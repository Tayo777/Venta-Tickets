const express = require('express');
const multer = require('multer');
const router = express.Router();
const eventosDb = require('../db/eventos');
const tiposEntradaDb = require('../db/tiposEntrada');
const ticketsDb = require('../db/tickets');
const cuponesDb = require('../db/cupones');
const comprasDb = require('../db/compras');
const guardiasDb = require('../db/guardias');
const mp = require('../services/mercadopago');
const { subirImagen } = require('../services/imgbb');
const { enviarMailBrevo } = require('../services/brevo');
const { generarPdfBuffer } = require('../services/pdfEntradas');
const { requiereLogin, requiereAprobado, esDueñoOAdmin, eventoEditable, puedeEliminarEvento } = require('../middleware/auth');
const { BASE_URL } = require('../config/env');
const { ZONA_HORARIA } = require('../config/tiempo');

// Guarda el archivo en memoria (no en disco) — se sube a un hosting de imágenes al toque.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

router.get('/mis-eventos', requiereLogin, async (req, res) => {
    const eventos = req.session.rol === 'admin'
        ? await eventosDb.obtenerTodos()
        : await eventosDb.obtenerEventosDeUsuario(req.session.usuarioId);

    // El panel los muestra en dos acordeones separados: los activos se administran normal,
    // los finalizados quedan en solo lectura (ver middleware/auth.js -> eventoEditable).
    const { activos, finalizados } = eventosDb.separarPorEstado(eventos);
    res.render('mis-eventos', { activos, finalizados, esAdmin: req.session.rol === 'admin' });
});

router.get('/crear-evento', requiereLogin, requiereAprobado, (req, res) => {
    res.render('crear-evento', { error: null, usuarioLogueado: true });
});

router.post('/crear-evento', requiereLogin, requiereAprobado, upload.single('flyer'), async (req, res) => {
    const { nombre, descripcion, fecha, fecha_cierre_ventas,
            lugar_nombre, direccion, ciudad, maps_url,
            tipo1_nombre, tipo1_descripcion, valor_entrada, cupo_general,
            vip_activo, tipo2_nombre, tipo2_descripcion, valor_vip, cupo_vip } = req.body;
    const valorEntradaNum = Number(valor_entrada);
    const cupoGeneralNum = parseInt(cupo_general);

    const campos = { nombre, descripcion, fecha, tipo1_nombre };
    const faltantes = Object.entries(campos).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (faltantes.length > 0 || !valorEntradaNum || valorEntradaNum <= 0 || !cupoGeneralNum || cupoGeneralNum <= 0 || !req.file) {
        return res.render('crear-evento', { error: 'Completá todos los campos obligatorios: datos del evento, imagen del flyer, y nombre/precio/cupo del primer tipo de entrada.', usuarioLogueado: true });
    }

    const quiereVip = vip_activo === 'on';
    const valorVipNum = Number(valor_vip);
    const cupoVipNum = parseInt(cupo_vip);
    if (quiereVip && (!tipo2_nombre || !String(tipo2_nombre).trim() || !valorVipNum || valorVipNum <= 0 || !cupoVipNum || cupoVipNum <= 0)) {
        return res.render('crear-evento', { error: 'Si agregás un segundo tipo de entrada, completá su nombre, precio y cupo.', usuarioLogueado: true });
    }

    try {
        const flyerUrl = await subirImagen(req.file.buffer);
        const { comisionMpPct, comisionPropiaPct, tarifaOnline } = mp.calcularTarifa(valorEntradaNum);

        const { id } = await eventosDb.crearEvento({
            usuarioId: req.session.usuarioId,
            nombre, descripcion, fecha, flyerUrl,
            valorEntrada: valorEntradaNum, tarifaOnline,
            organizerEmail: null, comisionMpPct, comisionPropiaPct,
            fechaCierreVentas: fecha_cierre_ventas || null,
            lugarNombre: lugar_nombre, direccion, ciudad, mapsUrl: maps_url
        });

        await tiposEntradaDb.crearTipoEntrada({
            eventoId: id, nombre: tipo1_nombre.trim(), descripcion: tipo1_descripcion,
            precio: valorEntradaNum, cupoTotal: cupoGeneralNum
        });
        if (quiereVip) {
            await tiposEntradaDb.crearTipoEntrada({
                eventoId: id, nombre: tipo2_nombre.trim(), descripcion: tipo2_descripcion,
                precio: valorVipNum, cupoTotal: cupoVipNum
            });
        }

        res.redirect(`/eventos/${id}`);
    } catch (error) {
        console.error('Error al crear el evento:', error);
        res.render('crear-evento', { error: 'Hubo un error al crear el evento (revisá la imagen e intentá de nuevo).', usuarioLogueado: true });
    }
});

