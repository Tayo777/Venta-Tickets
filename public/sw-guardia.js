// Service Worker del modo guardia. Cachea el "app shell" (la página del scanner + sus
// scripts) para que abra igual sin señal. La data (tickets/validaciones) NO se maneja acá
// sino en IndexedDB desde guardia-cliente.js — el SW solo se ocupa de los archivos estáticos.
const CACHE_NAME = 'guardia-shell-v1';
const ARCHIVOS_APP_SHELL = [
    '/guardia-cliente.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'
];

// La primera vez que el guardia abre la página CON internet, se precachea todo. Si esa
// primera carga falla (sin red todavía), el SW no se instala — hace falta abrir la página
// al menos una vez conectado antes del evento.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((nombres) =>
            Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        )
    );
    self.clients.claim();
});

// Estrategia: cache-first para el app shell (nunca depende de la red una vez cacheado).
// Las llamadas a /api/guardia/* NO se cachean acá: van directo a la red y, si fallan,
// el propio guardia-cliente.js decide qué hacer (leer/escribir en IndexedDB).
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/guardia/')) return; // deja pasar, no intercepta la API

    event.respondWith(
        caches.match(event.request).then((cacheada) => {
            if (cacheada) return cacheada;
            return fetch(event.request).then((respuesta) => {
                // Cachea también la página del scanner (navegación) para que la próxima
                // apertura offline funcione aunque no se haya listado arriba explícitamente.
                if (event.request.method === 'GET' && respuesta.ok) {
                    const copia = respuesta.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
                }
                return respuesta;
            });
        })
    );
});

// Background Sync: soporte parcial (no existe en Safari/iOS), por eso es un EXTRA y no la
// única vía de sincronización — el guardia-cliente.js igual reintenta solo con el evento
// 'online' del navegador y un polling periódico mientras la página está abierta.
self.addEventListener('sync', (event) => {
    if (event.tag !== 'sync-validaciones-guardia') return;
    event.waitUntil(
        self.clients.matchAll().then((clientes) => {
            clientes.forEach((cliente) => cliente.postMessage({ tipo: 'SINCRONIZAR_PENDIENTES' }));
        })
    );
});
