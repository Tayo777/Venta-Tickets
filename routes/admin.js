const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const mp = require('../services/mercadopago');
const { ADMIN_CLAVE, BASE_URL } = require('../config/env');

function requiereAdmin(req, res, next) {
    const clave = req.query.clave || req.body.clave;
    if (clave !== ADMIN_CLAVE) {
        return res.status(403).send('Acceso denegado. Agregá ?clave=TU_CLAVE_ADMIN a la URL.');
    }
    next();
}

router.get('/admin/eventos', requiereAdmin, async (req, res) => {
    const eventos = await eventosDb.obtenerTodos();
    res.render('admin', { eventos, clave: req.query.clave, baseUrl: BASE_URL });
});

router.post('/admin/eventos', requiereAdmin, async (req, res) => {
    const { nombre, fecha, flyer_url, valor_entrada, organizer_email } = req.body;
    const { comisionMpPct, comisionPropiaPct, tarifaOnline } = mp.calcularTarifa(Number(valor_entrada));

    await eventosDb.crearEvento({
        nombre, fecha, flyerUrl: flyer_url, valorEntrada: Number(valor_entrada), tarifaOnline,
        organizerEmail: organizer_email, comisionMpPct, comisionPropiaPct
    });

    res.redirect(`/admin/eventos?clave=${req.query.clave}`);
});

router.post('/admin/eventos/:id/toggle', requiereAdmin, async (req, res) => {
    await eventosDb.toggleActivo(req.params.id);
    res.redirect(`/admin/eventos?clave=${req.query.clave}`);
});

module.exports = router;
