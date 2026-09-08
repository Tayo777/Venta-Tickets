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
//
// El panel se direcciona por SLUG (/eventos/tuentradaya-mi-fiesta), así que se busca primero
// por ahí. Si el parámetro es puramente numérico se prueba además por id: los links viejos
// del panel (/eventos/12) siguen andando, y un evento sin slug —no debería haber, hay backfill
// en db/pool.js— sigue siendo administrable.
async function esDueñoOAdmin(req, res, next) {
    const evento = await eventosDb.obtenerEventoPorSlugOId(req.params.slug ?? req.params.id);
    if (!evento) return res.status(404).send('Evento no encontrado.');

    const esDueño = evento.usuario_id === req.session.usuarioId;
    const esAdmin = req.session.rol === 'admin';
    if (!esDueño && !esAdmin) return res.status(403).send('No tenés permiso para ver este evento.');

    req.evento = evento;
    next();
}

// Bloquea cualquier MODIFICACIÓN sobre un evento ya finalizado (por fecha o marcado a mano).
// Los finalizados quedan en modo solo lectura: se siguen pudiendo ver estadísticas, ventas e
// historial, pero no editar el evento, emitir cortesías, tocar cupones ni guardias.
// Va siempre DESPUÉS de esDueñoOAdmin, que es quien deja el evento en req.evento.
function eventoEditable(req, res, next) {
    if (eventosDb.eventoFinalizado(req.evento)) {
        return res.status(403).send('Este evento ya finalizó y quedó en modo solo lectura. Podés consultar sus estadísticas e historial, pero no modificarlo.');
    }
    next();
}

// Un evento finalizado solo lo puede borrar el admin (decisión manual, nunca automática).
// Mientras está activo, el dueño también puede borrar el suyo.
function puedeEliminarEvento(req, res, next) {
    const esAdmin = req.session.rol === 'admin';
    if (eventosDb.eventoFinalizado(req.evento) && !esAdmin) {
        return res.status(403).send('Los eventos finalizados solo los puede eliminar un administrador.');
    }
    next();
}

module.exports = { requiereLogin, requiereAprobado, requiereAdmin, esDueñoOAdmin, eventoEditable, puedeEliminarEvento };
