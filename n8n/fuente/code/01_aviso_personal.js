//@@LIB@@
// Fase 2 · aviso inmediato a quien atiende: NUEVA RESERVA.
// Va después del correo a la persona (su confirmación sale primero) y es tolerante a fallos:
// si este correo no sale, queda en email_log y la persona ve igualmente su confirmación.
const r = $('Reservar turno').last().json;               // respuesta de book_slot (ok: true)
const cfg = $('Cargar parámetros').first().json;         // get_config()
const conf = $('Configuración').first().json;
const telefono = $('Preparar reserva').last().json.body.p_phone;

const { text, html } = plantillaAviso('Nueva reserva', [
  ['Servicio', r.service_name],
  ['Día', fechaLarga(r.local_date)],
  ['Hora', `${r.local_time} (hora de ${r.timezone})`],
  ['Nombre', r.customer_name],
  ['Teléfono', telefono],
  ['Correo', r.customer_email],
]);

return [{ json: {
  booking_id: r.booking_id,
  from: conf.from_email,
  to: destinoPersonal(cfg, conf),
  subject: `[Turnos] Nueva reserva: ${r.service_name} · ${dmy(r.local_date)} ${r.local_time} · ${r.customer_name}`,
  text, html,
} }];
