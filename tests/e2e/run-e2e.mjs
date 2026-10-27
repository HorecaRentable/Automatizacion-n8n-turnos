// ============================================================
// Pruebas de extremo a extremo: navegador real (Edge/Chrome) -> formularios de n8n ->
// API de Supabase (PostgREST) -> Postgres, con un servidor SMTP que captura los correos.
//
//   node e2e/stack.mjs <carpeta> <postgrest.exe>        (terminal 1: BD + API + SMTP)
//   n8n arrancado con los workflows importados            (terminal 2)
//   node e2e/run-e2e.mjs <carpeta>                        (terminal 3)
// ============================================================
import puppeteer from 'puppeteer-core';
import ICAL from 'ical.js';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

pg.types.setTypeParser(1082, v => v);
const WORK = path.resolve(process.argv[2] ?? './e2e-work');
const stack = JSON.parse(fs.readFileSync(path.join(WORK, 'stack.json'), 'utf8'));
const N8N = process.env.N8N_URL ?? 'http://localhost:5678';
const BROWSER = [process.env.BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => p && fs.existsSync(p));
const SHOTS = path.join(WORK, 'capturas'); fs.mkdirSync(SHOTS, { recursive: true });
const SVC_NAME = 'Consulta de 30 minutos';

const db = new pg.Client({ host: 'localhost', port: stack.pgPort, user: 'postgres', password: 'postgres', database: 'turnos' });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ---------- utilidades ----------
const results = [];
// ONLY=E20,E23  ejecuta solo esas pruebas (para repetir una; algunas dependen de otras anteriores: E22 de E18)
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(x => x.trim()) : null;
async function test(name, fn) {
  if (ONLY && !ONLY.includes(name.split(' ')[0])) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) {
    if (e.skip) { results.push({ name, ok: true, skipped: e.message }); console.log(`  ↷ ${name}\n      SALTADA: ${e.message}`); return; }
    results.push({ name, ok: false, err: e.message }); console.log(`  ✘ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`); }
}
const ymd = (d) => d.toISOString().slice(0, 10);
/** fecha local de Madrid de hoy + n días */
const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dow = (s) => new Date(s + 'T12:00:00Z').getUTCDay();   // 0 = domingo
/** primer día >= hoy+min con ese día de la semana (1 = lunes) */
const nextWeekday = (wd, min = 5) => { let d = addDays(madridToday(), min); while (dow(d) !== wd) d = addDays(d, 1); return d; };
const mails = () => fs.readdirSync(stack.mailsDir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(stack.mailsDir, f), 'utf8')));
async function waitMail(pred, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = mails().find(pred); if (m) return m; await sleep(300); }
  throw new Error('no llegó el correo esperado. Correos recibidos: ' + JSON.stringify(mails().map(m => [m.to, m.subject])));
}

const profileDir = fs.mkdtempSync(path.join(WORK, 'perfil-navegador-'));
const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, userDataDir: profileDir,
  args: ['--no-sandbox', '--lang=es-ES', '--no-first-run', '--disable-extensions', '--disable-gpu'] });
const newPage = async () => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage(); page.setDefaultTimeout(25000);
  await page.setViewport({ width: 900, height: 1000 });
  page.on('pageerror', () => {});
  return page;
};
const h1 = (page) => page.evaluate(() => (document.querySelector('h1:not(#submitted-header)')?.innerText ?? document.title).trim());
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const shot = async (page, name) => { await sleep(600); await page.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {}); };
async function waitTitle(page, re, ms = 25000) {
  try { await page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('h1:not(#submitted-header)')?.innerText ?? document.title), { timeout: ms }, re.source); }
  catch (e) { await shot(page, 'fallo-' + Date.now()); throw new Error(`no apareció la página /${re.source}/. Se ve: "${await h1(page)}" — ${(await bodyText(page)).slice(0, 300).replace(/\n+/g, ' | ')}`); }
}
const submit = async (page) => { await page.click('#submit-btn'); };

/** landing -> página 1 */
async function openBooking(page, query = '') {
  await page.goto(`${N8N}/form/reservar-turno${query}`, { waitUntil: 'networkidle2' });   // esperar a que cargue el JS del formulario
  await waitTitle(page, /Reserva tu turno/);
  await submit(page);
  await waitTitle(page, /Tus datos/);
}
/** rellena la página 1 y pasa a la de horas */
async function fillPage1(page, { day, name, email, phone, privacy = true, service = SVC_NAME }) {
  await page.select('#field-0', service);
  await page.$eval('#field-1', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, day);
  await page.$eval('#field-2', (el) => { el.value = ''; }); await page.type('#field-2', name);
  await page.$eval('#field-3', (el) => { el.value = ''; }); await page.type('#field-3', email);
  await page.$eval('#field-4', (el) => { el.value = ''; }); await page.type('#field-4', phone);
  const cb = await page.$('input[type=checkbox]');
  if (privacy && !(await cb.evaluate(e => e.checked))) await cb.click();
  await submit(page);
}
const hourOptions = (page) => page.$$eval('#field-0 option', os => os.map(o => o.value).filter(Boolean));
async function bookViaUi(page, { day, hour, ...who }) {
  await openBooking(page);
  await fillPage1(page, { day, ...who });
  await waitTitle(page, /Elige tu hora/);
  await page.select('#field-0', hour);
  await submit(page);
}
const bookingsOf = (email) => q(`select b.*, iso_utc(starts_at) s, iso_utc(ends_at) e from bookings b where customer_email=$1 order by created_at`, [email]);
const icsOf = (m) => m.attachments.find(a => /\.ics$/.test(a.filename ?? ''));
const uniq = (p) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@ejemplo.com`;
const PHONE = '+34 600 123 456';

// ---------- Fase 2: utilidades ----------
const STAFF = 'staff@local.test', ADMIN = 'admin@local.test';
const dmy = (s) => s.split('-').reverse().join('/');
const fechaLarga = (s) => new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(s + 'T12:00:00Z'));
const rowJson = async (id) => (await q(`select to_jsonb(b) r from bookings b where id=$1`, [id]))[0].r;
const svcId = async () => (await q('select id from services where name=$1', [SVC_NAME]))[0].id;
/** turno creado directamente en la BD (hora local de Madrid) -> { id, management_code, link } */
async function sqlBooking({ day, time, email, name = 'Cliente SQL', svc = null }) {
  const r = (await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
                      values ($1,$2,$3,'+34 600 000 111', ($4::date + $5::time) at time zone 'Europe/Madrid', true) returning id, management_code`,
    [svc ?? await svcId(), name, email, day, time]))[0];
  return { ...r, link: `${N8N}/form/cambiar-turno?codigo=${r.management_code}` };
}
/** formulario de cambio de hora: abre el enlace y pasa a la página del día */
async function openReschedule(page, link) {
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await waitTitle(page, /Cambiar la hora de tu turno/);
  await submit(page);
}
/** página del día -> escribe el día y pasa a la de horas */
async function pickDay(page, day) {
  await waitTitle(page, /Elige el nuevo día/);
  await page.$eval('#field-0', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, day);
  await submit(page);
  await waitTitle(page, /Elige tu nueva hora|Ese día está completo/);
}
const mailsTo = (to, re) => mails().filter(m => m.to.includes(to) && re.test(m.subject));
const inMinutes = (min) => new Date(Date.now() + min * 60000).toISOString();
let cancelledForE21 = null;

// ============================================================
console.log(`Navegador: ${BROWSER}\nn8n: ${N8N}\n`);
const today = madridToday();
const dstWindow = today <= '2026-10-21';

await test('E01 reserva completa de principio a fin, en la semana del cambio de hora: lunes 26-oct-2026 09:00 (UTC+1) → correo con .ics 08:00Z', async () => {
  if (!dstWindow) throw Object.assign(new Error('usa fechas de octubre de 2026 y hoy ya es ' + today), { skip: true });
  const page = await newPage(); const email = uniq('e01');
  await bookViaUi(page, { day: '2026-10-26', hour: '09:00', name: 'Ana Pérez', email, phone: PHONE });
  await waitTitle(page, /Turno reservado/);
  const txt = await bodyText(page);
  assert.match(txt, /Consulta de 30 minutos/); assert.match(txt, /09:00/); assert.match(txt, new RegExp(email.replace(/[.+]/g, '\\$&')));
  await shot(page, 'e01-turno-reservado');
  const b = (await bookingsOf(email))[0];
  assert.equal(b.s, '2026-10-26T08:00:00Z'); assert.equal(b.status, 'confirmed'); assert.equal(b.consent_given, true);
  const m = await waitMail(x => x.to.includes(email));
  assert.match(m.subject, /Turno confirmado/); assert.match(m.subject, /26\/10\/2026 09:00/);
  const ics = icsOf(m); assert.ok(ics, 'falta el adjunto .ics: ' + JSON.stringify(m.attachments.map(a => a.filename)));
  assert.match(ics.content, /BEGIN:VCALENDAR/); assert.match(ics.content, /DTSTART:20261026T080000Z/); assert.match(ics.content, /DTEND:20261026T083000Z/);
  assert.match(ics.content, new RegExp(`UID:${b.id}@turnos`)); assert.match(ics.content, /STATUS:CONFIRMED/);
  assert.ok(ics.content.includes('\r\n'), 'el .ics debe usar CRLF');
  assert.ok(ics.content.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'líneas del .ics de más de 75 octetos');
  const ev = new ICAL.Event(new ICAL.Component(ICAL.parse(ics.content)).getFirstSubcomponent('vevent'));   // parser independiente
  assert.equal(ev.summary, 'Consulta de 30 minutos');
  assert.equal(ev.startDate.toJSDate().toISOString(), '2026-10-26T08:00:00.000Z');
  assert.equal(ev.endDate.toJSDate().toISOString(), '2026-10-26T08:30:00.000Z');
  assert.equal(ev.uid, `${b.id}@turnos`);
  assert.match(ev.description, /cancelar-turno\?codigo=/);
  assert.match(m.html, new RegExp('/form/cancelar-turno\\?codigo=' + b.management_code));
  assert.match(m.text, /26 de octubre de 2026 a las 09:00/);
});

await test('E02 viernes 23-oct-2026 09:00 (aún horario de verano, UTC+2) → .ics 07:00Z', async () => {
  if (!dstWindow) throw Object.assign(new Error('usa fechas de octubre de 2026 y hoy ya es ' + today), { skip: true });
  const page = await newPage(); const email = uniq('e02');
  await bookViaUi(page, { day: '2026-10-23', hour: '09:00', name: 'Luis Gómez', email, phone: PHONE });
  await waitTitle(page, /Turno reservado/);
  const m = await waitMail(x => x.to.includes(email));
  assert.match(icsOf(m).content, /DTSTART:20261023T070000Z/);
  assert.match(m.text, /23 de octubre de 2026 a las 09:00/);
});

