// ---- utilidades compartidas (se copian dentro de los nodos Code que las usan) ----
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Fecha larga en español a partir de 'YYYY-MM-DD' (ya es la fecha LOCAL: la calcula la base de datos).
const fechaLarga = (ymd) => new Intl.DateTimeFormat('es-ES', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
}).format(new Date(ymd + 'T12:00:00Z'));

// --- .ics (RFC 5545): horas en UTC, así el cambio de hora no afecta ---
const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsFold = (line) => {                       // líneas de máx. 75 octetos
  let out = '', cur = '', bytes = 0, first = true;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (first ? 75 : 74)) { out += cur + '\r\n '; cur = ''; bytes = 0; first = false; }
    cur += ch; bytes += b;
  }
  return out + cur;
};
const icsTime = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');   // 2026-11-09T09:00:00Z -> 20261109T090000Z
// sequence: versión del evento (la lleva la base de datos: 0 reserva, +1 por cada cambio o cancelación).
// Sin indicarla se usa la de la Fase 1: 0 (confirmado) / 1 (cancelado).
function buildIcs({ uid, start, end, summary, description, url, cancelled, sequence }) {
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Turnos//n8n//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@turnos`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsEsc(summary)}`,
    `DESCRIPTION:${icsEsc(description)}`,
    url ? `URL:${url}` : null,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${sequence ?? (cancelled ? 1 : 0)}`,
    ...(cancelled ? [] : ['BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Recordatorio de turno', 'END:VALARM']),
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// --- enlaces de gestión: <url del formulario>?codigo=<código secreto> ---
const enlaceCon = (base, code) => {
  const b = String(base ?? '');
  return b ? b + (b.includes('?') ? '&' : '?') + 'codigo=' + code : '';
};
const dmy = (ymd) => String(ymd).split('-').reverse().join('/');          // 2026-11-09 -> 09/11/2026

// --- avisos a quien atiende (inmediatos y resumen): misma plantilla sencilla ---
// filas: [[etiqueta, valor], ...]  ->  { text, html }
function plantillaAviso(titulo, filas) {
  const text = [titulo, '', ...filas.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
<h2 style="margin:0 0 12px">${esc(titulo)}</h2>
<table style="border-collapse:collapse">${filas.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table></div>`;
  return { text, html };
}
// Destinatario del aviso: staff_email (o, si está vacío, admin_email: lo resuelve get_config); nunca queda sin destino.
const destinoPersonal = (cfg, conf) => cfg.staff_email || cfg.admin_email || conf.from_email;