// Deja todo lo que necesita la pantalla de edición (evento + cupones + tipos de entrada).
async function datosEdicion(evento, extras = {}) {
    const [cupones, tipos] = await Promise.all([
        cuponesDb.obtenerCuponesDeEvento(evento.id),
        tiposEntradaDb.obtenerTiposPorEvento(evento.id)
    ]);
    return { evento, cupones, tipos, error: null, errorCupon: null, errorTipo: null, usuarioLogueado: true, ...extras };
}

router.get('/eventos/:id/editar', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    res.render('editar-evento', await datosEdicion(req.evento));
});

router.post('/eventos/:id/editar', requiereLogin, esDueñoOAdmin, eventoEditable, upload.single('flyer'), async (req, res) => {
    const { nombre, descripcion, fecha, valor_entrada, fecha_cierre_ventas,
            lugar_nombre, direccion, ciudad, maps_url } = req.body;
    try {
        const flyerUrl = req.file ? await subirImagen(req.file.buffer) : req.evento.flyer_url;
        await eventosDb.editarEvento(req.evento.id, {
            nombre, descripcion, fecha, flyerUrl, valorEntrada: Number(valor_entrada),
            fechaCierreVentas: fecha_cierre_ventas || null,
            lugarNombre: lugar_nombre, direccion, ciudad, mapsUrl: maps_url
        });
        res.redirect(`/eventos/${req.evento.id}`);
    } catch (error) {
        console.error('Error al editar el evento:', error);
        res.render('editar-evento', await datosEdicion(req.evento, { error: 'No se pudo guardar el cambio.' }));
    }
});

// --- Gestión de tipos de entrada (misma pantalla de edición) ---

router.post('/eventos/:id/tipos', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { nombre, descripcion, precio, cupo_total } = req.body;
    const precioNum = Number(precio);
    const cupoNum = parseInt(cupo_total);

    if (!nombre || !String(nombre).trim() || !cupoNum || cupoNum <= 0 || isNaN(precioNum) || precioNum < 0) {
        return res.render('editar-evento', await datosEdicion(req.evento, { errorTipo: 'Completá nombre, precio y cupo del tipo de entrada.' }));
    }

    try {
        await tiposEntradaDb.crearTipoEntrada({
            eventoId: req.evento.id, nombre: nombre.trim(), descripcion, precio: precioNum, cupoTotal: cupoNum
        });
        res.redirect(`/eventos/${req.evento.id}/editar`);
    } catch (error) {
        console.error('Error al crear el tipo de entrada:', error);
        res.render('editar-evento', await datosEdicion(req.evento, { errorTipo: 'No se pudo crear el tipo de entrada.' }));
    }
});

