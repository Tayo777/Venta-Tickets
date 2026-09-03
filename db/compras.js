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

// Recalcula la tarifa de un evento usando el PROMEDIO de comisiones reales ya observadas
// en sus ventas anteriores (en vez de la estimación fija genérica). Se llama después de cada
// venta, así que a partir de la 2da entrada vendida el precio ya refleja datos reales de ESE
// evento puntual, y se va afinando solo con cada venta nueva.
async function ajustarTarifaConDatosReales(eventoId) {
    const [[evento]] = await pool.query('SELECT valor_entrada, comision_propia_pct FROM eventos WHERE id = ?', [eventoId]);
    if (!evento) return;

    const [[{ pctPromedio, muestras }]] = await pool.query(
        `SELECT AVG(comision_mp_real / (cantidad * ?)) * 100 AS pctPromedio, COUNT(*) AS muestras
         FROM compras WHERE evento_id = ? AND comision_mp_real IS NOT NULL`,
        [evento.valor_entrada, eventoId]
    );

    if (!muestras || pctPromedio === null) return; // todavía no hay datos reales, se sigue usando la estimación

    const comisionMpPct = Number(pctPromedio);
    const tarifaOnline = Math.round(Number(evento.valor_entrada) * (comisionMpPct + Number(evento.comision_propia_pct)) / 100);

    await pool.query('UPDATE eventos SET comision_mp_pct = ?, tarifa_online = ? WHERE id = ?', [comisionMpPct, tarifaOnline, eventoId]);
    console.log(`Tarifa del evento ${eventoId} ajustada con datos reales: ${comisionMpPct.toFixed(2)}% MP (${muestras} venta/s con datos)`);
}

module.exports = { yaProcesada, registrarCompra, guardarComisionReal, ajustarTarifaConDatosReales };
