// Prepara la vuelta a la página 1 conservando lo escrito.
// Llega desde "¿Datos válidos?" (error en texto) o desde la reserva (INVALID_INPUT de la base de datos).
const j = $input.first().json;
if (j.abandoned) return [];   // formulario abandonado (venció la espera): no hay nada que reintentar
let prefill = j.prefill;
let error = j.error;

if (j.error === 'INVALID_INPUT' || !prefill) {
  prefill = $('Validar datos').last().json.prefill;
  const campo = { name: 'tu nombre', email: 'tu correo electrónico', phone: 'tu teléfono' }[j.field] ?? 'los datos';
  error = `Revisa ${campo}.`;
}
return [{ json: { error, prefill } }];
