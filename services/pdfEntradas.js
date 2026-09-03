const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { BASE_URL } = require('../config/env');

// Dibuja el PDF de entradas (banner, datos del comprador, un bloque con QR por código).
// Se usa tanto en /success (arma el PDF en memoria para mandarlo por mail) como en
// /descargar-pdf (lo manda directo como respuesta HTTP) — antes este código estaba
// duplicado dos veces en server.js.
function dibujarEntradas(doc, { nombreEvento, email, codigos }) {
    const pageWidth = doc.page.width;

    doc.rect(0, 0, pageWidth, 120).fill('#1a252c');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(nombreEvento.toUpperCase(), 0, 40, { align: 'center' });
    doc.fillColor('#bdc3c7').font('Helvetica').fontSize(12).text('ENTRADAS OFICIALES', 0, 75, { align: 'center' });

    doc.fillColor('#636e72').font('Helvetica-Bold').fontSize(10).text('TITULAR DE LA COMPRA', 0, 150, { align: 'center' });
    doc.fillColor('#2d3436').font('Helvetica-Bold').fontSize(14).text(email, 0, 165, { align: 'center' });

    let currentY = 220;

    return (async () => {
        for (let i = 0; i < codigos.length; i++) {
            if (currentY + 280 > doc.page.height) {
                doc.addPage({ margin: 0 });
                currentY = 50;
            }

            const codigo = codigos[i];
            const urlValidacion = `${BASE_URL}/validar/${codigo}`;

            doc.rect(50, currentY, pageWidth - 100, 230).lineWidth(2).dash(5, { space: 5 }).stroke('#b2bec3');
            doc.undash();

            doc.fillColor('#2d3436').font('Helvetica-Bold').fontSize(16).text(`Acceso ${i + 1} de ${codigos.length}`, 0, currentY + 25, { align: 'center' });
            doc.fillColor('#e74c3c').font('Helvetica').fontSize(10).text('Presentá este QR en la puerta', 0, currentY + 50, { align: 'center' });

            const qrBuffer = await QRCode.toBuffer(urlValidacion, { margin: 1, width: 100, color: { dark: '#000', light: '#fff' } });
            doc.image(qrBuffer, (pageWidth / 2) - 50, currentY + 70, { width: 100 });

            doc.rect((pageWidth / 2) - 75, currentY + 185, 150, 25).fill('#f1f2f6');
            doc.fillColor('#2d3436').font('Courier-Bold').fontSize(14).text(codigo, 0, currentY + 190, { align: 'center' });

            if (i < codigos.length - 1) {
                currentY += 270;
                doc.lineWidth(1).dash(3, { space: 3 }).strokeColor('#dfe6e9').moveTo(50, currentY).lineTo(pageWidth - 50, currentY).stroke();
                doc.undash();
                doc.fillColor('#b2bec3').font('Helvetica').fontSize(16).text('✂', 0, currentY - 8, { align: 'center' });
                currentY += 30;
            }
        }
    })();
}

// Genera el PDF completo en memoria y devuelve el Buffer (para adjuntar al mail).
function generarPdfBuffer({ nombreEvento, email, codigos }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 0, size: 'A4' });
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        dibujarEntradas(doc, { nombreEvento, email, codigos })
            .then(() => doc.end())
            .catch(reject);
    });
}

// Genera el PDF directo a una respuesta HTTP (para la descarga manual).
async function generarPdfEnResponse(res, { nombreEvento, email, codigos }) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Entradas_${email}.pdf`);

    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    doc.pipe(res);
    await dibujarEntradas(doc, { nombreEvento, email, codigos });
    doc.end();
}

module.exports = { generarPdfBuffer, generarPdfEnResponse };