await test('E03 solo se ven horas libres: respeta bloqueo (seed), horario, y tras reservar las 10:00 oculta 09:30/10:00/10:30 (descanso)', async () => {
  const blockDay = (await q(`select (starts_at at time zone 'Europe/Madrid')::date as d from blocks limit 1`))[0].d;
  const page = await newPage();
  await openBooking(page);
  await fillPage1(page, { day: blockDay, name: 'Marta Ruiz', email: uniq('e03'), phone: PHONE });
  await waitTitle(page, /Elige tu hora/);
  let opts = await hourOptions(page);
  assert.ok(opts.length > 5, 'opciones: ' + opts);
  assert.ok(!opts.includes('12:00') && !opts.includes('12:30'), 'el bloqueo de 12:00-13:00 debe estar oculto: ' + opts);
  assert.ok(opts.includes('11:30') && opts.includes('13:00'), 'los bordes del bloqueo siguen libres: ' + opts);
  assert.ok(opts.every(o => /^\d\d:\d\d$/.test(o)));
  assert.ok(opts.every(o => (o >= '09:00' && o < '14:00') || (o >= '16:00' && o < '19:00')), 'todas dentro del horario: ' + opts);
  // reservar las 10:00 en un martes y volver a mirar ese día
  const day = nextWeekday(2, 8);
  await bookViaUi(page, { day, hour: '10:00', name: 'Pablo Gil', email: uniq('e03b'), phone: PHONE });
  await waitTitle(page, /Turno reservado/);
  const p2 = await newPage();
  await openBooking(p2); await fillPage1(p2, { day, name: 'Nuria Sanz', email: uniq('e03c'), phone: PHONE });
  await waitTitle(p2, /Elige tu hora/);
  opts = await hourOptions(p2);
  for (const h of ['09:30', '10:00', '10:30']) assert.ok(!opts.includes(h), `${h} debería estar oculta por el turno de las 10:00 y su descanso: ${opts}`);
  for (const h of ['09:00', '11:00']) assert.ok(opts.includes(h), `${h} debería seguir libre: ${opts}`);
});

await test('E04 teléfono no válido: aviso claro y los datos escritos se conservan', async () => {
  const page = await newPage(); const email = uniq('e04');
  await openBooking(page);
  await fillPage1(page, { day: nextWeekday(3, 9), name: 'Elena Mora', email, phone: '12ab' });
  await waitTitle(page, /Tus datos/);
  await page.waitForFunction(() => /teléfono no es válido/i.test(document.body.innerText));
  assert.equal(await page.$eval('#field-2', e => e.value), 'Elena Mora');
  assert.equal(await page.$eval('#field-3', e => e.value), email);
  assert.equal(await page.$eval('#field-4', e => e.value), '12ab');
  assert.equal(await page.$eval('#field-0', e => e.value), SVC_NAME, 'el servicio elegido se conserva');
  assert.equal(await page.$eval('#field-1', e => e.value), nextWeekday(3, 9), 'el día elegido se conserva');
  assert.equal((await bookingsOf(email)).length, 0);
  await shot(page, 'e04-telefono-invalido');
  // corrige y continúa
  await page.$eval('#field-4', e => { e.value = ''; }); await page.type('#field-4', PHONE);
  await page.click('input[type=checkbox]');
  await submit(page);
  await waitTitle(page, /Elige tu hora/);
});

await test('E05 sin aceptar la privacidad no se avanza', async () => {
  const page = await newPage();
  await openBooking(page);
  await fillPage1(page, { day: nextWeekday(3, 9), name: 'Sin Check', email: uniq('e05'), phone: PHONE, privacy: false });
  await sleep(1500);
  assert.match(await h1(page), /Tus datos/, 'debe seguir en la página 1');
  assert.equal((await q(`select count(*)::int n from bookings where customer_name='Sin Check'`))[0].n, 0);
});

await test('E06 CARRERA por el mismo hueco (A reserva, B tenía la lista vieja): B ve "Ese turno acaba de ocuparse", vuelve a elegir y NO pierde sus datos', async () => {
  const day = nextWeekday(4, 8);
  const [A, B] = [await newPage(), await newPage()];
  const [ea, eb] = [uniq('e06a'), uniq('e06b')];
  for (const [p, em, nm] of [[A, ea, 'Persona A'], [B, eb, 'Persona B']]) { await openBooking(p); await fillPage1(p, { day, name: nm, email: em, phone: PHONE }); await waitTitle(p, /Elige tu hora/); }
  assert.ok((await hourOptions(B)).includes('11:00'));
  await A.select('#field-0', '11:00'); await submit(A); await waitTitle(A, /Turno reservado/);
  await B.select('#field-0', '11:00'); await submit(B);
  await B.waitForFunction(() => /acaba de ocuparse/i.test(document.body.innerText));
  await shot(B, 'e06-turno-ocupado');
  assert.match(await h1(B), /Elige tu hora/);
  const opts = await hourOptions(B);
  assert.ok(!opts.includes('11:00'), '11:00 ya no debe ofrecerse: ' + opts);
  await B.select('#field-0', '09:00'); await submit(B);
  await waitTitle(B, /Turno reservado/);                       // sin volver a escribir nada
  const [bA, bB] = [(await bookingsOf(ea))[0], (await bookingsOf(eb))[0]];
  assert.equal(bA.customer_name, 'Persona A'); assert.equal(bB.customer_name, 'Persona B');
  assert.notEqual(bA.s, bB.s);
  assert.equal((await q(`select count(*)::int n from bookings where starts_at=$1 and status='confirmed'`, [bA.starts_at]))[0].n, 1);
});

await test('E07 CARRERA simultánea: 4 navegadores pulsan "Reservar" a la vez en el MISMO hueco → solo uno obtiene el turno', async () => {
  const day = nextWeekday(2, 15);
  const pages = await Promise.all([1, 2, 3, 4].map(() => newPage()));
  const emails = pages.map((_, i) => uniq('e07' + i));
  await Promise.all(pages.map(async (p, i) => { await openBooking(p); await fillPage1(p, { day, name: `Corredor ${i}`, email: emails[i], phone: PHONE }); await waitTitle(p, /Elige tu hora/); }));
  await Promise.all(pages.map(p => p.select('#field-0', '17:00')));
  await Promise.all(pages.map(p => p.click('#submit-btn')));
  await Promise.all(pages.map(p => p.waitForFunction(() => /Turno reservado|acaba de ocuparse/i.test(document.body.innerText) || /Turno reservado/i.test(document.title), { timeout: 30000 })));
  const winners = []; let losers = 0;
  for (const p of pages) { const t = await bodyText(p); if (/acaba de ocuparse/i.test(t)) losers++; else winners.push(p); }
  assert.equal(winners.length, 1, `ganadores: ${winners.length}`);
  assert.equal(losers, 3);
  const rows = await q(`select customer_email from bookings where service_id=(select id from services limit 1) and status='confirmed' and customer_email = any($1)`, [emails]);
  assert.equal(rows.length, 1, 'solo una reserva confirmada en BD: ' + JSON.stringify(rows));
});

await test('E08 día completo → propone los próximos días con huecos y permite continuar', async () => {
  const day = nextWeekday(1, 20);
  // llena el día por SQL (turnos de relleno)
  const svc = (await q('select id from services limit 1'))[0].id;
  let n = 0;
  for (;;) {
    const free = await q(`select iso_utc(slot_start) t from _available_slots($1, $2::date, now()) order by slot_start limit 1`, [svc, day]);
    if (!free.length) break;
    await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given) values ($1,'Relleno',$2,'600111222',$3,true)`, [svc, `relleno${n++}@x.com`, free[0].t]);
  }
  assert.ok(n >= 6);
  const page = await newPage();
  await openBooking(page);
  await fillPage1(page, { day, name: 'Rosa Lara', email: uniq('e08'), phone: PHONE });
  await waitTitle(page, /Ese día está completo/);
  await shot(page, 'e08-dia-completo');
  const opts = await page.$$eval('#field-0 option', os => os.map(o => o.value).filter(Boolean));
  assert.ok(opts.length >= 3, 'opciones de otros días: ' + opts);
  await page.select('#field-0', opts[0]); await submit(page);
  await waitTitle(page, /Elige tu hora/);
  assert.ok((await hourOptions(page)).length > 0);
});

await test('E09 una persona con turno futuro no puede reservar otro en el mismo servicio', async () => {
  const email = uniq('e09');
  const p1 = await newPage();
  await bookViaUi(p1, { day: nextWeekday(2, 22), hour: '13:00', name: 'Doble Turno', email, phone: PHONE });
  await waitTitle(p1, /Turno reservado/);
  const p2 = await newPage();
  await bookViaUi(p2, { day: nextWeekday(2, 22), hour: '13:30', name: 'Doble Turno', email: email.toUpperCase().replace('@EJEMPLO.COM', '@ejemplo.com'), phone: PHONE });
  await waitTitle(p2, /Ya tienes un turno reservado/);
  assert.equal((await bookingsOf(email.toLowerCase())).length, 1);
});

let cancelFlow = null;
await test('E10 cancelar desde el enlace del correo: formulario con el código ya puesto → "Turno cancelado" + correo con .ics de cancelación; el hueco se libera', async () => {
  const email = uniq('e10'); const day = nextWeekday(3, 12);
  const p1 = await newPage();
  await bookViaUi(p1, { day, hour: '16:30', name: 'Carla Vega', email, phone: PHONE });
  await waitTitle(p1, /Turno reservado/);
  const m = await waitMail(x => x.to.includes(email) && /confirmado/i.test(x.subject));
  const link = /href="([^"]*cancelar-turno\?codigo=[0-9a-f]{64})"/.exec(m.html)?.[1];
  assert.ok(link, 'el correo debe llevar el enlace de cancelación');
  const b = (await bookingsOf(email))[0];
  assert.ok(link.endsWith(b.management_code));
  // el hueco no se ofrece ahora
  const probe = await newPage(); await openBooking(probe); await fillPage1(probe, { day, name: 'Mirón', email: uniq('e10p'), phone: PHONE }); await waitTitle(probe, /Elige tu hora/);
  assert.ok(!(await hourOptions(probe)).includes('16:30'));
  // cancelar
  const page = await newPage();
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await waitTitle(page, /Cancelar turno/);
  assert.equal(await page.$eval('#field-0', e => e.value), b.management_code, 'el código viene rellenado');
  await submit(page);
  await waitTitle(page, /Turno cancelado/);
  await shot(page, 'e10-cancelado');
  assert.match(await bodyText(page), /Consulta de 30 minutos/);
  assert.equal((await bookingsOf(email))[0].status, 'cancelled');
  const mc = await waitMail(x => x.to.includes(email) && /cancelado/i.test(x.subject));
  assert.match(icsOf(mc).content, /STATUS:CANCELLED/); assert.match(icsOf(mc).content, new RegExp(`UID:${b.id}@turnos`)); assert.match(icsOf(mc).content, /SEQUENCE:1/);
  // el hueco vuelve a estar libre (y quien canceló puede reservar de nuevo)
  const probe2 = await newPage(); await openBooking(probe2); await fillPage1(probe2, { day, name: 'Mirón 2', email: uniq('e10q'), phone: PHONE }); await waitTitle(probe2, /Elige tu hora/);
  assert.ok((await hourOptions(probe2)).includes('16:30'), 'el hueco debe volver a ofrecerse');
  cancelFlow = { link, email };
});

await test('E11 cancelación con errores: código inválido y turno ya cancelado → mensajes claros SIN datos del turno', async () => {
  const page = await newPage();
  await page.goto(`${N8N}/form/cancelar-turno?codigo=${'a'.repeat(64)}`, { waitUntil: 'domcontentloaded' });
  await waitTitle(page, /Cancelar turno/); await submit(page);
  await waitTitle(page, /Código no válido/);
  assert.ok(!/Consulta|Carla|@/.test(await bodyText(page)));
  assert.ok(cancelFlow, 'depende de E10');
  const p2 = await newPage();
  await p2.goto(cancelFlow.link, { waitUntil: 'domcontentloaded' }); await waitTitle(p2, /Cancelar turno/); await submit(p2);
  await waitTitle(p2, /ya no se puede cancelar/i);
  assert.ok(!/Consulta|Carla|16:30/.test(await bodyText(p2)));
  const p3 = await newPage();
  await p3.goto(`${N8N}/form/cancelar-turno?codigo=corto`, { waitUntil: 'domcontentloaded' }); await submit(p3);
  await waitTitle(p3, /Código no válido/);
});

await test('E12 fuera de plazo (< X horas) no se puede cancelar', async () => {
  const svc = (await q('select id from services limit 1'))[0].id;
  // turno dentro de 60 min (insertado a mano; X = 2 h)
  const code = 'b'.repeat(64);
  await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,management_code)
           values ($1,'Tarde','tarde@x.com','600111222', date_trunc('minute', now()) + interval '60 minutes', true, $2)`, [svc, code]);
  const page = await newPage();
  await page.goto(`${N8N}/form/cancelar-turno?codigo=${code}`, { waitUntil: 'domcontentloaded' }); await submit(page);
  await waitTitle(page, /Fuera de plazo/);
  assert.match(await bodyText(page), /al menos 2 horas/);
  assert.equal((await q(`select status from bookings where management_code=$1`, [code]))[0].status, 'confirmed');
});

