// Alguien reservó ese hueco un instante antes: se vuelve a la lista de horas con aviso, conservando los datos.
return [{ json: {
  data: $('Preparar consulta').last().json.state.data,
  notice: '⚠️ Ese turno acaba de ocuparse. Elige otra hora.',
} }];
