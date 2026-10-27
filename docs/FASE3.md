# Fase 3 · enlaces cortos, estadísticas y bloqueos

Todo lo de las Fases 1 y 2 sigue igual; esto se **añade** (4 migraciones nuevas, 2 workflows nuevos y un cambio mínimo en el 01).
Instalación: [INSTALACION.md](INSTALACION.md) · Dominio (DNS y proxy): [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md) · Pruebas: [PRUEBAS.md](PRUEBAS.md).

| # | Qué | Dónde |
|---|---|---|
| 1 | **Acortador**: `l.rocketnova.io/instagram` → 302 al formulario de reserva con `?origen=instagram`; cuenta cada clic sin retrasar la redirección | workflow `06-enlaces-cortos` · RPC `resolve_link`, `register_click` · tablas `links`, `link_clicks_daily` |
| 1b | La reserva **guarda el origen** | campo oculto `origen` en el formulario del workflow `01` → `bookings.source` |
| 2 | **Formulario para crear enlaces** (equipo), protegido con usuario y contraseña | workflow `07-crear-enlace` · RPC `create_link` |
| 3 | **Estadísticas** para el panel: clics y reservas por enlace, conversión por canal | vistas `stats_links`, `stats_channels`, `stats_clicks_daily` · [consultas/estadisticas.sql](../supabase/consultas/estadisticas.sql) |
| 4 | **Bloqueos**: verificados (vacaciones, festivos, huecos sueltos) + detección de turnos afectados | vista `blocks_affected_bookings`, función `bookings_affected_by()` · [consultas/bloqueos.sql](../supabase/consultas/bloqueos.sql) |

## Decisiones que he tomado (cámbialas si no te valen)

| Tema | Decisión | Dónde se cambia |
|---|---|---|
| **Slug** | Minúsculas, números y guiones; sin guion al principio ni al final ni dobles; 1 a 40 caracteres. **No se corrige en silencio** (si escriben `Instagram`, se avisa). **No se puede renombrar** (rompería las estadísticas): se desactiva y se crea otro | restricción `links_slug_format` |
| **Destino** | Vacío = el formulario de reserva (`settings.booking_form_url`). Solo `https://` y solo **dominios permitidos** (`settings.link_allowed_domains`, que admite también sus subdominios). No puede apuntar al propio dominio corto (bucle) ni llevar ya `origen=` (lo añade el sistema) | tabla `settings` |
| **Canal** | Opcional: agrupa varios enlaces (`instagram-bio` e `instagram-stories` → canal `instagram`). Vacío = el propio slug. «Enlace» y «canal» son lo mismo mientras no uses el campo | `links.channel` |
| **Qué es un clic** | Una carga del enlace corto por una persona. **No suman**: bots, previsualizadores de enlaces (WhatsApp, Slack, Facebook…), `curl`/scripts, monitores y peticiones sin `User-Agent` (sí se les redirige). Las visitas repetidas de una misma persona sí suman | `n8n/fuente/code/06_preparar_redireccion.js` |
| **Qué es una reserva** (para la conversión) | Todo turno creado con ese origen, **aunque se cancele después** (también tienes `bookings_not_cancelled`) | vistas |
| **Origen raro** | Si `?origen=` no tiene forma de slug (o pasa de 40 caracteres) se guarda **vacío**, y las mayúsculas se pasan a minúsculas. **La reserva nunca falla por eso** | trigger `bookings_normalize_source` |
| **Protección del formulario de creación** | Usuario y contraseña (*Basic Auth* de n8n) en un formulario de **una sola página** (ver 2) | credencial `Formulario del equipo (usuario y contraseña)` |
| **Slug inexistente / desactivado** | 302 a `settings.link_default_url` y no cuenta. Si Supabase no responde, 302 a `url_respaldo` (nodo *Configuración* del workflow 06) | ajustes |
| **Ruta del webhook** | Ruta dinámica `:slug` → `/webhook/<id>/<slug>`; el proxy del dominio traduce `/<slug>` a esa ruta | [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md) |

---

## 1 · Acortador de enlaces

