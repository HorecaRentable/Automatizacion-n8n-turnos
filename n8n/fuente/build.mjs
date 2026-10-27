// ============================================================
// Genera los workflows de n8n (JSON) a partir de este archivo y de ./code/*.js
//
//   node n8n/fuente/build.mjs                       -> n8n/workflows/*.json  (valores de ejemplo)
//   node n8n/fuente/build.mjs --out DIR --supabase-url http://... --from a@b.c --admin x@y.z [--wait-minutes 0.5]
//
// Workflows: 01 reservar · 02 cancelar · 03 cambiar hora (Fase 2) · 04 recordatorios (Fase 2)
//            05 resumen diario (Fase 2) · 06 enlaces cortos: redirección (Fase 3) · 07 crear enlace corto (Fase 3)
//            99 aviso de errores.
//
// No hace falta ejecutarlo para usar el sistema: los JSON ya generados están en n8n/workflows/.
// Sirve para mantener el código de los nodos Code en archivos .js normales (con coloreado, revisión...).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('--out', path.join(import.meta.dirname, '..', 'workflows')));
const SUPABASE_URL = opt('--supabase-url', 'https://TU-PROYECTO.supabase.co');
const FROM = opt('--from', 'turnos@tu-dominio.com');
// Fase 3 · adonde redirige el workflow 06 SOLO si Supabase no responde (el resto del tiempo manda settings.link_default_url)
const FALLBACK_URL = opt('--fallback-url', 'https://rocketnova.io');
const ADMIN = opt('--admin', 'alexandra@rocketnova.io');
// Cuánto espera cada página del formulario a que la persona la envíe antes de darla por abandonada
// (si no, la ejecución queda "en espera" para siempre con los datos escritos, y n8n no la poda nunca).
const WAIT_TEST = opt('--wait-minutes', null);              // solo para pruebas (p. ej. 0.5)
const WAIT_PAGE = Number(WAIT_TEST ?? 60);                  // minutos en páginas con campos
const WAIT_END = Number(WAIT_TEST ?? 5);                    // minutos en la página final
// Solo para pruebas de extremo a extremo (Fase 2):
//   --cron "* * * * *"   los workflows 04 y 05 se disparan cada minuto en vez de cada 15
//   --twins              genera además 04b y 05b, copias exactas con otro id: al dispararse a la vez, compiten por lo mismo
//   --save-success       guarda también las ejecuciones correctas de 04 y 05 (para contarlas)
const CRON = opt('--cron', '*/15 * * * *');
const TWINS = args.includes('--twins');
const SAVE_SUCCESS = args.includes('--save-success');

const CODE = (f) => fs.readFileSync(path.join(import.meta.dirname, 'code', f), 'utf8');
const LIB = CODE('lib_correo.js');
const code = (f) => CODE(f).replace('//@@LIB@@', LIB);

const CRED_SUPABASE = { supabaseApi: { id: 'supabaseTurnos1', name: 'Supabase turnos (service role)' } };
const CRED_SMTP = { smtp: { id: 'smtpTurnos1', name: 'SMTP turnos' } };
const CRED_BASIC = { httpBasicAuth: { id: 'formularioEquipo1', name: 'Formulario del equipo (usuario y contraseña)' } };
const ERROR_WF_ID = 'turnosErrores1';

// ---------- fábricas de nodos ----------
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
const node = (name, type, typeVersion, position, parameters, extra = {}) =>
  ({ parameters, id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, type, typeVersion, position, ...extra });

const configNode = (position, withAdmin = false, withFallbackUrl = false) => node('Configuración', 'n8n-nodes-base.set', 3.4, position, {
  assignments: { assignments: [
    { id: 'a1', name: 'supabase_url', value: SUPABASE_URL, type: 'string' },
    { id: 'a2', name: 'from_email', value: FROM, type: 'string' },
    ...(withAdmin ? [{ id: 'a3', name: 'admin_email_respaldo', value: ADMIN, type: 'string' }] : []),
    ...(withFallbackUrl ? [{ id: 'a4', name: 'url_respaldo', value: FALLBACK_URL, type: 'string' }] : []),
  ] },
  options: {},
}, { notes: 'Único sitio (por workflow) con la URL de Supabase y el remitente. La clave service_role NO va aquí: está en la credencial "Supabase turnos (service role)".', notesInFlow: true });

const http = (name, rpc, jsonBody, position, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, position, {
  method: 'POST',
  url: `={{ $('Configuración').first().json.supabase_url }}/rest/v1/rpc/${rpc}`,
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'supabaseApi',
  sendBody: true,
  specifyBody: 'json',
  jsonBody,
  options: {},
}, { credentials: CRED_SUPABASE, ...extra });

const codeNode = (name, file, position, extra = {}) => node(name, 'n8n-nodes-base.code', 2, position, { jsCode: code(file) }, extra);

const cond = (left, op = { type: 'boolean', operation: 'true', singleValue: true }, right = '') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: 'c1', leftValue: left, rightValue: right, operator: op }],
  combinator: 'and',
});
const ifNode = (name, left, position) => node(name, 'n8n-nodes-base.if', 2.2, position, { conditions: cond(left), options: {} });

const switchNode = (name, valueExpr, outputs, position) => node(name, 'n8n-nodes-base.switch', 3.2, position, {
  rules: { values: outputs.map(([key, val]) => ({
    conditions: cond(valueExpr, { type: 'string', operation: 'equals' }, val),
    renameOutput: true, outputKey: key,
  })) },
  options: { fallbackOutput: 'extra' },
});

const waitLimit = (minutes) => ({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: minutes, resumeUnit: 'minutes' });

const formPage = (name, fieldsExpr, titleExpr, descExpr, button, position) => node(name, 'n8n-nodes-base.form', 2.5, position, {
  operation: 'page',
  defineForm: 'json',
  jsonOutput: fieldsExpr,
  ...waitLimit(WAIT_PAGE),
  options: { formTitle: titleExpr, formDescription: descExpr, buttonLabel: button },
}, { webhookId: uuid() });

