const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./pool');
const { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD } = require('../config/env');

async function obtenerPorEmail(email) {
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    return filas[0] || null;
}

async function obtenerPorId(id) {
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
    return filas[0] || null;
}

async function obtenerPorTokenVerificacion(token) {
    const [filas] = await pool.query('SELECT * FROM usuarios WHERE token_verificacion = ?', [token]);
    return filas[0] || null;
}

// Crea un usuario nuevo (contraseña SIEMPRE hasheada, nunca en texto plano en la DB).
async function crearUsuario({ nombre, email, telefono, password }) {
    const passwordHash = await bcrypt.hash(password, 12);
    const tokenVerificacion = crypto.randomBytes(24).toString('hex');
    const [resultado] = await pool.query(
        `INSERT INTO usuarios (nombre, email, telefono, password_hash, token_verificacion)
         VALUES (?, ?, ?, ?, ?)`,
        [nombre, email, telefono, passwordHash, tokenVerificacion]
    );
    return { id: resultado.insertId, tokenVerificacion };
}

async function verificarPassword(usuario, password) {
    return bcrypt.compare(password, usuario.password_hash);
}

async function marcarEmailVerificado(usuarioId) {
    const tokenAprobacion = crypto.randomBytes(24).toString('hex');
    await pool.query(
        'UPDATE usuarios SET email_verificado = 1, token_aprobacion = ? WHERE id = ?',
        [tokenAprobacion, usuarioId]
    );
    return tokenAprobacion;
}

async function obtenerPorTokenAprobacion(id, token) {
    const [filas] = await pool.query(
        'SELECT * FROM usuarios WHERE id = ? AND token_aprobacion = ?', [id, token]
    );
    return filas[0] || null;
}

async function aprobarUsuario(id) {
    await pool.query('UPDATE usuarios SET aprobado = 1 WHERE id = ?', [id]);
}

async function obtenerPendientesDeAprobacion() {
    const [filas] = await pool.query(
        'SELECT * FROM usuarios WHERE email_verificado = 1 AND aprobado = 0 ORDER BY id DESC'
    );
    return filas;
}

// Si no existe ningún usuario todavía, crea el admin dueño de la plataforma usando las
// credenciales de las variables de entorno (nunca escritas en el código fuente).
async function asegurarAdminSemilla() {
    const existente = await obtenerPorEmail(ADMIN_SEED_EMAIL);
    if (existente) return;

    const passwordHash = await bcrypt.hash(ADMIN_SEED_PASSWORD, 12);
    await pool.query(
        `INSERT INTO usuarios (nombre, email, telefono, password_hash, rol, email_verificado, aprobado)
         VALUES (?, ?, ?, ?, 'admin', 1, 1)`,
        ['Admin', ADMIN_SEED_EMAIL, null, passwordHash]
    );
    console.log(`Usuario admin creado: ${ADMIN_SEED_EMAIL}. Cambiá la contraseña apenas puedas.`);
}

module.exports = {
    obtenerPorEmail, obtenerPorId, obtenerPorTokenVerificacion, crearUsuario, verificarPassword,
    marcarEmailVerificado, obtenerPorTokenAprobacion, aprobarUsuario, obtenerPendientesDeAprobacion,
    asegurarAdminSemilla
};
