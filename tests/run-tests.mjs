// ============================================================
// Pruebas del sistema de turnos contra un Postgres REAL (embedded-postgres).
//   cd tests && npm install && npm test
// Aplica las migraciones + seed de ../supabase y ejecuta las pruebas.
// Las pruebas de concurrencia usan varias conexiones en paralelo.
// ============================================================
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

pg.types.setTypeParser(1082, v => v);   // date -> 'YYYY-MM-DD' (sin conversión a zona local)
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PGPORT_TEST ?? 54329);
const CONN = { host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'turnos' };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnos-pg-'));

const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],   // como Supabase (UTF8): las pruebas de la Fase 3 usan caracteres Unicode
  onLog: () => {}, onError: () => {},
});

const results = [];
let admin;

// ---------- utilidades ----------
const q = async (sql, params) => (await admin.query(sql, params)).rows;
const newClient = async () => { const c = new pg.Client(CONN); c.on('error', () => {}); await c.connect(); return c; };
const MAD = 'Europe/Madrid';
/** hora local de Madrid ('2026-11-09','10:00') -> ISO UTC */
const L = async (day, time) =>
  (await q(`select iso_utc(($1::date + $2::time) at time zone '${MAD}') as t`, [day, time]))[0].t;
const slots = async (svc, day, now) =>
  q(`select iso_utc(slot_start) as utc, to_char(slot_start at time zone '${MAD}','HH24:MI') as loc
       from _available_slots($1, $2::date, $3::timestamptz) order by slot_start`, [svc, day, now]);
const labels = async (svc, day, now) => (await slots(svc, day, now)).map(s => s.loc);
const book = async (svc, startsUtc, email, now, o = {}) =>
  (await q(`select _book_slot($1,$2::timestamptz,$3,$4,$5,$6,$7,$8::timestamptz) as r`,
    [svc, startsUtc, o.name ?? 'Ana Prueba', email, o.phone ?? '+34 600 123 456', o.consent === undefined ? true : o.consent, o.source ?? null, now]))[0].r;
const cancel = async (code, now) => (await q(`select _cancel_booking($1,$2::timestamptz) as r`, [code, now]))[0].r;

