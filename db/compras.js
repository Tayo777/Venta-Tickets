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

// Afina comision_mp_pct con el PROMEDIO de comisiones reales ya observadas en las ventas de
// este evento (en vez de quedarse con la estimación genérica). Se llama después de cada venta,
// así que a partir de la 2da entrada vendida los precios ya reflejan datos reales de ESE
// evento, y se va afinando solo.
//
// Ojo: este porcentaje es AHORA el que fija la tarifa de cada entrada (ver
// mp.tarifaPorEntrada), no un dato meramente informativo como antes. eventos.tarifa_online
// pasó a ser solo un valor de referencia sobre el precio base del evento, que se guarda para
// mostrarlo — el checkout no lo usa más.
async function ajustarTarifaConDatosReales(eventoId) {
    const [[evento]] = await pool.query('SELECT valor_entrada, comision_propia_pct FROM eventos WHERE id = ?', [eventoId]);
    if (!evento) return;

    // El porcentaje real de Mercado Pago se mide contra el MONTO EFECTIVAMENTE COBRADO de cada
    // compra (monto_total), no contra "cantidad x precio de referencia": desde que una compra
    // puede mezclar varios tipos de entrada a distinto precio (y llevar cupón), esa cuenta
    // vieja ya no representaba lo que se cobró y desviaba la estimación.
    const [[{ pctPromedio, muestras }]] = await pool.query(
        `SELECT AVG(comision_mp_real / monto_total) * 100 AS pctPromedio, COUNT(*) AS muestras
         FROM compras WHERE evento_id = ? AND comision_mp_real IS NOT NULL AND monto_total > 0`,
        [eventoId]
    );

    if (!muestras || pctPromedio === null) return; // todavía no hay datos reales, se sigue usando la estimación

    const comisionMpPct = Number(pctPromedio);
    const tarifaOnline = Math.round(Number(evento.valor_entrada) * (comisionMpPct + Number(evento.comision_propia_pct)) / 100);

    await pool.query('UPDATE eventos SET comision_mp_pct = ?, tarifa_online = ? WHERE id = ?', [comisionMpPct, tarifaOnline, eventoId]);
    console.log(`Tarifa del evento ${eventoId} ajustada con datos reales: ${comisionMpPct.toFixed(2)}% MP (${muestras} venta/s con datos)`);
}

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
    yaProcesada, registrarCompra, guardarComisionReal, ajustarTarifaConDatosReales, obtenerVentasPorFecha
};
