// Junta TODAS las migraciones de supabase/migrations en un único archivo para pegar de una vez en el SQL Editor:
//   node supabase/generar-instalacion-completa.mjs      ->  supabase/instalacion_completa.sql
// Cada migración va dentro de su propio BEGIN/COMMIT (usan "set local", que solo vale dentro de una transacción).
// Si el archivo se vuelve a generar tras añadir migraciones nuevas, saldrán también.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const out = [
  '-- ============================================================',
  '-- INSTALACIÓN COMPLETA · todas las migraciones juntas, en orden',
  `-- (${files.length} archivos: ${files[0]} … ${files.at(-1)})`,
  '--',
  '-- Pégalo ENTERO en Supabase → SQL Editor y pulsa Run, UNA sola vez, en un proyecto NUEVO.',
  '-- Después ejecuta supabase/seed.sql (datos de ejemplo) cambiando antes admin_email.',
  '-- Si un bloque falla, ese bloque se deshace y el script se detiene: corrige y vuelve a empezar',
  '-- desde un proyecto limpio (o ejecuta solo los bloques que faltan).',
  '-- Generado con: node supabase/generar-instalacion-completa.mjs',
  '-- ============================================================',
  '',
];
for (const f of files) {
  out.push(
    '',
    '-- ############################################################',
    `-- ## ${f}`,
    '-- ############################################################',
    'begin;',
    fs.readFileSync(path.join(dir, f), 'utf8').trimEnd(),
    'commit;',
    '',
  );
}
const target = path.join(import.meta.dirname, 'instalacion_completa.sql');
fs.writeFileSync(target, out.join('\n'));
console.log(`escrito ${target} (${files.length} migraciones, ${out.join('\n').split('\n').length} líneas)`);
