const express = require('express');
const router = express.Router();
const eventos = require('../db/eventos');
const usuariosDb = require('../db/usuarios');
const tiposEntrada = require('../db/tiposEntrada');
const mp = require('../services/mercadopago');

// Página principal del sitio. Carga SIEMPRE la landing, esté el visitante logueado o no —
// antes redirigía a /mis-eventos cuando había sesión, y eso hacía que la raíz del sitio
// pareciera rota para cualquiera con la sesión abierta (incluido el logo del navbar, que
// apunta acá).
//
// Además del hero, muestra el catálogo de eventos públicos: es lo que la gente viene a ver.
router.get('/', async (req, res) => {
    let lista = [];
    try {
        lista = (await eventos.obtenerEventosActivos()).filter((e) => !eventos.eventoFinalizado(e));
    } catch (error) {
        // La home NUNCA tiene que caerse por un problema al traer los eventos: si la consulta
        // falla, se muestra igual con el catálogo vacío en vez de un 500 en la raíz del sitio.
        console.error('Error al cargar los eventos de la portada:', error);
    }

    res.render('landing', {
        usuarioLogueado: Boolean(req.session.usuarioId),
        eventos: lista
    });
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

router.get('/evento/:slug', async (req, res) => {
    try {
        const evento = await eventos.obtenerEventoPorSlugOId(req.params.slug);
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
