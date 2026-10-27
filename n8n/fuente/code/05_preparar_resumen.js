//@@LIB@@
// Resumen diario para quien atiende: turnos confirmados de HOY (día local), ordenados por hora.
// Sin turnos: aviso breve (a menos que settings.daily_summary_send_empty = false; entonces la base
// de datos ni siquiera marca "due+send" y este nodo no llega a ejecutarse).
const s = $input.first().json;                          // claim_daily_summary: { due:true, send:true, local_date, count, bookings:[...] }
const cfg = $('Cargar parámetros').first().json;
const conf = $('Configuración').first().json;

const fecha = fechaLarga(s.local_date);
const lista = s.bookings ?? [];
const asunto = lista.length
  ? `[Turnos] Agenda de hoy · ${dmy(s.local_date)} · ${lista.length} ${lista.length === 1 ? 'turno' : 'turnos'}`
  : `[Turnos] Agenda de hoy · ${dmy(s.local_date)} · sin turnos`;

let text, html;
if (!lista.length) {
  text = `Buenos días,\n\nHoy, ${fecha}, no hay ningún turno confirmado.`;
  html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937"><h2 style="margin:0 0 12px">Agenda de hoy</h2><p>Hoy, ${esc(fecha)}, no hay ningún turno confirmado.</p></div>`;
} else {
  text = [`Buenos días,`, '', `Turnos confirmados de hoy, ${fecha} (hora de ${s.timezone}):`, '',
    ...lista.map((b) => `${b.local_time}  ${b.service_name} · ${b.customer_name} · ${b.customer_phone} · ${b.customer_email}`)].join('\n');
  html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#1f2937">
<h2 style="margin:0 0 4px">Agenda de hoy</h2>
<p style="margin:0 0 12px;color:#6b7280">${esc(fecha)} · ${lista.length} ${lista.length === 1 ? 'turno confirmado' : 'turnos confirmados'} (hora de ${esc(s.timezone)})</p>
<table style="border-collapse:collapse;width:100%">
<tr style="text-align:left;color:#6b7280"><th style="padding:6px 10px 6px 0">Hora</th><th style="padding:6px 10px 6px 0">Servicio</th><th style="padding:6px 10px 6px 0">Nombre</th><th style="padding:6px 10px 6px 0">Teléfono</th><th style="padding:6px 0">Correo</th></tr>
${lista.map((b) => `<tr style="border-top:1px solid #e5e7eb"><td style="padding:6px 10px 6px 0"><b>${esc(b.local_time)}</b></td><td style="padding:6px 10px 6px 0">${esc(b.service_name)}</td><td style="padding:6px 10px 6px 0">${esc(b.customer_name)}</td><td style="padding:6px 10px 6px 0">${esc(b.customer_phone)}</td><td style="padding:6px 0">${esc(b.customer_email)}</td></tr>`).join('\n')}
</table></div>`;
}

return [{ json: { day: s.day, from: conf.from_email, to: destinoPersonal(cfg, conf), subject: asunto, text, html, count: lista.length } }];
