const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const ticketsDb = require('../db/tickets');
const comprasDb = require('../db/compras');
const tiposEntradaDb = require('../db/tiposEntrada');
const mp = require('../services/mercadopago');
const { enviarMailBrevo } = require('../services/brevo');
const { enviarNotificacionTelegram } = require('../services/telegram');
const { generarPdfBuffer, generarPdfEnResponse } = require('../services/pdfEntradas');

router.post('/crear-pago', async (req, res) => {
    const { email, nombre_apellido, cantidad, evento_id, tipo_entrada_id } = req.body;
    const cant = parseInt(cantidad);
    const eventoId = parseInt(evento_id);
    const tipoEntradaId = parseInt(tipo_entrada_id);

    if (!nombre_apellido || !String(nombre_apellido).trim()) {
        return res.status(400).send('Falta el nombre y apellido del comprador.');
    }
    if (cant < 1 || cant > 5) {
        return res.status(400).send('Cantidad de entradas inválida (máximo 5).');
    }

    const evento = await eventosDb.obtenerEvento(eventoId);
    if (!evento || !evento.activo || !evento.conectado_mp) {
        return res.status(404).send('Evento no encontrado o no disponible para la venta.');
    }

    // Cierre automático de ventas: por fecha límite o porque ya no queda cupo. Esto es una
    // validación "amable" antes de pagar; la que de verdad evita la sobreventa es la
    // transacción con FOR UPDATE en ticketsDb.registrarEntradas (ver /success más abajo).
    if (eventosDb.ventaVencidaPorTiempo(evento)) {
        return res.status(410).send('La venta de entradas para este evento ya cerró.');
    }

    const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(tipoEntradaId);
    if (!tipoEntrada || tipoEntrada.evento_id !== eventoId || !tipoEntrada.activo) {
        return res.status(404).send('Tipo de entrada no encontrado.');
    }
    if (tipoEntrada.cupo_disponible < cant) {
        return res.status(409).send(`Ya no quedan suficientes entradas "${tipoEntrada.nombre}" disponibles (quedan ${tipoEntrada.cupo_disponible}).`);
    }

    try {
        const urlCheckout = await mp.crearPreferencia(evento, tipoEntrada, { email, nombreApellido: nombre_apellido, cantidad: cant });
        res.redirect(urlCheckout);
    } catch (error) {
        console.error('Error al crear la preferencia de pago:', error);
        res.status(500).send('Error al procesar el pago con Mercado Pago.');
    }
});

