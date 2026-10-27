// Punto único de entrada a "ver horas libres". Lo alimentan tres caminos:
//   · el día elegido en la primera página     · cambio de día (día completo)
//   · "Esa hora acaba de ocuparse" (vuelve a elegir hora SIN perder el código)
// Todos traen { data: { code, info, day }, notice? }.
const j = $input.first().json;
return [{ json: {
  state: { data: j.data, notice: j.notice ?? null },
  p_code: j.data.code,
  p_day: j.data.day,
} }];