```
persona abre  l.rocketnova.io/instagram
   │ (proxy: /instagram → /webhook/<id>/instagram)
   ▼
workflow 06 ── resolve_link('instagram') ───────▶ Supabase  (SOLO LEE: devuelve la URL ya validada)
   │ 302 Location: https://TU-N8N/form/reservar-turno?origen=instagram     ◀── la persona recibe esto YA
   ▼
   register_click('instagram') ───────────────▶ Supabase  (+1 atómico, DESPUÉS de responder)
```

* **El formulario recoge el origen como campo oculto.** El workflow 01 tiene un campo `origen` (tipo *Hidden Field*) que n8n rellena con `?origen=…`. Al reservar, `book_slot` lo guarda en `bookings.source`. Probado de principio a fin con el navegador (E31): clic en el enlace corto → formulario → turno → `source = 'e2e-book'`.
* **La redirección no espera al recuento** (E29: con el recuento frenado 3 s a propósito, el 302 llega en menos de 2 s y el clic se anota después). Y un fallo al contar **no** estropea la redirección.
* **Un clic cuenta una vez** (E26: una visita → `click_count` = 1 y se mantiene tras esperar; 10 visitas simultáneas → +10 exactos; T70: 20 conexiones × 10 clics = 200 exactos).
* **Respuestas:**

| Petición | Respuesta | ¿Cuenta? |
|---|---|---|
| Slug activo, persona | `302` a `destino?origen=slug` (con `Cache-Control: no-store`) | **sí** |
| Slug activo, bot / previsualizador / `curl` | `302` igual | no |
| Slug inexistente, desactivado o raro (`../x`, mayúsculas, 10 000 caracteres…) | `302` a la página por defecto | no |
| Ni la página por defecto es válida | `404` sin `Location` | no |
| Supabase no responde | `302` a `url_respaldo` | no |
| `HEAD` (y cualquier método que no sea `GET`) | `404` de n8n (`HEAD` probado) | no |

### Seguridad de la redirección (redirecciones abiertas)

El destino se valida en **tres sitios** con **una sola función** (`_link_destination_error`):

1. **Al crear** (`create_link`, que usa el formulario) → error claro para la persona.
2. **En la base de datos** (trigger `links_guard`) → también las altas y ediciones **a mano en el panel**.
3. **En cada clic** (`resolve_link`) → aunque alguien meta un destino saltándose el trigger, o acorte después la lista de dominios, el clic **no** redirige allí: va a la página por defecto (E35 lo fuerza con 5 destinos maliciosos).

Qué se rechaza (T63 prueba 78 destinos maliciosos y 11 legítimos): otro dominio · `rocketnova.io.evil.com` · `evilrocketnova.io` · `https://rocketnova.io@evil.com` (credenciales) · `\` · `//evil.com` · `javascript:`, `data:`, `ftp:`, `http:` · espacios, tabuladores, saltos de línea y cualquier carácter no ASCII (dominios homógrafos) · `< > " ' \` { } | ^` · IP y `localhost` · dominios de un solo nivel (`com`) · más de 2000 caracteres. El host debe ser **igual** a un dominio permitido o **terminar en `.dominio`**.

> `localhost` y `http://` solo se aceptan si pones `localhost` en `link_allowed_domains` (para pruebas). En producción no lo pongas.

### El contador no se puede manipular desde fuera

* `links` y `link_clicks_daily` tienen **RLS sin políticas** y sin permisos para `anon`/`authenticated`; `register_click` y `resolve_link` solo las ejecuta `service_role` (la clave que guarda n8n). Desde la API de Supabase con la clave pública no se puede ni leer, ni escribir, ni llamar a la función (T72 en SQL, **E36 contra la API real**).
* El único camino al contador es **visitar el enlace**. Subirlo visitándolo en bucle es posible (es lo que hace un clic): por eso el proxy debe limitar peticiones por IP ([DOMINIO-ENLACES.md](DOMINIO-ENLACES.md)) y por eso no cuentan bots.
* Total y desglose por días suben en **la misma sentencia**, así que siempre coinciden. Un administrador sí puede editar `click_count` a mano en el panel; la consulta 7 de `estadisticas.sql` lo detecta.

---

## 2 · Formulario para crear enlaces (equipo)

`https://TU-N8N/form/crear-enlace` · tres campos: **Slug**, **Destino** (opcional), **Canal** (opcional).

