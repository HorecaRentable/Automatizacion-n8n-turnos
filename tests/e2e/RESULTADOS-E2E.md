# Resultado de las pruebas de extremo a extremo

Ejecutado: 2026-10-21T19:02:36.432Z

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
| E26 | UN CLIC CUENTA UNA SOLA VEZ y redirige con 302 al destino + ?origen=<slug> (sin caché); el slug no distingue mayúsculas; las visitas suman una a una, también 10 a la vez | ✔ |
| E27 | slug inexistente, desactivado o raro → 302 a la página por defecto, NO se cuenta y nunca redirige a otro sitio; sin página por defecto válida → 404 | ✔ |
| E28 | si la base de datos falla al resolver, la persona IGUALMENTE es redirigida a la página de respaldo y no se cuenta nada | ✔ |
| E29 | LA REDIRECCIÓN NO ESPERA AL RECUENTO: con el recuento frenado 3 s, el 302 llega en < 2 s y el clic se anota después | ✔ |
| E30 | previsualizadores, rastreadores y herramientas (WhatsApp, Facebook, Slack, Googlebot, curl, Chrome headless, sin User-Agent) se redirigen pero NO suman; una persona sí | ✔ |
| E31 | UNA RESERVA HECHA DESDE UN ENLACE GUARDA SU ORIGEN: clic en el enlace corto → formulario → turno → bookings.source = slug (y el clic cuenta) | ✔ |
| E32 | un ?origen= raro, en mayúsculas o ausente NUNCA impide reservar: mayúsculas se normalizan, texto raro o largo se descarta, sin origen queda vacío | ✔ |
| E33 | FORMULARIO DE CREACIÓN PROTEGIDO: sin usuario y contraseña (o con una errónea) no entra ni por GET ni por POST y no se crea nada; con ellos crea el enlace y lo muestra | ✔ |
| E34 | el formulario de creación valida: slug con formato malo, slug repetido, destino de otro dominio / con @ / con origen / que es el propio dominio corto, y canal malo (nada se crea); un destino válido sí | ✔ |
| E35 | REDIRECCIÓN ABIERTA: aunque alguien meta a la fuerza un destino ajeno en la base de datos, el clic NO redirige allí (va a la página por defecto) y no cuenta | ✔ |
| E36 | EL CONTADOR NO SE PUEDE MANIPULAR DESDE FUERA: la API de Supabase rechaza a anon y a quien no lleva clave (tablas, vistas y RPC) y ningún intento mueve el contador | ✔ |
| E37 | ESTADÍSTICAS desde la API con datos reales de esta ejecución: clics, reservas y conversión por enlace y por canal coinciden con las tablas; la suma de canales = todas las reservas | ✔ |
| E38 | HUECO SUELTO: un bloqueo de 11:15 a 12:05 quita del desplegable SOLO 11:00, 11:30 y 12:00 (los bordes siguen libres), otro de 5 minutos quita su hora; al borrarlos todo vuelve | ✔ |
| E39 | FESTIVO Y VACACIONES: un festivo deja el día sin horas; unas vacaciones de lunes a viernes dejan esos días vacíos y proponen un día posterior; vale para todos los servicios | ✔ |
| E40 | UN BLOQUEO SOBRE TURNOS YA CONFIRMADOS NO LOS BORRA: siguen confirmados, la vista de turnos afectados los lista, la hora no se ofrece a nadie más y la persona aún puede cancelar | ✔ |
| E15 | la API real (PostgREST) rechaza a anon y a quien no lleva clave: ni tablas ni funciones | ✔ |
| E16 | un fallo de verdad en un workflow (la API cae) → el workflow de errores avisa por correo al administrador | ✔ |

**40/40 correctas**
