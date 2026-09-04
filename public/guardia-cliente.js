// Lógica del scanner offline del guardia. Todo el estado vive en IndexedDB (no en memoria),
// para sobrevivir si el navegador se recarga o el celular se queda sin batería/señal a mitad
// del evento.
//
// Esquema (una base de datos por evento, así un mismo celular puede ser guardia de varios):
//   DB "guardia-<eventoId>"
//     store "tickets"     keyPath 'id'  -> { id, estado }             (copia local de la DB)
//     store "pendientes"  keyPath 'id'  -> { id, ts }                 (validado offline, falta avisar al server)
(function () {
    const eventoId = window.GUARDIA_EVENTO_ID;
    const elEstado = document.getElementById('estado');
    const elPendientes = document.getElementById('contador-pendientes');
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let db;

    function abrirDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(`guardia-${eventoId}`, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore('tickets', { keyPath: 'id' });
                req.result.createObjectStore('pendientes', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function tx(storeName, modo) {
        return db.transaction(storeName, modo).objectStore(storeName);
    }

    function idbGet(storeName, key) {
        return new Promise((resolve, reject) => {
            const req = tx(storeName, 'readonly').get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    function idbPut(storeName, valor) {
        return new Promise((resolve, reject) => {
            const req = tx(storeName, 'readwrite').put(valor);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    function idbDelete(storeName, key) {
        return new Promise((resolve, reject) => {
            const req = tx(storeName, 'readwrite').delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    function idbGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const req = tx(storeName, 'readonly').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    function mostrarEstado(texto, color) {
        elEstado.textContent = texto;
        elEstado.style.background = color;
    }

    async function actualizarContadorPendientes() {
        const pendientes = await idbGetAll('pendientes');
        elPendientes.textContent = pendientes.length;
        elPendientes.parentElement.hidden = pendientes.length === 0;
    }

    // Trae la lista completa de tickets del server y refresca la copia local. Se llama al
    // entrar (si hay internet) y cada vez que se reconecta — así el celular arranca el evento
    // con el cupo/estado más nuevo posible antes de quedarse sin señal.
    async function refrescarCacheDeTickets() {
        try {
            const resp = await fetch(`/api/guardia/${eventoId}/tickets`);
            if (!resp.ok) return;
            const { tickets } = await resp.json();
            for (const t of tickets) {
                // No pisa un ticket que este mismo celular ya marcó como usado offline y
                // todavía no confirmó con el server (evita "revivir" una entrada localmente).
                const pendiente = await idbGet('pendientes', t.id);
                if (!pendiente) await idbPut('tickets', t);
            }
            console.log(`[guardia] Cache local actualizada: ${tickets.length} entradas.`);
        } catch {
            // Sin internet: seguimos con lo que ya había en IndexedDB de la última vez.
        }
    }

    // Intenta avisarle al server cada validación hecha offline. Idempotente: si el server
    // dice "ya_usada" (por ejemplo porque otro guardia ya la sincronizó) igual se la saca de
    // la cola, porque el efecto que importa (que no vuelva a entrar) ya está garantizado.
    async function sincronizarPendientes() {
        if (!navigator.onLine) return;
        const pendientes = await idbGetAll('pendientes');

        for (const p of pendientes) {
            try {
                const resp = await fetch(`/api/guardia/${eventoId}/validar/${p.id}`, { method: 'POST' });
                if (resp.ok || resp.status === 403) {
                    await idbDelete('pendientes', p.id);
                }
                // Si el server no responde bien (500) la dejamos en la cola para reintentar.
            } catch {
                break; // se cortó la conexión de nuevo, se sigue reintentando más tarde
            }
        }
        await actualizarContadorPendientes();
    }

    // Corazón del modo offline: decide qué mostrarle al guardia SIN esperar respuesta del
    // server. Si hay internet la confirmación real llega igual (fetch), pero la UI ya
    // respondió al toque con lo último que sabíamos localmente.
    async function procesarCodigo(codigoLeido) {
        // El QR trae la URL completa (BASE_URL/validar/EVT-XXXXXXXX); nos quedamos con el código.
        const match = String(codigoLeido).match(/EVT-[A-Z0-9]+$/);
        const ticketId = match ? match[0] : codigoLeido;

        const local = await idbGet('tickets', ticketId);
        if (!local) {
            // No está en la copia local: puede ser una entrada nueva vendida después del
            // último refresh. Si hay internet, se intenta validar directo contra el server.
            if (navigator.onLine) return validarOnline(ticketId);
            return mostrarEstado('❓ SIN DATOS LOCALES — conectate a internet para refrescar', '#95a5a6');
        }

        if (local.estado === 'Usada') {
            return mostrarEstado('⚠️ YA ESCANEADA', '#f39c12');
        }

        // Optimista: se marca como usada YA, local, y se encola la confirmación.
        await idbPut('tickets', { id: ticketId, estado: 'Usada' });
        await idbPut('pendientes', { id: ticketId, ts: Date.now() });
        await actualizarContadorPendientes();
        mostrarEstado('✅ ACCESO PERMITIDO', '#27ae60');
        sincronizarPendientes();
    }

    async function validarOnline(ticketId) {
        try {
            const resp = await fetch(`/api/guardia/${eventoId}/validar/${ticketId}`, { method: 'POST' });
            const data = await resp.json();
            if (resp.status === 404) return mostrarEstado('❌ RECHAZADO: no existe', '#c0392b');
            if (data.resultado === 'ya_usada') return mostrarEstado('⚠️ YA ESCANEADA', '#f39c12');
            await idbPut('tickets', { id: ticketId, estado: 'Usada' });
            mostrarEstado('✅ ACCESO PERMITIDO', '#27ae60');
        } catch {
            mostrarEstado('❌ SIN CONEXIÓN Y SIN DATOS LOCALES DE ESTA ENTRADA', '#c0392b');
        }
    }

    // --- Cámara + lectura de QR (jsQR) ---
    let escaneando = false;
    let ultimoCodigo = null;
    let ultimoTs = 0;

    function loopEscaneo() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imagen = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const codigo = window.jsQR(imagen.data, imagen.width, imagen.height);

            if (codigo) {
                const ahora = Date.now();
                // Evita procesar el mismo QR 30 veces por segundo mientras el guardia lo sostiene.
                if (codigo.data !== ultimoCodigo || ahora - ultimoTs > 3000) {
                    ultimoCodigo = codigo.data;
                    ultimoTs = ahora;
                    procesarCodigo(codigo.data);
                }
            }
        }
        if (escaneando) requestAnimationFrame(loopEscaneo);
    }

    async function iniciarCamara() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
            video.srcObject = stream;
            await video.play();
            escaneando = true;
            requestAnimationFrame(loopEscaneo);
        } catch (error) {
            mostrarEstado('❌ No se pudo acceder a la cámara: ' + error.message, '#c0392b');
        }
    }

    // --- Arranque ---
    async function iniciar() {
        db = await abrirDb();
        await actualizarContadorPendientes();
        await refrescarCacheDeTickets();
        mostrarEstado('Listo para escanear', '#34495e');
        iniciarCamara();

        window.addEventListener('online', () => {
            refrescarCacheDeTickets();
            sincronizarPendientes();
        });
        setInterval(sincronizarPendientes, 20000); // red de seguridad si 'online' no llega a disparar

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw-guardia.js');
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data?.tipo === 'SINCRONIZAR_PENDIENTES') sincronizarPendientes();
            });
        }
    }

    iniciar();
})();
