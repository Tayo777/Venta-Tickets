require('dotenv').config();

const express = require('express');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const PDFDocument = require('pdfkit');
const path = require('path');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const app = express();

// Validamos que las variables de entorno necesarias existan antes de arrancar
const requiredEnv = ['MP_ACCESS_TOKEN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GUARDIA_CLAVE', 'ADMIN_CLAVE', 'BASE_URL'];
const faltantes = requiredEnv.filter((key) => !process.env[key]);
if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
    console.error('Creá un archivo .env (ver .env.example) o configuralas en tu plataforma de hosting.');
    process.exit(1);
}

// Credenciales de Mercado Pago (Access Token) desde variable de entorno
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// (Los precios ahora viven por evento en la tabla "eventos", no como constantes fijas)

// Configuración de correo para enviar las entradas
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Obliga a usar una conexión segura
    family: 4, // Fuerza IPv4: en Railway la resolución IPv6 a Gmail suele colgarse (ETIMEDOUT)
    connectionTimeout: 15000, // Si no conecta en 15s, falla rápido en vez de colgarse minutos
    greetingTimeout: 15000,
    socketTimeout: 15000,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD // Contraseña de aplicación de 16 letras (no la de tu cuenta)
    }
});

const cookieParser = require('cookie-parser');
app.use(cookieParser());

const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Conexión a MySQL. Railway inyecta MYSQL_URL automáticamente al conectar el plugin de MySQL.
if (!process.env.MYSQL_URL) {
    console.error('Falta la variable MYSQL_URL. Conectá el servicio de MySQL en Railway (ver .env.example).');
    process.exit(1);
}
const pool = mysql.createPool(process.env.MYSQL_URL);

