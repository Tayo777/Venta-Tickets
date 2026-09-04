const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

// Protege los endpoints de la API para la app móvil de guardias. Espera
// "Authorization: Bearer <token>" — el token lo emite POST /api/app/login.
function requiereJwtGuardia(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Falta el token de autenticación.' });

    try {
        req.guardia = jwt.verify(token, JWT_SECRET); // { guardiaId, eventoId, filaAsignada, email }
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido o vencido. Volvé a iniciar sesión.' });
    }
}

module.exports = { requiereJwtGuardia };