router.post('/eventos/:id/tipos/:tipoId/editar', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { nombre, descripcion, precio, cupo_total } = req.body;
    const precioNum = Number(precio);
    const cupoNum = parseInt(cupo_total);

    if (!nombre || !String(nombre).trim() || !cupoNum || cupoNum <= 0 || isNaN(precioNum) || precioNum < 0) {
        return res.render('editar-evento', await datosEdicion(req.evento, { errorTipo: 'Completá nombre, precio y cupo del tipo de entrada.' }));
    }

    // El cupo nuevo no puede quedar por debajo de lo YA vendido de ese tipo: dejaría el
    // contador en negativo y el tipo aparecería "sobrevendido".
    const tipo = await tiposEntradaDb.obtenerTipoEntrada(req.params.tipoId);
    if (!tipo || tipo.evento_id !== req.evento.id) return res.status(404).send('Tipo de entrada no encontrado.');
    if (cupoNum < tipo.cupo_vendido) {
        return res.render('editar-evento', await datosEdicion(req.evento, {
            errorTipo: `No podés bajar el cupo de "${tipo.nombre}" a ${cupoNum}: ya vendiste ${tipo.cupo_vendido}.`
        }));
    }

    await tiposEntradaDb.editarTipoEntrada(req.params.tipoId, req.evento.id, {
        nombre: nombre.trim(), descripcion, precio: precioNum, cupoTotal: cupoNum
    });
    res.redirect(`/eventos/${req.evento.id}/editar`);
});

router.post('/eventos/:id/tipos/:tipoId/toggle', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    await tiposEntradaDb.toggleActivo(req.params.tipoId, req.evento.id);
    res.redirect(`/eventos/${req.evento.id}/editar`);
});

router.post('/eventos/:id/tipos/:tipoId/eliminar', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { borrado, motivo } = await tiposEntradaDb.eliminarTipoEntrada(req.params.tipoId, req.evento.id);
    if (!borrado) {
        return res.render('editar-evento', await datosEdicion(req.evento, { errorTipo: motivo }));
    }
    res.redirect(`/eventos/${req.evento.id}/editar`);
});

// --- Gestión de cupones del evento (misma pantalla de edición) ---

router.post('/eventos/:id/cupones', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { codigo, tipo, valor, usos_maximos } = req.body;
    const valorNum = Number(valor);
    const usosMaximosNum = usos_maximos ? parseInt(usos_maximos) : null;

    const renderConError = async (mensaje) => {
        res.render('editar-evento', await datosEdicion(req.evento, { errorCupon: mensaje }));
    };

    if (!codigo || !String(codigo).trim()) return renderConError('Ingresá un código para el cupón.');
    if (tipo !== 'porcentaje' && tipo !== 'monto_fijo') return renderConError('Tipo de cupón inválido.');
    if (!valorNum || valorNum <= 0) return renderConError('El valor del cupón tiene que ser mayor a 0.');
    if (tipo === 'porcentaje' && valorNum > 100) return renderConError('Un descuento porcentual no puede ser mayor a 100%.');

    // Los checkboxes llegan como array si se tildó más de uno, y como string suelto si se
    // tildó uno solo — [].concat() normaliza los dos casos. Sin ninguno tildado, el cupón
    // queda sin restricción y aplica a todos los tipos.
    const tiposDelEvento = await tiposEntradaDb.obtenerTiposPorEvento(req.evento.id);
    const idsValidos = tiposDelEvento.map((t) => t.id);
    const tiposIds = [].concat(req.body.tipos_ids || [])
        .map((v) => parseInt(v))
        .filter((id) => idsValidos.includes(id)); // descarta ids de otros eventos

    try {
        await cuponesDb.crearCupon({
            eventoId: req.evento.id, codigo, tipo, valor: valorNum, usosMaximos: usosMaximosNum, tiposIds
        });
        res.redirect(`/eventos/${req.evento.id}/editar`);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return renderConError(`Ya existe un cupón con el código "${String(codigo).trim().toUpperCase()}".`);
        console.error('Error al crear el cupón:', error);
        renderConError('No se pudo crear el cupón.');
    }
});

router.post('/eventos/:id/cupones/:cuponId/toggle', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    await cuponesDb.toggleActivo(req.params.cuponId, req.evento.id);
    res.redirect(`/eventos/${req.evento.id}/editar`);
});

