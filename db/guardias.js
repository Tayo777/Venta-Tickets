const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

async function crearGuardia({ eventoId, email, password, filaAsignada }) {
    const passwordHash = await bcrypt.hash(password, 12);
    const [resultado] = await pool.query(
        'INSERT INTO guardias (evento_id, email, password_hash, fila_asignada) VALUES (?, ?, ?, ?)',
        [eventoId, String(email).trim().toLowerCase(), passwordHash, filaAsignada]
    );
    return resultado.insertId;
}

// Edita un guardia. `password` es OPCIONAL: si viene vacío o sin definir, la contraseña actual
// queda intacta (no se toca el hash). Solo se re-hashea cuando el organizador escribió una nueva.
async function editarGuardia(guardiaId, eventoId, { email, filaAsignada, password }) {
    const campos = ['email = ?', 'fila_asignada = ?'];
    const valores = [String(email).trim().toLowerCase(), filaAsignada];

    if (password && String(password).length > 0) {
        campos.push('password_hash = ?');
        valores.push(await bcrypt.hash(password, 12));
    }

    // El evento_id en el WHERE evita que el dueño del evento A toque un guardia del evento B.
    valores.push(guardiaId, eventoId);
    await pool.query(`UPDATE guardias SET ${campos.join(', ')} WHERE id = ? AND evento_id = ?`, valores);
}

async function obtenerGuardiaPorEmail(email) {
    const [filas] = await pool.query('SELECT * FROM guardias WHERE email = ?', [String(email).trim().toLowerCase()]);
    return filas[0] || null;
}

async function obtenerGuardiasDeEvento(eventoId) {
    const [filas] = await pool.query('SELECT * FROM guardias WHERE evento_id = ? ORDER BY fila_asignada, email', [eventoId]);
    return filas;
}

async function verificarPassword(guardia, password) {
    return bcrypt.compare(password, guardia.password_hash);
}

// El WHERE incluye evento_id a propósito: el dueño del evento A nunca puede borrar un
// guardia del evento B, aunque adivine/manipule el id en el POST.
async function eliminarGuardia(guardiaId, eventoId) {
    await pool.query('DELETE FROM guardias WHERE id = ? AND evento_id = ?', [guardiaId, eventoId]);
}

async function toggleActivo(guardiaId, eventoId) {
    await pool.query('UPDATE guardias SET activo = NOT activo WHERE id = ? AND evento_id = ?', [guardiaId, eventoId]);
}

module.exports = {
    crearGuardia, editarGuardia, obtenerGuardiaPorEmail, obtenerGuardiasDeEvento, verificarPassword,
    eliminarGuardia, toggleActivo
};
