const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const guardiasDb = require('../db/guardias');
const eventosDb = require('../db/eventos');
const ticketsDb = require('../db/tickets');
const { intentarValidar, extraerIdTicket } = require('../services/validarTicket');
const { requiereJwtGuardia } = require('../middleware/authApi');
const { limitadorAuth } = require('../middleware/rateLimiters');
const { JWT_SECRET } = require('../config/env');

// Duración de la sesión de un guardia en la app: alcanza y sobra para un turno de trabajo
// (evento + previa + after). Si se vence a mitad del evento, el login es instantáneo de nuevo.
const DURACION_TOKEN = '12h';

// Hora real del escaneo que manda la app cuando validó sin señal. Acepta timestamp en ms
// (Date.now() del celular) o texto ISO. Se descarta cualquier fecha absurda —futuro, o
// anterior a 2020— para que un celular con la hora mal configurada no ensucie las estadísticas.
function fechaDeEscaneo(entrada) {
    if (!entrada || typeof entrada !== 'object') return null;
    const crudo = entrada.ts ?? entrada.fecha ?? entrada.fechaEscaneo ?? entrada.fecha_escaneada;
    if (crudo === null || crudo === undefined) return null;

    const fecha = new Date(typeof crudo === 'number' ? crudo : String(crudo));
    if (isNaN(fecha)) return null;

    const ahora = Date.now();
    if (fecha.getTime() > ahora + 60 * 1000) return null;
    if (fecha.getTime() < Date.UTC(2020, 0, 1)) return null;
    return fecha;
}

// Login de la app móvil de guardias. Devuelve el JWT + la fila asignada, para que la app
// sepa de entrada qué puerta le toca cubrir (aunque igual descarga el mapa COMPLETO del
// evento en /sync-download, no solo su fila).
router.post('/api/app/login', limitadorAuth, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Faltan email y/o contraseña.' });
    }

    try {
        // Mensaje genérico a propósito (no revelar si el mail existe), mismo criterio que
        // /login de organizadores en routes/auth.js.
        const guardia = await guardiasDb.obtenerGuardiaPorEmail(email);
        if (!guardia || !guardia.activo) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        }

        const passwordOk = await guardiasDb.verificarPassword(guardia, password);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        }

        const evento = await eventosDb.obtenerEvento(guardia.evento_id);
        if (!evento) return res.status(404).json({ error: 'El evento de este guardia ya no existe.' });

        const token = jwt.sign(
            { guardiaId: guardia.id, eventoId: guardia.evento_id, filaAsignada: guardia.fila_asignada, email: guardia.email },
            JWT_SECRET,
            { expiresIn: DURACION_TOKEN }
        );

        res.json({
            token,
            filaAsignada: guardia.fila_asignada,
            eventoId: evento.id,
            eventoNombre: evento.nombre,
            // La app necesita esto para poder generar/leer QRs de forma autónoma si en algún
            // momento lo requiere client-side; hoy mismo la validación real siempre pasa por
            // el servidor (sync-upload), que verifica con el qr_secret guardado en la DB.
            qrSecret: evento.qr_secret
        });
    } catch (error) {
        console.error('Error en /api/app/login:', error);
        res.status(500).json({ error: 'Error interno al iniciar sesión.' });
    }
});

// Descarga completa del "mapa" de entradas del evento (TODAS las filas, no solo la del
// guardia que pide la sync) — así la app arma su copia offline entera y cualquier guardia
// puede ayudar en otra puerta si hace falta, sin depender de la señal en ese momento.
router.get('/api/app/sync-download', requiereJwtGuardia, async (req, res) => {
    try {
        const tickets = await ticketsDb.obtenerTicketsCompletosDeEvento(req.guardia.eventoId);
        res.json({ eventoId: req.guardia.eventoId, filaAsignada: req.guardia.filaAsignada, tickets });
    } catch (error) {
        console.error('Error en /api/app/sync-download:', error);
        res.status(500).json({ error: 'No se pudo descargar el mapa de entradas.' });
    }
});

// Sube el resultado de lo que la app validó offline: los escaneos que el guardia hizo en el
// celular y quedaron encolados. Cada uno se re-valida en serio acá (firma HMAC + pertenece a
// este evento + no estaba ya usado) antes de tocar la DB — nunca se confía en que "la app ya
// lo marcó como válido localmente".
//
// El formato de cada elemento es flexible a propósito, porque de esto dependía que los
// escaneos llegaran o se perdieran en silencio. Se acepta:
//   - el código pelado:            "EVT-AB12CD34.9f8e..."
//   - el contenido crudo del QR:   "https://.../validar/EVT-AB12CD34.9f8e..."
//   - un objeto de la cola local:  { id: "...", ts: 1725500000000 }  (o fecha / fechaEscaneo)
// De ahí sale el código con extraerIdTicket(); si llega la URL entera sin recortar, buscarla
// tal cual en la tabla tickets devolvía "no_existe" y el ingreso nunca quedaba registrado.
//
// Cuando el elemento trae la hora del escaneo, esa es la que se guarda en fecha_escaneada (es
// la hora real en la puerta); si no, se usa la del server. Sin esto, un lote sincronizado a
// las 4 AM marcaba todos los ingresos a las 4 AM y el gráfico de flujo de gente quedaba mal.
router.post('/api/app/sync-upload', requiereJwtGuardia, async (req, res) => {
    const { tickets } = req.body;
    if (!Array.isArray(tickets) || tickets.length === 0) {
        return res.status(400).json({ error: 'Mandá un array "tickets" con al menos un ID.' });
    }
    if (tickets.length > 500) {
        return res.status(400).json({ error: 'Demasiados tickets en un solo lote (máx. 500).' });
    }

    const resultados = [];
    const yaProcesados = new Set(); // el mismo código repetido en el lote se resuelve una sola vez

    for (const entrada of tickets) {
        const ticketId = extraerIdTicket(entrada);
        if (!ticketId) {
            resultados.push({ id: null, resultado: 'formato_invalido' });
            continue;
        }
        if (yaProcesados.has(ticketId)) continue;
        yaProcesados.add(ticketId);

        try {
            const { resultado } = await intentarValidar(ticketId, req.guardia.eventoId, {
                fechaEscaneo: fechaDeEscaneo(entrada)
            });
            resultados.push({ id: ticketId, resultado });
        } catch (error) {
            console.error(`Error al sincronizar el ticket ${ticketId}:`, error);
            resultados.push({ id: ticketId, resultado: 'error_interno' });
        }
    }

    // El resumen le sirve a la app para saber qué puede borrar de su cola local y al
    // organizador para verificar de un vistazo que la sincronización realmente entró.
    const contar = (r) => resultados.filter((x) => x.resultado === r).length;
    const resumen = {
        recibidos: tickets.length,
        registrados: contar('ok'),
        yaEstaban: contar('ya_usada'),
        rechazados: resultados.length - contar('ok') - contar('ya_usada')
    };
    console.log(`[sync-upload] evento ${req.guardia.eventoId} / guardia ${req.guardia.email}:`, resumen);

    res.json({ resumen, resultados });
});

module.exports = router;