await test('E13 si el correo FALLA la reserva no se pierde: se registra en email_log y se avisa en pantalla (con el enlace de gestión)', async () => {
  const email = uniq('e13'); const flag = path.join(WORK, 'smtp-fail');
  fs.writeFileSync(flag, '1');
  try {
    const page = await newPage();
    await bookViaUi(page, { day: nextWeekday(4, 16), hour: '12:00', name: 'Sin Correo', email, phone: PHONE });
    await waitTitle(page, /Turno reservado/, 40000);
    const txt = await bodyText(page);
    assert.match(txt, /No hemos podido enviarte el correo/);
    assert.match(txt, /cancelar-turno\?codigo=[0-9a-f]{64}/, 'debe mostrar el enlace de gestión');
    await shot(page, 'e13-correo-fallido');
    const b = (await bookingsOf(email))[0];
    assert.equal(b.status, 'confirmed');
    const log = await q(`select kind,status,to_email,error from email_log where booking_id=$1 and kind='confirmation'`, [b.id]);
    assert.equal(log.length, 1); assert.deepEqual([log[0].kind, log[0].status, log[0].to_email], ['confirmation', 'failed', email]);
    assert.ok(log[0].error && log[0].error.length > 3);
  } finally { fs.rmSync(flag, { force: true }); }
  // con el correo restablecido, un nuevo turno registra "sent"
  const email2 = uniq('e13b'); const p2 = await newPage();
  await bookViaUi(p2, { day: nextWeekday(4, 16), hour: '12:30', name: 'Con Correo', email: email2, phone: PHONE });
  await waitTitle(p2, /Turno reservado/);
  const b2 = (await bookingsOf(email2))[0];
  const log2 = await q(`select status from email_log where booking_id=$1 and kind='confirmation'`, [b2.id]);
  assert.deepEqual(log2.map(x => x.status), ['sent']);
});

// Requiere workflows generados con `--wait-minutes 0.5` y N8N_DB=<ruta a database.sqlite de n8n>
await test('E14 formularios ABANDONADOS (página 1 y página de horas): al vencer la espera la ejecución termina sola; no queda nada "en espera" con datos personales y no se crea ninguna reserva', async () => {
  if (!process.env.N8N_DB) throw new Error('define N8N_DB (ruta a database.sqlite de n8n) y genera los workflows con --wait-minutes 0.5');
  const n8nDb = new DatabaseSync(process.env.N8N_DB, { readOnly: true });
  const execId = (page) => Number(/form-waiting\/(\d+)/.exec(page.url())?.[1]);
  const status = (id) => n8nDb.prepare('select status from execution_entity where id=?').get(id)?.status;
  const email = uniq('e16');
  const A = await newPage(); await openBooking(A);                                           // abandona en la página 1
  const B = await newPage(); await openBooking(B);                                           // abandona en la página de horas
  await fillPage1(B, { day: nextWeekday(2, 6), name: 'Abandono Prueba', email, phone: PHONE }); await waitTitle(B, /Elige tu hora/);
  const [ida, idb] = [execId(A), execId(B)];
  assert.ok(ida > 0 && idb > 0, `ids de ejecución: ${ida} ${idb} (${A.url()})`);
  assert.equal(status(ida), 'waiting'); assert.equal(status(idb), 'waiting');
  const t0 = Date.now();
  while (Date.now() - t0 < 200000 && (status(ida) === 'waiting' || status(idb) === 'waiting')) await sleep(3000);
  console.log(`      (las dos ejecuciones dejaron de esperar a los ${Math.round((Date.now() - t0) / 1000)} s)`);
  assert.equal(status(ida), 'success'); assert.equal(status(idb), 'success');
  assert.equal((await bookingsOf(email)).length, 0, 'no debe haberse creado ninguna reserva');
  n8nDb.close();
});

// ============================================================
// FASE 2
// ============================================================
await test('E17 al RESERVAR llega el aviso inmediato a quien atiende con los datos correctos (sin el código secreto), tras la confirmación a la persona, que ahora trae el enlace para cambiar la hora', async () => {
  const email = uniq('e17'); const day = nextWeekday(5, 21);
  const page = await newPage();
  await bookViaUi(page, { day, hour: '09:00', name: 'Irene Soler', email, phone: '+34 611 222 333' });
  await waitTitle(page, /Turno reservado/);
  const aviso = await waitMail(m => m.to.includes(STAFF) && /Nueva reserva/.test(m.subject) && m.text.includes(email));
  assert.equal(aviso.subject, `[Turnos] Nueva reserva: ${SVC_NAME} · ${dmy(day)} 09:00 · Irene Soler`);
  for (const t of ['Irene Soler', '+34 611 222 333', email, SVC_NAME, fechaLarga(day), '09:00']) assert.ok(aviso.text.includes(t), `falta "${t}" en el aviso:\n${aviso.text}`);
  assert.ok(!/[0-9a-f]{64}/.test(aviso.text + aviso.html), 'el aviso a quien atiende NO debe llevar el código secreto de gestión');
  const conf = await waitMail(m => m.to.includes(email) && /confirmado/i.test(m.subject));
  assert.ok(conf.n < aviso.n, 'primero la confirmación a la persona y después el aviso al personal');
  assert.match(conf.html, /cambiar-turno\?codigo=[0-9a-f]{64}/); assert.match(conf.text, /Cámbiala aquí/); assert.match(conf.html, /cancelar-turno\?codigo=[0-9a-f]{64}/);
  const b = (await bookingsOf(email))[0];
  const log = await q(`select kind,status,to_email from email_log where booking_id=$1 order by id`, [b.id]);
  assert.deepEqual(log.map(l => [l.kind, l.status, l.to_email]), [['confirmation', 'sent', email], ['staff_booking', 'sent', STAFF]]);
  assert.equal(mailsTo(STAFF, /Nueva reserva/).filter(m => m.text.includes(email)).length, 1, 'un solo aviso');
});

await test('E18 al CANCELAR llega el aviso a quien atiende con los datos correctos; la cancelación lleva SEQUENCE:1', async () => {
  const email = uniq('e18'); const day = nextWeekday(5, 21);
  const page = await newPage();
  await bookViaUi(page, { day, hour: '10:00', name: 'Hugo Pardo', email, phone: '+34 622 333 444' });
  await waitTitle(page, /Turno reservado/);
  const m = await waitMail(x => x.to.includes(email) && /confirmado/i.test(x.subject));
  const link = /href="([^"]*cancelar-turno\?codigo=[0-9a-f]{64})"/.exec(m.html)[1];
  const p2 = await newPage();
  await p2.goto(link, { waitUntil: 'domcontentloaded' }); await waitTitle(p2, /Cancelar turno/); await submit(p2);
  await waitTitle(p2, /Turno cancelado/);
  const aviso = await waitMail(x => x.to.includes(STAFF) && /Turno cancelado/.test(x.subject) && x.text.includes(email));
  assert.equal(aviso.subject, `[Turnos] Turno cancelado: ${SVC_NAME} · ${dmy(day)} 10:00 · Hugo Pardo`);
  for (const t of ['Hugo Pardo', '+34 622 333 444', email, SVC_NAME, fechaLarga(day), '10:00', 'El hueco ha quedado libre']) assert.ok(aviso.text.includes(t), `falta "${t}":\n${aviso.text}`);
  const b = (await bookingsOf(email))[0];
  assert.equal(b.status, 'cancelled');
  assert.match(icsOf(await waitMail(x => x.to.includes(email) && /cancelado/i.test(x.subject))).content, /SEQUENCE:1/);
  const log = await q(`select kind,status from email_log where booking_id=$1 order by id`, [b.id]);
  assert.deepEqual(log.map(l => [l.kind, l.status]), [['confirmation', 'sent'], ['staff_booking', 'sent'], ['cancellation', 'sent'], ['staff_cancellation', 'sent']]);
  cancelledForE21 = b.management_code;
});

