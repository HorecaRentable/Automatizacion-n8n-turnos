# Pruebas realizadas

**Resultado: 81/81 pruebas de base de datos + 40/40 pruebas de extremo a extremo correctas** (última ejecución: 2026-10-21).
De ellas, **34 + 16 son las de la Fase 1** y **26 + 9 las de la Fase 2** (regresión: se ejecutan **todas** sobre los workflows y migraciones ya con la Fase 3), y **21 + 15 son nuevas de la Fase 3**.

## Cómo se probó

| Capa | Con qué |
|---|---|
| Base de datos | **PostgreSQL 18.4 real** (binario embebido, `embedded-postgres`, en **UTF-8** como Supabase) con las 12 migraciones y el seed tal cual; roles `anon` / `authenticated` / `service_role` creados como en Supabase. Varias **conexiones simultáneas** para las carreras. El reloj se fija con el parámetro `p_now` de las funciones internas |
| API | **PostgREST 16.5** (el mismo servicio que usa Supabase) detrás de un gateway mínimo que imita `/rest/v1/…` |
| Workflows | **n8n 2.44.4** real con los JSON importados y publicados (los 8 + dos copias «gemelas» de los programados), la credencial *Supabase API*, la credencial *SMTP* y la de *Basic Auth* del formulario del equipo |
| Correo | servidor SMTP de captura: guarda cada correo y su `.ics` en disco; puede fallar a propósito, para todos o solo para ciertos destinatarios |
| Navegador | **Chrome automatizado** (puppeteer) recorriendo los formularios como una persona |

Los **workflows probados son los mismos que se entregan** (`n8n/workflows/*.json`); solo cambian la URL de Supabase, el remitente y, en el E2E, parámetros de prueba: la espera de los formularios (30 s en vez de 60 min), la cadencia de los programados (**cada minuto** en vez de cada 15), las copias gemelas y la URL de respaldo del workflow 06.

**El dominio corto (`l.rocketnova.io`) se sustituye por la URL real del webhook** (`/webhook/<id>/<slug>`), que es a lo que traduce el proxy. El flujo completo —clic → 302 → formulario → turno → estadísticas— se prueba con n8n, Postgres y PostgREST reales y Chrome real.

## Criterios de aceptación de la Fase 2 → pruebas que los demuestran

| Criterio | Pruebas |
|---|---|
| **Un cambio de hora fallido no libera el turno antiguo** (forzando el fallo) | **T38** (la hora nueva está ocupada: la fila queda *byte a byte* igual) · **T39** (alguien ocupa el hueco *saltándose las funciones* mientras se valida el cambio: la restricción de exclusión lo rechaza y el original no se mueve; si esa otra operación se deshace, el cambio sí prospera) · **T40** (error inesperado *después* del `UPDATE`, provocado con un trigger: se deshace todo) · **T41** (6 cambios + 4 reservas por el mismo hueco: gana uno, los demás no se mueven) · **E21** (en la interfaz: otra persona ocupa la hora mientras se decide → «Esa hora acaba de ocuparse», turno intacto, ningún correo, y luego el cambio a otra hora funciona) |
| **Cada recordatorio sale exactamente una vez aunque el workflow se dispare dos veces a la vez** | **T49** (6 ejecuciones simultáneas × 3 rondas × 12 turnos) · **T50** (determinista: la 2.ª ejecución no espera ni recibe lo que la 1.ª tiene en curso; si la 1.ª se deshace, lo recibe la 2.ª) · **T51** (control negativo: un reclamo ingenuo SÍ duplica) · **T52** (fallo → reintento sin duplicar) · **E23** (n8n real: **dos copias del workflow 04 se disparan en el mismo segundo**, en 4 minutos coincidieron las dos, y cada recordatorio llegó una sola vez) · **E24** |
| **Un turno cancelado no recibe recordatorios** | **T48** (cancelado antes, cancelado después del de 24 h, `attended`, `no_show`) · **E23** |
| **No se envía el de 24 h a turnos reservados con < 24 h** | **T47** (también turnos *cambiados* con < 24 h, y ventanas) · **E23** |
| **Si el envío falla: constancia y reintento sin duplicar** | **T52** · **E24** (falla → `email_log` → el reclamo se libera → se reintenta → llega **una** vez; con 3 fallos se rinde y avisa al administrador sin datos personales) |
| **El resumen diario y los avisos inmediatos llegan con datos correctos** | **T54–T59** (hora, orden, día local de 25 h, sin turnos, una sola vez, fallo y reintento) · **E17** (aviso al reservar) · **E18** (al cancelar) · **E19** (al cambiar: hora antigua y nueva) · **E25** (resumen real: no antes de la hora; un solo correo con dos workflows a la vez; ordenado; sin cancelados ni de otros días; aviso breve si no hay turnos; fallo y reintento) |
| **Cambio de hora: mismas reglas y mismas horas libres** | **T35–T37, T45** (antelación X, días vista Y, horario, bloqueos, plazo para cambiar, estado del turno, código; semana del cambio de hora de octubre) · **T36** (la disponibilidad es *la misma* que `get_availability`) · **E19, E20, E22** |
| **El `.ics` actualizado sustituye al evento** | **T43** (`SEQUENCE` 0 → 1 → 2) · **E19, E20** (mismo `UID`, `SEQUENCE` mayor, validado con `ical.js`; la cancelación posterior lleva `SEQUENCE:2`) |
| **La Fase 1 sigue funcionando** (regresión) | **T01–T34** (solo se ajustaron 2 aserciones, ver abajo) y **E01–E16** sobre los workflows 01 y 02 *ya modificados* |
| Seguridad de lo nuevo | **T60** (ninguna función de `public` ejecutable por `anon`/`authenticated`; RLS en la tabla nueva) · E15 |

