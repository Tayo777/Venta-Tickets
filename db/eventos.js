const crypto = require('crypto');
const { pool } = require('./pool');

async function obtenerEventosActivos() {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE activo = 1 ORDER BY id DESC');
    return filas;
}

// Eventos con Mercado Pago conectado (tienen access_token propio), para el job de
// reconciliación: hay que consultar la cuenta de CADA organizador por separado.
async function obtenerEventosConectados() {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE conectado_mp = 1 AND mp_access_token IS NOT NULL');
    return filas;
}

async function obtenerTodos() {
    const [filas] = await pool.query('SELECT e.*, u.email AS dueño_email FROM eventos e LEFT JOIN usuarios u ON e.usuario_id = u.id ORDER BY e.id DESC');
    return filas;
}

async function obtenerEventosDeUsuario(usuarioId) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE usuario_id = ? ORDER BY id DESC', [usuarioId]);
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

async function obtenerEventoPorGuardiaToken(token) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE guardia_token = ?', [token]);
    return filas[0] || null;
}

// Crea un evento nuevo, siempre atado a un usuario (usuarioId) que es su dueño.
async function crearEvento({ usuarioId, nombre, descripcion, fecha, flyerUrl, valorEntrada, tarifaOnline,
                              organizerEmail, comisionMpPct, comisionPropiaPct, fechaCierreVentas }) {
    const token = crypto.randomBytes(16).toString('hex');
    const guardiaToken = crypto.randomBytes(16).toString('hex');
    const [resultado] = await pool.query(
        `INSERT INTO eventos
            (usuario_id, nombre, descripcion, fecha, flyer_url, valor_entrada, tarifa_online, token_informe,
             guardia_token, organizer_email, comision_mp_pct, comision_propia_pct, fecha_cierre_ventas, activo, conectado_mp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [usuarioId, nombre, descripcion || null, fecha || null, flyerUrl || '/flyer.png', valorEntrada, tarifaOnline,
         token, guardiaToken, organizerEmail || null, comisionMpPct, comisionPropiaPct, fechaCierreVentas || null]
    );
    return { id: resultado.insertId, token };
}

async function editarEvento(id, { nombre, descripcion, fecha, flyerUrl, valorEntrada, fechaCierreVentas }) {
    await pool.query(
        `UPDATE eventos SET nombre = ?, descripcion = ?, fecha = ?, flyer_url = ?, valor_entrada = ?, fecha_cierre_ventas = ? WHERE id = ?`,
        [nombre, descripcion, fecha, flyerUrl, valorEntrada, fechaCierreVentas || null, id]
    );
}

// Borra el evento y todo lo que depende de él (transacción: o se borra todo, o nada).
async function eliminarEvento(id) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        await conexion.query('DELETE FROM tickets WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM compras WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM tipos_entrada WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM eventos WHERE id = ?', [id]);
        await conexion.commit();
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
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

// La venta de un evento se cierra sola cuando pasó su fecha_cierre_ventas (si tiene una
// configurada). El cierre por capacidad se resuelve aparte, en tiposEntrada.eventoAgotado,
// porque depende del cupo de cada tipo de entrada (no de una columna del evento).
function ventaVencidaPorTiempo(evento) {
    return Boolean(evento.fecha_cierre_ventas) && new Date(evento.fecha_cierre_ventas) <= new Date();
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

// Listado de ventas con las columnas pedidas para el panel del organizador/admin.
async function listadoVentas(eventoId) {
    const [filas] = await pool.query(
        `SELECT
            c.id AS id_cliente,
            t.nombre_apellido AS nom_y_apellido,
            t.email AS email,
            t.id AS id_entrada,
            t.estado AS estado_entrada,
            t.origen AS origen,
            te.nombre AS tipo_entrada,
            t.fecha_compra AS fecha_y_hora_compra,
            t.fecha_escaneada AS fecha_y_hora_escaneada
         FROM tickets t
         LEFT JOIN compras c ON c.payment_id = t.payment_id
         LEFT JOIN tipos_entrada te ON te.id = t.tipo_entrada_id
         WHERE t.evento_id = ?
         ORDER BY t.fecha_compra DESC`,
        [eventoId]
    );
    return filas;
}

module.exports = {
    obtenerEventosActivos, obtenerEventosConectados, obtenerTodos, obtenerEventosDeUsuario, obtenerEvento,
    obtenerEventoPorToken, obtenerEventoPorGuardiaToken, crearEvento, editarEvento, eliminarEvento,
    conectarMercadoPago, toggleActivo, resumenVentas, listadoVentas, ventaVencidaPorTiempo
};
