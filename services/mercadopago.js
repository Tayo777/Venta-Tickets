const { MercadoPagoConfig, Preference } = require('mercadopago');
const { MP_CLIENT_ID, MP_CLIENT_SECRET, BASE_URL, TARIFA_SERVICIO_PCT, MP_COMISION_PCT } = require('../config/env');

// Redondeo a 2 decimales, que es la precisión con la que trabaja Mercado Pago (y las columnas
// DECIMAL(10,2) de la base). El + Number.EPSILON corrige el clásico caso de punto flotante en
// el que 1.005 * 100 da 100.49999999999999 y Math.round lo tiraría para abajo.
function redondear2(numero) {
    return Math.round((Number(numero) + Number.EPSILON) * 100) / 100;
}

// Redondeo a 2 decimales SIEMPRE PARA ARRIBA, solo para el recargo que paga el comprador.
//
// Por qué no alcanza con redondear2 acá: el recargo se redondea por unidad, pero Mercado Pago
// cobra su comisión sobre el total sumado. Si el recargo unitario queda redondeado apenas para
// abajo, en una compra de varias entradas el neto puede terminar un centavo por debajo del
// precio base — y la regla del negocio es que el organizador NUNCA reciba menos de su precio.
// Redondeando para arriba, el desvío siempre queda a favor del organizador; el comprador paga
// como mucho un centavo de más por entrada.
//
// El − Number.EPSILON evita que un valor ya exacto (ej: 40.00) se empuje a 40.01 por la
// imprecisión del punto flotante.
function redondear2Arriba(numero) {
    return Math.ceil(Number(numero) * 100 - Number.EPSILON) / 100;
}

// Porcentaje de comisión de Mercado Pago que se usa para el gross-up. Es un valor FIJO: sale
// de la constante de configuración y se congela por evento al crearlo (eventos.comision_mp_pct),
// así un evento ya publicado conserva su precio aunque la constante cambie más adelante.
//
// Nada lo recalcula después de crear el evento — antes se re-promediaba con la comisión real
// de cada venta y eso hacía que el precio publicado se moviera solo (ver la nota en
// db/compras.js).
//
// Se acota a [0, 0.5) por seguridad: con un pctMp >= 1 la división de abajo se iría al
// infinito o daría negativo si algún dato quedara corrupto.
function porcentajeMp(evento) {
    const pct = Number(evento?.comision_mp_pct ?? MP_COMISION_PCT) / 100;
    return Math.min(Math.max(pct, 0), 0.5);
}

// Factor por el que hay que multiplicar lo que cobra el organizador para obtener el TOTAL a
// cobrarle al comprador. Es el corazón del gross-up, en un solo lugar: lo usan el cálculo del
// servidor, el precio por entrada que se muestra en cada tarjeta, y el resumen del checkout
// en el navegador (viaja a la vista para no reescribir la fórmula en dos idiomas).
//
//     total = base · (1 + 4%) / (1 − pctMp)
function factorRecargo(evento) {
    return (1 + TARIFA_SERVICIO_PCT / 100) / (1 - porcentajeMp(evento));
}

// Recargo que paga el COMPRADOR por UNA entrada: nuestro 4% + la comisión de Mercado Pago,
// absorbida vía gross-up. Es la única función que define lo que se cobra de más.
//
// La regla de negocio es estricta: el organizador tiene que recibir EXACTAMENTE su precio
// base, sin que le descuenten nada. Para eso hay que despejar el total a cobrar, porque
// Mercado Pago cobra su comisión sobre el TOTAL (que incluye el recargo), no sobre el precio:
//
//     neto que queda después de MP        = total · (1 − pctMp)
//     ese neto se tiene que repartir en   = precio (organizador) + 4%·precio (TuEntradaYa)
//
//     total · (1 − pctMp) = precio · (1 + 0.04)
//     total = precio · (1 + 0.04) / (1 − pctMp)
//     recargo = total − precio
//
// Ejemplo con precio $1000 y pctMp 6.39%:
//     total   = 1000 · 1.04 / 0.9361 = $1110.99
//     MP cobra  6.39% de 1110.99     = $70.99  → neto $1040.00
//     TuEntradaYa se lleva 4% de 1000  = $40.00  → al organizador le quedan $1000.00 exactos
function tarifaPorEntrada(evento, precioEntrada) {
    const precio = Number(precioEntrada);
    if (!(precio > 0)) return 0;

    return Math.max(0, redondear2Arriba(precio * factorRecargo(evento) - precio));
}

