// Puerta de cierre de una unidad de trabajo: migraciones sin pendientes + todas las pruebas, con resumen corto.
// Sale con 0 solo si todo esta en verde. La salida completa de las pruebas se guarda en var/verificar.log.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_env.mjs';

const run = (args) => spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
let fallo = false;

const mig = run(['tools/migrate.mjs']);
const resumenMig = (mig.stdout || mig.stderr || '').split('\n').find((l) => /aplicadas|Migracion/.test(l)) || 'sin respuesta';
console.log(`migraciones : ${resumenMig.trim()} ${mig.status === 0 ? 'OK' : 'FALLA'}`);
if (mig.status !== 0) fallo = true;

const t = run(['--test', '--test-reporter=spec']);
const salida = `${t.stdout || ''}\n${t.stderr || ''}`;
mkdirSync(join(REPO_ROOT, 'var'), { recursive: true });
writeFileSync(join(REPO_ROOT, 'var', 'verificar.log'), salida);
const n = (k) => (salida.match(new RegExp(`ℹ ${k} ([0-9]+)`)) || [0, '?'])[1];
console.log(`pruebas     : ${n('pass')} de ${n('tests')} en verde, ${n('fail')} fallan ${t.status === 0 ? 'OK' : 'FALLA'}`);
if (t.status !== 0) {
  fallo = true;
  const rojas = salida.split('\n').filter((l) => l.startsWith('✖')).slice(0, 8);
  for (const l of rojas) console.log(`  ${l}`);
  console.log('  (detalle completo en var/verificar.log)');
}
console.log(fallo ? 'RESULTADO: NO cerrar la unidad' : 'RESULTADO: verde, se puede cerrar la unidad');
process.exit(fallo ? 1 : 0);
