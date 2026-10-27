// Alguien ocupó ese hueco un instante antes (o se pidió la hora que ya tiene): se vuelve a la lista de horas con aviso.
// El turno original NO se ha tocado: la base de datos solo mueve el turno si la hora nueva queda ocupada.
const r = $('Cambiar hora').last().json;
const notice = r.error === 'SAME_SLOT'
  ? '⚠️ Esa es la hora que ya tienes. Elige otra.'
  : '⚠️ Esa hora acaba de ocuparse. Elige otra; tu turno actual sigue reservado.';
return [{ json: { data: $('Preparar consulta').last().json.state.data, notice } }];
