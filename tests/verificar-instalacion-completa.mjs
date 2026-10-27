// Comprueba que supabase/instalacion_completa.sql (pegado de una vez) deja la base de datos IGUAL que
// aplicar las migraciones una a una, y que el seed y las RPC principales funcionan después.
//   cd tests && node verificar-instalacion-completa.mjs
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PGPORT_TEST ?? 54385);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnos-pg-'));
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: false, onLog: () => {}, onError: () => {},
  initdbFlags: ['--encoding=UTF8', '--locale=C'] });   // Supabase usa UTF-8
const conn = (database) => { const c = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database }); c.on('error', () => {}); return c; };
const CREAR_ROLES = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`;   // una vez por servidor
const ROLES = `
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`;

const snapshot = async (c) => {
  const q = async (sql) => (await c.query(sql)).rows.map((r) => Object.values(r).join('|'));
  return {
    tablas: await q(`select relname||':rls='||relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','v') order by 1`),
    columnas: await q(`select table_name||'.'||column_name||':'||data_type from information_schema.columns where table_schema='public' order by 1`),
    funciones: await q(`select p.oid::regprocedure::text||' anon='||has_function_privilege('anon',p.oid,'execute')||' srv='||has_function_privilege('service_role',p.oid,'execute') from pg_proc p where pronamespace='public'::regnamespace order by 1`),
    indices: await q(`select indexname from pg_indexes where schemaname='public' order by 1`),
    restricciones: await q(`select conrelid::regclass||'.'||conname from pg_constraint where connamespace='public'::regnamespace order by 1`),
    triggers: await q(`select tgname from pg_trigger where not tgisinternal order by 1`),
    ajustes: await q(`select key from public.settings order by 1`),
  };
};

let ok = false;
try {
  await server.initialise(); await server.start();
  await server.createDatabase('a_junto'); await server.createDatabase('b_una_a_una');

  // A: el archivo único, de UNA sola vez (como el SQL Editor)
  const A = conn('a_junto'); await A.connect(); await A.query(CREAR_ROLES); await A.query(ROLES);
  await A.query(fs.readFileSync(path.join(ROOT, 'supabase', 'instalacion_completa.sql'), 'utf8'));
  await A.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));

  // B: migración a migración
  const B = conn('b_una_a_una'); await B.connect(); await B.query(ROLES);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort())
    await B.query('begin;\n' + fs.readFileSync(path.join(dir, f), 'utf8') + '\ncommit;');
  await B.query(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));

  const [sa, sb] = [await snapshot(A), await snapshot(B)];
  for (const k of Object.keys(sa)) assert.deepEqual(sa[k], sb[k], `difiere: ${k}`);
  console.log(`✔ idéntico: ${sa.tablas.length} tablas, ${sa.columnas.length} columnas, ${sa.funciones.length} funciones, ${sa.indices.length} índices, ${sa.restricciones.length} restricciones, ${sa.triggers.length} triggers, ${sa.ajustes.length} ajustes`);

  // Seguridad: anon sin acceso a nada
  const bad = sa.funciones.filter((f) => f.includes('anon=true') && !/touch_updated_at|bookings_prepare/.test(f));
  assert.deepEqual(bad, [], 'funciones ejecutables por anon');
  const rel = (await A.query(`select c.relname, c.relkind, c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'select') as anon_lee, has_table_privilege('authenticated', c.oid, 'select') as auth_lee
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v')`)).rows;
  assert.deepEqual(rel.filter((r) => r.relkind === 'r' && !r.relrowsecurity).map((r) => r.relname), [], 'tabla sin RLS');
  assert.deepEqual(rel.filter((r) => r.anon_lee || r.auth_lee).map((r) => r.relname), [], 'anon/authenticated pueden leer');
  console.log(`✔ RLS en las ${rel.filter((r) => r.relkind === 'r').length} tablas, ${rel.filter((r) => r.relkind === 'v').length} vistas y ninguna función ni tabla accesible para anon`);

  // Humo: el sistema funciona desde el archivo único
  const svc = (await A.query(`select list_active_services() as r`)).rows[0].r.services;
  assert.equal(svc.length, 1);
  const cfg = (await A.query(`select get_config() as r`)).rows[0].r;
  assert.ok(cfg.timezone === 'Europe/Madrid' && 'staff_email' in cfg && 'reschedule_form_url' in cfg);
  const day = (await A.query(`select day::text d from get_next_available_days($1, null, 1)`, [svc[0].id])).rows[0].d;
  assert.ok((await A.query(`select get_availability($1,$2::date) as r`, [svc[0].id, day])).rows[0].r.slots.length > 0);
  console.log(`✔ el seed y las RPC funcionan (servicio «${svc[0].name}», primer día con huecos: ${day})`);
  await A.end(); await B.end();
  ok = true;
} catch (e) { console.error('✘', e.message); }
finally {
  try { await server.stop(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(ok ? 0 : 1);
