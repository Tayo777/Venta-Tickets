const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const ticketsDb = require('../db/tickets');
const tiposEntradaDb = require('../db/tiposEntrada');
const cuponesDb = require('../db/cupones');
const checkoutsDb = require('../db/checkouts');
const mp = require('../services/mercadopago');
const { procesarPagoAprobado } = require('../services/procesarPago');
const { generarPdfEnResponse } = require('../services/pdfEntradas');
const { limitadorCheckout } = require('../middleware/rateLimiters');

// Tope de entradas por compra, sumando TODOS los tipos del carrito.
const MAX_ENTRADAS_POR_COMPRA = 5;

// Normaliza el carrito a [{ tipoEntradaId, cantidad }], descartando las cantidades en 0.
//
// Llega de dos lados:
//   a) Del fetch de validar-cupón: array de objetos [{ tipoEntradaId, cantidad }].
//   b) Del form HTML: inputs name="items[t<tipoId>]" -> { items: { t9: '2', t10: '0' } }.
//
// El prefijo "t" de (b) NO es cosmético. El parser de Express (qs) trata el contenido entre
// corchetes como índice de array si es un número, y además COMPACTA los índices salteados:
// "items[9]=2&items[10]=0" llega como ["2","0"] y los ids 9 y 10 se pierden para siempre.
// Con una clave no numérica lo trata como objeto y el id sobrevive intacto.
//
// El fallback de abajo (array de valores sueltos) queda solo como red de seguridad para no
// romper si algún form viejo quedara cacheado en el navegador de alguien: en ese caso no hay
// forma de recuperar los ids, así que devuelve vacío y el checkout avisa en vez de cobrar mal.
function normalizarItems(items) {
    if (!items || typeof items !== 'object') return [];

    if (Array.isArray(items)) {
        if (!items.some((i) => i && typeof i === 'object')) return []; // ids perdidos: no adivinar
        return items
            .map((i) => ({ tipoEntradaId: parseInt(i.tipoEntradaId), cantidad: parseInt(i.cantidad) || 0 }))
            .filter((i) => i.tipoEntradaId > 0 && i.cantidad > 0);
    }

    return Object.entries(items)
        .map(([clave, cant]) => ({
            // Acepta "t9" (lo que manda el form) y "9" por las dudas.
            tipoEntradaId: parseInt(String(clave).replace(/^t/i, '')),
            cantidad: parseInt(cant) || 0
        }))
        .filter((i) => i.tipoEntradaId > 0 && i.cantidad > 0);
}

// Relee cada tipo de entrada DESDE LA BASE (nunca se confía en el precio que mandó el
// navegador) y valida que siga disponible y con cupo. Devuelve { lineas } o { error }.
async function resolverLineas(eventoId, items) {
    const lineas = [];
    for (const item of items) {
        const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(item.tipoEntradaId);
        if (!tipoEntrada || tipoEntrada.evento_id !== eventoId || !tipoEntrada.activo) {
            return { error: 'Alguno de los tipos de entrada elegidos ya no está disponible.' };
        }
        if (tipoEntrada.cupo_disponible < item.cantidad) {
            return { error: `Ya no quedan ${item.cantidad} entradas "${tipoEntrada.nombre}" (quedan ${tipoEntrada.cupo_disponible}).` };
        }
        lineas.push({ tipoEntrada, cantidad: item.cantidad });
    }
    return { lineas };
}

// Versión para DESPUÉS del pago: relee los tipos igual, pero sin volver a exigir cupo. El
// dinero ya se cobró, así que acá no corresponde rechazar por stock — si el cupo se agotó en
// el medio, lo detecta la transacción de registrarEntradas y dispara el aviso de reembolso
// manual (ver services/procesarPago.js). Devuelve null si algún tipo ya no existe.
async function resolverLineasParaCobro(eventoId, items) {
    const lineas = [];
    for (const item of items) {
        const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(item.tipoEntradaId);
        if (!tipoEntrada || tipoEntrada.evento_id !== eventoId) return null;
        lineas.push({ tipoEntrada, cantidad: item.cantidad });
    }
    return lineas;
}

