const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { MYSQL_URL, QR_SECRET_LEGACY } = require('../config/env');
const { OFFSET_MYSQL } = require('../config/tiempo');
const { generarSlugBase } = require('../services/slug');

// Límites explícitos (no confiar en los defaults de la librería): Railway cobra/limita por
// cantidad de conexiones simultáneas a MySQL, y sin un tope acá un pico de tráfico podría
// abrir conexiones sin freno hasta que la base las rechace y el server empiece a tirar errores.
//   - connectionLimit: tope duro de conexiones simultáneas de ESTE pool.
//   - waitForConnections: si ya se usaron las 10, un pedido nuevo ESPERA en cola en vez de
//     fallar al toque (más lento en el pico, pero no se cae).
//   - queueLimit: 0 = cola sin límite de tamaño (nunca rechaza un pedido por "demasiados
//     esperando" — solo van a esperar más si el pico es grande).
//   - timezone: con qué huso interpreta el driver las columnas DATETIME al convertirlas a
//     Date de JS (y al revés). Va junto con el SET time_zone de más abajo: si el driver y el
//     servidor MySQL no coinciden, las fechas se corren de a horas sin que nada falle.
const pool = mysql.createPool({
    uri: MYSQL_URL,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0,
    timezone: OFFSET_MYSQL
});

// Cada conexión nueva arranca fijando el huso de la SESIÓN de MySQL en hora de Argentina.
// Esto es lo que hace que NOW() (fecha_compra, fecha_escaneada) y las funciones de
// agrupación DATE()/HOUR() que usan los gráficos trabajen en hora local y no en UTC.
//
// El evento 'connection' se emite de forma síncrona ANTES de que el pool entregue la conexión
// a quien la pidió, así que este SET queda encolado primero en esa conexión: ninguna query de
// la app puede colarse antes y ejecutarse con el huso viejo.
function fijarZonaHoraria(conexion) {
    conexion.query(`SET time_zone = '${OFFSET_MYSQL}'`, (err) => {
        if (err) console.error('No se pudo fijar la zona horaria de la conexión MySQL:', err.message);
    });
}
pool.on('connection', fijarZonaHoraria);

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
    queueLimit: 0,
    timezone: OFFSET_MYSQL
});
poolCallback.on('connection', fijarZonaHoraria);
poolCallback.on('enqueue', () => {
    console.warn('[MySQL pool de sesiones] Sin conexiones libres — un pedido quedó en cola esperando una (connectionLimit: 5).');
});

