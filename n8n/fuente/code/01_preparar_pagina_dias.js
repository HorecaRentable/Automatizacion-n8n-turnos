//@@LIB@@
// El día elegido está lleno: se ofrecen los próximos días con huecos.
const p = $input.first().json;
const opciones = p.nextDays.map((n) => ({
  day: n.day,
  label: `${fechaLarga(n.day)} · ${n.free_slots} ${n.free_slots === 1 ? 'hora libre' : 'horas libres'}`,
}));
return [{ json: {
  data: p.data,
  opciones,
  fields: [{ fieldLabel: 'Otro día', fieldType: 'dropdown', requiredField: true,
             fieldOptions: { values: opciones.map((o) => ({ option: o.label })) } }],
  description: `No quedan horas libres el ${p.dayLabel}. Estos son los próximos días con huecos:`,
} }];
