const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');

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
            const id = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
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
        const id = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
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

module.exports = {
    registrarEntradas, registrarEntradasCortesia, obtenerEntradasDeCompra,
    obtenerUltimasEntradas, obtenerTicketConEvento, marcarComoUsada, SinCupoError
};
