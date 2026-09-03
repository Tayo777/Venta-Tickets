const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const usuariosDb = require('../db/usuarios');
const { requiereLogin, requiereAdmin } = require('../middleware/auth');

router.get('/admin', requiereLogin, requiereAdmin, async (req, res) => {
    const eventos = await eventosDb.obtenerTodos();
    const pendientes = await usuariosDb.obtenerPendientesDeAprobacion();
    res.render('admin', { eventos, pendientes });
});

module.exports = router;