## Criterios de aceptación de la Fase 3 → pruebas que los demuestran

| Criterio | Pruebas |
|---|---|
| **Un clic cuenta una vez y redirige correctamente** | **E26** (una visita → `302` a `destino?origen=slug` con `Cache-Control: no-store`; el contador pasa a 1 y **sigue en 1** tras esperar; el slug en mayúsculas funciona; 3 visitas seguidas y 10 simultáneas suman exactamente; total y desglose por días coinciden) · **T69** (+1 exacto, solo enlaces activos, día **local**) · **T70** (**20 conexiones × 10 clics a la vez = 200 exactos**) · **T71** (control negativo: un contador «leer y luego escribir» **pierde** clics con las mismas conexiones) |
| **La redirección no espera al recuento** | **E29** (recuento frenado 3 s a propósito → el 302 llega en < 2 s y el clic se anota después) · **E28** (si la base de datos falla al resolver, la persona sigue siendo redirigida a la página de respaldo y no se cuenta nada) |
| **Slug inexistente → página por defecto** | **E27** (inexistente, desactivado, mayúsculas, 8 slugs raros: `302` a la página por defecto, sin contar, sin tocar otros contadores; sin página por defecto válida → `404` sin `Location`) · **T68** |
| **Una reserva hecha desde un enlace guarda su origen** | **E31** (clic en el enlace corto → formulario → turno reservado → `bookings.source = 'e2e-book'`, y el clic cuenta) · **E32** (`?origen=Instagram` → `instagram`; texto raro, HTML o de 150 caracteres → vacío; sin origen → vacío; **la reserva nunca falla**) · **T73** |
| **Formulario de creación: slug único y de formato válido** | **T61** (24 formatos malos rechazados sin crear nada y sin corregir en silencio) · **T62** (SLUG_TAKEN; **8 personas crean el mismo slug a la vez: gana una**) · **E34** (pantallas de error reales) |
| **Formulario protegido** | **E33** (sin credenciales, con usuario o contraseña erróneos: **401 en GET y en POST** y no se crea nada; con credenciales, crea el enlace y muestra la URL corta) |
| **Sin redirecciones abiertas (solo dominios permitidos)** | **T63** (**78 destinos maliciosos** rechazados —otro dominio, subdominio falso, `@`, `\`, `//`, `javascript:`, Unicode, saltos de línea, IP…— y 11 legítimos aceptados) · **T64** (la lista de dominios manda; `com`/`io` sueltos no valen; http solo para `localhost`) · **T66** (también en las altas/ediciones a mano en el panel) · **T67–T68** (se revalida en cada clic) · **E35** (**destinos ajenos metidos a la fuerza en la base de datos: el clic NO redirige allí**) · **E34** |
| **El contador no se manipula desde fuera** | **T72** (RLS; `anon`/`authenticated` no leen, escriben ni ejecutan nada; el contador no se mueve) · **E36** (**la API real** rechaza a `anon` y sin clave: tablas, vistas y RPC; `PATCH`/`POST`/`DELETE` sobre `links`; el contador no se mueve) |
| **Previsualizadores y bots no inflan los clics** | **E30** (WhatsApp, Facebook, Slack, Googlebot, curl, Chrome headless, Telegram, monitor, `node`, sin `User-Agent`: se redirigen pero **no suman**; `HEAD` tampoco; una persona sí) |
| **La conversión por canal devuelve datos coherentes** | **T74** (clics, reservas y conversión por enlace y por canal con datos conocidos: 40,0 % · 33,3 % · 25 % · 30,0 % de un canal con 2 enlaces; la suma de reservas de todos los canales = todas las reservas) · **T81** (las consultas de `supabase/consultas/` se ejecutan y la de «por periodo» coincide con las vistas) · **E37** (con los datos reales de esta ejecución, vía API: por enlace y por canal) |
| **Un bloqueo quita horas del desplegable** | **T75** (vacaciones de varios días y a media jornada) · **T76** (festivos, globales y de un servicio) · **T77** (huecos sueltos: bordes exactos, 5 minutos) · **T78** (editar/borrar/solapar) · **E38** (hueco suelto, en el desplegable real) · **E39** (festivo y vacaciones: «Ese día está completo» y se proponen días posteriores) |
| **Un bloqueo sobre turnos confirmados no los borra y se pueden detectar** | **T79** (la vista `blocks_affected_bookings` y `bookings_affected_by()` listan exactamente los confirmados y futuros que se solapan; bordes, parciales, global/servicio, cancelados/asistidos/pasados fuera) · **T80** (los turnos quedan byte a byte iguales; la hora no se ofrece a nadie más; se puede cancelar o cambiar a otra hora libre pero no a una bloqueada) · **E40** (en el navegador y por la API) |
| **Las Fases 1 y 2 siguen funcionando** (regresión) | **T01–T60** y **E01–E25** completas, ejecutadas con los workflows y migraciones ya modificados. Solo se ajustó **T02** (ahora 9 tablas con RLS). **T60** (permisos de todas las funciones) cubre también las nuevas |

### Las pruebas detectan el fallo de verdad (mutaciones)

* `MUTATE=3 node run-tests.mjs` (**Fase 3**: el filtro de dominios compara con «contiene» en vez de «igual o termina en `.dominio`») → fallan **T63** (`rocketnova.io.evil.com` pasaría) y **T64** (`notmidominio.es` pasaría).
* `MUTATE=4 node run-tests.mjs` (**Fase 3**: el contador lee el valor y luego escribe) → falla **T70** (quedan 15 clics en vez de 200) y, por arrastre, **T81**.

* `MUTATE=1 node run-tests.mjs` (Fase 1: quita el bloqueo por servicio y la restricción de exclusión) → fallan **T12, T26, T27, T28** y ahora también **T39, T40, T41 y T42**: el cambio de hora atómico descansa en esa restricción. Las siguientes caen por arrastre y el arnés termina con error de conexión.
* `MUTATE=2 node run-tests.mjs` (quita `SKIP LOCKED` y la guarda `IS NULL` del reclamo de recordatorios) → falla **T49** (las 6 ejecuciones se llevan los 12 turnos cada una: 72 envíos en vez de 12) y **T50**. Igual: las siguientes caen por arrastre.
* **T51** demuestra además que un reclamo «mirar y luego marcar» duplica con las mismas 4 conexiones.

(En PowerShell: `$env:MUTATE=2; node run-tests.mjs`.) `MUTATE=3` y `MUTATE=4` son de la Fase 3 (ver arriba).

### Cosas que las pruebas destaparon o afinaron

**Fase 3**

1. **Las repeticiones de una expresión regular de Postgres llegan a 255.** La primera versión de la validación del destino usaba `{1,2000}` y fallaba con «invalid repetition count(s)»: ahora la longitud se mide aparte.
2. **El slug `%00` (un carácter nulo) se hacía pasar por una caída de Supabase** (el JSON con `\u0000` lo rechaza Postgres): redirigía a la página de *respaldo* en vez de a la de *por defecto*. El workflow 06 limpia el slug (ASCII imprimible, ≤ 100) antes de llamar a la base de datos.
3. **`HEAD` no lo atiende el webhook** (404): no cuenta, que es lo que se quiere; pero `curl -I` no sirve para probar el enlace (se documenta en [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md)).
4. **Una base de datos de pruebas en WIN1252 no admitía los casos Unicode** (emoji, barra de ancho completo, cirílico): el arnés SQL crea ahora el clúster en UTF-8, como Supabase.
5. **n8n lanzado desde la carpeta del proyecto cargó el `.env` de la raíz** y cambió las URL de los formularios (todas las pruebas de formulario fallaban): el arnés lanza n8n desde otra carpeta.
6. Las URL de `.` y `%2e%2e` no llegan al servidor (el cliente las normaliza antes), así que no forman parte de E27; las de `..%2f..%2f`, `%0d%0a` e `https:%2f%2f` sí, y n8n las rechaza con 404 sin ejecutar nada.

**Fases 1 y 2**

1. **La regla «no enviar el de 24 h a turnos reservados con < 24 h» se mide desde cuándo se reservó (o se cambió), no desde ahora.** Mis primeros escenarios de prueba daban por «corto» un turno reservado con 24,5 h de margen (y por «cambiado con < 24 h» uno cambiado con 25 h de margen): sí les tocaba recordatorio. Quedó fijado en T47 y E23 con los dos casos.
2. **El de 1 h necesita la misma regla.** Sin ella, un turno reservado con 30 min de margen recibiría el «te quedan 1 h» justo después de su confirmación.
3. **Pasar de 10:00 a 10:30 es imposible con la disponibilidad normal** (el descanso del propio turno bloquea la hora), de ahí el parámetro «turno que se mueve» (T36, E19).
4. **La cancelación posterior a un cambio tenía que subir el `SEQUENCE`** (si seguía fijo en 1, los calendarios no la verían como más reciente que el cambio): T43, E20.
5. Una función que bloquea filas (`FOR UPDATE`) no puede declararse `STABLE`: las de consulta del cambio de hora son `VOLATILE`.

### Pruebas de las Fases 1 y 2 que se ajustaron (y solo estas)

| Prueba | Por qué |
|---|---|
| T02 | cuenta las tablas con RLS: ahora son 9 (`daily_summary_log` en la Fase 2; `links` y `link_clicks_daily` en la Fase 3) |
| T34 | comprueba las claves de `get_config`: ahora son 5 (se añadieron `staff_email` y `reschedule_form_url`; las 3 de la Fase 1 siguen igual) |
| E13 | filtra `email_log` por `kind = 'confirmation'`: ahora también se registran los avisos a quien atiende |

## Lo que NO se ha probado (para ser claros)

* **El dominio real, el DNS y el proxy** (`l.rocketnova.io` con Nginx/Caddy/Cloudflare): se probó el webhook al que traducen; las configuraciones de [DOMINIO-ENLACES.md](DOMINIO-ENLACES.md) **no** se ejecutaron contra un dominio real.
* **La autenticación `n8nUserAuth`** del formulario de creación (sí la de usuario y contraseña, E33). **Cuántos enlaces** (el rendimiento con miles de clics por minuto: lo más que se probó son 200 clics simultáneos en SQL y 10 en n8n).
* **Un bot que se haga pasar por un navegador** suma como una persona (la detección es por `User-Agent`); el límite de peticiones por IP del proxy no está probado.
* **Contra un proyecto Supabase real ni n8n Cloud.** Se usó el mismo PostgREST y las funciones estándar de Postgres, pero con PostgreSQL 18 (Supabase usa 15/17): no se emplea nada posterior a PG 13, aun así conviene ejecutar `supabase db push` y repetir la prueba rápida de la instalación.
* **Cómo se ve el `.ics` actualizado en Gmail, Outlook o Apple Calendar** (si de verdad sustituyen el evento por el `UID`/`SEQUENCE`). Se validó el formato (RFC 5545, CRLF, ≤ 75 octetos, UTC, mismo `UID`, `SEQUENCE` creciente) con un parser independiente, no con los clientes reales.
* **La cadencia real de 15 minutos.** El E2E usa `* * * * *` (cada minuto) para no esperar; el código y las funciones son los mismos y la lógica de ventanas se prueba con reloj fijo en SQL (T46–T53), pero el cron `*/15 * * * *` no se ejecutó durante horas.
* **El resumen a las 08:00 con el reloj real.** En E25 se fija `daily_summary_time` en `00:00` (y en `23:59` para «aún no»); la comparación de la hora local y el día de 25 h se prueban en SQL (T54, T55, T59).
* **El cambio de hora de verano/invierno en los programados** (el cron de n8n usa la zona del workflow): la parte de datos (UTC, día local) está probada; el disparo de n8n en esa noche concreta, no.
* **Una caída de n8n entre el reclamo y el envío** de un recordatorio: por diseño ese recordatorio no se reenvía (ver [FASE2.md](FASE2.md) §2); no se provocó.
* **Correos reales:** el SMTP es un servidor de captura; rebotes y spam no se contemplan.
* **Móvil, accesibilidad** y **carga** (la mayor concurrencia probada son 12 conexiones sobre un mismo hueco).

## Cómo repetirlas

```bash
# Base de datos (no necesita nada instalado salvo Node 22+)
cd tests && npm install && npm test                   # 81 pruebas; escribe tests/RESULTADOS.md
MUTATE=1 node run-tests.mjs                           # debe FALLAR T12, T26-T28 y T39-T42
MUTATE=2 node run-tests.mjs                           # debe FALLAR T49 y T50
MUTATE=3 node run-tests.mjs                           # (Fase 3) debe FALLAR T63 y T64
MUTATE=4 node run-tests.mjs                           # (Fase 3) debe FALLAR T70
# Si el puerto 54329 está ocupado: PGPORT_TEST=54399 npm test

# Extremo a extremo (≈ 30 min): ver tests/e2e/README.md
```

## Lista completa

### Base de datos (`tests/run-tests.mjs`)

| # | Prueba | Resultado |
|---|---|---|
| T01 | seed: 1 servicio, 5 días de horario, 1 bloqueo (y relanzable sin duplicar) | ✔ |
| T02 | RLS activado en las 7 tablas (6 de la Fase 1 + daily_summary_log de la Fase 2) | ✔ |
| T03 | anon y authenticated no pueden leer/escribir tablas ni ejecutar funciones; service_role sí | ✔ |
| T04 | el bloqueo del seed se descuenta de las horas libres (hora real) | ✔ |
| T05 | un lunes normal ofrece 09:00-13:30 y 16:00-18:30 cada 30 min | ✔ |
| T06 | viernes solo mañana; sábado y domingo cerrados | ✔ |
| T07 | antelación mínima X=2h: con "ahora"=09:00 la primera hora de hoy es las 11:00 | ✔ |
| T08 | días vista Y=30: hoy+30 se ofrece, hoy+31 no, y ayer no | ✔ |
| T09 | bloqueo de un servicio: descuenta solo ese servicio | ✔ |
| T10 | bloqueo global (service_id nulo): afecta a todos los servicios | ✔ |
| T11 | el descanso se respeta: tras reservar 10:00 (+10 min) desaparecen 09:30, 10:00 y 10:30; 09:00 y 11:00 siguen | ✔ |
| T12 | la BD rechaza a mano un solape dentro del descanso (23P01) y acepta justo al terminar | ✔ |
| T13 | día lleno: get_availability no devuelve horas y propone los próximos días con huecos | ✔ |
| T14 | cambio de hora de OCTUBRE 2026: las 09:00 locales son 07:00Z el viernes 23 y 08:00Z el lunes 26 | ✔ |
| T15 | cambio de hora de MARZO 2026: las 09:00 locales son 08:00Z el viernes 27 y 07:00Z el lunes 30 | ✔ |
| T16 | domingo 25-oct-2026 (fin de horario de verano): franja 01:00-05:00 = 5 horas reales; el desplegable desambigua las dos 02:00 | ✔ |
| T17 | domingo 28-mar-2027 (inicio de horario de verano): franja 01:00-05:00 = 3 horas reales; no existe la 02:00 | ✔ |
| T18 | reservar tras el cambio de hora guarda UTC correcto y devuelve la hora local de Madrid | ✔ |
| T19 | reserva correcta: código de 256 bits, correo en minúsculas, consentimiento y descanso guardados | ✔ |
| T20 | validación: nombre, correo, teléfono y consentimiento | ✔ |
| T21 | horas no ofrecidas se rechazan: fuera de horario, no alineadas, antelación < X, fin de semana, día pasado, > Y días | ✔ |
| T22 | una persona = un turno futuro confirmado por servicio (correo normalizado) | ✔ |
| T23 | cancelar libera el hueco y se puede volver a reservar | ✔ |
| T24 | cancelaciones erróneas: código inválido, ya cancelado, turno pasado y fuera de plazo; sin revelar datos | ✔ |
| T25 | plazo de cancelación propio (cancel_notice_hours=24) y por defecto igual a X | ✔ |
| T26 | CARRERA: 12 personas reservan el MISMO hueco a la vez (5 rondas) -> solo una lo consigue | ✔ |
| T27 | CARRERA determinista: A reserva sin confirmar, B queda esperando y al hacer commit A recibe "SLOT_TAKEN" B | ✔ |
| T28 | la propia BD impide el solape aunque se salte la función: 10 INSERT directos simultáneos -> 1 éxito y 9 rechazos (23P01 o deadlock 40P01) | ✔ |
| T29 | CARRERA: la misma persona pide 8 turnos distintos a la vez -> solo 1 confirmado (resto ALREADY_HAS_BOOKING) | ✔ |
| T30 | CARRERA: dos cancelaciones simultáneas del mismo código -> una ok y otra NOT_CANCELLABLE | ✔ |
| T31 | ediciones desde el panel: alta con solo inicio calcula fin y descanso; el correo se normaliza; sin consentimiento no entra | ✔ |
| T32 | cancelar a mano desde el panel (status=cancelled) libera el hueco y rellena cancelled_at | ✔ |
| T33 | restricciones del horario semanal y de los servicios | ✔ |
| T34 | get_availability devuelve JSON con horas (etiqueta HH:MI y UTC) y list_active_services/get_config/log_email funcionan | ✔ |
| T35 | cambiar la hora: UNA misma fila (mismo id y código) pasa a la hora nueva; la antigua se libera; fin, descanso, versión del .ics y fecha del cambio se actualizan | ✔ |
| T36 | get_reschedule_availability usa la MISMA disponibilidad: igual que get_availability en otros días; en el día del turno el propio hueco cuenta como libre y su hora actual no se ofrece | ✔ |
| T37 | reglas del cambio: antelación X, días vista Y, horario, bloqueos, plazo mínimo para cambiar, estado del turno y código; el turno nunca se altera | ✔ |
| T38 | FALLO FORZADO 1: la hora nueva está ocupada por otra persona -> SLOT_TAKEN y el turno original queda byte a byte igual | ✔ |
| T39 | FALLO FORZADO 2 (carrera en la propia BD): alguien ocupa el hueco nuevo SALTÁNDOSE las funciones mientras se valida el cambio -> la restricción de exclusión lo rechaza y el original no se mueve; si esa otra operación se deshace, el cambio sí prospera | ✔ |
| T40 | FALLO FORZADO 3 (error inesperado DESPUÉS del UPDATE, p. ej. fallo del servidor): se deshace todo, el turno original sigue en su sitio y la hora nueva sigue libre | ✔ |
| T41 | CARRERA: 6 cambios de hora y 4 reservas nuevas pelean por el MISMO hueco -> gana una sola operación; las demás no se mueven | ✔ |
| T42 | dos cambios simultáneos del MISMO código a horas distintas: se aplican uno tras otro, queda un solo turno confirmado y la versión del .ics sube dos veces | ✔ |
| T43 | versión del .ics (SEQUENCE): reserva 0 -> cambio 1 -> cancelación 2; una cancelación sin cambios previos devuelve 1 (como en la Fase 1) y ambas llevan el teléfono | ✔ |
| T44 | mover un turno rearma sus recordatorios (por la RPC y también editando starts_at a mano en el panel); editar otro campo no los rearma | ✔ |
| T45 | cambio de hora (octubre 2026): pasar del viernes 23 (UTC+2) al lunes 26 (UTC+1) a las 09:00 guarda 08:00Z y avisa con la hora local correcta | ✔ |
| T46 | recordatorio de 24 h: no sale antes de tiempo, sale justo a las 24 h con todos los datos, y nunca se repite | ✔ |
| T47 | NO se envía el de 24 h a turnos reservados (o cambiados) con menos de 24 h de antelación, ni el de 1 h a los reservados con menos de 1 h; ventanas: 24 h hasta 2 h antes, 1 h hasta el inicio | ✔ |
| T48 | un turno CANCELADO no recibe recordatorios (ni antes ni después de cancelar); tampoco los marcados asistido / no presentado | ✔ |
| T49 | CARRERA de recordatorios: 6 ejecuciones simultáneas reclaman 12 turnos pendientes (3 rondas) -> cada recordatorio sale EXACTAMENTE una vez | ✔ |
| T50 | CARRERA determinista: una ejecución reclama sin terminar; la segunda no espera ni reclama lo mismo; al confirmar la primera nadie más lo recibe; si la primera se deshace, la segunda sí | ✔ |
| T51 | CONTROL NEGATIVO: un reclamo ingenuo (SELECT y luego UPDATE, sin atomicidad) SÍ envía duplicados con las mismas 4 conexiones -> T49 detectaría el fallo | ✔ |
| T52 | fallo de envío: queda constancia en email_log, el reclamo se libera, se reintenta en la pasada siguiente SIN duplicar y, tras 3 fallos, se da por fallido (gave_up) | ✔ |
| T53 | un turno movido recibe recordatorios nuevos para su nueva hora (los de la antigua no cuentan) | ✔ |
| T54 | resumen diario: no sale antes de las 08:00 (Madrid), a las 08:00 lista SOLO los confirmados del día ordenados por hora (todos los servicios), y no repite | ✔ |
| T55 | el "día" del resumen es el día LOCAL aunque tenga 25 h: el domingo 25-oct-2026 incluye 00:30 y 23:30 locales, pero no el 00:30 del lunes | ✔ |
| T56 | CARRERA del resumen: 6 ejecuciones simultáneas a las 08:00 -> exactamente UNA recibe due=true; las demás ALREADY_DONE | ✔ |
| T57 | día sin turnos: por defecto se envía un aviso breve (count 0); con daily_summary_send_empty=false no se envía nada y tampoco se reintenta | ✔ |
| T58 | fallo del resumen: constancia en email_log, reintento en la pasada siguiente (máx. 3 intentos) y aviso final; si se envía, queda "sent" | ✔ |
| T59 | hora del resumen configurable (daily_summary_time); un valor inválido cae a 08:00; staff_email vacío usa admin_email | ✔ |
| T60 | seguridad de lo nuevo: ninguna función de public es ejecutable por anon/authenticated/PUBLIC, la tabla nueva tiene RLS, y service_role llama a las 7 RPC nuevas | ✔ |
| T61 | slug: solo minúsculas, números y guiones (sin guion al principio/final ni dobles, 1-40); lo demás se rechaza sin crear nada y sin corregir en silencio | ✔ |
| T62 | slug único: el segundo intento falla con SLUG_TAKEN; y si 8 personas crean el MISMO slug a la vez, solo una lo consigue | ✔ |
| T63 | destino: NINGÚN truco de redirección abierta pasa (78 casos: otro dominio, subdominio falso, @, \\, esquemas, //, Unicode, espacios, IP…) y los 11 destinos legítimos sí; bucle y `origen=` repetido | ✔ |
| T64 | la lista de dominios manda: editable (comas, espacios, comodín), no admite «com»/«io» sueltos, vacía no permite nada, y http solo vale para localhost | ✔ |
| T65 | create_link con destino: vacío = formulario de reserva; destinos malos se rechazan sin crear nada | ✔ |
| T66 | las altas y ediciones a mano en el panel pasan por las mismas reglas: destino, slug inmutable y formato | ✔ |
| T67 | resolve_link: destino + origen=<slug> (antes del #fragmento), sin distinguir mayúsculas en la URL, y no modifica nada | ✔ |
| T68 | resolve_link con slug inexistente, desactivado o raro: página por defecto, nunca un error; la página por defecto también se valida; el destino se revalida en cada clic | ✔ |
| T69 | un clic suma exactamente 1 (total y día local); solo cuentan enlaces que existen y están activos | ✔ |
| T70 | CARRERA: 20 conexiones × 10 clics a la vez sobre el MISMO enlace = 200 exactos, y el total coincide con la suma por días | ✔ |
| T71 | CONTROL NEGATIVO: un contador ingenuo (leer y luego escribir) PIERDE clics con las mismas conexiones → T70 detectaría el fallo | ✔ |
| T72 | seguridad de los enlaces: RLS, anon/authenticated no pueden leer, escribir ni tocar el contador, y solo service_role ejecuta las RPC | ✔ |
| T73 | bookings.source: minúsculas si tiene forma de slug y, si no, se descarta (la reserva NUNCA falla por un origen raro) | ✔ |
| T74 | estadísticas coherentes: clics, reservas y conversión por enlace y por canal con datos conocidos; la suma de canales = todas las reservas | ✔ |
| T75 | VACACIONES (bloqueo global de varios días): ninguna hora de esos días, los siguientes normales; a media jornada solo quita lo que cae dentro | ✔ |
| T76 | FESTIVOS (un día entero, global o de un solo servicio): ese día no ofrece horas; el anterior y el posterior, sí | ✔ |
| T77 | HUECOS SUELTOS: quitan SOLO las horas que tocan; los bordes exactos siguen libres; 5 minutos bastan para quitar una hora | ✔ |
| T78 | los bloqueos son «vivos»: acortarlos o borrarlos devuelve las horas; solapados se suman; uno pasado o de otro día no estorba | ✔ |
| T79 | TURNOS AFECTADOS: la vista y bookings_affected_by() listan exactamente los turnos confirmados y futuros que se solapan con un bloqueo (parcial o total, de un servicio o global); nada más | ✔ |
| T80 | un bloqueo SOBRE turnos ya confirmados NO los borra ni los toca; la hora no se ofrece a nadie más y la persona aún puede cancelar o cambiarla (no a otra hora bloqueada) | ✔ |
| T81 | las consultas listas para el panel (`supabase/consultas/*.sql`) se ejecutan sin error; la de «por periodo» coincide con la vista por canal y las comprobaciones de coherencia dan 0 | ✔ |

### Extremo a extremo (`tests/e2e/run-e2e.mjs`)

| # | Prueba | Resultado |
|---|---|---|
| E01 | reserva completa de principio a fin, en la semana del cambio de hora: lunes 26-oct-2026 09:00 (UTC+1) → correo con .ics 08:00Z | ✔ |
| E02 | viernes 23-oct-2026 09:00 (aún horario de verano, UTC+2) → .ics 07:00Z | ✔ |
| E03 | solo se ven horas libres: respeta bloqueo (seed), horario, y tras reservar las 10:00 oculta 09:30/10:00/10:30 (descanso) | ✔ |
| E04 | teléfono no válido: aviso claro y los datos escritos se conservan | ✔ |
| E05 | sin aceptar la privacidad no se avanza | ✔ |
| E06 | CARRERA por el mismo hueco (A reserva, B tenía la lista vieja): B ve "Ese turno acaba de ocuparse", vuelve a elegir y NO pierde sus datos | ✔ |
| E07 | CARRERA simultánea: 4 navegadores pulsan "Reservar" a la vez en el MISMO hueco → solo uno obtiene el turno | ✔ |
| E08 | día completo → propone los próximos días con huecos y permite continuar | ✔ |
| E09 | una persona con turno futuro no puede reservar otro en el mismo servicio | ✔ |
| E10 | cancelar desde el enlace del correo: formulario con el código ya puesto → "Turno cancelado" + correo con .ics de cancelación; el hueco se libera | ✔ |
| E11 | cancelación con errores: código inválido y turno ya cancelado → mensajes claros SIN datos del turno | ✔ |
| E12 | fuera de plazo (< X horas) no se puede cancelar | ✔ |
| E13 | si el correo FALLA la reserva no se pierde: se registra en email_log y se avisa en pantalla (con el enlace de gestión) | ✔ |
| E14 | formularios ABANDONADOS (página 1 y página de horas): al vencer la espera la ejecución termina sola; no queda nada "en espera" con datos personales y no se crea ninguna reserva | ✔ |
| E17 | al RESERVAR llega el aviso inmediato a quien atiende con los datos correctos (sin el código secreto), tras la confirmación a la persona, que ahora trae el enlace para cambiar la hora | ✔ |
| E18 | al CANCELAR llega el aviso a quien atiende con los datos correctos; la cancelación lleva SEQUENCE:1 | ✔ |
| E19 | CAMBIO DE HORA en el mismo día (10:00 → 10:30) por el formulario: ve las horas libres con la misma disponibilidad (su propio hueco cuenta como libre), la fila se actualiza, correo con .ics actualizado y aviso con hora antigua y nueva | ✔ |
| E20 | CAMBIO DE HORA a otro día: el hueco antiguo se libera, el nuevo se ocupa; la cancelación posterior sustituye al evento (SEQUENCE:2 > 1) | ✔ |
| E21 | CAMBIO FALLIDO FORZADO: otra persona ocupa la hora elegida mientras se decide -> "Esa hora acaba de ocuparse", el turno original NO se toca ni se libera, no sale ningún correo; al elegir otra hora sí se cambia | ✔ |
| E22 | cambios que NO se pueden hacer: código inválido, turno cancelado y fuera de plazo -> mensajes claros, sin datos, sin tocar nada y sin avisos | ✔ |
| E23 | RECORDATORIOS: 24 h y 1 h salen UNA sola vez aunque el workflow se dispare DOS veces a la vez; nada para cancelados, reservados con < 24 h, cambiados con < 24 h ni turnos aún no llegados | ✔ |
| E24 | RECORDATORIOS con fallo de envío: queda en email_log, se reintenta en la pasada siguiente SIN duplicar y llega una sola vez; tras 3 fallos se rinde y avisa al administrador (sin datos personales) | ✔ |
| E25 | RESUMEN DIARIO: no sale antes de la hora configurada; a la hora llega UN correo (aunque haya dos workflows a la vez) con los turnos de hoy ordenados por hora y los datos correctos; sin turnos, un aviso breve | ✔ |
| E26 | UN CLIC CUENTA UNA SOLA VEZ y redirige con 302 al destino + ?origen=<slug> (sin caché); mayúsculas; visitas seguidas y 10 simultáneas suman exactas | ✔ |
| E27 | slug inexistente, desactivado o raro → 302 a la página por defecto, NO se cuenta y nunca redirige a otro sitio; sin página por defecto válida → 404 | ✔ |
| E28 | si la base de datos falla al resolver, la persona igualmente es redirigida a la página de respaldo y no se cuenta nada | ✔ |
| E29 | LA REDIRECCIÓN NO ESPERA AL RECUENTO: con el recuento frenado 3 s, el 302 llega en < 2 s y el clic se anota después | ✔ |
| E30 | previsualizadores, rastreadores y herramientas se redirigen pero NO suman (ni `HEAD`); una persona sí | ✔ |
| E31 | UNA RESERVA HECHA DESDE UN ENLACE GUARDA SU ORIGEN: clic → formulario → turno → bookings.source = slug (y el clic cuenta) | ✔ |
| E32 | un ?origen= raro, en mayúsculas o ausente NUNCA impide reservar | ✔ |
| E33 | FORMULARIO DE CREACIÓN PROTEGIDO: sin usuario y contraseña (o erróneos) no entra ni por GET ni por POST y no se crea nada; con ellos crea el enlace | ✔ |
| E34 | el formulario de creación valida: slug malo/repetido, destino ajeno / con @ / con origen / el propio dominio corto, canal malo; un destino válido sí | ✔ |
| E35 | REDIRECCIÓN ABIERTA: aunque se meta a la fuerza un destino ajeno en la base de datos, el clic NO redirige allí y no cuenta | ✔ |
| E36 | EL CONTADOR NO SE PUEDE MANIPULAR DESDE FUERA: la API rechaza a anon y sin clave (tablas, vistas, RPC y escrituras) y el contador no se mueve | ✔ |
| E37 | ESTADÍSTICAS desde la API con datos reales: clics, reservas y conversión por enlace y canal coinciden con las tablas; suma de canales = todas las reservas | ✔ |
| E38 | HUECO SUELTO en el desplegable real: quita solo sus horas; los bordes siguen libres; al borrarlo todo vuelve | ✔ |
| E39 | FESTIVO Y VACACIONES en el formulario real: días sin horas, se proponen días posteriores; vale para todos los servicios | ✔ |
| E40 | UN BLOQUEO SOBRE TURNOS CONFIRMADOS NO LOS BORRA: siguen confirmados, la vista de turnos afectados los lista, la hora no se ofrece y la persona aún puede cancelar | ✔ |
| E15 | la API real (PostgREST) rechaza a anon y a quien no lleva clave: ni tablas ni funciones | ✔ |
| E16 | un fallo de verdad en un workflow (la API cae) → el workflow de errores avisa por correo al administrador | ✔ |

## Capturas de las pruebas E2E

| Turno reservado (E01) | Teléfono inválido, datos conservados (E04) |
|---|---|
| ![](capturas/e01-turno-reservado.png) | ![](capturas/e04-telefono-invalido.png) |

| «Ese turno acaba de ocuparse» (E06) | Día completo (E08) |
|---|---|
| ![](capturas/e06-turno-ocupado.png) | ![](capturas/e08-dia-completo.png) |

| Cancelado (E10) | Correo fallido, reserva a salvo (E13) |
|---|---|
| ![](capturas/e10-cancelado.png) | ![](capturas/e13-correo-fallido.png) |

| Cambio de hora: horas libres (E19) | Cambio fallido forzado: «Esa hora acaba de ocuparse» (E21) |
|---|---|
| ![](capturas/e19-cambio-horas.png) | ![](capturas/e21-hora-ocupada.png) |

| Hora cambiada (E19) | Fuera de plazo para cambiar (E22) |
|---|---|
| ![](capturas/e19-hora-cambiada.png) | ![](capturas/e22-fuera-de-plazo.png) |

| Resumen diario recibido por quien atiende (E25, correo renderizado) |
|---|
| ![](capturas/e25-resumen-diario.png) |

| Reserva hecha desde un enlace corto (E31) | Formulario de creación de enlaces (E33) |
|---|---|
| ![](capturas/e31-reserva-desde-enlace.png) | ![](capturas/e33-crear-enlace.png) |

| Enlace creado (E33) |
|---|
| ![](capturas/e33-enlace-creado.png) |