await test('E19 CAMBIO DE HORA en el mismo día (10:00 → 10:30) por el formulario: ve las horas libres con la misma disponibilidad (su propio hueco cuenta como libre), la fila se actualiza, correo con .ics actualizado y aviso con hora antigua y nueva', async () => {
  const email = uniq('e19'); const day = nextWeekday(3, 10);
  const b = await sqlBooking({ day, time: '10:00', email, name: 'Marta Ríos' });
  const page = await newPage();
  await page.goto(b.link, { waitUntil: 'domcontentloaded' }); await waitTitle(page, /Cambiar la hora de tu turno/);
  assert.equal(await page.$eval('#field-0', e => e.value), b.management_code, 'el código viene rellenado desde el enlace');
  await submit(page);
  await waitTitle(page, /Elige el nuevo día/);
  const txt = await bodyText(page);
  assert.ok(txt.includes(fechaLarga(day)) && txt.includes('10:00'), 'muestra el turno actual: ' + txt);
  assert.equal(await page.$eval('#field-0', e => e.value), day, 'el día actual viene propuesto');
  await submit(page);
  await waitTitle(page, /Elige tu nueva hora/);
  const opts = await hourOptions(page);
  assert.ok(!opts.includes('10:00'), 'su hora actual no se ofrece: ' + opts);
  for (const h of ['09:00', '09:30', '10:30', '11:00']) assert.ok(opts.includes(h), `${h} debe poder elegirse (el descanso del propio turno no le bloquea): ${opts}`);
  assert.match(await bodyText(page), /sigue reservado/);
  await shot(page, 'e19-cambio-horas');
  await page.select('#field-0', '10:30'); await submit(page);
  await waitTitle(page, /Hora cambiada/);
  await shot(page, 'e19-hora-cambiada');
  assert.match(await bodyText(page), /10:30/);
  const row = (await q(`select id, status, ics_sequence, iso_utc(starts_at) s, rescheduled_at, to_char(starts_at at time zone 'Europe/Madrid','HH24:MI') lt from bookings where customer_email=$1`, [email]));
  assert.equal(row.length, 1, 'sigue habiendo UNA sola fila'); assert.equal(row[0].id, b.id);
  assert.deepEqual([row[0].lt, row[0].status, row[0].ics_sequence], ['10:30', 'confirmed', 1]); assert.ok(row[0].rescheduled_at);
  const m = await waitMail(x => x.to.includes(email) && /Hora cambiada/.test(x.subject));
  assert.equal(m.subject, `Hora cambiada: ${SVC_NAME} · ${dmy(day)} 10:30`);
  assert.match(m.text, /Antes: .* a las 10:00/); assert.match(m.text, /Ahora: .* a las 10:30/);
  const ics = icsOf(m);
  const ev = new ICAL.Event(new ICAL.Component(ICAL.parse(ics.content)).getFirstSubcomponent('vevent'));
  assert.equal(ev.uid, `${b.id}@turnos`, 'MISMO UID que el evento original: el calendario lo sustituye');
  assert.equal(ev.startDate.toJSDate().toISOString(), new Date(row[0].s).toISOString());
  assert.match(ics.content, /SEQUENCE:1/); assert.match(ics.content, /STATUS:CONFIRMED/); assert.ok(ics.content.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
  const aviso = await waitMail(x => x.to.includes(STAFF) && /Cambio de hora/.test(x.subject) && x.text.includes(email));
  assert.equal(aviso.subject, `[Turnos] Cambio de hora: ${SVC_NAME} · ${dmy(day)} 10:00 → ${dmy(day)} 10:30 · Marta Ríos`);
  assert.match(aviso.text, /Antes: .* a las 10:00/); assert.match(aviso.text, /Ahora: .* a las 10:30/); assert.ok(aviso.text.includes('Marta Ríos') && aviso.text.includes('+34 600 000 111'));
  const log = await q(`select kind,status from email_log where booking_id=$1 order by id`, [b.id]);
  assert.deepEqual(log.map(l => [l.kind, l.status]), [['reschedule', 'sent'], ['staff_reschedule', 'sent']]);
});

await test('E20 CAMBIO DE HORA a otro día: el hueco antiguo se libera, el nuevo se ocupa; la cancelación posterior sustituye al evento (SEQUENCE:2 > 1)', async () => {
  const email = uniq('e20'); const from = nextWeekday(1, 12), to = nextWeekday(5, 22);
  const b = await sqlBooking({ day: from, time: '09:00', email, name: 'Pilar Vera' });
  const page = await newPage();
  await openReschedule(page, b.link);
  await pickDay(page, to);
  assert.match(await h1(page), /Elige tu nueva hora/);
  await page.select('#field-0', '11:30'); await submit(page);
  await waitTitle(page, /Hora cambiada/);
  const r = (await q(`select iso_utc(starts_at) s, to_char(starts_at at time zone 'Europe/Madrid','YYYY-MM-DD HH24:MI') l, ics_sequence from bookings where id=$1`, [b.id]))[0];
  assert.deepEqual([r.l, r.ics_sequence], [`${to} 11:30`, 1]);
  const svc = await svcId();
  const oldFree = await q(`select to_char(slot_start at time zone 'Europe/Madrid','HH24:MI') h from _available_slots($1,$2::date,now())`, [svc, from]);
  assert.ok(oldFree.some(x => x.h === '09:00'), 'el hueco antiguo ha quedado libre');
  const newFree = await q(`select to_char(slot_start at time zone 'Europe/Madrid','HH24:MI') h from _available_slots($1,$2::date,now())`, [svc, to]);
  assert.ok(!newFree.some(x => x.h === '11:30'), 'el hueco nuevo está ocupado');
  const m = await waitMail(x => x.to.includes(email) && /Hora cambiada/.test(x.subject));
  assert.match(icsOf(m).content, new RegExp('DTSTART:' + r.s.replace(/[-:]/g, '')));
  // cancelar con el enlace del correo de cambio
  const link = /href="([^"]*cancelar-turno\?codigo=[0-9a-f]{64})"/.exec(m.html)[1];
  const p2 = await newPage(); await p2.goto(link, { waitUntil: 'domcontentloaded' }); await waitTitle(p2, /Cancelar turno/); await submit(p2);
  await waitTitle(p2, /Turno cancelado/);
  const c = await waitMail(x => x.to.includes(email) && /cancelado/i.test(x.subject));
  assert.match(icsOf(c).content, /SEQUENCE:2/); assert.match(icsOf(c).content, /STATUS:CANCELLED/); assert.match(icsOf(c).content, new RegExp(`UID:${b.id}@turnos`));
});

await test('E21 CAMBIO FALLIDO FORZADO: otra persona ocupa la hora elegida mientras se decide -> "Esa hora acaba de ocuparse", el turno original NO se toca ni se libera, no sale ningún correo; al elegir otra hora sí se cambia', async () => {
  const email = uniq('e21'); const original = nextWeekday(2, 6), D = nextWeekday(4, 22);
  const b = await sqlBooking({ day: original, time: '09:00', email, name: 'Víctima Cambio' });
  const page = await newPage();
  await openReschedule(page, b.link);
  await pickDay(page, D);
  assert.ok((await hourOptions(page)).includes('16:00'), 'la hora aparece libre en la lista');
  await sqlBooking({ day: D, time: '16:00', email: uniq('e21x'), name: 'Intruso' });         // otra persona la ocupa ahora mismo
  const antes = await rowJson(b.id);
  const mailsAntes = mails().length;
  await page.select('#field-0', '16:00'); await submit(page);
  await page.waitForFunction(() => /acaba de ocuparse/i.test(document.body.innerText));
  await shot(page, 'e21-hora-ocupada');
  assert.match(await h1(page), /Elige tu nueva hora/);
  assert.match(await bodyText(page), /tu turno actual sigue reservado/i);
  assert.deepEqual(await rowJson(b.id), antes, 'el turno original está EXACTAMENTE igual que antes del intento');
  const svc = await svcId();
  assert.ok(!(await q(`select to_char(slot_start at time zone 'Europe/Madrid','HH24:MI') h from _available_slots($1,$2::date,now())`, [svc, original])).some(x => x.h === '09:00'), 'su hueco original sigue ocupado (no se liberó)');
  assert.equal(mails().filter(x => x.to.includes(email) || (x.to.includes(STAFF) && x.text.includes(email))).length, 0, 'no sale ningún correo por un cambio fallido');
  assert.ok(!(await hourOptions(page)).includes('16:00'));
  assert.equal((await q(`select count(*)::int n from email_log where booking_id=$1`, [b.id]))[0].n, 0);
  await page.select('#field-0', '18:00'); await submit(page);                                 // elige otra y sin volver a escribir nada
  await waitTitle(page, /Hora cambiada/);
  assert.equal((await q(`select to_char(starts_at at time zone 'Europe/Madrid','YYYY-MM-DD HH24:MI') l from bookings where id=$1`, [b.id]))[0].l, `${D} 18:00`);
  assert.ok(mails().length > mailsAntes);
});