const formEnd = (name, title, message, position) => node(name, 'n8n-nodes-base.form', 2.5, position, {
  operation: 'completion',
  respondWith: 'text',
  completionTitle: title,
  completionMessage: message,
  ...waitLimit(WAIT_END),
  options: {},
}, { webhookId: uuid() });

const email = (name, position, extra = {}, withIcs = true) => node(name, 'n8n-nodes-base.emailSend', 2.1, position, {
  fromEmail: '={{ $json.from }}',
  toEmail: '={{ $json.to }}',
  subject: '={{ $json.subject }}',
  emailFormat: 'both',
  text: '={{ $json.text }}',
  html: '={{ $json.html }}',
  options: { appendAttribution: false, ...(withIcs ? { fileAttachments: 'ics' } : {}) },
}, { credentials: CRED_SMTP, ...extra });

const logEmail = (name, kind, status, errorExpr, position) => http(name, 'log_email',
  `={{ JSON.stringify({ p_booking_id: $('${kind.node}').last().json.booking_id, p_kind: '${kind.kind}', p_to: $('${kind.node}').last().json.to, p_status: '${status}', p_error: ${errorExpr} }) }}`,
  position, { onError: 'continueRegularOutput' });

// Fase 2 · aviso inmediato a quien atiende. Cuatro nodos EN SERIE tras el correo a la persona:
// generar -> enviar (un fallo aquí NO rompe nada: se anota en email_log) -> registrar enviado / fallo -> `destino`.
function avisoPersonal({ file, kind, x, y, destino }) {
  const gen = 'Generar aviso al personal';
  return {
    nodes: [
      codeNode(gen, file, [x, y]),
      email('Enviar aviso al personal', [x + 220, y], { onError: 'continueErrorOutput' }, false),
      logEmail('Registrar aviso enviado', { node: gen, kind }, 'sent', 'null', [x + 440, y - 100]),
      logEmail('Registrar fallo del aviso', { node: gen, kind }, 'failed', "String($json.error?.message ?? $json.error ?? 'error desconocido')", [x + 440, y + 100]),
    ],
    conns: [
      [gen, 'Enviar aviso al personal'],
      ['Enviar aviso al personal', 'Registrar aviso enviado', 0],
      ['Enviar aviso al personal', 'Registrar fallo del aviso', 1],
      ['Registrar aviso enviado', destino],
      ['Registrar fallo del aviso', destino],
    ],
  };
}

// ---------- conexiones ----------
function connections(list) {
  const c = {};
  for (const [from, to, out = 0] of list) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return c;
}
const settings = () => ({
  executionOrder: 'v1',
  errorWorkflow: ERROR_WF_ID,
  timezone: 'Europe/Madrid',
  // Valores por defecto de n8n, explícitos. Las ejecuciones guardan nombre/correo/teléfono: limita su
  // retención en n8n con EXECUTIONS_DATA_PRUNE=true y EXECUTIONS_DATA_MAX_AGE=48 (horas). Ver docs/INSTALACION.md.
  saveDataSuccessExecution: 'all',
  saveDataErrorExecution: 'all',
  saveManualExecutions: false,
});
const workflow = (id, name, nodes, conns, withErrorWf = true) => {
  const s = settings();
  if (!withErrorWf) delete s.errorWorkflow;
  return { id, name, active: false, nodes, connections: connections(conns), settings: s, pinData: {}, meta: { templateCredsSetupCompleted: false } };
};

// ============================================================
// 01 · RESERVAR
// ============================================================
const J = (o) => `={{ JSON.stringify(${o}) }}`;
const W1 = 'Turnos · 01 Reservar';