// Preview del cupón para el checkout: el frontend lo llama al tocar "Aplicar cupón" para
// mostrar el descuento sin cobrar todavía. Es de solo lectura (no reserva el cupón ni lo
// marca como usado) — la validación se repite igual, en serio, en /crear-pago justo antes
// de cobrar, porque nunca hay que confiar en un descuento calculado del lado del cliente.
router.post('/api/eventos/:id/validar-cupon', async (req, res) => {
    const eventoId = parseInt(req.params.id);
    const { codigo } = req.body;
    const items = normalizarItems(req.body.items);

    if (items.length === 0) {
        return res.json({ valido: false, motivo: 'Elegí al menos una entrada antes de aplicar el cupón.' });
    }

    try {
        const evento = await eventosDb.obtenerEvento(eventoId);
        if (!evento) return res.status(404).json({ valido: false, motivo: 'Evento no encontrado.' });

        const { lineas, error } = await resolverLineas(eventoId, items);
        if (error) return res.status(409).json({ valido: false, motivo: error });

        // El cupón se valida contra el carrito completo: adentro, db/cupones.js calcula el
        // descuento SOLO sobre los tipos de entrada habilitados para ese cupón (y nunca sobre
        // la tarifa de servicio).
        const subtotal = lineas.reduce((acc, l) => acc + Number(l.tipoEntrada.precio) * l.cantidad, 0);
        const resultado = await cuponesDb.validarCupon(codigo, eventoId, lineas);
        if (!resultado.valido) return res.json(resultado);

        const { total } = mp.calcularTotales(evento, lineas, resultado.descuento);
        res.json({
            valido: true,
            motivo: null,
            tipo: resultado.cupon.tipo,
            valor: Number(resultado.cupon.valor),
            subtotal,
            descuento: resultado.descuento,
            nuevoSubtotal: resultado.nuevoSubtotal,
            nuevoTotal: total,
            // Para avisarle al comprador cuando el cupón cubre solo parte del carrito.
            aplicaATodos: resultado.aplicaATodos,
            tiposAplicados: [...new Set(resultado.tiposAplicados)]
        });
    } catch (error) {
        console.error('Error al validar cupón:', error);
        res.status(500).json({ valido: false, motivo: 'Error al validar el cupón.' });
    }
});

router.post('/crear-pago', limitadorCheckout, async (req, res) => {
    const { email, nombre_apellido, evento_id, cupon_codigo } = req.body;
    const eventoId = parseInt(evento_id);
    const items = normalizarItems(req.body.items);
    const cantidadTotal = items.reduce((acc, i) => acc + i.cantidad, 0);

    if (!nombre_apellido || !String(nombre_apellido).trim()) {
        return res.status(400).send('Falta el nombre y apellido del comprador.');
    }
    if (cantidadTotal < 1) {
        return res.status(400).send('Elegí al menos una entrada antes de continuar.');
    }
    if (cantidadTotal > MAX_ENTRADAS_POR_COMPRA) {
        return res.status(400).send(`Podés comprar hasta ${MAX_ENTRADAS_POR_COMPRA} entradas por operación (sumando todos los tipos).`);
    }

    const evento = await eventosDb.obtenerEvento(eventoId);
    if (!evento || !evento.activo || !evento.conectado_mp) {
        return res.status(404).send('Evento no encontrado o no disponible para la venta.');
    }

    // Cierre de ventas: por evento finalizado o por fecha límite. Esto es una validación
    // "amable" antes de pagar; la que de verdad evita la sobreventa es la transacción con
    // FOR UPDATE en ticketsDb.registrarEntradas, que corre después del pago.
    if (eventosDb.eventoFinalizado(evento) || eventosDb.ventaVencidaPorTiempo(evento)) {
        return res.status(410).send('La venta de entradas para este evento ya cerró.');
    }

    const { lineas, error } = await resolverLineas(eventoId, items);
    if (error) return res.status(409).send(error);

    // Re-validación del cupón ACÁ, del lado del servidor, justo antes de cobrar — el preview
    // de /api/eventos/:id/validar-cupon es solo para mostrarle algo al usuario; el descuento
    // que de verdad se cobra sale de esta validación, nunca de un número que mandó el navegador.
    let descuentoTotal = 0;
    let cuponCodigo = null;
    if (cupon_codigo && String(cupon_codigo).trim()) {
        const resultadoCupon = await cuponesDb.validarCupon(cupon_codigo, eventoId, lineas);
        if (!resultadoCupon.valido) {
            return res.status(400).send(resultadoCupon.motivo);
        }
        descuentoTotal = resultadoCupon.descuento;
        cuponCodigo = resultadoCupon.cupon.codigo;
    }

    try {
        // El carrito queda guardado en NUESTRA base contra un token. A Mercado Pago solo le
        // viaja ese token, y es también lo único que vuelve en la URL de /success — así el
        // comprador no puede editar cantidades ni precios manipulando la URL de vuelta.
        const checkoutToken = await checkoutsDb.crearCheckout(eventoId, {
            items: lineas.map((l) => ({ tipoEntradaId: l.tipoEntrada.id, cantidad: l.cantidad })),
            email,
            nombreApellido: nombre_apellido,
            descuentoTotal,
            cuponCodigo
        });

        const urlCheckout = await mp.crearPreferencia(evento, lineas, {
            email, nombreApellido: nombre_apellido, descuentoTotal, cuponCodigo, checkoutToken
        });
        res.redirect(urlCheckout);
    } catch (error) {
        console.error('Error al crear la preferencia de pago:', error);
        res.status(500).send('Error al procesar el pago con Mercado Pago.');
    }
});