await test('E22 cambios que NO se pueden hacer: código inválido, turno cancelado y fuera de plazo -> mensajes claros, sin datos, sin tocar nada y sin avisos', async () => {
  const staffAntes = mailsTo(STAFF, /Cambio de hora/).length;
  const p1 = await newPage();
  await p1.goto(`${N8N}/form/cambiar-turno?codigo=${'a'.repeat(64)}`, { waitUntil: 'domcontentloaded' }); await waitTitle(p1, /Cambiar la hora de tu turno/); await submit(p1);
  await waitTitle(p1, /Código no válido/); assert.ok(!/Consulta|@/.test(await bodyText(p1)));
  assert.ok(cancelledForE21, 'depende de E18');
  const p2 = await newPage();
  await p2.goto(`${N8N}/form/cambiar-turno?codigo=${cancelledForE21}`, { waitUntil: 'domcontentloaded' }); await waitTitle(p2, /Cambiar la hora de tu turno/); await submit(p2);
  await waitTitle(p2, /ya no se puede cambiar/i); assert.ok(!/Hugo|@/.test(await bodyText(p2)));
  // dentro de 60 min (X = 2 h): fuera de plazo
  const code = 'c'.repeat(64);
  const plazoSvc = (await q(`insert into services(name,duration_minutes,break_minutes,active) values ('Servicio plazo (prueba)',30,0,true) on conflict (name) do update set active=excluded.active returning id`))[0].id;   // propio: no choca con el turno de E12
  await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,management_code)
           values ($1,'Tarde Cambio','tardecambio@x.com','600111222', date_trunc('minute', now()) + interval '75 minutes', true, $2)`, [plazoSvc, code]);
  const antes = await rowJson((await q(`select id from bookings where management_code=$1`, [code]))[0].id);
  const p3 = await newPage();
  await p3.goto(`${N8N}/form/cambiar-turno?codigo=${code}`, { waitUntil: 'domcontentloaded' }); await waitTitle(p3, /Cambiar la hora de tu turno/); await submit(p3);
  await waitTitle(p3, /Fuera de plazo/); assert.match(await bodyText(p3), /al menos 2 horas/);
  await shot(p3, 'e22-fuera-de-plazo');
  assert.deepEqual(await rowJson(antes.id), antes);
  assert.equal(mailsTo(STAFF, /Cambio de hora/).length, staffAntes, 'ningún aviso de cambio');
});

// ---------- Recordatorios (workflow 04, cada minuto en estas pruebas, con un GEMELO que se dispara en el MISMO segundo) ----------
let rsvc = null;
const mkRem = async (email, offsetMin, o = {}) => (await q(
  `insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,created_at,status,rescheduled_at)
   values ($1,$2,$3,'+34 600 555 000', date_trunc('minute', now()) + ($4 || ' minutes')::interval, true, now() - interval '3 days', $5, $6) returning id, management_code`,
  [rsvc, o.name ?? 'Cliente Recordatorio', email, String(offsetMin), o.status ?? 'confirmed', o.rescheduledAgoMin ? new Date(Date.now() - o.rescheduledAgoMin * 60000).toISOString() : null]))[0];
const countRem = (email, re) => mails().filter(m => m.to.includes(email) && re.test(m.subject)).length;

await test('E23 RECORDATORIOS: 24 h y 1 h salen UNA sola vez aunque el workflow se dispare DOS veces a la vez; nada para cancelados, reservados con < 24 h, cambiados con < 24 h ni turnos aún no llegados', async () => {
  rsvc = (await q(`insert into services(name,duration_minutes,break_minutes,active) values ('Servicio recordatorios (prueba)',1,0,false) on conflict (name) do update set active=excluded.active returning id`))[0].id;   // 1 min de duración: los turnos de prueba no se solapan
  const E = { a: uniq('r24a'), b: uniq('r24b'), c: uniq('r1h'), x: uniq('rcancel'), corto: uniq('rcorto'), mov: uniq('rmov'), lejos: uniq('rlejos') };
  const A = await mkRem(E.a, 23 * 60 + 50), B = await mkRem(E.b, 23 * 60 + 45), C = await mkRem(E.c, 50);
  await mkRem(E.x, 23 * 60 + 40, { status: 'cancelled' });
  const short = await mkRem(E.corto, 23 * 60 + 30); await q(`update bookings set created_at = now() - interval '10 minutes' where id=$1`, [short.id]);   // reservado con 23 h 20 min de margen (< 24 h)
  await mkRem(E.mov, 23 * 60 + 20, { rescheduledAgoMin: 10 });                                                                                          // cambiado hace 10 min -> con 23 h 10 min de margen (< 24 h)
  await mkRem(E.lejos, 30 * 60);                                                                                                                       // aún no toca
  const t0 = Date.now();
  for (const [em, re] of [[E.a, /Recordatorio/], [E.b, /Recordatorio/], [E.c, /en 1 hora/]]) await waitMail(m => m.to.includes(em) && re.test(m.subject), 150000);
  console.log(`      (los 3 recordatorios llegaron a los ${Math.round((Date.now() - t0) / 1000)} s)`);
  await sleep(75000);        // otra pasada completa de los dos workflows
  assert.equal(countRem(E.a, /Recordatorio/), 1); assert.equal(countRem(E.b, /Recordatorio/), 1); assert.equal(countRem(E.c, /en 1 hora/), 1);
  assert.equal(countRem(E.c, /Recordatorio/), 0, 'al de 1 h no le toca el de 24 h');
  for (const k of ['x', 'corto', 'mov', 'lejos']) assert.equal(mails().filter(m => m.to.includes(E[k])).length, 0, `${k} no debe recibir nada`);
  const ma = mails().find(m => m.to.includes(E.a));
  assert.ok(ma.text.includes('Cliente Recordatorio') && ma.text.includes('Servicio recordatorios (prueba)') && /cancelar-turno\?codigo=[0-9a-f]{64}/.test(ma.text) && /cambiar-turno\?codigo=[0-9a-f]{64}/.test(ma.text));
  const mc = mails().find(m => m.to.includes(E.c)); assert.ok(!/cancelar-turno/.test(mc.text), 'el de 1 h no ofrece cancelar');
  const st = async (id) => (await q(`select reminder_24h_sent_at a, reminder_1h_sent_at b, reminder_24h_attempts a24, reminder_1h_attempts a1 from bookings where id=$1`, [id]))[0];
  assert.ok((await st(A.id)).a && (await st(B.id)).a && !(await st(A.id)).b); assert.ok((await st(C.id)).b && !(await st(C.id)).a);
  assert.deepEqual([(await st(A.id)).a24, (await st(C.id)).a1], [1, 1], 'un solo intento cada uno');
  const log = await q(`select kind,status,count(*)::int n from email_log where booking_id = any($1) group by 1,2 order by 1`, [[A.id, B.id, C.id]]);
  assert.deepEqual(log.map(l => [l.kind, l.status, l.n]), [['reminder_1h', 'sent', 1], ['reminder_24h', 'sent', 2]]);
  // las dos instancias se dispararon de verdad en el mismo minuto (n8n guarda sus ejecuciones en esta prueba)
  if (process.env.N8N_DB) {
    const db2 = new DatabaseSync(process.env.N8N_DB, { readOnly: true });
    const ex = db2.prepare(`select workflowId w, status, startedAt s from execution_entity where workflowId in ('turnosRecordatorios1','turnosRecordatorios2') and startedAt >= ? order by startedAt`).all(new Date(t0 - 90000).toISOString().replace('T', ' ').replace('Z', ''));
    db2.close();
    const byMinute = {}; for (const e of ex) (byMinute[e.s.slice(0, 16)] ??= new Set()).add(e.w);
    assert.ok(Object.values(byMinute).some(s => s.size === 2), 'ninguna pasada se ejecutó en las dos instancias a la vez: ' + JSON.stringify(ex));
    assert.ok(ex.every(e => e.status === 'success'), 'todas las ejecuciones deben terminar bien: ' + JSON.stringify(ex.filter(e => e.status !== 'success')));
    console.log(`      (${ex.length} ejecuciones de las dos instancias en la ventana; minutos con las DOS a la vez: ${Object.values(byMinute).filter(s => s.size === 2).length})`);
  }
});

await test('E24 RECORDATORIOS con fallo de envío: queda en email_log, se reintenta en la pasada siguiente SIN duplicar y llega una sola vez; tras 3 fallos se rinde y avisa al administrador (sin datos personales)', async () => {
  const flag = path.join(WORK, 'smtp-fail');
  const F = uniq('rfail'), G = uniq('rgave');
  const bf = await mkRem(F, 23 * 60 + 55), bg = await mkRem(G, 23 * 60 + 56);
  fs.writeFileSync(flag, `${F}\n${G}\n`);      // solo fallan los correos a estas dos personas (el resto, incluido el administrador, sale)
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 150000 && (await q(`select count(*)::int n from email_log where booking_id=$1 and status='failed'`, [bf.id]))[0].n < 1) await sleep(1500);
    const s1 = (await q(`select reminder_24h_sent_at s, reminder_24h_attempts a from bookings where id=$1`, [bf.id]))[0];
    assert.equal(s1.s, null, 'tras el fallo el reclamo se libera (para poder reintentar)'); assert.ok(s1.a >= 1);
    const fl = (await q(`select kind, error from email_log where booking_id=$1 and status='failed' order by id limit 1`, [bf.id]))[0];
    assert.equal(fl.kind, 'reminder_24h'); assert.ok(fl.error && fl.error.length > 3, 'el motivo del fallo queda anotado: ' + fl.error);
    assert.equal(countRem(F, /Recordatorio/), 0);
    fs.writeFileSync(flag, `${G}\n`);          // F se recupera; G sigue fallando
    await waitMail(m => m.to.includes(F) && /Recordatorio/.test(m.subject), 150000);
    // G agota sus 3 intentos y se avisa al administrador
    const adm = await waitMail(m => m.to.includes(ADMIN) && /Un recordatorio no se pudo enviar/.test(m.subject) && m.text.includes(bg.id), 240000);
    assert.ok(!adm.text.includes(G) && !adm.text.includes('Cliente Recordatorio'), 'el aviso al administrador no lleva datos personales');
    assert.match(adm.text, /3 veces/);
  } finally { fs.rmSync(flag, { force: true }); }
  await sleep(75000);          // dos pasadas más: nadie vuelve a enviar nada
  assert.equal(countRem(F, /Recordatorio/), 1, 'F: exactamente un recordatorio, pese al fallo previo');
  assert.equal(countRem(G, /Recordatorio/), 0, 'G: ninguno (se rindió)');
  const lf = await q(`select status, count(*)::int n from email_log where booking_id=$1 group by 1 order by 1`, [bf.id]);
  assert.ok(lf.find(x => x.status === 'sent').n === 1 && lf.find(x => x.status === 'failed').n >= 1, JSON.stringify(lf));
  const g = (await q(`select reminder_24h_sent_at s, reminder_24h_attempts a from bookings where id=$1`, [bg.id]))[0];
  assert.deepEqual([g.s, g.a], [null, 3]);
  assert.equal((await q(`select count(*)::int n from email_log where booking_id=$1 and status='failed'`, [bg.id]))[0].n, 3);
});

// ---------- Resumen diario (workflow 05) ----------
await test('E25 RESUMEN DIARIO: no sale antes de la hora configurada; a la hora llega UN correo (aunque haya dos workflows a la vez) con los turnos de hoy ordenados por hora y los datos correctos; sin turnos, un aviso breve', async () => {
  const today = (await q(`select (now() at time zone 'Europe/Madrid')::date::text d`))[0].d;
  const nowLocal = (await q(`select to_char(now() at time zone 'Europe/Madrid','HH24:MI') t`))[0].t;
  const localToday = `(now() at time zone 'Europe/Madrid')::date`;
  // limpio el día: nada confirmado hoy
  await q(`update bookings set status='cancelled' where (starts_at at time zone 'Europe/Madrid')::date = ${localToday}`);
  await q(`delete from daily_summary_log`);
  // 1) antes de la hora: nada
  const previos = mailsTo(STAFF, /Agenda de hoy/).length;
  if (nowLocal < '23:57') {
    await q(`update settings set value='23:59' where key='daily_summary_time'`);
    await sleep(75000);
    assert.equal(mailsTo(STAFF, /Agenda de hoy/).length, previos, 'antes de la hora configurada no se envía');
  }
  // 2) a la hora, sin turnos: aviso breve, una sola vez
  await q(`update settings set value='00:00' where key='daily_summary_time'`);
  const vacio = await waitMail(m => m.to.includes(STAFF) && /Agenda de hoy/.test(m.subject) && /sin turnos/.test(m.subject), 150000);
  assert.equal(vacio.subject, `[Turnos] Agenda de hoy · ${dmy(today)} · sin turnos`);
  assert.match(vacio.text, /no hay ningún turno confirmado/);
  await sleep(75000);
  assert.equal(mailsTo(STAFF, /Agenda de hoy/).length, previos + 1, 'un solo resumen aunque se ejecutaron dos workflows a la vez');
  assert.equal((await q(`select status from daily_summary_log where day=${localToday}`))[0].status, 'sent');
  // 3) otro día lógico (borro la marca): ahora con turnos desordenados, uno cancelado, uno de mañana y uno ya asistido
  await q(`delete from daily_summary_log`);
  const ssvc = (await q(`insert into services(name,duration_minutes,break_minutes,active) values ('Servicio resumen (prueba)',1,0,false) on conflict (name) do update set active=excluded.active returning id`))[0].id;
  const at2 = async (time, email, name, status = 'confirmed', svc = ssvc, dayExpr = localToday) => (await q(
    `insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,status)
     values ($1,$2,$3,$4, (${dayExpr} + $5::time) at time zone 'Europe/Madrid', true, $6) returning id`, [svc, name, email, '+34 600 777 ' + time.replace(':', ''), time, status]))[0];
  await at2('15:00', 'tarde@resumen.test', 'Tarde Tercera');
  await at2('09:30', 'primera@resumen.test', 'Primera Hora');
  await at2('12:00', 'media@resumen.test', 'Segunda Media');
  await at2('10:00', 'cancelada@resumen.test', 'No Debe Salir', 'cancelled');
  await at2('11:00', 'asistida@resumen.test', 'Tampoco Sale', 'attended');
  await at2('09:00', 'manana@resumen.test', 'De Mañana', 'confirmed', ssvc, `${localToday} + 1`);
  const r = await waitMail(m => m.to.includes(STAFF) && /Agenda de hoy/.test(m.subject) && /3 turnos/.test(m.subject), 150000);
  assert.equal(r.subject, `[Turnos] Agenda de hoy · ${dmy(today)} · 3 turnos`);
  const lines = r.text.split('\n').filter(l => /^\d\d:\d\d /.test(l));
  assert.deepEqual(lines, [
    '09:30  Servicio resumen (prueba) · Primera Hora · +34 600 777 0930 · primera@resumen.test',
    '12:00  Servicio resumen (prueba) · Segunda Media · +34 600 777 1200 · media@resumen.test',
    '15:00  Servicio resumen (prueba) · Tarde Tercera · +34 600 777 1500 · tarde@resumen.test']);
  assert.ok(!/No Debe Salir|Tampoco Sale|De Mañana/.test(r.text + r.html));
  assert.ok(r.html.indexOf('Primera Hora') < r.html.indexOf('Segunda Media') && r.html.indexOf('Segunda Media') < r.html.indexOf('Tarde Tercera'));
  await shot(await (async () => { const p = await newPage(); await p.setContent(r.html); return p; })(), 'e25-resumen-diario');
  await sleep(75000);
  assert.equal(mailsTo(STAFF, /Agenda de hoy/).filter(m => /3 turnos/.test(m.subject)).length, 1, 'el resumen con turnos tampoco se duplica');
  // 4) fallo de envío: se reintenta en la pasada siguiente y llega una vez
  await q(`delete from daily_summary_log`);
  const flag = path.join(WORK, 'smtp-fail'); fs.writeFileSync(flag, `${STAFF}\n`);
  const before = mailsTo(STAFF, /Agenda de hoy/).length;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 150000 && (await q(`select count(*)::int n from email_log where kind='daily_summary' and status='failed'`))[0].n < 1) await sleep(1500);
    assert.equal((await q(`select status from daily_summary_log where day=${localToday}`))[0].status, 'retry');
  } finally { fs.rmSync(flag, { force: true }); }
  for (let t0 = Date.now(); mailsTo(STAFF, /Agenda de hoy/).length <= before; await sleep(1500)) if (Date.now() - t0 > 150000) throw new Error('no llegó el resumen reintentado');
  await sleep(75000);
  assert.equal(mailsTo(STAFF, /Agenda de hoy/).length, before + 1, 'tras el fallo llega exactamente un resumen más');
  const lg = await q(`select status, count(*)::int n from email_log where kind='daily_summary' group by 1 order by 1`);
  assert.ok(lg.find(x => x.status === 'failed').n >= 1 && lg.find(x => x.status === 'sent').n === 3, JSON.stringify(lg));
  await q(`update settings set value='08:00' where key='daily_summary_time'`);
});

// ============================================================
// FASE 3 · enlaces cortos, formulario de creación, estadísticas y bloqueos
//   (los workflows 06 y 07 reales, n8n real, Chrome real; el dominio corto se sustituye por la URL del webhook:
//    https://l.rocketnova.io/<slug>  <->  <n8n>/webhook/<webhookId>/<slug>, que es lo que hace el proxy del dominio)
// ============================================================
const WH = '6f1d2c4e-0a7b-4c1e-9d55-7a3e5b9c1f06';                 // webhookId fijo del workflow 06
const shortUrl = (slug) => `${N8N}/webhook/${WH}/${slug}`;
const BOOKING_FORM = `${N8N}/form/reservar-turno`;
const DEF_URL = 'https://rocketnova.io';
const UA_HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 Instagram 300.0';
const hit = (slug, ua = UA_HUMAN, method = 'GET') => fetch(shortUrl(slug), { method, redirect: 'manual', headers: { 'user-agent': ua } });
const clicksOf = async (slug) => Number((await q(`select click_count from links where slug=$1`, [slug]))[0]?.click_count ?? -1);
async function waitClicks(slug, n, ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await clicksOf(slug) === n) return; await sleep(200); }
  throw new Error(`el contador de ${slug} debería ser ${n} y es ${await clicksOf(slug)}`);
}
const mkShort = async (slug, dest = BOOKING_FORM, ch = null) => {
  await q(`delete from links where slug=$1`, [slug]);       // por si se repite una prueba suelta sobre la misma base de datos
  const r = (await q(`select create_link($1,$2,$3) as r`, [slug, dest, ch]))[0].r;
  assert.equal(r.ok, true, JSON.stringify(r)); return r;
};
const apiGet = (p, key = stack.serviceRoleKey) => fetch(stack.api + '/rest/v1/' + p, { headers: { apikey: key, Authorization: `Bearer ${key}` } });

await test('E26 UN CLIC CUENTA UNA SOLA VEZ y redirige con 302 al destino + ?origen=<slug> (sin caché); el slug no distingue mayúsculas; las visitas suman una a una, también 10 a la vez', async () => {
  await mkShort('e2e-ig');
  const r = await hit('e2e-ig');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${BOOKING_FORM}?origen=e2e-ig`);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  await waitClicks('e2e-ig', 1);
  await sleep(3000);
  assert.equal(await clicksOf('e2e-ig'), 1, 'no debe contarse dos veces');
  assert.equal((await q(`select sum(d.clicks)::int n from link_clicks_daily d join links l on l.id = d.link_id where l.slug = 'e2e-ig'`))[0].n, 1);
  for (let i = 0; i < 3; i++) assert.equal((await hit('e2e-ig')).status, 302);
  await waitClicks('e2e-ig', 4);
  const up = await hit('E2E-IG');
  assert.equal(up.status, 302); assert.equal(up.headers.get('location'), `${BOOKING_FORM}?origen=e2e-ig`);
  await waitClicks('e2e-ig', 5);
  const many = await Promise.all(Array.from({ length: 10 }, () => hit('e2e-ig')));
  assert.ok(many.every(x => x.status === 302));
  await waitClicks('e2e-ig', 15);
  await sleep(2000);
  assert.equal(await clicksOf('e2e-ig'), 15);
  assert.equal((await q(`select sum(d.clicks)::int n from link_clicks_daily d join links l on l.id = d.link_id where l.slug = 'e2e-ig'`))[0].n, 15, 'total y por días coinciden');
});

