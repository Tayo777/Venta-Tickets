Poné acá el archivo app-guardias.apk (el build de la app móvil de guardias).

La ruta pública queda en:
  /downloads/app-guardias.apk

...porque express.static ya sirve todo lo que esté dentro de la carpeta /public sin
configuración adicional (ver server.js -> app.use(express.static('public'))).

Este es un lugar temporal para distribuir el APK directo por link (como pide la tarjeta
"App para Guardias" del panel del organizador). Cuando tengas una Play Store / distribución
más seria, cambiá el href de esa tarjeta en views/evento-detalle.ejs.
