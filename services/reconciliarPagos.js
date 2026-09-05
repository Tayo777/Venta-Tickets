const eventosDb = require('../db/eventos');
const tiposEntradaDb = require('../db/tiposEntrada');
const comprasDb = require('../db/compras');
const checkoutsDb = require('../db/checkouts');
const mp = require('./mercadopago');
const { procesarPagoAprobado } = require('./procesarPago');

// Cada cuánto correr la reconciliación y cuánto para atrás mirar en cada corrida. La ventana
// es más ancha que el intervalo (180min vs 10min) a propósito: así, si el proceso estuvo caído
// o una corrida falla, la siguiente igual encuentra los pagos que quedaron pendientes.
const INTERVALO_MS = 10 * 60 * 1000;
const VENTANA_MINUTOS = 180;

// Red de seguridad para cuando /success nunca se ejecuta (el comprador cierra la pestaña antes
// de volver, el servidor se reinicia justo en el medio, Mercado Pago no llega a redirigir).
// Recorre cada evento con Mercado Pago conectado, busca sus pagos aprobados recientes y,
// para los que todavía no están en `compras`, entrega las entradas usando el external_reference
// guardado al crear la preferencia (ver services/mercadopago.js -> crearPreferencia).
async function reconciliarPagos() {
    let eventos;
    try {
        eventos = await eventosDb.obtenerEventosConectados();
    } catch (error) {
        console.error('[reconciliarPagos] No se pudo listar eventos conectados:', error.message);
        return;
    }

    for (const evento of eventos) {
        let pagos;
        try {
            pagos = await mp.buscarPagosAprobadosRecientes(evento.mp_access_token, { minutosAtras: VENTANA_MINUTOS });
        } catch (error) {
            console.error(`[reconciliarPagos] Evento ${evento.id} (${evento.nombre}): error al buscar pagos:`, error.message);
            continue;
        }

        for (const pago of pagos) {
            try {
                await reconciliarUnPago(evento, pago);
            } catch (error) {
                console.error(`[reconciliarPagos] Evento ${evento.id}, payment_id ${pago.id}: error al procesar:`, error.message);
            }
        }
    }

    // Carritos que quedaron abandonados en el checkout de Mercado Pago y nunca terminaron en
    // un pago. Se borran recién a los 7 días para no pisar ningún pago que llegue tarde.
    try {
        const borrados = await checkoutsDb.limpiarCheckoutsViejos(7);
        if (borrados > 0) console.log(`[reconciliarPagos] Limpiados ${borrados} checkout/s abandonados.`);
    } catch (error) {
        console.error('[reconciliarPagos] No se pudieron limpiar los checkouts viejos:', error.message);
    }
}

async function reconciliarUnPago(evento, pago) {
    const paymentId = String(pago.id);

    const yaProcesado = await comprasDb.yaProcesada(paymentId);
    if (yaProcesado) return; // ya entró por /success (o por una corrida anterior de este job)

    if (!pago.external_reference) {
        console.warn(`[reconciliarPagos] payment_id ${paymentId} aprobado sin external_reference, no se puede reconciliar automáticamente.`);
        return;
    }

    const datos = await resolverDatosDeCompra(pago.external_reference, paymentId);
    if (!datos) return;

    // Los tipos de entrada se releen de la base (no se confía en precios "congelados"): así el
    // monto que se registra sale del mismo cálculo que usó la preferencia de pago.
    const lineas = [];
    for (const item of datos.items) {
        const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(item.tipoEntradaId);
        if (!tipoEntrada || tipoEntrada.evento_id !== evento.id) {
            console.warn(`[reconciliarPagos] payment_id ${paymentId}: tipo de entrada ${item.tipoEntradaId} inválido para el evento ${evento.id}.`);
            return;
        }
        lineas.push({ tipoEntrada, cantidad: item.cantidad });
    }

    console.log(`[reconciliarPagos] Recuperando pago pendiente ${paymentId} del evento ${evento.nombre} (nunca llegó a /success).`);
    await procesarPagoAprobado({
        evento, lineas, paymentId,
        email: datos.email, nombreApellido: datos.nombreApellido,
        descuentoTotal: datos.descuentoTotal || 0, cuponCodigo: datos.cuponCodigo || null
    });
}

// El external_reference hoy es un token que apunta a la tabla `checkouts`. Pero puede haber
// pagos EN VUELO creados con el formato viejo (un JSON con los datos adentro, un solo tipo de
// entrada), así que se soportan los dos mientras esos pagos terminan de caer.
async function resolverDatosDeCompra(externalReference, paymentId) {
    const checkout = await checkoutsDb.obtenerCheckout(externalReference);
    if (checkout) return checkout.datos;

    try {
        const legacy = JSON.parse(externalReference);
        if (legacy && legacy.tipoEntradaId) {
            return {
                items: [{ tipoEntradaId: legacy.tipoEntradaId, cantidad: legacy.cantidad }],
                email: legacy.email,
                nombreApellido: legacy.nombreApellido,
                descuentoTotal: legacy.descuentoTotal || 0,
                cuponCodigo: legacy.cuponCodigo || null
            };
        }
    } catch {
        // No es JSON: era un token que ya no existe (checkout borrado por antigüedad).
    }

    console.warn(`[reconciliarPagos] payment_id ${paymentId}: no se encontró el checkout "${externalReference}".`);
    return null;
}

// Arranca el polling periódico. Se llama una sola vez desde server.js al iniciar la app.
function iniciarReconciliacionPeriodica() {
    setInterval(() => {
        reconciliarPagos().catch((error) => console.error('[reconciliarPagos] Error inesperado:', error));
    }, INTERVALO_MS);
    console.log(`Reconciliación de pagos con Mercado Pago activa (cada ${INTERVALO_MS / 60000} min).`);
}

module.exports = { reconciliarPagos, iniciarReconciliacionPeriodica };