const av01 = avisoPersonal({ file: '01_aviso_personal.js', kind: 'staff_booking', x: 4400, y: 0, destino: 'Mensaje final' });
const wf01 = workflow('turnosReservar1', W1, [
  node('Formulario de reserva', 'n8n-nodes-base.formTrigger', 2.5, [0, 300], {
    formTitle: 'Reserva tu turno',
    formDescription: 'Reserva, en un minuto y sin crear cuenta, tu turno. Después podrás cancelarlo desde el enlace del correo de confirmación.',
    // Fase 3: campo OCULTO «origen»: se rellena con ?origen=<slug> (lo añade el enlace corto) y la reserva lo guarda en bookings.source
    formFields: { values: [{ fieldType: 'html', elementName: 'bienvenida',
      html: '<p>Pulsa <b>Reservar un turno</b> para elegir servicio, día y hora. Te enviaremos la confirmación por correo, con un archivo para tu calendario.</p>' },
      { fieldType: 'hiddenField', fieldName: 'origen', fieldValue: '' }] },
    responseMode: 'onReceived',
    options: { path: 'reservar-turno', buttonLabel: 'Reservar un turno', appendAttribution: false },
  }, { webhookId: uuid() }),
  configNode([220, 300]),
  http('Cargar parámetros', 'get_config', '{}', [440, 300]),
  http('Cargar servicios', 'list_active_services', '{}', [660, 300]),
  codeNode('Preparar página 1', '01_preparar_pagina1.js', [880, 300]),
  formPage('Página 1 · Datos', "={{ $('Preparar página 1').last().json.fields }}", 'Tus datos',
    "={{ $('Preparar página 1').last().json.description }}", 'Ver horas libres', [1100, 300]),
  codeNode('Validar datos', '01_validar_datos.js', [1320, 300]),
  ifNode('¿Datos válidos?', '={{ $json.ok }}', [1540, 300]),
  codeNode('Reintento datos', '01_reintento_datos.js', [1540, 560]),

  codeNode('Preparar consulta', '01_preparar_consulta.js', [1760, 300]),
  http('Consultar disponibilidad', 'get_availability', J('{ p_service_id: $json.p_service_id, p_day: $json.p_day }'), [1980, 300]),
  codeNode('Preparar página de horas', '01_preparar_pagina_horas.js', [2200, 300]),
  ifNode('¿Hay horas libres?', '={{ $json.hasSlots }}', [2420, 300]),
  formPage('Página 2 · Hora', "={{ $('Preparar página de horas').last().json.fields }}", 'Elige tu hora',
    "={{ $('Preparar página de horas').last().json.description }}", 'Reservar turno', [2640, 200]),
  codeNode('Preparar reserva', '01_preparar_reserva.js', [2860, 200]),
  http('Reservar turno', 'book_slot', '={{ JSON.stringify($json.body) }}', [3080, 200]),
  switchNode('Resultado de la reserva', "={{ $json.ok ? 'OK' : $json.error }}", [
    ['Reservado', 'OK'], ['Hueco ocupado', 'SLOT_TAKEN'], ['Ya tiene turno', 'ALREADY_HAS_BOOKING'], ['Datos inválidos', 'INVALID_INPUT'],
  ], [3300, 200]),

  codeNode('Turno ocupado', '01_turno_ocupado.js', [3520, 460]),

  ifNode('¿Hay otros días?', '={{ $json.hasNextDays }}', [2640, 480]),
  codeNode('Preparar página de días', '01_preparar_pagina_dias.js', [2860, 480]),
  formPage('Página · Día completo', "={{ $('Preparar página de días').last().json.fields }}", 'Ese día está completo',
    "={{ $('Preparar página de días').last().json.description }}", 'Ver horas libres', [3080, 480]),
  codeNode('Elegir otro día', '01_elegir_otro_dia.js', [3300, 480]),
  formEnd('Fin · Sin disponibilidad', 'No hay turnos disponibles',
    'Ahora mismo no quedan horas libres en los próximos días para este servicio. Vuelve a intentarlo más adelante.', [2860, 700]),

  codeNode('Generar correo', '01_generar_correo.js', [3520, 0]),
  email('Enviar correo de confirmación', [3740, 0], { onError: 'continueErrorOutput' }),
  logEmail('Registrar correo enviado', { node: 'Generar correo', kind: 'confirmation' }, 'sent', 'null', [3960, -100]),
  logEmail('Registrar fallo del correo', { node: 'Generar correo', kind: 'confirmation' }, 'failed', "String($json.error?.message ?? $json.error ?? 'error desconocido')", [3960, 120]),
  node('Avisar al administrador', 'n8n-nodes-base.emailSend', 2.1, [4180, 120], {
    fromEmail: "={{ $('Configuración').first().json.from_email }}",
    toEmail: "={{ $('Cargar parámetros').first().json.admin_email }}",
    subject: "=[Turnos] No se pudo enviar el correo de confirmación",
    emailFormat: 'text',
    text: "=Se guardó la reserva {{ $('Generar correo').last().json.booking_id }} pero el correo de confirmación falló. Revisa la tabla email_log en Supabase (status = failed).",
    options: { appendAttribution: false },
  }, { credentials: CRED_SMTP, onError: 'continueRegularOutput' }),
  ...av01.nodes,
  codeNode('Mensaje final', '01_mensaje_final.js', [5300, 0]),
  formEnd('Turno reservado', 'Turno reservado', "={{ $json.mensaje }}", [5520, 0]),

  formEnd('Fin · Ya tienes turno', 'Ya tienes un turno reservado',
    'Con este correo ya tienes un turno pendiente para este servicio. Si necesitas otro horario, cancela el actual con el enlace del correo de confirmación y vuelve a reservar.', [3520, 640]),
  formEnd('Fin · Error', 'No hemos podido reservar',
    'Ha ocurrido un problema inesperado. Inténtalo de nuevo en unos minutos.', [3520, 800]),
], [
  ['Formulario de reserva', 'Configuración'],
  ['Configuración', 'Cargar parámetros'],
  ['Cargar parámetros', 'Cargar servicios'],
  ['Cargar servicios', 'Preparar página 1'],
  ['Preparar página 1', 'Página 1 · Datos'],
  ['Página 1 · Datos', 'Validar datos'],
  ['Validar datos', '¿Datos válidos?'],
  ['¿Datos válidos?', 'Preparar consulta', 0],
  ['¿Datos válidos?', 'Reintento datos', 1],
  ['Reintento datos', 'Cargar servicios'],

  ['Preparar consulta', 'Consultar disponibilidad'],
  ['Consultar disponibilidad', 'Preparar página de horas'],
  ['Preparar página de horas', '¿Hay horas libres?'],
  ['¿Hay horas libres?', 'Página 2 · Hora', 0],
  ['¿Hay horas libres?', '¿Hay otros días?', 1],
  ['¿Hay otros días?', 'Preparar página de días', 0],
  ['¿Hay otros días?', 'Fin · Sin disponibilidad', 1],
  ['Preparar página de días', 'Página · Día completo'],
  ['Página · Día completo', 'Elegir otro día'],
  ['Elegir otro día', 'Preparar consulta'],

  ['Página 2 · Hora', 'Preparar reserva'],
  ['Preparar reserva', 'Reservar turno'],
  ['Reservar turno', 'Resultado de la reserva'],
  ['Resultado de la reserva', 'Generar correo', 0],
  ['Resultado de la reserva', 'Turno ocupado', 1],
  ['Resultado de la reserva', 'Fin · Ya tienes turno', 2],
  ['Resultado de la reserva', 'Reintento datos', 3],
  ['Resultado de la reserva', 'Fin · Error', 4],
  ['Turno ocupado', 'Preparar consulta'],

  ['Generar correo', 'Enviar correo de confirmación'],
  ['Enviar correo de confirmación', 'Registrar correo enviado', 0],
  ['Enviar correo de confirmación', 'Registrar fallo del correo', 1],
  ['Registrar correo enviado', 'Generar aviso al personal'],
  ['Registrar fallo del correo', 'Avisar al administrador'],
  ['Avisar al administrador', 'Generar aviso al personal'],
  ...av01.conns,
  ['Mensaje final', 'Turno reservado'],
]);

