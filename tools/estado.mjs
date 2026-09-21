// Estado del proyecto en ~20 lineas: lo unico que hay que leer para retomar el trabajo (regla 13: una sola implementacion).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_env.mjs';

const run = (cmd, args) => spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' });
const lineas = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean);

let modo = '(sin docs/handoff/ESTADO.md)';
try {
  const m = readFileSync(join(REPO_ROOT, 'docs/handoff/ESTADO.md'), 'utf8').match(/^\*\*Modo:\*\*\s*(.+)$/m);
  if (m) modo = m[1];
} catch { /* el archivo puede no existir todavia */ }

const rama = lineas(run('git', ['branch', '--show-current']).stdout)[0] || '?';
const sucios = lineas(run('git', ['status', '--porcelain']).stdout).length;
const mig = lineas(run('node', ['tools/migrate.mjs']).stdout).find((l) => /aplicadas/.test(l)) || 'migraciones: sin conexion a la base';

console.log(`Modo: ${modo}`);
console.log(`Rama: ${rama} | archivos sin commit: ${sucios}`);
console.log(mig);
console.log('Ultimos commits:');
for (const l of lineas(run('git', ['log', '-4', '--oneline']).stdout)) console.log(`  ${l}`);
console.log('Siguiente trabajo: docs/handoff/COLA.md | Preguntas abiertas: docs/handoff/PENDIENTES_USUARIO.md');
