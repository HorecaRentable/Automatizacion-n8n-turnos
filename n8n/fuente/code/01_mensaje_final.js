// Texto de la página final "Turno reservado". La reserva ya está guardada pase lo que pase con el correo.
const c = $('Generar correo').last().json;
let correoFallido = false;
try { correoFallido = $('Registrar fallo del correo').isExecuted; } catch (e) { /* no ejecutado */ }

const detalle = `${c.service_name} · ${c.fecha} a las ${c.local_time}`;
const mensaje = correoFallido
  ? `${detalle}.\nNo hemos podido enviarte el correo de confirmación, pero tu turno está reservado. `
    + `Guarda este enlace para poder cancelarlo: ${c.enlace}`
  : `${detalle}.\nTe hemos enviado la confirmación a ${c.to} con un archivo .ics para tu calendario. `
    + `En ese correo tienes el enlace para cancelar el turno.`;

return [{ json: { mensaje } }];
