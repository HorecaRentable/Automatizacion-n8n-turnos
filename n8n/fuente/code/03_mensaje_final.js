// Texto de la página final "Hora cambiada". El cambio ya está guardado pase lo que pase con el correo.
const c = $('Generar correo del cambio').last().json;
let correoFallido = false;
try { correoFallido = $('Registrar fallo del correo').isExecuted; } catch (e) { /* no ejecutado */ }
const r = $('Cambiar hora').last().json;

const detalle = `${c.service_name} · ${c.fecha} a las ${c.local_time}`;
const mensaje = correoFallido
  ? `${detalle}.\nNo hemos podido enviarte el correo de confirmación, pero la hora ya está cambiada. `
    + `Guarda este enlace para poder cancelarla o cambiarla: ${c.enlace}`
  : `${detalle}.\n(Antes: ${r.old_local_date.split('-').reverse().join('/')} a las ${r.old_local_time}.) `
    + `Te hemos enviado la confirmación a ${c.to} con un archivo .ics actualizado para tu calendario.`;

return [{ json: { mensaje } }];
