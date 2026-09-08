const { pool } = require('./pool');

async function yaProcesada(paymentId) {
    const [filas] = await pool.query('SELECT id FROM compras WHERE payment_id = ?', [paymentId]);
    return filas.length > 0;
}

async function registrarCompra({ paymentId, eventoId, email, cantidad, montoTotal }) {
    await pool.query(
        'INSERT INTO compras (payment_id, evento_id, email, cantidad, monto_total) VALUES (?, ?, ?, ?, ?)',
        [paymentId, eventoId, email, cantidad, montoTotal]
    );
}

// Guarda la comisión REAL que cobró Mercado Pago en esta transacción puntual (se consulta
// después del pago, ya que antes no se puede saber con exactitud — ver services/mercadopago.js).
async function guardarComisionReal(paymentId, { comisionMpReal, montoNeto }) {
    await pool.query(
        'UPDATE compras SET comision_mp_real = ?, monto_neto_organizador = ? WHERE payment_id = ?',
        [comisionMpReal, montoNeto, paymentId]
    );
}

// NOTA: acá vivía ajustarTarifaConDatosReales(), que promediaba la comisión real observada y
// la escribía en eventos.comision_mp_pct. Se eliminó a propósito: ese porcentaje alimenta el
// gross-up del precio, así que recalcularlo después de cada venta hacía que el precio que ve
// el comprador se moviera solo (un evento publicado a $1111 pasaba a $1089 sin que nadie lo
// tocara). Ahora el porcentaje es una constante fija (config/env.js -> MP_COMISION_PCT), que
// además se congela por evento al crearlo.
//
// El dato real no se pierde: guardarComisionReal() sigue guardando por compra la comisión
// exacta que cobró Mercado Pago (compras.comision_mp_real) y el neto recibido, que es la
// fuente correcta para los informes.

// Ventas agrupadas por día, para el gráfico de líneas del panel del organizador. Se agrupa
// sobre `compras` (una fila por PAGO) y no sobre `tickets` (una fila por entrada individual)
// porque acá interesa la evolución de las ventas en el tiempo, no el detalle de cada ticket.
async function obtenerVentasPorFecha(eventoId) {
    const [filas] = await pool.query(
        `SELECT DATE(fecha_compra) AS fecha, SUM(cantidad) AS entradas_vendidas, SUM(monto_total) AS monto_total
         FROM compras
         WHERE evento_id = ?
         GROUP BY DATE(fecha_compra)
         ORDER BY fecha`,
        [eventoId]
    );
    return filas;
}

module.exports = {
    yaProcesada, registrarCompra, guardarComisionReal, obtenerVentasPorFecha
};
