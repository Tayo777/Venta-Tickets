const { enviarMail } = require('./mailer');
const { ADMIN_EMAIL, BASE_URL } = require('../config/env');
const { ZONA_HORARIA } = require('../config/tiempo');

// Avisos automáticos al administrador de TuEntradaYa. Viven acá y no dentro de las rutas para
// que el texto y el formato de los mails estén en un solo lugar.
//
// REGLA IMPORTANTE: ninguna de estas funciones lanza. Un aviso al admin es secundario respecto
// de la operación que lo dispara — si el mail falla, el usuario NO tiene que ver un error ni
// perder su registro o su evento recién creado. El fallo queda en el log del server.

function formatearFecha(fecha) {
    if (!fecha) return 'sin definir';
    const d = new Date(fecha);
    if (isNaN(d)) return String(fecha);
    return d.toLocaleString('es-AR', {
        timeZone: ZONA_HORARIA,
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

// Aviso de EVENTO NUEVO. Incluye el link de acreditación rápida, que deja el evento público de
// un click (la ruta está protegida por isAdmin, así que si el admin no tiene sesión iniciada
// primero le va a pedir login — el link por sí solo no acredita nada).
async function avisarEventoNuevo(evento, creador) {
    const linkAcreditar = `${BASE_URL}/admin/acreditar/${evento.slug}`;
    const linkPanel = `${BASE_URL}/admin/dashboard`;

    const texto = [
        'Se creó un evento nuevo en TuEntradaYa y está esperando acreditación.',
        '',
        `Evento:  ${evento.nombre}`,
        `Creador: ${creador ? `${creador.nombre} (${creador.email})` : 'desconocido'}`,
        `Fecha del evento: ${formatearFecha(evento.fecha)}`,
        `Mail del creador verificado: ${creador && creador.email_verificado ? 'sí' : 'NO'}`,
        '',
        'Acreditarlo (queda público al instante):',
        linkAcreditar,
        '',
        'Ver todos los pendientes:',
        linkPanel
    ].join('\n');

    const html = `
        <p>Se creó un evento nuevo en <strong>TuEntradaYa</strong> y está esperando acreditación.</p>
        <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
            <tr><td><strong>Evento</strong></td><td>${escapar(evento.nombre)}</td></tr>
            <tr><td><strong>Creador</strong></td><td>${creador ? `${escapar(creador.nombre)} (${escapar(creador.email)})` : 'desconocido'}</td></tr>
            <tr><td><strong>Fecha del evento</strong></td><td>${escapar(formatearFecha(evento.fecha))}</td></tr>
            <tr><td><strong>Mail verificado</strong></td><td>${creador && creador.email_verificado ? 'sí' : '<strong>NO</strong>'}</td></tr>
        </table>
        <p style="margin-top:18px;">
            <a href="${linkAcreditar}" style="background:#8b5cf6;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold;">Acreditar este evento</a>
        </p>
        <p style="font-size:12px;color:#666;">O entrá al panel de pendientes: <a href="${linkPanel}">${linkPanel}</a></p>
    `;

    try {
        const canal = await enviarMail({ to: ADMIN_EMAIL, subject: `🎪 Evento nuevo para acreditar: ${evento.nombre}`, text: texto, html });
        console.log(`[avisosAdmin] Aviso de evento nuevo (${evento.slug}) enviado por ${canal}.`);
    } catch (error) {
        console.error('[avisosAdmin] No se pudo avisar al admin del evento nuevo:', error.message);
    }
}

// Aviso de USUARIO NUEVO, apenas se registra (no espera a que verifique el mail).
async function avisarUsuarioNuevo(usuario) {
    const texto = [
        'Se registró un usuario nuevo en TuEntradaYa.',
        '',
        `Nombre:   ${usuario.nombre}`,
        `Email:    ${usuario.email}`,
        `Teléfono: ${usuario.telefono || 'no informó'}`,
        `Fecha de registro: ${formatearFecha(new Date())}`
    ].join('\n');

    const html = `
        <p>Se registró un usuario nuevo en <strong>TuEntradaYa</strong>.</p>
        <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
            <tr><td><strong>Nombre</strong></td><td>${escapar(usuario.nombre)}</td></tr>
            <tr><td><strong>Email</strong></td><td>${escapar(usuario.email)}</td></tr>
            <tr><td><strong>Teléfono</strong></td><td>${escapar(usuario.telefono || 'no informó')}</td></tr>
            <tr><td><strong>Fecha de registro</strong></td><td>${escapar(formatearFecha(new Date()))}</td></tr>
        </table>
    `;

    try {
        const canal = await enviarMail({ to: ADMIN_EMAIL, subject: `👤 Usuario nuevo en TuEntradaYa: ${usuario.nombre}`, text: texto, html });
        console.log(`[avisosAdmin] Aviso de usuario nuevo (${usuario.email}) enviado por ${canal}.`);
    } catch (error) {
        console.error('[avisosAdmin] No se pudo avisar al admin del usuario nuevo:', error.message);
    }
}

// Los datos que se interpolan en el HTML los escribió un usuario (nombre del evento, nombre de
// la persona): se escapan para que nadie pueda inyectar HTML en el mail del administrador.
function escapar(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { avisarEventoNuevo, avisarUsuarioNuevo };
