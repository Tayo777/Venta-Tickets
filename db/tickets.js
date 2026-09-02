const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');

// Registra N entradas nuevas para un evento y devuelve sus códigos (todo o nada, en transacción).
async function registrarEntradas(eventoId, email, cantidad) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        const codigos = [];
        for (let i = 0; i < cantidad; i++) {
            const id = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
            codigos.push(id);
            await conexion.query('INSERT INTO tickets (id, evento_id, email) VALUES (?, ?, ?)', [id, eventoId, email]);
        }
        await conexion.commit();
        return codigos;
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
}

// Busca las últimas N entradas de un email, con el nombre del evento (para el PDF/descarga).
async function obtenerUltimasEntradas(email, limit) {
    const [filas] = await pool.query(
        `SELECT t.id, e.nombre AS evento_nombre FROM tickets t
         JOIN eventos e ON t.evento_id = e.id
         WHERE t.email = ? ORDER BY t.fecha_compra DESC LIMIT ?`,
        [email, limit]
    );
    return filas;
}

// Busca un ticket puntual junto con el nombre de su evento (para /validar).
async function obtenerTicketConEvento(ticketId) {
    const [filas] = await pool.query(
        `SELECT t.*, e.nombre AS evento_nombre FROM tickets t
         JOIN eventos e ON t.evento_id = e.id
         WHERE t.id = ?`,
        [ticketId]
    );
    return filas[0] || null;
}

async function marcarComoUsada(ticketId) {
    await pool.query('UPDATE tickets SET estado = ? WHERE id = ?', ['Usada', ticketId]);
}

module.exports = { registrarEntradas, obtenerUltimasEntradas, obtenerTicketConEvento, marcarComoUsada };
