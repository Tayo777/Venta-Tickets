const mysql = require('mysql2/promise');
const { MYSQL_URL } = require('../config/env');

const pool = mysql.createPool(MYSQL_URL);

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

    await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(20) PRIMARY KEY,
        evento_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        estado VARCHAR(20) DEFAULT 'Válida',
        fecha_compra DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
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

    console.log('Base de datos MySQL lista (eventos + tickets + compras, con Marketplace/OAuth).');
}

module.exports = { pool, inicializarDB };
