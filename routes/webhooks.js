const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { MP_WEBHOOK_SECRET } = require('../config/env');
const { reconciliarPagos } = require('../services/reconciliarPagos');

// Verifica que la notificación realmente venga de Mercado Pago (y no de alguien simulando un
// pago aprobado para robar entradas gratis). Algoritmo documentado por MP:
// id:{data.id};request-id:{x-request-id};ts:{ts};  ->  HMAC-SHA256 con el secreto de webhooks
// https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks
function firmaWebhookValida(req) {
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    const dataId = req.body?.data?.id;

    if (!xSignature || !xRequestId || !dataId) return false;

    // x-signature llega como "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a15d1"
    const partes = {};
    for (const par of xSignature.split(',')) {
        const [clave, valor] = par.split('=').map((s) => s && s.trim());
        if (clave && valor) partes[clave] = valor;
    }
    const { ts, v1: firmaRecibida } = partes;
    if (!ts || !firmaRecibida) return false;

    // El manifest se arma con el ID en minúscula, tal cual pide la documentación de MP.
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${ts};`;
    const firmaEsperada = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

    // Comparación en tiempo constante: evita que un atacante deduzca la firma correcta
    // midiendo cuánto tarda la respuesta según cuántos caracteres acertó.
    const bufRecibida = Buffer.from(firmaRecibida);
    const bufEsperada = Buffer.from(firmaEsperada);
    if (bufRecibida.length !== bufEsperada.length) return false;
    return crypto.timingSafeEqual(bufRecibida, bufEsperada);
}

// Mercado Pago pega acá cada vez que cambia el estado de un pago. Nunca hay que confiar en
// el body a ciegas — sin la firma, cualquiera podría mandar un POST fingiendo un pago
// aprobado para sacar entradas gratis.
router.post('/webhooks/mercadopago', (req, res) => {
    if (!firmaWebhookValida(req)) {
        console.warn('Webhook de Mercado Pago rechazado: firma inválida o headers faltantes.');
        return res.sendStatus(403);
    }

    // Confirmamos rápido (MP reintenta agresivamente si no responde a tiempo) y el trabajo de
    // acreditar la venta corre aparte, reusando el mismo camino que ya usan /success y el job
    // de reconciliación periódica — así no duplicamos la lógica de entrega de entradas.
    res.sendStatus(200);

    const tipoNotificacion = req.body?.type || req.body?.topic;
    if (tipoNotificacion !== 'payment') return;

    reconciliarPagos().catch((error) => {
        console.error('Error al reconciliar tras un webhook de Mercado Pago:', error);
    });
});

module.exports = router;
