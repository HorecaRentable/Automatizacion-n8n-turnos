//@@LIB@@
const r = $input.first().json;                       // respuesta de book_slot (ok: true)
const cfg = $('Cargar parámetros').first().json;     // get_config()
const conf = $('Configuración').first().json;

const enlace = enlaceCon(cfg.cancel_form_url, r.management_code);
const enlaceCambio = enlaceCon(cfg.reschedule_form_url, r.management_code);   // Fase 2: cambiar la hora
const fecha = fechaLarga(r.local_date);
const servicio = r.service_name;

const ics = buildIcs({
  uid: r.booking_id,
  start: r.starts_at,
  end: r.ends_at,
  summary: servicio,
  description: `Turno reservado a nombre de ${r.customer_name}.\nPara cancelarlo: ${enlace}` + (enlaceCambio ? `\nPara cambiar la hora: ${enlaceCambio}` : ''),
  url: enlace,
  cancelled: false,
});
const binary = { ics: await this.helpers.prepareBinaryData(Buffer.from(ics, 'utf8'), 'turno.ics', 'text/calendar') };

const text = [
  `Hola ${r.customer_name},`, '',
  `Tu turno está confirmado:`,
  `  ${servicio}`,
  `  ${fecha} a las ${r.local_time} (hora de ${r.timezone})`, '',
  `Adjuntamos un archivo .ics para añadirlo a tu calendario.`, '',
  `¿No puedes venir? Cancélalo aquí (con la antelación indicada):`,
  enlace, '',
  ...(enlaceCambio ? [`¿Prefieres otra hora? Cámbiala aquí:`, enlaceCambio, ''] : []),
  `Guarda este enlace: contiene tu código secreto de gestión.`,
].join('\n');

const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
<h2 style="margin:0 0 12px">Turno confirmado ✅</h2>
<p>Hola ${esc(r.customer_name)},</p>
<p>Tu turno está confirmado:</p>
<table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:6px 12px 6px 0;color:#6b7280">Servicio</td><td><b>${esc(servicio)}</b></td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#6b7280">Día</td><td><b>${esc(fecha)}</b></td></tr>
<tr><td style="padding:6px 12px 6px 0;color:#6b7280">Hora</td><td><b>${esc(r.local_time)}</b> (hora de ${esc(r.timezone)})</td></tr></table>
<p>Adjuntamos un archivo <b>.ics</b> para añadirlo a tu calendario.</p>
<p>¿No puedes venir? <a href="${esc(enlace)}">Cancela tu turno aquí</a>.${enlaceCambio ? ` ¿Prefieres otra hora? <a href="${esc(enlaceCambio)}">Cámbiala aquí</a>.` : ''}</p>
<p style="color:#6b7280;font-size:13px">Guarda este correo: el enlace contiene tu código secreto de gestión.</p></div>`;

return [{ json: {
  booking_id: r.booking_id,
  from: conf.from_email,
  to: r.customer_email,
  subject: `Turno confirmado: ${servicio} · ${r.local_date.split('-').reverse().join('/')} ${r.local_time}`,
  text, html, enlace, fecha,
  local_time: r.local_time, service_name: servicio, customer_name: r.customer_name,
}, binary }];
