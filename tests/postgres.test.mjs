import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNamed, createDatabase, postgresConfig } from '../src/platform/postgres.js';

test('parametros repetidos mantienen su posicion y valores no entran al SQL', () => {
  const attack = "'); DROP TABLE cuentas;--";
  assert.deepEqual(bindNamed('SELECT @b, @a, @b', { a: attack, b: 12 }), {
    text: 'SELECT $1, $2, $1', values: [12, attack],
  });
});
test('ignora parametros en literales, identificadores, dollar quotes y comentarios anidados', () => {
  const prefix = `SELECT '@literal''@otro', "@col", $$@body$$, $fn$@function$fn$, E'\\\'@escaped' /* @x /* @y */ @z */ -- @line\n`;
  assert.deepEqual(bindNamed(prefix + '@real', { real: false }), { text: prefix + '$1', values: [false] });
});
test('rechaza parametros ausentes, undefined, heredados, mezcla de estilos y SQL incompleto', () => {
  for (const params of [{}, { x: undefined }, Object.create({ x: 1 })]) {
    assert.throws(() => bindNamed('SELECT @x', params), /Falta parametro/);
  }
  for (const sql of ["SELECT 'hola", '/* texto', 'SELECT $fn$texto']) assert.throws(() => bindNamed(sql));
  assert.throws(() => bindNamed('SELECT $1, @x', { x: 2 }), /No mezclar/);
  assert.deepEqual(bindNamed('SELECT @x', { x: null }).values, [null]);
});
function fakePool(failAt = []) {
  const calls = [], releases = [];
  const client = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      calls.push(text);
      if (failAt.includes(text)) throw new Error(text);
      return { rows: [{ ok: true }] };
    },
    release(error) { releases.push(error); },
  };
  return { pool: { async connect() { return client; } }, calls, releases };
}
test('transaccion ejecuta todo con el mismo cliente y libera despues de commit', async () => {
  const f = fakePool();
  const value = await createDatabase(f.pool).transaction(async tx => {
    await tx.query('SELECT @n', { n: 5 }); return 7;
  });
  assert.equal(value, 7);
  assert.deepEqual(f.calls, ['BEGIN', 'SELECT $1', 'COMMIT']);
  assert.deepEqual(f.releases, [undefined]);
});
for (const stage of ['BEGIN', 'SELECT $1', 'COMMIT']) {
  test(`rollback y liberacion cuando falla ${stage}`, async () => {
    const f = fakePool([stage]);
    await assert.rejects(createDatabase(f.pool).transaction(tx => tx.query('SELECT @n', { n: 1 })), { message: stage });
    assert.equal(f.calls.at(-1), 'ROLLBACK');
    assert.equal(f.releases.length, 1);
  });
}
test('fallo del rollback descarta conexion y conserva el error original', async () => {
  const f = fakePool(['SELECT $1', 'ROLLBACK']);
  await assert.rejects(createDatabase(f.pool).transaction(tx => tx.query('SELECT @n', { n: 1 })), { message: 'SELECT $1' });
  assert.equal(f.releases.length, 1);
  assert.equal(f.releases[0].message, 'ROLLBACK');
});
test('configuracion dedicada impide usar por accidente DATABASE_URL o PGHOST', () => {
  assert.throws(() => postgresConfig({ DATABASE_URL: 'postgres://legacy', PGHOST: 'legacy' }), /Configurar TECNIFIN_PG/);
  const env = { TECNIFIN_PG_HOST: 'localhost', TECNIFIN_PG_DATABASE: 'test', TECNIFIN_PG_USER: 'test', TECNIFIN_PG_PASSWORD: 'test' };
  const config = postgresConfig(env);
  assert.equal(config.port, 5432);
  assert.equal(config.types.getTypeParser(1082)('2026-09-14'), '2026-09-14');
  assert.throws(() => postgresConfig({ ...env, TECNIFIN_PG_PORT: '-1' }), /invalido/);
  assert.throws(() => postgresConfig({ ...env, TECNIFIN_PG_SSL: 'disable' }), /true o false/);
});
