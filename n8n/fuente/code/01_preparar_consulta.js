// Punto único de entrada a "ver horas libres". Lo alimentan tres caminos:
//   · datos válidos de la página 1          · cambio de día (día completo)
//   · "Ese turno acaba de ocuparse" (vuelve a elegir hora SIN perder los datos)
// Todos traen { data, notice? }.
const j = $input.first().json;
return [{ json: {
  state: { data: j.data, notice: j.notice ?? null },
  p_service_id: j.data.service_id,
  p_day: j.data.day,
} }];