await test('E27 slug inexistente, desactivado o raro → 302 a la página por defecto, NO se cuenta y nunca redirige a otro sitio; sin página por defecto válida → 404', async () => {
  const igAntes = await clicksOf('e2e-ig');
  await mkShort('e2e-off'); await q(`update links set active=false where slug='e2e-off'`);
  for (const s of ['no-existe-e2e', 'e2e-off', 'NO-EXISTE-E2E']) {
    const r = await hit(s);
    assert.equal(r.status, 302, s); assert.equal(r.headers.get('location'), DEF_URL, s);
  }
  for (const s of ['a%20b', "x'--", encodeURIComponent('<script>'), 'a'.repeat(200), '%00', '..%2f..%2fetc', 'https:%2f%2fevil.com', 'e2e-ig%0d%0aLocation:%20https:%2f%2fevil.com']) {
    const r = await hit(s);
    if (r.status === 302) assert.equal(r.headers.get('location'), DEF_URL, s);
    else assert.ok([400, 404].includes(r.status), `${s}: ${r.status}`);
  }
  await sleep(2000);
  assert.equal(await clicksOf('e2e-off'), 0);
  assert.equal(await clicksOf('e2e-ig'), igAntes, 'ninguna visita rara tocó el contador de otro enlace');
  await q(`update settings set value='https://evil.com' where key='link_default_url'`);
  try {
    const r = await hit('no-existe-e2e');
    assert.equal(r.status, 404); assert.equal(r.headers.get('location'), null);
  } finally { await q(`update settings set value=$1 where key='link_default_url'`, [DEF_URL]); }
});

await test('E28 si la base de datos falla al resolver, la persona IGUALMENTE es redirigida a la página de respaldo y no se cuenta nada', async () => {
  const before = await clicksOf('e2e-ig');
  await q(`revoke execute on function resolve_link(text) from service_role`);
  try {
    const r = await hit('e2e-ig');
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'http://localhost:5678/respaldo');
  } finally { await q(`grant execute on function resolve_link(text) to service_role`); }
  await sleep(2500);
  assert.equal(await clicksOf('e2e-ig'), before);
  assert.equal((await hit('e2e-ig')).headers.get('location'), `${BOOKING_FORM}?origen=e2e-ig`, 'recuperado');
  await waitClicks('e2e-ig', before + 1);
});

await test('E29 LA REDIRECCIÓN NO ESPERA AL RECUENTO: con el recuento frenado 3 s, el 302 llega en < 2 s y el clic se anota después', async () => {
  await hit('e2e-ig', 'curl/8.4.0');                        // calentamiento (no cuenta)
  await q(`create or replace function public.e2e_slow() returns trigger language plpgsql as $$ begin perform pg_sleep(3); return new; end $$`);
  await q(`create trigger e2e_slow before update of click_count on public.links for each row execute function public.e2e_slow()`);
  try {
    const base = await clicksOf('e2e-ig');
    const t0 = Date.now(); const r = await hit('e2e-ig'); const ms = Date.now() - t0;
    assert.equal(r.status, 302);
    assert.ok(ms < 2000, `la redirección tardó ${ms} ms: está esperando al recuento`);
    assert.equal(await clicksOf('e2e-ig'), base, 'en el momento de la redirección el recuento aún no ha terminado');
    await waitClicks('e2e-ig', base + 1, 20000);
  } finally {
    await q(`drop trigger if exists e2e_slow on public.links`); await q(`drop function if exists public.e2e_slow()`);
  }
});

await test('E30 previsualizadores, rastreadores y herramientas (WhatsApp, Facebook, Slack, Googlebot, curl, Chrome headless, sin User-Agent) se redirigen pero NO suman; una persona sí', async () => {
  await mkShort('e2e-bots');
  for (const ua of ['WhatsApp/2.23.20.0 A', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0 Safari/537.36',
      'TelegramBot (like TwitterBot)', 'node', 'UptimeRobot/2.0', '']) {
    const r = await hit('e2e-bots', ua);
    assert.equal(r.status, 302, JSON.stringify(ua)); assert.equal(r.headers.get('location'), `${BOOKING_FORM}?origen=e2e-bots`, 'la vista previa sí ve el destino');
  }
  await sleep(3000);
  assert.equal(await clicksOf('e2e-bots'), 0, 'los bots no suman');
  const head = await hit('e2e-bots', UA_HUMAN, 'HEAD');
  console.log(`      (HEAD -> ${head.status})`);
  await sleep(3000);
  assert.equal(await clicksOf('e2e-bots'), 0, 'una petición HEAD no suma');
  assert.equal((await hit('e2e-bots')).status, 302);
  await waitClicks('e2e-bots', 1);
});

await test('E31 UNA RESERVA HECHA DESDE UN ENLACE GUARDA SU ORIGEN: clic en el enlace corto → formulario → turno → bookings.source = slug (y el clic cuenta)', async () => {
  await mkShort('e2e-book');
  const page = await newPage(); await page.setUserAgent(UA_HUMAN);
  await page.goto(shortUrl('e2e-book'), { waitUntil: 'networkidle2' });
  assert.match(page.url(), /\/form\/reservar-turno\?origen=e2e-book/, page.url());
  await waitTitle(page, /Reserva tu turno/); await submit(page); await waitTitle(page, /Tus datos/);
  const email = uniq('e31');
  await fillPage1(page, { day: nextWeekday(2, 23), name: 'Carla Mora', email, phone: PHONE });
  await waitTitle(page, /Elige tu hora/);
  await page.select('#field-0', (await hourOptions(page))[0]); await submit(page);
  await waitTitle(page, /Turno reservado/);
  await shot(page, 'e31-reserva-desde-enlace');
  const b = (await bookingsOf(email))[0];
  assert.equal(b.status, 'confirmed'); assert.equal(b.source, 'e2e-book');
  assert.equal(await clicksOf('e2e-book'), 1);
});

await test('E32 un ?origen= raro, en mayúsculas o ausente NUNCA impide reservar: mayúsculas se normalizan, texto raro o largo se descarta, sin origen queda vacío', async () => {
  const day = nextWeekday(3, 25);
  const casos = [['?origen=Instagram', 'instagram'], ['?origen=' + 'x'.repeat(150), null], ['?origen=%3Cscript%3Ealert(1)%3C%2Fscript%3E', null], ['', null], ['?origen=mi-campana-2', 'mi-campana-2']];
  for (const [qs, esperado] of casos) {
    const page = await newPage(); const email = uniq('e32');
    await openBooking(page, qs);
    await fillPage1(page, { day, name: 'Pedro Sola', email, phone: PHONE });
    await waitTitle(page, /Elige tu hora/);
    await page.select('#field-0', (await hourOptions(page))[0]); await submit(page);
    await waitTitle(page, /Turno reservado/);
    assert.equal((await bookingsOf(email))[0].source, esperado, `origen ${qs.slice(0, 40)}`);
    await page.close();
  }
});

