//@@LIB@@
// Convierte los turnos RECLAMADOS por claim_due_reminders() en un correo cada uno.
// Si no hay ninguno devuelve [] y el workflow termina (lo normal en casi todas las pasadas).
// Los turnos que llegan aquí ya están marcados como reclamados en la base de datos: ninguna otra
// ejecución (solapada o posterior) los enviará. Si el envío falla, "Registrar fallo" libera el reclamo.
const lista = $input.first().json.reminders ?? [];
const cfg = $('Cargar parámetros').first().json;       // get_config()
const conf = $('Configuración').first().json;

return lista.map((r) => {
  const fecha = fechaLarga(r.local_date);
  const cancelar = enlaceCon(cfg.cancel_form_url, r.management_code);
  const cambiar = enlaceCon(cfg.reschedule_form_url, r.management_code);
  const es24 = r.kind === '24h';

  const asunto = es24
    ? `Recordatorio: tu turno de ${r.service_name} es el ${dmy(r.local_date)} a las ${r.local_time}`
    : `Tu turno de ${r.service_name} es en 1 hora (${r.local_time})`;
  const intro = es24
    ? 'Te recordamos que tienes un turno dentro de 24 horas:'
    : 'Te recordamos que tu turno empieza dentro de 1 hora:';

  const text = [
    `Hola ${r.customer_name},`, '',
    intro,
    `  ${r.service_name}`,
    `  ${fecha} a las ${r.local_time} (hora de ${r.timezone})`, '',
    ...(es24 && cancelar ? [`¿No puedes venir? Cancélalo aquí:`, cancelar, ''] : []),
    ...(es24 && cambiar ? [`¿Prefieres otra hora? Cámbiala aquí:`, cambiar, ''] : []),
    '¡Te esperamos!',
  ].join('\n');

  const enlaces = es24 && (cancelar || cambiar)
    ? `<p>${cancelar ? `¿No puedes venir? <a href="${esc(cancelar)}">Cancela tu turno aquí</a>.` : ''} ${cambiar ? `¿Prefieres otra hora? <a href="${esc(cambiar)}">Cámbiala aquí</a>.` : ''}</p>`
    : '';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937">
<h2 style="margin:0 0 12px">${es24 ? 'Recordatorio de tu turno ⏰' : 'Tu turno es en 1 hora ⏰'}</h2>
<p>Hola ${esc(r.customer_name)},</p>
<p>${esc(intro)}</p>
<p><b>${esc(r.service_name)}</b><br>${esc(fecha)} a las <b>${esc(r.local_time)}</b> (hora de ${esc(r.timezone)})</p>
${enlaces}<p>¡Te esperamos!</p></div>`;

  return { json: {
    booking_id: r.booking_id, kind: r.kind, claimed_at: r.claimed_at, attempt: r.attempt,
    from: conf.from_email, to: r.customer_email, subject: asunto, text, html,
  } };
});
