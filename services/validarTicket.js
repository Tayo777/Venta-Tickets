const ticketsDb = require('../db/tickets');
const { verificarIdFirmado } = require('./firmaTickets');
const { enviarNotificacionTelegram } = require('./telegram');

// Intenta marcar una entrada como usada. Centraliza la regla (firma HMAC válida / existe /
// es de este evento / no estaba ya usada) — la comparten /validar y el scanner web del
// guardia (routes/validacion.js) y ahora también la API de la app móvil (routes/appApi.js),
// para que no haya dos implementaciones del mismo chequeo de seguridad divergiendo con el tiempo.
async function intentarValidar(ticketId, eventoId) {
    // Blindaje contra QRs falsificados o alterados a mano: se verifica la firma HMAC ANTES
    // de tocar la base de datos. Si no coincide, se corta acá — cero consultas a MySQL.
    if (!verificarIdFirmado(ticketId)) return { resultado: 'firma_invalida' };

    const row = await ticketsDb.obtenerTicketConEvento(ticketId);
    if (!row) return { resultado: 'no_existe' };
    if (String(row.evento_id) !== String(eventoId)) return { resultado: 'otro_evento', row };
    if (row.estado === 'Usada') return { resultado: 'ya_usada', row };

    await ticketsDb.marcarComoUsada(ticketId);
    enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nEvento: ${row.evento_nombre}\nTitular: ${row.email}`);
    return { resultado: 'ok', row };
}

module.exports = { intentarValidar };
