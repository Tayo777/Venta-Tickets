const env = require('./config/env'); // valida variables de entorno al arrancar

const express = require('express');
const cookieParser = require('cookie-parser');
const { inicializarDB } = require('./db/pool');

const app = express();

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());

// Rutas, organizadas por área (ver carpeta /routes)
app.use(require('./routes/landing'));
app.use(require('./routes/organizador'));
app.use(require('./routes/pagos'));
app.use(require('./routes/validacion'));
app.use(require('./routes/admin'));

inicializarDB()
    .then(() => {
        app.listen(env.PORT, () => {
            console.log(`Servidor corriendo en el puerto ${env.PORT}`);
        });
    })
    .catch((err) => {
        console.error('Error al inicializar la base de datos:', err.message);
        process.exit(1);
    });