Toda la validación vive en `create_link()` (base de datos), no en n8n: formato del slug, slug único (el índice único decide si dos personas lo crean a la vez: gana una y la otra recibe «ese slug ya existe»), destino permitido, bucle, `origen=` repetido, canal. Las pantallas de error están probadas (E34).

### Cómo está protegido (y alternativas)

| Método | Estado | Comentario |
|---|---|---|
| **Basic Auth del Form Trigger** (usuario + contraseña en una credencial de n8n) | ✅ **implementado y probado** (E33) | Sin credenciales o con unas erróneas, **ni el GET ni el POST** pasan (401) y no se crea nada. Una credencial compartida por el equipo. Úsalo **solo por HTTPS** (Basic Auth va en base64) |
| **Autenticación de usuario de n8n** (`n8nUserAuth`, Form Trigger ≥ 2.6) | alternativa, **no probada aquí** | Cada persona entra con su cuenta de n8n (nombre propio, se puede revocar a una persona sin cambiar la clave de todas, y n8n da el usuario en la ejecución). Se cambia en el nodo *Formulario de enlaces* → *Authentication*. Es mejor si ya tenéis cuentas en n8n |
| Restringir por **IP / VPN / Cloudflare Access** delante de n8n | complemento recomendado | Que `/form/crear-enlace` solo se pueda abrir desde la oficina o con login corporativo |

Por qué el formulario es de **una sola página**: en n8n, las páginas siguientes de un formulario son otra URL (`/form-waiting/<ejecución>?signature=…`); con una sola página, lo único que ejecuta la acción es el envío protegido por la contraseña, y las pantallas finales solo muestran un resultado.

**Pasos:** crea la credencial *Basic Auth* de n8n («Formulario del equipo (usuario y contraseña)») con una **contraseña larga**, y ponle un límite de intentos en el proxy (anti fuerza bruta).

---

## 3 · Estadísticas (panel de Supabase)

Tres vistas de **solo lectura** (solo el panel y `service_role`; `anon` no las ve, E36):

| Vista | Una fila por… | Columnas clave |
|---|---|---|
| `stats_links` | enlace | `slug`, `channel`, `clicks`, `bookings`, `bookings_not_cancelled`, `bookings_cancelled`, `bookings_attended`, `bookings_no_show`, **`conversion_pct`**, `last_click_at` |
| `stats_channels` | canal | `links`, `clicks`, `bookings`, …, **`conversion_pct`** |
| `stats_clicks_daily` | enlace y día local | `clicks` |

```sql
select * from stats_links;       -- clics y reservas por ENLACE
select * from stats_channels;    -- conversión por CANAL
```

* **Conversión % = reservas / clics × 100** (vacía si no hay clics). Es **orientativa**: una persona puede hacer varios clics, o reservar más tarde desde otro dispositivo, o compartir el enlace del formulario con `?origen=` (reserva sin clic → puede pasar de 100 %).
* **Las reservas no se pierden ni se cuentan dos veces:** `stats_channels` incluye `directo` (sin origen) y orígenes escritos a mano sin enlace corto (`links = 0`, sin conversión). La suma de reservas de todos los canales es **siempre** el total de `bookings` (T74, E37).
* **Datos de prueba** (T74): `ig` 10 clics y 4 reservas (1 cancelada, 1 asistida) → **40,0 %**; `fb` 6 clics y 2 reservas → 33,3 %; `tt` 4 clics y 1 reserva → 25 %; `fb`+`tt` agrupados en el canal `st-social` → 10 clics, 3 reservas → **30,0 %**; origen manual sin enlace → 1 reserva y sin conversión; reservas sin origen → `directo`.
* [`consultas/estadisticas.sql`](../supabase/consultas/estadisticas.sql) trae 8 consultas listas (histórico, **por periodo** —últimos 30 días, editable—, evolución diaria, estados por canal, enlaces sin actividad y 2 comprobaciones de integridad); todas se ejecutan en las pruebas (T81).

---

## 4 · Bloqueos: qué quitan, qué no tocan y cómo detectarlo

### Validado: los bloqueos quitan horas del desplegable
Los bloqueos (`blocks`) ya los descontaba `_available_slots` desde la Fase 1; ahora hay pruebas de cada forma que pediste, **en SQL y en el formulario real con el navegador**:

