const { IMGBB_API_KEY } = require('../config/env');

// Sube una imagen (Buffer) a ImgBB y devuelve la URL pública. Esto evita guardar archivos en
// el disco de Railway, que se borra en cada redeploy — el organizador solo ve "subir imagen",
// toda esta parte queda invisible para él.
async function subirImagen(buffer) {
    const body = new URLSearchParams();
    body.set('key', IMGBB_API_KEY);
    body.set('image', buffer.toString('base64'));

    const response = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
    const data = await response.json();

    if (!response.ok || !data.success) {
        throw new Error(`ImgBB respondió con error: ${JSON.stringify(data)}`);
    }
    return data.data.url;
}

module.exports = { subirImagen };