// ============================================================
// 02 · CANCELAR
// ============================================================
const av02 = avisoPersonal({ file: '02_aviso_personal.js', kind: 'staff_cancellation', x: 1540, y: 100, destino: 'Mensaje final' });
const wf02 = workflow('turnosCancelar1', 'Turnos · 02 Cancelar', [
  node('Formulario de cancelación', 'n8n-nodes-base.formTrigger', 2.5, [0, 300], {
    formTitle: 'Cancelar turno',
    formDescription: 'Introduce el código de gestión que recibiste en el correo de confirmación. Si has llegado desde el enlace del correo, ya aparece rellenado.',
    formFields: { values: [{ fieldLabel: 'Código de gestión', fieldName: 'codigo', fieldType: 'text', requiredField: true, placeholder: 'Pega aquí tu código' }] },
    responseMode: 'onReceived',
    options: { path: 'cancelar-turno', buttonLabel: 'Cancelar mi turno', appendAttribution: false },
  }, { webhookId: uuid() }),
  configNode([220, 300]),
  http('Cargar parámetros', 'get_config', '{}', [330, 460]),
  http('Cancelar turno', 'cancel_booking', J('{ p_code: $(\'Formulario de cancelación\').first().json.codigo }'), [440, 300]),
  switchNode('Resultado de la cancelación', "={{ $json.ok ? 'OK' : $json.error }}", [
    ['Cancelado', 'OK'], ['Código inválido', 'INVALID_CODE'], ['No cancelable', 'NOT_CANCELLABLE'], ['Fuera de plazo', 'TOO_LATE'],
  ], [660, 300]),
  codeNode('Generar correo de cancelación', '02_generar_correo.js', [880, 100]),
  email('Enviar correo de cancelación', [1100, 100], { onError: 'continueErrorOutput' }),
  logEmail('Registrar correo enviado', { node: 'Generar correo de cancelación', kind: 'cancellation' }, 'sent', 'null', [1320, 0]),
  logEmail('Registrar fallo del correo', { node: 'Generar correo de cancelación', kind: 'cancellation' }, 'failed', "String($json.error?.message ?? $json.error ?? 'error desconocido')", [1320, 200]),
  ...av02.nodes,
  codeNode('Mensaje final', '02_mensaje_final.js', [2420, 100]),
  formEnd('Turno cancelado', 'Turno cancelado', '={{ $json.mensaje }}', [2640, 100]),

  formEnd('Fin · Código inválido', 'Código no válido',
    'No hemos encontrado ningún turno con ese código. Comprueba que lo has copiado completo del correo de confirmación.', [880, 360]),
  formEnd('Fin · No cancelable', 'Este turno ya no se puede cancelar',
    'El turno ya estaba cancelado o ya ha pasado.', [880, 520]),
  formEnd('Fin · Fuera de plazo', 'Fuera de plazo',
    "=Solo se puede cancelar con al menos {{ $('Cancelar turno').last().json.hours }} horas de antelación. Ponte en contacto con nosotros si no puedes asistir.", [880, 680]),
  formEnd('Fin · Error', 'No hemos podido cancelar', 'Ha ocurrido un problema inesperado. Inténtalo de nuevo en unos minutos.', [880, 840]),
], [
  ['Formulario de cancelación', 'Configuración'],
  ['Configuración', 'Cargar parámetros'],
  ['Cargar parámetros', 'Cancelar turno'],
  ['Cancelar turno', 'Resultado de la cancelación'],
  ['Resultado de la cancelación', 'Generar correo de cancelación', 0],
  ['Resultado de la cancelación', 'Fin · Código inválido', 1],
  ['Resultado de la cancelación', 'Fin · No cancelable', 2],
  ['Resultado de la cancelación', 'Fin · Fuera de plazo', 3],
  ['Resultado de la cancelación', 'Fin · Error', 4],
  ['Generar correo de cancelación', 'Enviar correo de cancelación'],
  ['Enviar correo de cancelación', 'Registrar correo enviado', 0],
  ['Enviar correo de cancelación', 'Registrar fallo del correo', 1],
  ['Registrar correo enviado', 'Generar aviso al personal'],
  ['Registrar fallo del correo', 'Generar aviso al personal'],
  ...av02.conns,
  ['Mensaje final', 'Turno cancelado'],
]);

// ============================================================
// 99 · ERRORES (avisa al administrador)
// ============================================================
const wf99 = workflow(ERROR_WF_ID, 'Turnos · 99 Aviso de errores', [
  node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 300], {}),
  configNode([220, 300], true),
  http('Cargar parámetros', 'get_config', '{}', [440, 300], { onError: 'continueRegularOutput' }),
  codeNode('Preparar aviso', '99_preparar_aviso.js', [660, 300]),
  email('Avisar al administrador', [880, 300], {}, false),
], [
  ['Error Trigger', 'Configuración'],
  ['Configuración', 'Cargar parámetros'],
  ['Cargar parámetros', 'Preparar aviso'],
  ['Preparar aviso', 'Avisar al administrador'],
], false);
wf99.settings.errorWorkflow = undefined;