| Caso | Regla | Pruebas |
|---|---|---|
| **Vacaciones** (varios días) | Un bloqueo de `00:00` del primer día a `00:00` del día **después** del último. Esos días no ofrecen nada y el formulario propone el primer día libre posterior. A media jornada también (jueves 14:00 → lunes 13:00) | T75 · E39 |
| **Festivo** (un día entero) | Igual con un solo día. Global (`service_id` vacío) o de un servicio | T76 · E39 |
| **Hueco suelto** (reunión, cita…) | Con horas (11:15–12:05). Quita **solo** las horas que se solapan: aquí 11:00, 11:30 y 12:00; **los bordes exactos siguen libres** (el rango es `[desde, hasta)`); 5 minutos bastan para quitar una hora | T77 · E38 |
| Cambios | Acortar un bloqueo o borrarlo devuelve las horas; bloqueos solapados se suman; uno pasado o de otro día no estorba | T78 |

Las horas se interpretan en la zona `settings.timezone`. Escribe las fechas en el SQL Editor con `('2026-12-24'::date + time '00:00') at time zone 'Europe/Madrid'` (el panel muestra UTC).

> **Una cosa a saber:** el descanso (`break_minutes`) **no** se bloquea. Si un turno acaba a las 10:30 con 10 min de descanso y un bloqueo empieza a las 10:35, la hora de las 10:30 sigue ofreciéndose: el bloqueo solo mira la duración del turno.

### Un bloqueo creado sobre turnos ya confirmados **no los borra**
Es deliberado: no se cancela a nadie sin que lo decida una persona. El turno sigue `confirmed`, sin tocar ni una columna (T80: comparación fila a fila antes y después), la hora **no se ofrece a nadie más**, y quien tiene el turno puede **cancelarlo** o **cambiarlo a otra hora libre** (no a una bloqueada) con su enlace de siempre (T80, E40).

### Cómo detectarlos

```sql
select * from blocks_affected_bookings;      -- los turnos confirmados y futuros que caen dentro de algún bloqueo
```

| Columna | Qué es |
|---|---|
| `block_reason`, `block_starts_local`, `block_ends_local`, `block_service_id` | el bloqueo (`block_service_id` vacío = global) |
| `service_name`, `starts_local`, `starts_at`, `ends_at` | el turno |
| `customer_name`, `customer_email`, `customer_phone` | a quién avisar |
| `booked_before_block` | `true` = el turno es anterior al bloqueo (lo normal); `false` = alguien lo dio de alta a mano **después** |

* Solo turnos **confirmados** y que **no han terminado**. Cancelados, asistidos, no presentados y pasados no salen. Que el bloqueo empiece justo cuando acaba el turno **no** es un solape (T79 prueba los bordes y los solapes parciales).
* **Antes** de crear el bloqueo: `select * from bookings_affected_by(null, '2026-12-24 00:00 Europe/Madrid', '2026-12-27 00:00 Europe/Madrid');` (`null` = todos los servicios).
* **Procedimiento recomendado al bloquear días:** ① `bookings_affected_by(...)` para ver a quién afectaría → ② crear el bloqueo → ③ `select * from blocks_affected_bookings` → ④ avisar a esas personas y cancelar o mover sus turnos (al cancelar a mano, `status = 'cancelled'`, salen de la vista y no reciben recordatorio).
* [`consultas/bloqueos.sql`](../supabase/consultas/bloqueos.sql) trae además la lista de bloqueos vigentes con su número de turnos afectados y una plantilla para crear bloqueos con hora de Madrid.

> Esta entrega **no avisa automáticamente** a quien atiende cuando un bloqueo cae sobre turnos (se miró y se dejó fuera para no alterar el resumen diario de la Fase 2). Se podría añadir una línea «turnos afectados por bloqueos» al resumen de las 08:00 leyendo la misma vista.

---

## 5 · Qué cambió de las Fases 1 y 2 (y qué no)