// Nuestra ganancia por UNA entrada: exactamente el 4% del precio base, sin importar cuánto
// termine cobrando Mercado Pago. Es lo que viaja como marketplace_fee (ver calcularTotales).
function gananciaPorEntrada(precioEntrada) {
    const precio = Number(precioEntrada);
    if (!(precio > 0)) return 0;
    return redondear2(precio * TARIFA_SERVICIO_PCT / 100);
}

// Valores que se congelan en el evento al crearlo. comision_propia_pct queda como referencia
// para los informes: el precio que se cobra NO sale de acá, se recalcula siempre con
// tarifaPorEntrada() sobre el precio de cada tipo de entrada.
function calcularTarifa(valorEntrada) {
    return {
        comisionMpPct: MP_COMISION_PCT,
        comisionPropiaPct: TARIFA_SERVICIO_PCT,
        tarifaOnline: tarifaPorEntrada({ comision_mp_pct: MP_COMISION_PCT }, valorEntrada)
    };
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
    const subtotalBruto = redondear2(lineas.reduce((acc, l) => acc + Number(l.tipoEntrada.precio) * l.cantidad, 0));

    // El descuento del cupón ya viene validado y calculado por db/cupones.js (ver /crear-pago
    // en routes/pagos.js) — acá solo se aplica, nunca se recalcula ni se confía en un valor
    // que pudiera venir del navegador.
    const subtotalEntradas = redondear2(Math.max(subtotalBruto - Number(descuentoTotal || 0), 0));

    // ORDEN SECUENCIAL, y esto es lo importante: primero se descuenta el cupón, y RECIÉN
    // DESPUÉS se calcula el recargo sobre ese precio ya descontado. Antes el recargo salía del
    // precio de lista, así que en una compra con cupón el comprador pagaba de más y al
    // organizador le quedaba un saldo a favor que no le correspondía. Ahora:
    //
    //     1. subtotalEntradas = precio de lista − descuento   (lo que efectivamente cobra el organizador)
    //     2. total            = subtotalEntradas · factor     (gross-up sobre ESE número)
    //     3. recargo          = total − subtotalEntradas      (lo que paga de más el comprador)
    //     4. nuestro 4%       = 4% de subtotalEntradas        (sobre el valor realmente abonado)
    //
    // El gross-up se aplica UNA sola vez sobre el total del carrito (no por unidad): así el
    // redondeo ocurre una única vez y la cuenta cierra al centavo, en vez de acumular un
    // centavo por entrada. El "+ $X" que muestra cada tarjeta de entrada sigue siendo el
    // recargo unitario de referencia, sin cupón.
    const total = redondear2Arriba(subtotalEntradas * factorRecargo(evento));
    const tarifaTotal = redondear2(total - subtotalEntradas);

    // Nuestra ganancia (marketplace_fee, lo que Mercado Pago transfiere solo a la cuenta de la
    // plataforma): 4% de lo que realmente cobra el organizador por las entradas, ya con el
    // cupón aplicado. Nunca sale del recargo, que existe para cubrir la comisión de la pasarela.
    //
    // Con esto la cuenta cierra: MP se lleva su comisión del total, nosotros el 4% del valor
    // abonado, y lo que queda es exactamente lo que cobra el organizador.
    //
    // El clamp es una red de seguridad contable: Mercado Pago rechaza la preferencia si el fee
    // supera el monto cobrado.
    const nuestraComision = Math.min(redondear2(subtotalEntradas * TARIFA_SERVICIO_PCT / 100), total);

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
    // Se exporta el porcentaje para que las vistas muestren SIEMPRE el mismo número que usa el
    // cálculo (nunca un "4" escrito a mano en el HTML que pueda quedar desactualizado).
    TARIFA_SERVICIO_PCT,
    calcularTarifa, tarifaPorEntrada, gananciaPorEntrada, factorRecargo, redondear2, calcularTotales, urlConexionOAuth, intercambiarCodigoOAuth,
    crearPreferencia, obtenerFeeReal, buscarPagosAprobadosRecientes
};
