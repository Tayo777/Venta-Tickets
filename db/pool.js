const mysql = require('mysql2/promise');
const { MYSQL_URL } = require('../config/env');

const pool = mysql.createPool(MYSQL_URL);

// express-mysql-session necesita una conexión "estilo callback" (no la de promesas de arriba),
// por eso se crea aparte solo para guardar las sesiones de login.
const poolCallback = require('mysql2').createPool(MYSQL_URL);

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

    await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(20) PRIMARY KEY,
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

    // Migración: recuperación de contraseña.
    await agregarColumnaSiNoExiste('usuarios', 'reset_token', 'VARCHAR(64)');
    await agregarColumnaSiNoExiste('usuarios', 'reset_expira', 'DATETIME NULL');

    // Migración: tipos de entrada (General/VIP) + cierre automático de ventas por fecha límite.
    await agregarColumnaSiNoExiste('tickets', 'tipo_entrada_id', 'INT NULL');
    await agregarColumnaSiNoExiste('eventos', 'fecha_cierre_ventas', 'DATETIME NULL');

    // Migración: entradas de cortesía (no pasan por Mercado Pago ni descuentan cupo pago).
    await agregarColumnaSiNoExiste('tickets', 'origen', "VARCHAR(20) NOT NULL DEFAULT 'compra'");

    console.log('Base de datos MySQL lista (usuarios + eventos + tipos_entrada + tickets + compras).');
}

module.exports = { pool, poolCallback, inicializarDB, agregarColumnaSiNoExiste };
