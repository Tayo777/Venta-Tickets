const express = require('express');
const router = express.Router();
const eventos = require('../db/eventos');
const usuariosDb = require('../db/usuarios');
const tiposEntrada = require('../db/tiposEntrada');
const mp = require('../services/mercadopago');

router.get('/', (req, res) => {
    // "/" es el logo/marca en el navbar de TODA la página — para alguien ya logueado tiene que
    // llevar a SU dashboard (Mis eventos), no a la landing de marketing que ya no le sirve.
    if (req.session.usuarioId) return res.redirect('/mis-eventos');
    res.render('landing', { usuarioLogueado: false });
});

router.get('/eventos', async (req, res) => {
    try {
        // Los finalizados (por fecha o marcados a mano) no se listan al público. La lista ya
        // viene filtrada por visibilidad pública (acreditado + mail del dueño verificado) —
        // ver eventosDb.obtenerEventosActivos().
        const lista = (await eventos.obtenerEventosActivos()).filter((e) => !eventos.eventoFinalizado(e));
        res.render('index', { eventos: lista, usuarioLogueado: Boolean(req.session.usuarioId) });
    } catch (error) {
        console.error('Error al listar eventos:', error);
        res.status(500).send('Error al cargar los eventos.');
    }
});

// Busca el evento por su slug público ("tuentrada-nombre-del-evento"). Si lo que llega es
// puramente numérico, también prueba por id — así los links viejos (compartidos antes de que
// existiera el slug) siguen funcionando en vez de romperse de golpe.
async function buscarEventoPorSlugOId(param) {
    const porSlug = await eventos.obtenerEventoPorSlug(param);
    if (porSlug) return porSlug;
    if (/^\d+$/.test(param)) return eventos.obtenerEvento(param);
    return null;
}

router.get('/evento/:slug', async (req, res) => {
    try {
        const evento = await buscarEventoPorSlugOId(req.params.slug);
        if (!evento || !evento.activo) return res.status(404).send('Evento no encontrado.');

        // Visibilidad: acreditado por un admin + el creador con el mail verificado (ver
        // eventosDb.eventoEsPublico). Mientras no se cumplan las dos, el evento es PRIVADO —
        // solo su dueño o un admin lo pueden previsualizar entrando con el link directo.
        const creador = await usuariosDb.obtenerPorId(evento.usuario_id);
        const esPublico = eventos.eventoEsPublico(evento, creador && creador.email_verificado);
        const esPreviewDelDueño = req.session.usuarioId === evento.usuario_id || req.session.rol === 'admin';
        if (!esPublico && !esPreviewDelDueño) {
            return res.status(404).send('Evento no encontrado.');
        }

        if (!evento.conectado_mp) return res.status(503).send('Este evento todavía no está listo para vender entradas.');

        if (eventos.eventoFinalizado(evento) || eventos.ventaVencidaPorTiempo(evento)) {
            return res.status(410).send('La venta de entradas para este evento ya cerró.');
        }

        const tipos = await tiposEntrada.obtenerTiposPorEvento(evento.id, { soloActivos: true });
        // La tarifa de servicio es proporcional al precio de CADA tipo, así que se calcula por
        // tipo y viaja al frontend para que el total en pantalla coincida exactamente con lo
        // que después recalcula el servidor en /crear-pago.
        const tiposConCupo = tipos
            .filter((t) => t.cupo_disponible > 0)
            .map((t) => ({ ...t, tarifa: mp.tarifaPorEntrada(evento, t.precio) }));

        if (tiposConCupo.length === 0) {
            return res.status(410).send('Las entradas para este evento están agotadas.');
        }

        res.render('evento', {
            evento, tipos: tiposConCupo, usuarioLogueado: Boolean(req.session.usuarioId),
            vistaPreviaPrivada: !esPublico,
            // El navegador necesita el factor del gross-up para recalcular el total cuando se
            // aplica un cupón (el recargo se calcula sobre el precio YA descontado). Viaja
            // desde acá para que la fórmula viva en un solo lugar (services/mercadopago.js).
            factorRecargo: mp.factorRecargo(evento)
        });
    } catch (error) {
        console.error('Error al cargar evento:', error);
        res.status(500).send('Error al cargar el evento.');
    }
});

module.exports = router;
