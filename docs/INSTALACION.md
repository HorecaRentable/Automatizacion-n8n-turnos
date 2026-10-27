# Instalación (≈ 20 minutos)

Sistema de reserva de turnos: **formularios y correos en n8n, datos y reglas en Supabase**. Sin otros servicios.

> **¿Ya tienes la Fase 1 instalada?** No reinstales: ejecuta **solo las 4 migraciones `20261021…`** (sección 1), **reimporta** los workflows `01` y `02`, **importa** `03`, `04` y `05`, publica los tres nuevos y rellena los ajustes nuevos (2.5). Qué cambia exactamente: [FASE2.md](FASE2.md).
>
> **¿Ya tienes la Fase 2?** Ejecuta **solo las 4 migraciones `20261022…`**, **reimporta** el workflow `01` (lleva un campo oculto nuevo), **importa** `06` y `07`, crea la credencial del formulario del equipo (2.1), publica los dos nuevos, rellena los ajustes `link_*` y `booking_form_url` (2.5) y configura el dominio corto ([DOMINIO-ENLACES.md](DOMINIO-ENLACES.md)). Qué cambia exactamente: [FASE3.md](FASE3.md).

## 0. Qué necesitas

| | |
|---|---|
| Supabase | un proyecto (cualquier plan) |
| n8n | **2.x** con los nodos *Form* (probado con **2.44.4**), accesible por HTTPS desde Internet |
| Correo | una cuenta SMTP (la que quieras usar de remitente) |

## 1. Base de datos (Supabase)

1. **SQL Editor** → pega y ejecuta, **en este orden y cada archivo entero**:
   1. `supabase/migrations/20261020000001_tablas.sql`
   2. `supabase/migrations/20261020000002_triggers.sql`
   3. `supabase/migrations/20261020000003_funciones.sql`
   4. `supabase/migrations/20261020000004_seguridad.sql`
   5. `supabase/migrations/20261021000001_fase2_tablas.sql` *(Fase 2)*
   6. `supabase/migrations/20261021000002_fase2_cambio_de_hora.sql`
   7. `supabase/migrations/20261021000003_fase2_avisos.sql`
   8. `supabase/migrations/20261021000004_fase2_seguridad.sql`
   9. `supabase/migrations/20261022000001_fase3_enlaces_tablas.sql` *(Fase 3)*
   10. `supabase/migrations/20261022000002_fase3_enlaces_rpc.sql`
   11. `supabase/migrations/20261022000003_fase3_estadisticas_y_bloqueos.sql`
   12. `supabase/migrations/20261022000004_fase3_seguridad.sql`

   (Con la CLI: `supabase db push`.)

   **Atajo, en un proyecto nuevo:** en vez de pegar los archivos uno a uno, pega **una sola vez** [`supabase/instalacion_completa.sql`](../supabase/instalacion_completa.sql), que contiene todas las migraciones en orden (cada una en su propia transacción). Se regenera con `node supabase/generar-instalacion-completa.mjs` si se añaden migraciones, y `tests/verificar-instalacion-completa.mjs` comprueba que deja la base de datos idéntica a aplicarlas una a una. Úsalo solo para la primera instalación; las migraciones posteriores se aplican por separado.
2. Abre `supabase/seed.sql`, **cambia `admin_email`** y ejecútalo: crea 1 servicio de ejemplo, su horario semanal y 1 bloqueo.
3. Comprueba en **Table Editor** que hay 9 tablas (`settings`, `services`, `weekly_schedule`, `blocks`, `bookings`, `email_log`, `daily_summary_log`, `links`, `link_clicks_daily`) con RLS activado y **sin ninguna política**: es lo correcto (`anon` no puede nada). Las estadísticas (`stats_*`) y `blocks_affected_bookings` son **vistas**: tampoco accesibles para `anon`.
4. Apunta, en **Project Settings → API**: la **Project URL** (`https://xxxx.supabase.co`) y la clave **`service_role`** (o *secret key*). Esa clave solo irá a una credencial de n8n, nunca a un nodo ni a un archivo.

## 2. n8n

### 2.1 Credenciales (3)

**Opción A (recomendada: conserva los identificadores que usan los workflows).** Copia `n8n/credenciales.ejemplo.json` a un archivo **fuera del repositorio**, rellena tus valores y ejecuta:

```bash
n8n import:credentials --input=/ruta/fuera/del/repo/credenciales.json
```

**Opción B (desde la interfaz).** *Credentials → Create* con estos nombres exactos:

