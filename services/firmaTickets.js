const crypto = require('crypto');
const { QR_SECRET } = require('../config/env');

// 16 chars hex (64 bits) alcanza de sobra para esto: no protege un secreto de alto valor,
// solo evita que alguien invente/altere un código a mano o con un generador casero de QRs.
// Acortarlo así mantiene el ID (y el QR) chico sin resignar seguridad real.
const LARGO_FIRMA = 16;

function calcularFirma(idPlano) {
    return crypto.createHmac('sha256', QR_SECRET).update(idPlano).digest('hex').slice(0, LARGO_FIRMA);
}

// Genera el ID final de una entrada: el ID plano + su firma HMAC, unidos por un punto
// (ej. "EVT-A1B2C3D4.9f8e7d6c5b4a3f2e"). Este es el valor que se guarda en la DB, se imprime
// en el QR y viaja en la URL de /validar — un solo ID, firmado siempre.
function firmarId(idPlano) {
    return `${idPlano}.${calcularFirma(idPlano)}`;
}

// Separa ID y firma, recalcula el HMAC del ID y compara en tiempo constante (evita timing
// attacks). Devuelve el ID plano si la firma es válida, o null si el formato es inválido o
// la firma fue alterada/inventada — quien llama debe cortar acá, ANTES de tocar la base de datos.
function verificarIdFirmado(idConFirma) {
    if (typeof idConFirma !== 'string') return null;

    const posicionPunto = idConFirma.lastIndexOf('.');
    if (posicionPunto === -1) return null;

    const idPlano = idConFirma.slice(0, posicionPunto);
    const firmaRecibida = idConFirma.slice(posicionPunto + 1);
    const firmaEsperada = calcularFirma(idPlano);

    const bufRecibida = Buffer.from(firmaRecibida);
    const bufEsperada = Buffer.from(firmaEsperada);
    if (bufRecibida.length !== bufEsperada.length) return null;
    if (!crypto.timingSafeEqual(bufRecibida, bufEsperada)) return null;

    return idPlano;
}

module.exports = { firmarId, verificarIdFirmado };
