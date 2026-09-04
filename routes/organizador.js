const express = require('express');
const multer = require('multer');
const router = express.Router();
const eventosDb = require('../db/eventos');
const tiposEntradaDb = require('../db/tiposEntrada');
const mp = require('../services/mercadopago');
const { subirImagen } = require('../services/imgbb');
const { requiereLogin, requiereAprobado, esDueñoOAdmin } = require('../middleware/auth');
const { BASE_URL } = require('../config/env');

// Guarda el archivo en memoria (no en disco) — se sube a un hosting de imágenes al toque.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/mis-eventos', requiereLogin, async (req, res) => {
    const eventos = req.session.rol === 'admin'
        ? await eventosDb.obtenerTodos()
        : await eventosDb.obtenerEventosDeUsuario(req.session.usuarioId);
    res.render('mis-eventos', { eventos, esAdmin: req.session.rol === 'admin' });
});

router.get('/crear-evento', requiereLogin, requiereAprobado, (req, res) => {
    res.render('crear-evento', { error: null });
});

router.post('/crear-evento', requiereLogin, requiereAprobado, upload.single('flyer'), async (req, res) => {
    const { nombre, descripcion, fecha, valor_entrada, cupo_general, fecha_cierre_ventas,
            vip_activo, valor_vip, cupo_vip } = req.body;
    const valorEntradaNum = Number(valor_entrada);
    const cupoGeneralNum = parseInt(cupo_general);

    const campos = { nombre, descripcion, fecha };
    const faltantes = Object.entries(campos).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (faltantes.length > 0 || !valorEntradaNum || valorEntradaNum <= 0 || !cupoGeneralNum || cupoGeneralNum <= 0 || !req.file) {
        return res.render('crear-evento', { error: 'Completá todos los campos, incluida la imagen del flyer y el cupo de entradas General.' });
    }

    const quiereVip = vip_activo === 'on';
    const valorVipNum = Number(valor_vip);
    const cupoVipNum = parseInt(cupo_vip);
    if (quiereVip && (!valorVipNum || valorVipNum <= 0 || !cupoVipNum || cupoVipNum <= 0)) {
        return res.render('crear-evento', { error: 'Si activás VIP, completá su precio y cupo.' });
    }

    try {
        const flyerUrl = await subirImagen(req.file.buffer);
        const { comisionMpPct, comisionPropiaPct, tarifaOnline } = mp.calcularTarifa(valorEntradaNum);

        const { id } = await eventosDb.crearEvento({
            usuarioId: req.session.usuarioId,
            nombre, descripcion, fecha, flyerUrl,
            valorEntrada: valorEntradaNum, tarifaOnline,
            organizerEmail: null, comisionMpPct, comisionPropiaPct,
            fechaCierreVentas: fecha_cierre_ventas || null
        });

        await tiposEntradaDb.crearTipoEntrada({
            eventoId: id, nombre: 'General', descripcion: null,
            precio: valorEntradaNum, cupoTotal: cupoGeneralNum
        });
        if (quiereVip) {
            await tiposEntradaDb.crearTipoEntrada({
                eventoId: id, nombre: 'VIP', descripcion: null,
                precio: valorVipNum, cupoTotal: cupoVipNum
            });
        }

        res.redirect(`/eventos/${id}`);
    } catch (error) {
        console.error('Error al crear el evento:', error);
        res.render('crear-evento', { error: 'Hubo un error al crear el evento (revisá la imagen e intentá de nuevo).' });
    }
});

router.get('/eventos/:id/editar', requiereLogin, esDueñoOAdmin, (req, res) => {
    res.render('editar-evento', { evento: req.evento, error: null });
});

router.post('/eventos/:id/editar', requiereLogin, esDueñoOAdmin, upload.single('flyer'), async (req, res) => {
    const { nombre, descripcion, fecha, valor_entrada } = req.body;
    try {
        const flyerUrl = req.file ? await subirImagen(req.file.buffer) : req.evento.flyer_url;
        await eventosDb.editarEvento(req.evento.id, {
            nombre, descripcion, fecha, flyerUrl, valorEntrada: Number(valor_entrada)
        });
        res.redirect(`/eventos/${req.evento.id}`);
    } catch (error) {
        console.error('Error al editar el evento:', error);
        res.render('editar-evento', { evento: req.evento, error: 'No se pudo guardar el cambio.' });
    }
});

router.post('/eventos/:id/eliminar', requiereLogin, esDueñoOAdmin, async (req, res) => {
    try {
        await eventosDb.eliminarEvento(req.evento.id);
        res.redirect('/mis-eventos');
    } catch (error) {
        console.error('Error al eliminar el evento:', error);
        res.status(500).send('No se pudo eliminar el evento.');
    }
});

// Panel privado del evento: solo el dueño o el admin pueden entrar. Acá está el link de
// guardia (encriptado, uno por evento) y el listado de ventas — nada de esto es público.
router.get('/eventos/:id', requiereLogin, esDueñoOAdmin, async (req, res) => {
    const evento = req.evento;
    const resumen = await eventosDb.resumenVentas(evento.id);
    const ventas = await eventosDb.listadoVentas(evento.id);
    const recaudacion = (Number(resumen.total_vendidas) || 0) * Number(evento.valor_entrada);

    res.render('evento-detalle', {
        evento, resumen, ventas, recaudacion,
        urlConexionMP: mp.urlConexionOAuth(evento.token_informe),
        urlPublica: `${BASE_URL}/evento/${evento.id}`,
        urlGuardia: `${BASE_URL}/login-guardia/${evento.id}?token=${evento.guardia_token}`,
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

        res.redirect(`/eventos/${evento.id}?conectado=1`);
    } catch (error) {
        console.error('Error al conectar con Mercado Pago:', error);
        res.status(500).send('Hubo un error al conectar tu cuenta de Mercado Pago. Volvé a intentarlo desde tu panel.');
    }
});

module.exports = router;