// Agrega una columna a una tabla solo si todavía no existe (idempotente, corre en cada arranque).
// Devuelve true si la columna se acaba de crear (false si ya existía) — así un caller puede
// disparar un backfill SOLO la primera vez que la columna aparece, sin repetirlo en cada
// arranque del server.
async function agregarColumnaSiNoExiste(tabla, columna, definicion) {
    const [filas] = await pool.query(
        `SELECT COUNT(*) AS existe FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tabla, columna]
    );
    if (filas[0].existe === 0) {
        await pool.query(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
        console.log(`Columna agregada: ${tabla}.${columna}`);
        return true;
    }
    return false;
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

    // Cupones de descuento. evento_id NULL = cupón global (sirve para cualquier evento);
    // con evento_id seteado, el cupón solo es válido para ESE evento puntual. usos_maximos
    // NULL = sin límite de usos. La validación (existe/activo/no vencido/no agotado) vive en
    // db/cupones.js, se corre ANTES de cobrar (en /crear-pago) — nunca se confía en un
    // descuento calculado del lado del cliente.
    await pool.query(`CREATE TABLE IF NOT EXISTS cupones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        evento_id INT NULL,
        codigo VARCHAR(50) NOT NULL UNIQUE,
        tipo VARCHAR(20) NOT NULL,
        valor DECIMAL(10,2) NOT NULL,
        usos_maximos INT NULL,
        usos_actuales INT NOT NULL DEFAULT 0,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
    )`);

    // A qué tipos de entrada aplica cada cupón. Si un cupón NO tiene ninguna fila acá, aplica
    // a TODOS los tipos del evento (es el default y el caso más común). Se modela aparte y no
    // como una columna en `cupones` porque un mismo cupón puede habilitar varios tipos.
    await pool.query(`CREATE TABLE IF NOT EXISTS cupones_tipos (
        cupon_id INT NOT NULL,
        tipo_entrada_id INT NOT NULL,
        PRIMARY KEY (cupon_id, tipo_entrada_id),
        FOREIGN KEY (cupon_id) REFERENCES cupones(id),
        FOREIGN KEY (tipo_entrada_id) REFERENCES tipos_entrada(id)
    )`);

    // Cuentas de guardia para la app móvil (login por email/password propio, distinto del
    // "modo guardia" del navegador que usa cookie + link compartido). Cada guardia queda
    // atado a UN evento y a UNA fila/puerta puntual.
    await pool.query(`CREATE TABLE IF NOT EXISTS guardias (
        id INT AUTO_INCREMENT PRIMARY KEY,
        evento_id INT NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        fila_asignada INT NOT NULL,
        activo TINYINT(1) NOT NULL DEFAULT 1,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
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

    // Migración: reparto de entradas por fila/guardia (app móvil de seguridad).
    await agregarColumnaSiNoExiste('tickets', 'fila_asignada', 'INT NULL DEFAULT NULL');

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

    // Migración: ubicación del evento (se muestra en la página pública de compra).
    await agregarColumnaSiNoExiste('eventos', 'lugar_nombre', 'VARCHAR(255)');
    await agregarColumnaSiNoExiste('eventos', 'direccion', 'VARCHAR(500)');
    await agregarColumnaSiNoExiste('eventos', 'ciudad', 'VARCHAR(150)');
    await agregarColumnaSiNoExiste('eventos', 'maps_url', 'VARCHAR(500)');

    // Migración: evento finalizado (queda en modo SOLO LECTURA). Es un override manual —
    // un evento también cuenta como finalizado si ya pasó su fecha, sin tocar esta columna
    // (ver eventosDb.eventoFinalizado). Nunca se borra solo: solo el admin puede eliminarlo.
    await agregarColumnaSiNoExiste('eventos', 'finalizado', 'TINYINT(1) NOT NULL DEFAULT 0');

    // Carritos de checkout: guarda QUÉ se está comprando (varios tipos de entrada a la vez,
    // cupón, comprador) contra un token corto. Ese token es lo único que viaja a Mercado Pago
    // como external_reference. Antes se mandaba un JSON con todo adentro, que ya rozaba el
    // límite de 256 chars de ese campo y encima exponía datos del comprador en la pasarela.
    await pool.query(`CREATE TABLE IF NOT EXISTS checkouts (
        token CHAR(32) PRIMARY KEY,
        evento_id INT NOT NULL,
        datos TEXT NOT NULL,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (evento_id) REFERENCES eventos(id)
    )`);

    // Migración: secreto de firma HMAC PROPIO por evento (antes era un único QR_SECRET
    // global en .env). db/eventos.js::crearEvento ya genera uno nuevo con crypto.randomBytes
    // para cada evento que se crea de acá en adelante — esto es el fallback para los eventos
    // que ya existían ANTES de este cambio y todavía no tienen ninguno:
    //   - Si había un QR_SECRET global viejo, se lo copiamos tal cual a esos eventos, para
    //     no invalidar de golpe los QRs que ya se mandaron por mail.
    //   - Si no había ninguno, les generamos uno nuevo — en ese caso puntual, los QRs ya
    //     emitidos de esos eventos específicos van a dejar de validar (no hay forma de
    //     evitarlo sin conocer el secreto viejo).
    await agregarColumnaSiNoExiste('eventos', 'qr_secret', 'VARCHAR(64) NULL');
    const [eventosSinSecret] = await pool.query('SELECT id FROM eventos WHERE qr_secret IS NULL');
    for (const { id } of eventosSinSecret) {
        const secretoFallback = QR_SECRET_LEGACY || crypto.randomBytes(32).toString('hex');
        await pool.query('UPDATE eventos SET qr_secret = ? WHERE id = ?', [secretoFallback, id]);
    }
    if (eventosSinSecret.length > 0) {
        console.log(`qr_secret asignado a ${eventosSinSecret.length} evento/s existente/s${QR_SECRET_LEGACY ? ' (usando el QR_SECRET viejo)' : ' (generado nuevo — sus QRs ya emitidos dejan de validar)'}.`);
    }

    // flyer_delete_url: la URL de borrado que ImgBB devuelve junto con cada imagen subida.
    // Sin guardar esto no hay forma de borrar el flyer viejo cuando el organizador sube uno
    // nuevo (ver services/imgbb.js -> eliminarImagen) y las imágenes reemplazadas quedan
    // acumulándose en ImgBB para siempre. Los eventos creados antes de esta columna
    // simplemente no tienen delete_url guardada — no pasa nada, esa imagen puntual no se va
    // a poder borrar por API, pero tampoco rompe nada (eliminarImagen ignora un valor null).
    await agregarColumnaSiNoExiste('eventos', 'flyer_delete_url', 'VARCHAR(500) NULL');

    // precio_pagado: el precio HISTÓRICO real que pagó cada ticket, congelado al momento de
    // la venta (ver db/tickets.js -> registrarEntradas). Sin esto, la recaudación se calculaba
    // multiplicando por el precio ACTUAL del tipo de entrada — si el organizador sube el
    // precio de General a mitad de evento, las ventas viejas se recalculaban solas para
    // arriba y la recaudación mostrada dejaba de coincidir con la plata real cobrada.
    // Las cortesías se guardan con precio_pagado = 0 (no cobraron nada).
    await agregarColumnaSiNoExiste('tickets', 'precio_pagado', 'DECIMAL(10,2) NULL');
    const [ticketsSinPrecio] = await pool.query(
        `SELECT t.id, t.origen, t.tipo_entrada_id, te.precio AS precio_tipo, e.valor_entrada
         FROM tickets t
         JOIN eventos e ON e.id = t.evento_id
         LEFT JOIN tipos_entrada te ON te.id = t.tipo_entrada_id
         WHERE t.precio_pagado IS NULL`
    );
    for (const t of ticketsSinPrecio) {
        // Backfill de tickets vendidos ANTES de esta columna: es lo más cerca que se puede
        // estar del precio real sin haberlo guardado en su momento (precio del tipo si lo
        // tenía, si no el precio general del evento). De acá en adelante ya no hace falta
        // adivinar: cada venta nueva graba su propio precio_pagado en el momento exacto.
        const precio = t.origen === 'cortesia' ? 0 : Number(t.precio_tipo ?? t.valor_entrada ?? 0);
        await pool.query('UPDATE tickets SET precio_pagado = ? WHERE id = ?', [precio, t.id]);
    }
    if (ticketsSinPrecio.length > 0) {
        console.log(`precio_pagado completado (backfill) en ${ticketsSinPrecio.length} entrada/s existente/s.`);
    }

    // slug: URL amigable pública del evento, formato "tuentradaya-nombre-del-evento" (ver
    // services/slug.js). UNIQUE para poder buscar por slug sin ambigüedad.
    await agregarColumnaSiNoExiste('eventos', 'slug', 'VARCHAR(280) NULL');
    // UNIQUE (no un índice normal): generarSlugUnico() ya resuelve colisiones en la app antes
    // del INSERT, pero esto es la garantía de última línea a nivel de base de datos.
    const [indiceSlug] = await pool.query(
        `SELECT COUNT(*) AS existe FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'eventos' AND INDEX_NAME = 'idx_eventos_slug_unico'`
    );
    if (indiceSlug[0].existe === 0) {
        await pool.query('CREATE UNIQUE INDEX idx_eventos_slug_unico ON eventos (slug)');
        console.log('Índice único agregado: eventos.slug');
    }
    const [eventosSinSlug] = await pool.query('SELECT id, nombre FROM eventos WHERE slug IS NULL');
    for (const evento of eventosSinSlug) {
        // Backfill de eventos creados antes de que existiera el slug: se arma uno a partir del
        // nombre + el propio id (el id ya es único de por sí, así no hace falta la lógica de
        // "agregar -2, -3..." que sí usa la generación en caliente de eventos nuevos).
        const base = generarSlugBase(evento.nombre) || 'evento';
        await pool.query('UPDATE eventos SET slug = ? WHERE id = ?', [`${base}-${evento.id}`, evento.id]);
    }
    if (eventosSinSlug.length > 0) {
        console.log(`slug generado (backfill) para ${eventosSinSlug.length} evento/s existente/s.`);
    }

    // is_admin_accredited: un evento nuevo nace PRIVADO y necesita que un admin lo acredite a
    // mano para hacerse público (ver routes/admin.js), además de que su creador tenga el mail
    // verificado. Los eventos que YA EXISTÍAN antes de este cambio se acreditan solos al
    // agregar la columna (grandfathering) — si no, un evento activo y con entradas ya vendidas
    // desaparecería de golpe de la venta pública el día de este deploy, lo cual sería un
    // cambio de comportamiento mucho más grave que "pedir acreditación a los eventos nuevos".
    const columnaAcreditacionNueva = await agregarColumnaSiNoExiste('eventos', 'is_admin_accredited', 'TINYINT(1) NOT NULL DEFAULT 0');
    if (columnaAcreditacionNueva) {
        const [resultado] = await pool.query('UPDATE eventos SET is_admin_accredited = 1');
        console.log(`is_admin_accredited: ${resultado.affectedRows} evento/s existente/s acreditados automáticamente (grandfathering). Los eventos NUEVOS de acá en más nacen sin acreditar.`);
    }

    // is_admin: flag booleano de administrador. Convive con la columna `rol` que ya existía —
    // para no dejar DOS fuentes de verdad sobre quién es admin (un agujero de seguridad
    // clásico: revocás una y la otra sigue abierta), se sincroniza en los dos sentidos en cada
    // arranque, y el middleware isAdmin acepta cualquiera de las dos como válida.
    const columnaAdminNueva = await agregarColumnaSiNoExiste('usuarios', 'is_admin', 'TINYINT(1) NOT NULL DEFAULT 0');
    if (columnaAdminNueva) {
        const [r] = await pool.query("UPDATE usuarios SET is_admin = 1 WHERE rol = 'admin'");
        console.log(`is_admin activado en ${r.affectedRows} usuario/s que ya tenían rol = 'admin'.`);
    }
    // Y al revés: si alguien puso is_admin = 1 a mano en la base, que su rol acompañe. Así las
    // dos columnas nunca quedan contradiciéndose.
    await pool.query("UPDATE usuarios SET rol = 'admin' WHERE is_admin = 1 AND rol <> 'admin'");

    console.log('Base de datos MySQL lista (usuarios + eventos + tipos_entrada + tickets + compras + cupones + guardias).');
}

module.exports = { pool, poolCallback, inicializarDB, agregarColumnaSiNoExiste };
