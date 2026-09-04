const ticketsDb = require('../db/tickets');
const { verificarIdFirmado } = require('./firmaTickets');
const { enviarNotificacionTelegram } = require('./telegram');

// Intenta marcar una entrada como usada. Centraliza la regla (existe / firma HMAC válida con
// el secreto DE ESE EVENTO / es de este evento / no estaba ya usada) — la comparten /validar
// y el scanner web del guardia (routes/validacion.js) y también la API de la app móvil
// (routes/appApi.js), para que no haya dos implementaciones del mismo chequeo divergiendo.
//
// Nota de diseño: como cada evento tiene su PROPIO qr_secret (ya no hay uno global), la firma
// recién se puede verificar después de saber a qué evento pertenece el ticket — por eso el
// orden es "buscar la fila" y DESPUÉS "verificar firma", y no al revés como cuando el secreto
// era único. La fila sale por PRIMARY KEY (lookup barato e indexado), y lo importante se
// mantiene: NUNCA se llama a marcarComoUsada() sin que la firma haya validado antes.
async function intentarValidar(ticketId, eventoId) {
    const row = await ticketsDb.obtenerTicketConEvento(ticketId);
    if (!row) return { resultado: 'no_existe' };

    if (!verificarIdFirmado(ticketId, row.evento_qr_secret)) return { resultado: 'firma_invalida' };
    if (String(row.evento_id) !== String(eventoId)) return { resultado: 'otro_evento', row };
    if (row.estado === 'Usada') return { resultado: 'ya_usada', row };

    await ticketsDb.marcarComoUsada(ticketId);
    enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nEvento: ${row.evento_nombre}\nTitular: ${row.email}`);
    return { resultado: 'ok', row };
}

module.exports = { intentarValidar };
