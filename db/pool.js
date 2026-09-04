const mysql = require('mysql2/promise');
const { MYSQL_URL } = require('../config/env');

// Límites explícitos (no confiar en los defaults de la librería): Railway cobra/limita por
// cantidad de conexiones simultáneas a MySQL, y sin un tope acá un pico de tráfico podría
// abrir conexiones sin freno hasta que la base las rechace y el server empiece a tirar errores.
//   - connectionLimit: tope duro de conexiones simultáneas de ESTE pool.
//   - waitForConnections: si ya se usaron las 10, un pedido nuevo ESPERA en cola en vez de
//     fallar al toque (más lento en el pico, pero no se cae).
//   - queueLimit: 0 = cola sin límite de tamaño (nunca rechaza un pedido por "demasiados
//     esperando" — solo van a esperar más si el pico es grande).
const pool = mysql.createPool({
    uri: MYSQL_URL,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
});

// Aviso temprano de que el pool se está quedando sin conexiones libres: el evento 'enqueue'
// se dispara cada vez que un pedido tiene que ESPERAR porque las 10 conexiones ya están
// ocupadas. Si esto aparece seguido en los logs de Railway, es la señal de subir
// connectionLimit o de que hay alguna query lenta reteniendo conexiones más de la cuenta.
pool.on('enqueue', () => {
    console.warn('[MySQL pool] Sin conexiones libres — un pedido quedó en cola esperando una (connectionLimit: 10).');
});

// express-mysql-session necesita una conexión "estilo callback" (no la de promesas de arriba),
// por eso se crea aparte solo para guardar las sesiones de login. Se le da un límite más chico
// porque su carga es liviana (solo lee/escribe la sesión) — así entre los dos pools no se
// pasan del total de conexiones que Railway permite para la base.
const poolCallback = require('mysql2').createPool({
    uri: MYSQL_URL,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 0
});
poolCallback.on('enqueue', () => {
    console.warn('[MySQL pool de sesiones] Sin conexiones libres — un pedido quedó en cola esperando una (connectionLimit: 5).');
});

// Agrega una columna a una tabla solo si todavía no existe (idempotente, corre en cada arranque).
async function agregarColumnaSiNoExiste(tabla, columna, definicion) {
    const [filas] = await pool.query(
        `SELECT COUNT(*) AS existe FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tabla, columna]
    );
    if (filas[0].existe === 0) {
        await pool.query(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
        console.log(`Columna agregada: ${tabla}.${columna}`);
    }
}

// Agrega un índice a una tabla solo si todavía no existe (idempotente, corre en cada arranque).
async function agregarIndiceSiNoExiste(tabla, nombreIndice, definicionColumnas) {
    const [filas] = await pool.query(
        `SELECT COUNT(*) AS existe FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [tabla, nombreIndice]
    );
    if (filas[0].existe === 0) {
        await pool.query(`CREATE INDEX ${nombreIndice} ON ${tabla} (${definicionColumnas})`);
        console.log(`Índice agregado: ${tabla}.${nombreIndice}`);
    }
}

