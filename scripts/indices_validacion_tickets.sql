-- Índices para que el escaneo de tickets en la puerta sea rápido (< 200ms)
-- =========================================================================

-- id (id_entrada): NO hace falta crear nada — ya es PRIMARY KEY de `tickets`, o sea ya es
-- un índice BTREE único. Es la clave que usan tanto el SELECT como el UPDATE del validador
-- (db/tickets.js: obtenerTicketConEvento / marcarComoUsada), así que ya es lo más rápido
-- posible (lookup directo, sin escanear filas).

-- evento_id: técnicamente InnoDB ya crea un índice automático acá porque es FOREIGN KEY
-- (REFERENCES eventos(id)), pero lo hacemos explícito para no depender de ese comportamiento
-- implícito y documentar la intención.
CREATE INDEX idx_tickets_evento_id ON tickets (evento_id) USING BTREE;

-- estado: se filtra por 'Usada' vs 'Válida' en reportes (resumenVentas) y en el volcado que
-- descarga el celular del guardia para el modo offline (obtenerTicketsDeEvento).
CREATE INDEX idx_tickets_estado ON tickets (estado) USING BTREE;

-- Compuesto (evento_id, estado): cubre el patrón real más pesado — "todos los tickets DE
-- ESTE evento con tal estado" (obtenerTicketsDeEvento, resumenVentas) — en un solo índice,
-- sin tener que combinar dos índices simples en tiempo de consulta.
CREATE INDEX idx_tickets_evento_estado ON tickets (evento_id, estado) USING BTREE;