await test('E33 FORMULARIO DE CREACIÓN PROTEGIDO: sin usuario y contraseña (o con una errónea) no entra ni por GET ni por POST y no se crea nada; con ellos crea el enlace y lo muestra', async () => {
  const f = `${N8N}/form/crear-enlace`;
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  assert.equal((await fetch(f)).status, 401);
  assert.equal((await fetch(f, { headers: { authorization: basic('equipo', 'mala') } })).status, 401);
  assert.equal((await fetch(f, { headers: { authorization: basic('otro', 'clave-de-prueba-123') } })).status, 401);
  for (const auth of [undefined, basic('equipo', 'mala')]) {
    const fd = new FormData(); fd.append('field-0', 'e2e-hack'); fd.append('field-1', 'https://evil.com'); fd.append('field-2', '');
    const r = await fetch(f, { method: 'POST', body: fd, headers: auth ? { authorization: auth } : {} });
    assert.equal(r.status, 401, 'POST sin credenciales válidas');
  }
  await sleep(1500);
  assert.equal((await q(`select 1 from links where slug='e2e-hack'`)).length, 0, 'sin credenciales no se crea nada');
  assert.equal((await fetch(f, { headers: { authorization: basic('equipo', 'clave-de-prueba-123') } })).status, 200);
  const page = await newPage(); await page.authenticate({ username: 'equipo', password: 'clave-de-prueba-123' });
  await page.goto(f, { waitUntil: 'networkidle2' });
  await waitTitle(page, /Crear enlace corto/);
  await shot(page, 'e33-crear-enlace');
  await page.type('#field-0', 'e2e-tiktok'); await page.type('#field-2', 'e2e-social');
  await submit(page);
  await waitTitle(page, /Enlace creado/);
  const txt = await bodyText(page);
  assert.match(txt, /https:\/\/l\.rocketnova\.io\/e2e-tiktok/); assert.match(txt, /e2e-social/);
  await shot(page, 'e33-enlace-creado');
  const row = (await q(`select slug, destination, channel, active, click_count::int c from links where slug='e2e-tiktok'`))[0];
  assert.deepEqual(row, { slug: 'e2e-tiktok', destination: BOOKING_FORM, channel: 'e2e-social', active: true, c: 0 });
});

await test('E34 el formulario de creación valida: slug con formato malo, slug repetido, destino de otro dominio / con @ / con origen / que es el propio dominio corto, y canal malo (nada se crea); un destino válido sí', async () => {
  const f = `${N8N}/form/crear-enlace`;
  const page = await newPage(); await page.authenticate({ username: 'equipo', password: 'clave-de-prueba-123' });
  const crear = async (slug, destino = '', canal = '') => {
    await page.goto(f, { waitUntil: 'networkidle2' }); await waitTitle(page, /Crear enlace corto/);
    await page.type('#field-0', slug); if (destino) await page.type('#field-1', destino); if (canal) await page.type('#field-2', canal);
    await submit(page);
  };
  const casos = [['Mal Slug', '', '', /Slug no válido/], ['-malo-', '', '', /Slug no válido/], ['e2e-tiktok', '', '', /Ese slug ya existe/],
    ['e2e-evil', 'https://evil.com/phishing', '', /Destino no permitido/], ['e2e-evil2', 'https://rocketnova.io@evil.com', '', /Destino no permitido/],
    ['e2e-evil3', 'https://rocketnova.io.evil.com', '', /Destino no permitido/], ['e2e-evil4', 'javascript:alert(1)', '', /Destino no permitido/],
    ['e2e-loop', 'https://l.rocketnova.io/instagram', '', /Destino no válido/], ['e2e-orig', 'https://rocketnova.io/x?origen=otro', '', /ya lleva/],
    ['e2e-canal', '', 'Mal Canal', /Canal no válido/]];
  for (const [slug, destino, canal, re] of casos) {
    await crear(slug, destino, canal);
    await waitTitle(page, re);
    if (slug !== 'e2e-tiktok') assert.equal((await q(`select 1 from links where slug=$1`, [slug])).length, 0, `${slug} no debería crearse`);
  }
  assert.equal((await q(`select count(*)::int n from links where slug='e2e-tiktok'`))[0].n, 1);
  await crear('e2e-dest', 'https://reservas.rocketnova.io/form/x#top', 'e2e-social');
  await waitTitle(page, /Enlace creado/);
  const r = await hit('e2e-dest');
  assert.equal(r.headers.get('location'), 'https://reservas.rocketnova.io/form/x?origen=e2e-dest#top');
});

await test('E35 REDIRECCIÓN ABIERTA: aunque alguien meta a la fuerza un destino ajeno en la base de datos, el clic NO redirige allí (va a la página por defecto) y no cuenta', async () => {
  await mkShort('e2e-forzado');
  await q(`alter table links disable trigger links_guard`);
  try {
    for (const evil of ['https://evil.com/phish', 'https://rocketnova.io@evil.com/', 'https://rocketnova.io.evil.com/', 'javascript:alert(1)', '//evil.com']) {
      await q(`update links set destination=$1 where slug='e2e-forzado'`, [evil]);
      const r = await hit('e2e-forzado');
      assert.equal(r.status, 302, evil); assert.equal(r.headers.get('location'), DEF_URL, `NO debe redirigir a ${evil}`);
    }
  } finally { await q(`alter table links enable trigger links_guard`); }
  await sleep(2500);
  assert.equal(await clicksOf('e2e-forzado'), 0);
  await q(`update links set destination=$1 where slug='e2e-forzado'`, ['https://rocketnova.io/ok']);
  assert.equal((await hit('e2e-forzado')).headers.get('location'), 'https://rocketnova.io/ok?origen=e2e-forzado');
  await waitClicks('e2e-forzado', 1);
});

