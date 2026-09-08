const crypto = require('crypto');
const { pool } = require('./pool');
const { generarSlugBase } = require('../services/slug');

// Eventos que se listan en la venta pública (/eventos). Tienen que cumplir TODO:
//   - activo = 1 (ya conectó Mercado Pago).
//   - is_admin_accredited = 1: un admin lo acreditó a mano (ver routes/admin.js).
//   - el creador tiene el mail verificado.
// Sin las últimas dos, el evento existe y su dueño lo puede administrar (ver obtenerEvento),
// pero queda PRIVADO: no aparece acá ni es accesible por su link público (ver routes/landing.js).
async function obtenerEventosActivos() {
    const [filas] = await pool.query(
        `SELECT e.* FROM eventos e
         JOIN usuarios u ON u.id = e.usuario_id
         WHERE e.activo = 1 AND e.is_admin_accredited = 1 AND u.email_verificado = 1
         ORDER BY e.id DESC`
    );
    return filas;
}

// true si el evento cumple las dos condiciones de visibilidad pública (acreditado por un
// admin + creador con mail verificado) — se usa para decidir si mostrarlo en /evento/:slug y
// para armar el banner de "por qué todavía no es público" en el panel del organizador.
// `emailVerificadoCreador` viaja aparte porque no siempre está en la fila de `eventos` (hay
// que traerlo con un JOIN a usuarios).
function eventoEsPublico(evento, emailVerificadoCreador) {
    return Boolean(evento.is_admin_accredited) && Boolean(emailVerificadoCreador);
}

// Arma un slug único con el formato pedido: "tuentradaya-nombre-del-evento". Si ya existe uno
// igual (dos eventos con el mismo nombre, por ejemplo) le agrega "-2", "-3", etc. hasta
// encontrar uno libre — la columna eventos.slug es UNIQUE, así que esto evita el ER_DUP_ENTRY
// en vez de dejar que la INSERT falle.
async function generarSlugUnico(nombre) {
    const base = `tuentradaya-${generarSlugBase(nombre) || 'evento'}`;
    let candidato = base;
    let sufijo = 2;
    while (true) {
        const [filas] = await pool.query('SELECT id FROM eventos WHERE slug = ?', [candidato]);
        if (filas.length === 0) return candidato;
        candidato = `${base}-${sufijo}`;
        sufijo++;
    }
}

async function obtenerEventoPorSlug(slug) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE slug = ?', [slug]);
    return filas[0] || null;
}

// Eventos con Mercado Pago conectado (tienen access_token propio), para el job de
// reconciliación: hay que consultar la cuenta de CADA organizador por separado.
async function obtenerEventosConectados() {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE conectado_mp = 1 AND mp_access_token IS NOT NULL');
    return filas;
}

async function obtenerTodos() {
    const [filas] = await pool.query('SELECT e.*, u.email AS dueño_email FROM eventos e LEFT JOIN usuarios u ON e.usuario_id = u.id ORDER BY e.id DESC');
    return filas;
}

async function obtenerEventosDeUsuario(usuarioId) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE usuario_id = ? ORDER BY id DESC', [usuarioId]);
    return filas;
}

async function obtenerEvento(id) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE id = ?', [id]);
    return filas[0] || null;
}

async function obtenerEventoPorToken(token) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE token_informe = ?', [token]);
    return filas[0] || null;
}

async function obtenerEventoPorGuardiaToken(token) {
    const [filas] = await pool.query('SELECT * FROM eventos WHERE guardia_token = ?', [token]);
    return filas[0] || null;
}

