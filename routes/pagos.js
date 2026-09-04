const express = require('express');
const router = express.Router();
const eventosDb = require('../db/eventos');
const ticketsDb = require('../db/tickets');
const tiposEntradaDb = require('../db/tiposEntrada');
const mp = require('../services/mercadopago');
const { procesarPagoAprobado } = require('../services/procesarPago');
const { generarPdfEnResponse } = require('../services/pdfEntradas');

router.post('/crear-pago', async (req, res) => {
    const { email, nombre_apellido, cantidad, evento_id, tipo_entrada_id } = req.body;
    const cant = parseInt(cantidad);
    const eventoId = parseInt(evento_id);
    const tipoEntradaId = parseInt(tipo_entrada_id);

    if (!nombre_apellido || !String(nombre_apellido).trim()) {
        return res.status(400).send('Falta el nombre y apellido del comprador.');
    }
    if (cant < 1 || cant > 5) {
        return res.status(400).send('Cantidad de entradas inválida (máximo 5).');
    }

    const evento = await eventosDb.obtenerEvento(eventoId);
    if (!evento || !evento.activo || !evento.conectado_mp) {
        return res.status(404).send('Evento no encontrado o no disponible para la venta.');
    }

    // Cierre automático de ventas: por fecha límite o porque ya no queda cupo. Esto es una
    // validación "amable" antes de pagar; la que de verdad evita la sobreventa es la
    // transacción con FOR UPDATE en ticketsDb.registrarEntradas (ver /success más abajo).
    if (eventosDb.ventaVencidaPorTiempo(evento)) {
        return res.status(410).send('La venta de entradas para este evento ya cerró.');
    }

    const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(tipoEntradaId);
    if (!tipoEntrada || tipoEntrada.evento_id !== eventoId || !tipoEntrada.activo) {
        return res.status(404).send('Tipo de entrada no encontrado.');
    }
    if (tipoEntrada.cupo_disponible < cant) {
        return res.status(409).send(`Ya no quedan suficientes entradas "${tipoEntrada.nombre}" disponibles (quedan ${tipoEntrada.cupo_disponible}).`);
    }

    try {
        const urlCheckout = await mp.crearPreferencia(evento, tipoEntrada, { email, nombreApellido: nombre_apellido, cantidad: cant });
        res.redirect(urlCheckout);
    } catch (error) {
        console.error('Error al crear la preferencia de pago:', error);
        res.status(500).send('Error al procesar el pago con Mercado Pago.');
    }
});

// Página de éxito: idempotente (no duplica entradas/mails si Mercado Pago o el navegador
// cargan esta URL más de una vez con el mismo payment_id).
router.get('/success', async (req, res) => {
    const { email, cant, evento_id, payment_id, nombre, tipo_entrada_id } = req.query;
    const cantidadEntradas = parseInt(cant) || 1;
    const eventoId = parseInt(evento_id);
    const tipoEntradaId = parseInt(tipo_entrada_id);
    const nombreApellido = nombre || '';
    let evento;
    let tipoEntrada;

    try {
        evento = await eventosDb.obtenerEvento(eventoId);
        if (!evento) return res.status(404).send('Evento no encontrado.');

        tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(tipoEntradaId);
        if (!tipoEntrada || tipoEntrada.evento_id !== eventoId) return res.status(404).send('Tipo de entrada no encontrado.');

        if (!payment_id) {
            console.error('Llegó a /success sin payment_id, se rechaza para evitar duplicados.');
            return res.status(400).send('No se pudo confirmar el pago. Si ya recibiste tu mail con las entradas, no hace falta hacer nada más.');
        }

        res.render('success', { email, cant, evento });
    } catch (error) {
        console.error('Error al procesar la compra:', error);
        return res.status(500).send('Error interno al registrar la compra.');
    }

    // A partir de acá la respuesta YA fue enviada al navegador. Corre aparte para que un
    // error acá (PDF, QR, mail) no intente mandar otra respuesta HTTP y quede oculto. La
    // función es idempotente por payment_id: si el job de reconciliación (services/reconciliarPagos.js)
    // ya la procesó antes (por ejemplo porque el servidor se reinició justo acá), no duplica nada.
    try {
        await procesarPagoAprobado({
            evento, tipoEntrada, paymentId: payment_id, email, nombreApellido, cantidad: cantidadEntradas
        });
    } catch (error) {
        console.error('Error al generar el PDF o registrar las entradas post-pago:', error);
    }
});

router.get('/descargar-pdf', async (req, res) => {
    const { email, cant } = req.query;
    const limit = parseInt(cant) || 1;

    try {
        const filas = await ticketsDb.obtenerUltimasEntradas(email, limit);
        if (filas.length === 0) return res.status(404).send('No se encontraron entradas para este correo.');

        await generarPdfEnResponse(res, {
            nombreEvento: filas[0].evento_nombre,
            email,
            codigos: filas.map((f) => f.id)
        });
    } catch (error) {
        console.error('Error al descargar el PDF:', error);
        res.status(500).send('Hubo un error al generar tu entrada.');
    }
});

module.exports = router;
