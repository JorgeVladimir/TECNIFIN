// withTenant sin base de datos: que el tenant se valide antes de salir del proceso y que
// se fije SIEMPRE con SET LOCAL parametrizado, dentro de la transaccion y antes del trabajo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearWithTenant, validarCooperativaId, CLAVE_TENANT } from '../src/platform/tenant.js';
import { createDatabase } from '../src/platform/postgres.js';
import { poolFalso } from './fixtures/pool-falso.mjs';

test('rechaza cualquier cooperativaId que no sea un entero positivo', () => {
  for (const malo of [0, -1, 1.5, NaN, Infinity, '1', null, undefined, {}, 2147483648n]) {
    assert.throws(() => validarCooperativaId(malo), /entero positivo|rango/);
  }
  assert.throws(() => validarCooperativaId(2147483648), /rango/);
  assert.equal(validarCooperativaId(7), 7);
});

test('valida el tenant antes de tocar la base: ninguna consulta sale con basura', async () => {
  const f = poolFalso();
  const withTenant = crearWithTenant(createDatabase(f.pool));
  await assert.rejects(withTenant('1; DROP TABLE socios', async () => {}), TypeError);
  await assert.rejects(withTenant(0, async () => {}), TypeError);
  await assert.rejects(withTenant(1, 'no soy una funcion'), TypeError);
  assert.deepEqual(f.llamadas, []);
});

test('fija el tenant con SET LOCAL parametrizado, dentro de la transaccion y antes del trabajo', async () => {
  const f = poolFalso();
  const withTenant = crearWithTenant(createDatabase(f.pool));
  const valor = await withTenant(42, async (tx, cooperativa) => {
    await tx.query('SELECT * FROM tecnifin.socios');
    return cooperativa;
  });
  assert.equal(valor, 42);
  assert.deepEqual(f.textos(), [
    'BEGIN', 'SELECT set_config($1, $2, true)',
    `SELECT current_setting($1, true) AS cooperativa_id,
                pg_backend_pid()::text AS conexion_id,
                txid_current_if_assigned()::text AS transaccion_id`,
    'SELECT * FROM tecnifin.socios',
    `SELECT current_setting($1, true) AS cooperativa_id,
                pg_backend_pid()::text AS conexion_id,
                txid_current_if_assigned()::text AS transaccion_id`,
    'COMMIT',
  ]);
  // El valor viaja como parametro: nunca se interpola en el texto del SQL.
  assert.deepEqual(f.llamadas[1].valores, [CLAVE_TENANT, '42']);
});

test('si el trabajo falla, la transaccion se revierte y el tenant no sobrevive', async () => {
  const f = poolFalso(['SELECT 1']);
  const withTenant = crearWithTenant(createDatabase(f.pool));
  await assert.rejects(withTenant(3, tx => tx.query('SELECT 1')), { message: 'SELECT 1' });
  assert.equal(f.textos().at(-1), 'ROLLBACK');
});

test('puede usar una transaccion existente sin abrir ni confirmar otra', async () => {
  const llamadas = [];
  const withTenant = crearWithTenant({
    transaction() { throw new Error('no debe abrir otra transaccion'); },
  });
  const tx = {
    async query(texto, parametros) {
      llamadas.push({ texto, parametros });
      if (texto.includes('current_setting(@clave, true) AS cooperativa_id')) {
        return { rows: [{ cooperativa_id: '9', conexion_id: '1', transaccion_id: '2' }] };
      }
      return { rows: [] };
    },
  };

  await withTenant(9, actual => actual.query('SELECT 1'), tx);
  assert.deepEqual(llamadas.map(f => f.texto), [
    'SELECT set_config(@clave, @valor, true)',
    `SELECT current_setting(@clave, true) AS cooperativa_id,
                pg_backend_pid()::text AS conexion_id,
                txid_current_if_assigned()::text AS transaccion_id`,
    'SELECT 1',
    `SELECT current_setting(@clave, true) AS cooperativa_id,
                pg_backend_pid()::text AS conexion_id,
                txid_current_if_assigned()::text AS transaccion_id`,
  ]);
  assert.deepEqual(llamadas[0].parametros, { clave: CLAVE_TENANT, valor: '9' });
  await assert.rejects(withTenant(9, async () => {}, {}), /transaccionExistente/);
});

test('aborta, alerta y descarta la conexion si el tenant cambia durante el trabajo', async () => {
  const f = poolFalso();
  const alertas = [];
  const withTenant = crearWithTenant(createDatabase(f.pool), {
    alertarDesvio: evento => alertas.push(evento),
  });
  await assert.rejects(withTenant(4, async () => f.cambiarTenant(5), null, {
    solicitudId: 'sol-1', usuarioLogin: 'admin',
  }), error => error.code === 'TECNIFIN_TENANT_CONTEXT_DRIFT');
  assert.equal(f.textos().at(-1), 'ROLLBACK');
  assert.equal(f.liberaciones.length, 1);
  assert.equal(f.liberaciones[0].code, 'TECNIFIN_TENANT_CONTEXT_DRIFT');
  assert.deepEqual(alertas, [{
    tipo: 'DESVIO_CONTEXTO_TENANT', fase: 'salida', cooperativaEsperada: 4,
    cooperativaObservada: '5', solicitudId: 'sol-1', usuarioLogin: 'admin',
    conexionId: '99', transaccionId: '7',
  }]);
});

test('crearWithTenant exige una base con transaction()', () => {
  for (const malo of [null, {}, { query: () => {} }]) assert.throws(() => crearWithTenant(malo), TypeError);
});
