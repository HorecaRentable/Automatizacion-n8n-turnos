# Fase 2 · cambio de hora, recordatorios y avisos para quien atiende

Todo lo de la Fase 1 sigue igual; esto se **añade** (migraciones nuevas, workflows nuevos y dos workflows ampliados).
Instalación: [INSTALACION.md](INSTALACION.md) · Pruebas: [PRUEBAS.md](PRUEBAS.md).

| # | Qué | Dónde |
|---|---|---|
| 1 | **Cambio de hora** con el mismo código secreto, atómico, con correo + `.ics` actualizado | workflow `03-cambiar-hora` · RPC `get_reschedule_info`, `get_reschedule_availability`, `reschedule_booking` |
| 2 | **Recordatorios** 24 h y 1 h antes, cada uno **una sola vez** | workflow `04-recordatorios` (cada 15 min) · RPC `claim_due_reminders`, `report_reminder` |
| 3 | **Resumen diario** para quien atiende (08:00 Madrid por defecto) | workflow `05-resumen-diario` · RPC `claim_daily_summary`, `report_daily_summary` |
| 4 | **Aviso inmediato** al reservar, cancelar o cambiar | nodos nuevos en `01-reservar`, `02-cancelar` y `03-cambiar-hora` |

## Decisiones que he tomado (cámbialas si no te valen)

| Tema | Decisión | Dónde se cambia |
|---|---|---|
| «Formulario de gestión» | El de **cancelar no se toca**; el cambio de hora es un formulario nuevo `/form/cambiar-turno` con el **mismo código**. Los correos llevan los dos enlaces (cancelar y cambiar). | — |
| Quién atiende | Ajuste nuevo `staff_email`. Si está **vacío** se usa `admin_email`. El administrador sigue recibiendo solo los avisos de errores. | tabla `settings` |
| Resumen sin turnos | **Se envía** un aviso breve («hoy no hay ningún turno confirmado»). | `settings.daily_summary_send_empty` = `false` para no enviar nada |
| Hora del resumen | 08:00 hora local. El workflow se consulta cada 15 min y la **base de datos** decide si ya toca, así que la hora se cambia en `settings.daily_summary_time` sin tocar n8n. | tabla `settings` |
| Plazo para cambiar | Nuevo `services.reschedule_notice_hours`; si está vacío, el de cancelar; y si también, X. | tabla `services` |
| Reintentos | 3 intentos por recordatorio y por resumen. | `settings.reminder_max_attempts` |
| Límite de cambios por turno | **Ninguno** (cada cambio respeta todas las reglas). | — |

---

## 1 · Cambio de hora

**Recorrido de la persona**: enlace «Cámbiala aquí» del correo (o el formulario con el código) → se comprueba el turno y el plazo **antes de pedir nada más** → elige día → ve las **horas libres** → elige hora → «Hora cambiada» + correo.

### Las horas libres son las de siempre
`get_reschedule_availability` llama a la **misma** `_get_availability` / `_available_slots` de la reserva. Solo se añadió un parámetro opcional, *«turno que se está moviendo»* (las versiones de la Fase 1 delegan en las nuevas con `NULL`: mismo cálculo). Con él:

* el hueco **actual** del turno no cuenta como ocupado (si no, con descanso de 10 min no podrías pasar de 10:00 a 10:30 por culpa de tu propio descanso);
* la hora que ya tienes **no se ofrece** como «nueva».

### Es atómico: el turno antiguo no se libera si el nuevo no queda reservado
No hay «borrar y crear»: `reschedule_booking` hace **un único `UPDATE` de la misma fila** (mismo `id`, mismo código), protegido por la restricción de exclusión `bookings_no_overlap`.

```
reschedule_booking(código, hora_nueva)
  1. bloquea el servicio (el mismo bloqueo que book_slot) y después la fila del turno
  2. comprueba: código · turno confirmado y futuro · plazo mínimo para cambiar
  3. comprueba que hora_nueva ∈ _available_slots (horario, bloqueos, X, Y, descanso)
  4. UPDATE bookings SET starts_at = …, ends_at = …, ics_sequence = ics_sequence + 1, rescheduled_at = …
        └─ si bookings_no_overlap lo rechaza (alguien ocupó el hueco "por debajo")  → SLOT_TAKEN y se deshace
        └─ si cualquier otra cosa falla                                             → se deshace TODO
```
En cualquier fallo el turno original queda **byte a byte igual** (pruebas T38–T40 y E21, que lo fuerzan de tres formas).

Códigos de error (sin datos del turno): `INVALID_CODE` · `NOT_CHANGEABLE` (cancelado, pasado o servicio inactivo) · `TOO_LATE` (+ horas) · `SLOT_TAKEN` · `SAME_SLOT`.
Si la hora se ocupa mientras la persona decide, ve *«Esa hora acaba de ocuparse. Elige otra; tu turno actual sigue reservado»* y vuelve a la lista **sin perder el código**.

