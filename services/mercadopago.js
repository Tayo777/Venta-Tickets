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
async function crearPreferencia(evento, tipoEntrada, { email, nombreApellido, cantidad }) {
    const subtotal = Number(tipoEntrada.precio) * cantidad;
    const tarifaTotal = Number(evento.tarifa_online) * cantidad;
    const total = subtotal + tarifaTotal;

    // Nuestra comisión: 3% (comision_propia_pct) del valor de la entrada, fijado al crear el evento.
    const nuestraComision = Math.round(Number(tipoEntrada.precio) * cantidad * Number(evento.comision_propia_pct) / 100);

    const eventoClient = new MercadoPagoConfig({ accessToken: evento.mp_access_token });
    const preference = new Preference(eventoClient);
    const result = await preference.create({
        body: {
            items: [{ title: `${evento.nombre} - ${tipoEntrada.nombre} x ${cantidad}`, quantity: 1, unit_price: total, currency_id: 'ARS' }],
            payer: { email },
            marketplace_fee: nuestraComision,
            back_urls: {
                success: `${BASE_URL}/success?email=${encodeURIComponent(email)}&nombre=${encodeURIComponent(nombreApellido || '')}&cant=${cantidad}&evento_id=${evento.id}&tipo_entrada_id=${tipoEntrada.id}`,
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

module.exports = { calcularTarifa, urlConexionOAuth, intercambiarCodigoOAuth, crearPreferencia, obtenerFeeReal };