router.post('/eventos/:id/cupones/:cuponId/eliminar', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    await cuponesDb.eliminarCupon(req.params.cuponId, req.evento.id);
    res.redirect(`/eventos/${req.evento.id}/editar`);
});

router.post('/eventos/:id/eliminar', requiereLogin, esDueñoOAdmin, puedeEliminarEvento, async (req, res) => {
    try {
        await eventosDb.eliminarEvento(req.evento.id);
        res.redirect('/mis-eventos');
    } catch (error) {
        console.error('Error al eliminar el evento:', error);
        res.status(500).send('No se pudo eliminar el evento.');
    }
});

// Panel privado del evento: solo el dueño o el admin pueden entrar. Acá está el link de
// guardia (encriptado, uno por evento) y el listado de ventas — nada de esto es público.
async function datosPanel(evento, extras = {}) {
    const [resumen, ventas, guardias, tipos, desglosePorTipo] = await Promise.all([
        eventosDb.resumenVentas(evento.id),
        eventosDb.listadoVentas(evento.id),
        guardiasDb.obtenerGuardiasDeEvento(evento.id),
        tiposEntradaDb.obtenerTiposPorEvento(evento.id),
        eventosDb.desgloseVentasPorTipo(evento.id)
    ]);
    // La recaudacion la calcula resumenVentas() sumando precio_pagado (el precio HISTÓRICO
    // real de cada ticket, congelado al venderse — ver db/tickets.js), no el precio actual
    // del tipo de entrada. Así, si el organizador sube el precio de "General" a mitad de
    // evento, las ventas viejas siguen contando lo que efectivamente se cobró.
    const recaudacion = resumen.recaudacion;

    return {
        evento, resumen, ventas, guardias, tipos, recaudacion, desglosePorTipo,
        esAdmin: extras.esAdmin === true,
        // Si está finalizado, la vista oculta/deshabilita todo lo que modifica (el servidor
        // igual lo bloquea con eventoEditable, esto es solo para no ofrecer botones muertos).
        soloLectura: eventosDb.eventoFinalizado(evento),
        urlConexionMP: mp.urlConexionOAuth(evento.token_informe),
        urlPublica: `${BASE_URL}/evento/${evento.id}`,
        urlGuardia: `${BASE_URL}/login-guardia/${evento.id}?token=${evento.guardia_token}`,
        conectado: false, cortesia: false, reenviado: false, filasAsignadas: null,
        errorGuardia: null,
        ...extras
    };
}

router.get('/eventos/:id', requiereLogin, esDueñoOAdmin, async (req, res) => {
    res.render('evento-detalle', await datosPanel(req.evento, {
        esAdmin: req.session.rol === 'admin',
        conectado: req.query.conectado === '1',
        cortesia: req.query.cortesia === '1',
        reenviado: req.query.reenviado === '1',
        filasAsignadas: req.query.filas_ok || null
    }));
});

// Marca/desmarca el evento como finalizado a mano. Un evento con fecha pasada ya cuenta como
// finalizado solo (ver eventosDb.eventoFinalizado); esto sirve para cerrarlo antes de tiempo,
// o para reabrir uno que se marcó por error (mientras su fecha no haya pasado).
router.post('/eventos/:id/finalizar', requiereLogin, esDueñoOAdmin, async (req, res) => {
    await eventosDb.marcarFinalizado(req.evento.id, req.body.finalizar === '1');
    res.redirect(`/eventos/${req.evento.id}`);
});

// Reparte todas las entradas vendidas entre N filas/guardias, al azar y en partes iguales
// (ver ticketsDb.asignarFilasAleatorio). Pensado para correrlo el día del evento, una vez
// que ya se sabe cuántos guardias/puertas va a haber.
router.post('/eventos/:id/asignar-filas', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const cantidadFilas = parseInt(req.body.cantidad_filas);
    if (!cantidadFilas || cantidadFilas < 1 || cantidadFilas > 20) {
        return res.status(400).send('Ingresá una cantidad de filas válida (entre 1 y 20).');
    }

    try {
        const total = await ticketsDb.asignarFilasAleatorio(req.evento.id, cantidadFilas);
        res.redirect(`/eventos/${req.evento.id}?filas_ok=${cantidadFilas}`);
        console.log(`Repartidas ${total} entradas en ${cantidadFilas} filas para el evento ${req.evento.id}.`);
    } catch (error) {
        console.error('Error al repartir filas:', error);
        res.status(500).send('No se pudo repartir las entradas por fila.');
    }
});

