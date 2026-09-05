# Guía de pruebas locales

Cómo levantar el proyecto en tu máquina y probar de punta a punta antes de deployar a Railway.
Los comandos son para PowerShell (Windows), pero funcionan igual en cualquier terminal.

---

## 1. Requisitos

- **Node.js 18 o superior** (el código usa `fetch` nativo, que no existe en Node 16).
  Verificá con: `node -v`
- **MySQL 8** corriendo localmente (ver paso 3).

---

## 2. Instalar dependencias

```powershell
npm install
```

Esto instala también las dos que se agregaron últimamente (`sharp` para comprimir flyers y
`jsonwebtoken` para el login de la app de guardias).

---

## 3. Levantar MySQL

**Opción A — con Docker (lo más rápido, no ensucia la máquina):**

```powershell
docker run --name evento-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=evento_listo -p 3306:3306 -d mysql:8
```

Para frenarlo/arrancarlo después: `docker stop evento-mysql` / `docker start evento-mysql`.

**Opción B — MySQL instalado localmente:** creá la base a mano.

```sql
CREATE DATABASE evento_listo CHARACTER SET utf8mb4;
```

---

## 4. Configurar el `.env`

Copiá `.env.example` a `.env` y completá. Para una prueba local alcanza con esto:

```env
MYSQL_URL=mysql://root:root@localhost:3306/evento_listo
BASE_URL=http://localhost:3000
PORT=3000

# Inventá strings largos y random para estos tres:
SESSION_SECRET=pon-aca-una-cadena-larga-random
JWT_SECRET=otra-cadena-larga-random
MP_WEBHOOK_SECRET=otra-mas

# Tu usuario admin: se crea solo la primera vez que arranca la app.
ADMIN_SEED_EMAIL=admin@local.test
ADMIN_SEED_PASSWORD=unaClaveSegura123
ADMIN_EMAIL=admin@local.test

# Credenciales reales (sandbox) — ver notas abajo.
MP_CLIENT_ID=
MP_CLIENT_SECRET=
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
IMGBB_API_KEY=
```

> **Importante:** la app **no arranca** si falta alguna variable obligatoria — te dice cuál en
> la consola. `QR_SECRET` quedó opcional (solo se usa para migrar eventos viejos).

Notas sobre las credenciales externas:
- **IMGBB_API_KEY**: gratis en <https://api.imgbb.com/>. Sin esto no podés crear eventos
  (falla al subir el flyer).
- **BREVO_API_KEY / BREVO_SENDER_EMAIL**: si no las ponés, la app arranca igual pero el envío
  de entradas por mail falla (queda logueado en consola, no rompe la compra).
- **MP_CLIENT_ID / MP_CLIENT_SECRET**: de tu app Marketplace en el panel de desarrolladores
  de Mercado Pago.

---

## 5. Migraciones

**No hay comando aparte.** Las migraciones corren solas al arrancar el servidor
(`inicializarDB()` en `db/pool.js`): crea las tablas que falten y agrega las columnas nuevas
de forma idempotente. Vas a ver en consola:

```
Base de datos MySQL lista (usuarios + eventos + tipos_entrada + tickets + compras + cupones + guardias).
```

---

## 6. Arrancar el servidor

```powershell
npm start
```

Abrí <http://localhost:3000>.

---

## 7. Prueba de punta a punta

### 7.1 Entrar como admin

1. Andá a <http://localhost:3000/login>.
2. Entrá con el `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` del `.env`.

### 7.2 Crear el evento con varios tipos

1. **Crear evento** → completá datos, **ubicación** (lugar, dirección, ciudad, link de Maps) y
   el primer tipo de entrada con **nombre y descripción**.
2. Tildá "Agregar un segundo tipo de entrada" y cargá uno más caro (ej: General $1000 / VIP $5000)
   — así verificás que la tarifa de servicio ahora sea **proporcional al precio de cada uno**.
3. Desde **Editar evento** podés agregar más tipos, editarlos, desactivarlos o borrarlos.

### 7.3 Conectar Mercado Pago (o saltearlo)

La página pública de venta solo aparece si el evento tiene MP conectado. Dos caminos:

**Camino real (necesita URL pública, ver sección 8).** Botón "Conectar con Mercado Pago" en el
panel del evento.

