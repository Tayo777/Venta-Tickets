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
async function crearPreferencia(evento, tipoEntrada, { email, nombreApellido, cantidad, descuentoTotal = 0, cuponCodigo = null }) {
    const subtotalBruto = Number(tipoEntrada.precio) * cantidad;
    // El descuento del cupón ya viene validado y calculado por db/cupones.js (ver /crear-pago
    // en routes/pagos.js) — acá solo se aplica, nunca se recalcula ni se confía en un valor
    // que pudiera venir del navegador.
    const subtotal = Math.max(subtotalBruto - Number(descuentoTotal || 0), 0);
    const tarifaTotal = Number(evento.tarifa_online) * cantidad;
    const total = subtotal + tarifaTotal;

    // Nuestra comisión: % (comision_propia_pct) sobre lo que el organizador REALMENTE cobra
    // por las entradas (ya con el cupón aplicado), no sobre el precio de lista.
    const nuestraComision = Math.round(subtotal * Number(evento.comision_propia_pct) / 100);

    // external_reference viaja pegado al pago DENTRO de Mercado Pago (no depende de que el
    // navegador vuelva a /success), así el job de reconciliación puede reconstruir a quién
    // hay que entregarle las entradas aunque el redirect nunca haya llegado a pasar.
    const referenciaExterna = JSON.stringify({
        eventoId: evento.id, tipoEntradaId: tipoEntrada.id, email, nombreApellido: nombreApellido || '', cantidad,
        descuentoTotal: Number(descuentoTotal || 0), cuponCodigo: cuponCodigo || null
    });

    const tituloCupon = cuponCodigo ? ` (cupón ${cuponCodigo})` : '';
    const eventoClient = new MercadoPagoConfig({ accessToken: evento.mp_access_token });
    const preference = new Preference(eventoClient);
    const result = await preference.create({
        body: {
            items: [{ title: `${evento.nombre} - ${tipoEntrada.nombre} x ${cantidad}${tituloCupon}`, quantity: 1, unit_price: total, currency_id: 'ARS' }],
            payer: { email },
            marketplace_fee: nuestraComision,
            external_reference: referenciaExterna,
            back_urls: {
                success: `${BASE_URL}/success?email=${encodeURIComponent(email)}&nombre=${encodeURIComponent(nombreApellido || '')}&cant=${cantidad}&evento_id=${evento.id}&tipo_entrada_id=${tipoEntrada.id}&descuento=${Number(descuentoTotal || 0)}&cupon=${encodeURIComponent(cuponCodigo || '')}`,
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
    calcularTarifa, urlConexionOAuth, intercambiarCodigoOAuth, crearPreferencia, obtenerFeeReal,
    buscarPagosAprobadosRecientes
};
