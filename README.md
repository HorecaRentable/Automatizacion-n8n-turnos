# Reserva de turnos con n8n + Supabase

Cualquier persona reserva, **cambia de hora** y cancela un turno desde un formulario de n8n, **sin cuenta**, y recibe correos (con archivo `.ics`) y **recordatorios** 24 h y 1 h antes. Quien atiende recibe un **resumen diario** y un aviso al instante de cada reserva, cancelación o cambio.
Con **enlaces cortos** (`l.rocketnova.io/instagram`) que llevan al formulario guardando de dónde viene cada reserva, y estadísticas de clics, reservas y conversión por canal.
Todo con **n8n** (formularios, lógica, correos) y **Supabase** (datos e integridad). Sin otros servicios ni backends.

**Estado: Fases 1, 2 y 3 completas** (reservar, cancelar, cambiar hora, recordatorios, resumen y avisos; enlaces cortos, estadísticas y bloqueos) → qué hay de nuevo: [docs/FASE3.md](docs/FASE3.md) · pruebas: [docs/PRUEBAS.md](docs/PRUEBAS.md)

| Quiero… | Lee |
|---|---|
| Instalarlo (≈ 20 min) | [docs/INSTALACION.md](docs/INSTALACION.md) |
| Ver qué añade la Fase 2 y cómo funciona | [docs/FASE2.md](docs/FASE2.md) |
| Ver qué añade la Fase 3 (enlaces cortos, estadísticas, bloqueos) | [docs/FASE3.md](docs/FASE3.md) |
| Poner `l.rocketnova.io` apuntando a n8n (DNS y proxy) | [docs/DOMINIO-ENLACES.md](docs/DOMINIO-ENLACES.md) |
| Ver qué se probó y cómo | [docs/PRUEBAS.md](docs/PRUEBAS.md) |

## Cómo funciona

```
Persona ─► Formulario n8n ─► workflow n8n ─► RPC de Supabase ─► Postgres (reglas e integridad)
                                  │
                                  └─► correo (SMTP) con .ics y enlace de cancelación
```

- **Toda la lógica crítica vive en la base de datos**: horas libres (`get_availability`), reserva (`book_slot`), cancelación (`cancel_booking`), cambio de hora (`reschedule_booking`, un único `UPDATE` atómico) y el reclamo de recordatorios (`claim_due_reminders`, `UPDATE … RETURNING`) son funciones transaccionales. n8n solo las llama, con la clave `service_role` guardada en una credencial.
- **El doble turno es imposible**: restricción de exclusión (`btree_gist`) sobre `[inicio, fin + descanso)` por servicio, más un bloqueo por servicio dentro de `book_slot`. Si dos personas eligen el mismo hueco, una reserva y la otra ve «Ese turno acaba de ocuparse» y vuelve a elegir **sin perder sus datos**.
- **Horas en UTC, mostradas en Europe/Madrid**, con los cambios de hora de marzo y octubre resueltos en SQL.
- **RLS activado en todas las tablas y sin políticas**; `anon` no puede nada.
- **Enlaces cortos sin redirecciones abiertas**: el destino solo puede estar en dominios permitidos y se vuelve a validar en cada clic; el contador de clics solo lo sube el webhook de n8n (atómico, después de redirigir).
- Si falla el correo, **la reserva no se pierde**: queda en `email_log`, se avisa al administrador y la persona ve su enlace de gestión.

## Qué hay en el repositorio

| Carpeta | Contenido |
|---|---|
| [supabase/migrations/](supabase/migrations/) | las 12 migraciones SQL: 4 de la Fase 1 (tablas, triggers, funciones, seguridad), 4 de la Fase 2 (`20261021…`) y 4 de la Fase 3 (`20261022…`) |
| [supabase/consultas/](supabase/consultas/) | consultas listas para el SQL Editor: estadísticas de enlaces y turnos afectados por bloqueos |
| [supabase/seed.sql](supabase/seed.sql) | datos de ejemplo: 1 servicio, su horario semanal y 1 bloqueo |
| [n8n/workflows/](n8n/workflows/) | los 8 workflows en JSON: `01-reservar`, `02-cancelar`, `03-cambiar-hora`, `04-recordatorios`, `05-resumen-diario`, `06-enlaces-cortos`, `07-crear-enlace`, `99-aviso-de-errores` |
| [n8n/fuente/](n8n/fuente/) | generador de esos JSON (el código de cada nodo Code en archivos `.js` legibles) |
| [tests/](tests/) | pruebas de base de datos (Postgres real) y de extremo a extremo (n8n + navegador) |
| [docs/](docs/) | instalación, pruebas, capturas |
| `supabase/legacy/` | borrador anterior del esquema (en español, incompleto): solo referencia, **no ejecutar** |

