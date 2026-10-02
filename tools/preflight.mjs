// Checklist ejecutable de "listo para produccion" (regla 10). Solo lectura.
//
//   npm run preflight
//
// Cada punto es BLOQUEA (no se sale a produccion), AVISO (revisar) u OK. Sale con 1 si hay algun
// BLOQUEA. Los puntos del servicio de Windows y del sitio publico se agregan en la Fase 4, cuando
// existan (deploy/README.md); hasta entonces figuran como AVISO para que no se olviden.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, entornoAdmin } from './_env.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { auditarBase } from './auditoria.mjs';

const ejecutar = promisify(execFile);
const env = process.env;
const resultados = [];
const marcar = (estado, punto, detalle) => resultados.push({ estado, punto, detalle });

async function punto(nombre, fn) {
  try { await fn(); } catch (e) { marcar('BLOQUEA', nombre, e.message.split('\n')[0]); }
}

await punto('Configuracion (.env)', () => {
  const faltan = ['TECNIFIN_PG_HOST', 'TECNIFIN_PG_DATABASE', 'TECNIFIN_PG_USER', 'TECNIFIN_PG_PASSWORD',
    'TECNIFIN_PG_ADMIN_USER', 'TECNIFIN_PG_ADMIN_DB_PASSWORD', 'TECNIFIN_JWT_SECRET', 'TECNIFIN_JWT_ISSUER',
    'TECNIFIN_JWT_AUDIENCE'].filter(k => !env[k]);
  if (faltan.length) return marcar('BLOQUEA', 'Configuracion (.env)', `faltan ${faltan.join(', ')}`);
  if (Buffer.byteLength(env.TECNIFIN_JWT_SECRET) < 32) return marcar('BLOQUEA', 'Configuracion (.env)', 'TECNIFIN_JWT_SECRET con menos de 32 bytes');
  if (/_demo$/.test(env.TECNIFIN_PG_DATABASE)) return marcar('BLOQUEA', 'Configuracion (.env)', 'la aplicacion apunta a la base de demostracion');
  if (!env.TECNIFIN_SMTP_HOST) return marcar('AVISO', 'Configuracion (.env)', 'sin SMTP: no habra recuperacion de clave por correo');
  marcar('OK', 'Configuracion (.env)', `base ${env.TECNIFIN_PG_DATABASE}, rol ${env.TECNIFIN_PG_USER}`);
});

await punto('Migraciones aplicadas', async () => {
  try {
    const { stdout } = await ejecutar(process.execPath, ['tools/migrate.mjs'], { cwd: REPO_ROOT, windowsHide: true });
    marcar('OK', 'Migraciones aplicadas', stdout.trim().split('\n').at(-1));
  } catch (e) {
    marcar('BLOQUEA', 'Migraciones aplicadas', (e.stdout || e.message).trim().split('\n').slice(-2).join(' | '));
  }
});

await punto('Auditoria contable', async () => {
  const db = connectPostgres(entornoAdmin());
  try {
    const { cooperativas, hallazgos } = await auditarBase(db);
    if (hallazgos.length) marcar('BLOQUEA', 'Auditoria contable', hallazgos.map(h => `[${h.ambito}] ${h.control}`).join('; '));
    else marcar('OK', 'Auditoria contable', `${cooperativas} cooperativa(s), sin diferencias`);
  } finally { await db.close(); }
});

await punto('Respaldo reciente', () => {
  const dir = env.TECNIFIN_RESPALDO_DIR || join(REPO_ROOT, 'var', 'respaldos');
  const base = postgresConfig().database;
  const archivos = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(`${base}_`) && f.endsWith('.dump')) : [];
  if (!archivos.length) return marcar('BLOQUEA', 'Respaldo reciente', `no hay respaldos de ${base} en ${dir} (npm run respaldo)`);
  const ultimo = archivos.map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  const horas = (Date.now() - ultimo.t) / 3600000;
  if (horas > 26) return marcar('BLOQUEA', 'Respaldo reciente', `el ultimo (${ultimo.f}) tiene ${horas.toFixed(0)} h`);
  marcar('OK', 'Respaldo reciente', `${ultimo.f} (${horas.toFixed(1)} h)`);
});

await punto('Respaldo programado', async () => {
  if (process.platform !== 'win32') return marcar('AVISO', 'Respaldo programado', 'solo se verifica en Windows');
  try {
    await ejecutar('schtasks', ['/Query', '/TN', 'TECNIFIN-Respaldo'], { windowsHide: true });
    marcar('OK', 'Respaldo programado', 'tarea TECNIFIN-Respaldo instalada');
  } catch {
    marcar('BLOQUEA', 'Respaldo programado',
      'tarea TECNIFIN-Respaldo no visible: instalar con deploy\\programar-respaldo.ps1 -Instalar (como administrador); sin elevacion puede no verse aunque exista');
  }
});

marcar('AVISO', 'Servicio de Windows y sitio publico', 'pendiente de la Fase 4 (deploy/README.md): servicio NSSM y /api/health por el dominio');

const ancho = Math.max(...resultados.map(r => r.punto.length));
for (const r of resultados) console.log(`${r.estado.padEnd(7)} ${r.punto.padEnd(ancho)}  ${r.detalle}`);
const bloquea = resultados.filter(r => r.estado === 'BLOQUEA').length;
console.log(bloquea ? `\nNO LISTO: ${bloquea} punto(s) bloquean.` : '\nLISTO (revise los avisos).');
process.exit(bloquea ? 1 : 0);
