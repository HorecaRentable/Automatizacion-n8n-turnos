// ============================================================
// Monta un n8n LOCAL de pruebas para el E2E: propietario, credenciales, workflows importados y publicados.
//
//   node e2e/n8n-local.mjs <carpeta-de-trabajo> <carpeta-con-n8n-instalado> [carpeta-de-workflows]
//
// * <carpeta-con-n8n-instalado>: donde hiciste `npm install n8n@2.44.4` (debe existir node_modules/n8n).
// * <carpeta-de-workflows>: por defecto <carpeta-de-trabajo>/wf (los que genera build.mjs).
// * Necesita que `node e2e/stack.mjs <carpeta> …` esté en marcha (lee <carpeta>/stack.json para la clave service_role).
// * Deja n8n ARRANCADO en http://localhost:5678 (pid en <carpeta>/n8n.pid, log en <carpeta>/n8n.log);
//   para pararlo: matar ese pid.
// Usa su propia carpeta de datos (<carpeta>/n8n-home): no toca ningún n8n que tengas instalado.
// ============================================================
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const WORK = path.resolve(process.argv[2] ?? './e2e-work');
const N8N_DIR = path.resolve(process.argv[3] ?? '.');
const WF_DIR = path.resolve(process.argv[4] ?? path.join(WORK, 'wf'));
const BIN = path.join(N8N_DIR, 'node_modules', 'n8n', 'bin', 'n8n');
const HOME = path.join(WORK, 'n8n-home');
const stack = JSON.parse(fs.readFileSync(path.join(WORK, 'stack.json'), 'utf8'));
const URL = 'http://localhost:5678';

const env = {
  ...process.env,
  N8N_USER_FOLDER: HOME, N8N_ENCRYPTION_KEY: 'e2e-local-key-0123456789abcdef',
  N8N_PORT: '5678', N8N_HOST: 'localhost', N8N_PROTOCOL: 'http', WEBHOOK_URL: URL + '/',
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_SECURE_COOKIE: 'false', GENERIC_TIMEZONE: 'Europe/Madrid', TZ: 'Europe/Madrid',
  N8N_RUNNERS_ENABLED: 'true', N8N_DEFAULT_BINARY_DATA_MODE: 'default',
};
fs.mkdirSync(HOME, { recursive: true });
const cli = (...a) => execFileSync(process.execPath, [BIN, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const startN8n = () => {
  const log = fs.openSync(path.join(WORK, 'n8n.log'), 'a');
  const child = spawn(process.execPath, [BIN, 'start'], { env, detached: true, stdio: ['ignore', log, log] });
  child.unref(); fs.writeFileSync(path.join(WORK, 'n8n.pid'), String(child.pid));
  return child;
};
async function waitUp(ms = 120000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000)) {
    try { if ((await fetch(URL + '/healthz')).ok) return; } catch {}
  }
  throw new Error('n8n no arrancó (mira n8n.log)');
}
const stopN8n = async () => {
  const pid = Number(fs.readFileSync(path.join(WORK, 'n8n.pid'), 'utf8'));
  try { process.kill(pid); } catch {}
  await sleep(4000);
};

// 1) primer arranque: crea la base de datos y el propietario
startN8n(); await waitUp();
const r = await fetch(URL + '/rest/owner/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'e2e@local.test', firstName: 'E2E', lastName: 'Local', password: 'E2e-Local-Pass-1234' }) });
if (!r.ok && r.status !== 400) throw new Error('owner/setup ' + r.status + ' ' + await r.text());
const sqlite = new DatabaseSync(path.join(HOME, '.n8n', 'database.sqlite'), { readOnly: true });
const userId = sqlite.prepare('select id from user order by createdAt limit 1').get().id;
sqlite.close();
await stopN8n();

// 2) credenciales (mismos ids que usan los workflows) y workflows
const creds = [
  { id: 'supabaseTurnos1', name: 'Supabase turnos (service role)', type: 'supabaseApi', data: { host: stack.api, serviceRole: stack.serviceRoleKey } },
  { id: 'smtpTurnos1', name: 'SMTP turnos', type: 'smtp', data: { user: '', password: '', host: '127.0.0.1', port: stack.smtpPort, secure: false, disableStartTls: true } },
  // Fase 3: usuario y contraseña del formulario del equipo (workflow 07)
  { id: 'formularioEquipo1', name: 'Formulario del equipo (usuario y contraseña)', type: 'httpBasicAuth', data: { user: 'equipo', password: 'clave-de-prueba-123' } },
];
const credFile = path.join(WORK, 'credenciales-e2e.json');
fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
console.log(cli('import:credentials', `--input=${credFile}`).trim());
console.log(cli('import:workflow', '--separate', `--input=${WF_DIR}`, `--userId=${userId}`).trim());
for (const f of fs.readdirSync(WF_DIR).filter(f => f.endsWith('.json'))) {
  const id = JSON.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8')).id;
  console.log(cli('publish:workflow', `--id=${id}`).trim());
}

// 3) arranque definitivo
startN8n(); await waitUp();
console.log(`N8N LISTO ${URL} (pid ${fs.readFileSync(path.join(WORK, 'n8n.pid'), 'utf8')}; base de datos: ${path.join(HOME, '.n8n', 'database.sqlite')})`);
