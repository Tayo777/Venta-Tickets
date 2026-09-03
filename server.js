const env = require('./config/env'); // valida variables de entorno al arrancar

const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const { pool, poolCallback, inicializarDB } = require('./db/pool');
const { asegurarAdminSemilla } = require('./db/usuarios');

const app = express();

// Cabeceras de seguridad básicas (XSS, sniffing, clickjacking, etc.)
app.use(helmet({ contentSecurityPolicy: false })); // CSP desactivada: la app usa estilos/scripts inline en las vistas

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());

// Sesiones guardadas en la misma base MySQL (no se pierden en cada redeploy de Railway).
const sessionStore = new MySQLStore({}, poolCallback);
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

// Rutas, organizadas por área (ver carpeta /routes)
app.use(require('./routes/landing'));
app.use(require('./routes/auth'));
app.use(require('./routes/organizador'));
app.use(require('./routes/pagos'));
app.use(require('./routes/validacion'));
app.use(require('./routes/admin'));

inicializarDB()
    .then(() => asegurarAdminSemilla())
    .then(() => {
        app.listen(env.PORT, () => {
            console.log(`Servidor corriendo en el puerto ${env.PORT}`);
        });
    })
    .catch((err) => {
        console.error('Error al inicializar la base de datos:', err.message);
        process.exit(1);
    });