// Definición del esquema relacional: un evento tiene muchas entradas (tickets)
async function inicializarDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS eventos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        fecha VARCHAR(100),
        flyer_url VARCHAR(500) DEFAULT '/flyer.png',
        valor_entrada DECIMAL(10,2) NOT NULL DEFAULT 0,
        tarifa_online DECIMAL(10,2) NOT NULL DEFAULT 0,
        token_informe VARCHAR(64) NOT NULL,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(20) PRIMARY KEY,
        evento_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        estado VARCHAR(20) DEFAULT 'Válida',
        fecha_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
    )`);

    // Cada pago de Mercado Pago se procesa UNA sola vez, gracias al payment_id único.
    // Esto evita que un reload o una doble redirección a /success duplique entradas o mails.
    await pool.query(`CREATE TABLE IF NOT EXISTS compras (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payment_id VARCHAR(50) NOT NULL UNIQUE,
        evento_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        cantidad INT NOT NULL,
        monto_total DECIMAL(10,2) NOT NULL,
        fecha_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
    )`);

    console.log('Base de datos MySQL lista (eventos + tickets + compras).');
}
inicializarDB().catch((err) => {
    console.error('Error al inicializar la base de datos:', err.message);
    process.exit(1);
});

// Trae todos los eventos activos, para listar en la página principal
async function obtenerEventosActivos() {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE activo = 1 ORDER BY id DESC');
    return filas;
}

// Trae un evento puntual por su id
async function obtenerEvento(id) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE id = ?', [id]);
    return filas[0] || null;
}

// Registra N entradas nuevas para un evento y devuelve sus códigos
async function registrarEntradas(eventoId, email, cantidad) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        const codigos = [];
        for (let i = 0; i < cantidad; i++) {
            const id = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
            codigos.push(id);
            await conexion.query('INSERT INTO tickets (id, evento_id, email) VALUES (?, ?, ?)', [id, eventoId, email]);
        }
        await conexion.commit();
        return codigos;
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
}



// 1. Página Principal: lista todos los eventos activos
app.get('/', async (req, res) => {
    try {
        const eventos = await obtenerEventosActivos();
        res.render('index', { eventos });
    } catch (error) {
        console.error('Error al listar eventos:', error);
        res.status(500).send('Error al cargar los eventos.');
    }
});

// 1b. Página de compra de un evento puntual
app.get('/evento/:id', async (req, res) => {
    try {
        const evento = await obtenerEvento(req.params.id);
        if (!evento || !evento.activo) return res.status(404).send('Evento no encontrado.');
        res.render('evento', { evento });
    } catch (error) {
        console.error('Error al cargar evento:', error);
        res.status(500).send('Error al cargar el evento.');
    }
});

// 2. Procesar y Crear Preferencia de Pago
app.post('/crear-pago', async (req, res) => {
    const { email, cantidad, evento_id } = req.body;
    const cant = parseInt(cantidad);
    const eventoId = parseInt(evento_id);

    if (cant < 1 || cant > 5) {
        return res.status(400).send("Cantidad de entradas inválida (máximo 5).");
    }

    const evento = await obtenerEvento(eventoId);
    if (!evento || !evento.activo) {
        return res.status(404).send("Evento no encontrado o no disponible.");
    }

    const subtotal = Number(evento.valor_entrada) * cant;
    const tarifaTotal = Number(evento.tarifa_online) * cant;
    const total = subtotal + tarifaTotal;

    try {
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [
                    {
                        title: `${evento.nombre} x ${cant}`,
                        quantity: 1,
                        unit_price: total,
                        currency_id: 'ARS'
                    }
                ],
                payer: {
                    email: email
                },
                back_urls: {
                    success: `${process.env.BASE_URL}/success?email=${encodeURIComponent(email)}&cant=${cant}&evento_id=${eventoId}`,
                    failure: `${process.env.BASE_URL}/evento/${eventoId}`,
                    pending: `${process.env.BASE_URL}/evento/${eventoId}`
                },
                auto_return: 'approved'
            }
        });

        // Si el Access Token es de producción (empieza con APP_USR), usamos el checkout real.
        // Si es de prueba (empieza con TEST-), usamos el checkout sandbox.
        const esProduccion = process.env.MP_ACCESS_TOKEN.startsWith('APP_USR');
        const urlCheckout = esProduccion ? result.init_point : result.sandbox_init_point;
        res.redirect(urlCheckout);
    } catch (error) {
        console.error("Error:", error);
        res.status(500).send("Error al procesar el pago con Mercado Pago.");
    }
});

// 3. Página de Éxito, Registro en DB y Envío de PDF
app.get('/success', async (req, res) => {
    const { email, cant, evento_id, payment_id } = req.query;
    const cantidadEntradas = parseInt(cant) || 1;
    const eventoId = parseInt(evento_id);

    try {
        const evento = await obtenerEvento(eventoId);
        if (!evento) return res.status(404).send('Evento no encontrado.');

        if (!payment_id) {
            // No debería pasar viniendo de Mercado Pago, pero si falta, no podemos
            // garantizar que no sea una recarga duplicada de la página.
            console.error('Llegó a /success sin payment_id, se rechaza para evitar duplicados.');
            return res.status(400).send('No se pudo confirmar el pago. Si ya recibiste tu mail con las entradas, no hace falta hacer nada más.');
        }

        // ¿Ya procesamos este pago antes? (evita duplicar entradas si /success se carga 2 veces)
        const [existentes] = await pool.query('SELECT id FROM compras WHERE payment_id = ?', [payment_id]);
        const yaProcesado = existentes.length > 0;

        if (!yaProcesado) {
            const montoTotal = (Number(evento.valor_entrada) + Number(evento.tarifa_online)) * cantidadEntradas;
            await pool.query(
                'INSERT INTO compras (payment_id, evento_id, email, cantidad, monto_total) VALUES (?, ?, ?, ?, ?)',
                [payment_id, eventoId, email, cantidadEntradas, montoTotal]
            );
        }

        // Respondemos al navegador siempre (haya sido nueva la compra o no)
        res.render('success', { email, cant, evento });

        // Si ya se había procesado este pago, no volvemos a generar entradas ni a mandar mail
        if (yaProcesado) {
            console.log(`payment_id ${payment_id} ya estaba procesado, se evita duplicar entradas/mail.`);
            return;
        }
    } catch (error) {
        console.error('Error al procesar la compra:', error);
        return res.status(500).send('Error interno al registrar la compra.');
    }

    // A partir de acá la respuesta YA fue enviada al navegador. Este bloque corre aparte
    // para que un error acá (PDF, QR, envío de mail) no intente mandar otra respuesta HTTP
    // (eso rompía silenciosamente el envío del correo) y para loguear el error completo.
    try {
        // 1. Guardamos las entradas en la base de datos, asociadas al evento
        const evento = await obtenerEvento(eventoId);
        const listaCodigos = await registrarEntradas(eventoId, email, cantidadEntradas);
        console.log(`Guardadas ${listaCodigos.length} entradas en DB para: ${email} (evento: ${evento.nombre})`);

        // 2. Generación del PDF con los códigos de la DB
        const doc = new PDFDocument({ margin: 0, size: 'A4' });
        const buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        
        doc.on('end', async () => {
            try {
                const pdfData = Buffer.concat(buffers);
                const mailOptions = {
                    from: process.env.GMAIL_USER,
                    to: email,
                    subject: '🎟️ Tus entradas oficiales',
                    text: `¡Gracias por tu compra! Adjuntamos ${cantidadEntradas} entrada/s para ${evento.nombre}.`,
                    attachments: [{ filename: 'Entradas_Evento.pdf', content: pdfData }]
                };

                await transporter.sendMail(mailOptions);
                console.log(`¡Correo enviado exitosamente a ${email}!`);

                enviarNotificacionTelegram(
                    `🎟️ <b>Nueva venta</b>\nEvento: ${evento.nombre}\n${cantidadEntradas} entrada/s\nComprador: ${email}`
                );
            } catch (mailError) {
                // Logueamos el error COMPLETO (no solo .message) para ver el código real
                // que devuelve Gmail (ej: credenciales inválidas, contraseña de app vencida, etc.)
                console.error('Error al enviar el correo:', mailError);
            }
        });

        const pageWidth = doc.page.width;

        // Banner Superior
        doc.rect(0, 0, pageWidth, 120).fill('#1a252c');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(evento.nombre.toUpperCase(), 0, 40, { align: 'center' });
        doc.fillColor('#bdc3c7').font('Helvetica').fontSize(12).text('ENTRADAS OFICIALES', 0, 75, { align: 'center' });

        // Info del Comprador
        doc.fillColor('#636e72').font('Helvetica-Bold').fontSize(10).text('TITULAR DE LA COMPRA', 0, 150, { align: 'center' });
        doc.fillColor('#2d3436').font('Helvetica-Bold').fontSize(14).text(email, 0, 165, { align: 'center' });

        let currentY = 220;

        for (let i = 0; i < listaCodigos.length; i++) {
            if (currentY + 280 > doc.page.height) {
                doc.addPage({ margin: 0 });
                currentY = 50;
            }

            const codigo = listaCodigos[i];
            const urlValidacion = `${process.env.BASE_URL}/validar/${codigo}`;

            // Caja punteada exterior
            doc.rect(50, currentY, pageWidth - 100, 230).lineWidth(2).dash(5, { space: 5 }).stroke('#b2bec3');
            doc.undash();

            // Encabezados
            doc.fillColor('#2d3436').font('Helvetica-Bold').fontSize(16).text(`Acceso ${i+1} de ${cantidadEntradas}`, 0, currentY + 25, { align: 'center' });
            doc.fillColor('#e74c3c').font('Helvetica').fontSize(10).text('Presentá este QR en la puerta', 0, currentY + 50, { align: 'center' });

            // QR con la URL de validación
            const qrBuffer = await QRCode.toBuffer(urlValidacion, { margin: 1, width: 100, color: { dark: '#000', light: '#fff' } });
            doc.image(qrBuffer, (pageWidth / 2) - 50, currentY + 70, { width: 100 });

            // ID
            doc.rect((pageWidth / 2) - 75, currentY + 185, 150, 25).fill('#f1f2f6');
            doc.fillColor('#2d3436').font('Courier-Bold').fontSize(14).text(codigo, 0, currentY + 190, { align: 'center' });

            if (i < listaCodigos.length - 1) {
                currentY += 270;
                doc.lineWidth(1).dash(3, { space: 3 }).strokeColor('#dfe6e9').moveTo(50, currentY).lineTo(pageWidth - 50, currentY).stroke();
                doc.undash();
                doc.fillColor('#b2bec3').font('Helvetica').fontSize(16).text('✂', 0, currentY - 8, { align: 'center' });
                currentY += 30;
            }
        }

        doc.end();
    } catch (error) {
        // La respuesta HTTP ya se mandó antes (res.render), así que acá solo podemos
        // loguear el error real para diagnosticarlo — no reintentar responder al navegador.
        console.error('Error al generar el PDF o registrar las entradas post-pago:', error);
    }
});

// Ruta conectada a la Base de Datos para descargar el PDF real
app.get('/descargar-pdf', async (req, res) => {
    const { email, cant } = req.query;
    const limit = parseInt(cant) || 1;

    try {
        // Buscamos los códigos reales y seguros (UUID) generados en la DB, junto con el nombre del evento
        const [filas] = await pool.query(
            `SELECT t.id, e.nombre AS evento_nombre FROM tickets t
             JOIN eventos e ON t.evento_id = e.id
             WHERE t.email = ? ORDER BY t.fecha_compra DESC LIMIT ?`,
            [email, limit]
        );
        if (filas.length === 0) {
            return res.status(404).send("No se encontraron entradas para este correo.");
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Entradas_${email}.pdf`);

        const doc = new PDFDocument({ margin: 0, size: 'A4' });
        doc.pipe(res); 

        const pageWidth = doc.page.width;
        
        // Banner Superior
        doc.rect(0, 0, pageWidth, 120).fill('#1a252c');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(filas[0].evento_nombre.toUpperCase(), 0, 40, { align: 'center' });
        doc.fillColor('#bdc3c7').font('Helvetica').fontSize(12).text('ENTRADAS OFICIALES', 0, 75, { align: 'center' });
        
        // Info del Comprador
        doc.fillColor('#636e72').font('Helvetica-Bold').fontSize(10).text('TITULAR DE LA COMPRA', 0, 150, { align: 'center' });
        doc.fillColor('#2d3436').font('Helvetica-Bold').fontSize(14).text(email, 0, 165, { align: 'center' });
        
        let currentY = 220;

        // Iteramos sobre los registros reales de la DB
        for (let i = 0; i < filas.length; i++) {
            if (currentY + 280 > doc.page.height) {
                doc.addPage({ margin: 0 });
                currentY = 50;
            }
            
            const codigo = filas[i].id; // ACÁ USAMOS EL CÓDIGO SEGURO (Ej: EVT-A1B2C3D4)
            const urlValidacion = `${process.env.BASE_URL}/validar/${codigo}`; 
            
            // Caja punteada exterior
            doc.rect(50, currentY, pageWidth - 100, 230).lineWidth(2).dash(5, { space: 5 }).stroke('#b2bec3');
            doc.undash(); 
            
            // Textos de Cabecera
            doc.fillColor('#2d3436').font('Helvetica-Bold').fontSize(16).text(`Acceso ${i+1} de ${filas.length}`, 0, currentY + 25, { align: 'center' });
            doc.fillColor('#e74c3c').font('Helvetica').fontSize(10).text('Presentá este QR en la puerta', 0, currentY + 50, { align: 'center' });
            
            // Generar el Código QR atado a la validación
            const qrBuffer = await QRCode.toBuffer(urlValidacion, { margin: 1, width: 100, color: { dark: '#000', light: '#fff' } });
            doc.image(qrBuffer, (pageWidth / 2) - 50, currentY + 70, { width: 100 });
            
            // Etiqueta del Código Alfanumérico Seguro
            doc.rect((pageWidth / 2) - 75, currentY + 185, 150, 25).fill('#f1f2f6');
            doc.fillColor('#2d3436').font('Courier-Bold').fontSize(14).text(codigo, 0, currentY + 190, { align: 'center' });
            
            // Línea de corte
            if (i < filas.length - 1) {
                currentY += 270;
                doc.lineWidth(1).dash(3, { space: 3 }).strokeColor('#dfe6e9').moveTo(50, currentY).lineTo(pageWidth - 50, currentY).stroke();
                doc.undash();
                doc.fillColor('#b2bec3').font('Helvetica').fontSize(16).text('✂', 0, currentY - 8, { align: 'center' });
                currentY += 30; 
            }
        }
        
        doc.end();
    } catch (error) {
        console.error('Error al descargar el PDF:', error);
        res.status(500).send("Hubo un error al generar tu entrada.");
    }
});

