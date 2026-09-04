const express = require('express');
const router = express.Router();
const ticketsDb = require('../db/tickets');
const eventosDb = require('../db/eventos');
const { enviarNotificacionTelegram } = require('../services/telegram');
const { verificarIdFirmado } = require('../services/firmaTickets');

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

// Intenta marcar una entrada como usada. Centraliza la regla (firma válida / existe / es de
// este evento / no estaba ya usada) para que la comparta tanto /validar (navegación directa
// del QR) como la API JSON que usa el scanner offline del guardia (ver /api/guardia más abajo).
async function intentarValidar(ticketId, eventoId) {
    // Blindaje contra QRs falsificados o alterados a mano: se verifica la firma HMAC ANTES
    // de tocar la base de datos. Si no coincide, se corta acá — cero consultas a MySQL.
    if (!verificarIdFirmado(ticketId)) return { resultado: 'firma_invalida' };

    const row = await ticketsDb.obtenerTicketConEvento(ticketId);
    if (!row) return { resultado: 'no_existe' };
    if (String(row.evento_id) !== String(eventoId)) return { resultado: 'otro_evento', row };
    if (row.estado === 'Usada') return { resultado: 'ya_usada', row };

    await ticketsDb.marcarComoUsada(ticketId);
    enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nEvento: ${row.evento_nombre}\nTitular: ${row.email}`);
    return { resultado: 'ok', row };
}

// Diferencia entre el COMPRADOR (ve info, no valida) y el GUARDIA de ESE evento puntual
// (valida y marca como usada). El guardia se identifica por una cookie propia de cada evento —
// un guardia autorizado para el evento A no puede validar entradas del evento B. Esta ruta es
// la que abre la cámara del CELULAR (fuera de la app) al leer el QR; el guardia normalmente
// usa en cambio el scanner propio en /guardia/:eventoId, que funciona sin conexión.
router.get('/validar/:id', async (req, res) => {
    const ticketId = req.params.id;

    // Verificación de firma ANTES de cualquier consulta a MySQL: un código inventado o
    // adulterado (por ejemplo, alguien armando un QR a mano con un "EVT-" cualquiera) se
    // rechaza al toque, sin gastarle ni una query a la base.
    if (!verificarIdFirmado(ticketId)) {
        return res.send(generarPantallaControl('❌ QR INVÁLIDO', 'Este código no es válido o fue falsificado.', '#c0392b'));
    }

    try {
        const row = await ticketsDb.obtenerTicketConEvento(ticketId);
        if (!row) return res.send(generarPantallaControl('❌ RECHAZADO', 'Esta entrada NO existe en el sistema.', '#c0392b'));

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

    // Mismo blindaje que en /validar: se corta antes de tocar la DB si la firma no cierra.
    if (!verificarIdFirmado(ticketId)) {
        return res.status(400).json({ resultado: 'firma_invalida', error: 'QR inválido o falsificado.' });
    }

    try {
        const { resultado, row } = await intentarValidar(ticketId, eventoId);
        if (resultado === 'no_existe') return res.status(404).json({ resultado });
        if (resultado === 'otro_evento') return res.status(403).json({ resultado });
        res.json({ resultado, email: row.email });
    } catch (error) {
        console.error('Error al validar (API guardia):', error);
        res.status(500).json({ error: 'Error de base de datos.' });
    }
});

module.exports = router;
