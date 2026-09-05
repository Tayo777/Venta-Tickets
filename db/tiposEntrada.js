const { pool } = require('./pool');

// Crea un tipo de entrada (General, VIP, etc.) para un evento.
async function crearTipoEntrada({ eventoId, nombre, descripcion, precio, cupoTotal }) {
    const [resultado] = await pool.query(
        `INSERT INTO tipos_entrada (evento_id, nombre, descripcion, precio, cupo_total)
         VALUES (?, ?, ?, ?, ?)`,
        [eventoId, nombre, descripcion || null, precio, cupoTotal]
    );
    return resultado.insertId;
}

async function editarTipoEntrada(id, eventoId, { nombre, descripcion, precio, cupoTotal }) {
    await pool.query(
        `UPDATE tipos_entrada SET nombre = ?, descripcion = ?, precio = ?, cupo_total = ?
         WHERE id = ? AND evento_id = ?`,
        [nombre, descripcion || null, precio, cupoTotal, id, eventoId]
    );
}

async function toggleActivo(id, eventoId) {
    await pool.query('UPDATE tipos_entrada SET activo = NOT activo WHERE id = ? AND evento_id = ?', [id, eventoId]);
}

// Solo se puede borrar un tipo que todavía no vendió NADA — si ya tiene entradas emitidas,
// borrarlo dejaría tickets huérfanos (y rompería el historial de ventas). En ese caso el
// organizador lo desactiva en vez de borrarlo.
async function eliminarTipoEntrada(id, eventoId) {
    const [[fila]] = await pool.query('SELECT COUNT(*) AS emitidas FROM tickets WHERE tipo_entrada_id = ?', [id]);
    if (fila.emitidas > 0) return { borrado: false, motivo: 'Este tipo ya tiene entradas emitidas: desactivalo en vez de borrarlo.' };

    await pool.query('DELETE FROM tipos_entrada WHERE id = ? AND evento_id = ?', [id, eventoId]);
    return { borrado: true };
}

// Todos los tipos de un evento, con el cupo disponible ya calculado (para mostrar en la web).
async function obtenerTiposPorEvento(eventoId, { soloActivos = false } = {}) {
    const condicionActivo = soloActivos ? 'AND activo = 1' : '';
    const [filas] = await pool.query(
        `SELECT *, (cupo_total - cupo_vendido) AS cupo_disponible
         FROM tipos_entrada WHERE evento_id = ? ${condicionActivo} ORDER BY id ASC`,
        [eventoId]
    );
    return filas;
}

async function obtenerTipoEntrada(id) {
    const [filas] = await pool.query(
        `SELECT *, (cupo_total - cupo_vendido) AS cupo_disponible FROM tipos_entrada WHERE id = ?`,
        [id]
    );
    return filas[0] || null;
}

// Un evento está agotado cuando TODOS sus tipos de entrada activos ya no tienen cupo disponible.
async function eventoAgotado(eventoId) {
    const [[fila]] = await pool.query(
        `SELECT COUNT(*) AS tipos_con_cupo FROM tipos_entrada
         WHERE evento_id = ? AND activo = 1 AND cupo_vendido < cupo_total`,
        [eventoId]
    );
    return fila.tipos_con_cupo === 0;
}

module.exports = {
    crearTipoEntrada, editarTipoEntrada, toggleActivo, eliminarTipoEntrada,
    obtenerTiposPorEvento, obtenerTipoEntrada, eventoAgotado
};
