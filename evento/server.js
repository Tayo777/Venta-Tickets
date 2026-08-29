require('dotenv').config();

const express = require('express');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const PDFDocument = require('pdfkit');
const path = require('path');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const app = express();

// Validamos que las variables de entorno necesarias existan antes de arrancar
const requiredEnv = ['MP_ACCESS_TOKEN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'GUARDIA_CLAVE', 'BASE_URL'];
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

// Precios de ejemplo
const VALOR_ENTRADA = 1;
const TARIFA_ONLINE = 2;

// Memoria temporal para guardar los datos de la compra (en producción usa una Base de Datos)
let ultimasEntradas = {};

// Configuración de correo para enviar las entradas
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Obliga a usar una conexión segura
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD // Contraseña de aplicación de 16 letras (no la de tu cuenta)
    }
});

const cookieParser = require('cookie-parser');
app.use(cookieParser());

const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

// Conexión a la base de datos (DB_PATH apunta al volumen persistente en producción)
const dbPath = process.env.DB_PATH || './entradas.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Error al abrir DB:", err.message);
    else console.log(`Base de datos conectada en: ${dbPath}`);
});

// Definición del esquema relacional
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        estado TEXT DEFAULT 'Válida',
        fecha_compra DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Función para registrar entradas en SQLite y devolver sus IDs únicos
function registrarEntradas(email, cantidad) {
    return new Promise((resolve, reject) => {
        const codigos = [];
        const stmt = db.prepare('INSERT INTO tickets (id, email) VALUES (?, ?)');

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            for (let i = 0; i < cantidad; i++) {
                // Generamos un código único alfanumérico corto y seguro
                const id = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
                codigos.push(id);
                stmt.run(id, email);
            }
            stmt.finalize();
            db.run('COMMIT', (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return reject(err);
                }
                resolve(codigos);
            });
        });
    });
}



// 1. Página Principal (Formulario y Flyer)
app.get('/', (req, res) => {
    res.render('index', { valorEntrada: VALOR_ENTRADA, tarifaOnline: TARIFA_ONLINE });
});

// 2. Procesar y Crear Preferencia de Pago
app.post('/crear-pago', async (req, res) => {
    const { email, cantidad } = req.body;
    const cant = parseInt(cantidad);

    if (cant < 1 || cant > 5) {
        return res.status(400).send("Cantidad de entradas inválida (máximo 5).");
    }

    const subtotal = VALOR_ENTRADA * cant;
    const tarifaTotal = TARIFA_ONLINE * cant;
    const total = subtotal + tarifaTotal;

    try {
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [
                    {
                        title: `Entrada Evento Genérico x ${cant}`,
                        quantity: 1,
                        unit_price: total,
                        currency_id: 'ARS'
                    }
                ],
                payer: {
                    email: email
                },
                back_urls: {
                    success: `${process.env.BASE_URL}/success?email=${encodeURIComponent(email)}&cant=${cant}`,
                    failure: `${process.env.BASE_URL}/`,
                    pending: `${process.env.BASE_URL}/`
                },
                auto_return: 'approved'
            }
        });

        ultimasEntradas[email] = { cantidad: cant };
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
    const { email, cant } = req.query;
    const cantidadEntradas = parseInt(cant) || 1;

    try {
        // 1. Guardamos las entradas en la base de datos
        const listaCodigos = await registrarEntradas(email, cantidadEntradas);
        console.log(`Guardadas ${listaCodigos.length} entradas en DB para: ${email}`);

        // 2. Respondemos al navegador
        res.render('success', { email, cant });

        // 3. Generación del PDF con los códigos de la DB
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
                    text: `¡Gracias por tu compra! Adjuntamos ${cantidadEntradas} entrada/s para el evento.`,
                    attachments: [{ filename: 'Entradas_Evento.pdf', content: pdfData }]
                };

                await transporter.sendMail(mailOptions);
                console.log(`¡Correo enviado exitosamente a ${email}!`);

                enviarNotificacionTelegram(
                    `🎟️ <b>Nueva venta</b>\n${cantidadEntradas} entrada/s\nComprador: ${email}`
                );
            } catch (mailError) {
                console.error('Error al enviar el correo:', mailError.message);
            }
        });

        const pageWidth = doc.page.width;

        // Banner Superior
        doc.rect(0, 0, pageWidth, 120).fill('#1a252c');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('LA RENGA - GIRA NORTE 2026', 0, 40, { align: 'center' });
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
        console.error('Error al procesar la compra:', error);
        res.status(500).send('Error interno al registrar la compra.');
    }
});

// Ruta conectada a la Base de Datos para descargar el PDF real
app.get('/descargar-pdf', async (req, res) => { 
    const { email, cant } = req.query;
    const limit = parseInt(cant) || 1;

    // Buscamos los códigos reales y seguros (UUID) generados en la DB
    db.all("SELECT id FROM tickets WHERE email = ? ORDER BY fecha_compra DESC LIMIT ?", [email, limit], async (err, filas) => {
        if (err || filas.length === 0) {
            return res.status(404).send("No se encontraron entradas para este correo.");
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Entradas_${email}.pdf`);

        try {
            const doc = new PDFDocument({ margin: 0, size: 'A4' });
            doc.pipe(res); 

            const pageWidth = doc.page.width;
            
            // Banner Superior
            doc.rect(0, 0, pageWidth, 120).fill('#1a252c');
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('LA RENGA - GIRA NORTE 2026', 0, 40, { align: 'center' });
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
app.get('/validar/:id', (req, res) => {
    const ticketId = req.params.id;
    const esGuardia = req.cookies.rol === 'guardia'; // Verificamos si el celular tiene la sesión de guardia

    db.get('SELECT * FROM tickets WHERE id = ?', [ticketId], (err, row) => {
        if (err) return res.status(500).send("Error de conexión con la base de datos.");
        if (!row) return res.send(generarPantallaControl('❌ RECHAZADO', 'Esta entrada NO existe en el sistema.', '#c0392b'));

        // CASO 1: Lo escaneó el COMPRADOR (No es guardia)
        if (!esGuardia) {
            // Mostramos pantalla azul informativa, pero NO actualizamos la base de datos
            return res.send(generarPantallaControl('🎟️ ENTRADA OFICIAL', `Código: ${row.id}<br>Estado actual: ${row.estado}<br><br>Por favor, mostrá este QR al guardia en la entrada.`, '#2980b9'));
        }

        // CASO 2: Lo escanea el GUARDIA (A partir de acá)
        if (row.estado === 'Usada') {
            return res.send(generarPantallaControl('⚠️ YA ESCANEADA', `Esta entrada ya ingresó previamente.<br><br>Titular: ${row.email}`, '#f39c12')); 
        }

        db.run('UPDATE tickets SET estado = ? WHERE id = ?', ['Usada', ticketId], (updateErr) => {
            if (updateErr) return res.status(500).send("Error al actualizar la entrada.");
            enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nTitular: ${row.email}`);
            return res.send(generarPantallaControl('✅ ACCESO PERMITIDO', `Entrada válida.<br><br>Titular: ${row.email}`, '#27ae60'));
        });
    });
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