await test('E36 EL CONTADOR NO SE PUEDE MANIPULAR DESDE FUERA: la API de Supabase rechaza a anon y a quien no lleva clave (tablas, vistas y RPC) y ningún intento mueve el contador', async () => {
  const before = await clicksOf('e2e-ig');
  const call = (p, o = {}) => fetch(stack.api + '/rest/v1' + p, o).then(async r => ({ status: r.status, body: await r.text() }));
  const h = (key) => ({ apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  for (const t of ['links', 'link_clicks_daily', 'stats_links', 'stats_channels', 'stats_clicks_daily', 'blocks_affected_bookings']) {
    for (const hd of [h(stack.anonKey), { 'content-type': 'application/json' }]) {
      const g = await call(`/${t}?select=*`, { headers: hd });
      assert.ok([401, 403].includes(g.status), `GET ${t} -> ${g.status} ${g.body}`);
    }
  }
  for (const hd of [h(stack.anonKey), { 'content-type': 'application/json' }]) {
    for (const [m, p, body] of [['PATCH', '/links?slug=eq.e2e-ig', { click_count: 99999 }], ['POST', '/links', { slug: 'hack', destination: 'https://evil.com' }],
        ['DELETE', '/links?slug=eq.e2e-ig', null], ['POST', '/link_clicks_daily', { link_id: '00000000-0000-0000-0000-000000000000', day: '2026-11-02', clicks: 5 }]]) {
      const r = await call(p, { method: m, headers: hd, body: body ? JSON.stringify(body) : undefined });
      assert.ok([401, 403].includes(r.status), `${m} ${p} -> ${r.status} ${r.body}`);
    }
    for (const [fn, body] of [['register_click', { p_slug: 'e2e-ig' }], ['resolve_link', { p_slug: 'e2e-ig' }], ['create_link', { p_slug: 'hack-api' }],
        ['_register_click', { p_slug: 'e2e-ig', p_now: new Date().toISOString() }], ['bookings_affected_by', { p_service_id: null, p_starts_at: '2026-01-01T00:00:00Z', p_ends_at: '2030-01-01T00:00:00Z' }]]) {
      const r = await call(`/rpc/${fn}`, { method: 'POST', headers: hd, body: JSON.stringify(body) });
      assert.ok([401, 403, 404].includes(r.status), `rpc ${fn} -> ${r.status} ${r.body}`);
    }
  }
  await sleep(1500);
  assert.equal(await clicksOf('e2e-ig'), before, 'el contador no se movió');
  assert.equal((await q(`select 1 from links where slug in ('hack','hack-api')`)).length, 0);
  assert.equal((await apiGet('stats_links?select=slug')).status, 200, 'con la clave service_role (n8n) sí se puede leer');
});

await test('E37 ESTADÍSTICAS desde la API con datos reales de esta ejecución: clics, reservas y conversión por enlace y por canal coinciden con las tablas; la suma de canales = todas las reservas', async () => {
  const links = await (await apiGet('stats_links?select=*')).json();
  assert.ok(links.length >= 5, 'enlaces: ' + links.length);
  for (const l of links) {
    const real = (await q(`select (select click_count from links where slug=$1)::int clicks, (select count(*) from bookings where source=$1)::int bookings`, [l.slug]))[0];
    assert.equal(l.clicks, real.clicks, l.slug); assert.equal(l.bookings, real.bookings, l.slug);
    assert.equal(l.conversion_pct, real.clicks > 0 ? Math.round(1000 * real.bookings / real.clicks) / 10 : null, `conversión de ${l.slug}`);
  }
  const book = links.find(l => l.slug === 'e2e-book');
  assert.deepEqual([book.clicks, book.bookings, book.conversion_pct], [1, 1, 100], 'el enlace de E31: 1 clic, 1 reserva');
  const canales = await (await apiGet('stats_channels?select=*')).json();
  assert.equal(canales.reduce((s, c) => s + c.bookings, 0), (await q(`select count(*)::int n from bookings`))[0].n, 'ninguna reserva se pierde ni se cuenta dos veces');
  assert.equal(canales.reduce((s, c) => s + c.clicks, 0), (await q(`select sum(click_count)::int n from links`))[0].n);
  const get = (c) => canales.find(x => x.channel === c);
  assert.equal(get('instagram').bookings, 1, 'de E32: ?origen=Instagram se normalizó a instagram');
  assert.ok(get('mi-campana-2').bookings === 1 && get('mi-campana-2').clicks === 0 && get('mi-campana-2').conversion_pct === null, 'origen escrito a mano, sin enlace');
  assert.ok(get('directo').bookings >= 3, 'las reservas sin origen son «directo»');
  assert.equal(get('e2e-social').links, 2, 'dos enlaces (tiktok y dest) en el canal e2e-social');
  const daily = await (await apiGet('stats_clicks_daily?select=*&slug=eq.e2e-ig')).json();
  assert.equal(daily.reduce((s, d) => s + d.clicks, 0), await clicksOf('e2e-ig'));
});

// ---------- Bloqueos en el formulario real ----------
const E2E_SVC = 'E2E Bloqueos';
const baselineHours = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30'];
let e2eSvc = null;
const ensureE2eService = async () => {
  if (e2eSvc) return e2eSvc;
  const ya = await q(`select id from services where name=$1`, [E2E_SVC]);        // por si se repite una prueba suelta sobre la misma base de datos
  if (ya.length) return (e2eSvc = ya[0].id);
  e2eSvc = (await q(`insert into services(name, duration_minutes, break_minutes, min_notice_hours, booking_window_days) values ($1, 30, 0, 2, 30) returning id`, [E2E_SVC]))[0].id;
  for (const d of [1, 2, 3, 4, 5]) await q(`insert into weekly_schedule(service_id, weekday, morning_start, morning_end, afternoon_start, afternoon_end) values ($1,$2,'09:00','14:00','16:00','19:00')`, [e2eSvc, d]);
  return e2eSvc;
};
const blockAt = async (service, d1, t1, d2, t2, reason) => (await q(
  `insert into blocks(service_id, starts_at, ends_at, reason) values ($1, ($2::date + $3::time) at time zone 'Europe/Madrid', ($4::date + $5::time) at time zone 'Europe/Madrid', $6) returning id`,
  [service, d1, t1, d2, t2, reason]))[0].id;
const hoursFor = async (day, service = E2E_SVC) => {
  const page = await newPage();
  try {
    await openBooking(page); await fillPage1(page, { day, name: 'Prueba Bloqueos', email: uniq('blk'), phone: PHONE, service });
    await waitTitle(page, /Elige tu hora|Ese día está completo/);
    return { title: await h1(page), hours: (await h1(page)).match(/Elige tu hora/) ? await hourOptions(page) : [], options: (await page.$$eval('#field-0 option', os => os.map(o => o.textContent.trim()))).filter(o => o && !/^Select an option/i.test(o)) };
  } finally { await page.close(); }
};

await test('E38 HUECO SUELTO: un bloqueo de 11:15 a 12:05 quita del desplegable SOLO 11:00, 11:30 y 12:00 (los bordes siguen libres), otro de 5 minutos quita su hora; al borrarlos todo vuelve', async () => {
  await ensureE2eService();
  const day = nextWeekday(3, 14);
  const base = await hoursFor(day);
  assert.deepEqual(base.hours, baselineHours, 'sin bloqueos: horario completo');
  const b1 = await blockAt(e2eSvc, day, '11:15', day, '12:05', 'E2E hueco');
  const conHueco = await hoursFor(day);
  assert.deepEqual(conHueco.hours, baselineHours.filter(h => !['11:00', '11:30', '12:00'].includes(h)));
  const b2 = await blockAt(e2eSvc, day, '16:10', day, '16:15', 'E2E 5 minutos');
  assert.deepEqual((await hoursFor(day)).hours, baselineHours.filter(h => !['11:00', '11:30', '12:00', '16:00'].includes(h)));
  const solo = await q(`select count(*)::int n from blocks where service_id is null and reason like 'E2E%'`);
  assert.equal(solo[0].n, 0);
  await q(`delete from blocks where id = any($1)`, [[b1, b2]]);
  assert.deepEqual((await hoursFor(day)).hours, baselineHours, 'sin bloqueos, todo vuelve');
});

await test('E39 FESTIVO Y VACACIONES: un festivo deja el día sin horas; unas vacaciones de lunes a viernes dejan esos días vacíos y proponen un día posterior; vale para todos los servicios', async () => {
  await ensureE2eService();
  const fest = nextWeekday(2, 16);
  const id1 = await blockAt(null, fest, '00:00', addDays(fest, 1), '00:00', 'E2E festivo');
  try {
    for (const service of [E2E_SVC, SVC_NAME]) {
      const r = await hoursFor(fest, service);
      assert.match(r.title, /Ese día está completo/, `festivo (${service}): ${r.title}`);
      assert.ok(r.options.every(o => !o.includes(fechaLarga(fest))), 'el festivo no se propone como alternativa');
    }
    const antes = await hoursFor(addDays(fest, -1)); const despues = await hoursFor(addDays(fest, 1));
    assert.match(antes.title, /Elige tu hora/); assert.match(despues.title, /Elige tu hora/);
  } finally { await q(`delete from blocks where id=$1`, [id1]); }
  const lun = nextWeekday(1, 12);
  const id2 = await blockAt(null, lun, '00:00', addDays(lun, 5), '00:00', 'E2E vacaciones');
  try {
    for (const service of [E2E_SVC, SVC_NAME]) {
      const r = await hoursFor(addDays(lun, 2), service);
      assert.match(r.title, /Ese día está completo/, `vacaciones (${service})`);
      const dentro = [0, 1, 2, 3, 4].map(i => fechaLarga(addDays(lun, i)));
      assert.ok(r.options.every(o => dentro.every(d => !o.includes(d))), 'ningún día de vacaciones se propone: ' + JSON.stringify(r.options));
      if (service === E2E_SVC) assert.ok(r.options[0].includes(fechaLarga(addDays(lun, 7))), 'el primer día propuesto es el lunes siguiente: ' + r.options[0]);
    }
  } finally { await q(`delete from blocks where id=$1`, [id2]); }
  assert.match((await hoursFor(addDays(lun, 2))).title, /Elige tu hora/, 'borradas las vacaciones, el día vuelve');
});

await test('E40 UN BLOQUEO SOBRE TURNOS YA CONFIRMADOS NO LOS BORRA: siguen confirmados, la vista de turnos afectados los lista, la hora no se ofrece a nadie más y la persona aún puede cancelar', async () => {
  await ensureE2eService();
  const day = nextWeekday(4, 15);
  const a = await sqlBooking({ day, time: '10:00', email: uniq('afect1'), name: 'Afectada Uno', svc: e2eSvc });
  const b = await sqlBooking({ day, time: '10:30', email: uniq('afect2'), name: 'Afectada Dos', svc: e2eSvc });
  const c = await sqlBooking({ day, time: '12:00', email: uniq('afect3'), name: 'No Afectada', svc: e2eSvc });
  const antes = [await rowJson(a.id), await rowJson(b.id), await rowJson(c.id)];
  // antes de crear el bloqueo: ¿a quién afectaría?
  const pre = await (await fetch(stack.api + '/rest/v1/rpc/bookings_affected_by', { method: 'POST', headers: { apikey: stack.serviceRoleKey, Authorization: `Bearer ${stack.serviceRoleKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_service_id: e2eSvc, p_starts_at: (await q(`select (($1::date + time '10:15') at time zone 'Europe/Madrid') t`, [day]))[0].t, p_ends_at: (await q(`select (($1::date + time '10:45') at time zone 'Europe/Madrid') t`, [day]))[0].t }) })).json();
  assert.deepEqual(pre.map(x => x.customer_name).sort(), ['Afectada Dos', 'Afectada Uno']);
  const blk = await blockAt(null, day, '10:15', day, '10:45', 'E2E reunión');
  try {
    assert.deepEqual([await rowJson(a.id), await rowJson(b.id), await rowJson(c.id)], antes, 'los turnos quedan byte a byte iguales');
    const af = await (await apiGet(`blocks_affected_bookings?select=*&block_id=eq.${blk}`)).json();
    assert.deepEqual(af.map(x => x.customer_name).sort(), ['Afectada Dos', 'Afectada Uno']);
    assert.ok(af.every(x => x.booked_before_block === true && x.block_reason === 'E2E reunión' && x.service_name === E2E_SVC));
    assert.deepEqual(af.map(x => x.starts_local).sort(), [`${day} 10:00`, `${day} 10:30`]);
    // y la hora no se ofrece a nadie más: ni las ocupadas ni las que tocan el bloqueo (10:00 y 10:30 están ocupadas; 09:30 y 11:00 siguen libres)
    const h = (await hoursFor(day)).hours;
    assert.ok(!h.includes('10:00') && !h.includes('10:30'), 'horas con turno + bloqueo: ' + h);
    assert.ok(h.includes('09:30') && h.includes('11:00') && !h.includes('12:00'), h.join(' '));
    // la persona afectada puede cancelar con su enlace de siempre
    const page = await newPage();
    await page.goto(`${N8N}/form/cancelar-turno?codigo=${a.management_code}`, { waitUntil: 'networkidle2' });
    await waitTitle(page, /Cancelar turno/); await submit(page); await waitTitle(page, /Turno cancelado/);
    assert.equal((await rowJson(a.id)).status, 'cancelled');
    assert.equal((await rowJson(b.id)).status, 'confirmed');
    const af2 = await (await apiGet(`blocks_affected_bookings?select=customer_name&block_id=eq.${blk}`)).json();
    assert.deepEqual(af2.map(x => x.customer_name), ['Afectada Dos'], 'el cancelado deja de aparecer en la vista');
  } finally {
    await q(`delete from blocks where id=$1`, [blk]);
  }
  assert.equal((await rowJson(b.id)).status, 'confirmed', 'al borrar el bloqueo el turno sigue ahí');
});

await test('E15 la API real (PostgREST) rechaza a anon y a quien no lleva clave: ni tablas ni funciones', async () => {
  const call = (p, o = {}) => fetch(stack.api + '/rest/v1' + p, o).then(async r => ({ status: r.status, body: await r.text() }));
  const h = (key) => ({ apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  for (const t of ['bookings', 'services', 'settings', 'blocks', 'weekly_schedule', 'email_log']) {
    const a = await call(`/${t}?select=*`, { headers: h(stack.anonKey) });
    assert.ok([401, 403].includes(a.status), `${t} con anon -> ${a.status} ${a.body}`);
    const n = await call(`/${t}?select=*`);
    assert.ok([401, 403].includes(n.status), `${t} sin clave -> ${n.status}`);
  }
  for (const [fn, body] of [['list_active_services', {}], ['get_config', {}], ['cancel_booking', { p_code: 'a'.repeat(64) }]]) {
    const a = await call(`/rpc/${fn}`, { method: 'POST', headers: h(stack.anonKey), body: JSON.stringify(body) });
    assert.ok([401, 403].includes(a.status), `rpc ${fn} con anon -> ${a.status} ${a.body}`);
    const n = await call(`/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok([401, 403].includes(n.status), `rpc ${fn} sin clave -> ${n.status}`);
  }
  const ok = await call('/rpc/get_config', { method: 'POST', headers: h(stack.serviceRoleKey), body: '{}' });
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.body).timezone === 'Europe/Madrid');
});

await test('E16 un fallo de verdad en un workflow (la API cae) → el workflow de errores avisa por correo al administrador', async () => {
  const before = mails().length;
  // tumba PostgREST
  const pid = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort 54332 -State Listen | Select-Object -First 1).OwningProcess`]).toString().trim();
  execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`]);
  await sleep(500);
  const page = await newPage();
  await page.goto(`${N8N}/form/reservar-turno`, { waitUntil: 'domcontentloaded' });
  await waitTitle(page, /Reserva tu turno/);
  await submit(page);
  const m = await waitMail(x => x.to.includes('admin@local.test') && /\[Turnos\] Error/.test(x.subject), 40000);
  assert.match(m.text, /Turnos · 01 Reservar/); assert.match(m.text, /Cargar parámetros/);
  assert.match(m.text, /Las reservas ya confirmadas/);
  assert.ok(mails().length > before);
});

// ---------- resumen ----------
await browser.close(); await db.end(); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
const ok = results.filter(r => r.ok).length;
console.log(`\n${ok}/${results.length} pruebas E2E correctas`);
if (!ONLY) fs.writeFileSync(path.join(import.meta.dirname, 'RESULTADOS-E2E.md'), ['# Resultado de las pruebas de extremo a extremo', '',
  `Ejecutado: ${new Date().toISOString()}`, '', '| # | Prueba | Resultado |', '|---|---|---|',
  ...results.map(r => `| ${r.name.split(' ')[0]} | ${r.name.slice(r.name.indexOf(' ') + 1).replace(/\|/g, '/')} | ${r.skipped ? '↷ saltada (' + r.skipped + ')' : r.ok ? '✔' : '✘ ' + r.err.split('\n')[0]} |`), '', `**${ok}/${results.length} correctas**`, ''].join('\n'));
process.exit(ok === results.length ? 0 : 1);