| Tipo | Nombre | Datos |
|---|---|---|
| Supabase API | `Supabase turnos (service role)` | Host = Project URL · Secret Key = `service_role` |
| SMTP | `SMTP turnos` | tu servidor, usuario, contraseña, SSL/TLS |
| Basic Auth | `Formulario del equipo (usuario y contraseña)` | usuario y una **contraseña larga**: es la entrada al formulario de creación de enlaces *(Fase 3)* |

Luego, al abrir cada workflow, elige estas credenciales en los nodos que marquen aviso.

### 2.2 Workflows (8)

*Workflows → Import from file* (o `n8n import:workflow --separate --input=n8n/workflows`):

| Archivo | Para qué |
|---|---|
| `n8n/workflows/99-aviso-de-errores.json` | avisa por correo al administrador cuando algo falla |
| `n8n/workflows/01-reservar.json` | formulario de reserva (landing + 2 páginas) |
| `n8n/workflows/02-cancelar.json` | formulario de cancelación (+ aviso a quien atiende) |
| `n8n/workflows/03-cambiar-hora.json` | formulario de cambio de hora *(Fase 2)* |
| `n8n/workflows/04-recordatorios.json` | recordatorios 24 h y 1 h, cada 15 min *(Fase 2)* |
| `n8n/workflows/05-resumen-diario.json` | resumen diario para quien atiende *(Fase 2)* |
| `n8n/workflows/06-enlaces-cortos.json` | redirección de los enlaces cortos y recuento de clics *(Fase 3)* |
| `n8n/workflows/07-crear-enlace.json` | formulario del equipo para crear enlaces cortos *(Fase 3)* |

En **cada uno** (01-07 y 99) abre el nodo **Configuración** y pon tu `supabase_url` y tu `from_email` (el 99 también `admin_email_respaldo`, que solo se usa si Supabase está caído; el 06 también `url_respaldo`, adónde redirigir si Supabase está caído).

### 2.3 Enlazar el workflow de errores

En **01 a 07**: *Settings (⋯) → Error workflow* → **Turnos · 99 Aviso de errores** (al importar por la interfaz n8n puede asignar otros identificadores).

### 2.4 Publicar

**Publica (Active) los ocho.** (04 y 05 son programados: no tienen URL, se disparan solos cada 15 min con la zona horaria `Europe/Madrid` del workflow.) Las URLs públicas quedan así:

```
https://TU-N8N/form/reservar-turno        ← la que compartes (admite ?origen=nombre, se guarda en bookings.source)
https://TU-N8N/form/cancelar-turno        ← la usa el enlace del correo
https://TU-N8N/form/cambiar-turno         ← la usa el enlace «Cámbiala aquí» del correo
https://TU-N8N/form/crear-enlace          ← el equipo crea enlaces cortos (pide usuario y contraseña) (Fase 3)
https://TU-N8N/webhook/<id>/<slug>        ← el enlace corto; <id> es el del nodo «Enlace corto» del workflow 06. El dominio corto se apunta aquí (ver DOMINIO-ENLACES.md)
```

### 2.5 Dile a Supabase las URLs y quién atiende

En **Table Editor → settings**:

| Fila | Valor |
|---|---|
| `cancel_form_url` | `https://TU-N8N/form/cancelar-turno` |
| `reschedule_form_url` | `https://TU-N8N/form/cambiar-turno` *(Fase 2)* |
| `staff_email` | correo de quien atiende: recibe el resumen diario y los avisos de reservas, cancelaciones y cambios. Vacío = usa `admin_email` *(Fase 2)* |
| `daily_summary_time` | `08:00` (hora local; opcional) |
| `daily_summary_send_empty` | `true` = aviso breve si no hay turnos; `false` = no enviar nada |
| `booking_form_url` | `https://TU-N8N/form/reservar-turno`: destino por defecto de un enlace corto *(Fase 3)* |
| `link_base_url` | `https://l.rocketnova.io` (dominio corto, sin barra final) *(Fase 3)* |
| `link_default_url` | adónde va quien abre un slug que no existe *(Fase 3)* |
| `link_allowed_domains` | dominios (y subdominios) a los que puede redirigir un enlace: `rocketnova.io` + el de tu n8n si es otro *(Fase 3)* |

### 2.6 Privacidad de las ejecuciones (recomendado)

n8n guarda en cada ejecución los datos que pasan por ella (nombre, correo, teléfono). Limita cuánto tiempo, en las variables de entorno de n8n:

```
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=48        # horas
```

Los workflows 04 y 05 (programados) no guardan las ejecuciones correctas; los errores sí.

