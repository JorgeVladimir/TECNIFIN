// Control de convenciones, no analizador de SQL ni barrera frente a SQL arbitrario.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = new URL('../', import.meta.url);
const extensiones = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|sql|ps1|sh)$/i;
// Se bloquea toda llamada a set_config: su primer argumento puede ser un parametro.
// Tambien SET de sesion, RESET y formas con comillas/comentarios/saltos de linea.
function fijaContexto(texto) {
  const normalizado = texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ');
  return /\bset_config"?\s*\(/i.test(normalizado)
    || /\b(?:SET\s+(?:(?:LOCAL|SESSION)\s+)?|RESET\s+)"?app"?\s*\.\s*"?cooperativa_id\b/i.test(normalizado)
    || /\b(?:RESET\s+ALL|DISCARD\s+ALL)\b/i.test(normalizado);
}

// Lista cerrada: no se excluyen directorios de pruebas ni futuras migraciones.
// Las migraciones historicas se mantienen intactas (migrate verifica su hash).
const excepciones = new Map([
  ['src/platform/tenant.js', 'unico fijador en codigo de aplicacion'],
  ['db/migrations/0007_contabilidad.sql', 'marca contable historica, sustituida por 0014'],
  ['db/migrations/0014_correcciones_revision_dat01_02.sql', 'trigger de cuadre cambia/restaura tenant de OLD/NEW'],
  ['tests/tenant.test.mjs', 'comprueba el SQL emitido por withTenant'],
  ['tests/fixtures/pool-falso.mjs', 'simula el contexto que fija withTenant en pruebas unitarias'],
  ['tests/aislamiento.integration.test.mjs', 'sondas adversarias ALTO 1 y cuadre diferido'],
  ['tests/higiene-tenant.test.mjs', 'casos negativos del propio detector'],
]);

function archivos(dir) {
  return readdirSync(new URL(dir, raiz), { withFileTypes: true }).flatMap(entrada => {
    const ruta = dir + entrada.name;
    return entrada.isDirectory() ? archivos(ruta + '/') : extensiones.test(ruta) ? [ruta] : [];
  });
}

test('ALTO 1: solo withTenant fija contexto en aplicacion; excepciones SQL y pruebas explicitas', () => {
  const fuentes = ['src/', 'tools/', 'deploy/', 'db/', 'tests/'].flatMap(archivos);
  const fijadores = fuentes.filter(ruta => fijaContexto(readFileSync(new URL(ruta, raiz), 'utf8')));
  assert.deepEqual(fijadores.filter(ruta => !excepciones.has(ruta)), [],
    'fijacion de contexto fuera de withTenant; ver adenda ALTO 1 de ADR-0002');
  for (const ruta of excepciones.keys()) {
    assert.ok(fijadores.includes(ruta), `revisar excepcion obsoleta: ${fileURLToPath(new URL(ruta, raiz))}`);
  }
});

test('la higiene detecta variantes de escritura y permite leer el contexto', () => {
  for (const sql of [
    "SELECT set_config(@clave, @valor, true)",
    "SELECT pg_catalog.\"set_config\" /* comentario */ ('app.cooperativa_id', '2', true)",
    "SET LOCAL app.cooperativa_id = '2'",
    "set\n session\n \"app\".\"cooperativa_id\" TO '2'",
    "SET /* comentario */ \"app.cooperativa_id\" = '2'",
    "SET -- comentario\n app.cooperativa_id = '2'",
    'RESET app.cooperativa_id', 'RESET ALL', 'DISCARD ALL',
  ]) assert.ok(fijaContexto(sql), sql);
  for (const sql of [
    "SELECT current_setting('app.cooperativa_id', true)",
    'SET CONSTRAINTS ALL IMMEDIATE', 'SELECT * FROM tecnifin.socios',
  ]) assert.equal(fijaContexto(sql), false, sql);
});
