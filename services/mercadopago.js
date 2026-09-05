const { MercadoPagoConfig, Preference } = require('mercadopago');
const { MP_CLIENT_ID, MP_CLIENT_SECRET, BASE_URL, PLATFORM_FEE_PCT, MP_FEE_ESTIMADA_PCT } = require('../config/env');

// Calcula automáticamente la tarifa que paga el comprador: comisión ESTIMADA de Mercado Pago
// + comisión de la plataforma. No se le pregunta nada al organizador — es siempre automático.
// Importante: la comisión real de Mercado Pago solo se conoce después de cada pago (depende
// del medio elegido por el comprador), así que esto es una estimación para fijar el precio;
// la cifra real de cada venta se consulta después con obtenerFeeReal().
function calcularTarifa(valorEntrada) {
    const tarifaOnline = Math.round(valorEntrada * (MP_FEE_ESTIMADA_PCT + PLATFORM_FEE_PCT) / 100);
    return { comisionMpPct: MP_FEE_ESTIMADA_PCT, comisionPropiaPct: PLATFORM_FEE_PCT, tarifaOnline };
}

// Tarifa de servicio de UNA entrada, proporcional a SU precio.
//
// Dos cosas se arreglan acá respecto del esquema viejo (un monto fijo por entrada guardado en
// eventos.tarifa_online, calculado una sola vez sobre el precio de referencia del evento):
//
// 1. PROPORCIONALIDAD. Con varios tipos a distinto precio, una VIP de $5000 pagaba la misma
//    tarifa fija que una General de $1000, pero la comisión de Mercado Pago es porcentual:
//    en la cara esa tarifa no alcanzaba y el hueco salía del margen del organizador.
//
// 2. GROSS-UP. Aplicar el porcentaje sobre el PRECIO se queda corto, porque Mercado Pago cobra
//    su comisión sobre el TOTAL cobrado (precio + tarifa), que siempre es mayor. Para que al
//    organizador le quede exactamente el precio que puso, hay que despejar el total:
//
//        total − pctMp·total − pctPropia·precio = precio
//        total·(1 − pctMp) = precio·(1 + pctPropia)
//        total = precio·(1 + pctPropia) / (1 − pctMp)
//        tarifa = total − precio
//
//    (pctPropia va sobre el precio porque así se cobra el marketplace_fee, ver calcularTotales.)
//
// Los porcentajes salen del evento (se congelan al crearlo, y comision_mp_pct se va afinando
// con datos reales — ver db/compras.js). Si un evento viejo los tiene en NULL, se cae a los
// valores por defecto de configuración.
function tarifaPorEntrada(evento, precioEntrada) {
    const precio = Number(precioEntrada);
    if (!(precio > 0)) return 0;

    const pctPropia = Number(evento.comision_propia_pct ?? PLATFORM_FEE_PCT) / 100;
    // Se acota entre 0 y 0.5 por las dudas: con un pctMp >= 1 la fórmula se iría al infinito
    // o daría negativo si algún dato quedara corrupto.
    const pctMp = Math.min(Math.max(Number(evento.comision_mp_pct ?? MP_FEE_ESTIMADA_PCT) / 100, 0), 0.5);

    const total = precio * (1 + pctPropia) / (1 - pctMp);
    return Math.max(0, Math.round(total - precio));
}

// Arma la URL de Mercado Pago donde el organizador inicia sesión y autoriza tu app (Marketplace).
function urlConexionOAuth(tokenEvento) {
    const redirectUri = encodeURIComponent(`${BASE_URL}/oauth/mercadopago/callback`);
    return `https://auth.mercadopago.com/authorization?client_id=${MP_CLIENT_ID}&response_type=code&platform_id=mp&redirect_uri=${redirectUri}&state=${tokenEvento}`;
}