let svcCounter = 0;
/** Crea un servicio aislado con horario L-J 9-14/16-19 y V 9-14 salvo que se pase otro. */
async function newService(o = {}) {
  svcCounter++;
  const id = (await q(`insert into services(name,duration_minutes,break_minutes,min_notice_hours,booking_window_days,cancel_notice_hours,slot_step_minutes)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [o.name ?? `Servicio test ${svcCounter}`, o.duration ?? 30, o.break ?? 10, o.x ?? 2, o.y ?? 30, o.cancel ?? null, o.step ?? null]))[0].id;
  const sched = o.schedule ?? [
    [1, '09:00', '14:00', '16:00', '19:00'], [2, '09:00', '14:00', '16:00', '19:00'],
    [3, '09:00', '14:00', '16:00', '19:00'], [4, '09:00', '14:00', '16:00', '19:00'],
    [5, '09:00', '14:00', null, null]];
  for (const [d, ms, me, as, ae] of sched)
    await q(`insert into weekly_schedule(service_id,weekday,morning_start,morning_end,afternoon_start,afternoon_end)
             values ($1,$2,$3,$4,$5,$6)`, [id, d, ms, me, as, ae]);
  return id;
}
const expectError = async (fn, code) => {
  try { await fn(); } catch (e) { assert.equal(e.code, code, `se esperaba SQLSTATE ${code}, llegó ${e.code}: ${e.message}`); return; }
  assert.fail(`se esperaba un error ${code} y no hubo ninguno`);
};

const NOW = '2026-11-02T08:00:00Z';           // lunes 09:00 en Madrid (CET)
const MON = '2026-11-09';                     // lunes de la semana siguiente
const MORNING = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'];
const AFTERNOON = ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30'];

async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`  ✔ ${name}`); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, err: e.message }); console.log(`  ✘ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}

// ============================================================
async function main() {
  console.log('Arrancando Postgres local…');
  await server.initialise();
  await server.start();
  await server.createDatabase('turnos');
  admin = await newClient();

  // Roles tal y como los trae Supabase
  await admin.query(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);

  const migDir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()) {
    let sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    // MUTATE=1: quita las protecciones anti-carrera para comprobar que las pruebas SÍ detectan el fallo
    if (process.env.MUTATE === '1') sql = sql.replace("perform pg_advisory_xact_lock(hashtextextended('slot:' || p_service_id::text, 0));", '');
    // MUTATE=2: quita el reclamo ATÓMICO de los recordatorios (sin SKIP LOCKED y sin la guarda "sent_at is null" del UPDATE)
    if (process.env.MUTATE === '2' && f.includes('fase2_avisos')) {
      sql = sql.replaceAll('    for update skip locked\n', '')
               .replace('       and b.reminder_24h_sent_at is null\n    returning', '    returning')
               .replace('       and b.reminder_1h_sent_at is null\n    returning', '    returning');
    }
    // MUTATE=3 (Fase 3): el filtro de dominios compara con "contiene" en vez de "igual o termina en .dominio" -> debe fallar T63 y T64
    if (process.env.MUTATE === '3' && f.includes('fase3_enlaces_tablas'))
      sql = sql.replace("and (v_host = x.d or right(v_host, length(x.d) + 1) = '.' || x.d)", 'and position(x.d in v_host) > 0');
    // MUTATE=4 (Fase 3): el contador lee el valor y luego escribe (no atómico) -> debe fallar T70
    if (process.env.MUTATE === '4' && f.includes('fase3_enlaces_rpc'))
      sql = sql.replace('set click_count = click_count + 1,', 'set click_count = (select l2.click_count from public.links l2 where l2.slug = v_slug) + 1,');
    await admin.query('begin;\n' + sql + '\ncommit;');
    console.log(`  migración aplicada: ${f}`);
  }
  if (process.env.MUTATE === '2') console.log('  *** MUTATE=2: recordatorios SIN reclamo atómico ***');
  if (process.env.MUTATE === '1') { await admin.query('alter table bookings drop constraint bookings_no_overlap'); console.log('  *** MUTATE=1: sin bloqueo por servicio y sin restricción de exclusión ***'); }
  await admin.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  // Aplicarlas dos veces el seed no debe duplicar nada
  await admin.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  const SEED = '11111111-1111-4111-8111-111111111111';

  console.log('\nPruebas');

  // ---------------- Instalación y seguridad ----------------
  await test('T01 seed: 1 servicio, 5 días de horario, 1 bloqueo (y relanzable sin duplicar)', async () => {
    assert.equal((await q('select count(*)::int n from services'))[0].n, 1);
    assert.equal((await q('select count(*)::int n from weekly_schedule'))[0].n, 5);
    assert.equal((await q('select count(*)::int n from blocks'))[0].n, 1);
  });

  await test('T02 RLS activado en las 9 tablas (6 de la Fase 1 + daily_summary_log de la Fase 2 + links y link_clicks_daily de la Fase 3)', async () => {
    const r = await q(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
                        where n.nspname='public' and relkind='r' order by relname`);
    assert.deepEqual(r.map(x => x.relname), ['blocks', 'bookings', 'daily_summary_log', 'email_log', 'link_clicks_daily', 'links', 'services', 'settings', 'weekly_schedule']);
    assert.ok(r.every(x => x.relrowsecurity), 'alguna tabla sin RLS: ' + JSON.stringify(r));
  });

  await test('T03 anon y authenticated no pueden leer/escribir tablas ni ejecutar funciones; service_role sí', async () => {
    for (const role of ['anon', 'authenticated']) {
      const c = await newClient();
      await c.query(`set role ${role}`);
      for (const t of ['services', 'weekly_schedule', 'blocks', 'bookings', 'settings', 'email_log'])
        await expectError(async () => c.query(`select * from ${t}`), '42501');
      await expectError(async () => c.query(`insert into services(name,duration_minutes) values ('x',10)`), '42501');
      await expectError(async () => c.query(`select list_active_services()`), '42501');
      await expectError(async () => c.query(`select book_slot('${SEED}', now(), 'a','a@b.co','+34600111222', true)`), '42501');
      await expectError(async () => c.query(`select cancel_booking('abc')`), '42501');
      await expectError(async () => c.query(`select _book_slot('${SEED}', now(), 'a','a@b.co','+34600111222', true, null, now())`), '42501');
      await c.end();
    }
    const s = await newClient();
    await s.query('set role service_role');
    const r = await s.query('select list_active_services() as r');
    assert.equal(r.rows[0].r.services.length, 1);
    await s.end();
  });

  // ---------------- Seed con la hora real ----------------
  await test('T04 el bloqueo del seed se descuenta de las horas libres (hora real)', async () => {
    const day = (await q(`select (starts_at at time zone '${MAD}')::date as d from blocks`))[0].d;
    const rows = await q(`select local_time from get_available_slots($1, $2::date)`, [SEED, day]);
    const lt = rows.map(r => r.local_time);
    assert.ok(lt.length > 0, 'el día del bloqueo debería tener otras horas libres');
    assert.ok(!lt.includes('12:00') && !lt.includes('12:30'), 'las 12:00 y 12:30 deberían estar bloqueadas: ' + lt);
  });
  await q('delete from blocks');   // a partir de aquí, fechas fijas y sin bloqueos del seed

  // ---------------- Disponibilidad ----------------
  await test('T05 un lunes normal ofrece 09:00-13:30 y 16:00-18:30 cada 30 min', async () => {
    const s = await newService({ break: 0 });
    assert.deepEqual(await labels(s, MON, NOW), [...MORNING, ...AFTERNOON]);
  });

  await test('T06 viernes solo mañana; sábado y domingo cerrados', async () => {
    const s = await newService({ break: 0 });
    assert.deepEqual(await labels(s, '2026-11-13', NOW), MORNING);
    assert.deepEqual(await labels(s, '2026-11-14', NOW), []);
    assert.deepEqual(await labels(s, '2026-11-15', NOW), []);
  });

  await test('T07 antelación mínima X=2h: con "ahora"=09:00 la primera hora de hoy es las 11:00', async () => {
    const s = await newService({ break: 0 });
    const l = await labels(s, '2026-11-02', NOW);
    assert.equal(l[0], '11:00');
    assert.ok(!l.includes('10:30'));
  });

  await test('T08 días vista Y=30: hoy+30 se ofrece, hoy+31 no, y ayer no', async () => {
    const s = await newService({ break: 0 });
    assert.ok((await labels(s, '2026-12-02', NOW)).length > 0, 'hoy+30 (miércoles 2-dic) debe ofrecerse');
    assert.deepEqual(await labels(s, '2026-12-03', NOW), []);
    assert.deepEqual(await labels(s, '2026-11-01', NOW), []);
  });

  await test('T09 bloqueo de un servicio: descuenta solo ese servicio', async () => {
    const a = await newService({ break: 0 }); const b = await newService({ break: 0 });
    await q(`insert into blocks(service_id,starts_at,ends_at,reason) values ($1,$2,$3,'test')`,
      [a, await L(MON, '11:00'), await L(MON, '12:00')]);
    const la = await labels(a, MON, NOW);
    assert.ok(!la.includes('11:00') && !la.includes('11:30'));
    assert.ok(la.includes('10:30') && la.includes('12:00'), 'los bordes del bloqueo siguen libres');
    assert.ok((await labels(b, MON, NOW)).includes('11:00'));
  });

  await test('T10 bloqueo global (service_id nulo): afecta a todos los servicios', async () => {
    const a = await newService({ break: 0 }); const b = await newService({ break: 0 });
    await q(`insert into blocks(service_id,starts_at,ends_at,reason) values (null,$1,$2,'festivo')`,
      [await L(MON, '09:00'), await L(MON, '14:00')]);
    for (const s of [a, b]) assert.deepEqual(await labels(s, MON, NOW), AFTERNOON);
    await q('delete from blocks');
  });

  await test('T11 el descanso se respeta: tras reservar 10:00 (+10 min) desaparecen 09:30, 10:00 y 10:30; 09:00 y 11:00 siguen', async () => {
    const s = await newService({ break: 10 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    assert.equal(r.ok, true);
    const l = await labels(s, MON, NOW);
    for (const h of ['09:30', '10:00', '10:30']) assert.ok(!l.includes(h), `${h} debería estar oculta`);
    for (const h of ['09:00', '11:00']) assert.ok(l.includes(h), `${h} debería seguir libre`);
  });

  await test('T12 la BD rechaza a mano un solape dentro del descanso (23P01) y acepta justo al terminar', async () => {
    const s = await newService({ break: 10 });
    await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
             values ($1,'A','a@x.com','+34600111222',$2,true)`, [s, await L(MON, '10:00')]);
    await expectError(async () => q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
             values ($1,'B','b@x.com','+34600111222',$2,true)`, [s, await L(MON, '10:30')]), '23P01');
    // 10:40 = 10:00 + 30 min de turno + 10 min de descanso -> permitido
    await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
             values ($1,'C','c@x.com','+34600111222',$2,true)`, [s, await L(MON, '10:40')]);
  });

  await test('T13 día lleno: get_availability no devuelve horas y propone los próximos días con huecos', async () => {
    const s = await newService({ break: 10 });
    let i = 0;
    for (;;) {
      const free = await slots(s, MON, NOW);
      if (!free.length) break;
      const r = await book(s, free[0].utc, `lleno${i++}@x.com`, NOW);
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const a = (await q(`select _get_availability($1,$2::date,$3::timestamptz) as r`, [s, MON, NOW]))[0].r;
    assert.deepEqual(a.slots, []);
    assert.ok(a.next_days.length >= 3, 'debería proponer varios días');
    assert.ok(a.next_days.every(d => d.day > MON && d.free_slots > 0));
    assert.equal(a.next_days[0].day, '2026-11-10');
  });

  // ---------------- Cambios de hora ----------------
  await test('T14 cambio de hora de OCTUBRE 2026: las 09:00 locales son 07:00Z el viernes 23 y 08:00Z el lunes 26', async () => {
    const s = await newService({ break: 0 });
    const now = '2026-10-20T08:00:00Z';
    assert.equal((await slots(s, '2026-10-23', now))[0].utc, '2026-10-23T07:00:00Z');
    assert.equal((await slots(s, '2026-10-26', now))[0].utc, '2026-10-26T08:00:00Z');
    assert.equal((await slots(s, '2026-10-26', now))[0].loc, '09:00');
  });

  await test('T15 cambio de hora de MARZO 2026: las 09:00 locales son 08:00Z el viernes 27 y 07:00Z el lunes 30', async () => {
    const s = await newService({ break: 0 });
    const now = '2026-03-20T08:00:00Z';
    assert.equal((await slots(s, '2026-03-27', now))[0].utc, '2026-03-27T08:00:00Z');
    assert.equal((await slots(s, '2026-03-30', now))[0].utc, '2026-03-30T07:00:00Z');
  });

  await test('T16 domingo 25-oct-2026 (fin de horario de verano): franja 01:00-05:00 = 5 horas reales; el desplegable desambigua las dos 02:00', async () => {
    const s = await newService({ duration: 60, break: 0, schedule: [[7, '01:00', '05:00', null, null]] });
    const now = '2026-10-20T08:00:00Z';
    const sl = await slots(s, '2026-10-25', now);
    assert.deepEqual(sl.map(x => x.utc), ['2026-10-24T23:00:00Z', '2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z', '2026-10-25T03:00:00Z']);
    assert.deepEqual(sl.map(x => x.loc), ['01:00', '02:00', '02:00', '03:00', '04:00']);
    const av = (await q(`select _get_availability($1,'2026-10-25'::date,$2::timestamptz) as r`, [s, now]))[0].r;
    assert.deepEqual(av.slots.map(x => x.label), ['01:00', '02:00 (UTC+2)', '02:00 (UTC+1)', '03:00', '04:00']);
    assert.equal(new Set(av.slots.map(x => x.label)).size, 5);
  });

  await test('T17 domingo 28-mar-2027 (inicio de horario de verano): franja 01:00-05:00 = 3 horas reales; no existe la 02:00', async () => {
    const s = await newService({ duration: 60, break: 0, schedule: [[7, '01:00', '05:00', null, null]] });
    const sl = await slots(s, '2027-03-28', '2027-03-20T08:00:00Z');
    assert.deepEqual(sl.map(x => x.utc), ['2027-03-28T00:00:00Z', '2027-03-28T01:00:00Z', '2027-03-28T02:00:00Z']);
    assert.deepEqual(sl.map(x => x.loc), ['01:00', '03:00', '04:00']);
  });

  await test('T18 reservar tras el cambio de hora guarda UTC correcto y devuelve la hora local de Madrid', async () => {
    const s = await newService({ break: 0 });
    const now = '2026-10-20T08:00:00Z';
    const r = await book(s, '2026-10-26T08:00:00Z', 'dst@x.com', now);
    assert.equal(r.ok, true);
    assert.equal(r.local_time, '09:00');
    assert.equal(r.local_date, '2026-10-26');
    assert.equal(r.starts_at, '2026-10-26T08:00:00Z');
    assert.equal(r.ends_at, '2026-10-26T08:30:00Z');
  });

  // ---------------- Reserva ----------------
  await test('T19 reserva correcta: código de 256 bits, correo en minúsculas, consentimiento y descanso guardados', async () => {
    const s = await newService({ break: 10 });
    const r = await book(s, await L(MON, '09:00'), '  Ana.Perez@Mail.COM ', NOW, { name: ' Ana Pérez ' });
    assert.equal(r.ok, true);
    assert.match(r.management_code, /^[0-9a-f]{64}$/);
    assert.equal(r.customer_email, 'ana.perez@mail.com');
    const row = (await q(`select *, iso_utc(occupied_until) ou, iso_utc(ends_at) ea from bookings where id=$1`, [r.booking_id]))[0];
    assert.equal(row.customer_email, 'ana.perez@mail.com');
    assert.equal(row.customer_name, 'Ana Pérez');
    assert.equal(row.status, 'confirmed');
    assert.equal(row.consent_given, true);
    assert.ok(row.consent_at instanceof Date);
    assert.equal(row.ou, '2026-11-09T08:40:00Z');
    assert.equal(row.ea, '2026-11-09T08:30:00Z');
    assert.equal(row.source, null);
    assert.equal(row.reminder_24h_sent_at, null);
    const codes = await q('select count(distinct management_code)::int n, count(*)::int t from bookings');
    assert.equal(codes[0].n, codes[0].t);
  });

  await test('T20 validación: nombre, correo, teléfono y consentimiento', async () => {
    const s = await newService();
    const h = await L(MON, '09:00');
    assert.equal((await book(s, h, 'a@x.com', NOW, { name: '  ' })).field, 'name');
    for (const bad of ['sin-arroba', 'a@b', 'a b@c.com', '']) assert.equal((await book(s, h, bad, NOW)).field, 'email', bad);
    for (const bad of ['abc', '12345', '+34 600 abc', '1234567890123456789']) assert.equal((await book(s, h, 'a@x.com', NOW, { phone: bad })).field, 'phone', bad);
    assert.equal((await book(s, h, 'a@x.com', NOW, { consent: false })).error, 'CONSENT_REQUIRED');
    assert.equal((await book(s, h, 'a@x.com', NOW, { consent: null })).error, 'CONSENT_REQUIRED');
    assert.equal((await book('00000000-0000-4000-8000-000000000000', h, 'a@x.com', NOW)).error, 'SERVICE_NOT_FOUND');
    assert.equal((await q('select count(*)::int n from bookings where service_id=$1', [s]))[0].n, 0);
  });

  await test('T21 horas no ofrecidas se rechazan: fuera de horario, no alineadas, antelación < X, fin de semana, día pasado, > Y días', async () => {
    const s = await newService({ break: 0 });
    for (const [d, t] of [[MON, '08:00'], [MON, '09:15'], [MON, '14:00'], [MON, '13:45'], ['2026-11-14', '10:00'], ['2026-11-02', '10:00'], ['2026-11-01', '10:00'], ['2026-12-03', '10:00']]) {
      const r = await book(s, await L(d, t), 'z@x.com', NOW);
      assert.equal(r.error, 'SLOT_TAKEN', `${d} ${t}: ${JSON.stringify(r)}`);
    }
    assert.equal((await q('select count(*)::int n from bookings where service_id=$1', [s]))[0].n, 0);
  });

  await test('T22 una persona = un turno futuro confirmado por servicio (correo normalizado)', async () => {
    const s = await newService({ break: 0 }); const otro = await newService({ break: 0 });
    assert.equal((await book(s, await L(MON, '09:00'), 'ana@x.com', NOW)).ok, true);
    assert.equal((await book(s, await L(MON, '10:00'), ' ANA@x.com ', NOW)).error, 'ALREADY_HAS_BOOKING');
    assert.equal((await book(otro, await L(MON, '10:00'), 'ana@x.com', NOW)).ok, true, 'otro servicio: permitido');
    assert.equal((await book(s, await L(MON, '10:00'), 'bea@x.com', NOW)).ok, true, 'otra persona: permitido');
    // cuando el turno ya es pasado, puede volver a reservar
    const later = '2026-11-09T12:00:00Z';
    assert.equal((await book(s, await L('2026-11-10', '10:00'), 'ana@x.com', later)).ok, true);
  });

  // ---------------- Cancelación ----------------
  await test('T23 cancelar libera el hueco y se puede volver a reservar', async () => {
    const s = await newService({ break: 10 });
    const h = await L(MON, '10:00');
    const r = await book(s, h, 'a@x.com', NOW);
    assert.ok(!(await labels(s, MON, NOW)).includes('10:00'));
    const c = await cancel(r.management_code, NOW);
    assert.equal(c.ok, true);
    assert.equal(c.customer_email, 'a@x.com');
    assert.equal(c.local_time, '10:00');
    const l = await labels(s, MON, NOW);
    for (const x of ['09:30', '10:00', '10:30']) assert.ok(l.includes(x), `${x} debería volver a estar libre`);
    const row = (await q('select status, cancelled_at from bookings where id=$1', [r.booking_id]))[0];
    assert.equal(row.status, 'cancelled'); assert.ok(row.cancelled_at);
    assert.equal((await book(s, h, 'b@x.com', NOW)).ok, true, 'otra persona ocupa el hueco liberado');
    assert.equal((await book(s, await L('2026-11-10', '10:00'), 'a@x.com', NOW)).ok, true, 'quien canceló puede reservar de nuevo');
  });

  await test('T24 cancelaciones erróneas: código inválido, ya cancelado, turno pasado y fuera de plazo; sin revelar datos', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW, { name: 'Persona Secreta' });
    for (const bad of ['', null, 'abc', 'x'.repeat(64), '0'.repeat(64), r.management_code.slice(0, 63), r.management_code + 'f']) {
      const x = await cancel(bad, NOW);
      assert.deepEqual(x, { ok: false, error: 'INVALID_CODE' }, String(bad));
    }
    // fuera de plazo: faltan 1 h (< X = 2 h)
    const tarde = await cancel(r.management_code, '2026-11-09T08:00:00Z');   // 09:00 local; el turno es a las 10:00
    assert.deepEqual(tarde, { ok: false, error: 'TOO_LATE', hours: 2 });
    assert.equal((await q('select status from bookings where id=$1', [r.booking_id]))[0].status, 'confirmed');
    // turno pasado
    const pasado = await cancel(r.management_code, '2026-11-09T12:00:00Z');
    assert.deepEqual(pasado, { ok: false, error: 'NOT_CANCELLABLE' });
    // cancelado y vuelto a intentar
    assert.equal((await cancel(r.management_code, NOW)).ok, true);
    assert.deepEqual(await cancel(r.management_code, NOW), { ok: false, error: 'NOT_CANCELLABLE' });
    for (const x of [tarde, pasado]) assert.ok(!JSON.stringify(x).includes('Secreta') && !JSON.stringify(x).includes('a@x.com'));
  });

  await test('T25 plazo de cancelación propio (cancel_notice_hours=24) y por defecto igual a X', async () => {
    const s = await newService({ break: 0, cancel: 24 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const x = await cancel(r.management_code, '2026-11-08T12:00:00Z');   // faltan 21 h
    assert.deepEqual(x, { ok: false, error: 'TOO_LATE', hours: 24 });
    assert.equal((await cancel(r.management_code, '2026-11-08T08:00:00Z')).ok, true);   // faltan 25 h
  });

  // ---------------- Concurrencia (conexiones reales en paralelo) ----------------
  await test('T26 CARRERA: 12 personas reservan el MISMO hueco a la vez (5 rondas) -> solo una lo consigue', async () => {
    const s = await newService({ break: 10 });
    const days = await q(`select day from get_next_available_days($1, null, 5)`, [s]);
    const N = 12;
    const clients = await Promise.all(Array.from({ length: N }, () => newClient()));
    for (let round = 0; round < 5; round++) {
      const dayStr = days[round].day;
      const free = (await q(`select slot_start::text as t, iso_utc(slot_start) as utc from get_available_slots($1,$2::date)`, [s, dayStr]))[0];
      const out = await Promise.all(clients.map((c, i) =>
        c.query(`select book_slot($1,$2::timestamptz,$3,$4,'+34 600 000 000',true) as r`,
          [s, free.utc, `Persona ${i}`, `carrera${round}_${i}@x.com`]).then(r => r.rows[0].r)));
      const oks = out.filter(r => r.ok);
      assert.equal(oks.length, 1, `ronda ${round}: confirmadas=${oks.length} ${JSON.stringify(out.map(o => o.ok ? 'OK' : o.error))}`);
      assert.ok(out.filter(r => !r.ok).every(r => r.error === 'SLOT_TAKEN'));
      const n = (await q(`select count(*)::int n from bookings where service_id=$1 and starts_at=$2 and status='confirmed'`, [s, free.utc]))[0].n;
      assert.equal(n, 1);
    }
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T27 CARRERA determinista: A reserva sin confirmar, B queda esperando y al hacer commit A recibe "SLOT_TAKEN" B', async () => {
    const s = await newService({ break: 10 });
    const h = await L(MON, '11:00');
    const A = await newClient(), B = await newClient();
    await A.query('begin');
    const ra = (await A.query(`select _book_slot($1,$2::timestamptz,'A','a@x.com','+34600111222',true,null,$3::timestamptz) as r`, [s, h, NOW])).rows[0].r;
    assert.equal(ra.ok, true);
    let bDone = false;
    const bP = B.query(`select _book_slot($1,$2::timestamptz,'B','b@x.com','+34600111222',true,null,$3::timestamptz) as r`, [s, h, NOW])
      .then(r => { bDone = true; return r.rows[0].r; });
    await sleep(700);
    assert.equal(bDone, false, 'B debería estar bloqueada esperando a A (restricción de exclusión)');
    await A.query('commit');
    const rb = await bP;
    assert.deepEqual(rb, { ok: false, error: 'SLOT_TAKEN' });
    assert.equal((await q(`select count(*)::int n from bookings where service_id=$1 and status='confirmed'`, [s]))[0].n, 1);
    // Variante: si A hace rollback, B sí consigue el hueco
    const h2 = await L(MON, '12:00');
    await A.query('begin');
    await A.query(`select _book_slot($1,$2::timestamptz,'A','a2@x.com','+34600111222',true,null,$3::timestamptz)`, [s, h2, NOW]);
    const bP2 = B.query(`select _book_slot($1,$2::timestamptz,'B','b2@x.com','+34600111222',true,null,$3::timestamptz) as r`, [s, h2, NOW]).then(r => r.rows[0].r);
    await sleep(400);
    await A.query('rollback');
    assert.equal((await bP2).ok, true);
    await A.end(); await B.end();
  });

  await test('T28 la propia BD impide el solape aunque se salte la función: 10 INSERT directos simultáneos -> 1 éxito y 9 rechazos (23P01 o deadlock 40P01)', async () => {
    const s = await newService({ break: 10 });
    const h = await L(MON, '15:00');
    const clients = await Promise.all(Array.from({ length: 10 }, () => newClient()));
    const out = await Promise.all(clients.map((c, i) =>
      c.query(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
               values ($1,'P',$2,'+34600111222',$3,true)`, [s, `raw${i}@x.com`, h]).then(() => 'OK', e => e.code)));
    // Con INSERT simultáneos, Postgres puede resolver el conflicto GiST como 23P01 (exclusión) o 40P01 (deadlock):
    // en ambos casos la fila sobrante se rechaza y solo queda una confirmada.
    assert.equal(out.filter(x => x === 'OK').length, 1, JSON.stringify(out));
    assert.ok(out.filter(x => x !== 'OK').every(x => x === '23P01' || x === '40P01'), JSON.stringify(out));
    assert.equal((await q(`select count(*)::int n from bookings where service_id=$1 and status='confirmed'`, [s]))[0].n, 1);
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T29 CARRERA: la misma persona pide 8 turnos distintos a la vez -> solo 1 confirmado (resto ALREADY_HAS_BOOKING)', async () => {
    const s = await newService({ break: 0 });
    const hs = [];
    for (const t of ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30']) hs.push(await L(MON, t));
    const clients = await Promise.all(hs.map(() => newClient()));
    const out = await Promise.all(clients.map((c, i) =>
      c.query(`select _book_slot($1,$2::timestamptz,'Ana','mismo@x.com','+34600111222',true,null,$3::timestamptz) as r`, [s, hs[i], NOW]).then(r => r.rows[0].r)));
    assert.equal(out.filter(r => r.ok).length, 1, JSON.stringify(out));
    assert.equal(out.filter(r => r.error === 'ALREADY_HAS_BOOKING').length, 7);
    assert.equal((await q(`select count(*)::int n from bookings where service_id=$1 and customer_email='mismo@x.com' and status='confirmed'`, [s]))[0].n, 1);
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T30 CARRERA: dos cancelaciones simultáneas del mismo código -> una ok y otra NOT_CANCELLABLE', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const clients = await Promise.all([newClient(), newClient()]);
    const out = await Promise.all(clients.map(c => c.query(`select _cancel_booking($1,$2::timestamptz) as r`, [r.management_code, NOW]).then(x => x.rows[0].r)));
    assert.equal(out.filter(x => x.ok).length, 1, JSON.stringify(out));
    assert.equal(out.filter(x => x.error === 'NOT_CANCELLABLE').length, 1);
    await Promise.all(clients.map(c => c.end()));
  });

  // ---------------- Integridad ante ediciones a mano ----------------
  await test('T31 ediciones desde el panel: alta con solo inicio calcula fin y descanso; el correo se normaliza; sin consentimiento no entra', async () => {
    const s = await newService({ duration: 45, break: 15 });
    const id = (await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
                         values ($1,'  Pepe ','PEPE@Mail.Com','600111222',$2,true) returning id`, [s, await L(MON, '10:00')]))[0].id;
    const row = (await q(`select customer_email, customer_name, iso_utc(ends_at) ea, iso_utc(occupied_until) ou, length(management_code) len from bookings where id=$1`, [id]))[0];
    assert.deepEqual([row.customer_email, row.customer_name, row.ea, row.ou, row.len], ['pepe@mail.com', 'Pepe', '2026-11-09T09:45:00Z', '2026-11-09T10:00:00Z', 64]);
    await expectError(async () => q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at)
                              values ($1,'X','x@x.com','600111222',$2)`, [s, await L(MON, '12:00')]), '23514');
    await expectError(async () => q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,management_code)
                              values ($1,'X','x@x.com','600111222',$2,true,'corto')`, [s, await L(MON, '12:00')]), '23514');
    await expectError(async () => q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,status)
                              values ($1,'X','x@x.com','600111222',$2,true,'raro')`, [s, await L(MON, '12:00')]), '23514');
  });

  await test('T32 cancelar a mano desde el panel (status=cancelled) libera el hueco y rellena cancelled_at', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    await q(`update bookings set status='cancelled' where id=$1`, [r.booking_id]);
    assert.ok((await labels(s, MON, NOW)).includes('10:00'));
    assert.ok((await q('select cancelled_at from bookings where id=$1', [r.booking_id]))[0].cancelled_at);
    await q(`update bookings set status='attended' where id=$1`, [r.booking_id]);   // volver a un estado "no cancelado" re-ocupa
    assert.ok(!(await labels(s, MON, NOW)).includes('10:00'));
  });

  await test('T33 restricciones del horario semanal y de los servicios', async () => {
    const s = await newService({ break: 0 });
    const ins = (...v) => q(`insert into weekly_schedule(service_id,weekday,morning_start,morning_end,afternoon_start,afternoon_end) values ($1,$2,$3,$4,$5,$6)`, [s, ...v]);
    await expectError(async () => ins(1, '09:00', '14:00', null, null), '23505');       // día repetido
    await expectError(async () => ins(6, '09:00', null, null, null), '23514');          // mañana sin fin
    await expectError(async () => ins(6, '14:00', '09:00', null, null), '23514');       // fin antes que inicio
    await expectError(async () => ins(6, '09:00', '14:00', '13:00', '19:00'), '23514'); // tarde solapa mañana
    await expectError(async () => ins(6, null, null, null, null), '23514');             // día sin franjas
    await expectError(async () => ins(8, '09:00', '14:00', null, null), '23514');       // weekday inválido
    await expectError(async () => q(`insert into services(name,duration_minutes) values ('mal',0)`), '23514');
    await expectError(async () => q(`insert into blocks(starts_at,ends_at) values (now(), now())`), '23514');
  });

  await test('T34 get_availability devuelve JSON con horas (etiqueta HH:MI y UTC) y list_active_services/get_config/log_email funcionan', async () => {
    const s = await newService({ break: 0, name: 'Zzz último' });
    const day = (await q(`select day from get_next_available_days($1,null,1)`, [s]))[0].day;
    const dayStr = day;
    const a = (await q(`select get_availability($1,$2::date) as r`, [s, dayStr]))[0].r;
    assert.ok(a.slots.length > 0 && /^\d\d:\d\d$/.test(a.slots[0].label) && /Z$/.test(a.slots[0].starts_at));
    assert.equal(a.timezone, MAD);
    const services = (await q('select list_active_services() as r'))[0].r.services;
    assert.ok(services.some(x => x.name === 'Zzz último') && services.every(x => x.id && x.name));
    const cfg = (await q(`select get_config() as v`))[0].v;
    // Fase 2 añade claves (reschedule_form_url, staff_email); las tres de la Fase 1 siguen igual.
    assert.deepEqual(Object.keys(cfg).sort(), ['admin_email', 'cancel_form_url', 'reschedule_form_url', 'staff_email', 'timezone']);
    assert.equal(cfg.timezone, MAD);
    await q(`select log_email(null,'confirmation','a@x.com','failed','SMTP caído')`);
    const log = (await q(`select * from email_log order by id desc limit 1`))[0];
    assert.deepEqual([log.kind, log.status, log.error], ['confirmation', 'failed', 'SMTP caído']);
    await q(`update services set active=false where id=$1`, [s]);
    assert.ok(!(await q('select list_active_services() as r'))[0].r.services.some(x => x.id === s));
    assert.equal((await book(s, await L(MON, '10:00'), 'a@x.com', NOW)).error, 'SERVICE_NOT_FOUND');
  });

  // ============================================================
  // FASE 2
  // ============================================================
  const resched = async (code, startsUtc, now = NOW) =>
    (await q(`select _reschedule_booking($1,$2::timestamptz,$3::timestamptz) as r`, [code, startsUtc, now]))[0].r;
  const rowOf = async (id) => (await q(`select to_jsonb(b) as r from bookings b where id=$1`, [id]))[0].r;
  const mk = async (svc, startsUtc, email, o = {}) => (await q(
    `insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given,created_at,status)
     values ($1,$2,$3,'+34 600 111 222',$4,true,$5,$6) returning id, management_code`,
    [svc, o.name ?? 'Cliente', email, startsUtc, o.created ?? '2026-10-01T00:00:00Z', o.status ?? 'confirmed']))[0];
  const claim = async (now, c = admin) => (await c.query(`select _claim_due_reminders($1::timestamptz) as r`, [now])).rows[0].r.reminders;
  const report = async (b, kind, claimedAt, ok, err = null) =>
    (await q(`select _report_reminder($1,$2,$3::timestamptz,$4,$5,'cliente@x.com') as r`, [b, kind, claimedAt, ok, err]))[0].r;
  const summary = async (now, c = admin) => (await c.query(`select _claim_daily_summary($1::timestamptz) as r`, [now])).rows[0].r;
  const reportSummary = async (day, ok, err = null, now = NOW) =>
    (await q(`select _report_daily_summary($1::date,$2,$3,'staff@x.com',$4::timestamptz) as r`, [day, ok, err, now]))[0].r;
  const TUE = '2026-11-10';

  // ---------------- Cambio de hora ----------------
  await test('T35 cambiar la hora: UNA misma fila (mismo id y código) pasa a la hora nueva; la antigua se libera; fin, descanso, versión del .ics y fecha del cambio se actualizan', async () => {
    const s = await newService({ break: 10 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const x = await resched(r.management_code, await L(TUE, '11:00'));
    assert.equal(x.ok, true, JSON.stringify(x));
    assert.equal(x.booking_id, r.booking_id); assert.equal(x.management_code, r.management_code);
    assert.deepEqual([x.old_local_date, x.old_local_time, x.local_date, x.local_time, x.ics_sequence], [MON, '10:00', TUE, '11:00', 1]);
    assert.equal(x.customer_phone, '+34 600 123 456');
    const row = (await q(`select iso_utc(starts_at) s, iso_utc(ends_at) e, iso_utc(occupied_until) o, status, ics_sequence, iso_utc(rescheduled_at) rs from bookings where id=$1`, [r.booking_id]))[0];
    assert.deepEqual([row.s, row.e, row.o, row.status, row.ics_sequence, row.rs], ['2026-11-10T10:00:00Z', '2026-11-10T10:30:00Z', '2026-11-10T10:40:00Z', 'confirmed', 1, NOW]);
    assert.equal((await q(`select count(*)::int n from bookings where service_id=$1`, [s]))[0].n, 1, 'no se crea otra fila');
    assert.ok((await labels(s, MON, NOW)).includes('10:00'), 'la hora antigua queda libre');
    assert.ok(!(await labels(s, TUE, NOW)).includes('11:00'), 'la nueva queda ocupada');
  });

  await test('T36 get_reschedule_availability usa la MISMA disponibilidad: igual que get_availability en otros días; en el día del turno el propio hueco cuenta como libre y su hora actual no se ofrece', async () => {
    const s = await newService({ break: 10 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    await book(s, await L(MON, '12:00'), 'b@x.com', NOW);
    const av = async (day) => (await q(`select _get_reschedule_availability($1,$2::date,$3::timestamptz) as r`, [r.management_code, day, NOW]))[0].r;
    const plain = async (day) => (await q(`select _get_availability($1,$2::date,$3::timestamptz) as r`, [s, day, NOW]))[0].r;
    // otro día: idéntico
    const a1 = await av(TUE), p1 = await plain(TUE);
    assert.equal(a1.ok, true); assert.deepEqual(a1.slots, p1.slots); assert.deepEqual(a1.next_days, p1.next_days);
    // el día del turno: con la disponibilidad normal 09:30 y 10:30 están ocultas por el descanso del propio turno
    const own = (await av(MON)).slots.map(x => x.label), normal = (await plain(MON)).slots.map(x => x.label);
    for (const h of ['09:30', '10:30']) { assert.ok(!normal.includes(h)); assert.ok(own.includes(h), `${h} debe poder elegirse para moverse junto a su hueco`); }
    assert.ok(!own.includes('10:00'), 'su hora actual no se ofrece como "nueva"');
    for (const h of ['11:30', '12:00', '12:30']) assert.ok(!own.includes(h), `${h} sigue ocupada por OTRO turno`);
    // código malo: error y nada más
    assert.deepEqual((await q(`select _get_reschedule_availability('xx',$1::date,$2::timestamptz) as r`, [TUE, NOW]))[0].r, { ok: false, error: 'INVALID_CODE' });
    // día lleno -> propone otros días
    const t = await newService({ break: 0 });
    const rt = await book(t, await L(MON, '10:00'), 'z@x.com', NOW);
    for (const h of [...MORNING, ...AFTERNOON]) if (h !== '10:00')
      await q(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given) values ($1,'R',$2,'600111222',$3,true)`, [t, `r${h}@x.com`, await L(MON, h)]);
    const full = (await q(`select _get_reschedule_availability($1,$2::date,$3::timestamptz) as r`, [rt.management_code, MON, NOW]))[0].r;
    assert.deepEqual(full.slots, []); assert.equal(full.next_days[0].day, TUE);
  });

  await test('T37 reglas del cambio: antelación X, días vista Y, horario, bloqueos, plazo mínimo para cambiar, estado del turno y código; el turno nunca se altera', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const before = await rowOf(r.booking_id);
    await q(`insert into blocks(service_id,starts_at,ends_at,reason) values ($1,$2,$3,'t')`, [s, await L(TUE, '11:00'), await L(TUE, '12:00')]);
    for (const [d, t, why] of [['2026-11-02', '10:00', 'menos de X=2 h'], ['2026-12-03', '10:00', 'más de Y=30 días'], ['2026-11-14', '10:00', 'sábado'],
                               [TUE, '08:00', 'antes del horario'], [TUE, '09:15', 'no alineada'], [TUE, '11:00', 'bloqueo'], [TUE, '14:00', 'fin de franja']]) {
      const x = await resched(r.management_code, await L(d, t));
      assert.deepEqual(x, { ok: false, error: 'SLOT_TAKEN' }, `${why}: ${JSON.stringify(x)}`);
    }
    assert.deepEqual(await resched(r.management_code, null), { ok: false, error: 'SLOT_TAKEN' });
    assert.deepEqual(await resched(r.management_code, await L(MON, '10:00')), { ok: false, error: 'SAME_SLOT' });
    assert.deepEqual(await rowOf(r.booking_id), before, 'el turno quedó exactamente igual tras 9 intentos rechazados');
    // plazo para cambiar: faltan 1 h (< 2 h)
    assert.deepEqual(await resched(r.management_code, await L(TUE, '10:00'), '2026-11-09T08:00:00Z'), { ok: false, error: 'TOO_LATE', hours: 2 });
    // jerarquía: reschedule_notice_hours > cancel_notice_hours > X
    const a = await newService({ break: 0, cancel: 12 }), b = await newService({ break: 0, cancel: 12 });
    await q(`update services set reschedule_notice_hours=24 where id=$1`, [b]);
    const ra = await book(a, await L(MON, '10:00'), 'a2@x.com', NOW), rb = await book(b, await L(MON, '10:00'), 'b2@x.com', NOW);
    const t18 = '2026-11-08T15:00:00Z';   // faltan 18 h
    assert.equal((await resched(ra.management_code, await L(TUE, '10:00'), t18)).ok, true, 'cancel=12 h: 18 h de margen valen');
    assert.deepEqual(await resched(rb.management_code, await L(TUE, '10:00'), t18), { ok: false, error: 'TOO_LATE', hours: 24 });
    // estado del turno y código
    const c = await book(s, await L(MON, '11:00'), 'c@x.com', NOW);
    assert.equal((await cancel(c.management_code, NOW)).ok, true);
    assert.deepEqual(await resched(c.management_code, await L(TUE, '10:00')), { ok: false, error: 'NOT_CHANGEABLE' });
    assert.deepEqual(await resched(r.management_code, await L(TUE, '10:00'), '2026-11-09T12:00:00Z'), { ok: false, error: 'NOT_CHANGEABLE' }, 'turno ya pasado');
    for (const bad of ['', null, 'abc', '0'.repeat(64), r.management_code.slice(0, 63)]) {
      const x = await resched(bad, await L(TUE, '10:00'));
      assert.deepEqual(x, { ok: false, error: 'INVALID_CODE' }, String(bad));
    }
    // y el cambio válido sí funciona (último día permitido, hoy+30)
    assert.equal((await resched(r.management_code, await L('2026-12-02', '10:00'))).ok, true);
  });

  await test('T38 FALLO FORZADO 1: la hora nueva está ocupada por otra persona -> SLOT_TAKEN y el turno original queda byte a byte igual', async () => {
    const s = await newService({ break: 10 });
    const a = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const b = await book(s, await L(TUE, '16:00'), 'b@x.com', NOW);
    const antes = await rowOf(a.booking_id);
    for (const t of ['16:00', '16:30']) {   // 16:30 = dentro del descanso del otro
      assert.deepEqual(await resched(a.management_code, await L(TUE, t)), { ok: false, error: 'SLOT_TAKEN' }, t);
    }
    assert.deepEqual(await rowOf(a.booking_id), antes);
    assert.ok(!(await labels(s, MON, NOW)).includes('10:00'), 'el hueco original sigue ocupado por su dueño');
    assert.equal((await q(`select status from bookings where id=$1`, [b.booking_id]))[0].status, 'confirmed');
  });

  await test('T39 FALLO FORZADO 2 (carrera en la propia BD): alguien ocupa el hueco nuevo SALTÁNDOSE las funciones mientras se valida el cambio -> la restricción de exclusión lo rechaza y el original no se mueve; si esa otra operación se deshace, el cambio sí prospera', async () => {
    const s = await newService({ break: 10 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const antes = await rowOf(r.booking_id);
    const target = await L(TUE, '16:00');
    const A = await newClient(), B = await newClient();
    await A.query('begin');
    await A.query(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given)
                   values ($1,'Intruso','intruso@x.com','600111222',$2,true)`, [s, target]);        // sin confirmar
    let done = false;
    const p = B.query(`select _reschedule_booking($1,$2::timestamptz,$3::timestamptz) as r`, [r.management_code, target, NOW]).then(x => { done = true; return x.rows[0].r; });
    await sleep(700);
    assert.equal(done, false, 'el cambio debe quedar esperando a que A termine (restricción de exclusión)');
    await A.query('commit');
    assert.deepEqual(await p, { ok: false, error: 'SLOT_TAKEN' });
    assert.deepEqual(await rowOf(r.booking_id), antes, 'el turno original no se ha movido ni un milisegundo');
    assert.ok(!(await labels(s, MON, NOW)).includes('10:00'), 'y su hueco antiguo NO se liberó');
    // variante: la otra operación hace rollback -> el cambio prospera
    const target2 = await L(TUE, '17:00');
    await A.query('begin');
    await A.query(`insert into bookings(service_id,customer_name,customer_email,customer_phone,starts_at,consent_given) values ($1,'Intruso','intruso2@x.com','600111222',$2,true)`, [s, target2]);
    const p2 = B.query(`select _reschedule_booking($1,$2::timestamptz,$3::timestamptz) as r`, [r.management_code, target2, NOW]).then(x => x.rows[0].r);
    await sleep(400);
    await A.query('rollback');
    const x2 = await p2;
    assert.equal(x2.ok, true, JSON.stringify(x2)); assert.equal(x2.local_time, '17:00');
    await A.end(); await B.end();
  });

  await test('T40 FALLO FORZADO 3 (error inesperado DESPUÉS del UPDATE, p. ej. fallo del servidor): se deshace todo, el turno original sigue en su sitio y la hora nueva sigue libre', async () => {
    const s = await newService({ break: 10 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const antes = await rowOf(r.booking_id);
    await q(`create function test_boom() returns trigger language plpgsql as $f$ begin raise exception 'fallo simulado tras mover el turno' using errcode = 'XX000'; end $f$;
             create trigger test_boom_trg after update of starts_at on bookings for each row execute function test_boom();`);
    try {
      await expectError(async () => resched(r.management_code, await L(TUE, '10:00')), 'XX000');
    } finally { await q(`drop trigger test_boom_trg on bookings; drop function test_boom();`); }
    assert.deepEqual(await rowOf(r.booking_id), antes);
    assert.ok(!(await labels(s, MON, NOW)).includes('10:00'), 'el hueco original sigue ocupado');
    assert.ok((await labels(s, TUE, NOW)).includes('10:00'), 'el hueco nuevo no quedó ocupado');
    assert.equal((await resched(r.management_code, await L(TUE, '10:00'))).ok, true, 'sin el fallo, el mismo cambio funciona');
  });

  await test('T41 CARRERA: 6 cambios de hora y 4 reservas nuevas pelean por el MISMO hueco -> gana una sola operación; las demás no se mueven', async () => {
    const s = await newService({ break: 10 });
    const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '16:00'];
    const owners = [];
    for (const [i, h] of hours.entries()) owners.push(await book(s, await L(MON, h), `mov${i}@x.com`, NOW));
    const antes = []; for (const o of owners) antes.push(await rowOf(o.booking_id));
    const target = await L(TUE, '16:00');
    const clients = await Promise.all(Array.from({ length: 10 }, () => newClient()));
    const out = await Promise.all(clients.map((c, i) => i < 6
      ? c.query(`select _reschedule_booking($1,$2::timestamptz,$3::timestamptz) as r`, [owners[i].management_code, target, NOW]).then(x => ({ k: 'cambio', i, r: x.rows[0].r }))
      : c.query(`select _book_slot($1,$2::timestamptz,'Nuevo',$3,'+34600111222',true,null,$4::timestamptz) as r`, [s, target, `nuevo${i}@x.com`, NOW]).then(x => ({ k: 'reserva', i, r: x.rows[0].r }))));
    assert.equal(out.filter(o => o.r.ok).length, 1, JSON.stringify(out.map(o => [o.k, o.r.ok ? 'OK' : o.r.error])));
    assert.ok(out.filter(o => !o.r.ok).every(o => o.r.error === 'SLOT_TAKEN'));
    assert.equal((await q(`select count(*)::int n from bookings where service_id=$1 and starts_at=$2 and status='confirmed'`, [s, target]))[0].n, 1);
    for (const o of out.filter(o => o.k === 'cambio' && !o.r.ok)) assert.deepEqual(await rowOf(owners[o.i].booking_id), antes[o.i], `el turno ${o.i} no debía tocarse`);
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T42 dos cambios simultáneos del MISMO código a horas distintas: se aplican uno tras otro, queda un solo turno confirmado y la versión del .ics sube dos veces', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    const cl = await Promise.all([newClient(), newClient()]);
    const [h1, h2] = [await L(TUE, '10:00'), await L(TUE, '11:00')];
    const out = await Promise.all(cl.map((c, i) => c.query(`select _reschedule_booking($1,$2::timestamptz,$3::timestamptz) as r`, [r.management_code, i ? h2 : h1, NOW]).then(x => x.rows[0].r)));
    assert.ok(out.every(o => o.ok), JSON.stringify(out));
    const rows = await q(`select iso_utc(starts_at) s, ics_sequence from bookings where service_id=$1 and status='confirmed'`, [s]);
    assert.equal(rows.length, 1); assert.equal(rows[0].ics_sequence, 2);
    assert.ok([h1, h2].includes(rows[0].s));
    await Promise.all(cl.map(c => c.end()));
  });

  await test('T43 versión del .ics (SEQUENCE): reserva 0 -> cambio 1 -> cancelación 2; una cancelación sin cambios previos devuelve 1 (como en la Fase 1) y ambas llevan el teléfono', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L(MON, '10:00'), 'a@x.com', NOW);
    assert.equal((await q(`select ics_sequence from bookings where id=$1`, [r.booking_id]))[0].ics_sequence, 0);
    assert.equal((await resched(r.management_code, await L(TUE, '10:00'))).ics_sequence, 1);
    const c = await cancel(r.management_code, NOW);
    assert.equal(c.ok, true); assert.equal(c.ics_sequence, 2); assert.equal(c.customer_phone, '+34 600 123 456'); assert.equal(c.local_time, '10:00'); assert.equal(c.local_date, TUE);
    const r2 = await book(s, await L(MON, '11:00'), 'b@x.com', NOW);
    assert.equal((await cancel(r2.management_code, NOW)).ics_sequence, 1);
  });

  await test('T44 mover un turno rearma sus recordatorios (por la RPC y también editando starts_at a mano en el panel); editar otro campo no los rearma', async () => {
    const s = await newService({ break: 0 });
    const a = await book(s, await L(MON, '10:00'), 'a@x.com', NOW), b = await book(s, await L(MON, '11:00'), 'b@x.com', NOW);
    await q(`update bookings set reminder_24h_sent_at=now(), reminder_1h_sent_at=now(), reminder_24h_attempts=2, reminder_1h_attempts=1 where id = any($1)`, [[a.booking_id, b.booking_id]]);
    await resched(a.management_code, await L(TUE, '10:00'));
    const nuevo = await L(TUE, '11:00');
    await q(`update bookings set starts_at = $2::timestamptz, ends_at = $2::timestamptz + interval '30 minutes' where id=$1`, [b.booking_id, nuevo]);   // a mano
    for (const id of [a.booking_id, b.booking_id]) {
      const x = (await q(`select reminder_24h_sent_at r24, reminder_1h_sent_at r1, reminder_24h_attempts a24, reminder_1h_attempts a1, rescheduled_at from bookings where id=$1`, [id]))[0];
      assert.deepEqual([x.r24, x.r1, x.a24, x.a1], [null, null, 0, 0]);
      assert.ok(x.rescheduled_at);
    }
    await q(`update bookings set reminder_24h_sent_at=now(), reminder_24h_attempts=1 where id=$1`, [a.booking_id]);
    await q(`update bookings set customer_name='Otro Nombre' where id=$1`, [a.booking_id]);
    assert.ok((await q(`select reminder_24h_sent_at from bookings where id=$1`, [a.booking_id]))[0].reminder_24h_sent_at);
  });

  await test('T45 cambio de hora (octubre 2026): pasar del viernes 23 (UTC+2) al lunes 26 (UTC+1) a las 09:00 guarda 08:00Z y avisa con la hora local correcta', async () => {
    const s = await newService({ break: 0 });
    const now = '2026-10-20T08:00:00Z';
    const r = await book(s, '2026-10-23T07:00:00Z', 'dst@x.com', now);
    const x = await resched(r.management_code, '2026-10-26T08:00:00Z', now);
    assert.equal(x.ok, true, JSON.stringify(x));
    assert.deepEqual([x.old_local_time, x.local_time, x.starts_at, x.old_starts_at], ['09:00', '09:00', '2026-10-26T08:00:00Z', '2026-10-23T07:00:00Z']);
  });

  // ---------------- Recordatorios ----------------
  await q('delete from bookings');   // a partir de aquí cada prueba cuenta sus propios turnos sin ruido de las anteriores
  const START = '2026-11-09T09:00:00Z';                       // lunes 10:00 en Madrid
  const at = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();

  await test('T46 recordatorio de 24 h: no sale antes de tiempo, sale justo a las 24 h con todos los datos, y nunca se repite', async () => {
    const s = await newService({ break: 0 });
    const b = await mk(s, START, 'r24@x.com');
    assert.deepEqual((await claim(at(START, -24 * 60 - 1))).filter(x => x.booking_id === b.id), [], '1 min antes de las 24 h: nada');
    const got = (await claim(at(START, -24 * 60))).filter(x => x.booking_id === b.id);
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].kind, got[0].customer_email, got[0].local_date, got[0].local_time, got[0].timezone, got[0].attempt], ['24h', 'r24@x.com', MON, '10:00', MAD, 1]);
    assert.equal(got[0].management_code, b.management_code);
    assert.equal((await q(`select iso_utc(reminder_24h_sent_at) t, reminder_1h_sent_at from bookings where id=$1`, [b.id]))[0].t, at(START, -24 * 60).replace('.000Z', 'Z'));
    for (const m of [-24 * 60 + 15, -24 * 60 + 30, -121]) assert.deepEqual((await claim(at(START, m))).filter(x => x.booking_id === b.id), [], `otra pasada a ${m} min: no se repite`);
  });

  await test('T47 NO se envía el de 24 h a turnos reservados (o cambiados) con menos de 24 h de antelación, ni el de 1 h a los reservados con menos de 1 h; ventanas: 24 h hasta 2 h antes, 1 h hasta el inicio', async () => {
    const s = await newService({ break: 0 });
    const corto = await mk(s, START, 'corto@x.com', { created: at(START, -20 * 60) });                    // reservado con 20 h
    const movido = await mk(s, at(START, 30), 'movido@x.com', { created: '2026-10-01T00:00:00Z' });
    await q(`update bookings set rescheduled_at=$2 where id=$1`, [movido.id, at(START, 30 - 13 * 60)]);     // movido con 13 h
    const last = await mk(s, at(START, 60), 'ultima@x.com', { created: at(START, 60 - 30) });              // reservado con 30 min
    const ids = (a) => a.map(x => `${x.kind}:${x.booking_id}`);
    // hora de las 24 h de esos turnos: no sale el de 24 h
    assert.deepEqual(ids(await claim(at(START, -24 * 60 + 5))).filter(x => x.includes(corto.id)), []);
    assert.deepEqual(ids(await claim(at(START, 30 - 24 * 60 + 5))).filter(x => x.includes(movido.id)), []);
    // pero el de 1 h sí sale al llegar su hora (antelación suficiente para ese)
    assert.deepEqual(ids(await claim(at(START, -60))).filter(x => x.includes(corto.id)), [`1h:${corto.id}`]);
    assert.deepEqual(ids(await claim(at(START, 30 - 60))).filter(x => x.includes(movido.id)), [`1h:${movido.id}`]);
    // reservado con 30 min: ni el de 24 h ni el de 1 h (su "hora de 1 h" ya había pasado al reservar)
    for (const m of [60 - 20, 60 - 10]) assert.deepEqual(ids(await claim(at(START, m))).filter(x => x.includes(last.id)), []);
    // ventanas
    const w = await mk(s, at(START, 180), 'ventana@x.com');
    assert.deepEqual((await claim(at(START, 180 - 90))).filter(x => x.booking_id === w.id), [], 'a menos de 2 h el de 24 h ya no sale');
    assert.deepEqual((await claim(at(START, 180 - 61))).filter(x => x.booking_id === w.id), [], 'a 61 min aún no toca el de 1 h');
    assert.equal((await claim(at(START, 180 - 60))).filter(x => x.booking_id === w.id).length, 1, 'a 60 min sale el de 1 h');
    const late = await mk(s, at(START, 240), 'tarde@x.com');
    assert.deepEqual((await claim(at(START, 240 + 1))).filter(x => x.booking_id === late.id), [], 'turno ya empezado: nada');
  });

  await test('T48 un turno CANCELADO no recibe recordatorios (ni antes ni después de cancelar); tampoco los marcados asistido / no presentado', async () => {
    await q('delete from bookings');   // esta prueba mira TODO lo que se reclama: sin restos de las anteriores
    const s = await newService({ break: 0 });
    const c1 = await mk(s, await L(MON, '10:00'), 'c1@x.com');
    await mk(s, await L(MON, '11:00'), 'c2@x.com', { status: 'cancelled' });
    await mk(s, await L(MON, '12:00'), 'c3@x.com', { status: 'attended' });
    await mk(s, await L(MON, '13:00'), 'c4@x.com', { status: 'no_show' });
    assert.equal((await cancel(c1.management_code, '2026-10-02T00:00:00Z')).ok, true);
    assert.deepEqual(await claim('2026-11-08T09:00:00Z'), [], '24 h antes: nada para cancelados / asistidos');
    assert.deepEqual(await claim('2026-11-09T08:30:00Z'), [], '1 h antes: nada');
    // cancelado DESPUÉS del de 24 h: no recibe el de 1 h
    const d = await mk(s, await L(MON, '15:00'), 'c5@x.com');   // 14:00Z
    assert.equal((await claim('2026-11-08T14:00:00Z')).filter(x => x.booking_id === d.id).length, 1);
    assert.equal((await cancel(d.management_code, '2026-11-08T14:05:00Z')).ok, true);
    assert.deepEqual((await claim('2026-11-09T13:30:00Z')).filter(x => x.booking_id === d.id), []);
  });

  await test('T49 CARRERA de recordatorios: 6 ejecuciones simultáneas reclaman 12 turnos pendientes (3 rondas) -> cada recordatorio sale EXACTAMENTE una vez', async () => {
    const s = await newService({ break: 0 });
    const clients = await Promise.all(Array.from({ length: 6 }, () => newClient()));
    const horas = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];
    for (let round = 0; round < 3; round++) {
      const day = `2026-12-0${1 + round}`;
      const now = `${at(day + 'T00:00:00Z', -8 * 60).slice(0, 10)}T16:00:00Z`;       // las 16:00Z del día anterior: los 12 están en su ventana de 24 h
      const ids = [];
      for (const [i, h] of horas.entries()) ids.push((await mk(s, await L(day, h), `carr${round}_${i}@x.com`)).id);
      const out = await Promise.all(clients.map(c => claim(now, c).then(a => a.filter(x => ids.includes(x.booking_id)).map(x => `${x.kind}:${x.booking_id}`))));
      const flat = out.flat();
      assert.equal(flat.length, new Set(flat).size, `ronda ${round}: HAY duplicados ${JSON.stringify(flat)}`);
      assert.equal(flat.length, 12, `ronda ${round}: los 12 deben salir una vez (salieron ${flat.length})`);
      assert.ok(out.filter(o => o.length > 0).length >= 1);
      assert.deepEqual((await claim(now)).filter(x => ids.includes(x.booking_id)), [], 'una pasada posterior no repite nada');
    }
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T50 CARRERA determinista: una ejecución reclama sin terminar; la segunda no espera ni reclama lo mismo; al confirmar la primera nadie más lo recibe; si la primera se deshace, la segunda sí', async () => {
    const s = await newService({ break: 0 });
    const day = '2026-11-17';
    const now = '2026-11-16T12:00:00Z';
    const ids = []; for (const h of ['09:00', '09:30', '10:00']) ids.push((await mk(s, await L(day, h), `det${h}@x.com`)).id);
    const A = await newClient(), B = await newClient();
    await A.query('begin');
    const ra = (await claim(now, A)).filter(x => ids.includes(x.booking_id));
    assert.equal(ra.length, 3);
    const t0 = Date.now();
    const rb = (await claim(now, B)).filter(x => ids.includes(x.booking_id));       // no debe quedarse esperando
    assert.deepEqual(rb, [], 'B no recibe nada de lo que A tiene en curso'); assert.ok(Date.now() - t0 < 1500, 'B no debe bloquearse (SKIP LOCKED)');
    await A.query('commit');
    assert.deepEqual((await claim(now, B)).filter(x => ids.includes(x.booking_id)), [], 'tras confirmar A, ya están reclamados');
    // variante: A se deshace (p. ej. n8n cae a mitad) -> los turnos vuelven a estar pendientes
    const ids2 = []; for (const h of ['11:00', '11:30']) ids2.push((await mk(s, await L(day, h), `det2${h}@x.com`)).id);
    await A.query('begin');
    assert.equal((await claim(now, A)).filter(x => ids2.includes(x.booking_id)).length, 2);
    await A.query('rollback');
    assert.equal((await claim(now, B)).filter(x => ids2.includes(x.booking_id)).length, 2);
    await A.end(); await B.end();
  });

  await test('T51 CONTROL NEGATIVO: un reclamo ingenuo (SELECT y luego UPDATE, sin atomicidad) SÍ envía duplicados con las mismas 4 conexiones -> T49 detectaría el fallo', async () => {
    const s = await newService({ break: 0 });
    const ids = []; for (const h of ['09:00', '09:30', '10:00', '10:30']) ids.push((await mk(s, await L('2026-11-18', h), `naive${h}@x.com`)).id);
    const clients = await Promise.all(Array.from({ length: 4 }, () => newClient()));
    const naive = async (c) => {
      const due = (await c.query(`select id from bookings where id = any($1) and reminder_24h_sent_at is null`, [ids])).rows.map(r => r.id);
      await sleep(250);                                                       // "enviar" el correo
      await c.query(`update bookings set reminder_24h_sent_at = now() where id = any($1)`, [due]);
      return due;
    };
    const out = (await Promise.all(clients.map(naive))).flat();
    assert.ok(out.length > ids.length, `el enfoque ingenuo debería duplicar (${out.length} envíos para ${ids.length} turnos)`);
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T52 fallo de envío: queda constancia en email_log, el reclamo se libera, se reintenta en la pasada siguiente SIN duplicar y, tras 3 fallos, se da por fallido (gave_up)', async () => {
    const s = await newService({ break: 0 });
    const b = await mk(s, START, 'fail@x.com');
    const t1 = '2026-11-08T09:00:00.123456Z';
    const c1 = (await claim(t1)).find(x => x.booking_id === b.id);
    assert.equal(c1.claimed_at, t1);
    // reporte con un reclamo que NO es el suyo (otra ejecución): no libera nada (pero el fallo queda anotado)
    assert.deepEqual(await report(b.id, '24h', '2000-01-01T00:00:00Z', false, 'x'), { ok: true, will_retry: false, gave_up: false, attempts: null });
    assert.ok((await q(`select reminder_24h_sent_at from bookings where id=$1`, [b.id]))[0].reminder_24h_sent_at, 'sigue reclamado');
    assert.deepEqual((await claim('2026-11-08T09:10:00Z')).filter(x => x.booking_id === b.id), [], 'mientras está reclamado nadie más lo envía');
    // fallo 1
    assert.deepEqual(await report(b.id, '24h', c1.claimed_at, false, 'SMTP caído: 451'), { ok: true, will_retry: true, gave_up: false, attempts: 1 });
    let log = await q(`select kind,status,to_email,error from email_log where booking_id=$1 order by id`, [b.id]);
    assert.deepEqual(log.filter(l => l.status === 'failed').map(l => [l.kind, l.error]).at(-1), ['reminder_24h', 'SMTP caído: 451']);
    assert.equal((await q(`select reminder_24h_sent_at s from bookings where id=$1`, [b.id]))[0].s, null);
    // reintento en la pasada siguiente: lo reclama UNA vez (intento 2) y fallo 2
    const c2 = (await claim('2026-11-08T09:15:00Z')).filter(x => x.booking_id === b.id);
    assert.equal(c2.length, 1); assert.equal(c2[0].attempt, 2);
    assert.equal((await claim('2026-11-08T09:15:00Z')).filter(x => x.booking_id === b.id).length, 0);
    assert.equal((await report(b.id, '24h', c2[0].claimed_at, false, 'SMTP caído')).will_retry, true);
    // intento 3 -> fallo -> se rinde
    const c3 = (await claim('2026-11-08T09:30:00Z')).find(x => x.booking_id === b.id);
    assert.equal(c3.attempt, 3);
    assert.deepEqual(await report(b.id, '24h', c3.claimed_at, false, 'SMTP caído'), { ok: true, will_retry: false, gave_up: true, attempts: 3 });
    assert.deepEqual((await claim('2026-11-08T09:45:00Z')).filter(x => x.booking_id === b.id), [], 'tras gave_up ya no se reclama');
    log = await q(`select status from email_log where booking_id=$1 and kind='reminder_24h'`, [b.id]);
    assert.equal(log.filter(l => l.status === 'failed').length, 4, '3 fallos reales + el reporte ajeno');
    // el fallo del de 24 h no afecta al de 1 h
    const one = (await claim('2026-11-09T08:00:00Z')).find(x => x.booking_id === b.id);
    assert.equal(one.kind, '1h'); assert.equal(one.attempt, 1);
    // camino feliz: queda 'sent' y no se reclama de nuevo
    assert.deepEqual(await report(b.id, '1h', one.claimed_at, true, null), { ok: true, will_retry: false, gave_up: false });
    assert.deepEqual((await q(`select kind,status from email_log where booking_id=$1 order by id desc limit 1`, [b.id]))[0], { kind: 'reminder_1h', status: 'sent' });
    assert.deepEqual((await claim('2026-11-09T08:15:00Z')).filter(x => x.booking_id === b.id), []);
    assert.equal((await report(b.id, 'raro', '2000-01-01T00:00:00Z', true)).error, 'INVALID_KIND');
  });

  await test('T53 un turno movido recibe recordatorios nuevos para su nueva hora (los de la antigua no cuentan)', async () => {
    const s = await newService({ break: 0 });
    const r = await book(s, await L('2026-11-16', '10:00'), 'mv@x.com', '2026-11-10T08:00:00Z');
    await q(`update bookings set created_at='2026-10-01T00:00:00Z' where id=$1`, [r.booking_id]);
    assert.equal((await claim('2026-11-15T09:00:00Z')).filter(x => x.booking_id === r.booking_id).length, 1);   // 24 h del día 16
    assert.equal((await resched(r.management_code, await L('2026-11-24', '10:00'), '2026-11-15T10:00:00Z')).ok, true);
    assert.deepEqual((await claim('2026-11-16T08:00:00Z')).filter(x => x.booking_id === r.booking_id), [], 'la hora vieja ya no genera recordatorios');
    const n = (await claim('2026-11-23T09:00:00Z')).filter(x => x.booking_id === r.booking_id);
    assert.deepEqual(n.map(x => [x.kind, x.local_date, x.local_time]), [['24h', '2026-11-24', '10:00']]);
  });

  // ---------------- Resumen diario ----------------
  await q('delete from bookings');

  await test('T54 resumen diario: no sale antes de las 08:00 (Madrid), a las 08:00 lista SOLO los confirmados del día ordenados por hora (todos los servicios), y no repite', async () => {
    const a = await newService({ break: 0, name: 'Servicio A' }), b = await newService({ break: 0, name: 'Servicio B' });
    await mk(b, await L(TUE, '12:00'), 'z@x.com', { name: 'Zoe' });
    await mk(a, await L(TUE, '16:30'), 'y@x.com', { name: 'Yago' });
    await mk(a, await L(TUE, '09:30'), 'x@x.com', { name: 'Xavi' });
    await mk(b, await L(TUE, '10:00'), 'w@x.com', { name: 'Wanda', status: 'cancelled' });
    await mk(a, await L(TUE, '11:00'), 'v@x.com', { name: 'Vera', status: 'attended' });
    await mk(a, await L('2026-11-11', '09:00'), 'u@x.com', { name: 'Ulises' });                    // otro día
    assert.deepEqual(await summary('2026-11-10T06:59:00Z'), { due: false, reason: 'TOO_EARLY' });  // 07:59 local
    const r = await summary('2026-11-10T07:00:00Z');                                              // 08:00 local
    assert.equal(r.due, true); assert.equal(r.send, true); assert.equal(r.count, 3); assert.equal(r.local_date, TUE);
    assert.deepEqual(r.bookings.map(x => [x.local_time, x.service_name, x.customer_name, x.customer_phone, x.customer_email]),
      [['09:30', 'Servicio A', 'Xavi', '+34 600 111 222', 'x@x.com'], ['12:00', 'Servicio B', 'Zoe', '+34 600 111 222', 'z@x.com'], ['16:30', 'Servicio A', 'Yago', '+34 600 111 222', 'y@x.com']]);
    assert.deepEqual(await summary('2026-11-10T07:15:00Z'), { due: false, reason: 'ALREADY_DONE' });
    assert.deepEqual(await summary('2026-11-10T16:00:00Z'), { due: false, reason: 'ALREADY_DONE' });
    assert.equal((await summary('2026-11-11T07:00:00Z')).count, 1);   // día siguiente: vuelve a tocar
  });

  await test('T55 el "día" del resumen es el día LOCAL aunque tenga 25 h: el domingo 25-oct-2026 incluye 00:30 y 23:30 locales, pero no el 00:30 del lunes', async () => {
    const s = await newService({ break: 0 });
    await mk(s, '2026-10-24T22:30:00Z', 'd1@x.com', { name: 'Madrugada' });     // 00:30 CEST del 25
    await mk(s, '2026-10-25T22:30:00Z', 'd2@x.com', { name: 'Noche' });         // 23:30 CET del 25
    await mk(s, '2026-10-25T23:30:00Z', 'd3@x.com', { name: 'Lunes' });         // 00:30 CET del 26
    const r = await summary('2026-10-25T07:00:00Z');                            // 08:00 CET
    assert.deepEqual(r.bookings.map(x => [x.local_time, x.customer_name]), [['00:30', 'Madrugada'], ['23:30', 'Noche']]);
  });

  await test('T56 CARRERA del resumen: 6 ejecuciones simultáneas a las 08:00 -> exactamente UNA recibe due=true; las demás ALREADY_DONE', async () => {
    const clients = await Promise.all(Array.from({ length: 6 }, () => newClient()));
    for (const day of ['2026-11-12', '2026-11-13']) {
      const out = await Promise.all(clients.map(c => summary(`${day}T07:00:00Z`, c)));
      assert.equal(out.filter(o => o.due).length, 1, JSON.stringify(out));
      assert.ok(out.filter(o => !o.due).every(o => o.reason === 'ALREADY_DONE'));
    }
    assert.equal((await q(`select count(*)::int n from daily_summary_log where day in ('2026-11-12','2026-11-13')`))[0].n, 2);
    await Promise.all(clients.map(c => c.end()));
  });

  await test('T57 día sin turnos: por defecto se envía un aviso breve (count 0); con daily_summary_send_empty=false no se envía nada y tampoco se reintenta', async () => {
    const r = await summary('2026-11-19T07:00:00Z');
    assert.deepEqual([r.due, r.send, r.count, r.bookings], [true, true, 0, []]);
    await q(`update settings set value='false' where key='daily_summary_send_empty'`);
    const r2 = await summary('2026-11-20T07:00:00Z');
    assert.deepEqual([r2.due, r2.send, r2.count], [true, false, 0]);
    assert.equal((await q(`select status from daily_summary_log where day='2026-11-20'`))[0].status, 'skipped');
    assert.deepEqual(await summary('2026-11-20T07:30:00Z'), { due: false, reason: 'ALREADY_DONE' });
    const s = await newService({ break: 0 }); await mk(s, await L('2026-11-23', '10:00'), 'q@x.com');   // con turnos sí se envía
    assert.equal((await summary('2026-11-23T07:00:00Z')).send, true);
    await q(`update settings set value='true' where key='daily_summary_send_empty'`);
  });

  await test('T58 fallo del resumen: constancia en email_log, reintento en la pasada siguiente (máx. 3 intentos) y aviso final; si se envía, queda "sent"', async () => {
    const day = '2026-11-24';
    assert.equal((await summary(`${day}T07:00:00Z`)).attempt, 1);
    assert.deepEqual(await reportSummary(day, false, 'SMTP caído'), { ok: true, will_retry: true, gave_up: false });
    assert.equal((await q(`select status from daily_summary_log where day=$1`, [day]))[0].status, 'retry');
    const r2 = await summary(`${day}T07:15:00Z`); assert.equal(r2.attempt, 2);
    assert.deepEqual(await summary(`${day}T07:15:00Z`), { due: false, reason: 'ALREADY_DONE' }, 'mientras se reintenta nadie más lo envía');
    assert.equal((await reportSummary(day, false, 'SMTP caído')).will_retry, true);
    assert.equal((await summary(`${day}T07:30:00Z`)).attempt, 3);
    assert.deepEqual(await reportSummary(day, false, 'SMTP caído'), { ok: true, will_retry: false, gave_up: true });
    assert.deepEqual(await summary(`${day}T07:45:00Z`), { due: false, reason: 'ALREADY_DONE' });
    const log = await q(`select status, error from email_log where kind='daily_summary' and to_email='staff@x.com' order by id desc limit 3`);
    assert.ok(log.length === 3 && log.every(l => l.status === 'failed' && l.error === 'SMTP caído'));
    const row = (await q(`select status, attempts, last_error from daily_summary_log where day=$1`, [day]))[0];
    assert.deepEqual([row.status, row.attempts, row.last_error], ['failed', 3, 'SMTP caído']);
    await summary('2026-11-25T07:00:00Z');   // camino feliz
    assert.deepEqual(await reportSummary('2026-11-25', true, null, '2026-11-25T07:00:05Z'), { ok: true, will_retry: false, gave_up: false });
    const ok = (await q(`select status, iso_utc(sent_at) s from daily_summary_log where day='2026-11-25'`))[0];
    assert.deepEqual([ok.status, ok.s], ['sent', '2026-11-25T07:00:05Z']);
    assert.deepEqual((await q(`select status from email_log where kind='daily_summary' order by id desc limit 1`))[0], { status: 'sent' });
  });

  await test('T59 hora del resumen configurable (daily_summary_time); un valor inválido cae a 08:00; staff_email vacío usa admin_email', async () => {
    await q(`update settings set value='09:30' where key='daily_summary_time'`);
    assert.equal((await summary('2026-11-26T08:29:00Z')).reason, 'TOO_EARLY');     // 09:29 local
    assert.equal((await summary('2026-11-26T08:30:00Z')).due, true);               // 09:30 local
    await q(`update settings set value='mañana' where key='daily_summary_time'`);
    assert.equal((await summary('2026-11-27T06:59:00Z')).reason, 'TOO_EARLY');
    assert.equal((await summary('2026-11-27T07:00:00Z')).due, true);
    await q(`update settings set value='08:00' where key='daily_summary_time'`);
    const cfg = async () => (await q('select get_config() as v'))[0].v;
    await q(`update settings set value='admin@x.com' where key='admin_email'`);
    assert.equal((await cfg()).staff_email, 'admin@x.com');
    await q(`update settings set value='  atiende@x.com ' where key='staff_email'`);
    assert.equal((await cfg()).staff_email, 'atiende@x.com');
    await q(`update settings set value='' where key='staff_email'`);
  });

  await test('T60 seguridad de lo nuevo: ninguna función de public es ejecutable por anon/authenticated/PUBLIC, la tabla nueva tiene RLS, y service_role llama a las 7 RPC nuevas', async () => {
    const fns = await q(`select p.oid::regprocedure::text as sig,
                                has_function_privilege('anon', p.oid, 'execute') as anon,
                                has_function_privilege('authenticated', p.oid, 'execute') as auth
                           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype`);
    assert.ok(fns.length > 30, 'se esperaban muchas funciones, hay ' + fns.length);
    assert.deepEqual(fns.filter(f => f.anon || f.auth).map(f => f.sig), []);
    const c = await newClient();
    await c.query('set role anon');
    for (const sql of ['select * from daily_summary_log', `select claim_due_reminders()`, `select claim_daily_summary()`, `select reschedule_booking('${'a'.repeat(64)}', now())`,
                       `select get_reschedule_info('${'a'.repeat(64)}')`, `select report_reminder(null,'24h',now(),true)`])
      await expectError(async () => c.query(sql), '42501');
    await c.end();
    const sr = await newClient(); await sr.query('set role service_role');
    for (const sql of [`select get_reschedule_info('${'a'.repeat(64)}')`, `select get_reschedule_availability('${'a'.repeat(64)}', current_date)`, `select reschedule_booking('${'a'.repeat(64)}', now())`,
                       `select claim_due_reminders()`, `select report_reminder(null,'raro',now(),true)`, `select report_daily_summary(current_date, true)`])
      await sr.query(sql);
    assert.notEqual((await sr.query(`select claim_daily_summary() as r`)).rows[0].r.due, undefined);
    await sr.end();
  });

  // ============================================================
  // FASE 3 · enlaces cortos, estadísticas y bloqueos
  // ============================================================
  const FORM_URL = 'https://reservas.rocketnova.io/form/reservar-turno';
  await q(`update settings set value=$1 where key='booking_form_url'`, [FORM_URL]);
  const setSetting = (key, value) => q(`update settings set value=$2 where key=$1`, [key, value]);
  const getSetting = async (key) => (await q(`select value from settings where key=$1`, [key]))[0].value;
  /** ejecuta fn con un ajuste cambiado y lo restaura SIEMPRE */
  const withSetting = async (key, value, fn) => {
    const old = await getSetting(key);
    await setSetting(key, value);
    try { return await fn(); } finally { await setSetting(key, old); }
  };
  const mkLink = async (slug, dest = FORM_URL, ch = null) => (await q(`select create_link($1,$2,$3) as r`, [slug, dest, ch]))[0].r;
  const resolve = async (slug) => (await q(`select resolve_link($1) as r`, [slug]))[0].r;
  const click = async (slug, now = NOW) => (await q(`select _register_click($1,$2::timestamptz) as r`, [slug, now]))[0].r;
  const counts = async (slug) => (await q(
    `select l.click_count::int as total, coalesce((select sum(d.clicks) from link_clicks_daily d where d.link_id = l.id), 0)::int as daily
       from links l where l.slug = $1`, [slug]))[0];
  const destErr = async (u) => (await q(`select _link_destination_error($1) as e`, [u]))[0].e;
  /** alta "a mano" (como desde el panel): sin las reglas de la reserva */
  const ins = async (svc, email, startUtc, o = {}) => (await q(
    `insert into bookings(service_id, customer_name, customer_email, customer_phone, starts_at, consent_given, status, created_at)
     values ($1, 'Cliente Test', $2, '+34 600 111 222', $3::timestamptz, true, $4, coalesce($5::timestamptz, now())) returning id`,
    [svc, email, startUtc, o.status ?? 'confirmed', o.created ?? null]))[0].id;

  // ---------------- Enlaces: slug ----------------
  await test('T61 slug: solo minúsculas, números y guiones (sin guion al principio/final ni dobles, 1-40); lo demás se rechaza sin crear nada y sin corregir en silencio', async () => {
    const good = ['instagram', 'a', 'a1', 'mi-campana-2', '2026', 'x-y-z', 'a'.repeat(40)];
    const bad = ['Instagram', 'INSTAGRAM', '-x', 'x-', 'a--b', 'a b', 'a_b', 'ñandú', '', '   ', null, 'a'.repeat(41),
      '../x', 'a/b', 'a.b', 'a?b=1', 'a%20b', 'a\tb', 'a\nb', "x'; drop table links;--", '<b>', 'instagram/', '/instagram', 'ａｂｃ'];
    for (const s of good) { const r = await mkLink(s); assert.equal(r.ok, true, `${s}: ${JSON.stringify(r)}`); assert.equal(r.slug, s); }
    const before = (await q('select count(*)::int n from links'))[0].n;
    for (const s of bad) { const r = await mkLink(s); assert.deepEqual([s, r.ok, r.error], [s, false, 'INVALID_SLUG']); }
    assert.equal((await q('select count(*)::int n from links'))[0].n, before, 'un slug inválido no debe crear nada');
    const padded = await mkLink('  con-espacios  ');
    assert.equal(padded.slug, 'con-espacios', 'los espacios de los extremos sí se recortan');
    // el canal tiene el mismo formato
    assert.equal((await mkLink('canal-malo', FORM_URL, 'Social Media')).error, 'INVALID_CHANNEL');
    assert.equal((await mkLink('canal-bueno', FORM_URL, 'social-media')).channel, 'social-media');
    assert.equal((await q(`select 1 from links where slug='canal-malo'`)).length, 0);
  });

  await test('T62 slug único: el segundo intento falla con SLUG_TAKEN; y si 8 personas crean el MISMO slug a la vez, solo una lo consigue', async () => {
    assert.equal((await mkLink('unico')).ok, true);
    assert.equal((await mkLink('unico')).error, 'SLUG_TAKEN');
    assert.equal((await mkLink('unico', 'https://rocketnova.io/otro')).error, 'SLUG_TAKEN');
    assert.equal((await q(`select count(*)::int n from links where slug='unico'`))[0].n, 1);
    assert.equal((await q(`select destination from links where slug='unico'`))[0].destination, FORM_URL, 'el original no se toca');
    const cs = await Promise.all(Array.from({ length: 8 }, () => newClient()));
    const out = await Promise.all(cs.map(c => c.query(`select create_link('carrera-slug', $1) as r`, [FORM_URL]).then(x => x.rows[0].r)));
    await Promise.all(cs.map(c => c.end()));
    assert.equal(out.filter(r => r.ok).length, 1, JSON.stringify(out));
    assert.equal(out.filter(r => r.error === 'SLUG_TAKEN').length, 7);
    assert.equal((await q(`select count(*)::int n from links where slug='carrera-slug'`))[0].n, 1);
  });

  // ---------------- Enlaces: destino (redirección abierta) ----------------
  await test('T63 destino: NINGÚN truco de redirección abierta pasa (otro dominio, subdominio falso, @, \\, esquemas, //, Unicode, espacios, IP...) y los destinos legítimos sí', async () => {
    const EVIL = [
      'https://evil.com', 'https://evil.com/rocketnova.io', 'https://evil.com/?u=https://rocketnova.io',
      'https://rocketnova.io.evil.com', 'https://rocketnova.io-evil.com', 'https://evilrocketnova.io', 'https://notrocketnova.io',
      'https://rocketnova.io@evil.com', 'https://evil.com@rocketnova.io', 'https://rocketnova.io:443@evil.com/', 'https://user:pass@rocketnova.io',
      'https://evil.com#@rocketnova.io', 'https://evil.com?x=@rocketnova.io', 'https://rocketnova.io%2f@evil.com',
      'https://evil.com\\.rocketnova.io', 'https:\\\\evil.com', 'https://rocketnova.io\\@evil.com', '/\\evil.com',
      '//evil.com', '///evil.com', '////evil.com', '/evil', 'evil.com', 'rocketnova.io', 'www.rocketnova.io', '/reservar',
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', 'file:///etc/passwd', 'ftp://rocketnova.io', 'mailto:a@b.co',
      'http://rocketnova.io', 'HTTP://ROCKETNOVA.IO', 'https:/rocketnova.io', 'https:rocketnova.io', 'https:///rocketnova.io', 'https://',
      'https://rocketnova.io.', 'https://.rocketnova.io', 'https://rocketnova..io', 'https://-rocketnova.io', 'https://rocketnova.io:/x', 'https://rocketnova.io:99999999/',
      'https://rocketnova.io/\tx', 'https://rocketnova.io/\nx', 'https://rocketnova.io/\r\nLocation: https://evil.com', 'https://rocketnova.io/x y', ' https://rocketnova.io', 'https://rocketnova.io ',
      'https://rocketnova.io/ñ', 'https://rocketnova.io／evil.com', 'https://rocketnova.іо', 'https://ɾocketnova.io', 'https://xn--rocketnova-x.io',
      'https://127.0.0.1/', 'https://localhost/', 'http://localhost/', 'http://127.0.0.1:5678/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/',
      'https://io', 'https://com', 'https://rocketnova', 'https://rocketnova.io.com',
      'https://rocketnova.io/<script>', 'https://rocketnova.io/"onload=alert(1)', "https://rocketnova.io/'x", 'https://rocketnova.io/`x', 'https://rocketnova.io/{x}', 'https://rocketnova.io/|x', 'https://rocketnova.io/^x',
      '', null, 'https://' + 'a'.repeat(2000) + '.rocketnova.io', 'https://rocketnova.io/' + 'a'.repeat(2000),
    ];
    for (const u of EVIL) assert.equal(await destErr(u), 'DESTINATION_NOT_ALLOWED', `debería rechazarse: ${JSON.stringify(u)}`);
    const GOOD = ['https://rocketnova.io', 'https://rocketnova.io/', 'https://rocketnova.io/reservar?utm_source=x&utm_medium=y',
      'https://reservas.rocketnova.io/form/reservar-turno', 'https://a.b.rocketnova.io/x#frag', 'HTTPS://ROCKETNOVA.IO/Path',
      'https://rocketnova.io:8443/x', 'https://rocketnova.io/ruta%20con%20espacio', 'https://rocketnova.io/?q=a+b', 'https://rocketnova.io/x?otroorigen=1', 'https://rocketnova.io/origen=1'];
    for (const u of GOOD) assert.equal(await destErr(u), null, `debería aceptarse: ${u}`);
    // bucle: el propio dominio de los enlaces cortos
    for (const u of ['https://l.rocketnova.io/instagram', 'https://L.ROCKETNOVA.IO', 'https://l.rocketnova.io:8443/x'])
      assert.equal(await destErr(u), 'DESTINATION_LOOP', u);
    // el sistema añade origen=: uno ya escrito sería ambiguo
    for (const u of ['https://rocketnova.io/x?origen=tiktok', 'https://rocketnova.io/x?a=1&origen=x', 'https://rocketnova.io/x?ORIGEN=x'])
      assert.equal(await destErr(u), 'DESTINATION_HAS_ORIGEN', u);
  });

  await test('T64 la lista de dominios manda: se puede editar (comas, espacios, comodín), no admite "com"/"io" sueltos, vacía no permite nada, y http solo vale para localhost', async () => {
    await withSetting('link_allowed_domains', 'rocketnova.io, midominio.es;otro.com\n*.wild.net .dot.org io com', async () => {
      for (const u of ['https://midominio.es/x', 'https://www.otro.com', 'https://wild.net', 'https://x.wild.net/a', 'https://dot.org', 'https://a.dot.org'])
        assert.equal(await destErr(u), null, u);
      for (const u of ['https://foo.com', 'https://evil.io', 'https://iofoo.com', 'https://notmidominio.es', 'https://wild.net.evil.com'])
        assert.equal(await destErr(u), 'DESTINATION_NOT_ALLOWED', u);
    });
    await withSetting('link_allowed_domains', '', async () => { assert.equal(await destErr('https://rocketnova.io'), 'DESTINATION_NOT_ALLOWED'); });
    await withSetting('link_allowed_domains', 'rocketnova.io localhost 127.0.0.1', async () => {
      for (const u of ['http://localhost:5678/form/x', 'https://localhost/', 'http://127.0.0.1:5678/x']) assert.equal(await destErr(u), null, u);
      for (const u of ['http://localhost.evil.com/', 'http://sub.localhost/', 'http://rocketnova.io/', 'http://reservas.rocketnova.io/'])
        assert.equal(await destErr(u), 'DESTINATION_NOT_ALLOWED', u);
    });
    assert.equal(await destErr('http://localhost/'), 'DESTINATION_NOT_ALLOWED', 'restaurado: localhost ya no está permitido');
  });

  await test('T65 create_link con destino: vacío = formulario de reserva; destinos malos se rechazan sin crear nada', async () => {
    const r = await mkLink('dest-vacio', null);
    assert.equal(r.ok, true); assert.equal(r.destination, FORM_URL);
    assert.equal(r.short_url, 'https://l.rocketnova.io/dest-vacio');
    assert.equal((await mkLink('dest-blanco', '   ')).destination, FORM_URL);
    for (const [slug, dest, err] of [['d-evil', 'https://evil.com/x', 'DESTINATION_NOT_ALLOWED'], ['d-js', 'javascript:alert(1)', 'DESTINATION_NOT_ALLOWED'],
        ['d-loop', 'https://l.rocketnova.io/otro', 'DESTINATION_LOOP'], ['d-origen', 'https://rocketnova.io/?origen=x', 'DESTINATION_HAS_ORIGEN']]) {
      const x = await mkLink(slug, dest); assert.deepEqual([slug, x.ok, x.error], [slug, false, err]);
      assert.equal((await q(`select 1 from links where slug=$1`, [slug])).length, 0);
    }
    // si el formulario de reserva configurado no es válido, "destino vacío" falla con un motivo claro
    await withSetting('booking_form_url', 'https://TU-N8N/form/reservar-turno', async () => {
      assert.equal((await mkLink('d-sin-config', null)).error, 'DESTINATION_NOT_ALLOWED');
    });
    assert.equal((await q(`select 1 from links where slug='d-sin-config'`)).length, 0);
  });

  await test('T66 las altas y ediciones a mano en el panel pasan por las mismas reglas: destino, slug inmutable y formato', async () => {
    await expectError(() => q(`insert into links(slug,destination) values ('panel-evil','https://evil.com')`), '23514');
    await expectError(() => q(`insert into links(slug,destination) values ('Panel-Mayus','${FORM_URL}')`), '23514');
    await expectError(() => q(`insert into links(slug,destination) values ('panel-ok','${FORM_URL}?origen=x')`), '23514');
    await expectError(() => q(`insert into links(slug,destination,channel) values ('panel-ch','${FORM_URL}','Mal Canal')`), '23514');
    await q(`insert into links(slug,destination) values ('panel-ok','${FORM_URL}')`);
    await expectError(() => q(`update links set destination='https://evil.com' where slug='panel-ok'`), '23514');
    await expectError(() => q(`update links set slug='panel-otro' where slug='panel-ok'`), '23000');
    await expectError(() => q(`update links set click_count = -1 where slug='panel-ok'`), '23514');
    await q(`update links set destination='https://rocketnova.io/nuevo' where slug='panel-ok'`);
    assert.equal((await q(`select destination from links where slug='panel-ok'`))[0].destination, 'https://rocketnova.io/nuevo');
    // y los clics siguen sumando aunque la lista de dominios cambie después (el trigger no se dispara con click_count)
    await withSetting('link_allowed_domains', 'rocketnova.io wild.net', async () => { assert.equal((await mkLink('panel-viejo', 'https://x.wild.net/p')).ok, true); });
    assert.equal((await click('panel-viejo')).counted, true);
  });

  // ---------------- Enlaces: resolver ----------------
  await test('T67 resolve_link: destino + origen=<slug> (antes del #fragmento), sin distinguir mayúsculas en la URL, y no modifica nada', async () => {
    await mkLink('rs-simple', 'https://rocketnova.io/reservar');
    await mkLink('rs-query', 'https://reservas.rocketnova.io/f?utm=1&x=2');
    await mkLink('rs-frag', 'https://rocketnova.io/x#arriba');
    await mkLink('rs-both', 'https://rocketnova.io/x?a=1#arriba');
    await mkLink('rs-form');          // destino por defecto = formulario de reserva
    const before = await q(`select slug, click_count from links order by slug`);
    assert.deepEqual(await resolve('rs-simple'), { ok: true, found: true, slug: 'rs-simple', url: 'https://rocketnova.io/reservar?origen=rs-simple' });
    assert.equal((await resolve('rs-query')).url, 'https://reservas.rocketnova.io/f?utm=1&x=2&origen=rs-query');
    assert.equal((await resolve('rs-frag')).url, 'https://rocketnova.io/x?origen=rs-frag#arriba');
    assert.equal((await resolve('rs-both')).url, 'https://rocketnova.io/x?a=1&origen=rs-both#arriba');
    assert.equal((await resolve('rs-form')).url, `${FORM_URL}?origen=rs-form`);
    assert.equal((await resolve('RS-SIMPLE')).found, true);
    assert.equal((await resolve('  rs-simple ')).found, true);
    assert.deepEqual(await q(`select slug, click_count from links order by slug`), before, 'resolver no cuenta clics');
  });

  await test('T68 resolve_link con slug inexistente, desactivado o raro: página por defecto, nunca un error; el destino se revalida en cada clic', async () => {
    const DEF = 'https://rocketnova.io';
    await mkLink('rs-off', 'https://rocketnova.io/off'); await q(`update links set active=false where slug='rs-off'`);
    const none = { ok: true, found: false, url: DEF };
    assert.deepEqual(await resolve('rs-off'), none);
    assert.deepEqual(await resolve('no-existe'), none);
    for (const s of [null, '', '   ', '../etc/passwd', 'a b', "x' or '1'='1", '<script>', 'a'.repeat(10000), 'ñ', 'a--b', '-', '%00', '😀', 'rs-simple/../x'])
      assert.deepEqual(await resolve(s), none, JSON.stringify(s)?.slice(0, 40));
    // la página por defecto también se valida
    await withSetting('link_default_url', 'https://evil.com', async () => { assert.deepEqual(await resolve('no-existe'), { ok: true, found: false, url: null }); });
    await withSetting('link_default_url', 'https://l.rocketnova.io', async () => { assert.equal((await resolve('no-existe')).url, null, 'bucle'); });
    await withSetting('link_default_url', 'https://rocketnova.io/hola', async () => { assert.equal((await resolve('no-existe')).url, 'https://rocketnova.io/hola'); });
    // un destino que ya no está permitido (se acortó la lista) NO se redirige: va a la página por defecto
    await withSetting('link_allowed_domains', 'rocketnova.io wild.net', async () => {
      assert.equal((await mkLink('rs-wild', 'https://x.wild.net/p')).ok, true);
      assert.deepEqual(await resolve('rs-wild'), { ok: true, found: true, slug: 'rs-wild', url: 'https://x.wild.net/p?origen=rs-wild' });
    });
    assert.deepEqual(await resolve('rs-wild'), none, 'wild.net ya no está permitido');
  });

  // ---------------- Clics ----------------
  await test('T69 un clic suma exactamente 1 (total y día local); solo cuentan enlaces que existen y están activos', async () => {
    await mkLink('ck-uno');
    assert.deepEqual(await click('ck-uno'), { ok: true, counted: true });
    assert.deepEqual(await counts('ck-uno'), { total: 1, daily: 1 });
    for (let i = 0; i < 3; i++) await click('ck-uno');
    assert.deepEqual(await counts('ck-uno'), { total: 4, daily: 4 });
    assert.equal((await click('CK-UNO')).counted, true, 'el slug de la URL no distingue mayúsculas');
    assert.deepEqual(await counts('ck-uno'), { total: 5, daily: 5 });
    // desactivado, inexistente o raro: ni cuenta ni falla
    await mkLink('ck-off'); await q(`update links set active=false where slug='ck-off'`);
    for (const s of ['ck-off', 'no-existe', null, '', '../x', 'A B', 'a'.repeat(500), "x'--"]) assert.deepEqual(await click(s), { ok: true, counted: false }, String(s).slice(0, 30));
    assert.deepEqual(await counts('ck-off'), { total: 0, daily: 0 });
    // el día es el día LOCAL de Madrid (CET en noviembre): 22:30Z = 23:30 del día 2; 23:30Z = 00:30 del día 3
    await mkLink('ck-dia');
    for (const t of ['2026-11-02T22:30:00Z', '2026-11-02T23:30:00Z', '2026-11-02T23:45:00Z']) await click('ck-dia', t);
    assert.deepEqual(await q(`select d.day, d.clicks::int as clicks from link_clicks_daily d join links l on l.id = d.link_id where l.slug = 'ck-dia' order by d.day`),
      [{ day: '2026-11-02', clicks: 1 }, { day: '2026-11-03', clicks: 2 }]);
    assert.equal((await q(`select iso_utc(last_click_at) as t from links where slug='ck-dia'`))[0].t, '2026-11-02T23:45:00Z');
  });

  await test('T70 CARRERA: 20 conexiones × 10 clics a la vez sobre el MISMO enlace = 200 exactos, y el total coincide con la suma por días', async () => {
    await mkLink('ck-carrera');
    const cs = await Promise.all(Array.from({ length: 20 }, () => newClient()));
    const res = await Promise.all(cs.map(async (c, i) => {
      const out = [];
      for (let k = 0; k < 10; k++) out.push((await c.query(`select _register_click('ck-carrera', $1::timestamptz) as r`, [i % 2 ? '2026-11-02T10:00:00Z' : '2026-11-03T10:00:00Z'])).rows[0].r.counted);
      return out;
    }));
    await Promise.all(cs.map(c => c.end()));
    assert.ok(res.flat().every(x => x === true) && res.flat().length === 200);
    assert.deepEqual(await counts('ck-carrera'), { total: 200, daily: 200 });
    assert.deepEqual(await q(`select d.day, d.clicks::int as clicks from link_clicks_daily d join links l on l.id = d.link_id where l.slug = 'ck-carrera' order by d.day`),
      [{ day: '2026-11-02', clicks: 100 }, { day: '2026-11-03', clicks: 100 }]);
  });

  await test('T71 CONTROL NEGATIVO: un contador ingenuo (leer y luego escribir) PIERDE clics con las mismas conexiones -> T70 detectaría el fallo', async () => {
    await mkLink('ck-ingenuo');
    const cs = await Promise.all(Array.from({ length: 8 }, () => newClient()));
    await Promise.all(cs.map(async (c) => {
      for (let k = 0; k < 5; k++) {
        const v = Number((await c.query(`select click_count from links where slug='ck-ingenuo'`)).rows[0].click_count);
        await sleep(15);
        await c.query(`update links set click_count = $1 where slug='ck-ingenuo'`, [v + 1]);
      }
    }));
    await Promise.all(cs.map(c => c.end()));
    const total = (await counts('ck-ingenuo')).total;
    assert.ok(total < 40, `el enfoque ingenuo debería perder clics (quedó en ${total} de 40)`);
  });

  // ---------------- Seguridad ----------------
  await test('T72 seguridad de los enlaces: RLS, anon/authenticated no pueden leer, escribir ni tocar el contador, y solo service_role ejecuta las RPC', async () => {
    const rls = await q(`select relname, relrowsecurity from pg_class where relname in ('links','link_clicks_daily') and relnamespace = 'public'::regnamespace order by 1`);
    assert.deepEqual(rls, [{ relname: 'link_clicks_daily', relrowsecurity: true }, { relname: 'links', relrowsecurity: true }]);
    const before = await counts('ck-uno');
    for (const role of ['anon', 'authenticated']) {
      const c = await newClient(); await c.query(`set role ${role}`);
      for (const t of ['links', 'link_clicks_daily', 'stats_links', 'stats_channels', 'stats_clicks_daily', 'blocks_affected_bookings'])
        await expectError(() => c.query(`select * from ${t}`), '42501');
      await expectError(() => c.query(`update links set click_count = 999999 where slug = 'ck-uno'`), '42501');
      await expectError(() => c.query(`update links set destination = 'https://evil.com'`), '42501');
      await expectError(() => c.query(`insert into links(slug, destination) values ('hack', 'https://rocketnova.io')`), '42501');
      await expectError(() => c.query(`delete from links`), '42501');
      await expectError(() => c.query(`insert into link_clicks_daily(link_id, day, clicks) select id, current_date, 5 from links limit 1`), '42501');
      for (const sql of [`select create_link('x-${role}')`, `select resolve_link('ck-uno')`, `select register_click('ck-uno')`,
          `select _register_click('ck-uno', now())`, `select _link_destination_error('https://rocketnova.io')`,
          `select * from bookings_affected_by(null, now(), now() + interval '1 day')`])
        await expectError(() => c.query(sql), '42501');
      await c.end();
    }
    for (const f of ['links_guard()', 'bookings_normalize_source()'])
      assert.deepEqual((await q(`select has_function_privilege('anon', 'public.${f}', 'execute') a, has_function_privilege('authenticated', 'public.${f}', 'execute') b`))[0], { a: false, b: false });
    assert.deepEqual(await counts('ck-uno'), before, 'ningún intento externo movió el contador');
    // service_role (las credenciales de n8n) sí
    const sr = await newClient(); await sr.query('set role service_role');
    assert.equal((await sr.query(`select create_link('sr-ok') as r`)).rows[0].r.ok, true);
    assert.equal((await sr.query(`select resolve_link('sr-ok') as r`)).rows[0].r.found, true);
    assert.equal((await sr.query(`select register_click('sr-ok') as r`)).rows[0].r.counted, true);
    for (const t of ['stats_links', 'stats_channels', 'stats_clicks_daily', 'blocks_affected_bookings']) await sr.query(`select * from ${t}`);
    await sr.query(`select * from bookings_affected_by(null, now(), now() + interval '1 day')`);
    await sr.end();
  });

  await test('T73 bookings.source: se guarda en minúsculas si tiene forma de slug y, si no, se descarta (la reserva NUNCA falla por un origen raro)', async () => {
    const s = await newService({ break: 0 });
    const casos = [[' Instagram ', 'instagram'], ['my-campaign-2', 'my-campaign-2'], ['ST<script>', null], ['a'.repeat(41), null], ['', null], ['   ', null],
      ['Ñandú', null], ['a--b', null], ['A_B', null], ['a/b', null], [null, null], ['TikTok', 'tiktok']];
    const hours = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '16:00', '16:30'];
    for (const [i, [entrada, esperado]] of casos.entries()) {
      const r = await book(s, await L(MON, hours[i]), `src${i}@x.com`, NOW, { source: entrada });
      assert.equal(r.ok, true, JSON.stringify([entrada, r]));
      assert.equal((await q(`select source from bookings where id=$1`, [r.booking_id]))[0].source, esperado, JSON.stringify(entrada));
    }
    // la regla de la Fase 1 sigue: más de 100 caracteres = datos inválidos
    assert.deepEqual(await book(s, await L(MON, '17:00'), 'src-largo@x.com', NOW, { source: 'a'.repeat(101) }), { ok: false, error: 'INVALID_INPUT', field: 'source' });
    // y editar a mano en el panel también se normaliza
    const id = (await q(`select id from bookings where customer_email='src0@x.com'`))[0].id;
    await q(`update bookings set source=' TikTok ' where id=$1`, [id]);
    assert.equal((await q(`select source from bookings where id=$1`, [id]))[0].source, 'tiktok');
    await q(`update bookings set source='no vale' where id=$1`, [id]);
    assert.equal((await q(`select source from bookings where id=$1`, [id]))[0].source, null);
  });

  // ---------------- Estadísticas ----------------
  await test('T74 estadísticas coherentes: clics, reservas y conversión por enlace y por canal con datos de prueba conocidos (y la suma de canales = todas las reservas)', async () => {
    const s = await newService({ break: 0 });
    await mkLink('st-ig'); await mkLink('st-fb', FORM_URL, 'st-social'); await mkLink('st-tt', FORM_URL, 'st-social'); await mkLink('st-nl');
    for (const [slug, n] of [['st-ig', 10], ['st-fb', 6], ['st-tt', 4]]) for (let i = 0; i < n; i++) await click(slug);
    // 10 reservas en 10 huecos: ig×4 (una con mayúsculas y espacios), fb×2, tt×1, origen manual sin enlace×1, directas×2
    const plan = [' ST-IG ', 'st-ig', 'st-ig', 'st-ig', 'st-fb', 'st-fb', 'st-tt', 'st-manual', null, null];
    const ids = [], codes = [];
    for (const [i, src] of plan.entries()) {
      const r = await book(s, await L(MON, MORNING[i]), `st${i}@x.com`, NOW, { source: src });
      assert.equal(r.ok, true, JSON.stringify(r)); ids.push(r.booking_id); codes.push(r.management_code);
    }
    await cancel(codes[1], NOW);                                              // una de ig se cancela
    await q(`update bookings set status='attended' where id=$1`, [ids[2]]);    // otra de ig asistió
    const links = Object.fromEntries((await q(`select slug, channel, clicks::int clicks, bookings::int bookings, bookings_not_cancelled::int nc,
        bookings_cancelled::int cx, bookings_attended::int att, conversion_pct::float8 conv from stats_links where slug like 'st-%'`)).map(r => [r.slug, r]));
    assert.deepEqual(links['st-ig'], { slug: 'st-ig', channel: 'st-ig', clicks: 10, bookings: 4, nc: 3, cx: 1, att: 1, conv: 40 });
    assert.deepEqual(links['st-fb'], { slug: 'st-fb', channel: 'st-social', clicks: 6, bookings: 2, nc: 2, cx: 0, att: 0, conv: 33.3 });
    assert.deepEqual(links['st-tt'], { slug: 'st-tt', channel: 'st-social', clicks: 4, bookings: 1, nc: 1, cx: 0, att: 0, conv: 25 });
    assert.deepEqual(links['st-nl'], { slug: 'st-nl', channel: 'st-nl', clicks: 0, bookings: 0, nc: 0, cx: 0, att: 0, conv: null });
    const ch = Object.fromEntries((await q(`select channel, links::int links, clicks::int clicks, bookings::int bookings, bookings_cancelled::int cx, conversion_pct::float8 conv
        from stats_channels where channel like 'st-%' or channel = 'directo'`)).map(r => [r.channel, r]));
    assert.deepEqual(ch['st-ig'], { channel: 'st-ig', links: 1, clicks: 10, bookings: 4, cx: 1, conv: 40 });
    assert.deepEqual(ch['st-social'], { channel: 'st-social', links: 2, clicks: 10, bookings: 3, cx: 0, conv: 30 });
    assert.deepEqual(ch['st-nl'], { channel: 'st-nl', links: 1, clicks: 0, bookings: 0, cx: 0, conv: null });
    assert.deepEqual(ch['st-manual'], { channel: 'st-manual', links: 0, clicks: 0, bookings: 1, cx: 0, conv: null }, 'origen escrito a mano, sin enlace corto');
    assert.equal(ch['directo'].bookings, (await q(`select count(*)::int n from bookings where source is null`))[0].n, 'sin origen = directo');
    assert.equal(ch['directo'].conv, null);
    // coherencia global: ninguna reserva se pierde ni se cuenta dos veces, y los clics cuadran con la tabla
    assert.equal((await q(`select sum(bookings)::int n from stats_channels`))[0].n, (await q(`select count(*)::int n from bookings`))[0].n);
    assert.equal((await q(`select sum(clicks)::int n from stats_channels`))[0].n, (await q(`select sum(click_count)::int n from links`))[0].n);
    assert.equal((await q(`select sum(clicks)::int n from stats_clicks_daily where slug like 'st-%'`))[0].n, 20);
    // el total por día coincide con el contador de cada enlace
    assert.deepEqual(await q(`select l.slug from links l left join link_clicks_daily d on d.link_id = l.id where l.slug like 'st-%' group by l.id having l.click_count <> coalesce(sum(d.clicks), 0)`), []);
  });

  // ---------------- Bloqueos ----------------
  const FULL = [...MORNING, ...AFTERNOON];
  const dayRange = async (from, toExcl) => [await L(from, '00:00'), await L(toExcl, '00:00')];   // días LOCALES completos
  const block = async (svc, from, to, reason = 'test') => (await q(`insert into blocks(service_id,starts_at,ends_at,reason) values ($1,$2,$3,$4) returning id`, [svc, from, to, reason]))[0].id;

  await test('T75 VACACIONES (bloqueo global de varios días): ninguna hora de esos días, los días siguientes normales; y a media jornada solo quita lo que cae dentro', async () => {
    await q('delete from blocks');
    const a = await newService({ break: 0 }), b = await newService({ break: 0 });
    const [d0, d1] = await dayRange('2026-11-09', '2026-11-14');                       // lunes 9 a viernes 13, enteros
    await block(null, d0, d1, 'Vacaciones');
    for (const day of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'])
      for (const s of [a, b]) assert.deepEqual(await labels(s, day, NOW), [], `${day} debería estar cerrado`);
    assert.deepEqual(await labels(a, '2026-11-16', NOW), FULL, 'el lunes siguiente es normal');
    assert.deepEqual(await labels(a, '2026-11-06', NOW), MORNING, 'el viernes anterior (solo mañana) no se toca');
    // lo que ve la persona: sin horas y el primer día que se propone ya es posterior a las vacaciones
    const av = (await q(`select _get_availability($1,'2026-11-09'::date,$2::timestamptz) as r`, [a, NOW]))[0].r;
    assert.deepEqual(av.slots, []);
    assert.equal(av.next_days[0].day, '2026-11-16');
    // y reservar a la fuerza una hora de vacaciones se rechaza
    assert.equal((await book(a, await L('2026-11-10', '10:00'), 'vac@x.com', NOW)).error, 'SLOT_TAKEN');
    await q('delete from blocks');
    // media jornada: de jueves 12 a las 14:00 hasta lunes 16 a las 13:00
    await block(null, await L('2026-11-12', '14:00'), await L('2026-11-16', '13:00'), 'Escapada');
    assert.deepEqual(await labels(a, '2026-11-12', NOW), MORNING, 'el jueves queda la mañana (13:30-14:00 acaba justo cuando empieza el bloqueo)');
    assert.deepEqual(await labels(a, '2026-11-13', NOW), [], 'viernes cerrado');
    assert.deepEqual(await labels(a, '2026-11-16', NOW), ['13:00', '13:30', ...AFTERNOON], 'el lunes vuelve a las 13:00 (empieza justo cuando acaba el bloqueo)');
    await q('delete from blocks');
  });

  await test('T76 FESTIVOS (un día entero, global o de un solo servicio): ese día no ofrece horas; el día anterior y el posterior, sí', async () => {
    await q('delete from blocks');
    const a = await newService({ break: 0 }), b = await newService({ break: 0 });
    const [h0, h1] = await dayRange('2026-11-10', '2026-11-11');
    await block(null, h0, h1, 'Festivo local');
    for (const s of [a, b]) {
      assert.deepEqual(await labels(s, '2026-11-10', NOW), [], 'festivo global');
      assert.deepEqual(await labels(s, '2026-11-09', NOW), FULL);
      assert.deepEqual(await labels(s, '2026-11-11', NOW), FULL);
    }
    const [g0, g1] = await dayRange('2026-11-11', '2026-11-12');
    await block(a, g0, g1, 'Festivo solo del servicio A');
    assert.deepEqual(await labels(a, '2026-11-11', NOW), []);
    assert.deepEqual(await labels(b, '2026-11-11', NOW), FULL, 'el servicio B no se ve afectado');
    assert.deepEqual(await labels(a, '2026-11-12', NOW), FULL);
    // un festivo en domingo (cerrado) no hace nada; el domingo del cambio de hora de octubre (25 h) tampoco rompe nada
    const [s0, s1] = await dayRange('2026-10-25', '2026-10-26');
    assert.equal((await q(`select (extract(epoch from ($2::timestamptz - $1::timestamptz)) / 3600)::int as h`, [s0, s1]))[0].h, 25);
    await q('delete from blocks');
  });

  await test('T77 HUECOS SUELTOS (reunión, cita médica...): quitan SOLO las horas que tocan; los bordes exactos siguen libres; 5 minutos bastan para quitar una hora', async () => {
    await q('delete from blocks');
    const a = await newService({ break: 0 }), b = await newService({ break: 0 });
    const minus = (list, ...out) => list.filter(h => !out.includes(h));
    // 11:15-12:05 toca 11:00 (11:00-11:30), 11:30 y 12:00 (12:00-12:30 hasta las 12:05); no toca 10:30 ni 12:30
    await block(a, await L(MON, '11:15'), await L(MON, '12:05'), 'Cita');
    assert.deepEqual(await labels(a, MON, NOW), minus(FULL, '11:00', '11:30', '12:00'));
    assert.deepEqual(await labels(b, MON, NOW), FULL, 'otro servicio intacto');
    await q('delete from blocks');
    // bordes exactos: 11:00-11:30 quita solo las 11:00
    await block(a, await L(MON, '11:00'), await L(MON, '11:30'));
    assert.deepEqual(await labels(a, MON, NOW), minus(FULL, '11:00'));
    await q('delete from blocks');
    // 5 minutos dentro de una hora la quitan entera
    await block(a, await L(MON, '16:10'), await L(MON, '16:15'));
    assert.deepEqual(await labels(a, MON, NOW), minus(FULL, '16:00'));
    await q('delete from blocks');
    // varios huecos el mismo día, uno global y otro del servicio
    await block(null, await L(MON, '09:00'), await L(MON, '09:30'), 'Global');
    await block(a, await L(MON, '18:00'), await L(MON, '19:00'), 'Solo A');
    assert.deepEqual(await labels(a, MON, NOW), minus(FULL, '09:00', '18:00', '18:30'));
    assert.deepEqual(await labels(b, MON, NOW), minus(FULL, '09:00'));
    await q('delete from blocks');
  });

  await test('T78 los bloqueos son "vivos": acortarlos o borrarlos devuelve las horas; solapados se suman; y un bloqueo ya pasado o de otro día no estorba', async () => {
    await q('delete from blocks');
    const a = await newService({ break: 0 });
    const id = await block(a, await L(MON, '10:00'), await L(MON, '12:00'));
    assert.deepEqual(await labels(a, MON, NOW), FULL.filter(h => !['10:00', '10:30', '11:00', '11:30'].includes(h)));
    await q(`update blocks set ends_at = $2 where id = $1`, [id, await L(MON, '11:00')]);
    assert.deepEqual(await labels(a, MON, NOW), FULL.filter(h => !['10:00', '10:30'].includes(h)), 'al acortarlo vuelven las horas');
    await block(null, await L(MON, '10:30'), await L(MON, '11:30'));               // se solapa con el anterior
    assert.deepEqual(await labels(a, MON, NOW), FULL.filter(h => !['10:00', '10:30', '11:00'].includes(h)), 'dos bloqueos solapados = unión');
    await block(a, await L('2026-11-10', '09:00'), await L('2026-11-10', '14:00'));  // otro día
    await block(a, await L('2026-10-01', '09:00'), await L('2026-10-01', '14:00'));  // ya pasado
    assert.deepEqual(await labels(a, MON, NOW), FULL.filter(h => !['10:00', '10:30', '11:00'].includes(h)));
    assert.deepEqual(await labels(a, '2026-11-11', NOW), FULL);
    await q('delete from blocks');
    assert.deepEqual(await labels(a, MON, NOW), FULL, 'sin bloqueos, todo vuelve');
    const t10 = await L(MON, '10:00');
    await expectError(() => q(`insert into blocks(starts_at, ends_at) values ($1, $1)`, [t10]), '23514');   // un bloqueo debe durar algo
  });

  await test('T79 TURNOS AFECTADOS: la vista y bookings_affected_by() listan exactamente los turnos CONFIRMADOS y FUTUROS que se solapan con un bloqueo (parcial o total, de un servicio o global); nada más', async () => {
    await q('delete from blocks');
    const sA = await newService({ break: 0 }), sB = await newService({ break: 0 });
    const D = '2035-03-13';
    const at = (h) => L(D, h);
    const blk1 = await (async () => (await q(`insert into blocks(service_id,starts_at,ends_at,reason,created_at) values ($1,$2,$3,'Médico',$4) returning id`, [sA, await at('09:15'), await at('10:15'), '2035-01-01T00:00:00Z']))[0].id)();
    const blk2 = await (async () => (await q(`insert into blocks(service_id,starts_at,ends_at,reason,created_at) values (null,$1,$2,'Festivo',$3) returning id`, [await at('12:00'), await at('13:00'), '2035-01-01T00:00:00Z']))[0].id)();
    const blk3 = await (async () => (await q(`insert into blocks(service_id,starts_at,ends_at,reason,created_at) values ($1,$2,$3,'Obras',$4) returning id`, [sA, await at('14:00'), await at('15:00'), '2035-01-01T00:00:00Z']))[0].id)();
    const blk4 = await (async () => (await q(`insert into blocks(service_id,starts_at,ends_at,reason) values (null,$1,$2,'Pasado') returning id`, [await L('2020-03-10', '09:00'), await L('2020-03-10', '11:00')]))[0].id)();
    const mkb = {};
    const add = async (k, svc, h, o = {}) => { mkb[k] = await ins(svc, `afe-${k}@x.com`, await at(h), o); };
    await add('b4', sA, '08:45');                                   // acaba justo cuando empieza el bloqueo 1 -> NO
    await add('b1', sA, '09:15');                                   // dentro, empieza justo al empezar el bloqueo -> SÍ
    await add('b2', sA, '09:45');                                   // dentro, acaba justo al acabar -> SÍ
    await add('b3', sA, '10:15');                                   // empieza justo cuando acaba -> NO
    await add('b5', sA, '09:30', { status: 'cancelled' });          // cancelado -> NO
    await add('b9', sB, '09:30');                                   // otro servicio, bloqueo 1 es de A -> NO
    await add('b10', sA, '11:45');                                  // cruza el INICIO del bloqueo global 2 -> SÍ
    await add('b11', sB, '12:45');                                  // cruza el FIN del bloqueo global 2 (servicio B) -> SÍ
    await add('b8', sA, '12:30', { status: 'no_show' });            // no presentado -> NO
    await add('b13', sA, '14:00', { created: '2035-06-01T00:00:00Z' });   // reservado DESPUÉS de crear el bloqueo 3 -> SÍ (booked_before_block = false)
    await add('b6', sA, '14:30', { status: 'attended' });           // asistido -> NO
    mkb.b14 = await ins(sA, 'afe-b14@x.com', await L('2020-03-10', '10:00'));   // pasado -> NO
    const rows = await q(`select block_id, booking_id, booked_before_block, starts_local, block_starts_local, service_name from blocks_affected_bookings
                           where block_id = any($1)`, [[blk1, blk2, blk3, blk4]]);
    const key = (r) => `${r.block_id === blk1 ? 'blk1' : r.block_id === blk2 ? 'blk2' : r.block_id === blk3 ? 'blk3' : 'blk4'}:${Object.entries(mkb).find(([, v]) => v === r.booking_id)?.[0]}`;
    const byKey = Object.fromEntries(rows.map(r => [key(r), r]));
    assert.deepEqual(Object.keys(byKey).sort(), ['blk1:b1', 'blk1:b2', 'blk2:b10', 'blk2:b11', 'blk3:b13']);
    assert.equal(rows.length, 5, 'ni duplicados ni de más');
    assert.deepEqual(['blk1:b1', 'blk1:b2', 'blk2:b10', 'blk2:b11', 'blk3:b13'].map(k => byKey[k].booked_before_block), [true, true, true, true, false]);
    assert.equal(byKey['blk1:b1'].starts_local, '2035-03-13 09:15');
    assert.equal(byKey['blk1:b1'].block_starts_local, '2035-03-13 09:15');
    // y la misma lista ANTES de crear un bloqueo
    const ids = async (svc, from, to) => (await q(`select booking_id from bookings_affected_by($1, $2::timestamptz, $3::timestamptz)`, [svc, from, to])).map(r => r.booking_id).sort();
    assert.deepEqual(await ids(sA, await at('09:15'), await at('10:15')), [mkb.b1, mkb.b2].sort());
    assert.deepEqual(await ids(null, await at('12:00'), await at('13:00')), [mkb.b10, mkb.b11].sort(), 'null = todos los servicios');
    assert.deepEqual(await ids(sB, await at('12:00'), await at('13:00')), [mkb.b11]);
    assert.deepEqual(await ids(sA, await at('16:00'), await at('17:00')), []);
    // cuando el turno se cancela o se mueve fuera del bloqueo, deja de aparecer
    await q(`update bookings set status='cancelled' where id=$1`, [mkb.b1]);
    await q(`update bookings set starts_at=$2, ends_at=$3 where id=$1`, [mkb.b2, await at('16:00'), await at('16:30')]);
    assert.deepEqual((await q(`select booking_id from blocks_affected_bookings where block_id=$1`, [blk1])), []);
    await q('delete from blocks'); await q(`delete from bookings where customer_email like 'afe-%'`);
  });

  await test('T80 un bloqueo creado SOBRE turnos ya confirmados NO los borra ni los toca: siguen confirmados, la hora no se ofrece a nadie más y la persona aún puede cancelar o cambiarla (no a otra hora bloqueada)', async () => {
    await q('delete from blocks');
    const a = await newService({ break: 0 }), b = await newService({ break: 0 });
    const ra = await book(a, await L(MON, '10:00'), 'bl-a@x.com', NOW), ra2 = await book(a, await L(MON, '11:00'), 'bl-a2@x.com', NOW), rb = await book(b, await L(MON, '10:00'), 'bl-b@x.com', NOW);
    for (const r of [ra, ra2, rb]) assert.equal(r.ok, true);
    const snap = async () => [await rowOf(ra.booking_id), await rowOf(ra2.booking_id), await rowOf(rb.booking_id)];
    const antes = await snap();
    const nAntes = (await q(`select count(*)::int n from bookings where service_id = any($1)`, [[a, b]]))[0].n;
    // bloqueo GLOBAL de 09:45 a 10:15: cae sobre el turno de las 10:00 de los dos servicios (y no sobre las 11:00)
    await block(null, await L(MON, '09:45'), await L(MON, '10:15'), 'Reunión de equipo');
    assert.deepEqual(await snap(), antes, 'los turnos quedan byte a byte iguales');
    assert.equal((await q(`select count(*)::int n from bookings where service_id = any($1)`, [[a, b]]))[0].n, nAntes);
    assert.deepEqual((await q(`select status from bookings where id = any($1) order by customer_email`, [[ra.booking_id, ra2.booking_id, rb.booking_id]])).map(r => r.status), ['confirmed', 'confirmed', 'confirmed']);
    // la hora ya no se ofrece a nadie más (ni las que tocan el bloqueo)
    assert.deepEqual(await labels(a, MON, NOW), FULL.filter(h => !['09:30', '10:00', '11:00'].includes(h)));
    assert.equal((await book(a, await L(MON, '09:30'), 'otra@x.com', NOW)).error, 'SLOT_TAKEN');
    // la persona afectada puede cambiar su hora a una libre... pero no a otra hora bloqueada
    assert.equal((await resched(rb.management_code, await L(MON, '09:30'), NOW)).error, 'SLOT_TAKEN');
    const mov = await resched(ra.management_code, await L(MON, '16:00'), NOW);
    assert.equal(mov.ok, true, JSON.stringify(mov));
    assert.equal((await q(`select to_char(starts_at at time zone 'Europe/Madrid','HH24:MI') h, status from bookings where id=$1`, [ra.booking_id]))[0].h, '16:00');
    // o cancelarlo; y esa hora sigue sin ofrecerse mientras dure el bloqueo
    assert.equal((await cancel(rb.management_code, NOW)).ok, true);
    assert.ok(!(await labels(b, MON, NOW)).includes('10:00'), 'liberado por la cancelación pero aún bloqueado');
    // al borrar el bloqueo las horas vuelven; los turnos que no se movieron siguen ahí
    await q('delete from blocks');
    assert.ok((await labels(b, MON, NOW)).includes('10:00'));
    assert.equal((await rowOf(ra2.booking_id)).status, 'confirmed');
  });

  await test('T81 las consultas listas para el panel (supabase/consultas/*.sql) se ejecutan sin error; la de «por periodo» coincide con la vista por canal y las comprobaciones de coherencia dan 0', async () => {
    const dir = path.join(ROOT, 'supabase', 'consultas');
    const est = fs.readFileSync(path.join(dir, 'estadisticas.sql'), 'utf8');
    const blq = fs.readFileSync(path.join(dir, 'bloqueos.sql'), 'utf8');
    assert.ok(est.includes('30 as dias'));
    const rEst = await admin.query(est.replace('30 as dias', '36500 as dias'));   // todo el histórico (las fechas de las pruebas son fijas)
    const rBlq = await admin.query(blq);
    assert.equal(rEst.length, 8, 'estadisticas.sql: 8 consultas'); assert.equal(rBlq.length, 4, 'bloqueos.sql: 4 consultas (el INSERT va comentado)');
    const periodo = Object.fromEntries(rEst[2].rows.map(r => [r.channel, r]));
    const vista = (await q(`select * from stats_channels`));
    assert.ok(vista.length >= 5);
    for (const v of vista) {
      if (v.channel === 'ck-ingenuo' || (Number(v.clicks) === 0 && Number(v.bookings) === 0)) continue;   // sin actividad no hay fila en el periodo; ck-ingenuo:     // el contador que T71 manipuló a mano: sin detalle por días, justo lo que detecta la consulta 7
      const p = periodo[v.channel];
      assert.ok(p, `falta el canal ${v.channel} en la consulta por periodo`);
      assert.deepEqual([Number(p.clicks), Number(p.bookings), p.conversion_pct], [Number(v.clicks), Number(v.bookings), v.conversion_pct], v.channel);
    }
    assert.equal(rEst[7].rows[0].diferencia, '0', 'la suma de reservas de los canales = todas las reservas');
    assert.ok(rEst[0].rows.length >= 5 && rEst[1].rows.length >= 5 && rEst[3].rows.length > 0 && rEst[4].rows.length > 0);
    // la comprobación de integridad solo debe señalar el contador "ingenuo" que T71 manipuló a mano
    assert.deepEqual(rEst[6].rows.map(r => r.slug), ['ck-ingenuo']);
  });

  // ---------------- Resumen ----------------
  const ok = results.filter(r => r.ok).length;
  console.log(`\n${ok}/${results.length} pruebas correctas`);
  const md = ['# Resultado de las pruebas', '', `Ejecutado: ${new Date().toISOString()} · PostgreSQL ${(await q('show server_version'))[0].server_version}`, '',
    '| # | Prueba | Resultado |', '|---|---|---|',
    ...results.map(r => `| ${r.name.split(' ')[0]} | ${r.name.slice(r.name.indexOf(' ') + 1).replace(/\|/g, '/')} | ${r.ok ? '✔' : '✘ ' + r.err.split('\n')[0]} |`), '',
    `**${ok}/${results.length} correctas**`, ''].join('\n');
  if (!process.env.MUTATE) fs.writeFileSync(path.join(import.meta.dirname, 'RESULTADOS.md'), md);
  return ok === results.length;
}

let allOk = false;
try { allOk = await main(); }
catch (e) { console.error('ERROR FATAL en el arnés:', e); }
finally {
  try { await admin?.end(); } catch {}
  try { await server.stop(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(allOk ? 0 : 1);
