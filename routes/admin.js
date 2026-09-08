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

// Acredita (o desacredita) un evento a mano — una de las dos condiciones para que se haga
// público (la otra es que el creador tenga el mail verificado; ver eventosDb.eventoEsPublico).
router.post('/admin/eventos/:slug/acreditar', requiereLogin, requiereAdmin, async (req, res) => {
    // El formulario manda el slug (mismo formato que el resto del panel), no el id numérico:
    // hay que resolver el evento antes de tocarlo, porque acreditarEvento() filtra por id.
    const evento = await eventosDb.obtenerEventoPorSlugOId(req.params.slug);
    if (!evento) return res.status(404).send('Evento no encontrado.');

    await eventosDb.acreditarEvento(evento.id, req.body.acreditar === '1');
    res.redirect('/admin');
});

module.exports = router;