## Modelo de datos

`services` · `weekly_schedule` · `blocks` · `bookings` (con marcas e intentos de recordatorio, `ics_sequence`, `rescheduled_at`, `source` = origen del enlace corto, estados `confirmed | cancelled | attended | no_show`) · `settings` · `email_log` · `daily_summary_log` · `links` · `link_clicks_daily`, y las vistas `stats_links`, `stats_channels`, `stats_clicks_daily` y `blocks_affected_bookings`.
Pensado para editarse a mano desde el panel de Supabase: nombres claros, restricciones y valores por defecto.

## Credenciales y variables de entorno

**El sistema de turnos no usa archivos `.env`.** La configuración vive en dos sitios, y ninguno es el repositorio:

| Dónde | Qué | Valores reales |
|---|---|---|
| **n8n → Credentials** (3) | `Supabase turnos (service role)` (Project URL + clave `service_role`) · `SMTP turnos` (host, puerto, usuario y contraseña del correo remitente) · `Formulario del equipo (usuario y contraseña)` (Basic Auth del formulario de crear enlaces) | **nunca en el repositorio**; plantilla sin valores en [n8n/credenciales.ejemplo.json](n8n/credenciales.ejemplo.json) |
| **Nodo «Configuración»** de cada workflow | `supabase_url` (solo la Project URL, sin `/rest/v1/`) y `from_email` (remitente) | valores propios de cada instalación |
| **Supabase → tabla `settings`** | correos (`admin_email`, `staff_email`), URLs públicas de los formularios, dominios permitidos de los enlaces, hora del resumen… | ver [docs/INSTALACION.md](docs/INSTALACION.md) §2.5 |

El único `.env` del repositorio es el de la *demo anterior* (`.env.example`, sin valores reales), que no se usa en el sistema de turnos.

**Cómo probarlo:** [docs/INSTALACION.md](docs/INSTALACION.md) §3 (prueba rápida de 2 minutos) y [docs/PRUEBAS.md](docs/PRUEBAS.md) (pruebas automáticas y resultados).
**Para montarlo desde cero en Supabase:** un único archivo, [supabase/instalacion_completa.sql](supabase/instalacion_completa.sql) (todas las migraciones, en orden) y después [supabase/seed.sql](supabase/seed.sql) (datos iniciales).

---

## Demo anterior (Node + n8n «HOLA SOY N8N»)

### Proyecto Node.js + n8n

Página web con un cuadro de texto. Al enviar, el servidor Node.js llama a un webhook de n8n y n8n responde **HOLA SOY N8N**.

```
Navegador → Servidor Node (Express) → n8n (Webhook) → responde "HOLA SOY N8N" → Navegador
```

## Requisitos

- Node.js 18 o superior (`node -v` para comprobarlo)
- n8n (en local con `npx n8n`, con Docker o en n8n Cloud)

## 1. Configurar n8n

1. Arranca n8n: `npx n8n` y abre http://localhost:5678
2. Crea un workflow nuevo.
3. Añade un nodo **Webhook**:
   - HTTP Method: `POST`
   - Path: `hola`
   - Respond: **Using 'Respond to Webhook' Node**
4. Añade después un nodo **Respond to Webhook**:
   - Respond With: `Text`
   - Response Body: `HOLA SOY N8N`
5. Conecta los dos nodos (Webhook → Respond to Webhook).

## 2. Configurar el proyecto

```bash
npm install
cp .env.example .env     # en Windows: copy .env.example .env
```

Edita `.env` y pon la URL de tu webhook de n8n.

## 3. Arrancar

```bash
npm start
```

Abre http://localhost:3000, escribe algo y pulsa **Enviar**.

> Para probar con la URL `webhook-test`, pulsa antes **Listen for test event** en el nodo Webhook de n8n (solo vale para una petición).
> Para usar la URL `webhook`, activa el workflow con el interruptor **Active**.

## Estructura

| Archivo | Para qué sirve |
|---|---|
| `server.js` | Servidor Node: sirve la web y reenvía el mensaje a n8n |
| `public/index.html` | Página con el cuadro de texto y el botón |
| `.env` | Configuración (puerto y URL del webhook) |
| `package.json` | Lista de dependencias y comandos |