// --- Gestión de guardias (cuentas para la app móvil) ---

router.post('/eventos/:id/guardias', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { email, password, fila_asignada } = req.body;
    const filaNum = parseInt(fila_asignada);

    const rerenderConError = async (mensaje) => {
        res.render('evento-detalle', await datosPanel(req.evento, { esAdmin: req.session.rol === 'admin', errorGuardia: mensaje }));
    };

    if (!email || !String(email).trim()) return rerenderConError('Ingresá el email del guardia.');
    if (!password || password.length < 8) return rerenderConError('La contraseña del guardia tiene que tener al menos 8 caracteres.');
    if (!filaNum || filaNum < 1) return rerenderConError('Ingresá un número de fila válido.');

    try {
        await guardiasDb.crearGuardia({ eventoId: req.evento.id, email, password, filaAsignada: filaNum });
        res.redirect(`/eventos/${req.evento.id}`);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return rerenderConError(`Ya existe un guardia con el email "${email}".`);
        console.error('Error al crear guardia:', error);
        rerenderConError('No se pudo crear el guardia.');
    }
});

// Editar un guardia. La contraseña es opcional: si el campo viene vacío, se conserva la que
// ya tenía (ver guardiasDb.editarGuardia).
router.post('/eventos/:id/guardias/:guardiaId/editar', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { email, password, fila_asignada } = req.body;
    const filaNum = parseInt(fila_asignada);

    const rerenderConError = async (mensaje) => {
        res.render('evento-detalle', await datosPanel(req.evento, { esAdmin: req.session.rol === 'admin', errorGuardia: mensaje }));
    };

    if (!email || !String(email).trim()) return rerenderConError('Ingresá el email del guardia.');
    if (!filaNum || filaNum < 1) return rerenderConError('Ingresá un número de fila válido.');
    // Solo se valida el largo si REALMENTE escribió una contraseña nueva.
    if (password && password.length < 8) {
        return rerenderConError('La contraseña nueva del guardia tiene que tener al menos 8 caracteres.');
    }

    try {
        await guardiasDb.editarGuardia(req.params.guardiaId, req.evento.id, {
            email, filaAsignada: filaNum, password
        });
        res.redirect(`/eventos/${req.evento.id}`);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return rerenderConError(`Ya existe otro guardia con el email "${email}".`);
        console.error('Error al editar guardia:', error);
        rerenderConError('No se pudo guardar el cambio del guardia.');
    }
});

router.post('/eventos/:id/guardias/:guardiaId/eliminar', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    await guardiasDb.eliminarGuardia(req.params.guardiaId, req.evento.id);
    res.redirect(`/eventos/${req.evento.id}`);
});

router.post('/eventos/:id/guardias/:guardiaId/toggle', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    await guardiasDb.toggleActivo(req.params.guardiaId, req.evento.id);
    res.redirect(`/eventos/${req.evento.id}`);
});

