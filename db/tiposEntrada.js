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

async function editarTipoEntrada(id, { nombre, descripcion, precio, cupoTotal, activo }) {
    await pool.query(
        `UPDATE tipos_entrada SET nombre = ?, descripcion = ?, precio = ?, cupo_total = ?, activo = ? WHERE id = ?`,
        [nombre, descripcion || null, precio, cupoTotal, activo ? 1 : 0, id]
    );
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

module.exports = { crearTipoEntrada, editarTipoEntrada, obtenerTiposPorEvento, obtenerTipoEntrada, eventoAgotado };
