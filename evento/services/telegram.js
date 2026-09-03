const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('../config/env');

// Envía un mensaje al chat de Telegram configurado. No corta la app si falla ni si no está configurado.
async function enviarNotificacionTelegram(mensaje) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensaje, parse_mode: 'HTML' })
        });
        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Telegram respondió con error:', response.status, errorBody);
        }
    } catch (error) {
        console.error('Error al enviar notificación a Telegram:', error.message);
    }
}

module.exports = { enviarNotificacionTelegram };