// Entradas de cortesía: el organizador/admin las genera a mano, sin pasar por Mercado Pago.
// Corresponden a un TIPO de entrada concreto y descuentan su cupo igual que una venta (si
// regalás 10 VIP, quedan 10 VIP menos para vender).
router.post('/eventos/:id/cortesia', requiereLogin, esDueñoOAdmin, eventoEditable, async (req, res) => {
    const { email, nombre_apellido, cantidad, tipo_entrada_id } = req.body;
    const cant = parseInt(cantidad);
    const tipoEntradaId = parseInt(tipo_entrada_id);

    if (!email || !String(email).trim() || !nombre_apellido || !String(nombre_apellido).trim() || cant < 1 || cant > 20) {
        return res.status(400).send('Completá email, nombre y una cantidad válida (máx. 20).');
    }

    const tipoEntrada = await tiposEntradaDb.obtenerTipoEntrada(tipoEntradaId);
    if (!tipoEntrada || tipoEntrada.evento_id !== req.evento.id) {
        return res.status(400).send('Elegí a qué tipo de entrada corresponde la cortesía.');
    }
    if (tipoEntrada.cupo_disponible < cant) {
        return res.status(409).send(`No hay cupo suficiente en "${tipoEntrada.nombre}": quedan ${tipoEntrada.cupo_disponible} entrada/s.`);
    }

    try {
        const evento = req.evento;
        const codigos = await ticketsDb.registrarEntradasCortesia(evento.id, tipoEntradaId, email, cant, { nombreApellido: nombre_apellido, qrSecret: evento.qr_secret });

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos });
        await enviarMailBrevo({
            to: email,
            subject: `🎟️ Entrada${cant > 1 ? 's' : ''} de cortesía — ${evento.nombre}`,
            text: `¡Te invitamos a ${evento.nombre}! Adjuntamos ${cant} entrada/s de cortesía.`,
            attachmentBase64: pdfBuffer.toString('base64'),
            attachmentName: 'Entradas_Cortesia.pdf'
        });

        res.redirect(`/eventos/${evento.id}?cortesia=1`);
    } catch (error) {
        console.error('Error al generar entradas de cortesía:', error);
        res.status(500).send('No se pudieron generar las entradas de cortesía.');
    }
});

// Reenvío de QR: por si el mail original quedó en SPAM o se perdió. Regenera el PDF con
// TODAS las entradas que ese email tiene para este evento y lo reenvía, sin crear tickets nuevos.
router.post('/eventos/:id/reenviar-qr', requiereLogin, esDueñoOAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email || !String(email).trim()) {
        return res.status(400).send('Falta el email del comprador.');
    }

    try {
        const evento = req.evento;
        const codigos = await ticketsDb.obtenerEntradasDeCompra(evento.id, email);
        if (codigos.length === 0) {
            return res.status(404).send('No se encontraron entradas de ese email para este evento.');
        }

        const pdfBuffer = await generarPdfBuffer({ nombreEvento: evento.nombre, email, codigos });
        await enviarMailBrevo({
            to: email,
            subject: `🎟️ Reenvío de tus entradas — ${evento.nombre}`,
            text: `Te reenviamos ${codigos.length} entrada/s para ${evento.nombre}. Si no lo ves en tu bandeja de entrada, revisá la carpeta de SPAM/Correo no deseado.`,
            attachmentBase64: pdfBuffer.toString('base64'),
            attachmentName: 'Entradas_Evento.pdf'
        });

        res.redirect(`/eventos/${evento.id}?reenviado=1`);
    } catch (error) {
        console.error('Error al reenviar el QR:', error);
        res.status(500).send('No se pudo reenviar el mail con las entradas.');
    }
});

// Flujo de ingreso por hora (para el gráfico de barras del panel). JSON liviano: solo
// {hora, cantidad} por cada hora que tuvo al menos un ingreso.
router.get('/api/eventos/:id/ingresos-hora', requiereLogin, esDueñoOAdmin, async (req, res) => {
    try {
        const datos = await ticketsDb.obtenerIngresosPorHora(req.evento.id);
        res.json({ datos });
    } catch (error) {
        console.error('Error al calcular ingresos por hora:', error);
        res.status(500).json({ error: 'No se pudo calcular el flujo de ingreso.' });
    }
});

