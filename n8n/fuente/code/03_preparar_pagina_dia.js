//@@LIB@@
// Código válido y turno cambiable: se pide el día al que se quiere pasar.
const info = $('Consultar turno').last().json;                         // get_reschedule_info (ok: true)
const code = String($('Formulario de cambio de hora').first().json.codigo ?? '').trim().toLowerCase();

return [{ json: {
  data: { code, info },
  fields: [{ fieldLabel: 'Nuevo día', fieldType: 'date', requiredField: true, defaultValue: info.local_date }],
  description: `${info.service_name} · Ahora tienes turno el ${fechaLarga(info.local_date)} a las ${info.local_time} (hora de ${info.timezone}).\n`
    + 'Elige el día al que quieres cambiarlo; en el siguiente paso verás las horas libres. Tu turno actual no se libera hasta que confirmes la hora nueva.',
} }];