// ============================================================
// 03 · CAMBIAR HORA (Fase 2)
//   código -> comprobar turno y plazo -> día -> horas libres (la MISMA disponibilidad que la reserva)
//   -> hora -> reschedule_booking (UN UPDATE atómico) -> correo con .ics actualizado + aviso al personal
// ============================================================
const av03 = avisoPersonal({ file: '03_aviso_personal.js', kind: 'staff_reschedule', x: 5400, y: 0, destino: 'Mensaje final' });
const wf03 = workflow('turnosCambiar1', 'Turnos · 03 Cambiar hora', [
  node('Formulario de cambio de hora', 'n8n-nodes-base.formTrigger', 2.5, [0, 300], {
    formTitle: 'Cambiar la hora de tu turno',
    formDescription: 'Introduce el código de gestión que recibiste en el correo de confirmación. Si has llegado desde el enlace del correo, ya aparece rellenado. Tu turno actual no se libera hasta que confirmes la hora nueva.',
    formFields: { values: [{ fieldLabel: 'Código de gestión', fieldName: 'codigo', fieldType: 'text', requiredField: true, placeholder: 'Pega aquí tu código' }] },
    responseMode: 'onReceived',
    options: { path: 'cambiar-turno', buttonLabel: 'Continuar', appendAttribution: false },
  }, { webhookId: uuid() }),
  configNode([220, 300]),
  http('Cargar parámetros', 'get_config', '{}', [440, 300]),
  http('Consultar turno', 'get_reschedule_info', J("{ p_code: $('Formulario de cambio de hora').first().json.codigo }"), [660, 300]),
  switchNode('Resultado de la consulta', "={{ $json.ok ? 'OK' : $json.error }}", [
    ['Cambiable', 'OK'], ['Código inválido', 'INVALID_CODE'], ['No cambiable', 'NOT_CHANGEABLE'], ['Fuera de plazo', 'TOO_LATE'],
  ], [880, 300]),

  codeNode('Preparar página de día', '03_preparar_pagina_dia.js', [1100, 100]),
  formPage('Página 1 · Nuevo día', "={{ $('Preparar página de día').last().json.fields }}", 'Elige el nuevo día',
    "={{ $('Preparar página de día').last().json.description }}", 'Ver horas libres', [1320, 100]),
  codeNode('Validar día', '03_validar_dia.js', [1540, 100]),

  codeNode('Preparar consulta', '03_preparar_consulta.js', [1760, 100]),
  http('Consultar disponibilidad', 'get_reschedule_availability', J('{ p_code: $json.p_code, p_day: $json.p_day }'), [1980, 100]),
  ifNode('¿Turno todavía cambiable?', '={{ $json.ok }}', [2200, 100]),
  codeNode('Preparar página de horas', '03_preparar_pagina_horas.js', [2420, 0]),
  ifNode('¿Hay horas libres?', '={{ $json.hasSlots }}', [2640, 0]),
  formPage('Página 2 · Hora', "={{ $('Preparar página de horas').last().json.fields }}", 'Elige tu nueva hora',
    "={{ $('Preparar página de horas').last().json.description }}", 'Cambiar la hora', [2860, -100]),
  codeNode('Preparar cambio', '03_preparar_cambio.js', [3080, -100]),
  http('Cambiar hora', 'reschedule_booking', '={{ JSON.stringify($json.body) }}', [3300, -100]),
  switchNode('Resultado del cambio', "={{ $json.ok ? 'OK' : $json.error }}", [
    ['Cambiado', 'OK'], ['Hueco ocupado', 'SLOT_TAKEN'], ['Misma hora', 'SAME_SLOT'], ['Fuera de plazo', 'TOO_LATE'], ['No cambiable', 'NOT_CHANGEABLE'],
  ], [3520, -100]),
  codeNode('Hora ocupada', '03_hora_ocupada.js', [3740, 160]),

  ifNode('¿Hay otros días?', '={{ $json.hasNextDays }}', [2860, 200]),
  codeNode('Preparar página de días', '01_preparar_pagina_dias.js', [3080, 200]),
  formPage('Página · Día completo', "={{ $('Preparar página de días').last().json.fields }}", 'Ese día está completo',
    "={{ $('Preparar página de días').last().json.description }}", 'Ver horas libres', [3300, 340]),
  codeNode('Elegir otro día', '01_elegir_otro_dia.js', [3520, 340]),
  formEnd('Fin · Sin disponibilidad', 'No hay turnos disponibles',
    'Ahora mismo no quedan horas libres en los próximos días para este servicio. Tu turno actual sigue reservado: vuelve a intentarlo más adelante.', [3080, 520]),

  codeNode('Generar correo del cambio', '03_generar_correo.js', [3740, -300]),
  email('Enviar correo del cambio', [3960, -300], { onError: 'continueErrorOutput' }),
  logEmail('Registrar correo enviado', { node: 'Generar correo del cambio', kind: 'reschedule' }, 'sent', 'null', [4180, -400]),
  logEmail('Registrar fallo del correo', { node: 'Generar correo del cambio', kind: 'reschedule' }, 'failed', "String($json.error?.message ?? $json.error ?? 'error desconocido')", [4180, -180]),
  node('Avisar al administrador', 'n8n-nodes-base.emailSend', 2.1, [4400, -180], {
    fromEmail: "={{ $('Configuración').first().json.from_email }}",
    toEmail: "={{ $('Cargar parámetros').first().json.admin_email }}",
    subject: "=[Turnos] No se pudo enviar el correo del cambio de hora",
    emailFormat: 'text',
    text: "=Se cambió la hora de la reserva {{ $('Generar correo del cambio').last().json.booking_id }} pero el correo de confirmación falló. Revisa la tabla email_log en Supabase (status = failed).",
    options: { appendAttribution: false },
  }, { credentials: CRED_SMTP, onError: 'continueRegularOutput' }),
  ...av03.nodes,
  codeNode('Mensaje final', '03_mensaje_final.js', [6200, -300]),
  formEnd('Hora cambiada', 'Hora cambiada', '={{ $json.mensaje }}', [6420, -300]),

  formEnd('Fin · Código inválido', 'Código no válido',
    'No hemos encontrado ningún turno con ese código. Comprueba que lo has copiado completo del correo de confirmación.', [1100, 360]),
  formEnd('Fin · No cambiable', 'Este turno ya no se puede cambiar',
    'El turno ya estaba cancelado o ya ha pasado.', [1100, 520]),
  formEnd('Fin · Fuera de plazo', 'Fuera de plazo',
    "=Solo se puede cambiar la hora con al menos {{ $json.hours }} horas de antelación. Tu turno sigue reservado; ponte en contacto con nosotros si no puedes asistir.", [1100, 680]),
  formEnd('Fin · Error', 'No hemos podido cambiar la hora',
    'Ha ocurrido un problema inesperado. Tu turno sigue como estaba. Inténtalo de nuevo en unos minutos.', [1100, 840]),
], [
  ['Formulario de cambio de hora', 'Configuración'],
  ['Configuración', 'Cargar parámetros'],
  ['Cargar parámetros', 'Consultar turno'],
  ['Consultar turno', 'Resultado de la consulta'],
  ['Resultado de la consulta', 'Preparar página de día', 0],
  ['Resultado de la consulta', 'Fin · Código inválido', 1],
  ['Resultado de la consulta', 'Fin · No cambiable', 2],
  ['Resultado de la consulta', 'Fin · Fuera de plazo', 3],
  ['Resultado de la consulta', 'Fin · Error', 4],
  ['Preparar página de día', 'Página 1 · Nuevo día'],
  ['Página 1 · Nuevo día', 'Validar día'],
  ['Validar día', 'Preparar consulta'],

  ['Preparar consulta', 'Consultar disponibilidad'],
  ['Consultar disponibilidad', '¿Turno todavía cambiable?'],
  ['¿Turno todavía cambiable?', 'Preparar página de horas', 0],
  ['¿Turno todavía cambiable?', 'Fin · No cambiable', 1],
  ['Preparar página de horas', '¿Hay horas libres?'],
  ['¿Hay horas libres?', 'Página 2 · Hora', 0],
  ['¿Hay horas libres?', '¿Hay otros días?', 1],
  ['¿Hay otros días?', 'Preparar página de días', 0],
  ['¿Hay otros días?', 'Fin · Sin disponibilidad', 1],
  ['Preparar página de días', 'Página · Día completo'],
  ['Página · Día completo', 'Elegir otro día'],
  ['Elegir otro día', 'Preparar consulta'],

  ['Página 2 · Hora', 'Preparar cambio'],
  ['Preparar cambio', 'Cambiar hora'],
  ['Cambiar hora', 'Resultado del cambio'],
  ['Resultado del cambio', 'Generar correo del cambio', 0],
  ['Resultado del cambio', 'Hora ocupada', 1],
  ['Resultado del cambio', 'Hora ocupada', 2],
  ['Resultado del cambio', 'Fin · Fuera de plazo', 3],
  ['Resultado del cambio', 'Fin · No cambiable', 4],
  ['Resultado del cambio', 'Fin · Error', 5],
  ['Hora ocupada', 'Preparar consulta'],

  ['Generar correo del cambio', 'Enviar correo del cambio'],
  ['Enviar correo del cambio', 'Registrar correo enviado', 0],
  ['Enviar correo del cambio', 'Registrar fallo del correo', 1],
  ['Registrar correo enviado', 'Generar aviso al personal'],
  ['Registrar fallo del correo', 'Avisar al administrador'],
  ['Avisar al administrador', 'Generar aviso al personal'],
  ...av03.conns,
  ['Mensaje final', 'Hora cambiada'],
]);

