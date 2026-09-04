const express = require('express');
const router = express.Router();
const usuariosDb = require('../db/usuarios');
const eventosDb = require('../db/eventos');
const { requiereLogin } = require('../middleware/auth');

// --- Editar perfil ---
router.get('/perfil', requiereLogin, async (req, res) => {
    const usuario = await usuariosDb.obtenerPorId(req.session.usuarioId);
    res.render('perfil', { usuario, error: null, guardado: false });
});

router.post('/perfil', requiereLogin, async (req, res) => {
    const { nombre, telefono } = req.body;
    if (!nombre || !String(nombre).trim()) {
        const usuario = await usuariosDb.obtenerPorId(req.session.usuarioId);
        return res.render('perfil', { usuario, error: 'El nombre no puede estar vacío.', guardado: false });
    }

    await usuariosDb.actualizarPerfil(req.session.usuarioId, { nombre: nombre.trim(), telefono: telefono || null });
    req.session.nombre = nombre.trim(); // así el navbar (que lee req.session.nombre) se actualiza al toque

    const usuario = await usuariosDb.obtenerPorId(req.session.usuarioId);
    res.render('perfil', { usuario, error: null, guardado: true });
});

// Cambio de contraseña estando logueado: pide la actual (a diferencia del flujo de
// "olvidé mi contraseña", acá SÍ hay que probar que sos vos antes de cambiarla).
router.post('/perfil/password', requiereLogin, async (req, res) => {
    const { password_actual, password_nueva } = req.body;
    const usuario = await usuariosDb.obtenerPorId(req.session.usuarioId);

    const falla = (mensaje) => res.render('perfil', { usuario, error: mensaje, guardado: false });

    if (!password_nueva || password_nueva.length < 8) {
        return falla('La contraseña nueva tiene que tener al menos 8 caracteres.');
    }
    const passwordOk = await usuariosDb.verificarPassword(usuario, password_actual || '');
    if (!passwordOk) {
        return falla('Tu contraseña actual no es correcta.');
    }

    await usuariosDb.cambiarPassword(usuario.id, password_nueva);
    res.render('perfil', { usuario, error: null, guardado: true });
});

// --- Configuración de cobros ---
// Hub que junta el estado de Mercado Pago de TODOS los eventos del usuario en un solo lugar
// (la conexión en sí sigue siendo por evento, porque cada evento tiene su propia cuenta de
// Mercado Pago vinculada — no hay una "cuenta de cobro" global de la plataforma).
router.get('/cobros', requiereLogin, async (req, res) => {
    const eventos = req.session.rol === 'admin'
        ? await eventosDb.obtenerTodos()
        : await eventosDb.obtenerEventosDeUsuario(req.session.usuarioId);
    res.render('cobros', { eventos });
});

module.exports = router;
