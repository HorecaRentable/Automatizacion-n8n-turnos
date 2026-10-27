// Aviso al administrador cuando falla cualquier workflow de turnos.
// No incluye datos personales de clientes: solo qué falló y dónde mirar.
const e = $('Error Trigger').first().json;
const conf = $('Configuración').first().json;
let admin = null;
try { admin = $('Cargar parámetros').first().json.admin_email; } catch (err) { /* Supabase caído */ }
admin = admin || conf.admin_email_respaldo;

const ex = e.execution ?? {};
const wf = e.workflow ?? {};
const msg = ex.error?.message ?? 'sin mensaje';
const lines = [
  `El workflow "${wf.name}" ha fallado.`, '',
  `Nodo: ${ex.lastNodeExecuted ?? '(desconocido)'}`,
  `Error: ${msg}`,
  `Ejecución: ${ex.id ?? '?'}${ex.url ? '  ' + ex.url : ''}`, '',
  'Qué hacer: abre la ejecución en n8n (pestaña Executions) para ver el detalle.',
  'Las reservas ya confirmadas en la base de datos NO se pierden por este error.',
];
const html = '<div style="font-family:Arial,sans-serif"><h3>⚠️ Fallo en el sistema de turnos</h3>'
  + lines.map((l) => `<div>${String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;'}</div>`).join('') + '</div>';

return [{ json: {
  from: conf.from_email, to: admin,
  subject: `[Turnos] Error en "${wf.name}"`,
  text: lines.join('\n'), html,
} }];
