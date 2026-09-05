const comprasDb = require('../db/compras');
const ticketsDb = require('../db/tickets');
const cuponesDb = require('../db/cupones');
const mp = require('./mercadopago');
const { enviarMailBrevo } = require('./brevo');
const { enviarNotificacionTelegram } = require('./telegram');
const { generarPdfBuffer } = require('./pdfEntradas');

// Cumple un pago YA APROBADO por Mercado Pago: registra la compra, descuenta cupo, genera
// el PDF y manda el mail + notificación. Es idempotente (por payment_id), así que se puede
// llamar tanto desde /success (redirect del navegador) como desde el job de reconciliación
// (services/reconciliarPagos.js) sin duplicar entradas ni mails si ambos caminos procesan
// el mismo pago.
// `lineas` = [{ tipoEntrada, cantidad }] — una compra puede llevar varios tipos a la vez.
async function procesarPagoAprobado({ evento, lineas, paymentId, email, nombreApellido, descuentoTotal = 0, cuponCodigo = null }) {
    const yaProcesado = await comprasDb.yaProcesada(paymentId);
    if (yaProcesado) {
        return { yaProcesado: true };
    }

    // Mismo cálculo que usó services/mercadopago.js para armar la preferencia, reutilizado
    // literalmente (no reimplementado): lo que se registra en `compras` es exactamente lo que
    // se le cobró al comprador, cupón incluido.
    const { cantidadTotal, total: montoTotal } = mp.calcularTotales(evento, lineas, descuentoTotal);

    // Entre el chequeo de arriba y este INSERT hay una ventana de carrera: si Mercado Pago
    // reintenta el webhook (o el webhook y el job de reconciliación caen justo al mismo
    // tiempo), dos llamadas pueden pasar el "yaProcesada" en false antes de que ninguna haya
    // insertado todavía. El INDEX UNIQUE de compras.payment_id es la red de seguridad real:
    // la segunda va a fallar acá con ER_DUP_ENTRY, y eso es lo que atrapamos.
    try {
        await comprasDb.registrarCompra({ paymentId, eventoId: evento.id, email, cantidad: cantidadTotal, montoTotal });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            // Otro proceso ganó la carrera y ya registró este payment_id un instante antes.
            // No es un error real: el pago YA está siendo/fue procesado por ese otro proceso,
            // así que acá no se generan entradas de nuevo (nada que "rollbackear": el INSERT
            // de esta llamada nunca llegó a aplicarse).
            console.warn(`payment_id ${paymentId} ya fue registrado por otro proceso en paralelo, se omite (sin duplicar entradas).`);
            return { yaProcesado: true };
        }
        throw error;
    }

    try {
        const listaCodigos = await ticketsDb.registrarEntradas(
            evento.id,
            lineas.map((l) => ({ tipoEntradaId: l.tipoEntrada.id, cantidad: l.cantidad })),
            { email, nombreApellido, paymentId, qrSecret: evento.qr_secret }
        );
        const detalle = lineas.map((l) => `${l.cantidad}x ${l.tipoEntrada.nombre}`).join(', ');
        console.log(`Guardadas ${listaCodigos.length} entradas en DB para: ${email} (evento: ${evento.nombre}, ${detalle})`);

        // Contador informativo del cupón (ver db/cupones.js): recién ahora, con el pago YA
        // confirmado y las entradas YA generadas, tiene sentido sumarle un uso.
        if (cuponCodigo) {
            try {
                await cuponesDb.incrementarUso(cuponCodigo);
            } catch (cuponError) {
                console.error(`No se pudo incrementar el uso del cupón ${cuponCodigo}:`, cuponError.message);
            }
        }

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos: listaCodigos });

        try {
            await enviarMailBrevo({
                to: email,
                subject: '🎟️ Tus entradas oficiales',
                text: `¡Gracias por tu compra! Adjuntamos ${cantidadTotal} entrada/s para ${evento.nombre} (${detalle}).`,
                attachmentBase64: pdfBuffer.toString('base64'),
                attachmentName: 'Entradas_Evento.pdf'
            });
            console.log(`¡Correo enviado exitosamente a ${email}!`);
        } catch (mailError) {
            console.error('Error al enviar el correo:', mailError);
        }

        enviarNotificacionTelegram(
            `🎟️ <b>Nueva venta</b>\nEvento: ${evento.nombre}\n${detalle}\nComprador: ${email}`
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