// ============================================================
// 04 · RECORDATORIOS (Fase 2) · cada 15 min
//   claim_due_reminders() RECLAMA los turnos de forma atómica (UPDATE ... RETURNING) ANTES de enviar:
//   dos ejecuciones a la vez nunca reciben el mismo turno. Si el envío falla -> report_reminder libera
//   el reclamo y queda en email_log; la pasada siguiente lo reintenta (máx. reminder_max_attempts).
// ============================================================
const PR = "$('Preparar recordatorios').item.json";
const reportBody = (ok, errExpr) =>
  `={{ JSON.stringify({ p_booking_id: ${PR}.booking_id, p_kind: ${PR}.kind, p_claimed_at: ${PR}.claimed_at, p_ok: ${ok}, p_error: ${errExpr}, p_to: ${PR}.to }) }}`;
const alertaAgotado = (name, subject, text, position) => node(name, 'n8n-nodes-base.emailSend', 2.1, position, {
  fromEmail: "={{ $('Configuración').first().json.from_email }}",
  toEmail: "={{ $('Cargar parámetros').first().json.admin_email }}",
  subject, emailFormat: 'text', text,
  options: { appendAttribution: false },
}, { credentials: CRED_SMTP, onError: 'continueRegularOutput' });

const wf04 = workflow('turnosRecordatorios1', 'Turnos · 04 Recordatorios', [
  node('Cada 15 minutos', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], {
    rule: { interval: [{ field: 'cronExpression', expression: CRON }] },
  }),
  configNode([220, 300]),
  http('Cargar parámetros', 'get_config', '{}', [440, 300]),
  http('Reclamar recordatorios', 'claim_due_reminders', '{}', [660, 300]),
  codeNode('Preparar recordatorios', '04_preparar_recordatorios.js', [880, 300]),
  email('Enviar recordatorio', [1100, 300], { onError: 'continueErrorOutput' }, false),
  http('Registrar envío', 'report_reminder', reportBody('true', 'null'), [1320, 200]),
  http('Registrar fallo', 'report_reminder', reportBody('false', "String($json.error?.message ?? $json.error ?? 'error desconocido')"), [1320, 420]),
  ifNode('¿Se agotaron los intentos?', '={{ $json.gave_up }}', [1540, 420]),
  alertaAgotado('Avisar al administrador', "=[Turnos] Un recordatorio no se pudo enviar",
    "=El recordatorio de {{ " + PR + ".kind }} de la reserva {{ " + PR + ".booking_id }} falló {{ $json.attempts }} veces y ya no se reintentará. Revisa la tabla email_log en Supabase (kind = reminder_{{ " + PR + ".kind }}, status = failed).",
    [1760, 420]),
], [
  ['Cada 15 minutos', 'Configuración'],
  ['Configuración', 'Cargar parámetros'],
  ['Cargar parámetros', 'Reclamar recordatorios'],
  ['Reclamar recordatorios', 'Preparar recordatorios'],
  ['Preparar recordatorios', 'Enviar recordatorio'],
  ['Enviar recordatorio', 'Registrar envío', 0],
  ['Enviar recordatorio', 'Registrar fallo', 1],
  ['Registrar fallo', '¿Se agotaron los intentos?'],
  ['¿Se agotaron los intentos?', 'Avisar al administrador', 0],
]);
// Las pasadas sin nada que enviar son casi todas: no se guardan (y las que envían no dejan nombres/correos en n8n). Los errores sí.
wf04.settings.saveDataSuccessExecution = SAVE_SUCCESS ? 'all' : 'none';

