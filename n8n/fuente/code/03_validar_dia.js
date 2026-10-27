// Recoge el día elegido. Si la persona abandonó la página, al vencer la espera n8n continúa SIN datos del formulario: se termina aquí.
const s = $input.first().json;
if (s['Nuevo día'] === undefined) return [];
const prep = $('Preparar página de día').last().json;
const day = String(s['Nuevo día']).trim();
const ok = /^\d{4}-\d{2}-\d{2}$/.test(day);
return [{ json: { data: { ...prep.data, day: ok ? day : prep.data.info.local_date }, notice: ok ? null : '⚠️ Elige un día válido.' } }];