// Intercambia el "code" que devuelve Mercado Pago por el Access Token real de la cuenta
// del organizador (esto es lo que hace que el dinero le llegue directo a él).
async function intercambiarCodigoOAuth(code) {
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: MP_CLIENT_ID,
            client_secret: MP_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: `${BASE_URL}/oauth/mercadopago/callback`
        })
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Mercado Pago OAuth respondió ${response.status}: ${errorBody}`);
    }
    return response.json(); // { access_token, refresh_token, user_id, public_key, live_mode, ... }
}

// Crea la preferencia de pago usando el Access Token PROPIO del organizador (el dinero entra
// directo a su cuenta), con marketplace_fee = comisión de la plataforma, que Mercado Pago
// transfiere sola a tu cuenta en cada venta.
// Calcula el desglose económico de una compra de varios tipos de entrada a la vez.
// Se usa en DOS lugares (armar la preferencia y, después del pago, registrar la compra), por
// eso vive acá y no inline: si los dos lados calcularan por su cuenta y uno cambiara, se
// cobraría una cosa y se registraría otra.
//
// `lineas` = [{ tipoEntrada, cantidad }]
function calcularTotales(evento, lineas, descuentoTotal = 0) {
    const cantidadTotal = lineas.reduce((acc, l) => acc + l.cantidad, 0);
    const subtotalBruto = lineas.reduce((acc, l) => acc + Number(l.tipoEntrada.precio) * l.cantidad, 0);

    // El descuento del cupón ya viene validado y calculado por db/cupones.js (ver /crear-pago
    // en routes/pagos.js) — acá solo se aplica, nunca se recalcula ni se confía en un valor
    // que pudiera venir del navegador.
    const subtotalEntradas = Math.max(subtotalBruto - Number(descuentoTotal || 0), 0);

    // La tarifa se calcula línea por línea, proporcional al precio de CADA tipo (ver
    // tarifaPorEntrada): así una VIP cara aporta la tarifa que le corresponde y no la
    // subsidia la General barata.
    const tarifaTotal = lineas.reduce(
        (acc, l) => acc + tarifaPorEntrada(evento, l.tipoEntrada.precio) * l.cantidad, 0
    );
    const total = subtotalEntradas + tarifaTotal;

    // Nuestra comisión (marketplace_fee) se calcula SOLO sobre lo que el organizador cobra por
    // las entradas ya con el cupón aplicado — nunca sobre la tarifa online (esa cubre la
    // comisión de Mercado Pago, no es ingreso del organizador) ni sobre el precio de lista.
    // El clamp final es una red de seguridad contable: Mercado Pago rechaza la preferencia si
    // el fee supera el monto cobrado, algo que podría pasar con un cupón del 100%.
    const comisionBruta = Math.round(subtotalEntradas * Number(evento.comision_propia_pct) / 100);
    const nuestraComision = Math.min(comisionBruta, Math.floor(total));

    return { cantidadTotal, subtotalBruto, subtotalEntradas, tarifaTotal, total, nuestraComision };
}

async function crearPreferencia(evento, lineas, { email, nombreApellido, descuentoTotal = 0, cuponCodigo = null, checkoutToken }) {
    const { total, nuestraComision } = calcularTotales(evento, lineas, descuentoTotal);

    const detalle = lineas.map((l) => `${l.cantidad}x ${l.tipoEntrada.nombre}`).join(', ');
    const tituloCupon = cuponCodigo ? ` (cupón ${cuponCodigo})` : '';

    const eventoClient = new MercadoPagoConfig({ accessToken: evento.mp_access_token });
    const preference = new Preference(eventoClient);
    const result = await preference.create({
        body: {
            // UN solo ítem con el total exacto, aunque el carrito tenga varios tipos. Itemizar
            // por tipo obligaría a prorratear el descuento y la tarifa entre líneas, y el
            // redondeo de cada una haría que la suma no cierre contra el total real por unos
            // pesos. Con un único ítem, lo que se cobra es exactamente lo que calculamos.
            items: [{ title: `${evento.nombre} - ${detalle}${tituloCupon}`, quantity: 1, unit_price: total, currency_id: 'ARS' }],
            payer: { email },
            marketplace_fee: nuestraComision,
            // Solo viaja el token del checkout: los datos reales (qué tipos, cuántos, quién,
            // qué cupón) quedan en NUESTRA base (tabla checkouts). Así no dependemos del
            // límite de 256 chars de este campo ni exponemos datos del comprador en la pasarela.
            external_reference: checkoutToken,
            back_urls: {
                success: `${BASE_URL}/success?checkout=${checkoutToken}`,
                failure: `${BASE_URL}/evento/${evento.id}`,
                pending: `${BASE_URL}/evento/${evento.id}`
            },
            auto_return: 'approved'
        }
    });

    const esProduccion = evento.mp_access_token.startsWith('APP_USR');
    return esProduccion ? result.init_point : result.sandbox_init_point;
}

// Consulta el pago YA CONFIRMADO para saber la comisión REAL que cobró Mercado Pago (no la
// estimación). Se usa después de /success, solo para guardar el dato exacto en el informe —
// no cambia nada de lo que ya se cobró.
async function obtenerFeeReal(accessTokenOrganizador, paymentId) {
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${accessTokenOrganizador}` }
    });
    if (!response.ok) {
        throw new Error(`No se pudo consultar el pago ${paymentId}: ${response.status}`);
    }
    const pago = await response.json();
    const feeMp = (pago.fee_details || []).find((f) => f.type === 'mercadopago_fee');
    return {
        comisionMpReal: feeMp ? feeMp.amount : null,
        montoNeto: pago.transaction_details ? pago.transaction_details.net_received_amount : null
    };
}

// Busca pagos APROBADOS recientes en la cuenta del organizador (accessToken propio, por eso
// esto hay que llamarlo una vez por cada evento conectado). Se usa desde el job de
// reconciliación (services/reconciliarPagos.js) para encontrar pagos cuyo webhook/redirect
// nunca llegó a procesarse — por ejemplo porque el servidor se reinició en el medio.
async function buscarPagosAprobadosRecientes(accessToken, { minutosAtras = 180 } = {}) {
    const desde = new Date(Date.now() - minutosAtras * 60 * 1000).toISOString();
    const hasta = new Date().toISOString();
    const params = new URLSearchParams({
        sort: 'date_created',
        criteria: 'desc',
        range: 'date_created',
        begin_date: desde,
        end_date: hasta,
        status: 'approved',
        limit: '50'
    });

    const response = await fetch(`https://api.mercadopago.com/v1/payments/search?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
        throw new Error(`Búsqueda de pagos respondió ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    return data.results || [];
}

module.exports = {
    calcularTarifa, tarifaPorEntrada, calcularTotales, urlConexionOAuth, intercambiarCodigoOAuth,
    crearPreferencia, obtenerFeeReal, buscarPagosAprobadosRecientes
};
