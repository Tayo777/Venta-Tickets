-- Idempotencia de pagos de Mercado Pago (evitar tickets duplicados si el webhook llega 2 veces)
-- ============================================================================================

-- 1) NO poner UNIQUE en tickets.payment_id: una sola compra de N entradas guarda N filas en
--    `tickets`, todas con el MISMO payment_id a propósito (una fila por ticket individual).
--    Un UNIQUE ahi rompería cualquier compra de más de 1 entrada.
--
--    ALTER TABLE tickets ADD UNIQUE INDEX uniq_payment_id (payment_id);  -- <-- NO HACER ESTO

-- 2) La idempotencia real va en `compras`: una fila por PAGO (no por ticket), y ahí sí
--    payment_id es naturalmente único. Ya está así desde el schema original (db/pool.js):
--
--        payment_id VARCHAR(50) NOT NULL UNIQUE
--
--    Si por algún motivo tu tabla `compras` ya existe SIN el índice único, aplicalo así
--    (revisá antes con SHOW INDEX FROM compras; si ya existe, este ALTER tira error de nombre
--    duplicado, es esperable y no pasa nada):
ALTER TABLE compras ADD UNIQUE INDEX uniq_compras_payment_id (payment_id);

-- 3) Índice NO único en tickets.payment_id: no aporta idempotencia, pero acelera el JOIN que
--    ya hace db/eventos.js (listadoVentas) para cruzar tickets con su compra.
CREATE INDEX idx_tickets_payment_id ON tickets (payment_id);
