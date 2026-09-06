// Comprime el flyer EN EL NAVEGADOR antes de subirlo, además de la compresión que ya hace el
// backend con sharp (services/imgbb.js). Por qué en los dos lados:
//   - El backend comprime lo que le llega, pero si la foto original pesa 8-12MB (típico de un
//     celular), esos MB igual tienen que viajar enteros desde el navegador del organizador
//     hasta el servidor ANTES de que el backend pueda tocarlos — con una conexión de subida
//     lenta, esa parte del viaje es la que más se siente como "lento para cargar".
//   - Comprimiendo acá primero, lo que sale del navegador ya pesa una fracción de eso.
//
// Reescribe el <input type="file"> con el archivo ya comprimido (vía DataTransfer) para que
// el <form> normal lo mande tal cual, sin tocar nada del lado del servidor.
//
// Se usa así en la vista:
//   <input type="file" name="flyer" id="flyer" accept="image/*">
//   <script src="/flyer-comprimir.js"></script>
//   <script>engancharCompresionFlyer('flyer');</script>
(function () {
    const LADO_MAXIMO_PX = 1600;
    const CALIDAD_JPEG = 0.82;

    function comprimirArchivo(archivo) {
        return new Promise((resolve) => {
            // Si no es una imagen que el navegador pueda decodificar en un <img> (o algo salió
            // mal), se manda el archivo original tal cual — el backend igual lo comprime.
            if (!archivo || !archivo.type.startsWith('image/')) return resolve(archivo);

            const lector = new FileReader();
            lector.onerror = () => resolve(archivo);
            lector.onload = () => {
                const imagen = new Image();
                imagen.onerror = () => resolve(archivo);
                imagen.onload = () => {
                    let { width, height } = imagen;
                    if (width > LADO_MAXIMO_PX || height > LADO_MAXIMO_PX) {
                        const escala = LADO_MAXIMO_PX / Math.max(width, height);
                        width = Math.round(width * escala);
                        height = Math.round(height * escala);
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(imagen, 0, 0, width, height);

                    canvas.toBlob((blob) => {
                        if (!blob || blob.size >= archivo.size) {
                            // No ganamos nada comprimiendo (imagen ya chica/liviana): mandamos la original.
                            return resolve(archivo);
                        }
                        const nombre = archivo.name.replace(/\.\w+$/, '') + '.jpg';
                        resolve(new File([blob], nombre, { type: 'image/jpeg' }));
                    }, 'image/jpeg', CALIDAD_JPEG);
                };
                imagen.src = lector.result;
            };
            lector.readAsDataURL(archivo);
        });
    }

    // Engancha la compresión al evento "change" del input de archivo indicado. Apenas el
    // organizador elige la foto (no al enviar el form), así el archivo ya está liviano de
    // entrada y el submit no tiene que esperar a comprimir además de subir.
    window.engancharCompresionFlyer = function (idInput) {
        const input = document.getElementById(idInput);
        if (!input) return;

        input.addEventListener('change', async () => {
            const archivo = input.files[0];
            if (!archivo) return;

            const comprimido = await comprimirArchivo(archivo);
            if (comprimido !== archivo) {
                const lista = new DataTransfer();
                lista.items.add(comprimido);
                input.files = lista.files;
            }
        });
    };

    // Pone el botón de submit en estado "Subiendo..." con spinner al enviar el form, para que
    // el organizador tenga feedback mientras se sube la imagen (puede tardar unos segundos
    // igual, sobre todo con internet de celular).
    window.engancharSpinnerSubida = function (idForm, idBoton) {
        const form = document.getElementById(idForm);
        const boton = document.getElementById(idBoton);
        if (!form || !boton) return;

        form.addEventListener('submit', () => {
            // No deshabilitamos el botón: un <button> disabled no manda su value/click en
            // algunos navegadores y, más importante, si el form usa confirm() antes de este
            // listener y el usuario cancela, submit no llega a dispararse — no hay riesgo de
            // doble click quedando bloqueado.
            boton.dataset.textoOriginal = boton.dataset.textoOriginal || boton.innerHTML;
            boton.innerHTML = '<span class="spinner-flyer"></span> Subiendo...';
            boton.setAttribute('aria-busy', 'true');
            boton.classList.add('boton-cargando');
        });
    };
})();
