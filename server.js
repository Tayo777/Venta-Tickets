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
    return d.toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
};
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
    next();
});

// Rutas, organizadas por área (ver carpeta /routes)
app.use(require('./routes/landing'));
app.use(require('./routes/auth'));
app.use(require('./routes/organizador'));
app.use(require('./routes/perfil'));
app.use(require('./routes/pagos'));
app.use(require('./routes/validacion'));
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
