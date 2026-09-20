// Unico camino para cambiar el esquema (regla 3). Estado: node tools/migrate.mjs (sale con 1 si hay pendientes)
// Aplicar: node tools/migrate.mjs --aplicar
// Cada archivo de db/migrations se aplica en su propia transaccion y se registra con su SHA-256:
// un archivo ya aplicado que cambia (ALTERADO) o que desaparece detiene el proceso.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT, entornoAdmin } from './_env.mjs';
import { connectPostgres } from '../src/platform/postgres.js';

const apply = process.argv.includes('--aplicar');
const dir = join(REPO_ROOT, 'db/migrations');
const files = readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b))
  .map(name => {
    const text = readFileSync(join(dir, name), 'utf8');
    return { name, text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
  });

// Los invariantes del modelo (cooperativa_id, RLS, FORCE, politica, indice por FK, cero
// SECURITY DEFINER) se exigen despues de CADA migracion y dentro de su transaccion: una
// tabla nueva que olvide tecnifin.aplicar_rls() no llega a existir. La regla vive en el
// esquema (db/migrations/0001), no aqui: aqui solo se decide cuando se aplica.
async function verificarInvariantes(tx, nombre) {
  const disponible = await tx.query("SELECT to_regprocedure('tecnifin.verificar_invariantes()') IS NOT NULL AS ok");
  if (!disponible.rows[0].ok) return;
  const problemas = await tx.query('SELECT objeto, problema FROM tecnifin.verificar_invariantes() ORDER BY objeto');
  if (problemas.rowCount) {
    const detalle = problemas.rows.map(f => `${f.objeto}: ${f.problema}`).join('; ');
    throw new Error(`${nombre} rompe los invariantes del esquema -> ${detalle}`);
  }
}

function compare(rows) {
  const known = new Map(files.map(f => [f.name, f]));
  for (const row of rows) {
    if (!known.has(row.file_name)) throw new Error(`Falta archivo ya aplicado: ${row.file_name}`);
    if (known.get(row.file_name).hash !== row.content_hash) throw new Error(`Migracion ALTERADA: ${row.file_name}`);
  }
  const applied = new Set(rows.map(r => r.file_name));
  return files.filter(f => !applied.has(f.name));
}

let db;
try {
  // Las migraciones corren como tecnifin_admin, el dueno del esquema. La aplicacion no
  // hace DDL y por eso tampoco necesita ser duena de sus tablas (ADR-0002, punto 1).
  db = connectPostgres(entornoAdmin());
  const version = await db.query("SELECT current_setting('server_version_num')::integer AS version");
  if (version.rows[0].version < 150000) throw new Error('Requiere PostgreSQL 15 o superior');
  const exists = await db.query("SELECT to_regclass('public.tecnifin_schema_migrations') IS NOT NULL AS exists");
  const rows = exists.rows[0].exists
    ? (await db.query('SELECT file_name, content_hash FROM public.tecnifin_schema_migrations')).rows : [];
  const pending = compare(rows);
  console.log(`PostgreSQL: ${files.length - pending.length} aplicadas; ${pending.length} pendientes.`);
  for (const f of pending) console.log(`Pendiente: ${f.name}`);
  if (!apply) {
    if (pending.length) process.exitCode = 1;
  } else {
    await db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(728194501)');
      await tx.query(`CREATE TABLE IF NOT EXISTS public.tecnifin_schema_migrations (
        file_name text PRIMARY KEY, content_hash varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL
      )`);
    });
    for (const file of files) {
      const applied = await db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(728194501)');
        const current = await tx.query('SELECT file_name, content_hash FROM public.tecnifin_schema_migrations');
        if (!compare(current.rows).some(f => f.name === file.name)) return false;
        const start = Date.now();
        await tx.query(file.text);
        await verificarInvariantes(tx, file.name);
        await tx.query(`INSERT INTO public.tecnifin_schema_migrations (file_name, content_hash, duration_ms)
          VALUES (@name, @hash, @ms)`, { name: file.name, hash: file.hash, ms: Date.now() - start });
        return true;
      });
      if (applied) console.log(`Aplicada: ${file.name}`);
    }
  }
} catch (error) {
  console.error(`Migracion PostgreSQL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
