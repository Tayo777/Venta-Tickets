const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const usuariosDb = require('../db/usuarios');
const { requiereLogin, requiereAdmin } = require('../middleware/auth');

router.get('/admin', requiereLogin, requiereAdmin, async (req, res) => {
    const eventos = await eventosDb.obtenerTodos();
    const pendientes = await usuariosDb.obtenerPendientesDeAprobacion();
    // Mismo criterio que el panel del organizador: activos arriba, finalizados aparte en
    // modo solo lectura (el admin es el único que además los puede eliminar).
    const { activos, finalizados } = eventosDb.separarPorEstado(eventos);
    res.render('admin', { activos, finalizados, pendientes });
});

module.exports = router;