// Página de éxito: idempotente (no duplica entradas/mails si Mercado Pago o el navegador
// cargan esta URL más de una vez con el mismo payment_id).
router.get('/success', async (req, res) => {
    const { email, cant, evento_id, payment_id, nombre, tipo_entrada_id } = req.query;
    const cantidadEntradas = parseInt(cant) || 1;
    const eventoId = parseInt(evento_id);
    const tipoEntradaId = parseInt(tipo_entrada_id);
    const nombreApellido = nombre || '';
    let evento;
    let tipoEntrada;

    try {
        evento = await eventosDb.obtenerEvento(eventoId);
        if (!evento) return res.status(404).send('Evento no encontrado.');

        tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(tipoEntradaId);
        if (!tipoEntrada || tipoEntrada.evento_id !== eventoId) return res.status(404).send('Tipo de entrada no encontrado.');

        if (!payment_id) {
            console.error('Llegó a /success sin payment_id, se rechaza para evitar duplicados.');
            return res.status(400).send('No se pudo confirmar el pago. Si ya recibiste tu mail con las entradas, no hace falta hacer nada más.');
        }

        const yaProcesado = await comprasDb.yaProcesada(payment_id);
        if (!yaProcesado) {
            const montoTotal = (Number(tipoEntrada.precio) + Number(evento.tarifa_online)) * cantidadEntradas;
            await comprasDb.registrarCompra({ paymentId: payment_id, eventoId, email, cantidad: cantidadEntradas, montoTotal });
        }

        res.render('success', { email, cant, evento });

        if (yaProcesado) {
            console.log(`payment_id ${payment_id} ya estaba procesado, se evita duplicar entradas/mail.`);
            return;
        }
    } catch (error) {
        console.error('Error al procesar la compra:', error);
        return res.status(500).send('Error interno al registrar la compra.');
    }

    // A partir de acá la respuesta YA fue enviada al navegador. Corre aparte para que un
    // error acá (PDF, QR, mail) no intente mandar otra respuesta HTTP y quede oculto.
    try {
        const listaCodigos = await ticketsDb.registrarEntradas(eventoId, tipoEntradaId, email, cantidadEntradas, {
            nombreApellido, paymentId: payment_id
        });
        console.log(`Guardadas ${listaCodigos.length} entradas en DB para: ${email} (evento: ${evento.nombre}, tipo: ${tipoEntrada.nombre})`);

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos: listaCodigos });

        try {
            await enviarMailBrevo({
                to: email,
                subject: '🎟️ Tus entradas oficiales',
                text: `¡Gracias por tu compra! Adjuntamos ${cantidadEntradas} entrada/s para ${evento.nombre}.`,
                attachmentBase64: pdfBuffer.toString('base64'),
                attachmentName: 'Entradas_Evento.pdf'
            });
            console.log(`¡Correo enviado exitosamente a ${email}!`);
        } catch (mailError) {
            console.error('Error al enviar el correo:', mailError);
        }

        enviarNotificacionTelegram(
            `🎟️ <b>Nueva venta</b>\nEvento: ${evento.nombre}\n${cantidadEntradas} entrada/s\nComprador: ${email}`
        );

        // Consultamos la comisión REAL que cobró Mercado Pago en esta transacción puntual
        // (recién ahora se puede saber; antes del pago solo teníamos una estimación).
        try {
            const { comisionMpReal, montoNeto } = await mp.obtenerFeeReal(evento.mp_access_token, payment_id);
            await comprasDb.guardarComisionReal(payment_id, { comisionMpReal, montoNeto });
            if (comisionMpReal !== null) {
                await comprasDb.ajustarTarifaConDatosReales(eventoId);
            }
        } catch (feeError) {
            console.error('No se pudo consultar la comisión real de Mercado Pago:', feeError.message);
        }
    } catch (error) {
        if (error instanceof ticketsDb.SinCupoError) {
            // Esto solo puede pasar si el cupo se agotó ENTRE la validación de /crear-pago y el
            // pago aprobado (carrera muy angosta). El dinero ya fue cobrado, así que no hay
            // vuelta atrás automática: se avisa para que el organizador reembolse a mano.
            console.error(`Sin cupo al confirmar pago ya cobrado (payment_id ${payment_id}):`, error.message);
            enviarNotificacionTelegram(
                `⚠️ <b>Venta sin cupo</b>\nEvento: ${evento.nombre}\nComprador: ${email}\npayment_id: ${payment_id}\n${error.message}\nEl pago ya fue cobrado, revisar reembolso manual.`
            );
            return;
        }
        console.error('Error al generar el PDF o registrar las entradas post-pago:', error);
    }
});

router.get('/descargar-pdf', async (req, res) => {
    const { email, cant } = req.query;
    const limit = parseInt(cant) || 1;

    try {
        const filas = await ticketsDb.obtenerUltimasEntradas(email, limit);
        if (filas.length === 0) return res.status(404).send('No se encontraron entradas para este correo.');

        await generarPdfEnResponse(res, {
            nombreEvento: filas[0].evento_nombre,
            email,
            codigos: filas.map((f) => f.id)
        });
    } catch (error) {
        console.error('Error al descargar el PDF:', error);
        res.status(500).send('Hubo un error al generar tu entrada.');
    }
});

module.exports = router;
