const rateLimit = require('express-rate-limit');

// Responde 429 en JSON con un mensaje amigable, en vez del texto plano por defecto de la
// librería — las rutas que usan estos limitadores devuelven JSON, así que el error debe
// mantener el mismo formato.
function respuestaLimite(mensaje) {
    return (req, res) => {
        res.status(429).json({ error: mensaje });
    };
}

// Checkout (crear preferencia de pago): máximo 5 peticiones por minuto por IP. Frena a quien
// intente generar pagos en ráfaga (bots, doble-click compulsivo, o alguien probando a lo loco).
const limitadorCheckout = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: respuestaLimite('Estás generando pagos muy rápido. Esperá un minuto e intentá de nuevo.')
});

// Autenticación (login, registro, recuperar contraseña): máximo 10 intentos cada 15 minutos
// por IP. Más estricto en el tiempo (ventana larga) porque acá el riesgo es fuerza bruta de
// contraseñas o spam de registros, no un click accidental.
const limitadorAuth = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: respuestaLimite('Demasiados intentos. Esperá unos minutos antes de volver a intentarlo.')
});

module.exports = { limitadorCheckout, limitadorAuth };
