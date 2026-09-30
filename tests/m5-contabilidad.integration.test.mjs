// M5 · contabilidad, patron 09: libro diario, balance jerarquico, mayor con saldo acumulado,
// asiento manual y cierre de periodo, sobre el mismo libro que escriben los modulos.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { crearAplicacion } from '../src/app.js';
import { hashearClave } from '../src/platform/credenciales.js';
import { crearJwt } from '../src/platform/jwt.js';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { cedulaDesdeBase } from '../src/platform/identificacion.js';
import { crearServicioPlataforma } from '../src/modules/plataforma/servicio.js';
import { crearServicioSocios } from '../src/modules/socios/servicio.js';
import { crearServicioCaja } from '../src/modules/caja/servicio.js';
import { crearServicioContabilidad } from '../src/modules/contabilidad/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_m5_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m5-contabilidad-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m5-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB;
const t = {};

async function preparar(cooperativa) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol] of [['caja', 'TELLER'], ['gerente', 'MANAGER']]) {
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol) VALUES (@login, @nombre, @hash, @rol)`,
        { login, nombre: `Usuario ${login}`, hash: await hashearClave(login, `clave-${login}-2026`), rol });
    }
    await tx.query(`INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
    await tx.query(
      `INSERT INTO tecnifin.productos_financieros (codigo_producto, nombre, tipo_deposito, es_certificado, cuenta_activa, cuenta_inactiva)
       VALUES (2, 'AHORRO A LA VISTA', 'AHORRO A LA VISTA', false, '210135', '210135')`);
  });
}

