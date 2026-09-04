const crypto = require('crypto');

// 16 chars hex (64 bits) alcanza de sobra para esto: no protege un secreto de alto valor,
// solo evita que alguien invente/altere un código a mano o con un generador casero de QRs.
// Acortarlo así mantiene el ID (y el QR) chico sin resignar seguridad real.
const LARGO_FIRMA = 16;

// El secreto YA NO sale de una variable de entorno global (QR_SECRET) — cada evento tiene
// el suyo propio en eventos.qr_secret, generado al crear el evento. Por eso estas funciones
// reciben el secreto como parámetro: quien llama es responsable de pasar el de ESE evento
// puntual (ver db/tickets.js y services/validarTicket.js).
function calcularFirma(idPlano, secret) {
    return crypto.createHmac('sha256', secret).update(idPlano).digest('hex').slice(0, LARGO_FIRMA);
}

// Genera el ID final de una entrada: el ID plano + su firma HMAC, unidos por un punto
// (ej. "EVT-A1B2C3D4.9f8e7d6c5b4a3f2e"). Este es el valor que se guarda en la DB, se imprime
// en el QR y viaja en la URL de /validar — un solo ID, firmado siempre.
function firmarId(idPlano, secret) {
    return `${idPlano}.${calcularFirma(idPlano, secret)}`;
}

// Separa ID y firma, recalcula el HMAC del ID (con el secreto del evento al que dice
// pertenecer) y compara en tiempo constante (evita timing attacks). Devuelve el ID plano si
// la firma es válida, o null si el formato es inválido o la firma fue alterada/inventada.
function verificarIdFirmado(idConFirma, secret) {
    if (typeof idConFirma !== 'string' || !secret) return null;

    const posicionPunto = idConFirma.lastIndexOf('.');
    if (posicionPunto === -1) return null;

    const idPlano = idConFirma.slice(0, posicionPunto);
    const firmaRecibida = idConFirma.slice(posicionPunto + 1);
    const firmaEsperada = calcularFirma(idPlano, secret);

    const bufRecibida = Buffer.from(firmaRecibida);
    const bufEsperada = Buffer.from(firmaEsperada);
    if (bufRecibida.length !== bufEsperada.length) return null;
    if (!crypto.timingSafeEqual(bufRecibida, bufEsperada)) return null;

    return idPlano;
}

module.exports = { firmarId, verificarIdFirmado };
