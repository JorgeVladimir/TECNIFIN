// Respaldo de PostgreSQL con verificacion por restauracion (regla 10, deploy/README.md).
//
//   npm run respaldo                       # base de trabajo (.env)
//   node tools/respaldo.mjs tecnifin_demo  # otra base
//
// 1. pg_dump en formato custom a var/respaldos/ (o TECNIFIN_RESPALDO_DIR).
// 2. Restaura el archivo en una base temporal, compara el numero de filas de cada tabla con el
//    origen y corre la auditoria contable sobre la copia: un respaldo que no se restaura igual
//    no es un respaldo. La base temporal se borra siempre.
// 3. Conserva los ultimos TECNIFIN_RESPALDO_RETENER archivos de cada base (14 por defecto).
//
// Corre como el superusuario postgres (TECNIFIN_PG_ADMIN_PASSWORD): con RLS FORCE, el dueno del
// esquema no ve filas sin cooperativa fijada y pg_dump fallaria. Un rol de respaldo propio con
// BYPASSRLS es decision pendiente (Christian, preguntas 4 y 5). Sale con 1 si algo falla.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './_env.mjs';
import { conectarSuperusuario, identificador } from './_local.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { auditarBase } from './auditoria.mjs';

const ejecutar = promisify(execFile);

// pg_dump / pg_restore: TECNIFIN_PG_BIN, o la version mas nueva instalada en Windows, o el PATH.
export function binarioPg(nombre, env = process.env) {
  const exe = process.platform === 'win32' ? `${nombre}.exe` : nombre;
  if (env.TECNIFIN_PG_BIN) return join(env.TECNIFIN_PG_BIN, exe);
  const raiz = 'C:\\Program Files\\PostgreSQL';
  if (process.platform === 'win32' && existsSync(raiz)) {
    const versiones = readdirSync(raiz).filter(v => existsSync(join(raiz, v, 'bin', exe)))
      .sort((a, b) => Number(b) - Number(a));
    if (versiones.length) return join(raiz, versiones[0], 'bin', exe);
  }
  return exe;
}

const argumentosConexion = (c) => ['-h', c.host, '-p', String(c.port), '-U', 'postgres', '--no-password'];
const entornoPg = (env) => ({ ...process.env, PGPASSWORD: env.TECNIFIN_PG_ADMIN_PASSWORD });

async function conteos(cliente) {
  const tablas = (await cliente.query(
    `SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables
      WHERE schemaname = 'tecnifin' OR (schemaname = 'public' AND tablename = 'tecnifin_schema_migrations')
      ORDER BY 1`)).rows.map(r => r.t);
  const resultado = {};
  for (const t of tablas) resultado[t] = Number((await cliente.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return resultado;
}

export async function respaldar(base, { env = process.env, directorio } = {}) {
  const configuracion = postgresConfig({ ...env, TECNIFIN_PG_DATABASE: base });
  const destino = directorio || env.TECNIFIN_RESPALDO_DIR || join(REPO_ROOT, 'var', 'respaldos');
  mkdirSync(destino, { recursive: true });
  const marca = `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}Z`;
  const archivo = join(destino, `${base}_${marca}.dump`);
  await ejecutar(binarioPg('pg_dump', env), [...argumentosConexion(configuracion), '-d', base, '-Fc', '-f', archivo],
    { env: entornoPg(env), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { archivo, bytes: statSync(archivo).size };
}

// Restaura en una base temporal y compara. Devuelve { tablas, diferencias, hallazgos }.
export async function verificar(archivo, base, { env = process.env } = {}) {
  const configuracion = postgresConfig({ ...env, TECNIFIN_PG_DATABASE: base });
  const temporal = `tecnifin_verif_${randomBytes(5).toString('hex')}`;
  const admin = await conectarSuperusuario(configuracion, 'postgres', env);
  try {
    await admin.query(`CREATE DATABASE ${identificador(temporal)} TEMPLATE template0 ENCODING 'UTF8'`);
    await ejecutar(binarioPg('pg_restore', env), [...argumentosConexion(configuracion), '-d', temporal, '--exit-on-error', archivo],
      { env: entornoPg(env), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const origen = await conectarSuperusuario(configuracion, base, env);
    const copia = await conectarSuperusuario(configuracion, temporal, env);
    let esperado; let obtenido;
    try { [esperado, obtenido] = await Promise.all([conteos(origen), conteos(copia)]); }
    finally { await Promise.all([origen.end(), copia.end()]); }
    const diferencias = [...new Set([...Object.keys(esperado), ...Object.keys(obtenido)])]
      .filter(t => esperado[t] !== obtenido[t]).map(t => ({ tabla: t, origen: esperado[t], copia: obtenido[t] }));
    const db = connectPostgres({ ...env, TECNIFIN_PG_DATABASE: temporal, TECNIFIN_PG_USER: 'postgres',
      TECNIFIN_PG_PASSWORD: env.TECNIFIN_PG_ADMIN_PASSWORD });
    let hallazgos;
    try { ({ hallazgos } = await auditarBase(db)); } finally { await db.close(); }
    return { tablas: Object.keys(esperado).length, filas: Object.values(esperado).reduce((s, n) => s + n, 0), diferencias, hallazgos };
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${identificador(temporal)} WITH (FORCE)`);
    await admin.end();
  }
}

export function podar(base, { env = process.env, directorio } = {}) {
  const destino = directorio || env.TECNIFIN_RESPALDO_DIR || join(REPO_ROOT, 'var', 'respaldos');
  const retener = Math.max(1, Number(env.TECNIFIN_RESPALDO_RETENER || 14));
  const propios = readdirSync(destino).filter(f => f.startsWith(`${base}_`) && f.endsWith('.dump')).sort().reverse();
  const borrar = propios.slice(retener);
  for (const f of borrar) unlinkSync(join(destino, f));
  return borrar.length;
}

async function principal() {
  const bases = process.argv.slice(2).length ? process.argv.slice(2) : [postgresConfig().database];
  let fallas = 0;
  for (const base of bases) {
    try {
      const { archivo, bytes } = await respaldar(base);
      const v = await verificar(archivo, base);
      const ok = !v.diferencias.length && !v.hallazgos.length;
      console.log(`${base}: ${archivo} (${bytes} bytes) -> restaurado en base temporal: ${v.tablas} tablas, ${v.filas} filas, `
        + `${v.diferencias.length} diferencia(s), ${v.hallazgos.length} hallazgo(s) de auditoria. ${ok ? 'OK' : 'FALLA'}`);
      for (const d of v.diferencias) console.log('  diferencia:', JSON.stringify(d));
      for (const h of v.hallazgos) console.log(`  [${h.ambito}] ${h.control}`);
      if (!ok) fallas++;
      else {
        const podados = podar(base);
        if (podados) console.log(`  ${podados} respaldo(s) antiguo(s) eliminado(s)`);
      }
    } catch (e) {
      console.log(`${base}: FALLA ${e.message.split('\n')[0]}`);
      fallas++;
    }
  }
  process.exit(fallas ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await principal();