// ============================================================
// 05 · RESUMEN DIARIO (Fase 2) · se consulta cada 15 min, se envía UNA vez al día
//   claim_daily_summary() solo devuelve due=true a partir de settings.daily_summary_time (08:00 por defecto,
//   hora local) y una única vez por día (clave primaria en daily_summary_log). Si n8n estaba caído a las 08:00,
//   el resumen sale en cuanto vuelve (el mismo día).
// ============================================================
const wf05 = workflow('turnosResumen1', 'Turnos · 05 Resumen diario', [
  node('Cada 15 minutos', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], {
    rule: { interval: [{ field: 'cronExpression', expression: CRON }] },
  }),
  configNode([220, 300]),
  http('Cargar parámetros', 'get_config', '{}', [440, 300]),
  http('Reclamar resumen', 'claim_daily_summary', '{}', [660, 300]),
  ifNode('¿Toca enviar?', '={{ $json.due === true && $json.send === true }}', [880, 300]),
  codeNode('Preparar resumen', '05_preparar_resumen.js', [1100, 200]),
  email('Enviar resumen', [1320, 200], { onError: 'continueErrorOutput' }, false),
  http('Registrar envío', 'report_daily_summary',
    "={{ JSON.stringify({ p_day: $('Preparar resumen').first().json.day, p_ok: true, p_error: null, p_to: $('Preparar resumen').first().json.to }) }}", [1540, 100]),
  http('Registrar fallo', 'report_daily_summary',
    "={{ JSON.stringify({ p_day: $('Preparar resumen').first().json.day, p_ok: false, p_error: String($json.error?.message ?? $json.error ?? 'error desconocido'), p_to: $('Preparar resumen').first().json.to }) }}", [1540, 320]),
  ifNode('¿Se agotaron los intentos?', '={{ $json.gave_up }}', [1760, 320]),
  alertaAgotado('Avisar al administrador', "=[Turnos] No se pudo enviar el resumen diario",
    "=El resumen diario del {{ $('Preparar resumen').first().json.day }} falló en todos sus intentos y ya no se reintentará. Revisa la tabla email_log en Supabase (kind = daily_summary, status = failed) y la credencial SMTP.",
    [1980, 320]),
], [
  ['Cada 15 minutos', 'Configuración'],
  ['Configuración', 'Cargar parámetros'],
  ['Cargar parámetros', 'Reclamar resumen'],
  ['Reclamar resumen', '¿Toca enviar?'],
  ['¿Toca enviar?', 'Preparar resumen', 0],
  ['Preparar resumen', 'Enviar resumen'],
  ['Enviar resumen', 'Registrar envío', 0],
  ['Enviar resumen', 'Registrar fallo', 1],
  ['Registrar fallo', '¿Se agotaron los intentos?'],
  ['¿Se agotaron los intentos?', 'Avisar al administrador', 0],
]);
wf05.settings.saveDataSuccessExecution = SAVE_SUCCESS ? 'all' : 'none';

// ============================================================
// 06 · ENLACES CORTOS: REDIRECCIÓN (Fase 3)
//   GET  <dominio-corto>/<slug>  ->  302 al destino + ?origen=<slug>, o a la página por defecto si el slug no existe.
//   resolve_link() SOLO LEE y devuelve un destino ya validado (dominios permitidos). La respuesta 302 sale ANTES de contar:
//   register_click() va después del nodo «Redirigir», así la redirección no espera al recuento (y un fallo al contar no
//   estropea la redirección). El único camino al contador es este webhook: la API de Supabase no lo permite desde fuera.
//   Webhook con ruta dinámica (:slug): n8n lo publica como /webhook/<webhookId>/<slug>; el proxy del dominio corto
//   traduce l.tudominio.io/<slug> a esa ruta (ver docs/DOMINIO-ENLACES.md).
// ============================================================
const WEBHOOK_ENLACES_ID = '6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06';
const wf06 = workflow('turnosEnlaces1', 'Turnos · 06 Enlaces cortos', [
  node('Enlace corto', 'n8n-nodes-base.webhook', 2.1, [0, 300], {
    httpMethod: 'GET',
    path: ':slug',
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: WEBHOOK_ENLACES_ID }),
  configNode([220, 300], false, true),
  // Solo caracteres ASCII imprimibles y 100 como máximo: un slug válido tiene <= 40 y lo demás "no existe", pero un NUL o un texto enorme no deben
  // llegar a la base de datos ni hacerse pasar por una caída (acabarían en la página de respaldo en vez de en la de por defecto).
  http('Resolver enlace', 'resolve_link', J("{ p_slug: String($('Enlace corto').first().json.params.slug ?? '').slice(0, 100).replace(/[^ -~]/g, '') }"), [440, 300], { onError: 'continueRegularOutput' }),
  codeNode('Preparar redirección', '06_preparar_redireccion.js', [660, 300]),
  ifNode('¿Hay destino?', '={{ $json.location !== null }}', [880, 300]),
  node('Redirigir (302)', 'n8n-nodes-base.respondToWebhook', 1.4, [1100, 200], {
    respondWith: 'noData',
    options: {
      responseCode: 302,
      responseHeaders: { entries: [
        { name: 'Location', value: '={{ $json.location }}' },
        { name: 'Cache-Control', value: 'no-store' },       // un 302 sin caché: cada visita pasa por aquí y se cuenta
      ] },
    },
  }),
  ifNode('¿Cuenta el clic?', "={{ $('Preparar redirección').first().json.count }}", [1320, 200]),
  http('Registrar clic', 'register_click', J("{ p_slug: $('Preparar redirección').first().json.slug }"), [1540, 100]),
  node('Responder 404', 'n8n-nodes-base.respondToWebhook', 1.4, [1100, 440], {
    respondWith: 'text',
    responseBody: 'Enlace no disponible.',
    options: { responseCode: 404 },
  }),
], [
  ['Enlace corto', 'Configuración'],
  ['Configuración', 'Resolver enlace'],
  ['Resolver enlace', 'Preparar redirección'],
  ['Preparar redirección', '¿Hay destino?'],
  ['¿Hay destino?', 'Redirigir (302)', 0],
  ['¿Hay destino?', 'Responder 404', 1],
  ['Redirigir (302)', '¿Cuenta el clic?'],
  ['¿Cuenta el clic?', 'Registrar clic', 0],
]);
// Tráfico alto y sin datos personales: las ejecuciones correctas no se guardan (los errores sí).
wf06.settings.saveDataSuccessExecution = SAVE_SUCCESS ? 'all' : 'none';

