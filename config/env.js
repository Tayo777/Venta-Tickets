// Centraliza la validación de variables de entorno y las constantes de configuración.
// Si falta algo obligatorio, la app no arranca (mejor eso que fallar a mitad de una venta).
require('dotenv').config();

const requiredEnv = [
    'MP_CLIENT_ID', 'MP_CLIENT_SECRET',        // credenciales de TU app Marketplace en Mercado Pago
    'BREVO_API_KEY', 'BREVO_SENDER_EMAIL',     // envío de mails
    'ADMIN_EMAIL',                             // tu mail: recibe los pedidos de aprobación de organizadores
    'ADMIN_SEED_EMAIL', 'ADMIN_SEED_PASSWORD', // tu usuario admin, se crea solo la primera vez que arranca
    'SESSION_SECRET',                          // clave para firmar las sesiones de login (invéntala, larga y random)
    'IMGBB_API_KEY',                           // para poder subir flyers como imagen directamente
    'MP_WEBHOOK_SECRET',                       // firma HMAC de las notificaciones (webhooks) de Mercado Pago
    'JWT_SECRET',                               // firma los JWT de login de la app móvil de guardias
    'BASE_URL', 'MYSQL_URL'
];

const faltantes = requiredEnv.filter((key) => !process.env[key]);
if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
    console.error('Creá un archivo .env (ver .env.example) o configuralas en tu plataforma de hosting.');
    process.exit(1);
}

module.exports = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.BASE_URL,
    MYSQL_URL: process.env.MYSQL_URL,

    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_SEED_EMAIL: process.env.ADMIN_SEED_EMAIL,
    ADMIN_SEED_PASSWORD: process.env.ADMIN_SEED_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET,

    MP_CLIENT_ID: process.env.MP_CLIENT_ID,
    MP_CLIENT_SECRET: process.env.MP_CLIENT_SECRET,

    BREVO_API_KEY: process.env.BREVO_API_KEY,
    BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL,
    BREVO_SENDER_NAME: process.env.BREVO_SENDER_NAME || 'Venta de Entradas',

    IMGBB_API_KEY: process.env.IMGBB_API_KEY,

    // Ya NO se usa para firmar QRs nuevos (eso ahora es eventos.qr_secret, uno por evento) —
    // se mantiene opcional solo como semilla de migración para eventos que ya existían antes
    // de este cambio, así sus QRs ya emitidos no se invalidan de golpe (ver db/pool.js).
    QR_SECRET_LEGACY: process.env.QR_SECRET,
    MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,

    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

    // Cargo por servicio: porcentaje FIJO sobre el precio base de cada tipo de entrada. Es el
    // único número que define lo que paga de más el comprador y lo que cobra la plataforma —
    // no se configura por evento ni por tipo de entrada, y el organizador no lo puede tocar.
    // Vive en el .env solo para poder cambiarlo en un lugar el día que haga falta.
    TARIFA_SERVICIO_PCT: Number(process.env.TARIFA_SERVICIO_PCT || 4),
    // Comisión de la plataforma (vos) sobre cada venta.
    PLATFORM_FEE_PCT: Number(process.env.PLATFORM_FEE_PCT || 3),
    // Comisión de Mercado Pago: constante FIJA, la tarifa real de nuestra cuenta. Es lo que se
    // absorbe en el gross-up (ver services/mercadopago.js) para que al organizador le quede su
    // precio base intacto.
    //
    // Tiene que ser fija a propósito: antes se recalculaba sola con la comisión real observada
    // en cada venta, y eso hacía que el precio que ve el comprador se moviera solo de un día
    // para el otro. Un evento publicado a $1111 no puede pasar a $1089 sin que nadie lo toque.
    // Si Mercado Pago cambia su tarifa, se cambia ACÁ (y los eventos ya creados conservan la
    // que tenían congelada en eventos.comision_mp_pct, así no se les mueve el precio).
    //
    // Se sigue leyendo el nombre viejo MP_FEE_ESTIMADA_PCT como respaldo para no romper el
    // deploy si esa variable ya está cargada en Railway.
    MP_COMISION_PCT: Number(process.env.MP_COMISION_PCT || process.env.MP_FEE_ESTIMADA_PCT || 6.39)
};