// Función auxiliar para armar una pantalla rápida para celulares
function generarPantallaControl(titulo, mensaje, colorFondo) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Control de Acceso</title>
        <style>
            body { 
                background-color: ${colorFondo}; 
                color: white; 
                font-family: 'Helvetica', sans-serif; 
                display: flex; 
                flex-direction: column; 
                align-items: center; 
                justify-content: center; 
                height: 100vh; 
                margin: 0; 
                text-align: center; 
                padding: 20px; 
            }
            h1 { font-size: 2.5rem; margin-bottom: 10px; text-transform: uppercase; }
            p { font-size: 1.2rem; font-weight: bold; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; }
        </style>
    </head>
    <body>
        <h1>${titulo}</h1>
        <p>${mensaje}</p>
    </body>
    </html>
    `;
}

// Ruta de Validación (Diferencia entre Usuario y Guardia)
app.get('/validar/:id', async (req, res) => {
    const ticketId = req.params.id;
    const esGuardia = req.cookies.rol === 'guardia'; // Verificamos si el celular tiene la sesión de guardia

    try {
        const [filas] = await pool.query(
            `SELECT t.*, e.nombre AS evento_nombre FROM tickets t
             JOIN eventos e ON t.evento_id = e.id
             WHERE t.id = ?`,
            [ticketId]
        );
        const row = filas[0];
        if (!row) return res.send(generarPantallaControl('❌ RECHAZADO', 'Esta entrada NO existe en el sistema.', '#c0392b'));

        // CASO 1: Lo escaneó el COMPRADOR (No es guardia)
        if (!esGuardia) {
            // Mostramos pantalla azul informativa, pero NO actualizamos la base de datos
            return res.send(generarPantallaControl('🎟️ ENTRADA OFICIAL', `${row.evento_nombre}<br>Código: ${row.id}<br>Estado actual: ${row.estado}<br><br>Por favor, mostrá este QR al guardia en la entrada.`, '#2980b9'));
        }

        // CASO 2: Lo escanea el GUARDIA (A partir de acá)
        if (row.estado === 'Usada') {
            return res.send(generarPantallaControl('⚠️ YA ESCANEADA', `Esta entrada ya ingresó previamente.<br><br>Titular: ${row.email}`, '#f39c12')); 
        }

        await pool.query('UPDATE tickets SET estado = ? WHERE id = ?', ['Usada', ticketId]);
        enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nEvento: ${row.evento_nombre}\nTitular: ${row.email}`);
        return res.send(generarPantallaControl('✅ ACCESO PERMITIDO', `Entrada válida.<br><br>Titular: ${row.email}`, '#27ae60'));
    } catch (error) {
        console.error('Error al validar entrada:', error);
        return res.status(500).send("Error de conexión con la base de datos.");
    }
});

