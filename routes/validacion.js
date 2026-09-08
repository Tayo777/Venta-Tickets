const express = require('express');
const router = express.Router();
const ticketsDb = require('../db/tickets');
const eventosDb = require('../db/eventos');
const { verificarIdFirmado } = require('../services/firmaTickets');
const { intentarValidar } = require('../services/validarTicket');

// Arma una pantalla simple a pantalla completa, pensada para verse bien en el celular del guardia.
function generarPantallaControl(titulo, mensaje, colorFondo) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Control de Acceso</title>
        <style>
            body {
                background-color: ${colorFondo}; color: white; font-family: 'Helvetica', sans-serif;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                height: 100vh; margin: 0; text-align: center; padding: 20px;
            }
            h1 { font-size: 2.5rem; margin-bottom: 10px; text-transform: uppercase; }
            p { font-size: 1.2rem; font-weight: bold; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; }
        </style>
    </head>
    <body>
        <h1>${titulo}</h1>
        <p>${mensaje}</p>
    </body>
    </html>
    `;
}

// Diferencia entre el COMPRADOR (ve info, no valida) y el GUARDIA de ESE evento puntual
// (valida y marca como usada). El guardia se identifica por una cookie propia de cada evento —
// un guardia autorizado para el evento A no puede validar entradas del evento B. Esta ruta es
// la que abre la cámara del CELULAR (fuera de la app) al leer el QR; el guardia normalmente
// usa en cambio el scanner propio en /guardia/:eventoId, que funciona sin conexión.
router.get('/validar/:id', async (req, res) => {
    const ticketId = req.params.id;

    try {
        const row = await ticketsDb.obtenerTicketConEvento(ticketId);
        if (!row) return res.send(generarPantallaControl('❌ RECHAZADO', 'Esta entrada NO existe en el sistema.', '#c0392b'));

        // La firma se verifica con el qr_secret PROPIO de este evento (ya no hay uno global,
        // así que recién se puede chequear una vez que sabemos a qué evento pertenece el
        // ticket). Un código inventado o adulterado se rechaza acá, antes de mostrar nada
        // y antes de que intentarValidar llegue a tocar el estado de la entrada.
        if (!verificarIdFirmado(ticketId, row.evento_qr_secret)) {
            return res.send(generarPantallaControl('❌ QR INVÁLIDO', 'Este código no es válido o fue falsificado.', '#c0392b'));
        }

        const esGuardiaDeEsteEvento = req.cookies[`guardia_${row.evento_id}`] === '1';
        if (!esGuardiaDeEsteEvento) {
            return res.send(generarPantallaControl('🎟️ ENTRADA OFICIAL', `${row.evento_nombre}<br>Código: ${row.id}<br>Estado actual: ${row.estado}<br><br>Por favor, mostrá este QR al guardia en la entrada.`, '#2980b9'));
        }

        const { resultado } = await intentarValidar(ticketId, row.evento_id);
        if (resultado === 'ya_usada') {
            return res.send(generarPantallaControl('⚠️ YA ESCANEADA', `Esta entrada ya ingresó previamente.<br><br>Titular: ${row.email}`, '#f39c12'));
        }
        return res.send(generarPantallaControl('✅ ACCESO PERMITIDO', `Entrada válida.<br><br>Titular: ${row.email}`, '#27ae60'));
    } catch (error) {
        console.error('Error al validar entrada:', error);
        return res.status(500).send('Error de conexión con la base de datos.');
    }
});

// Activa el "modo guardia" en el celular de la persona de seguridad, para UN evento puntual.
// El link (con su token encriptado) solo lo ve el dueño del evento o el admin, desde el panel.
// Redirige al scanner propio (con Service Worker) en vez de mostrar una pantalla estática.
router.get('/login-guardia/:eventoId', async (req, res) => {
    const evento = await eventosDb.obtenerEvento(req.params.eventoId);
    if (!evento || req.query.token !== evento.guardia_token) {
        return res.send(generarPantallaControl('❌ ERROR', 'Link inválido.', '#c0392b'));
    }

    res.cookie(`guardia_${evento.id}`, '1', { maxAge: 86400000 });
    res.redirect(`/guardia/${evento.id}`);
});

// Versión "linda" del link de guardia: /guardias/tuentradaya-nombreevento-<token>, en vez de
// /login-guardia/:eventoId?token=... El token sigue siendo el mismo secreto de siempre
// (evento.guardia_token, 32 caracteres hex) — acá va pegado al final del slug en vez de en
// un query param, así que se lo extrae tomando los últimos 32 caracteres del segmento; el
// slug de adelante es solo cosmético (identifica el evento a simple vista), la seguridad la
// da el token, verificado igual que siempre contra la DB. /login-guardia sigue andando para
// no romper links ya repartidos antes de este cambio.
router.get('/guardias/:slugConToken', async (req, res) => {
    const token = req.params.slugConToken.slice(-32);
    if (!/^[0-9a-f]{32}$/i.test(token)) {
        return res.send(generarPantallaControl('❌ ERROR', 'Link inválido.', '#c0392b'));
    }

    const evento = await eventosDb.obtenerEventoPorGuardiaToken(token);
    if (!evento) return res.send(generarPantallaControl('❌ ERROR', 'Link inválido.', '#c0392b'));

    res.cookie(`guardia_${evento.id}`, '1', { maxAge: 86400000 });
    res.redirect(`/guardia/${evento.id}`);
});

function esGuardia(req, eventoId) {
    return req.cookies[`guardia_${eventoId}`] === '1';
}

// Página del scanner del guardia: cámara + QR + Service Worker para modo offline.
router.get('/guardia/:eventoId', async (req, res) => {
    const evento = await eventosDb.obtenerEvento(req.params.eventoId);
    if (!evento) return res.status(404).send('Evento no encontrado.');
    if (!esGuardia(req, evento.id)) {
        return res.send(generarPantallaControl('❌ ERROR', 'Este celular no tiene activado el modo guardia para este evento. Pedile el link al organizador.', '#c0392b'));
    }
    res.render('guardia-scanner', { evento });
});

// --- API JSON para el scanner offline (guardia-cliente.js) ---
// Todo lo de acá abajo devuelve JSON y exige la misma cookie de guardia que /validar.

// Volcado inicial: la app lo descarga al abrir con internet y lo guarda en IndexedDB para
// poder seguir validando aunque después se corte la señal dentro del evento.
router.get('/api/guardia/:eventoId/tickets', async (req, res) => {
    const eventoId = req.params.eventoId;
    if (!esGuardia(req, eventoId)) return res.status(403).json({ error: 'No autorizado.' });

    try {
        const tickets = await ticketsDb.obtenerTicketsDeEvento(eventoId);
        res.json({ tickets });
    } catch (error) {
        console.error('Error al listar tickets para el guardia:', error);
        res.status(500).json({ error: 'Error de base de datos.' });
    }
});

// Validación en vivo: la llama el scanner cuando SÍ tiene conexión. Cuando no la tiene, valida
// localmente contra la copia en IndexedDB y encola este mismo POST para reintentarlo después
// (ver sincronizarPendientes() en public/guardia-cliente.js).
router.post('/api/guardia/:eventoId/validar/:ticketId', async (req, res) => {
    const { eventoId, ticketId } = req.params;
    if (!esGuardia(req, eventoId)) return res.status(403).json({ error: 'No autorizado.' });

    try {
        // intentarValidar ya verifica la firma con el qr_secret del evento correspondiente
        // (necesita buscar la fila primero para saber cuál es — ver services/validarTicket.js).
        const { resultado, row } = await intentarValidar(ticketId, eventoId);
        if (resultado === 'no_existe') return res.status(404).json({ resultado });
        if (resultado === 'firma_invalida') return res.status(400).json({ resultado, error: 'QR inválido o falsificado.' });
        if (resultado === 'otro_evento') return res.status(403).json({ resultado });
        res.json({ resultado, email: row.email });
    } catch (error) {
        console.error('Error al validar (API guardia):', error);
        res.status(500).json({ error: 'Error de base de datos.' });
    }
});

module.exports = router;
