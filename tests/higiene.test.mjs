// Las reglas del proyecto (CLAUDE.md) que se pueden comprobar con codigo, comprobadas en cada corrida.
// Nacieron de los errores de GUTT_SYSTEM; si una falla, se corrige el repo, no la prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const IGNORAR = new Set(['node_modules', '.git', 'var', 'dist', '.claude']);
const TEXTO = new Set(['.js', '.mjs', '.json', '.md', '.sql', '.yml', '.yaml', '.ps1', '.example', '']);

function recorrer(dir, salida = []) {
  for (const nombre of readdirSync(dir)) {
    if (IGNORAR.has(nombre)) continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) recorrer(ruta, salida); else salida.push(ruta);
  }
  return salida;
}
const archivos = recorrer(ROOT).filter(f => relative(ROOT, f) !== '.env');
const rel = f => relative(ROOT, f).replaceAll('\\', '/');

test('regla 2: un solo backend, sin server.*.js paralelos en la raiz', () => {
  const raiz = readdirSync(ROOT).filter(n => /^server.*\.(js|mjs|cjs|ts)$/.test(n));
  assert.deepEqual(raiz, []);
});

test('regla 3: migraciones con numero unico y formato NNNN_nombre.sql', () => {
  const dir = join(ROOT, 'db/migrations');
  const nombres = readdirSync(dir).filter(n => n.endsWith('.sql'));
  for (const n of nombres) assert.match(n, /^\d{4}_[a-z0-9_]+\.sql$/, `nombre invalido: ${n}`);
  const numeros = nombres.map(n => n.slice(0, 4));
  assert.equal(new Set(numeros).size, numeros.length, 'numero de migracion repetido');
});

test('regla 4: ningun archivo de codigo supera 500 lineas', () => {
  const largos = archivos
    .filter(f => /^(src|tools)\//.test(rel(f)) && ['.js', '.mjs'].includes(extname(f)))
    .map(f => [rel(f), readFileSync(f, 'utf8').split('\n').length])
    .filter(([, lineas]) => lineas > 500);
  assert.deepEqual(largos, []);
});

test('regla 7: ningun archivo versionado trae una credencial con valor', () => {
  const patron = /(PASSWORD|SECRET|TOKEN|API_KEY)[ \t]*=[ \t]*\S+/;
  const culpables = archivos
    .filter(f => TEXTO.has(extname(f)) && rel(f) !== '.env')
    .filter(f => patron.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(culpables, []);
});

test('regla 8: raiz limpia, sin logs ni scripts de prueba sueltos', () => {
  const permitido = new Set(['CLAUDE.md', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', '.gitignore', '.env.example', '.env']);
  const carpetas = new Set(['db', 'src', 'tests', 'tools', 'deploy', 'docs', '.github', '.claude', '.git', 'node_modules', 'var', 'dist']);
  const sueltos = readdirSync(ROOT).filter(n => !permitido.has(n) && !carpetas.has(n));
  assert.deepEqual(sueltos, []);
});

test('regla 9: identificadores TECNIFIN, sin prefijo GUTT_ en codigo nuevo', () => {
  const culpables = archivos
    .filter(f => /^(src|tools)\//.test(rel(f)) && ['.js', '.mjs'].includes(extname(f)))
    .filter(f => /GUTT_/.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(culpables, []);
});
