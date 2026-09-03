const { BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME } = require('../config/env');

// Envío de mails vía la API HTTP de Brevo (https://api.brevo.com), no por SMTP: evita el
// bloqueo/timeout de conexiones SMTP salientes que da Railway con Gmail, porque corre sobre
// HTTPS (puerto 443), el mismo que ya usa el resto de la app sin problemas.
async function enviarMailBrevo({ to, subject, text, attachmentBase64, attachmentName }) {
    const body = {
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        textContent: text
    };
    if (attachmentBase64 && attachmentName) {
        body.attachment = [{ content: attachmentBase64, name: attachmentName }];
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': BREVO_API_KEY,
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Brevo respondió ${response.status}: ${errorBody}`);
    }
}

module.exports = { enviarMailBrevo };