Los formularios abandonados caducan solos (60 min las páginas con campos, 5 min la final) y entonces la ejecución termina y entra en esa poda. Sin ese límite, n8n **no poda nunca** las ejecuciones "en espera".

## 3. Prueba rápida (2 min)

1. Abre `/form/reservar-turno` → *Reservar un turno* → elige servicio y un día laborable → tus datos → hora → **Turno reservado**.
2. Llega el correo con el `.ics` adjunto y el enlace de cancelación. Ábrelo: el código ya viene puesto → **Cancelar mi turno**.
3. Vuelve a mirar las horas de ese día: el hueco está libre otra vez.
4. *(Fase 2)* Reserva otro turno y, en el correo, pulsa **Cámbiala aquí**: elige otro día y hora → llega el correo «Hora cambiada» con el `.ics` actualizado y, a `staff_email`, el aviso con la hora antigua y la nueva. Cada reserva y cada cancelación también avisan a `staff_email`.
5. *(Fase 2)* Recordatorios y resumen: en `bookings` pon un turno confirmado a 23 h 50 min de ahora (`starts_at`, con `created_at` de hace días); en ≤ 15 min llega el recordatorio de 24 h, y solo uno. Para el resumen, fija `daily_summary_time` en una hora ya pasada y borra la fila de hoy de `daily_summary_log`: en ≤ 15 min llega «Agenda de hoy».

6. *(Fase 3)* Abre `https://TU-N8N/form/crear-enlace` (usuario y contraseña de la credencial) → slug `prueba` → **Crear enlace**. Abre `https://TU-N8N/webhook/<id>/prueba` con tu navegador (o `l.rocketnova.io/prueba` si ya configuraste el dominio): te lleva al formulario de reserva con `?origen=prueba`. Haz una reserva y en Supabase: `select slug, clicks, bookings, conversion_pct from stats_links;` → 1 clic, 1 reserva, 100 %.

## 4. Día a día (todo desde el panel de Supabase → Table Editor)

| Quiero… | Tabla | Cómo |
|---|---|---|
| Añadir un servicio | `services` | nueva fila: `name`, `duration_minutes`, `break_minutes`, `min_notice_hours` (**X**), `booking_window_days` (**Y**) |
| Su horario | `weekly_schedule` | una fila por servicio y día (`weekday`: 1 = lunes … 7 = domingo) con `morning_start/end` y/o `afternoon_start/end` en **hora local**. Sin fila = cerrado |
| Cerrar un rato / vacaciones / festivo | `blocks` | `starts_at`/`ends_at` (ver nota); `service_id` vacío = afecta a todos los servicios. **Los turnos ya confirmados dentro no se tocan**: mira `select * from blocks_affected_bookings;` y avisa a esas personas (ver [FASE3.md](FASE3.md) §4) |
| Crear un enlace corto | formulario `/form/crear-enlace` | slug (minúsculas, números y guiones), destino opcional y canal opcional. Para desactivar uno: tabla `links`, `active = false` |
| Ver clics, reservas y conversión | vistas `stats_links`, `stats_channels` | o las consultas listas de `supabase/consultas/estadisticas.sql` (por periodo, evolución diaria…) |
| Ver / cambiar un turno | `bookings` | para cancelar a mano pon `status = cancelled`: el hueco se libera. Un alta a mano solo necesita servicio, nombre, correo, teléfono, `starts_at` y marcar `consent_given` (el fin y el descanso los calcula la base de datos) |
| Ver correos que fallaron | `email_log` | filtra `status = failed` (`kind`: `confirmation`, `cancellation`, `reschedule`, `reminder_24h`, `reminder_1h`, `daily_summary`, `staff_*`) |
| Cambiar la hora de un turno a mano | `bookings` | edita `starts_at` (y `ends_at`): sus recordatorios se rearman solos |
| Dar más o menos plazo para cambiar la hora | `services` | `reschedule_notice_hours` (vacío = igual que cancelar) |
| Ver el resumen diario / reenviarlo | `daily_summary_log` | borra la fila del día para que se vuelva a enviar en la pasada siguiente |
| Cambiar zona horaria / correo del admin | `settings` | `timezone`, `admin_email`, `cancel_form_url` |

Notas:
- Las horas de `blocks` y `bookings` se guardan en **UTC**; el panel las muestra en la zona de tu navegador. Para escribir una hora de Madrid con seguridad usa el SQL Editor: `('2026-12-24 12:00' at time zone 'Europe/Madrid')`.
- Los altas a mano desde el panel **no** aplican la antelación mínima X ni los días vista Y (son reglas de la reserva por el formulario, para que un administrador pueda saltárselas); el solape, el descanso, el formato y el consentimiento **sí** los garantiza la base de datos siempre.
- Ejemplo (SQL) para otro servicio: ver `supabase/seed.sql`.

