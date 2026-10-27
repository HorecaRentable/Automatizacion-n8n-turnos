// Convierte la hora elegida en el desplegable ("09:30") en el instante exacto (UTC) que ofreció la base de datos.
if ($input.first().json['Hora'] === undefined) return [];   // formulario abandonado (venció la espera): fin
const p = $('Preparar página de horas').last().json;
const elegida = String($input.first().json['Hora'] ?? '');
const slot = p.slots.find((s) => s.label === elegida);
const d = p.data;

// Fase 3: el origen (slug del enlace corto) llega en el campo oculto «origen» del formulario (se rellena con ?origen=...).
// Se copia tal cual solo si tiene forma de slug; si no, se descarta: una reserva nunca debe fallar por un origen raro
// (la base de datos lo vuelve a normalizar). Fallback: el parámetro de la URL.
let origen = null;
try {
  const t = $('Formulario de reserva').first().json;
  const bruto = String(t.origen ?? t.formQueryParameters?.origen ?? '').trim().toLowerCase();
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bruto) && bruto.length <= 40) origen = bruto;
} catch (e) { /* sin origen */ }

return [{ json: { body: {
  p_service_id: d.service_id,
  p_starts_at: slot ? slot.starts_at : null,     // null -> la función responde SLOT_TAKEN
  p_name: d.name,
  p_email: d.email,
  p_phone: d.phone,
  p_consent: true,                                // solo se llega aquí si aceptó la privacidad
  p_source: origen,
} } }];