| Archivo | Cambio |
|---|---|
| Migraciones `20261020…` y `20261021…` | **Sin tocar.** Todo va en las 4 migraciones nuevas |
| Workflow 01 | + campo oculto `origen` en el *Formulario de reserva* · `Preparar reserva` lee ese campo (y solo lo pasa si tiene forma de slug). Nada más |
| Workflows 02, 03, 04, 05, 99 | **Sin tocar** (se regeneran con el mismo tamaño y se vuelven a probar) |
| `bookings` | + trigger `bookings_normalize_source` (minúsculas o vacío). `book_slot` **no cambia** (ya guardaba `p_source`) |
| Pruebas | **T02** (ahora 9 tablas con RLS). Nada más; el resto de T01–T60 y E01–E25 sin cambios |
| Entorno de pruebas | `run-tests.mjs` crea la base en UTF-8 (como Supabase) para probar Unicode; `stack.mjs` y `n8n-local.mjs` añaden los ajustes y la credencial de la Fase 3 |

## 6 · Migraciones nuevas

| Archivo | Contenido |
|---|---|
| `20261022000001_fase3_enlaces_tablas.sql` | ajustes, `_link_destination_error()`, tablas `links` y `link_clicks_daily`, triggers (`links_guard`, `bookings_normalize_source`) |
| `20261022000002_fase3_enlaces_rpc.sql` | `create_link`, `resolve_link`, `register_click` (+ `_register_click`) |
| `20261022000003_fase3_estadisticas_y_bloqueos.sql` | vistas `stats_*`, `blocks_affected_bookings`, `bookings_affected_by()` |
| `20261022000004_fase3_seguridad.sql` | RLS, permisos de tablas, vistas y funciones (solo `service_role`) |

## 7 · Ajustes nuevos (tabla `settings`)

| Clave | Por defecto | Para qué |
|---|---|---|
| `booking_form_url` | `https://TU-N8N/form/reservar-turno` | destino por defecto de un enlace nuevo. **Cámbialo** (y debe estar en un dominio permitido) |
| `link_base_url` | `https://l.rocketnova.io` | dominio corto: se muestra al crear el enlace y evita bucles |
| `link_default_url` | `https://rocketnova.io` | adónde va quien abre un slug que no existe |
| `link_allowed_domains` | `rocketnova.io` | dominios (y sus subdominios) a los que puede redirigir un enlace. **Añade el de tu n8n** si no cuelga de `rocketnova.io` |

## 8 · Qué mirar si algo no va

```sql
-- el enlace existe y a dónde llevaría ahora mismo (lo que haría el workflow 06)
select resolve_link('instagram');
-- ¿se cuentan los clics? total y por días deben coincidir (0 filas = bien)
select l.slug, l.click_count, coalesce(sum(d.clicks), 0) from links l left join link_clicks_daily d on d.link_id = l.id group by l.id having l.click_count <> coalesce(sum(d.clicks), 0);
-- enlaces cuyo destino ya no está permitido (se acortó la lista de dominios): no redirigen a él
select slug, destination from links where active and _link_destination_error(destination) is not null;
```
(La última se ejecuta en el SQL Editor; esa función no está disponible por la API.) Más: [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md) §6.

## 9 · Límites conocidos

* **Un clic es una carga del enlace, no una persona única.** Si alguien recarga, suma. La detección de bots es por `User-Agent` (lista fija en `06_preparar_redireccion.js`): bots que se hagan pasar por navegadores sí sumarán. El proxy debe limitar peticiones por IP.
* **La atribución del origen no es a prueba de manipulación:** cualquiera puede abrir `…/form/reservar-turno?origen=instagram` y su reserva contará como de Instagram sin pasar por el enlace corto. Es el mismo trade-off de cualquier parámetro `utm`.
* **`HEAD` no se atiende** (404 de n8n): algunos comprobadores de enlaces usan `HEAD`; con `GET` todo va bien.
* **El proxy no se ha probado contra un dominio real** (solo el webhook al que traduce). Sí está probado el flujo completo con n8n, Postgres y PostgREST locales.
* **`n8nUserAuth` no se ha probado** (sí Basic Auth).
* **Los bloqueos no avisan solos** a quien atiende (ver 4); hay que mirar la vista.
* Un administrador puede editar a mano `links.click_count`, `links.active`, etc. en el panel; el trigger solo vigila `slug` y `destination`.
* Si borras un enlace (fila de `links`) se borra su detalle por día, pero **las reservas conservan su origen** y siguen saliendo en `stats_channels` como canal sin enlace. Mejor **desactívalo** (`active = false`).
