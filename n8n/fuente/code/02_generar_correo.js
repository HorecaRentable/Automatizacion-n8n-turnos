//@@LIB@@
const r = $input.first().json;                       // respuesta de cancel_booking (ok: true)
const conf = $('Configuración').first().json;

const fecha = fechaLarga(r.local_date);
const servicio = r.service_name;

// Mismo UID que el .ics de la reserva, con STATUS:CANCELLED y SEQUENCE mayor: los calendarios
// (Google, Apple, Outlook) retiran el evento al abrirlo.
const ics = buildIcs({
  uid: r.booking_id,
  start: r.starts_at,
  end: r.ends_at,
  summary: servicio,
  description: 'Turno cancelado.',
  cancelled: true,
  sequence: r.ics_sequence,          // Fase 2: sube también con cada cambio de hora (si no, la cancelación no sustituiría al evento)
});
const binary = { ics: await this.helpers.prepareBinaryData(Buffer.from(ics, 'utf8'), 'turno-cancelado.ics', 'text/calendar') };

const text = [
  `Hola ${r.customer_name},`, '',
  `Hemos cancelado tu turno:`,
  `  ${servicio}`,
  `  ${fecha} a las ${r.local_time} (hora de ${r.timezone})`, '',
  `El hueco ha quedado libre. Si quieres, puedes reservar otro cuando quieras.`,
].join('\n');

const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
<h2 style="margin:0 0 12px">Turno cancelado</h2>
<p>Hola ${esc(r.customer_name)},</p>
<p>Hemos cancelado tu turno:</p>
<p><b>${esc(servicio)}</b><br>${esc(fecha)} a las <b>${esc(r.local_time)}</b> (hora de ${esc(r.timezone)})</p>
<p>El hueco ha quedado libre. Puedes reservar otro cuando quieras.</p></div>`;

return [{ json: {
  booking_id: r.booking_id,
  from: conf.from_email,
  to: r.customer_email,
  subject: `Turno cancelado: ${servicio} · ${r.local_date.split('-').reverse().join('/')} ${r.local_time}`,
  text, html, fecha, local_time: r.local_time, service_name: servicio,
}, binary }];
