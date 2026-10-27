# Resultado de las pruebas

Ejecutado: 2026-10-21T19:05:39.535Z · PostgreSQL 18.4

| # | Prueba | Resultado |
|---|---|---|
| T01 | seed: 1 servicio, 5 días de horario, 1 bloqueo (y relanzable sin duplicar) | ✔ |
| T02 | RLS activado en las 9 tablas (6 de la Fase 1 + daily_summary_log de la Fase 2 + links y link_clicks_daily de la Fase 3) | ✔ |
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
| T63 | destino: NINGÚN truco de redirección abierta pasa (otro dominio, subdominio falso, @, \, esquemas, //, Unicode, espacios, IP...) y los destinos legítimos sí | ✔ |
| T64 | la lista de dominios manda: se puede editar (comas, espacios, comodín), no admite "com"/"io" sueltos, vacía no permite nada, y http solo vale para localhost | ✔ |
| T65 | create_link con destino: vacío = formulario de reserva; destinos malos se rechazan sin crear nada | ✔ |
| T66 | las altas y ediciones a mano en el panel pasan por las mismas reglas: destino, slug inmutable y formato | ✔ |
| T67 | resolve_link: destino + origen=<slug> (antes del #fragmento), sin distinguir mayúsculas en la URL, y no modifica nada | ✔ |
| T68 | resolve_link con slug inexistente, desactivado o raro: página por defecto, nunca un error; el destino se revalida en cada clic | ✔ |
| T69 | un clic suma exactamente 1 (total y día local); solo cuentan enlaces que existen y están activos | ✔ |
| T70 | CARRERA: 20 conexiones × 10 clics a la vez sobre el MISMO enlace = 200 exactos, y el total coincide con la suma por días | ✔ |
| T71 | CONTROL NEGATIVO: un contador ingenuo (leer y luego escribir) PIERDE clics con las mismas conexiones -> T70 detectaría el fallo | ✔ |
| T72 | seguridad de los enlaces: RLS, anon/authenticated no pueden leer, escribir ni tocar el contador, y solo service_role ejecuta las RPC | ✔ |
| T73 | bookings.source: se guarda en minúsculas si tiene forma de slug y, si no, se descarta (la reserva NUNCA falla por un origen raro) | ✔ |
| T74 | estadísticas coherentes: clics, reservas y conversión por enlace y por canal con datos de prueba conocidos (y la suma de canales = todas las reservas) | ✔ |
| T75 | VACACIONES (bloqueo global de varios días): ninguna hora de esos días, los días siguientes normales; y a media jornada solo quita lo que cae dentro | ✔ |
| T76 | FESTIVOS (un día entero, global o de un solo servicio): ese día no ofrece horas; el día anterior y el posterior, sí | ✔ |
| T77 | HUECOS SUELTOS (reunión, cita médica...): quitan SOLO las horas que tocan; los bordes exactos siguen libres; 5 minutos bastan para quitar una hora | ✔ |
| T78 | los bloqueos son "vivos": acortarlos o borrarlos devuelve las horas; solapados se suman; y un bloqueo ya pasado o de otro día no estorba | ✔ |
| T79 | TURNOS AFECTADOS: la vista y bookings_affected_by() listan exactamente los turnos CONFIRMADOS y FUTUROS que se solapan con un bloqueo (parcial o total, de un servicio o global); nada más | ✔ |
| T80 | un bloqueo creado SOBRE turnos ya confirmados NO los borra ni los toca: siguen confirmados, la hora no se ofrece a nadie más y la persona aún puede cancelar o cambiarla (no a otra hora bloqueada) | ✔ |
| T81 | las consultas listas para el panel (supabase/consultas/*.sql) se ejecutan sin error; la de «por periodo» coincide con la vista por canal y las comprobaciones de coherencia dan 0 | ✔ |

**81/81 correctas**
