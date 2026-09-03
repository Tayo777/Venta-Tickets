const eventosDb = require('../db/eventos');

function requiereLogin(req, res, next) {
    if (!req.session.usuarioId) return res.redirect('/login');
    next();
}

function requiereAprobado(req, res, next) {
    if (!req.session.aprobado) {
        return res.status(403).send('Tu cuenta todavía no fue aprobada para crear eventos. Te avisamos por mail apenas esté lista.');
    }
    next();
}

function requiereAdmin(req, res, next) {
    if (req.session.rol !== 'admin') return res.status(403).send('Acceso denegado.');
    next();
}

// Deja pasar solo al dueño del evento o al admin. Deja el evento cargado en req.evento
// para que la ruta no tenga que volver a buscarlo.
async function esDueñoOAdmin(req, res, next) {
    const evento = await eventosDb.obtenerEvento(req.params.id);
    if (!evento) return res.status(404).send('Evento no encontrado.');

    const esDueño = evento.usuario_id === req.session.usuarioId;
    const esAdmin = req.session.rol === 'admin';
    if (!esDueño && !esAdmin) return res.status(403).send('No tenés permiso para ver este evento.');

    req.evento = evento;
    next();
}

module.exports = { requiereLogin, requiereAprobado, requiereAdmin, esDueñoOAdmin };
