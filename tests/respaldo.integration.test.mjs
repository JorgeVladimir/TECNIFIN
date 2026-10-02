// Respaldo con verificacion por restauracion (regla 10): pg_dump de una base con dos
// cooperativas, restauracion en una base temporal, mismos conteos y auditoria limpia.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { binarioPg, podar, respaldar, verificar } from '../tools/respaldo.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_resp_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const directorio = mkdtempSync(join(tmpdir(), 'tecnifin-respaldo-'));
let creada = false;

// pg_dump debe existir y no ser mas viejo que el servidor (en CI el cliente puede no coincidir).
function motivoParaOmitir() {
  try {
    const cliente = Number(/(\d+)/.exec(execFileSync(binarioPg('pg_dump'), ['--version']).toString())[1]);
    return { cliente };
  } catch { return { omitir: 'pg_dump no esta disponible' }; }
}
const { cliente: versionCliente, omitir } = motivoParaOmitir();

before(async () => {
  if (omitir) return;
  const configuracion = postgresConfig();
  await crearBaseLocal(configuracion, nombreBase, { dueno: entornoAdmin().TECNIFIN_PG_USER, aplicacion: configuracion.user });
  creada = true;
  await migrarBase(entorno);
  const admin = connectPostgres(entornoAdmin(entorno));
  const app = connectPostgres(entorno);
  try { await crearDosCooperativas(admin, crearWithTenant(app)); }
  finally { await Promise.all([admin.close(), app.close()]); }
});

after(async () => {
  rmSync(directorio, { recursive: true, force: true });
  if (creada) {
    const superusuario = await conectarSuperusuario(postgresConfig());
    try { await borrarBaseLocal(superusuario, nombreBase); } finally { await superusuario.end(); }
  }
});

test('respaldo y restauracion en base temporal: mismos conteos, auditoria limpia y la temporal se borra', { skip: omitir }, async (t) => {
  const superusuario = await conectarSuperusuario(postgresConfig());
  const servidor = Number((await superusuario.query('SHOW server_version_num')).rows[0].server_version_num) / 10000 | 0;
  if (versionCliente < servidor) { await superusuario.end(); t.skip(`pg_dump ${versionCliente} < servidor ${servidor}`); return; }
  try {
    const { archivo, bytes } = await respaldar(nombreBase, { env: entorno, directorio });
    assert.ok(bytes > 0);
    const v = await verificar(archivo, nombreBase, { env: entorno });
    assert.deepEqual([v.diferencias, v.hallazgos], [[], []]);
    assert.ok(v.filas > 1000, 'incluye el catalogo de cuentas de las dos cooperativas');
    const temporales = (await superusuario.query(`SELECT datname FROM pg_database WHERE datname LIKE 'tecnifin_verif_%'`)).rows;
    assert.deepEqual(temporales, []);
  } finally { await superusuario.end(); }
});

test('la poda conserva solo los ultimos N respaldos de cada base', { skip: omitir }, () => {
  for (const marca of ['20260101_000000Z', '20260102_000000Z', '20260103_000000Z']) {
    writeFileSync(join(directorio, `${nombreBase}_${marca}.dump`), 'x');
  }
  writeFileSync(join(directorio, 'otra_base_20260101_000000Z.dump'), 'x');
  const borrados = podar(nombreBase, { env: { TECNIFIN_RESPALDO_RETENER: '2' }, directorio });
  const quedan = readdirSync(directorio).filter(f => f.startsWith(nombreBase)).sort();
  assert.equal(quedan.length, 2);
  assert.ok(borrados >= 2);
  assert.ok(readdirSync(directorio).includes('otra_base_20260101_000000Z.dump'), 'no toca respaldos de otras bases');
});
