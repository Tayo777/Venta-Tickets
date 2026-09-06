const { v4: uuidv4 } = require('uuid');
const { pool } = require('./pool');
const { firmarId } = require('../services/firmaTickets');

// Genera el código base y le anexa la firma HMAC — este es el ID real de la entrada
// (se guarda en la DB, va en el QR, y es lo que /validar tiene que verificar antes de
// consultar la base). qrSecret es el de ESE evento puntual (eventos.qr_secret) — ya no hay
// un secreto global, así que quien llama tiene que pasarlo. Ver services/firmaTickets.js.
function generarIdEntrada(qrSecret) {
    const idBase = 'EVT-' + uuidv4().substring(0, 8).toUpperCase();
    return firmarId(idBase, qrSecret);
}

// Se lanza cuando ya no queda cupo suficiente en el tipo de entrada pedido.
class SinCupoError extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = 'SinCupoError';
    }
}

// Registra las entradas de una compra que puede incluir VARIOS tipos a la vez
// (ej. 2 General + 1 VIP) y devuelve todos los códigos generados.
//
// `lineas` es [{ tipoEntradaId, cantidad }]. Todo pasa en UNA sola transacción: por cada tipo
// se bloquea su fila con SELECT ... FOR UPDATE (así ninguna compra simultánea puede leer un
// cupo "viejo"), se valida el cupo, se descuenta y se insertan los tickets. Si CUALQUIER línea
// se queda sin cupo, se hace rollback de la compra entera — no existe la venta a medias donde
// el comprador paga por 3 entradas y recibe 2.
async function registrarEntradas(eventoId, lineas, { email, nombreApellido, paymentId, qrSecret, origen = 'compra' } = {}) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();

        // Se bloquean los tipos SIEMPRE en el mismo orden (por id). Si dos compras simultáneas
        // llevan los mismos tipos en distinto orden, sin esto podrían quedar esperándose
        // mutuamente cada una con medio lock agarrado (deadlock clásico).
        const ordenadas = [...lineas].sort((a, b) => a.tipoEntradaId - b.tipoEntradaId);

        const codigos = [];
        for (const linea of ordenadas) {
            const [filas] = await conexion.query(
                'SELECT id, nombre, precio, cupo_total, cupo_vendido FROM tipos_entrada WHERE id = ? AND evento_id = ? FOR UPDATE',
                [linea.tipoEntradaId, eventoId]
            );
            const tipo = filas[0];
            if (!tipo) throw new Error('El tipo de entrada no existe para este evento.');

            const disponibles = tipo.cupo_total - tipo.cupo_vendido;
            if (disponibles < linea.cantidad) {
                throw new SinCupoError(`Cupo insuficiente en "${tipo.nombre}": quedan ${disponibles} entrada/s.`);
            }

            await conexion.query(
                'UPDATE tipos_entrada SET cupo_vendido = cupo_vendido + ? WHERE id = ?',
                [linea.cantidad, tipo.id]
            );

            // El precio queda CONGELADO acá, en el momento de la venta: es la recaudación
            // histórica real. Si más adelante el organizador sube el precio del tipo, esta
            // fila no se recalcula sola — es la plata que efectivamente se cobró. Las
            // cortesías se guardan en 0 (no son plata, ver db/eventos.js -> resumenVentas).
            const precioPagado = origen === 'cortesia' ? 0 : Number(tipo.precio);
            for (let i = 0; i < linea.cantidad; i++) {
                const id = generarIdEntrada(qrSecret);
                codigos.push(id);
                await conexion.query(
                    'INSERT INTO tickets (id, evento_id, tipo_entrada_id, email, nombre_apellido, payment_id, origen, precio_pagado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [id, eventoId, tipo.id, email, nombreApellido || null, paymentId || null, origen, precioPagado]
                );
            }
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

// Entradas de cortesía: no pasan por Mercado Pago, pero SÍ corresponden a un tipo de entrada
// concreto y descuentan su cupo igual que una venta (si regalás 10 VIP, quedan 10 VIP menos
// para vender). Por eso reusa exactamente la misma transacción con FOR UPDATE de arriba.
async function registrarEntradasCortesia(eventoId, tipoEntradaId, email, cantidad, { nombreApellido, qrSecret } = {}) {
    return registrarEntradas(eventoId, [{ tipoEntradaId, cantidad }], {
        email, nombreApellido, qrSecret, paymentId: null, origen: 'cortesia'
    });
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

// Busca un ticket puntual junto con el nombre de su evento y el qr_secret CON EL QUE HAY QUE
// VERIFICAR SU FIRMA (para /validar) — cada evento tiene el suyo, por eso viaja en este JOIN.
async function obtenerTicketConEvento(ticketId) {
    const [filas] = await pool.query(
        `SELECT t.*, e.nombre AS evento_nombre, e.qr_secret AS evento_qr_secret FROM tickets t
         JOIN eventos e ON t.evento_id = e.id
         WHERE t.id = ?`,
        [ticketId]
    );
    return filas[0] || null;
}

// `fechaEscaneo` es OPCIONAL y existe por el modo offline de la app de guardias: cuando el
// escaneo se hizo sin señal, la hora real es la del celular en la puerta, no la del momento en
// que se pudo sincronizar (que puede ser horas despues). Si no viene, se usa la hora del server.
//
// El WHERE incluye "estado <> 'Usada'": si dos guardias escanearon la misma entrada offline y
// las dos sincronizan, gana la PRIMERA hora registrada y la segunda no la pisa.
async function marcarComoUsada(ticketId, fechaEscaneo = null) {
    if (fechaEscaneo instanceof Date && !isNaN(fechaEscaneo)) {
        await pool.query(
            "UPDATE tickets SET estado = 'Usada', fecha_escaneada = ? WHERE id = ? AND estado <> 'Usada'",
            [fechaEscaneo, ticketId]
        );
        return;
    }
    await pool.query(
        "UPDATE tickets SET estado = 'Usada', fecha_escaneada = NOW() WHERE id = ? AND estado <> 'Usada'",
        [ticketId]
    );
}

// Volcado liviano (solo id + estado) de todas las entradas de un evento, para que el celular
// del guardia lo descargue una vez y pueda seguir validando aunque se quede sin señal
// (ver public/guardia-cliente.js).
async function obtenerTicketsDeEvento(eventoId) {
    const [filas] = await pool.query('SELECT id, estado FROM tickets WHERE evento_id = ?', [eventoId]);
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
    asignarFilasAleatorio, obtenerTicketsCompletosDeEvento, SinCupoError
};