// ============================================================
// 07 · CREAR ENLACE CORTO (Fase 3) · formulario del equipo, protegido con usuario y contraseña (Basic Auth)
//   Toda la validación (formato del slug, slug único, destino permitido) la hace create_link() en la base de datos;
//   aquí solo se muestra el resultado. El formulario es de UNA página: no hay páginas intermedias sin protección.
// ============================================================
const FE = "$('Formulario de enlaces').first().json";
const wf07 = workflow('turnosCrearEnlace1', 'Turnos · 07 Crear enlace corto', [
  node('Formulario de enlaces', 'n8n-nodes-base.formTrigger', 2.5, [0, 300], {
    authentication: 'basicAuth',
    formTitle: 'Crear enlace corto',
    formDescription: 'Crea un enlace corto para una campaña o canal (por ejemplo, instagram). Las reservas hechas desde él se cuentan en las estadísticas. El slug solo admite minúsculas, números y guiones.',
    formFields: { values: [
      { fieldLabel: 'Slug', fieldName: 'slug', fieldType: 'text', requiredField: true, placeholder: 'instagram' },
      { fieldLabel: 'Destino (opcional)', fieldName: 'destino', fieldType: 'text', placeholder: 'Vacío = el formulario de reserva' },
      { fieldLabel: 'Canal (opcional)', fieldName: 'canal', fieldType: 'text', placeholder: 'Vacío = el slug. Ej.: instagram' },
    ] },
    responseMode: 'onReceived',
    options: { path: 'crear-enlace', buttonLabel: 'Crear enlace', appendAttribution: false },
  }, { webhookId: uuid(), credentials: CRED_BASIC }),
  configNode([220, 300]),
  http('Crear enlace', 'create_link', J(`{ p_slug: ${FE}.slug, p_destination: ${FE}.destino ?? null, p_channel: ${FE}.canal ?? null }`), [440, 300]),
  switchNode('Resultado de la creación', "={{ $json.ok ? 'OK' : $json.error }}", [
    ['Creado', 'OK'], ['Slug inválido', 'INVALID_SLUG'], ['Slug en uso', 'SLUG_TAKEN'], ['Destino no permitido', 'DESTINATION_NOT_ALLOWED'],
    ['Destino = dominio corto', 'DESTINATION_LOOP'], ['Destino con origen', 'DESTINATION_HAS_ORIGEN'], ['Canal inválido', 'INVALID_CHANNEL'],
  ], [660, 300]),
  codeNode('Mensaje final', '07_mensaje_final.js', [880, 40]),
  formEnd('Enlace creado', 'Enlace creado', '={{ $json.mensaje }}', [1100, 40]),
  formEnd('Fin · Slug inválido', 'Slug no válido',
    'El slug solo puede llevar minúsculas (a-z), números y guiones; sin guion al principio ni al final, sin guiones dobles y hasta 40 caracteres. Ejemplos: instagram, mi-campana-2. Vuelve a abrir el formulario y prueba de nuevo.', [880, 200]),
  formEnd('Fin · Slug en uso', 'Ese slug ya existe',
    'Ya hay un enlace con ese slug. Elige otro (o desactiva el anterior poniendo active = false en la tabla links de Supabase). Vuelve a abrir el formulario.', [880, 340]),
  formEnd('Fin · Destino no permitido', 'Destino no permitido',
    'El destino debe ser una dirección https:// de uno de los dominios permitidos (ajuste link_allowed_domains en Supabase). Si lo dejas vacío se usa el formulario de reserva (ajuste booking_form_url), que también debe estar en un dominio permitido.', [880, 480]),
  formEnd('Fin · Bucle', 'Destino no válido',
    'El destino no puede ser el propio dominio de los enlaces cortos: redirigiría en círculo.', [880, 620]),
  formEnd('Fin · Destino con origen', 'El destino ya lleva «origen»',
    'Quita el parámetro origen= del destino: el sistema lo añade solo, con el slug del enlace.', [880, 760]),
  formEnd('Fin · Canal inválido', 'Canal no válido',
    'El canal también solo admite minúsculas, números y guiones (por ejemplo, instagram). Puedes dejarlo vacío.', [880, 900]),
  formEnd('Fin · Error', 'No hemos podido crear el enlace',
    'Ha ocurrido un problema inesperado. Inténtalo de nuevo en unos minutos.', [880, 1040]),
], [
  ['Formulario de enlaces', 'Configuración'],
  ['Configuración', 'Crear enlace'],
  ['Crear enlace', 'Resultado de la creación'],
  ['Resultado de la creación', 'Mensaje final', 0],
  ['Resultado de la creación', 'Fin · Slug inválido', 1],
  ['Resultado de la creación', 'Fin · Slug en uso', 2],
  ['Resultado de la creación', 'Fin · Destino no permitido', 3],
  ['Resultado de la creación', 'Fin · Bucle', 4],
  ['Resultado de la creación', 'Fin · Destino con origen', 5],
  ['Resultado de la creación', 'Fin · Canal inválido', 6],
  ['Resultado de la creación', 'Fin · Error', 7],
  ['Mensaje final', 'Enlace creado'],
]);

// Gemelos de prueba: mismo workflow con otro id/nombre; con --cron "* * * * *" se disparan EN EL MISMO SEGUNDO.
const twin = (wf, id, name) => ({ ...structuredClone(wf), id, name });

// ---------- escribir ----------
fs.mkdirSync(OUT, { recursive: true });
const write = (f, wf) => { fs.writeFileSync(path.join(OUT, f), JSON.stringify(wf, null, 2) + '\n'); console.log('escrito', path.join(OUT, f)); };
write('01-reservar.json', wf01);
write('02-cancelar.json', wf02);
write('03-cambiar-hora.json', wf03);
write('04-recordatorios.json', wf04);
write('05-resumen-diario.json', wf05);
write('06-enlaces-cortos.json', wf06);
write('07-crear-enlace.json', wf07);
if (TWINS) {
  write('04b-recordatorios-gemelo.json', twin(wf04, 'turnosRecordatorios2', 'Turnos · 04b Recordatorios (gemelo de prueba)'));
  write('05b-resumen-diario-gemelo.json', twin(wf05, 'turnosResumen2', 'Turnos · 05b Resumen diario (gemelo de prueba)'));
}
write('99-aviso-de-errores.json', wf99);
