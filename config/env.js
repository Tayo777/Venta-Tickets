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
    'QR_SECRET',                               // firma HMAC de los QR de entrada, para detectar falsificaciones
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

    QR_SECRET: process.env.QR_SECRET,
    MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,

    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

    // Comisión de la plataforma (vos) sobre cada venta.
    PLATFORM_FEE_PCT: Number(process.env.PLATFORM_FEE_PCT || 3),
    // Estimación automática de la comisión de Mercado Pago, usada para calcular la tarifa que
    // paga el comprador. Es una ÚNICA estimación fija (no se le pregunta nada al organizador) —
    // la comisión real depende del medio de pago que elija cada comprador y solo se conoce
    // después de cada transacción (por eso además consultamos el valor real post-pago, ver
    // services/mercadopago.js -> obtenerFeeReal).
    MP_FEE_ESTIMADA_PCT: Number(process.env.MP_FEE_ESTIMADA_PCT || 6.39)
};
