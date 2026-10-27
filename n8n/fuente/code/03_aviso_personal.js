//@@LIB@@
// Fase 2 · aviso inmediato a quien atiende: CAMBIO DE HORA (hora antigua y nueva).
const r = $('Cambiar hora').last().json;                 // respuesta de reschedule_booking (ok: true)
const cfg = $('Cargar parámetros').first().json;         // get_config()
const conf = $('Configuración').first().json;

const { text, html } = plantillaAviso('Cambio de hora', [
  ['Servicio', r.service_name],
  ['Antes', `${fechaLarga(r.old_local_date)} a las ${r.old_local_time}`],
  ['Ahora', `${fechaLarga(r.local_date)} a las ${r.local_time} (hora de ${r.timezone})`],
  ['Nombre', r.customer_name],
  ['Teléfono', r.customer_phone],
  ['Correo', r.customer_email],
]);

return [{ json: {
  booking_id: r.booking_id,
  from: conf.from_email,
  to: destinoPersonal(cfg, conf),
  subject: `[Turnos] Cambio de hora: ${r.service_name} · ${dmy(r.old_local_date)} ${r.old_local_time} → ${dmy(r.local_date)} ${r.local_time} · ${r.customer_name}`,
  text, html,
} }];
