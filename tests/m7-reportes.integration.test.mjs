// M7 · reportes SEPS, patron 10: cada reporte sale del mismo libro y del mismo motor de cartera,
// y se contrasta contra cifras calculadas a mano sobre un escenario armado por la API.
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
import { crearServicioCreditos } from '../src/modules/creditos/servicio.js';
import { crearServicioReportes } from '../src/modules/reportes/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_m7_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m7-reportes-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m7-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB;
const t = {};

async function preparar(cooperativa) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol] of [['caja', 'TELLER'], ['oficial', 'CREDIT_OFFICER'], ['gerente', 'MANAGER']]) {
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol) VALUES (@login, @nombre, @hash, @rol)`,
        { login, nombre: `Usuario ${login}`, hash: await hashearClave(login, `clave-${login}-2026`), rol });
    }
    await tx.query(`INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
    await tx.query(
      `INSERT INTO tecnifin.productos_financieros (codigo_producto, nombre, tipo_deposito, es_certificado, cuenta_activa, cuenta_inactiva)
       VALUES (1, 'CERTIFICADO DE APORTACION', 'CERTIFICADO', true, '310305', '310305'),
              (2, 'AHORRO A LA VISTA', 'AHORRO A LA VISTA', false, '210135', '210135')`);
    await tx.query(
      `INSERT INTO tecnifin.tasas_credito (linea_credito, clase_credito, monto_minimo, monto_maximo, plazo_minimo, plazo_maximo,
                                          tasa_inicial, tasa_final, tasa_aplicable)
       VALUES ('CONSUMO ORDINARIO', 'CONSUMO', 100, 50000, 3, 60, 14, 16, 15)`);
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
const reporte = (nombre, extra = '') => llamar(`/api/reportes/${nombre}${extra}`, { token: t.gerente });

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
    creditos: crearServicioCreditos({ db: app, jwt }), reportes: crearServicioReportes({ db: app, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [t.caja, t.oficial, t.gerente, t.gerenteB] = await Promise.all([
    entrar('COOP-A', 'caja'), entrar('COOP-A', 'oficial'), entrar('COOP-A', 'gerente'), entrar('COOP-B', 'gerente')]);

  // Escenario: certificado 25, deposito en efectivo 6000 y un credito de 6000 acreditado a la cuenta.
  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Ines', primerApellido: 'Pilco' } });
  const cert = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 1 } })).cuerpo.numeroCuenta;
  t.ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: cert, tipo: 'DEPOSITO', monto: '25' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: t.ahorro, tipo: 'DEPOSITO', monto: '6000' } });
  await llamar('/api/creditos/solicitudes', { metodo: 'POST', token: t.oficial,
    cuerpo: { numeroSocio: 1, lineaCredito: 'CONSUMO ORDINARIO', monto: '6000', plazo: 12 } });
  await llamar('/api/creditos/solicitudes/SOL-000001/decision', { metodo: 'POST', token: t.gerente, cuerpo: { decision: 'APROBAR' } });
  await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente, cuerpo: { numeroCuenta: t.ahorro } });
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

test('ESF: activo = pasivo + patrimonio, por rubro del Catalogo Unico', async () => {
  const r = (await reporte('esf')).cuerpo;
  assert.equal(r.cuadrado, true);
  // Activo: caja 6025 + cartera 6000. Pasivo: ahorros 6000 + 6000 del desembolso. Patrimonio: certificados 25.
  assert.deepEqual([r.totalActivo, r.totalPasivo, r.totalPatrimonio], ['12025.00', '12000.00', '25.00']);
  assert.deepEqual(r.activo.map(x => [x.codigo, x.monto]), [['11', '6025.00'], ['14', '6000.00']]);
  assert.deepEqual(r.pasivo.map(x => [x.codigo, x.monto]), [['21', '12000.00']]);
});

test('B11: la cartera por cuenta, segmento, estado y banda suma la cartera bruta', async () => {
  const r = (await reporte('b11')).cuerpo;
  assert.equal(r.totales.carteraBruta, '6000.00');
  assert.equal(r.totales.morosidad, '0.00');
  assert.ok(r.filas.every(f => f.segmento === 'CONSUMO' && f.estado === 'POR VENCER' && f.cuentaSeps.startsWith('1402')));
  const suma = r.filas.reduce((s, f) => s + Math.round(Number(f.saldo) * 100), 0);
  assert.equal(suma, 600000);
  assert.deepEqual(r.operaciones.map(o => [o.calificacion, o.provision]), [['A1', '60.00']]);
});

test('PERLAS: liquidez, morosidad y participacion calculadas sobre el libro; sin alertas', async () => {
  const r = (await reporte('perlas')).cuerpo;
  const valor = (nombre) => r.indicadores.find(i => i.nombre === nombre).valor;
  assert.equal(valor('Indicador de liquidez'), '50.21', '6025 / 12000');
  assert.equal(valor('Morosidad ampliada'), '0.00');
  assert.equal(valor('Participacion de la cartera en el activo'), '49.90', '6000 / 12025');
  assert.equal(r.solvencia.minimo, '9.00');
  assert.deepEqual(r.alertas.filter(a => !a.startsWith('Solvencia')), []);
});

test('solvencia: activos ponderados por categoria y patrimonio tecnico', async () => {
  const r = (await reporte('solvencia')).cuerpo;
  assert.equal(r.activoContable, '12025.00');
  assert.ok(Number(r.activosPonderados) > 0 && Number(r.activosPonderados) <= 12025);
  assert.equal(r.solvencia.minimo, '9.00');
  assert.ok(r.categorias.length >= 1);
});

test('UAF: operaciones en efectivo sobre 5.000 y acumulado mensual sobre 10.000', async () => {
  const r1 = (await reporte('uaf')).cuerpo;
  assert.deepEqual(r1.individuales.map(x => [x.operacion, x.monto]), [['DEPOSITO_AHORROS', '6000.00']]);
  assert.deepEqual(r1.acumuladas, [], '6025 en el mes no llega a 10000');
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: t.ahorro, tipo: 'DEPOSITO', monto: '4000' } });
  const r2 = (await reporte('uaf')).cuerpo;
  assert.deepEqual(r2.acumuladas.map(x => [x.numeroSocio, x.operaciones, x.total]), [[1, 3, '10025.00']]);
  assert.equal((await reporte('uaf', '?periodo=2026-13')).estado, 400);
});

test('situacion general: resumen operativo coherente con el libro', async () => {
  const r = (await reporte('situacion-general')).cuerpo;
  assert.deepEqual([r.sociosActivos, r.ahorroVista, r.certificadosAportacion, r.creditosVigentes, r.carteraVigente],
    [1, '16000.00', '25.00', 1, '6000.00']);
});

test('los reportes son de gerencia y cada cooperativa ve solo lo suyo', async () => {
  assert.equal((await llamar('/api/reportes/esf', { token: t.caja })).estado, 403);
  const b = (await llamar('/api/reportes/esf', { token: t.gerenteB })).cuerpo;
  assert.deepEqual([b.totalActivo, b.activo.length], ['0.00', 0]);
  assert.equal((await llamar('/api/reportes/esf?fecha=2999-01-01', { token: t.gerente })).estado, 400);
});