async function inicializarDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        telefono VARCHAR(50),
        password_hash VARCHAR(255) NOT NULL,
        rol VARCHAR(20) NOT NULL DEFAULT 'organizador',
        email_verificado TINYINT(1) NOT NULL DEFAULT 0,
        token_verificacion VARCHAR(64),
        aprobado TINYINT(1) NOT NULL DEFAULT 0,
        token_aprobacion VARCHAR(64),
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS eventos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        fecha VARCHAR(100),
        flyer_url VARCHAR(500) DEFAULT '/flyer.png',
        valor_entrada DECIMAL(10,2) NOT NULL DEFAULT 0,
        tarifa_online DECIMAL(10,2) NOT NULL DEFAULT 0,
        token_informe VARCHAR(64) NOT NULL,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tipos de entrada por evento (General, VIP, etc.), cada uno con su propio precio y cupo.
    // cupo_vendido se incrementa DENTRO de la misma transacción que inserta los tickets
    // (ver db/tickets.js), usando SELECT ... FOR UPDATE para que dos compras simultáneas
    // nunca puedan vender más entradas que las que había disponibles (evita sobreventa).
    await pool.query(`CREATE TABLE IF NOT EXISTS tipos_entrada (
        id INT AUTO_INCREMENT PRIMARY KEY,
        evento_id INT NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        descripcion VARCHAR(500),
        precio DECIMAL(10,2) NOT NULL DEFAULT 0,
        cupo_total INT NOT NULL,
        cupo_vendido INT NOT NULL DEFAULT 0,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
    )`);

    // id: VARCHAR(40) porque ahora guarda el código firmado ("EVT-XXXXXXXX.firma16hex"),
    // no solo el código plano — ver services/firmaTickets.js.
    await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(40) PRIMARY KEY,
        evento_id INT NOT NULL,
        tipo_entrada_id INT NULL,
        email VARCHAR(255) NOT NULL,
        estado VARCHAR(20) DEFAULT 'Válida',
        fecha_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id),
        FOREIGN KEY (tipo_entrada_id) REFERENCES tipos_entrada(id)
    )`);

    // Cada pago de Mercado Pago se procesa UNA sola vez (payment_id único), para no
    // duplicar entradas ni mails si /success se carga más de una vez.
    await pool.query(`CREATE TABLE IF NOT EXISTS compras (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payment_id VARCHAR(50) NOT NULL UNIQUE,
        evento_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        cantidad INT NOT NULL,
        monto_total DECIMAL(10,2) NOT NULL,
        fecha_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
    )`);

    // Migración: columnas del sistema de Marketplace/OAuth y de comisión real post-pago.
    // Se agregan solas si la tabla ya existía de antes (no rompe instalaciones previas).
    await agregarColumnaSiNoExiste('eventos', 'descripcion', 'TEXT');
    await agregarColumnaSiNoExiste('eventos', 'organizer_email', 'VARCHAR(255)');
    await agregarColumnaSiNoExiste('eventos', 'mp_access_token', 'VARCHAR(255)');
    await agregarColumnaSiNoExiste('eventos', 'mp_refresh_token', 'VARCHAR(255)');
    await agregarColumnaSiNoExiste('eventos', 'mp_user_id', 'VARCHAR(50)');
    await agregarColumnaSiNoExiste('eventos', 'conectado_mp', 'TINYINT(1) NOT NULL DEFAULT 0');
    await agregarColumnaSiNoExiste('eventos', 'comision_mp_pct', 'DECIMAL(5,2)');
    await agregarColumnaSiNoExiste('eventos', 'comision_propia_pct', 'DECIMAL(5,2)');
    await agregarColumnaSiNoExiste('compras', 'comision_mp_real', 'DECIMAL(10,2)');
    await agregarColumnaSiNoExiste('compras', 'monto_neto_organizador', 'DECIMAL(10,2)');

    // Migración: dueño del evento (login) + link encriptado de guardia por evento (ya no es
    // una sola clave global — cada evento tiene la suya, y solo el dueño/admin la puede ver).
    await agregarColumnaSiNoExiste('eventos', 'usuario_id', 'INT');
    await agregarColumnaSiNoExiste('eventos', 'guardia_token', 'VARCHAR(64)');

    // Migración: datos del comprador y trazabilidad de cada ticket para el listado de ventas.
    await agregarColumnaSiNoExiste('tickets', 'nombre_apellido', 'VARCHAR(255)');
    await agregarColumnaSiNoExiste('tickets', 'fecha_escaneada', 'DATETIME NULL');
    await agregarColumnaSiNoExiste('tickets', 'payment_id', 'VARCHAR(50)');
    // NO único: una compra de N entradas guarda N filas con el MISMO payment_id a propósito.
    // La idempotencia real es el UNIQUE de compras.payment_id (ver CREATE TABLE compras arriba);
    // este índice solo acelera el JOIN de listadoVentas (db/eventos.js) por payment_id.
    await agregarIndiceSiNoExiste('tickets', 'idx_tickets_payment_id', 'payment_id');

    // Índices para que el escaneo en la puerta (y los reportes por evento) sean rápidos.
    // El lookup del validador por `id` ya es óptimo solo, porque `id` es PRIMARY KEY.
    await agregarIndiceSiNoExiste('tickets', 'idx_tickets_evento_id', 'evento_id');
    await agregarIndiceSiNoExiste('tickets', 'idx_tickets_estado', 'estado');
    await agregarIndiceSiNoExiste('tickets', 'idx_tickets_evento_estado', 'evento_id, estado');

    // Migración: recuperación de contraseña.
    await agregarColumnaSiNoExiste('usuarios', 'reset_token', 'VARCHAR(64)');
    await agregarColumnaSiNoExiste('usuarios', 'reset_expira', 'DATETIME NULL');

    // Migración: tipos de entrada (General/VIP) + cierre automático de ventas por fecha límite.
    await agregarColumnaSiNoExiste('tickets', 'tipo_entrada_id', 'INT NULL');
    await agregarColumnaSiNoExiste('eventos', 'fecha_cierre_ventas', 'DATETIME NULL');

    // Migración: entradas de cortesía (no pasan por Mercado Pago ni descuentan cupo pago).
    await agregarColumnaSiNoExiste('tickets', 'origen', "VARCHAR(20) NOT NULL DEFAULT 'compra'");

    // Migración: los IDs de entrada ahora vienen firmados (más largos que antes) — agranda
    // la columna si la tabla ya existía de una instalación previa a esto. Es idempotente:
    // si ya está en VARCHAR(40) o más, MySQL no hace nada.
    await pool.query(`ALTER TABLE tickets MODIFY COLUMN id VARCHAR(40) NOT NULL`);

    console.log('Base de datos MySQL lista (usuarios + eventos + tipos_entrada + tickets + compras).');
}

module.exports = { pool, poolCallback, inicializarDB, agregarColumnaSiNoExiste };