// Activar el celular del guardia
app.get('/login-guardia', (req, res) => {
    const { clave } = req.query;
    
    // Si la clave es correcta, guardamos una cookie en su celular por 24 horas
    if (clave === process.env.GUARDIA_CLAVE) {
        res.cookie('rol', 'guardia', { maxAge: 86400000 }); 
        res.send(generarPantallaControl('👮 MODO GUARDIA ACTIVADO', 'Tu celular ya está listo para escanear y validar entradas en la puerta.', '#34495e'));
    } else {
        res.send(generarPantallaControl('❌ ERROR', 'Clave incorrecta', '#c0392b'));
    }
});

// ---------------------------------------------------------------------------
// ADMIN: crear y listar eventos (protegido con ADMIN_CLAVE)
// ---------------------------------------------------------------------------
function requiereAdmin(req, res, next) {
    const clave = req.query.clave || req.body.clave;
    if (clave !== process.env.ADMIN_CLAVE) {
        return res.status(403).send('Acceso denegado. Agregá ?clave=TU_CLAVE_ADMIN a la URL.');
    }
    next();
}

app.get('/admin/eventos', requiereAdmin, async (req, res) => {
    const eventos = await obtenerEventosActivos();
    const [todos] = await pool.query('SELECT * FROM eventos ORDER BY id DESC');
    res.render('admin', { eventos: todos, clave: req.query.clave, baseUrl: process.env.BASE_URL });
});