// Crea un evento nuevo, siempre atado a un usuario (usuarioId) que es su dueño.
async function crearEvento({ usuarioId, nombre, descripcion, fecha, flyerUrl, flyerDeleteUrl, valorEntrada, tarifaOnline,
                              organizerEmail, comisionMpPct, comisionPropiaPct, fechaCierreVentas,
                              lugarNombre, direccion, ciudad, mapsUrl }) {
    const token = crypto.randomBytes(16).toString('hex');
    const guardiaToken = crypto.randomBytes(16).toString('hex');
    // Secreto de firma HMAC PROPIO de este evento (ver services/firmaTickets.js) — cada
    // evento tiene el suyo, generado acá, nunca compartido entre eventos ni con un .env global.
    const qrSecret = crypto.randomBytes(32).toString('hex');
    // Slug público ("tuentradaya-nombre-del-evento") — se resuelve ANTES del INSERT (necesita el
    // nombre, que ya tenemos, y no depende del id todavía inexistente).
    const slug = await generarSlugUnico(nombre);
    // Nace PRIVADO a propósito (is_admin_accredited = 0 por default de columna): recién se
    // hace público cuando un admin lo acredita Y el creador verificó su mail — ver
    // eventoEsPublico() y el banner en routes/organizador.js -> datosPanel().
    const [resultado] = await pool.query(
        `INSERT INTO eventos
            (usuario_id, nombre, descripcion, fecha, flyer_url, flyer_delete_url, slug, valor_entrada, tarifa_online, token_informe,
             guardia_token, qr_secret, organizer_email, comision_mp_pct, comision_propia_pct, fecha_cierre_ventas,
             lugar_nombre, direccion, ciudad, maps_url, activo, conectado_mp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [usuarioId, nombre, descripcion || null, fecha || null, flyerUrl || '/flyer.png', flyerDeleteUrl || null, slug,
         valorEntrada, tarifaOnline, token, guardiaToken, qrSecret, organizerEmail || null, comisionMpPct,
         comisionPropiaPct, fechaCierreVentas || null, lugarNombre || null, direccion || null, ciudad || null, mapsUrl || null]
    );
    return { id: resultado.insertId, token, slug };
}

// El admin acredita (o desacredita) un evento a mano desde /admin — es una de las dos
// condiciones para que se haga público (ver eventoEsPublico).
async function acreditarEvento(id, acreditado) {
    await pool.query('UPDATE eventos SET is_admin_accredited = ? WHERE id = ?', [acreditado ? 1 : 0, id]);
}

async function editarEvento(id, { nombre, descripcion, fecha, flyerUrl, flyerDeleteUrl, valorEntrada, fechaCierreVentas,
                                   lugarNombre, direccion, ciudad, mapsUrl }) {
    await pool.query(
        `UPDATE eventos SET nombre = ?, descripcion = ?, fecha = ?, flyer_url = ?, flyer_delete_url = ?, valor_entrada = ?,
            fecha_cierre_ventas = ?, lugar_nombre = ?, direccion = ?, ciudad = ?, maps_url = ?
         WHERE id = ?`,
        [nombre, descripcion, fecha, flyerUrl, flyerDeleteUrl || null, valorEntrada, fechaCierreVentas || null,
         lugarNombre || null, direccion || null, ciudad || null, mapsUrl || null, id]
    );
}

// Un evento cuenta como FINALIZADO si el organizador/admin lo marcó a mano, o si ya pasó su
// fecha. Los finalizados quedan en modo solo lectura: se pueden mirar (estadísticas, ventas,
// historial) pero no modificar, y solo el admin los puede borrar de la base.
function eventoFinalizado(evento) {
    if (!evento) return false;
    if (evento.finalizado) return true;
    const fecha = new Date(evento.fecha);
    return !isNaN(fecha) && fecha < new Date();
}

// Separa una lista de eventos en las dos secciones que muestra el panel.
function separarPorEstado(eventos) {
    return {
        activos: eventos.filter((e) => !eventoFinalizado(e)),
        finalizados: eventos.filter((e) => eventoFinalizado(e))
    };
}

async function marcarFinalizado(id, finalizado) {
    await pool.query('UPDATE eventos SET finalizado = ? WHERE id = ?', [finalizado ? 1 : 0, id]);
}

// Borra el evento y todo lo que depende de él (transacción: o se borra todo, o nada).
async function eliminarEvento(id) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        await conexion.query('DELETE FROM tickets WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM compras WHERE evento_id = ?', [id]);
        // cupones_tipos apunta a cupones Y a tipos_entrada, así que se borra antes que los dos.
        await conexion.query(
            'DELETE ct FROM cupones_tipos ct JOIN cupones c ON c.id = ct.cupon_id WHERE c.evento_id = ?',
            [id]
        );
        await conexion.query('DELETE FROM tipos_entrada WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM cupones WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM guardias WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM checkouts WHERE evento_id = ?', [id]);
        await conexion.query('DELETE FROM eventos WHERE id = ?', [id]);
        await conexion.commit();
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
}

// Guarda las credenciales de Mercado Pago del organizador tras el OAuth y activa el evento.
async function conectarMercadoPago(id, { accessToken, refreshToken, userId }) {
    await pool.query(
        `UPDATE eventos SET mp_access_token = ?, mp_refresh_token = ?, mp_user_id = ?, conectado_mp = 1, activo = 1 WHERE id = ?`,
        [accessToken, refreshToken, userId, id]
    );
}

async function toggleActivo(id) {
    await pool.query('UPDATE eventos SET activo = NOT activo WHERE id = ?', [id]);
}

// La venta de un evento se cierra sola cuando pasó su fecha_cierre_ventas (si tiene una
// configurada). El cierre por capacidad se resuelve aparte, en tiposEntrada.eventoAgotado,
// porque depende del cupo de cada tipo de entrada (no de una columna del evento).
function ventaVencidaPorTiempo(evento) {
    return Boolean(evento.fecha_cierre_ventas) && new Date(evento.fecha_cierre_ventas) <= new Date();
}

// Métricas del panel. Regla clave: las CORTESÍAS no son plata.
//   - total_vendidas / total_compradores / recaudacion cuentan SOLO entradas pagas.
//   - total_cortesias va aparte, en su propio cuadro, para que se vea cuántas se regalaron
//     sin que eso infle la recaudación ni las ganancias.
//   - total_ingresadas sí incluye cortesías: en la puerta entra gente, no dinero.
//
// La recaudación se suma con tickets.precio_pagado, el precio HISTÓRICO que se congeló en
// cada ticket al momento de venderse (ver db/tickets.js -> registrarEntradas), NO el precio
// actual del tipo de entrada. Si se usara el precio actual, subir el valor de "General" a
// mitad de evento recalcularía para arriba las ventas viejas y la recaudación mostrada
// dejaría de coincidir con la plata que realmente entró.
async function resumenVentas(eventoId) {
    const [[resumen]] = await pool.query(
        `SELECT
            COUNT(*) AS total_entradas,
            SUM(CASE WHEN t.origen = 'cortesia' THEN 0 ELSE 1 END) AS total_vendidas,
            SUM(CASE WHEN t.origen = 'cortesia' THEN 1 ELSE 0 END) AS total_cortesias,
            SUM(CASE WHEN t.estado = 'Usada' THEN 1 ELSE 0 END) AS total_ingresadas,
            COUNT(DISTINCT CASE WHEN t.origen = 'cortesia' THEN NULL ELSE t.email END) AS total_compradores,
            COALESCE(SUM(CASE WHEN t.origen = 'cortesia' THEN 0 ELSE t.precio_pagado END), 0) AS recaudacion
         FROM tickets t
         WHERE t.evento_id = ?`,
        [eventoId]
    );

    // MySQL devuelve los SUM/COUNT como string o null segun el driver y si la tabla esta
    // vacia; se normaliza acá para que las vistas no tengan que hacer || 0 en cada card.
    const num = (v) => Number(v) || 0;
    return {
        total_entradas: num(resumen.total_entradas),
        total_vendidas: num(resumen.total_vendidas),
        total_cortesias: num(resumen.total_cortesias),
        total_ingresadas: num(resumen.total_ingresadas),
        total_compradores: num(resumen.total_compradores),
        recaudacion: num(resumen.recaudacion)
    };
}

// Desglose de ventas por tipo de entrada (General, VIP, etc.) para el panel: cuántas se
// vendieron de cada una, cuántas fueron cortesía, y el subtotal recaudado (con el mismo
// precio_pagado histórico de arriba, no el precio actual del tipo). Los tipos ya borrados
// o inactivos también aparecen si tienen ventas — solo se excluyen si nunca vendieron nada.
async function desgloseVentasPorTipo(eventoId) {
    const [filas] = await pool.query(
        `SELECT
            COALESCE(te.id, 0) AS tipo_id,
            COALESCE(te.nombre, 'Sin tipo asignado') AS tipo_nombre,
            SUM(CASE WHEN t.origen = 'cortesia' THEN 0 ELSE 1 END) AS vendidas,
            SUM(CASE WHEN t.origen = 'cortesia' THEN 1 ELSE 0 END) AS cortesias,
            COALESCE(SUM(CASE WHEN t.origen = 'cortesia' THEN 0 ELSE t.precio_pagado END), 0) AS subtotal
         FROM tickets t
         LEFT JOIN tipos_entrada te ON te.id = t.tipo_entrada_id
         WHERE t.evento_id = ?
         GROUP BY COALESCE(te.id, 0), COALESCE(te.nombre, 'Sin tipo asignado')
         ORDER BY tipo_nombre`,
        [eventoId]
    );
    return filas.map((f) => ({
        tipoId: f.tipo_id,
        tipoNombre: f.tipo_nombre,
        vendidas: Number(f.vendidas) || 0,
        cortesias: Number(f.cortesias) || 0,
        subtotal: Number(f.subtotal) || 0
    }));
}

// Listado de ventas con las columnas pedidas para el panel del organizador/admin.
async function listadoVentas(eventoId) {
    const [filas] = await pool.query(
        `SELECT
            c.id AS id_cliente,
            t.nombre_apellido AS nom_y_apellido,
            t.email AS email,
            t.id AS id_entrada,
            t.estado AS estado_entrada,
            t.origen AS origen,
            te.nombre AS tipo_entrada,
            t.fecha_compra AS fecha_y_hora_compra,
            t.fecha_escaneada AS fecha_y_hora_escaneada
         FROM tickets t
         LEFT JOIN compras c ON c.payment_id = t.payment_id
         LEFT JOIN tipos_entrada te ON te.id = t.tipo_entrada_id
         WHERE t.evento_id = ?
         ORDER BY t.fecha_compra DESC`,
        [eventoId]
    );
    return filas;
}

module.exports = {
    obtenerEventosActivos, obtenerEventosConectados, obtenerTodos, obtenerEventosDeUsuario, obtenerEvento,
    obtenerEventoPorToken, obtenerEventoPorGuardiaToken, obtenerEventoPorSlug, crearEvento, editarEvento, eliminarEvento,
    conectarMercadoPago, toggleActivo, resumenVentas, desgloseVentasPorTipo, listadoVentas, ventaVencidaPorTiempo,
    eventoFinalizado, separarPorEstado, marcarFinalizado, generarSlugUnico, acreditarEvento, eventoEsPublico
};
