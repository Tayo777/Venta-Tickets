const express = require('express');
const multer = require('multer');
const router = express.Router();
const eventosDb = require('../db/eventos');
const tiposEntradaDb = require('../db/tiposEntrada');
const ticketsDb = require('../db/tickets');
const mp = require('../services/mercadopago');
const { subirImagen } = require('../services/imgbb');
const { enviarMailBrevo } = require('../services/brevo');
const { generarPdfBuffer } = require('../services/pdfEntradas');
const { requiereLogin, requiereAprobado, esDueñoOAdmin } = require('../middleware/auth');
const { BASE_URL } = require('../config/env');

// Guarda el archivo en memoria (no en disco) — se sube a un hosting de imágenes al toque.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

router.get('/mis-eventos', requiereLogin, async (req, res) => {
    const eventos = req.session.rol === 'admin'
        ? await eventosDb.obtenerTodos()
        : await eventosDb.obtenerEventosDeUsuario(req.session.usuarioId);
    res.render('mis-eventos', { eventos, esAdmin: req.session.rol === 'admin' });
});

router.get('/crear-evento', requiereLogin, requiereAprobado, (req, res) => {
    res.render('crear-evento', { error: null, usuarioLogueado: true });
});

router.post('/crear-evento', requiereLogin, requiereAprobado, upload.single('flyer'), async (req, res) => {
    const { nombre, descripcion, fecha, valor_entrada, cupo_general, fecha_cierre_ventas,
            vip_activo, valor_vip, cupo_vip } = req.body;
    const valorEntradaNum = Number(valor_entrada);
    const cupoGeneralNum = parseInt(cupo_general);

    const campos = { nombre, descripcion, fecha };
    const faltantes = Object.entries(campos).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (faltantes.length > 0 || !valorEntradaNum || valorEntradaNum <= 0 || !cupoGeneralNum || cupoGeneralNum <= 0 || !req.file) {
        return res.render('crear-evento', { error: 'Completá todos los campos, incluida la imagen del flyer y el cupo de entradas General.', usuarioLogueado: true });
    }

    const quiereVip = vip_activo === 'on';
    const valorVipNum = Number(valor_vip);
    const cupoVipNum = parseInt(cupo_vip);
    if (quiereVip && (!valorVipNum || valorVipNum <= 0 || !cupoVipNum || cupoVipNum <= 0)) {
        return res.render('crear-evento', { error: 'Si activás VIP, completá su precio y cupo.', usuarioLogueado: true });
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
        res.render('crear-evento', { error: 'Hubo un error al crear el evento (revisá la imagen e intentá de nuevo).', usuarioLogueado: true });
    }
});

router.get('/eventos/:id/editar', requiereLogin, esDueñoOAdmin, (req, res) => {
    res.render('editar-evento', { evento: req.evento, error: null, usuarioLogueado: true });
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
        res.render('editar-evento', { evento: req.evento, error: 'No se pudo guardar el cambio.', usuarioLogueado: true });
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
        conectado: req.query.conectado === '1',
        cortesia: req.query.cortesia === '1',
        reenviado: req.query.reenviado === '1'
    });
});

// Entradas de cortesía: el organizador/admin las genera a mano, sin pasar por Mercado Pago
// ni descontar cupo pago (van con tipo_entrada_id NULL, origen 'cortesia').
router.post('/eventos/:id/cortesia', requiereLogin, esDueñoOAdmin, async (req, res) => {
    const { email, nombre_apellido, cantidad } = req.body;
    const cant = parseInt(cantidad);

    if (!email || !String(email).trim() || !nombre_apellido || !String(nombre_apellido).trim() || cant < 1 || cant > 20) {
        return res.status(400).send('Completá email, nombre y una cantidad válida (máx. 20).');
    }

    try {
        const evento = req.evento;
        const codigos = await ticketsDb.registrarEntradasCortesia(evento.id, email, cant, { nombreApellido: nombre_apellido });

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos });
        await enviarMailBrevo({
            to: email,
            subject: `🎟️ Entrada${cant > 1 ? 's' : ''} de cortesía — ${evento.nombre}`,
            text: `¡Te invitamos a ${evento.nombre}! Adjuntamos ${cant} entrada/s de cortesía.`,
            attachmentBase64: pdfBuffer.toString('base64'),
            attachmentName: 'Entradas_Cortesia.pdf'
        });

        res.redirect(`/eventos/${evento.id}?cortesia=1`);
    } catch (error) {
        console.error('Error al generar entradas de cortesía:', error);
        res.status(500).send('No se pudieron generar las entradas de cortesía.');
    }
});

// Reenvío de QR: por si el mail original quedó en SPAM o se perdió. Regenera el PDF con
// TODAS las entradas que ese email tiene para este evento y lo reenvía, sin crear tickets nuevos.
router.post('/eventos/:id/reenviar-qr', requiereLogin, esDueñoOAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email || !String(email).trim()) {
        return res.status(400).send('Falta el email del comprador.');
    }

    try {
        const evento = req.evento;
        const codigos = await ticketsDb.obtenerEntradasDeCompra(evento.id, email);
        if (codigos.length === 0) {
            return res.status(404).send('No se encontraron entradas de ese email para este evento.');
        }

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos });
        await enviarMailBrevo({
            to: email,
            subject: `🎟️ Reenvío de tus entradas — ${evento.nombre}`,
            text: `Te reenviamos ${codigos.length} entrada/s para ${evento.nombre}. Si no lo ves en tu bandeja de entrada, revisá la carpeta de SPAM/Correo no deseado.`,
            attachmentBase64: pdfBuffer.toString('base64'),
            attachmentName: 'Entradas_Evento.pdf'
        });

        res.redirect(`/eventos/${evento.id}?reenviado=1`);
    } catch (error) {
        console.error('Error al reenviar el QR:', error);
        res.status(500).send('No se pudo reenviar el mail con las entradas.');
    }
});

// Exportación de contingencia: lista completa de asistentes en CSV (se abre directo en Excel),
// para tener a mano en la puerta si por lo que sea el panel/la app no está disponible.
router.get('/eventos/:id/exportar-csv', requiereLogin, esDueñoOAdmin, async (req, res) => {
    try {
        const ventas = await eventosDb.listadoVentas(req.evento.id);

        const escaparCsv = (valor) => `"${String(valor ?? '').replace(/"/g, '""')}"`;
        const encabezados = ['ID entrada', 'Nombre y apellido', 'Email', 'Tipo de entrada', 'Origen', 'Estado', 'Fecha de compra', 'Fecha escaneada'];
        const filas = ventas.map((v) => [
            v.id_entrada, v.nom_y_apellido || '', v.email || '', v.tipo_entrada || (v.origen === 'cortesia' ? 'Cortesía' : ''),
            v.origen, v.estado_entrada,
            v.fecha_y_hora_compra ? new Date(v.fecha_y_hora_compra).toLocaleString('es-AR') : '',
            v.fecha_y_hora_escaneada ? new Date(v.fecha_y_hora_escaneada).toLocaleString('es-AR') : ''
        ].map(escaparCsv).join(','));

        // BOM al inicio para que Excel abra los acentos/ñ bien en UTF-8.
        const csv = '﻿' + [encabezados.map(escaparCsv).join(','), ...filas].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="asistentes_evento_${req.evento.id}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Error al exportar el CSV de asistentes:', error);
        res.status(500).send('No se pudo generar el archivo CSV.');
    }
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
