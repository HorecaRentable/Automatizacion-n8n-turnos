// ============================================================
// Entorno local para probar los workflows de n8n de principio a fin:
//   Postgres real (migraciones + seed)  ->  PostgREST (igual que la API de Supabase)
//   + servidor SMTP "sumidero" que guarda los correos (con su .ics) en una carpeta.
//
//   node e2e/stack.mjs <carpeta-de-trabajo> <ruta-a-postgrest.exe>
//
// Escribe <carpeta>/stack.json con la URL de la API, la clave service_role y el puerto SMTP,
// y se queda en marcha hasta que se le envíe una señal (Ctrl+C).
// ============================================================
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

const WORK = path.resolve(process.argv[2] ?? './e2e-work');
const PGRST_BIN = process.argv[3] ?? 'postgrest';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PG_PORT = 54330, API_PORT = 54331, PGRST_PORT = 54332, SMTP_PORT = 2525;
const JWT_SECRET = 'secreto-local-de-pruebas-0123456789abcdef';

fs.mkdirSync(path.join(WORK, 'mails'), { recursive: true });
for (const f of fs.readdirSync(path.join(WORK, 'mails'))) fs.rmSync(path.join(WORK, 'mails', f), { recursive: true, force: true });

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = role => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ role, iss: 'local-test', exp: 4102444800 });
  return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
};

const dataDir = fs.mkdtempSync(path.join(WORK, 'pgdata-'));
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false, onLog: () => {}, onError: () => {} });
await server.initialise(); await server.start(); await server.createDatabase('turnos');
const db = new pg.Client({ host: 'localhost', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'turnos' });
await db.connect();
await db.query(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
const migDir = path.join(ROOT, 'supabase', 'migrations');
for (const f of fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort())
  await db.query('begin;\n' + fs.readFileSync(path.join(migDir, f), 'utf8') + '\ncommit;');
await db.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
// En el entorno local no hay bloqueo de ejemplo que moleste a las pruebas de pantalla
await db.query(`update settings set value='http://localhost:5678/form/cancelar-turno' where key='cancel_form_url'`);
await db.query(`update settings set value='admin@local.test' where key='admin_email'`);
// Fase 2: formulario de cambio de hora y correo de quien atiende (distinto del administrador para distinguir los avisos)
await db.query(`update settings set value='http://localhost:5678/form/cambiar-turno' where key='reschedule_form_url'`);
await db.query(`update settings set value='staff@local.test' where key='staff_email'`);
// El resumen diario no debe dispararse por su cuenta mientras corren las demás pruebas (E25 fija su hora)
await db.query(`update settings set value='23:59' where key='daily_summary_time'`);
// Fase 3: enlaces cortos. localhost es un "dominio permitido" SOLO en este entorno de pruebas (http solo vale para localhost)
await db.query(`update settings set value='http://localhost:5678/form/reservar-turno' where key='booking_form_url'`);
await db.query(`update settings set value='rocketnova.io localhost' where key='link_allowed_domains'`);

const pgrstConf = path.join(WORK, 'postgrest.conf');
fs.writeFileSync(pgrstConf, [
  `db-uri = "postgres://postgres:postgres@localhost:${PG_PORT}/turnos"`,
  'db-schemas = "public"', 'db-anon-role = "anon"', `jwt-secret = "${JWT_SECRET}"`,
  'server-host = "127.0.0.1"', `server-port = ${PGRST_PORT}`].join('\n'));
const pgrst = spawn(PGRST_BIN, [pgrstConf], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(PGRST_BIN) });
pgrst.stderr.on('data', d => fs.appendFileSync(path.join(WORK, 'postgrest.log'), d));
pgrst.stdout.on('data', d => fs.appendFileSync(path.join(WORK, 'postgrest.log'), d));

// Gateway mínimo como el de Supabase: <host>/rest/v1/<ruta> -> PostgREST /<ruta>
const gateway = http.createServer((req, res) => {
  if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"no route"}'); }
  const up = http.request({ host: '127.0.0.1', port: PGRST_PORT, method: req.method, path: req.url.slice('/rest/v1'.length), headers: req.headers },
    (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'PostgREST caído: ' + e.message })); });
  req.pipe(up);
});
await new Promise(r => gateway.listen(API_PORT, '127.0.0.1', r));

let mailN = 0;
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
  onAuth(auth, _s, cb) { cb(null, { user: auth.username }); },
  async onData(stream, session, cb) {
    // Para simular un fallo de correo: crear el archivo <carpeta>/smtp-fail (borrarlo lo restablece).
    // Vacío o con "1" -> fallan TODOS los correos. Con líneas de texto -> fallan solo los correos cuyo destinatario contiene alguna de ellas.
    const flag = path.join(WORK, 'smtp-fail');
    if (fs.existsSync(flag)) {
      const rules = fs.readFileSync(flag, 'utf8').split(/\s*\n\s*/).map(x => x.trim().toLowerCase()).filter(Boolean);
      const rcpts = session.envelope.rcptTo.map(r => r.address.toLowerCase());
      if (!rules.length || rules.includes('1') || rcpts.some(a => rules.some(r => a.includes(r)))) {
        stream.resume(); return cb(Object.assign(new Error('SMTP caído (simulado)'), { responseCode: 451 }));
      }
    }
    try {
      const m = await simpleParser(stream);
      const n = ++mailN;
      const rec = {
        n, to: (m.to?.value ?? []).map(a => a.address), from: m.from?.value?.[0]?.address, subject: m.subject, text: m.text, html: m.html || null,
        attachments: (m.attachments ?? []).map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content.toString('utf8') })),
      };
      fs.writeFileSync(path.join(WORK, 'mails', `mail-${String(n).padStart(3, '0')}.json`), JSON.stringify(rec, null, 2));
      cb();
    } catch (e) { cb(e); }
  },
});
await new Promise(r => smtp.listen(SMTP_PORT, '127.0.0.1', r));

// Espera a que PostgREST responda antes de dar el entorno por listo
for (let i = 0; i < 60; i++) {
  const ok = await new Promise(r => { const q = http.get({ host: '127.0.0.1', port: PGRST_PORT, path: '/' }, x => { x.resume(); r(true); }); q.on('error', () => r(false)); });
  if (ok) break; await new Promise(r => setTimeout(r, 500));
}
fs.writeFileSync(path.join(WORK, 'stack.json'), JSON.stringify({
  api: `http://127.0.0.1:${API_PORT}`, serviceRoleKey: jwt('service_role'), anonKey: jwt('anon'),
  smtpPort: SMTP_PORT, pgPort: PG_PORT, mailsDir: path.join(WORK, 'mails'),
}, null, 2));
console.log('STACK LISTO', API_PORT, SMTP_PORT);

const stop = async () => {
  try { pgrst.kill(); } catch {}
  try { smtp.close(); gateway.close(); } catch {}
  try { await db.end(); } catch {}
  try { await server.stop(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
