const { pool } = require('./pool');

async function obtenerCuponPorCodigo(codigo) {
    const [filas] = await pool.query('SELECT * FROM cupones WHERE codigo = ?', [String(codigo).trim().toUpperCase()]);
    return filas[0] || null;
}

// Calcula el descuento en pesos sobre un subtotal dado. Nunca devuelve más que el subtotal
// (no se puede "cobrar negativo") ni un número con más de 2 decimales.
function calcularDescuento(cupon, subtotal) {
    const bruto = cupon.tipo === 'porcentaje'
        ? subtotal * (Number(cupon.valor) / 100)
        : Number(cupon.valor);
    const descuento = Math.max(0, Math.min(bruto, subtotal));
    return Math.round(descuento * 100) / 100;
}

// Validación completa de un cupón para un evento y un subtotal puntuales. Es de solo lectura
// (no reserva ni descuenta nada) — se llama tanto desde el preview del frontend como, de
// nuevo, del lado del servidor en /crear-pago justo antes de cobrar (nunca se confía en un
// descuento que haya calculado el navegador).
async function validarCupon(codigo, eventoId, subtotal) {
    if (!codigo || !String(codigo).trim()) {
        return { valido: false, motivo: 'Ingresá un código de cupón.' };
    }

    const cupon = await obtenerCuponPorCodigo(codigo);
    if (!cupon) return { valido: false, motivo: 'El cupón no existe.' };
    if (!cupon.activo) return { valido: false, motivo: 'El cupón ya no está activo.' };
    if (cupon.evento_id !== null && Number(cupon.evento_id) !== Number(eventoId)) {
        return { valido: false, motivo: 'Este cupón no es válido para este evento.' };
    }
    if (cupon.usos_maximos !== null && cupon.usos_actuales >= cupon.usos_maximos) {
        return { valido: false, motivo: 'Este cupón alcanzó su límite de usos.' };
    }

    const descuento = calcularDescuento(cupon, subtotal);
    return { valido: true, cupon, descuento, nuevoSubtotal: Math.round((subtotal - descuento) * 100) / 100 };
}

// Contador informativo: se llama DESPUÉS de confirmar el pago (ver services/procesarPago.js),
// nunca antes de cobrar. La barrera real contra el sobreuso es validarCupon() en /crear-pago;
// esto solo lleva la cuenta de cuántas veces se usó de verdad.
async function incrementarUso(codigo) {
    await pool.query('UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE codigo = ?', [String(codigo).trim().toUpperCase()]);
}

// --- Gestión desde el panel del organizador (siempre scoped a UN evento puntual) ---

async function crearCupon({ eventoId, codigo, tipo, valor, usosMaximos }) {
    await pool.query(
        'INSERT INTO cupones (evento_id, codigo, tipo, valor, usos_maximos) VALUES (?, ?, ?, ?, ?)',
        [eventoId, String(codigo).trim().toUpperCase(), tipo, valor, usosMaximos || null]
    );
}

async function obtenerCuponesDeEvento(eventoId) {
    const [filas] = await pool.query('SELECT * FROM cupones WHERE evento_id = ? ORDER BY id DESC', [eventoId]);
    return filas;
}

// El WHERE incluye evento_id a propósito: así el dueño del evento A nunca puede borrar o
// desactivar un cupón del evento B, aunque adivine/manipule el id en el POST.
async function eliminarCupon(cuponId, eventoId) {
    await pool.query('DELETE FROM cupones WHERE id = ? AND evento_id = ?', [cuponId, eventoId]);
}

async function toggleActivo(cuponId, eventoId) {
    await pool.query('UPDATE cupones SET activo = NOT activo WHERE id = ? AND evento_id = ?', [cuponId, eventoId]);
}

module.exports = {
    obtenerCuponPorCodigo, validarCupon, incrementarUso,
    crearCupon, obtenerCuponesDeEvento, eliminarCupon, toggleActivo
};
