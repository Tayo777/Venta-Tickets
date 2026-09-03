const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const mp = require('../services/mercadopago');
const { enviarMailBrevo } = require('../services/brevo');
const { BASE_URL } = require('../config/env');

router.get('/crear-evento', (req, res) => {
    res.render('crear-evento');
});

router.post('/crear-evento', async (req, res) => {
    const { nombre, descripcion, fecha, flyer_url, valor_entrada, organizer_email } = req.body;
    const valorEntradaNum = Number(valor_entrada);

    const campos = { nombre, descripcion, fecha, flyer_url, organizer_email };
    const faltantes = Object.entries(campos).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (faltantes.length > 0 || !valorEntradaNum || valorEntradaNum <= 0) {
        return res.status(400).send(`Faltan datos obligatorios: ${faltantes.join(', ') || 'precio de la entrada'}.`);
    }

    // Cálculo 100% automático de la tarifa (comisión estimada de Mercado Pago + de la plataforma)
    const { comisionMpPct, comisionPropiaPct, tarifaOnline } = mp.calcularTarifa(valorEntradaNum);

    try {
        const { id, token } = await eventosDb.crearEvento({
            nombre, descripcion, fecha, flyerUrl: flyer_url,
            valorEntrada: valorEntradaNum, tarifaOnline,
            organizerEmail: organizer_email, comisionMpPct, comisionPropiaPct
        });

        const linkPrivado = `${BASE_URL}/organizador/${id}?token=${token}`;
        try {
            await enviarMailBrevo({
                to: organizer_email,
                subject: `🎟️ Tu panel para "${nombre}"`,
                text: `¡Creaste tu evento "${nombre}"! Guardá este link, es privado y es la única forma de administrar tu evento (ver ventas y conectar tu Mercado Pago):\n\n${linkPrivado}`
            });
        } catch (mailError) {
            console.error('No se pudo mandar el mail con el link del organizador:', mailError);
        }

        res.redirect(`/organizador/${id}?token=${token}`);
    } catch (error) {
        console.error('Error al crear el evento:', error);
        res.status(500).send('Error al crear el evento.');
    }
});

// Panel privado del organizador: link único (sin usuario/contraseña) para conectar
// Mercado Pago y ver las ventas de SU evento en tiempo real.
router.get('/organizador/:id', async (req, res) => {
    const evento = await eventosDb.obtenerEvento(req.params.id);
    if (!evento || req.query.token !== evento.token_informe) {
        return res.status(403).send('Acceso denegado. Verificá el link que te llegó por mail.');
    }

    const resumen = await eventosDb.resumenVentas(evento.id);
    const recaudacion = (Number(resumen.total_vendidas) || 0) * Number(evento.valor_entrada);

    res.render('organizador', {
        evento, resumen, recaudacion,
        urlConexionMP: mp.urlConexionOAuth(evento.token_informe),
        urlPublica: `${BASE_URL}/evento/${evento.id}`,
        conectado: req.query.conectado === '1'
    });
});

// Mercado Pago redirige acá después de que el organizador acepta conectar su cuenta.
router.get('/oauth/mercadopago/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan datos en la respuesta de Mercado Pago.');

    try {
        const evento = await eventosDb.obtenerEventoPorToken(state);
        if (!evento) return res.status(404).send('No se encontró el evento asociado a esta conexión.');

        const tokens = await mp.intercambiarCodigoOAuth(code);
        await eventosDb.conectarMercadoPago(evento.id, {
            accessToken: tokens.access_token, refreshToken: tokens.refresh_token, userId: tokens.user_id
        });

        res.redirect(`/organizador/${evento.id}?token=${state}&conectado=1`);
    } catch (error) {
        console.error('Error al conectar con Mercado Pago:', error);
        res.status(500).send('Hubo un error al conectar tu cuenta de Mercado Pago. Volvé a intentarlo desde tu panel.');
    }
});

// Compatibilidad con links viejos (/informe) generados antes de este cambio
router.get('/informe/:eventoId', (req, res) => {
    res.redirect(`/organizador/${req.params.eventoId}?token=${req.query.token || ''}`);
});

module.exports = router;
