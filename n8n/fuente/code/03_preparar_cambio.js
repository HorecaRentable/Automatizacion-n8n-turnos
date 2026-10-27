// Convierte la hora elegida en el desplegable ("11:00") en el instante exacto (UTC) que ofreció la base de datos.
if ($input.first().json['Hora'] === undefined) return [];   // formulario abandonado (venció la espera): fin
const p = $('Preparar página de horas').last().json;
const elegida = String($input.first().json['Hora'] ?? '');
const slot = p.slots.find((s) => s.label === elegida);

return [{ json: { body: {
  p_code: p.data.code,
  p_starts_at: slot ? slot.starts_at : null,     // null -> la función responde SLOT_TAKEN
} } }];