### Correo y `.ics`
Mismo `UID` que el evento original y `SEQUENCE` mayor (`ics_sequence`: **0** reserva → **1** cambio → **2** cancelación…). Los calendarios (Google, Apple, Outlook) **sustituyen** el evento en vez de duplicarlo, y una cancelación posterior a un cambio también sustituye (por eso `cancel_booking` ahora sube `ics_sequence` en vez de fijar «1»).

### Qué rearma el cambio
Al cambiar `starts_at` (por la RPC **o a mano en el panel**) un trigger pone a cero las marcas y los intentos de recordatorio y anota `rescheduled_at`: la hora nueva recibe sus propios recordatorios.

---

## 2 · Recordatorios (workflow 04, cada 15 min)

`claim_due_reminders()` devuelve los turnos a los que **hoy toca** un recordatorio y, **en la misma sentencia**, los marca:

```sql
WITH due AS (SELECT id FROM bookings WHERE status = 'confirmed' AND reminder_24h_sent_at IS NULL AND … FOR UPDATE SKIP LOCKED)
UPDATE bookings SET reminder_24h_sent_at = now(), reminder_24h_attempts = reminder_24h_attempts + 1
  FROM due WHERE bookings.id = due.id AND status = 'confirmed' AND reminder_24h_sent_at IS NULL
RETURNING …
```
Solo se envía lo que devuelve el `RETURNING`. Por eso **dos ejecuciones a la vez (o un reintento) no pueden enviar el mismo recordatorio**: `SKIP LOCKED` salta lo que la otra tiene en curso y la condición `IS NULL` se vuelve a evaluar sobre la fila bloqueada. Es una sola sentencia en una sola transacción: no hay hueco entre «mirar» y «marcar».

| Recordatorio | Se envía si… |
|---|---|
| **24 h** | faltan ≤ 24 h **y** > 2 h · el turno se reservó (o cambió) con **≥ 24 h** de antelación · está confirmado |
| **1 h** | faltan ≤ 1 h **y** > 0 · el turno se reservó (o cambió) con **≥ 1 h** de antelación · está confirmado |

* **Reservados con < 24 h de antelación** → sin recordatorio de 24 h. Se mide desde `rescheduled_at` si existe (un turno movido a mañana no recibe el de 24 h) y si no desde `created_at`. Con la misma lógica, un turno reservado con 30 min de margen no recibe el de 1 h justo después de su confirmación.
* **Cancelados** (`cancelled`), `attended` y `no_show` → nunca. El `UPDATE` vuelve a exigir `status = 'confirmed'`, así que cancelar entre el «mirar» y el «marcar» tampoco los deja pasar.
* La ventana de 24 h se cierra 2 h antes: si n8n estuvo caído un día, no llega «recordatorio de 24 h» a un turno de dentro de 1 h.

### Si el envío falla
1. n8n llama a `report_reminder(ok = false, error)`.
2. **Constancia**: fila en `email_log` (`kind = reminder_24h | reminder_1h`, `status = failed`, `error`).
3. **Reintento**: en la misma llamada se **libera el reclamo** (marca → `NULL`), pero solo si sigue siendo el de esa ejecución (se compara con `claimed_at`, a microsegundos). La pasada siguiente (15 min después) lo vuelve a reclamar: *intento 2*. No hay duplicado posible porque solo se libera cuando se sabe que **no salió**.
4. **Tope**: al tercer fallo (`reminder_max_attempts`) `report_reminder` devuelve `gave_up = true`, el workflow **avisa al administrador** (con el id de la reserva, sin datos personales) y deja de reintentar. Los contadores `reminder_*_attempts` quedan en la fila.

> **Límite conocido (decisión deliberada):** si n8n se cae *entre* el reclamo y el envío, ese recordatorio no se reenvía (la marca ya está puesta). Se prefiere perder uno a enviarlo dos veces. Esos casos se ven así:
> ```sql
> select b.id, b.starts_at, b.reminder_24h_sent_at from bookings b
> where b.status = 'confirmed' and b.reminder_24h_sent_at is not null
>   and not exists (select 1 from email_log l where l.booking_id = b.id and l.kind = 'reminder_24h' and l.status = 'sent');
> ```
> (Para reenviarlo a mano: `update bookings set reminder_24h_sent_at = null, reminder_24h_attempts = 0 where id = '…'`.)

---

## 3 · Avisos para quien atiende

### Resumen diario (workflow 05)
Cada 15 min el workflow llama a `claim_daily_summary()`. La base de datos responde `due = true` **una sola vez al día** y solo a partir de `daily_summary_time` (hora local). La clave primaria de `daily_summary_log (día)` impide dos resúmenes el mismo día aunque dos ejecuciones coincidan. Si n8n estaba caído a las 08:00, el resumen sale cuando vuelve (el mismo día).

