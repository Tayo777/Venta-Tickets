const sharp = require('sharp');
const { IMGBB_API_KEY } = require('../config/env');

// No hay tantos eventos activos a la vez, así que nos podemos permitir flyers grandes y de
// buena calidad — el límite es solo para no reventar la memoria de Railway con fotos de
// celular de 8-12MB (que además ImgBB/el navegador del comprador no necesitan a esa resolución).
const LADO_MAXIMO_PX = 1920;
const PESO_OBJETIVO_BYTES = 2 * 1024 * 1024; // 2MB

// Comprime un flyer (Buffer) SOLO lo necesario: si ya entra en el objetivo con calidad alta
// (85) lo deja así; si pesa mucho, baja la calidad JPEG en escalones hasta que entre (o hasta
// un piso razonable de calidad, para no devolver una imagen ilegible).
async function comprimirImagen(buffer) {
    let calidad = 85;
    let comprimida = await sharp(buffer)
        .rotate() // corrige la orientación EXIF de fotos sacadas con el celular
        .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: calidad })
        .toBuffer();

    while (comprimida.length > PESO_OBJETIVO_BYTES && calidad > 40) {
        calidad -= 15;
        comprimida = await sharp(buffer)
            .rotate()
            .resize({ width: LADO_MAXIMO_PX, height: LADO_MAXIMO_PX, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: calidad })
            .toBuffer();
    }

    if (comprimida.length < buffer.length) {
        const pesoOriginalMB = (buffer.length / 1024 / 1024).toFixed(2);
        const pesoFinalMB = (comprimida.length / 1024 / 1024).toFixed(2);
        console.log(`Flyer pesaba ${pesoOriginalMB}MB, se redujo a ${pesoFinalMB}MB (calidad ${calidad}) antes de subirlo.`);
    }
    return comprimida;
}

// Sube una imagen (Buffer) a ImgBB y devuelve la URL pública. Esto evita guardar archivos en
// el disco de Railway, que se borra en cada redeploy — el organizador solo ve "subir imagen",
// toda esta parte queda invisible para él.
async function subirImagen(buffer) {
    const imagenComprimida = await comprimirImagen(buffer);

    const body = new URLSearchParams();
    body.set('key', IMGBB_API_KEY);
    body.set('image', imagenComprimida.toString('base64'));

    const response = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(`ImgBB respondió con error: ${JSON.stringify(data)}`);
    }
    return data.data.url;
}

module.exports = { subirImagen };