// Página de éxito: idempotente (no duplica entradas/mails si Mercado Pago o el navegador
// cargan esta URL más de una vez con el mismo payment_id). Todo lo que se necesita sale del
// checkout guardado en la base — de la URL solo se lee el token y el payment_id.
router.get('/success', async (req, res) => {
    const { checkout, payment_id } = req.query;
    let evento;
    let lineas;
    let datos;

    try {
        const registro = await checkoutsDb.obtenerCheckout(checkout);
        if (!registro) return res.status(404).send('No encontramos esta compra. Si ya recibiste tu mail con las entradas, está todo bien.');
        datos = registro.datos;

        evento = await eventosDb.obtenerEvento(registro.evento_id);
        if (!evento) return res.status(404).send('Evento no encontrado.');

        const resueltas = await resolverLineasParaCobro(evento.id, datos.items);
        if (!resueltas) return res.status(404).send('Alguno de los tipos de entrada de esta compra ya no existe.');
        lineas = resueltas;

        if (!payment_id) {
            console.error('Llegó a /success sin payment_id, se rechaza para evitar duplicados.');
            return res.status(400).send('No se pudo confirmar el pago. Si ya recibiste tu mail con las entradas, no hace falta hacer nada más.');
        }

        const cantidadTotal = lineas.reduce((acc, l) => acc + l.cantidad, 0);
        res.render('success', { email: datos.email, cant: cantidadTotal, evento });
    } catch (error) {
        console.error('Error al procesar la compra:', error);
        return res.status(500).send('Error interno al registrar la compra.');
    }

    // A partir de acá la respuesta YA fue enviada al navegador. Corre aparte para que un
    // error acá (PDF, QR, mail) no intente mandar otra respuesta HTTP y quede oculto. La
    // función es idempotente por payment_id: si el job de reconciliación (services/reconciliarPagos.js)
    // ya la procesó antes (por ejemplo porque el servidor se reinició justo acá), no duplica nada.
    try {
        await procesarPagoAprobado({
            evento, lineas, paymentId: payment_id,
            email: datos.email, nombreApellido: datos.nombreApellido,
            descuentoTotal: datos.descuentoTotal || 0, cuponCodigo: datos.cuponCodigo || null
        });
    } catch (error) {
        console.error('Error al generar el PDF o registrar las entradas post-pago:', error);
    }
});

router.get('/descargar-pdf', async (req, res) => {
    const { email, cant } = req.query;
    const limit = parseInt(cant) || 1;

    try {
        const filas = await ticketsDb.obtenerUltimasEntradas(email, limit);
        if (filas.length === 0) return res.status(404).send('No se encontraron entradas para este correo.');

        await generarPdfEnResponse(res, {
            nombreEvento: filas[0].evento_nombre,
            email,
            codigos: filas.map((f) => f.id)
        });
    } catch (error) {
        console.error('Error al descargar el PDF:', error);
        res.status(500).send('Hubo un error al generar tu entrada.');
    }
});

module.exports = router;