async function llamar(ruta, { metodo = 'GET', token, cuerpo } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(baseUrl + ruta, { method: metodo, headers,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { estado: r.status, cuerpo: await r.json() };
}
const entrar = async (cooperativa, usuario) => (await llamar('/api/auth/login', { metodo: 'POST',
  cuerpo: { cooperativa, usuario, clave: `clave-${usuario}-2026` } })).cuerpo.token;
const cuenta = (balance, codigo) => balance.cuentas.find(c => c.codigo === codigo);

before(async () => {
  const configuracion = postgresConfig();
  await crearBaseLocal(configuracion, nombreBase,
    { dueno: entornoAdmin().TECNIFIN_PG_USER, aplicacion: configuracion.user });
  creada = true;
  await migrarBase(entorno);
  admin = connectPostgres(entornoAdmin(entorno));
  app = connectPostgres(entorno);
  withTenant = crearWithTenant(app);
  [coopA, coopB] = await crearDosCooperativas(admin, withTenant);
  await Promise.all([preparar(coopA), preparar(coopB)]);

  const jwt = crearJwt(entornoJwt);
  servidor = createServer(crearAplicacion(crearServicioPlataforma({ db: app, jwt }), {
    socios: crearServicioSocios({ db: app, jwt }), caja: crearServicioCaja({ db: app, jwt }),
    contabilidad: crearServicioContabilidad({ db: app, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [t.caja, t.gerente, t.gerenteB] = await Promise.all([entrar('COOP-A', 'caja'), entrar('COOP-A', 'gerente'), entrar('COOP-B', 'gerente')]);

  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Eva', primerApellido: 'Chango' } });
  const ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: ahorro, tipo: 'DEPOSITO', monto: '150.25' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: ahorro, tipo: 'RETIRO', monto: '50.25' } });
});

after(async () => {
  if (servidor) await new Promise(resolve => servidor.close(resolve));
  if (app) await app.close();
  if (admin) await admin.close();
  if (creada) {
    const superusuario = await conectarSuperusuario(postgresConfig());
    try { await borrarBaseLocal(superusuario, nombreBase); }
    finally { await superusuario.end(); }
  }
});

test('libro diario: los asientos de caja con sus lineas, del mas reciente al mas antiguo', async () => {
  const r = await llamar('/api/contabilidad/libro-diario', { token: t.gerente });
  assert.equal(r.estado, 200);
  assert.equal(r.cuerpo.asientos.length, 2);
  assert.equal(r.cuerpo.asientos[0].documento, 'COMPROBANTE_CAJA');
  assert.deepEqual(r.cuerpo.asientos[1].lineas.map(l => [l.cuenta, l.tipo, l.valor]),
    [['110105', 'D', '150.25'], ['210135', 'H', '150.25']]);
  assert.equal((await llamar('/api/contabilidad/libro-diario', { token: t.caja })).estado, 403);
});

test('balance de comprobacion: cuadrado, jerarquico y con saldo segun la naturaleza', async () => {
  const b = (await llamar('/api/contabilidad/balance', { token: t.gerente })).cuerpo;
  assert.equal(b.cuadrado, true);
  assert.deepEqual([b.totalDebe, b.totalHaber], ['200.50', '200.50']);
  assert.deepEqual([cuenta(b, '110105').debe, cuenta(b, '110105').haber, cuenta(b, '110105').saldo], ['150.25', '50.25', '100.00']);
  assert.equal(cuenta(b, '210135').saldo, '100.00', 'el pasivo se lee Haber - Debe');
  assert.equal(cuenta(b, '1101').saldo, '100.00', 'el agrupador suma a sus hijas');
  assert.equal(cuenta(b, '1').saldo, '100.00');
  assert.equal(cuenta(b, '2').saldo, '100.00');
  const ayer = (await llamar('/api/contabilidad/balance?hasta=2020-01-01', { token: t.gerente })).cuerpo;
  assert.deepEqual([ayer.cuentas.length, ayer.totalDebe], [0, '0.00'], 'antes de los movimientos no hay saldo');
});

test('mayor de una cuenta: saldo inicial y acumulado linea por linea', async () => {
  const m = (await llamar('/api/contabilidad/mayor/210135', { token: t.gerente })).cuerpo;
  assert.equal(m.naturaleza, 'ACREEDORA');
  assert.deepEqual(m.movimientos.map(x => [x.tipo, x.valor, x.saldo]), [['H', '150.25', '150.25'], ['D', '50.25', '100.00']]);
  assert.equal(m.saldoFinal, '100.00');
  assert.equal((await llamar('/api/contabilidad/mayor/99999999', { token: t.gerente })).estado, 400);
});

test('asiento manual: cuadrado, sin agrupadoras, solo gerencia y auditado', async () => {
  const base = { concepto: 'Reconocimiento de otros ingresos' };
  assert.equal((await llamar('/api/contabilidad/asientos', { metodo: 'POST', token: t.gerente, cuerpo: { ...base,
    lineas: [{ cuenta: '110105', tipo: 'D', valor: '10' }, { cuenta: '569010', tipo: 'H', valor: '9.99' }] } })).estado, 400);
  assert.equal((await llamar('/api/contabilidad/asientos', { metodo: 'POST', token: t.gerente, cuerpo: { ...base,
    lineas: [{ cuenta: '1101', tipo: 'D', valor: '10' }, { cuenta: '569010', tipo: 'H', valor: '10' }] } })).estado, 400);
  assert.equal((await llamar('/api/contabilidad/asientos', { metodo: 'POST', token: t.caja, cuerpo: { ...base,
    lineas: [{ cuenta: '110105', tipo: 'D', valor: '10' }, { cuenta: '569010', tipo: 'H', valor: '10' }] } })).estado, 403);
  const ok = await llamar('/api/contabilidad/asientos', { metodo: 'POST', token: t.gerente, cuerpo: { ...base,
    lineas: [{ cuenta: '110105', tipo: 'D', valor: '10' }, { cuenta: '569010', tipo: 'H', valor: '10' }] } });
  assert.equal(ok.estado, 201);
  const b = (await llamar('/api/contabilidad/balance', { token: t.gerente })).cuerpo;
  assert.equal(cuenta(b, '569010').saldo, '10.00', 'ingreso de naturaleza acreedora');
  assert.equal(b.cuadrado, true);
});

test('cierre de periodo: solo meses terminados y una sola vez', async () => {
  const hoy = new Date(Date.now() - 5 * 3600 * 1000);
  const [anio, mes] = [hoy.getUTCFullYear(), hoy.getUTCMonth() + 1];
  const anterior = mes === 1 ? [anio - 1, 12] : [anio, mes - 1];
  assert.equal((await llamar(`/api/contabilidad/periodos/${anio}/${mes}/cerrar`, { metodo: 'POST', token: t.gerente })).estado, 409);
  const c = await llamar(`/api/contabilidad/periodos/${anterior[0]}/${anterior[1]}/cerrar`, { metodo: 'POST', token: t.gerente });
  assert.equal(c.estado, 200);
  assert.equal((await llamar(`/api/contabilidad/periodos/${anterior[0]}/${anterior[1]}/cerrar`, { metodo: 'POST', token: t.gerente })).estado, 409);
});

test('la cooperativa B tiene su propio libro, vacio', async () => {
  const b = (await llamar('/api/contabilidad/balance', { token: t.gerenteB })).cuerpo;
  assert.deepEqual([b.cuentas.length, b.totalDebe], [0, '0.00']);
});
