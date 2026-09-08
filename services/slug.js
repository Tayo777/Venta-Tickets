// Convierte un texto libre (el nombre del evento) en un slug apto para URL: minúsculas, sin
// acentos ni ñ, solo [a-z0-9-], sin guiones repetidos ni en las puntas. Es la mitad "pura" de
// la generación de slugs — no toca la base, por eso vive en services/ y no en db/. La otra
// mitad (agregar el prefijo "tuentradaya-" y resolver colisiones consultando la DB) está en
// db/eventos.js, que es quien tiene acceso al pool.
function generarSlugBase(texto) {
    return String(texto || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca tildes: "Perú" -> "Peru"
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-') // cualquier cosa que no sea letra/número pasa a guión
        .replace(/^-+|-+$/g, '') // sin guión colgando al principio/final
        .slice(0, 200); // tope razonable de largo (el prefijo "tuentradaya-" y un sufijo van aparte)
}

module.exports = { generarSlugBase };