app.post('/admin/eventos', requiereAdmin, async (req, res) => {
    const { nombre, fecha, flyer_url, valor_entrada, tarifa_online } = req.body;
    const token = crypto.randomBytes(12).toString('hex');
    await pool.query(
        `INSERT INTO eventos (nombre, fecha, flyer_url, valor_entrada, tarifa_online, token_informe)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [nombre, fecha, flyer_url || '/flyer.png', valor_entrada, tarifa_online, token]
    );
    res.redirect(`/admin/eventos?clave=${req.query.clave}`);
});

app.post('/admin/eventos/:id/toggle', requiereAdmin, async (req, res) => {
    await pool.query('UPDATE eventos SET activo = NOT activo WHERE id = ?', [req.params.id]);
    res.redirect(`/admin/eventos?clave=${req.query.clave}`);
});

// ---------------------------------------------------------------------------
// INFORME EN TIEMPO REAL (para compartir con el cliente/organizador del evento)
// Cada evento tiene su propio token, así que este link se puede compartir
// sin exponer el panel de admin ni los datos de otros eventos.
// ---------------------------------------------------------------------------
app.get('/informe/:eventoId', async (req, res) => {
    const evento = await obtenerEvento(req.params.eventoId);
    if (!evento || req.query.token !== evento.token_informe) {
        return res.status(403).send('Acceso denegado. Verificá el link del informe.');
    }

    const [[resumen]] = await pool.query(
        `SELECT
            COUNT(*) AS total_vendidas,
            SUM(CASE WHEN estado = 'Usada' THEN 1 ELSE 0 END) AS total_ingresadas,
            COUNT(DISTINCT email) AS total_compradores
         FROM tickets WHERE evento_id = ?`,
        [evento.id]
    );

    // Recaudación = entradas vendidas × valor de la entrada (sin la tarifa online)
    const recaudacion = (Number(resumen.total_vendidas) || 0) * Number(evento.valor_entrada);

    res.render('informe', { evento, resumen, recaudacion });
});

const PORT = process.env.PORT || 3000;

// Envía un mensaje al chat de Telegram configurado. No corta la app si falla.
async function enviarNotificacionTelegram(mensaje) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; // si no están configuradas, simplemente no notifica

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: mensaje,
                parse_mode: 'HTML'
            })
        });
        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Telegram respondió con error:', response.status, errorBody);
        }
    } catch (error) {
        console.error('Error al enviar notificación a Telegram:', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});