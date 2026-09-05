const express = require('express');
const router = express.Router();
const eventos = require('../db/eventos');
const tiposEntrada = require('../db/tiposEntrada');
const mp = require('../services/mercadopago');

router.get('/', (req, res) => {
    res.render('landing', { usuarioLogueado: Boolean(req.session.usuarioId) });
});

router.get('/eventos', async (req, res) => {
    try {
        // Los finalizados (por fecha o marcados a mano) no se listan al público.
        const lista = (await eventos.obtenerEventosActivos()).filter((e) => !eventos.eventoFinalizado(e));
        res.render('index', { eventos: lista, usuarioLogueado: Boolean(req.session.usuarioId) });
    } catch (error) {
        console.error('Error al listar eventos:', error);
        res.status(500).send('Error al cargar los eventos.');
    }
});

router.get('/evento/:id', async (req, res) => {
    try {
        const evento = await eventos.obtenerEvento(req.params.id);
        if (!evento || !evento.activo) return res.status(404).send('Evento no encontrado.');
        if (!evento.conectado_mp) return res.status(503).send('Este evento todavía no está listo para vender entradas.');

        if (eventos.eventoFinalizado(evento) || eventos.ventaVencidaPorTiempo(evento)) {
            return res.status(410).send('La venta de entradas para este evento ya cerró.');
        }

        const tipos = await tiposEntrada.obtenerTiposPorEvento(evento.id, { soloActivos: true });
        // La tarifa de servicio es proporcional al precio de CADA tipo, así que se calcula por
        // tipo y viaja al frontend para que el total en pantalla coincida exactamente con lo
        // que después recalcula el servidor en /crear-pago.
        const tiposConCupo = tipos
            .filter((t) => t.cupo_disponible > 0)
            .map((t) => ({ ...t, tarifa: mp.tarifaPorEntrada(evento, t.precio) }));

        if (tiposConCupo.length === 0) {
            return res.status(410).send('Las entradas para este evento están agotadas.');
        }

        res.render('evento', { evento, tipos: tiposConCupo, usuarioLogueado: Boolean(req.session.usuarioId) });
    } catch (error) {
        console.error('Error al cargar evento:', error);
        res.status(500).send('Error al cargar el evento.');
    }
});

module.exports = router;
