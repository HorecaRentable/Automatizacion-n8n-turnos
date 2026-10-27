//@@LIB@@
const r = $input.first().json;                       // respuesta de reschedule_booking (ok: true)
const cfg = $('Cargar parámetros').first().json;     // get_config()
const conf = $('Configuración').first().json;

const enlace = enlaceCon(cfg.cancel_form_url, r.management_code);
const enlaceCambio = enlaceCon(cfg.reschedule_form_url, r.management_code);
const fecha = fechaLarga(r.local_date);
const fechaAntes = fechaLarga(r.old_local_date);
const servicio = r.service_name;

// Mismo UID que el .ics de la reserva y SEQUENCE mayor: los calendarios (Google, Apple, Outlook)
// sustituyen el evento antiguo por este en vez de añadir uno nuevo.
const ics = buildIcs({
  uid: r.booking_id,
  start: r.starts_at,
  end: r.ends_at,
  summary: servicio,
  description: `Turno cambiado a nombre de ${r.customer_name}.\nPara cancelarlo: ${enlace}` + (enlaceCambio ? `\nPara cambiar la hora de nuevo: ${enlaceCambio}` : ''),
  url: enlace || undefined,
  cancelled: false,
  sequence: r.ics_sequence,
});
const binary = { ics: await this.helpers.prepareBinaryData(Buffer.from(ics, 'utf8'), 'turno-actualizado.ics', 'text/calendar') };

const text = [
  `Hola ${r.customer_name},`, '',
  `Hemos cambiado la hora de tu turno:`,
  `  ${servicio}`,
  `  Antes: ${fechaAntes} a las ${r.old_local_time}`,
  `  Ahora: ${fecha} a las ${r.local_time} (hora de ${r.timezone})`, '',
  `Adjuntamos un archivo .ics actualizado: al abrirlo, tu calendario sustituye el evento anterior.`, '',
  ...(enlaceCambio ? [`¿Necesitas otra hora? Cámbiala aquí:`, enlaceCambio, ''] : []),
  `¿No puedes venir? Cancélalo aquí (con la antelación indicada):`,
  enlace, '',
  `Guarda este enlace: contiene tu código secreto de gestión.`,
].join('\n');

const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
<h2 style="margin:0 0 12px">Hora de tu turno cambiada 🔄</h2>
<p>Hola ${esc(r.customer_name)},</p>
<p>Hemos cambiado la hora de tu turno:</p>
<table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:6px 12px 6px 0;color:#6b7280">Servicio</td><td><b>${esc(servicio)}</b></td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#6b7280">Antes</td><td><s>${esc(fechaAntes)} a las ${esc(r.old_local_time)}</s></td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#6b7280">Ahora</td><td><b>${esc(fecha)} a las ${esc(r.local_time)}</b> (hora de ${esc(r.timezone)})</td></tr></table>
<p>Adjuntamos un archivo <b>.ics</b> actualizado: al abrirlo, tu calendario sustituye el evento anterior.</p>
<p>${enlaceCambio ? `¿Necesitas otra hora? <a href="${esc(enlaceCambio)}">Cámbiala aquí</a>. ` : ''}¿No puedes venir? <a href="${esc(enlace)}">Cancela tu turno aquí</a>.</p>
<p style="color:#6b7280;font-size:13px">Guarda este correo: los enlaces contienen tu código secreto de gestión.</p></div>`;

return [{ json: {
  booking_id: r.booking_id,
  from: conf.from_email,
  to: r.customer_email,
  subject: `Hora cambiada: ${servicio} · ${dmy(r.local_date)} ${r.local_time}`,
  text, html, enlace, fecha,
  local_time: r.local_time, service_name: servicio, customer_name: r.customer_name,
}, binary }];
