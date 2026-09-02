const express = require('express');
const router = express.Router();
const eventos = require('../db/eventos');

router.get('/', (req, res) => {
    res.render('landing');
});

router.get('/eventos', async (req, res) => {
    try {
        const lista = await eventos.obtenerEventosActivos();
        res.render('index', { eventos: lista });
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
        res.render('evento', { evento });
    } catch (error) {
        console.error('Error al cargar evento:', error);
        res.status(500).send('Error al cargar el evento.');
    }
});

module.exports = router;
