const crypto = require('crypto');
const { pool } = require('./pool');

async function obtenerEventosActivos() {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE activo = 1 ORDER BY id DESC');
    return filas;
}

async function obtenerTodos() {
    const [filas] = await pool.query('SELECT * FROM eventos ORDER BY id DESC');
    return filas;
}

async function obtenerEvento(id) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE id = ?', [id]);
    return filas[0] || null;
}

async function obtenerEventoPorToken(token) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE token_informe = ?', [token]);
    return filas[0] || null;
}

// Crea un evento nuevo (autogestión o admin) y devuelve su id + token privado.
async function crearEvento({ nombre, descripcion, fecha, flyerUrl, valorEntrada, tarifaOnline,
                              organizerEmail, comisionMpPct, comisionPropiaPct }) {
    const token = crypto.randomBytes(16).toString('hex');
    const [resultado] = await pool.query(
        `INSERT INTO eventos
            (nombre, descripcion, fecha, flyer_url, valor_entrada, tarifa_online, token_informe,
             organizer_email, comision_mp_pct, comision_propia_pct, activo, conectado_mp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [nombre, descripcion || null, fecha || null, flyerUrl || '/flyer.png', valorEntrada, tarifaOnline,
         token, organizerEmail || null, comisionMpPct, comisionPropiaPct]
    );
    return { id: resultado.insertId, token };
}

// Guarda las credenciales de Mercado Pago del organizador tras el OAuth y activa el evento.
async function conectarMercadoPago(id, { accessToken, refreshToken, userId }) {
    await pool.query(
        `UPDATE eventos SET mp_access_token = ?, mp_refresh_token = ?, mp_user_id = ?, conectado_mp = 1, activo = 1 WHERE id = ?`,
        [accessToken, refreshToken, userId, id]
    );
}

async function toggleActivo(id) {
    await pool.query('UPDATE eventos SET activo = NOT activo WHERE id = ?', [id]);
}

async function resumenVentas(eventoId) {
    const [[resumen]] = await pool.query(
        `SELECT
            COUNT(*) AS total_vendidas,
            SUM(CASE WHEN estado = 'Usada' THEN 1 ELSE 0 END) AS total_ingresadas,
            COUNT(DISTINCT email) AS total_compradores
         FROM tickets WHERE evento_id = ?`,
        [eventoId]
    );
    return resumen;
}

module.exports = {
    obtenerEventosActivos, obtenerTodos, obtenerEvento, obtenerEventoPorToken,
    crearEvento, conectarMercadoPago, toggleActivo, resumenVentas
};
