const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const usuariosDb = require('../db/usuarios');
const { requiereLogin, requiereAdmin, isAdmin } = require('../middleware/auth');

router.get('/admin', requiereLogin, requiereAdmin, async (req, res) => {
    const eventos = await eventosDb.obtenerTodos();
    const pendientes = await usuariosDb.obtenerPendientesDeAprobacion();
    // Mismo criterio que el panel del organizador: activos arriba, finalizados aparte en
    // modo solo lectura (el admin es el único que además los puede eliminar).
    const { activos, finalizados } = eventosDb.separarPorEstado(eventos);
    res.render('admin', { activos, finalizados, pendientes });
});

// Panel de acreditación: SOLO eventos esperando el visto bueno del admin. Es la pantalla a la
// que apuntan los mails de aviso, pensada para resolver rápido la cola de pendientes.
router.get('/admin/dashboard', isAdmin, async (req, res) => {
    try {
        const pendientes = await eventosDb.obtenerEventosPendientesAcreditacion();
        res.render('admin-dashboard', { pendientes, acreditado: req.query.acreditado || null });
    } catch (error) {
        console.error('Error al cargar el panel de acreditación:', error);
        res.status(500).send('No se pudo cargar el panel de acreditación.');
    }
});

// Acreditación rápida desde el link del mail. Es GET a propósito (un mail no puede mandar un
// POST), y por eso el middleware isAdmin es imprescindible: sin sesión de admin, abrir este
// link no acredita nada — manda a login.
router.get('/admin/acreditar/:slug', isAdmin, async (req, res) => {
    try {
        const evento = await eventosDb.obtenerEventoPorSlugOId(req.params.slug);
        if (!evento) return res.status(404).send('Evento no encontrado.');

        await eventosDb.acreditarEvento(evento.id, true);
        console.log(`[admin] Evento "${evento.nombre}" (${evento.slug}) acreditado por ${req.usuarioAdmin.email}.`);

        res.redirect(`/admin/dashboard?acreditado=${encodeURIComponent(evento.nombre)}`);
    } catch (error) {
        console.error('Error al acreditar el evento:', error);
        res.status(500).send('No se pudo acreditar el evento.');
    }
});

// Acredita (o desacredita) un evento a mano — una de las dos condiciones para que se haga
// público (la otra es que el creador tenga el mail verificado; ver eventosDb.eventoEsPublico).
router.post('/admin/eventos/:slug/acreditar', isAdmin, async (req, res) => {
    // El formulario manda el slug (mismo formato que el resto del panel), no el id numérico:
    // hay que resolver el evento antes de tocarlo, porque acreditarEvento() filtra por id.
    const evento = await eventosDb.obtenerEventoPorSlugOId(req.params.slug);
    if (!evento) return res.status(404).send('Evento no encontrado.');

    await eventosDb.acreditarEvento(evento.id, req.body.acreditar === '1');
    // Vuelve a la pantalla desde la que se disparó la acción (el panel de pendientes o el
    // listado general), en vez de mandar siempre al mismo lado.
    res.redirect(req.body.volver_a === 'dashboard' ? '/admin/dashboard' : '/admin');
});

module.exports = router;
