const ticketsDb = require('../db/tickets');
const { verificarIdFirmado } = require('./firmaTickets');
const { enviarNotificacionTelegram } = require('./telegram');

// Extrae el codigo de entrada de lo que sea que haya leido la camara. El QR impreso contiene
// la URL completa (https://.../validar/EVT-XXXXXXXX.<firma>), asi que si el lector manda el
// texto crudo del QR hay que quedarse solo con el codigo — buscar la URL entera en la tabla
// tickets da "no existe" y el escaneo se pierde en silencio. Tambien tolera espacios, saltos
// de linea y que venga envuelto en un objeto.
//
// Devuelve null si no hay nada parecido a un codigo de entrada.
function extraerIdTicket(valor) {
    if (valor === null || valor === undefined) return null;
    const texto = String(typeof valor === 'object' ? (valor.id ?? valor.ticketId ?? valor.codigo ?? '') : valor).trim();
    const match = texto.match(/EVT-[A-Z0-9]+\.[0-9a-f]+/i);
    return match ? match[0] : (texto || null);
}

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
async function intentarValidar(ticketId, eventoId, { fechaEscaneo = null } = {}) {
    const row = await ticketsDb.obtenerTicketConEvento(ticketId);
    if (!row) return { resultado: 'no_existe' };

    if (!verificarIdFirmado(ticketId, row.evento_qr_secret)) return { resultado: 'firma_invalida' };
    if (String(row.evento_id) !== String(eventoId)) return { resultado: 'otro_evento', row };
    if (row.estado === 'Usada') return { resultado: 'ya_usada', row };

    await ticketsDb.marcarComoUsada(ticketId, fechaEscaneo);
    enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nEvento: ${row.evento_nombre}\nTitular: ${row.email}`);
    return { resultado: 'ok', row };
}

module.exports = { intentarValidar, extraerIdTicket };