**Atajo para probar solo el carrito** (sin pagar de verdad): marcá el evento como conectado
a mano en MySQL.

```sql
UPDATE eventos SET conectado_mp = 1, activo = 1, mp_access_token = 'TEST-fake' WHERE id = 1;
```

Con esto ya podés entrar a `/evento/1` y probar **todo el carrito, los cupones y los totales**.
Lo único que va a fallar es el botón final de pago (el token es falso).

### 7.4 Probar el carrito mixto

En `/evento/<id>`:

- [ ] Los selectores de cada tipo arrancan en **0** y el botón de pago está **deshabilitado**.
- [ ] Con `+` / `−` se arma un carrito mixto (ej. 2 General + 1 VIP).
- [ ] El `+` se apaga al llegar al stock de ese tipo o al máximo de 5 por compra.
- [ ] El resumen muestra Subtotal / Descuento / Tarifa / **Total Final**, y la tarifa sube más
      con la VIP que con la General.
- [ ] Un cupón (creado desde Editar evento) aplica sobre el carrito completo y se **revalida
      solo** al cambiar cantidades.

### 7.5 Probar el pago (necesita sección 8)

- [ ] "Pagar con Mercado Pago" lleva al checkout con el **total exacto** del resumen.
- [ ] Pagás con una tarjeta de prueba de MP (`APRO` como nombre del titular para que aprueba).
- [ ] Volvés a `/success?checkout=...` y llega el mail con el PDF.
- [ ] En el panel: la venta aparece, el cupo de **cada tipo** bajó lo que corresponde.

### 7.6 Resto de las funciones

- [ ] **Cortesías**: emitir eligiendo tipo → verificar que el cupo de ESE tipo baje.
- [ ] **Evento finalizado**: "Marcar como finalizado" → el panel pasa a solo lectura y el
      evento se mueve al acordeón de finalizados en Mis eventos.
- [ ] **Validación de QR**: abrí el link de guardia y escaneá una entrada.

---

## 8. El punto que sí o sí necesita URL pública

Mercado Pago **no acepta `localhost`** en las `back_urls` cuando se usa `auto_return`, ni como
`redirect_uri` del OAuth. Para probar el pago real necesitás exponer tu servidor:

```powershell
ngrok http 3000
```

Con la URL que te da (ej. `https://abc123.ngrok-free.app`):

1. Cambiá en el `.env`: `BASE_URL=https://abc123.ngrok-free.app`
2. **Reiniciá el servidor** (la `BASE_URL` se lee al arrancar).
3. En el panel de desarrolladores de Mercado Pago, configurá esa URL como:
   - Redirect URI del OAuth: `https://abc123.ngrok-free.app/oauth/mercadopago/callback`
   - Webhook: `https://abc123.ngrok-free.app/webhooks/mercadopago`

> Si no querés lidiar con esto ahora, hacé todo lo de 7.4 y 7.6 con el atajo del 7.3 — cubre
> casi todos los cambios nuevos. Lo único que queda sin probar es el cobro real.

---

## 9. Chequeos útiles

**Ver cómo quedó el cupo de cada tipo:**

```sql
SELECT id, nombre, precio, cupo_total, cupo_vendido, (cupo_total - cupo_vendido) AS disponible
FROM tipos_entrada WHERE evento_id = 1;
```

**Ver qué se cobró realmente en cada compra:**

```sql
SELECT payment_id, cantidad, monto_total, comision_mp_real, monto_neto_organizador
FROM compras WHERE evento_id = 1;
```

**Ver los carritos guardados (lo que viaja a MP como token):**

```sql
SELECT token, evento_id, datos, creado_en FROM checkouts ORDER BY creado_en DESC LIMIT 5;
```

---

## 10. Antes de deployar a Railway

- [ ] Cargá en Railway **todas** las variables del `.env` (sobre todo las nuevas: `JWT_SECRET`,
      `MP_WEBHOOK_SECRET`).
- [ ] `BASE_URL` apuntando al dominio de Railway.
- [ ] Reconfigurá en Mercado Pago el redirect URI y el webhook con ese dominio.
- [ ] Al primer arranque, las migraciones corren solas: mirá los logs para confirmar que no
      hubo errores.
