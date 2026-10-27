//@@LIB@@
// Fase 2 · aviso inmediato a quien atiende: TURNO CANCELADO.
const r = $('Cancelar turno').last().json;               // respuesta de cancel_booking (ok: true)
const cfg = $('Cargar parámetros').first().json;         // get_config()
const conf = $('Configuración').first().json;

const { text, html } = plantillaAviso('Turno cancelado', [
  ['Servicio', r.service_name],
  ['Día', fechaLarga(r.local_date)],
  ['Hora', `${r.local_time} (hora de ${r.timezone})`],
  ['Nombre', r.customer_name],
  ['Teléfono', r.customer_phone],
  ['Correo', r.customer_email],
  ['Estado', 'El hueco ha quedado libre'],
]);

return [{ json: {
  booking_id: r.booking_id,
  from: conf.from_email,
  to: destinoPersonal(cfg, conf),
  subject: `[Turnos] Turno cancelado: ${r.service_name} · ${dmy(r.local_date)} ${r.local_time} · ${r.customer_name}`,
  text, html,
} }];
