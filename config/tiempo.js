// Zona horaria única de toda la app: Argentina (UTC-3, sin horario de verano desde 2009).
//
// El problema que resuelve: Railway corre los contenedores en UTC. Sin esto, MySQL guardaba
// NOW() en UTC, Node interpretaba esas fechas en UTC y las vistas las formateaban en UTC —
// resultado: cada compra y cada escaneo se mostraban 3 horas adelantadas respecto de la hora
// real en Argentina, y el gráfico de "flujo de ingreso por hora" corría las barras 3 horas.
//
// La decisión es tener UN solo huso de punta a punta (MySQL, Node y el render), en vez de
// guardar en UTC y convertir al mostrar. Motivo concreto: los formularios de fecha del panel
// son <input type="datetime-local">, que mandan hora local de Argentina como texto plano
// ("2026-09-05T22:00"). Ese texto se guarda tal cual, así que la base ya venía trabajando en
// hora local; lo que faltaba era que Node y MySQL estuvieran de acuerdo en cuál es.
//
// Como Argentina no tiene DST, el offset fijo -03:00 es correcto todo el año y no depende de
// que el contenedor de MySQL tenga cargadas las tablas de husos horarios (CONVERT_TZ con
// nombres tipo 'America/Argentina/Buenos_Aires' falla en instalaciones sin esas tablas).
const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';
const OFFSET_MYSQL = '-03:00';

module.exports = { ZONA_HORARIA, OFFSET_MYSQL };
