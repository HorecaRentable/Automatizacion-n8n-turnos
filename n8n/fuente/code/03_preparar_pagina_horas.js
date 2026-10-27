//@@LIB@@
const st = $('Preparar consulta').last().json.state;
const av = $input.first().json;            // get_reschedule_availability: { ok, day, timezone, slots:[{starts_at,label}], next_days:[{day,free_slots}] }
const d = st.data;
const slots = av.slots ?? [];
const dayLabel = fechaLarga(av.day);

const fields = [{
  fieldLabel: 'Hora', fieldType: 'dropdown', requiredField: true,
  fieldOptions: { values: slots.map((s) => ({ option: s.label })) },
}];

return [{ json: {
  data: d,
  tz: av.timezone,
  dayLabel,
  slots,
  nextDays: av.next_days ?? [],
  hasSlots: slots.length > 0,
  hasNextDays: (av.next_days ?? []).length > 0,
  fields,
  description: (st.notice ? `${st.notice}\n\n` : '')
    + `${d.info.service_name} · ${dayLabel}. Horas libres (hora de ${av.timezone}).\n`
    + `Tu turno actual (${fechaLarga(d.info.local_date)} a las ${d.info.local_time}) sigue reservado hasta que confirmes.`,
} }];
