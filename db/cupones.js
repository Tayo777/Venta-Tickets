const { pool } = require('./pool');

async function obtenerCuponPorCodigo(codigo) {
    const [filas] = await pool.query('SELECT * FROM cupones WHERE codigo = ?', [String(codigo).trim().toUpperCase()]);
    return filas[0] || null;
}

// Calcula el descuento en pesos sobre un subtotal dado. Nunca devuelve más que el subtotal
// (no se puede "cobrar negativo") ni un número con más de 2 decimales.
function calcularDescuento(cupon, subtotal) {
    const bruto = cupon.tipo === 'porcentaje'
        ? subtotal * (Number(cupon.valor) / 100)
        : Number(cupon.valor);
    const descuento = Math.max(0, Math.min(bruto, subtotal));
    return Math.round(descuento * 100) / 100;
}

// IDs de los tipos de entrada a los que está limitado un cupón. Array vacío = sin límite,
// aplica a todos los tipos del evento.
async function obtenerTiposDeCupon(cuponId) {
    const [filas] = await pool.query('SELECT tipo_entrada_id FROM cupones_tipos WHERE cupon_id = ?', [cuponId]);
    return filas.map((f) => f.tipo_entrada_id);
}

// Validación completa de un cupón contra el CARRITO del comprador. Es de solo lectura (no
// reserva ni descuenta nada) — se llama tanto desde el preview del frontend como, de nuevo,
// del lado del servidor en /crear-pago justo antes de cobrar (nunca se confía en un descuento
// que haya calculado el navegador).
//
// `lineas` = [{ tipoEntrada, cantidad }]. El descuento se calcula SOLO sobre las líneas cuyo
// tipo esté habilitado para este cupón: si alguien aplica un cupón de VIP a un carrito que
// además lleva Generales, la parte General se paga entera.
async function validarCupon(codigo, eventoId, lineas) {
    if (!codigo || !String(codigo).trim()) {
        return { valido: false, motivo: 'Ingresá un código de cupón.' };
    }

    const cupon = await obtenerCuponPorCodigo(codigo);
    if (!cupon) return { valido: false, motivo: 'El cupón no existe.' };
    if (!cupon.activo) return { valido: false, motivo: 'El cupón ya no está activo.' };
    if (cupon.evento_id !== null && Number(cupon.evento_id) !== Number(eventoId)) {
        return { valido: false, motivo: 'Este cupón no es válido para este evento.' };
    }
    if (cupon.usos_maximos !== null && cupon.usos_actuales >= cupon.usos_maximos) {
        return { valido: false, motivo: 'Este cupón alcanzó su límite de usos.' };
    }

    const tiposHabilitados = await obtenerTiposDeCupon(cupon.id);
    const aplicaATodos = tiposHabilitados.length === 0;
    const lineasElegibles = aplicaATodos
        ? lineas
        : lineas.filter((l) => tiposHabilitados.includes(l.tipoEntrada.id));

    if (lineasElegibles.length === 0) {
        return { valido: false, motivo: 'Este cupón no aplica a los tipos de entrada que elegiste.' };
    }

    const subtotalElegible = lineasElegibles.reduce((acc, l) => acc + Number(l.tipoEntrada.precio) * l.cantidad, 0);
    const subtotalCarrito = lineas.reduce((acc, l) => acc + Number(l.tipoEntrada.precio) * l.cantidad, 0);

    const descuento = calcularDescuento(cupon, subtotalElegible);
    return {
        valido: true,
        cupon,
        descuento,
        aplicaATodos,
        // Nombres de los tipos sobre los que efectivamente pegó el descuento, para poder
        // avisarle al comprador cuando el cupón cubre solo una parte del carrito.
        tiposAplicados: lineasElegibles.map((l) => l.tipoEntrada.nombre),
        nuevoSubtotal: Math.round((subtotalCarrito - descuento) * 100) / 100
    };
}

// Contador informativo: se llama DESPUÉS de confirmar el pago (ver services/procesarPago.js),
// nunca antes de cobrar. La barrera real contra el sobreuso es validarCupon() en /crear-pago;
// esto solo lleva la cuenta de cuántas veces se usó de verdad.
async function incrementarUso(codigo) {
    await pool.query('UPDATE cupones SET usos_actuales = usos_actuales + 1 WHERE codigo = ?', [String(codigo).trim().toUpperCase()]);
}

// --- Gestión desde el panel del organizador (siempre scoped a UN evento puntual) ---

// `tiposIds` vacío o sin pasar = el cupón aplica a TODOS los tipos del evento.
// Va en transacción para que un cupón nunca quede creado a medias (sin sus tipos), lo que lo
// dejaría aplicando a todo por error.
async function crearCupon({ eventoId, codigo, tipo, valor, usosMaximos, tiposIds = [] }) {
    const conexion = await pool.getConnection();
    try {
        await conexion.beginTransaction();
        const [resultado] = await conexion.query(
            'INSERT INTO cupones (evento_id, codigo, tipo, valor, usos_maximos) VALUES (?, ?, ?, ?, ?)',
            [eventoId, String(codigo).trim().toUpperCase(), tipo, valor, usosMaximos || null]
        );

        for (const tipoId of tiposIds) {
            await conexion.query(
                'INSERT INTO cupones_tipos (cupon_id, tipo_entrada_id) VALUES (?, ?)',
                [resultado.insertId, tipoId]
            );
        }
        await conexion.commit();
        return resultado.insertId;
    } catch (err) {
        await conexion.rollback();
        throw err;
    } finally {
        conexion.release();
    }
}

// Devuelve cada cupón con `tipos_ids`: los tipos a los que está limitado (array vacío = todos).
async function obtenerCuponesDeEvento(eventoId) {
    const [filas] = await pool.query('SELECT * FROM cupones WHERE evento_id = ? ORDER BY id DESC', [eventoId]);
    if (filas.length === 0) return [];

    const [relaciones] = await pool.query(
        `SELECT ct.cupon_id, ct.tipo_entrada_id, te.nombre
         FROM cupones_tipos ct
         JOIN tipos_entrada te ON te.id = ct.tipo_entrada_id
         WHERE ct.cupon_id IN (?)`,
        [filas.map((f) => f.id)]
    );

    return filas.map((cupon) => {
        const propias = relaciones.filter((r) => r.cupon_id === cupon.id);
        return {
            ...cupon,
            tipos_ids: propias.map((r) => r.tipo_entrada_id),
            tipos_nombres: propias.map((r) => r.nombre)
        };
    });
}

// El WHERE incluye evento_id a propósito: así el dueño del evento A nunca puede borrar o
// desactivar un cupón del evento B, aunque adivine/manipule el id en el POST.
async function eliminarCupon(cuponId, eventoId) {
    // Primero las filas hijas: la foreign key de cupones_tipos bloquea el DELETE del cupón.
    await pool.query(
        `DELETE ct FROM cupones_tipos ct
         JOIN cupones c ON c.id = ct.cupon_id
         WHERE ct.cupon_id = ? AND c.evento_id = ?`,
        [cuponId, eventoId]
    );
    await pool.query('DELETE FROM cupones WHERE id = ? AND evento_id = ?', [cuponId, eventoId]);
}

async function toggleActivo(cuponId, eventoId) {
    await pool.query('UPDATE cupones SET activo = NOT activo WHERE id = ? AND evento_id = ?', [cuponId, eventoId]);
}

module.exports = {
    obtenerCuponPorCodigo, validarCupon, incrementarUso,
    crearCupon, obtenerCuponesDeEvento, eliminarCupon, toggleActivo
};
