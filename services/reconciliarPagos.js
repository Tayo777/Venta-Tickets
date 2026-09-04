const eventosDb = require('../db/eventos');
const tiposEntradaDb = require('../db/tiposEntrada');
const comprasDb = require('../db/compras');
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
}

async function reconciliarUnPago(evento, pago) {
    const paymentId = String(pago.id);

    const yaProcesado = await comprasDb.yaProcesada(paymentId);
    if (yaProcesado) return; // ya entró por /success (o por una corrida anterior de este job)

    if (!pago.external_reference) {
        console.warn(`[reconciliarPagos] payment_id ${paymentId} aprobado sin external_reference, no se puede reconciliar automáticamente.`);
        return;
    }

    let datos;
    try {
        datos = JSON.parse(pago.external_reference);
    } catch {
        console.warn(`[reconciliarPagos] payment_id ${paymentId} con external_reference inválido: ${pago.external_reference}`);
        return;
    }

    const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(datos.tipoEntradaId);
    if (!tipoEntrada || tipoEntrada.evento_id !== evento.id) {
        console.warn(`[reconciliarPagos] payment_id ${paymentId}: tipo de entrada ${datos.tipoEntradaId} inválido para el evento ${evento.id}.`);
        return;
    }

    console.log(`[reconciliarPagos] Recuperando pago pendiente ${paymentId} del evento ${evento.nombre} (nunca llegó a /success).`);
    await procesarPagoAprobado({
        evento, tipoEntrada, paymentId,
        email: datos.email, nombreApellido: datos.nombreApellido, cantidad: datos.cantidad
    });
}

// Arranca el polling periódico. Se llama una sola vez desde server.js al iniciar la app.
function iniciarReconciliacionPeriodica() {
    setInterval(() => {
        reconciliarPagos().catch((error) => console.error('[reconciliarPagos] Error inesperado:', error));
    }, INTERVALO_MS);
    console.log(`Reconciliación de pagos con Mercado Pago activa (cada ${INTERVALO_MS / 60000} min).`);
}

module.exports = { reconciliarPagos, iniciarReconciliacionPeriodica };
