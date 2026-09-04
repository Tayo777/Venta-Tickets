const comprasDb = require('../db/compras');
const ticketsDb = require('../db/tickets');
const mp = require('./mercadopago');
const { enviarMailBrevo } = require('./brevo');
const { enviarNotificacionTelegram } = require('./telegram');
const { generarPdfBuffer } = require('./pdfEntradas');

// Cumple un pago YA APROBADO por Mercado Pago: registra la compra, descuenta cupo, genera
// el PDF y manda el mail + notificación. Es idempotente (por payment_id), así que se puede
// llamar tanto desde /success (redirect del navegador) como desde el job de reconciliación
// (services/reconciliarPagos.js) sin duplicar entradas ni mails si ambos caminos procesan
// el mismo pago.
async function procesarPagoAprobado({ evento, tipoEntrada, paymentId, email, nombreApellido, cantidad }) {
    const yaProcesado = await comprasDb.yaProcesada(paymentId);
    if (yaProcesado) {
        return { yaProcesado: true };
    }

    const montoTotal = (Number(tipoEntrada.precio) + Number(evento.tarifa_online)) * cantidad;
    await comprasDb.registrarCompra({ paymentId, eventoId: evento.id, email, cantidad, montoTotal });

    try {
        const listaCodigos = await ticketsDb.registrarEntradas(evento.id, tipoEntrada.id, email, cantidad, {
            nombreApellido, paymentId
        });
        console.log(`Guardadas ${listaCodigos.length} entradas en DB para: ${email} (evento: ${evento.nombre}, tipo: ${tipoEntrada.nombre})`);

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos: listaCodigos });

        try {
            await enviarMailBrevo({
                to: email,
                subject: '🎟️ Tus entradas oficiales',
                text: `¡Gracias por tu compra! Adjuntamos ${cantidad} entrada/s para ${evento.nombre}.`,
                attachmentBase64: pdfBuffer.toString('base64'),
                attachmentName: 'Entradas_Evento.pdf'
            });
            console.log(`¡Correo enviado exitosamente a ${email}!`);
        } catch (mailError) {
            console.error('Error al enviar el correo:', mailError);
        }

        enviarNotificacionTelegram(
            `🎟️ <b>Nueva venta</b>\nEvento: ${evento.nombre}\n${cantidad} entrada/s\nComprador: ${email}`
        );

        // Consultamos la comisión REAL que cobró Mercado Pago en esta transacción puntual
        // (recién ahora se puede saber; antes del pago solo teníamos una estimación).
        try {
            const { comisionMpReal, montoNeto } = await mp.obtenerFeeReal(evento.mp_access_token, paymentId);
            await comprasDb.guardarComisionReal(paymentId, { comisionMpReal, montoNeto });
            if (comisionMpReal !== null) {
                await comprasDb.ajustarTarifaConDatosReales(evento.id);
            }
        } catch (feeError) {
            console.error('No se pudo consultar la comisión real de Mercado Pago:', feeError.message);
        }

        return { yaProcesado: false, codigos: listaCodigos };
    } catch (error) {
        if (error instanceof ticketsDb.SinCupoError) {
            // Esto solo puede pasar si el cupo se agotó ENTRE la validación de /crear-pago y el
            // pago aprobado (carrera muy angosta). El dinero ya fue cobrado, así que no hay
            // vuelta atrás automática: se avisa para que el organizador reembolse a mano.
            console.error(`Sin cupo al confirmar pago ya cobrado (payment_id ${paymentId}):`, error.message);
            enviarNotificacionTelegram(
                `⚠️ <b>Venta sin cupo</b>\nEvento: ${evento.nombre}\nComprador: ${email}\npayment_id: ${paymentId}\n${error.message}\nEl pago ya fue cobrado, revisar reembolso manual.`
            );
            return { yaProcesado: false, sinCupo: true };
        }
        throw error;
    }
}

module.exports = { procesarPagoAprobado };
