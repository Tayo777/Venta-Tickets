const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { firmarId } = require('../services/firmaTickets');

// Genera el código base y le anexa la firma HMAC — este es el ID real de la entrada
// (se guarda en la DB, va en el QR, y es lo que /validar tiene que verificar antes de
// consultar la base). Ver services/firmaTickets.js.
function generarIdEntrada() {
    const idBase = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
    return firmarId(idBase);
}

// Se lanza cuando ya no queda cupo suficiente en el tipo de entrada pedido.
class SinCupoError extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = 'SinCupoError';
    }
}

// Registra N entradas nuevas de un tipo puntual (General/VIP/etc.) y devuelve sus códigos.
// Todo pasa en UNA transacción: primero bloquea la fila del tipo de entrada con
// SELECT ... FOR UPDATE (así ninguna otra compra simultánea puede leer un cupo "viejo"),
// valida que alcance el cupo, lo descuenta, y recién ahí inserta los tickets. Si algo falla
// o no alcanza el cupo, se hace rollback y no se vende ni se descuenta nada (todo o nada).
async function registrarEntradas(eventoId, tipoEntradaId, email, cantidad, { nombreApellido, paymentId } = {}) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();

        const [filas] = await conexion.query(
            'SELECT id, cupo_total, cupo_vendido FROM tipos_entrada WHERE id = ? AND evento_id = ? FOR UPDATE',
            [tipoEntradaId, eventoId]
        );
        const tipo = filas[0];
        if (!tipo) throw new Error('El tipo de entrada no existe para este evento.');

        const disponibles = tipo.cupo_total - tipo.cupo_vendido;
        if (disponibles < cantidad) {
            throw new SinCupoError(`Cupo insuficiente: quedan ${disponibles} entrada/s disponibles.`);
        }

        await conexion.query(
            'UPDATE tipos_entrada SET cupo_vendido = cupo_vendido + ? WHERE id = ?',
            [cantidad, tipoEntradaId]
        );

        const codigos = [];
        for (let i = 0; i < cantidad; i++) {
            const id = generarIdEntrada();
            codigos.push(id);
            await conexion.query(
                'INSERT INTO tickets (id, evento_id, tipo_entrada_id, email, nombre_apellido, payment_id) VALUES (?, ?, ?, ?, ?, ?)',
                [id, eventoId, tipoEntradaId, email, nombreApellido || null, paymentId || null]
            );
        }
        await conexion.commit();
        return codigos;
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
}

// Entradas de cortesía: no pasan por Mercado Pago ni descuentan cupo pago (tipo_entrada_id
// queda NULL), pensadas para invitados/prensa/staff. No necesitan transacción con FOR UPDATE
// porque no compiten por ningún cupo compartido.
async function registrarEntradasCortesia(eventoId, email, cantidad, { nombreApellido } = {}) {
    const codigos = [];
    for (let i = 0; i < cantidad; i++) {
        const id = generarIdEntrada();
        codigos.push(id);
        await pool.query(
            "INSERT INTO tickets (id, evento_id, email, nombre_apellido, origen) VALUES (?, ?, ?, ?, 'cortesia')",
            [id, eventoId, email, nombreApellido || null]
        );
    }
    return codigos;
}

// Todas las entradas vigentes de un email para un evento puntual (para reenviar el QR).
async function obtenerEntradasDeCompra(eventoId, email) {
    const [filas] = await pool.query(
        'SELECT id FROM tickets WHERE evento_id = ? AND email = ? ORDER BY fecha_compra DESC',
        [eventoId, email]
    );
    return filas.map((f) => f.id);
}

// Busca las últimas N entradas de un email, con el nombre del evento (para el PDF/descarga).
async function obtenerUltimasEntradas(email, limit) {
    const [filas] = await pool.query(
        `SELECT t.id, e.nombre AS evento_nombre FROM tickets t
         JOIN eventos e ON t.evento_id = e.id
         WHERE t.email = ? ORDER BY t.fecha_compra DESC LIMIT ?`,
        [email, limit]
    );
    return filas;
}

// Busca un ticket puntual junto con el nombre de su evento (para /validar).
async function obtenerTicketConEvento(ticketId) {
    const [filas] = await pool.query(
        `SELECT t.*, e.nombre AS evento_nombre FROM tickets t
         JOIN eventos e ON t.evento_id = e.id
         WHERE t.id = ?`,
        [ticketId]
    );
    return filas[0] || null;
}

async function marcarComoUsada(ticketId) {
    await pool.query('UPDATE tickets SET estado = ?, fecha_escaneada = NOW() WHERE id = ?', ['Usada', ticketId]);
}

// Volcado liviano (solo id + estado) de todas las entradas de un evento, para que el celular
// del guardia lo descargue una vez y pueda seguir validando aunque se quede sin señal
// (ver public/guardia-cliente.js).
async function obtenerTicketsDeEvento(eventoId) {
    const [filas] = await pool.query('SELECT id, estado FROM tickets WHERE evento_id = ?', [eventoId]);
    return filas;
}

// Cuántas entradas ingresaron por hora del día, para graficar el flujo de gente en la puerta.
// Se agrupa por HOUR(fecha_escaneada) — devuelve solo las horas que tuvieron al menos un
// ingreso (no rellena las horas en cero, eso lo arma el frontend al dibujar la barra).
async function obtenerIngresosPorHora(eventoId) {
    const [filas] = await pool.query(
        `SELECT HOUR(fecha_escaneada) AS hora, COUNT(*) AS cantidad
         FROM tickets
         WHERE evento_id = ? AND estado = 'Usada' AND fecha_escaneada IS NOT NULL
         GROUP BY HOUR(fecha_escaneada)
         ORDER BY hora`,
        [eventoId]
    );
    return filas;
}

// Reparte las entradas de un evento entre N filas/guardias, al azar y en partes iguales
// (diferencia de a lo sumo 1 entrada entre filas). El mezclado (Fisher-Yates) pasa ANTES de
// asignar el número de fila de forma cíclica, así el reparto queda al azar y mezcla tipos de
// entrada entre sí (no separa General/VIP por fila). Todo en una transacción: o se reparte
// completo, o no se toca nada.
async function asignarFilasAleatorio(eventoId, cantidadFilas) {
    const [tickets] = await pool.query('SELECT id FROM tickets WHERE evento_id = ?', [eventoId]);

    for (let i = tickets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tickets[i], tickets[j]] = [tickets[j], tickets[i]];
    }

    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        for (let i = 0; i < tickets.length; i++) {
            const fila = (i % cantidadFilas) + 1;
            await conexion.query('UPDATE tickets SET fila_asignada = ? WHERE id = ?', [fila, tickets[i].id]);
        }
        await conexion.commit();
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
    return tickets.length;
}

// Volcado COMPLETO de todas las entradas del evento (todas las filas, no solo la del guardia
// que pide la sync) — la app móvil necesita el mapa entero para que el modo offline funcione
// aunque un guardia cruce a ayudar en otra fila.
async function obtenerTicketsCompletosDeEvento(eventoId) {
    const [filas] = await pool.query(
        'SELECT id, estado, fila_asignada, tipo_entrada_id, email, nombre_apellido FROM tickets WHERE evento_id = ?',
        [eventoId]
    );
    return filas;
}

module.exports = {
    registrarEntradas, registrarEntradasCortesia, obtenerEntradasDeCompra,
    obtenerUltimasEntradas, obtenerTicketConEvento, obtenerTicketsDeEvento, marcarComoUsada,
    obtenerIngresosPorHora, asignarFilasAleatorio, obtenerTicketsCompletosDeEvento, SinCupoError
};