## 5. Reglas asumidas (cámbialas si no te valen)

- **Solape por servicio**: dos servicios distintos pueden coincidir en la misma hora. (Para solape global habría que cambiar la restricción `bookings_no_overlap`.)
- **X = 2 h, Y = 30 días** por servicio; Y cuenta hasta hoy+Y (día local) inclusive. **Plazo de cancelación = X** (o `cancel_notice_hours` si lo rellenas).
- **Rejilla de horas**: cada `duration_minutes` desde el inicio de cada franja (o `slot_step_minutes`). El **descanso** tras un turno bloquea las horas siguientes, no hace falta que quepa dentro de la franja.
- **Un turno futuro confirmado por correo y servicio** (el correo se normaliza a minúsculas).
- **Zona horaria Europe/Madrid** (en `settings`). Todo se guarda en UTC; los cambios de hora de marzo y octubre se resuelven en la base de datos.

## 6. Seguridad (resumen)

- RLS en todas las tablas y sin políticas; además se retiran los permisos de `anon` y `authenticated` sobre tablas y funciones. Solo `service_role` ejecuta las funciones.
- Reservar y cancelar son funciones RPC transaccionales (`book_slot`, `cancel_booking`): n8n solo las llama.
- Código de gestión de 256 bits (`gen_random_bytes(32)`), solo en el enlace del correo. Un código inválido no revela nada.
- Si falla el correo, la reserva se mantiene, se anota en `email_log` y se avisa al administrador; la persona ve el enlace de gestión en pantalla.
- *(Fase 3)* Enlaces cortos: el destino de una redirección solo puede estar en **dominios permitidos** (`link_allowed_domains`) y se comprueba al crear, en la base de datos y **en cada clic** (sin redirecciones abiertas). El contador de clics solo lo sube el webhook de n8n; con la clave pública de Supabase no se puede ni leer. El formulario de creación pide usuario y contraseña (úsalo solo por HTTPS). Detalle en [FASE3.md](FASE3.md).
- Los formularios de n8n son públicos por diseño. Si te preocupa el abuso (alguien creando reservas en bucle), pon un límite de peticiones en tu proxy/CDN delante de n8n.

## 7. Fases 2 y 3

La Fase 2 (cambio de hora, recordatorios, resumen y avisos) está descrita en [FASE2.md](FASE2.md). La Fase 3 (enlaces cortos con origen, formulario de creación, estadísticas y bloqueos) en [FASE3.md](FASE3.md), y la configuración del dominio corto en [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md).

## 8. Si algo no va

| Síntoma | Causa probable |
|---|---|
| «Problem loading form» al abrir la URL | el workflow no está publicado (Active) |
| «Problem submitting response» | un nodo falló: mira *Executions*; te habrá llegado un correo del workflow 99 |
| 404 en `/rest/v1/rpc/...` | el esquema `public` no está expuesto en *Project Settings → API* |
| 401/403 en n8n | la credencial `Supabase turnos` no tiene la clave `service_role` |
| No llega el correo | mira `email_log` (`failed` + motivo) y la credencial SMTP |
| No llegan recordatorios / resumen | ¿están **publicados** (Active) 04 y 05? ¿la zona horaria del workflow es `Europe/Madrid`? Mira `bookings.reminder_*_attempts`, `daily_summary_log` y `email_log` (ver [FASE2.md](FASE2.md) §7) |
| El enlace «Cámbiala aquí» no aparece en el correo | falta la fila `reschedule_form_url` en `settings` (o está vacía) |
| El formulario no ofrece horas | revisa `weekly_schedule`, `active` del servicio, la antelación X y que no haya un bloqueo (`blocks`) encima |
| El enlace corto redirige a la página por defecto | el slug no existe, está desactivado o su destino ya no está en `link_allowed_domains` (mira `select resolve_link('slug');`) |
| El enlace corto da 404 de n8n | el workflow 06 no está publicado o el `<id>` del proxy no coincide; ver [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md) §6 |
| No cuentan los clics | abre el enlace con un navegador real (`curl`, bots y previsualizaciones no suman) y mira *Executions* del workflow 06 |
| El formulario de creación dice «Destino no permitido» | el destino no está en `link_allowed_domains`; con destino vacío también falla si `booking_form_url` sigue con `TU-N8N` |
