const nodemailer = require('nodemailer');
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME } = require('../config/env');
const { enviarMailBrevo } = require('./brevo');

// Capa única de envío de mails. Intenta por SMTP (Nodemailer) y, si eso no está configurado o
// falla, cae a la API HTTP de Brevo.
//
// POR QUÉ EL FALLBACK, y no SMTP a secas: este proyecto ya había migrado de SMTP a la API de
// Brevo justamente porque Railway bloquea/deja colgadas las conexiones SMTP salientes (ver el
// comentario en services/brevo.js). La API de Brevo va por HTTPS al puerto 443, que sí sale.
// Dejar solo SMTP significaría, con alta probabilidad, que en producción no llegue ningún
// mail — y encima en silencio. Con este diseño:
//   - Si cargás SMTP_USER/SMTP_PASS, se usa Nodemailer como pediste.
//   - Si Railway bloquea esa conexión, el mail igual sale por Brevo y queda avisado en el log.
//   - Si no cargás nada de SMTP, todo sigue funcionando exactamente como antes.

const smtpConfigurado = Boolean(SMTP_USER && SMTP_PASS);

// El transporte se crea UNA sola vez (no por mail): nodemailer mantiene un pool de conexiones
// y recrearlo en cada envío es caro y puede agotar los límites del proveedor.
const transporte = smtpConfigurado
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465, // 465 = TLS implícito; 587 = STARTTLS, que nodemailer negocia solo
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        // Sin estos timeouts, un puerto SMTP bloqueado (el caso de Railway) deja la petición
        // colgada minutos enteros en vez de fallar rápido y pasar al fallback.
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000
    })
    : null;

if (smtpConfigurado) {
    console.log(`[mailer] SMTP configurado (${SMTP_HOST}:${SMTP_PORT}). Fallback a la API de Brevo si falla.`);
} else {
    console.log('[mailer] Sin SMTP_USER/SMTP_PASS: los mails salen por la API HTTP de Brevo.');
}

// Envía un mail. `to`, `subject` y `text` son obligatorios; `html` y el adjunto son opcionales.
// Devuelve el canal que terminó usando ('smtp' | 'brevo') — útil para los logs.
async function enviarMail({ to, subject, text, html, attachmentBase64, attachmentName }) {
    if (transporte) {
        try {
            await transporte.sendMail({
                from: `"${BREVO_SENDER_NAME}" <${SMTP_USER || BREVO_SENDER_EMAIL}>`,
                to, subject, text, html,
                attachments: attachmentBase64 && attachmentName
                    ? [{ filename: attachmentName, content: attachmentBase64, encoding: 'base64' }]
                    : undefined
            });
            return 'smtp';
        } catch (error) {
            // No se re-lanza: se intenta por Brevo antes de dar el envío por perdido.
            console.warn(`[mailer] SMTP falló (${error.message}). Reintentando por la API de Brevo...`);
        }
    }

    await enviarMailBrevo({ to, subject, text, attachmentBase64, attachmentName });
    return 'brevo';
}

module.exports = { enviarMail, smtpConfigurado };