// Ventas por día (para el gráfico de líneas de Chart.js del panel). JSON liviano: solo
// {fecha, entradas_vendidas, monto_total} por cada día que tuvo al menos una venta.
router.get('/api/eventos/:id/grafico-ventas', requiereLogin, esDueñoOAdmin, async (req, res) => {
    try {
        const datos = await comprasDb.obtenerVentasPorFecha(req.evento.id);
        res.json({ datos });
    } catch (error) {
        console.error('Error al calcular el gráfico de ventas:', error);
        res.status(500).json({ error: 'No se pudo calcular el gráfico de ventas.' });
    }
});

// Exportación de contingencia: lista completa de asistentes en CSV (se abre directo en Excel),
// para tener a mano en la puerta si por lo que sea el panel/la app no está disponible.
router.get('/eventos/:id/exportar-csv', requiereLogin, esDueñoOAdmin, async (req, res) => {
    try {
        const ventas = await eventosDb.listadoVentas(req.evento.id);

        const DELIMITADOR = ';'; // Excel en español separa columnas por ";", no por ","
        // Solo entrecomilla si el valor lo necesita (trae el delimitador, comillas o un salto
        // de línea) — así el CSV queda limpio en vez de "todo"-entrecomillado.
        const escaparCsv = (valor) => {
            const texto = String(valor ?? '');
            const necesitaComillas = texto.includes(DELIMITADOR) || texto.includes('"') || texto.includes('\n') || texto.includes('\r');
            return necesitaComillas ? `"${texto.replace(/"/g, '""')}"` : texto;
        };

        // Fechas del CSV en hora de Argentina (misma zona que el panel), en formato
        // dd/mm/aaaa hh:mm — así lo que exporta el organizador coincide con lo que ve en
        // pantalla y Excel lo reconoce como fecha.
        const fechaParaCsv = (fecha) => {
            if (!fecha) return '';
            const d = new Date(fecha);
            if (isNaN(d)) return String(fecha);
            return d.toLocaleString('es-AR', {
                timeZone: ZONA_HORARIA,
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        };

        const encabezados = ['ID Entrada', 'Estado', 'Nombre y Apellido', 'Email', 'Tipo de entrada', 'Origen', 'Fecha de compra', 'Fecha escaneada'];
        const filas = ventas.map((v) => [
            v.id_entrada,
            v.estado_entrada === 'Usada' ? 'Usada' : 'No usada',
            v.nom_y_apellido || '',
            v.email || '',
            v.tipo_entrada || (v.origen === 'cortesia' ? 'Cortesía' : ''),
            v.origen,
            fechaParaCsv(v.fecha_y_hora_compra),
            fechaParaCsv(v.fecha_y_hora_escaneada)
        ].map(escaparCsv).join(DELIMITADOR));

        // BOM UTF-8 explícito al inicio para que Excel detecte la codificación y muestre
        // acentos/ñ correctamente (sin esto, Excel a veces asume Latin-1 y los rompe).
        const BOM = '\uFEFF';
        const csv = BOM + [encabezados.map(escaparCsv).join(DELIMITADOR), ...filas].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="asistentes_evento_${req.evento.id}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Error al exportar el CSV de asistentes:', error);
        res.status(500).send('No se pudo generar el archivo CSV.');
    }
});

// Mercado Pago redirige acá después de que el organizador acepta conectar su cuenta.
router.get('/oauth/mercadopago/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan datos en la respuesta de Mercado Pago.');

    try {
        const evento = await eventosDb.obtenerEventoPorToken(state);
        if (!evento) return res.status(404).send('No se encontró el evento asociado a esta conexión.');

        const tokens = await mp.intercambiarCodigoOAuth(code);
        await eventosDb.conectarMercadoPago(evento.id, {
            accessToken: tokens.access_token, refreshToken: tokens.refresh_token, userId: tokens.user_id
        });

        res.redirect(`/eventos/${evento.id}?conectado=1`);
    } catch (error) {
        console.error('Error al conectar con Mercado Pago:', error);
        res.status(500).send('Hubo un error al conectar tu cuenta de Mercado Pago. Volvé a intentarlo desde tu panel.');
    }
});

module.exports = router;