* Contenido: turnos **confirmados** del **día local** (también el día de 25 h del cambio de hora), de **todos los servicios**, ordenados por hora, con servicio, nombre, teléfono y correo.
* Sin turnos: «Agenda de hoy · dd/mm/aaaa · sin turnos» (o nada, con `daily_summary_send_empty = false`).
* Fallo de envío: mismo esquema que los recordatorios (`daily_summary_log.status`: `claimed → sent | retry → failed`), 3 intentos y aviso al administrador.

### Aviso inmediato
Un correo a `staff_email` al **reservar**, **cancelar** o **cambiar la hora** (en el cambio: hora antigua y nueva). Detalles:

* Sale **después** de la confirmación a la persona y es **tolerante a fallos**: si falla se anota en `email_log` (`staff_booking`, `staff_cancellation`, `staff_reschedule`) y la persona ve igualmente su confirmación.
* Lleva nombre, teléfono y correo, pero **nunca el código secreto de gestión**.
* Un intento fallido (hora ocupada, fuera de plazo…) **no** genera aviso: solo cambios que realmente ocurrieron.

---

## 4 · Qué cambió de la Fase 1 (y qué no)

| Archivo | Cambio |
|---|---|
| Migraciones `20261020000001…4` | **Sin tocar.** Todo va en las 4 migraciones nuevas. |
| `_cancel_booking` (función) | Reemplazada por `create or replace`: igual que antes, **más** `ics_sequence + 1` y los campos `customer_phone` / `ics_sequence` en la respuesta. |
| `_available_slots`, `_next_available_days`, `_get_availability` | Pasan a ser envoltorios de versiones con un parámetro más (`NULL` = comportamiento anterior). Mismas firmas, mismos resultados. |
| `get_config` | Devuelve además `staff_email` y `reschedule_form_url`. |
| `bookings_prepare` (trigger) | Igual que antes + rearme de recordatorios al cambiar `starts_at`. |
| Workflow 01 | + enlace «Cámbiala aquí» en el correo · + 4 nodos de aviso a quien atiende (en serie, después del correo a la persona). |
| Workflow 02 | + `Cargar parámetros` · + los mismos 4 nodos de aviso · el `.ics` de cancelación usa la versión real (`ics_sequence`). |
| Workflow 99 | **Sin tocar.** |
| Pruebas | T02 (ahora 7 tablas con RLS) y T34 (ahora 5 claves en `get_config`) ajustadas a lo que se añadió; E13 filtra `email_log` por `kind = confirmation` (ahora también hay avisos al personal). Nada más. |

## 5 · Migraciones nuevas

| Archivo | Contenido |
|---|---|
| `20261021000001_fase2_tablas.sql` | columnas (`reschedule_notice_hours`, `ics_sequence`, `rescheduled_at`, `reminder_*_attempts`), ajustes en `settings`, tabla `daily_summary_log`, trigger |
| `20261021000002_fase2_cambio_de_hora.sql` | disponibilidad con «turno que se mueve», RPC de cambio, `_cancel_booking`, `get_config` |
| `20261021000003_fase2_avisos.sql` | reclamo/informe de recordatorios y del resumen diario |
| `20261021000004_fase2_seguridad.sql` | RLS de la tabla nueva y permisos (solo `service_role` ejecuta las RPC públicas) |

## 6 · Ajustes nuevos (tabla `settings`)

| Clave | Por defecto | Para qué |
|---|---|---|
| `staff_email` | *(vacío → `admin_email`)* | quien recibe resumen y avisos |
| `reschedule_form_url` | `https://TU-N8N/form/cambiar-turno` | enlace «Cámbiala aquí» de los correos |
| `daily_summary_time` | `08:00` | hora local a partir de la cual sale el resumen |
| `daily_summary_send_empty` | `true` | `false` = no avisar si no hay turnos |
| `reminder_max_attempts` | `3` | intentos de cada recordatorio / resumen |

## 7 · Qué mirar si algo no llega

```sql
-- correos fallidos (recordatorios, resúmenes, avisos, confirmaciones)
select created_at, kind, to_email, error from email_log where status = 'failed' order by created_at desc limit 20;
-- recordatorios que se rindieron
select id, starts_at, reminder_24h_attempts, reminder_1h_attempts from bookings
 where status = 'confirmed' and (reminder_24h_attempts >= 3 or reminder_1h_attempts >= 3);
-- estado del resumen de los últimos días
select * from daily_summary_log order by day desc limit 7;
```

## 8 · Límites conocidos

* Recordatorios con **precisión de 15 min** (se miran cada 15 min): el de 24 h sale entre las 24 h y las 23 h 45 min antes.
* Cancelar **en los milisegundos** entre el reclamo y el envío de un recordatorio no lo detiene (el correo ya está en camino).
* Un correo de recordatorio se envía **a la dirección del turno**, sin confirmar que existe; los rebotes (buzón inexistente) no llegan a n8n.
* Los workflows 04 y 05 no guardan las ejecuciones correctas (para no conservar nombres/correos en n8n y no llenar el historial con ~96 pasadas diarias); los errores sí. La traza de lo enviado es `email_log`.
