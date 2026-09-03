const express = require('express');
const router = express.Router();
const ticketsDb = require('../db/tickets');
const eventosDb = require('../db/eventos');
const { enviarNotificacionTelegram } = require('../services/telegram');

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
// un guardia autorizado para el evento A no puede validar entradas del evento B.
router.get('/validar/:id', async (req, res) => {
    const ticketId = req.params.id;

    try {
        const row = await ticketsDb.obtenerTicketConEvento(ticketId);
        if (!row) return res.send(generarPantallaControl('❌ RECHAZADO', 'Esta entrada NO existe en el sistema.', '#c0392b'));

        const esGuardiaDeEsteEvento = req.cookies[`guardia_${row.evento_id}`] === '1';

        if (!esGuardiaDeEsteEvento) {
            return res.send(generarPantallaControl('🎟️ ENTRADA OFICIAL', `${row.evento_nombre}<br>Código: ${row.id}<br>Estado actual: ${row.estado}<br><br>Por favor, mostrá este QR al guardia en la entrada.`, '#2980b9'));
        }

        if (row.estado === 'Usada') {
            return res.send(generarPantallaControl('⚠️ YA ESCANEADA', `Esta entrada ya ingresó previamente.<br><br>Titular: ${row.email}`, '#f39c12'));
        }

        await ticketsDb.marcarComoUsada(ticketId);
        enviarNotificacionTelegram(`✅ <b>Ingreso registrado</b>\nEvento: ${row.evento_nombre}\nTitular: ${row.email}`);
        return res.send(generarPantallaControl('✅ ACCESO PERMITIDO', `Entrada válida.<br><br>Titular: ${row.email}`, '#27ae60'));
    } catch (error) {
        console.error('Error al validar entrada:', error);
        return res.status(500).send('Error de conexión con la base de datos.');
    }
});

// Activa el "modo guardia" en el celular de la persona de seguridad, para UN evento puntual.
// El link (con su token encriptado) solo lo ve el dueño del evento o el admin, desde el panel.
router.get('/login-guardia/:eventoId', async (req, res) => {
    const evento = await eventosDb.obtenerEvento(req.params.eventoId);
    if (!evento || req.query.token !== evento.guardia_token) {
        return res.send(generarPantallaControl('❌ ERROR', 'Link inválido.', '#c0392b'));
    }

    res.cookie(`guardia_${evento.id}`, '1', { maxAge: 86400000 });
    res.send(generarPantallaControl('👮 MODO GUARDIA ACTIVADO', `Tu celular ya está listo para escanear y validar entradas de "${evento.nombre}".`, '#34495e'));
});

module.exports = router;
