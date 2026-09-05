const crypto = require('crypto');
const { pool } = require('./pool');

// Guarda el "carrito" de una compra antes de mandar al comprador a Mercado Pago: qué tipos de
// entrada eligió y cuántas de cada uno, quién es, y qué cupón aplicó. Devuelve un token corto.
//
// Ese token es lo ÚNICO que viaja a Mercado Pago (como external_reference) y lo único que
// vuelve en la URL de /success. Dos motivos:
//   1. external_reference tiene un límite de 256 caracteres: mandar el carrito entero en JSON
//      (con varios tipos de entrada + email + nombre) se pasaba de largo.
//   2. Lo que se cobra y las entradas que se emiten salen de ACÁ, de la base — no de
//      parámetros de la URL que el comprador podría editar a mano antes de volver.
async function crearCheckout(eventoId, datos) {
    const token = crypto.randomBytes(16).toString('hex'); // 32 chars
    await pool.query(
        'INSERT INTO checkouts (token, evento_id, datos) VALUES (?, ?, ?)',
        [token, eventoId, JSON.stringify(datos)]
    );
    return token;
}

async function obtenerCheckout(token) {
    if (!token || typeof token !== 'string') return null;
    const [filas] = await pool.query('SELECT * FROM checkouts WHERE token = ?', [token]);
    if (!filas[0]) return null;

    try {
        return { ...filas[0], datos: JSON.parse(filas[0].datos) };
    } catch {
        console.error(`Checkout ${token} con datos corruptos, se ignora.`);
        return null;
    }
}

// Limpieza de carritos viejos que nunca terminaron en un pago (el comprador cerró la pestaña
// en el checkout de Mercado Pago). Se corre junto al job de reconciliación.
async function limpiarCheckoutsViejos(diasAntiguedad = 7) {
    const [resultado] = await pool.query(
        'DELETE FROM checkouts WHERE creado_en < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [diasAntiguedad]
    );
    return resultado.affectedRows;
}

module.exports = { crearCheckout, obtenerCheckout, limpiarCheckoutsViejos };
