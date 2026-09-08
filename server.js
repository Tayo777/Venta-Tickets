// Huso horario del proceso, ANTES de cargar cualquier otra cosa: Node lee process.env.TZ una
// sola vez, así que si esto queda más abajo (o dentro de un require) no tiene efecto. Sin
// esto, Railway corre en UTC y todas las fechas se muestran 3 horas adelantadas.
const { ZONA_HORARIA } = require('./config/tiempo');
process.env.TZ = ZONA_HORARIA;

const env = require('./config/env'); // valida variables de entorno al arrancar

const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const { pool, poolCallback, inicializarDB } = require('./db/pool');
const { asegurarAdminSemilla } = require('./db/usuarios');
const { iniciarReconciliacionPeriodica } = require('./services/reconciliarPagos');

const app = express();

// Railway corre la app detrás de un proxy — sin esto, Express puede confundirse con
// las cabeceras de conexión segura y las cookies de sesión no se guardan bien.
app.set('trust proxy', 1);

// Cabeceras de seguridad básicas (XSS, sniffing, clickjacking, etc.)
app.use(helmet({ contentSecurityPolicy: false })); // CSP desactivada: la app usa estilos/scripts inline en las vistas

app.set('view engine', 'ejs');
// Formatea evento.fecha para mostrar (ahora se guarda en formato datetime-local desde el
// calendario del form). Si es un evento viejo con texto libre no parseable, lo muestra tal cual.
app.locals.formatearFecha = (fecha) => {
    const d = new Date(fecha);
    if (isNaN(d)) return fecha;
    // timeZone explícita: no alcanza con process.env.TZ si algún día el proceso corre en otro
    // lado (un cron, otra máquina). Así la fecha que ve el organizador es siempre la de Argentina.
    return d.toLocaleString('es-AR', {
        timeZone: ZONA_HORARIA,
        weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
};

// Fecha + hora corta para las tablas del panel (compra y escaneo). Misma zona horaria que
// formatearFecha; devuelve '—' para las entradas que todavía no se escanearon.
app.locals.formatearFechaHora = (fecha) => {
    if (!fecha) return '—';
    const d = new Date(fecha);
    if (isNaN(d)) return fecha;
    return d.toLocaleString('es-AR', {
        timeZone: ZONA_HORARIA,
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
};
// Link público de descarga del APK de la app de guardias. Vive acá (y no hardcodeado en la
// vista) para que el botón de descarga y el de "Copiar link" no puedan quedar apuntando a
// lugares distintos, y para cambiarlo en un solo lugar cuando haya Play Store.
app.locals.URL_APK_GUARDIAS = 'https://drive.google.com/file/d/1GqYema6b3oEHXcrWCLdWP3YH8oOh1l2i/view?usp=sharing';

// Porcentaje del cargo por servicio, disponible en TODAS las vistas. Sale del mismo lugar que
// usa el cálculo real (services/mercadopago.js) para que ninguna pantalla muestre un "4%"
// escrito a mano que después no coincida con lo que se cobra.
app.locals.TARIFA_SERVICIO_PCT = env.TARIFA_SERVICIO_PCT;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());

// Sesiones guardadas en la misma base MySQL (no se pierden en cada redeploy de Railway).
const sessionStore = new MySQLStore({}, poolCallback);
sessionStore.on('error', (err) => {
    console.error('Error en el session store (MySQL):', err);
});
app.use(session({
    secret: env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
        httpOnly: true,
        sameSite: 'lax', // mitiga CSRF básico
        secure: env.BASE_URL.startsWith('https')
    }
}));

// Expone la sesión a TODAS las vistas automáticamente (sin que cada ruta tenga que acordarse
// de pasar usuarioLogueado/usuarioNombre a mano) — así el navbar global sabe siempre si hay
// alguien logueado y cómo se llama, se renderice la vista que se renderice.
app.use((req, res, next) => {
    res.locals.usuarioLogueado = Boolean(req.session.usuarioId);
    res.locals.usuarioNombre = req.session.nombre || null;
    // Solo decide qué atajos de administración se DIBUJAN (el link del navbar, el botón de
    // acreditar). Las rutas de admin están protegidas aparte por el middleware isAdmin.
    res.locals.esAdminLogueado = Boolean(req.session.esAdmin || req.session.rol === 'admin');
    next();
});

// Las páginas dinámicas no se cachean NUNCA. Va después de express.static, así que los
// assets (CSS, imágenes, el APK) siguen cacheándose normal — esto aplica solo al HTML.
//
// Por qué: sin esto, el navegador se guarda la página de compra y te la vuelve a mostrar
// más tarde. Eso trae dos problemas reales:
//   1. Después de un deploy, alguien puede seguir usando el formulario VIEJO (fue exactamente
//      la causa del checkout que fallaba de forma intermitente, y por qué "volver atrás y
//      adelante" lo arreglaba: forzaba a pedir la página de nuevo).
//   2. Muestra cupos y precios desactualizados, que en esta app cambian todo el tiempo.
//
// Safari en iOS es el más agresivo guardando estas copias (bfcache), por eso ahí se notaba más.
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// Rutas, organizadas por área (ver carpeta /routes)
app.use(require('./routes/landing'));
app.use(require('./routes/auth'));
app.use(require('./routes/organizador'));
app.use(require('./routes/perfil'));
app.use(require('./routes/pagos'));
app.use(require('./routes/webhooks'));
app.use(require('./routes/validacion'));
app.use(require('./routes/appApi'));
app.use(require('./routes/admin'));

inicializarDB()
    .then(() => asegurarAdminSemilla())
    .then(() => {
        app.listen(env.PORT, () => {
            console.log(`Servidor corriendo en el puerto ${env.PORT}`);
        });
        iniciarReconciliacionPeriodica();
    })
    .catch((err) => {
        console.error('Error al inicializar la base de datos:', err.message);
        process.exit(1);
    });
