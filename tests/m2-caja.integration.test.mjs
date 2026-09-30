// M2 · caja y ventanilla, patron 05: el camino completo de un movimiento de dinero.
// Apertura, deposito y retiro con asiento en partida doble, desglose de efectivo verificado
// contra la base, concurrencia sobre la misma cuenta, anulacion por supervisor y cierre.
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
import { crearServicioCaja, montoValido } from '../src/modules/caja/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_m2_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m2-caja-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m2-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB;
const t = {};

async function preparar(cooperativa) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol] of [['caja', 'TELLER'], ['caja2', 'TELLER'], ['gerente', 'MANAGER'], ['oficial', 'CREDIT_OFFICER']]) {
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
         VALUES (@login, @nombre, @hash, @rol)`,
        { login, nombre: `Usuario ${login}`, hash: await hashearClave(login, `clave-${login}-2026`), rol });
    }
    await tx.query(`INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
    await tx.query(
      `INSERT INTO tecnifin.productos_financieros (codigo_producto, nombre, tipo_deposito, es_certificado, cuenta_activa, cuenta_inactiva)
       VALUES (1, 'CERTIFICADO DE APORTACION', 'CERTIFICADO', true, '310305', '310305'),
              (2, 'AHORRO A LA VISTA', 'AHORRO A LA VISTA', false, '210135', '210135')`);
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
const operar = (token, cuerpo) => llamar('/api/caja/transacciones', { metodo: 'POST', token, cuerpo });

async function socioConCuentas(token, base) {
  const socio = (await llamar('/api/socios', { metodo: 'POST', token, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase(base), primerNombre: 'Ana', primerApellido: `Socia ${base}` } })).cuerpo;
  const cert = (await llamar(`/api/socios/${socio.numeroSocio}/cuentas`, { metodo: 'POST', token, cuerpo: { codigoProducto: 1 } })).cuerpo;
  const ahorro = (await llamar(`/api/socios/${socio.numeroSocio}/cuentas`, { metodo: 'POST', token, cuerpo: { codigoProducto: 2 } })).cuerpo;
  return { socio: socio.numeroSocio, certificado: cert.numeroCuenta, ahorro: ahorro.numeroCuenta };
}

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
    socios: crearServicioSocios({ db: app, jwt }), caja: crearServicioCaja({ db: app, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [t.caja, t.caja2, t.gerente, t.oficial, t.cajaB] = await Promise.all([
    entrar('COOP-A', 'caja'), entrar('COOP-A', 'caja2'), entrar('COOP-A', 'gerente'), entrar('COOP-A', 'oficial'),
    entrar('COOP-B', 'caja')]);
  t.cuentas = await socioConCuentas(t.caja, '170000011');
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

test('el monto se valida como texto con 2 decimales, sin coma flotante', () => {
  assert.equal(montoValido('150.25'), '150.25');
  assert.equal(montoValido(10), '10');
  for (const malo of ['0', '0.00', '-5', '1.234', 'abc', '', '1e3', '10000000000000000']) {
    assert.throws(() => montoValido(malo), `${malo} deberia rechazarse`);
  }
});

test('sin caja abierta no se opera; la apertura valida el efectivo contra la base', async () => {
  assert.equal((await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'DEPOSITO', monto: '10' })).estado, 409);
  assert.equal((await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja,
    cuerpo: { saldoApertura: '200.00', efectivo: [{ codigo: 'B100', cantidad: 1 }] } })).estado, 400);
  assert.equal((await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja,
    cuerpo: { saldoApertura: '5', efectivo: [{ codigo: 'B7', cantidad: 1 }] } })).estado, 400);
  const ok = await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja,
    cuerpo: { saldoApertura: '200.00', efectivo: [{ codigo: 'B100', cantidad: 2 }] } });
  assert.equal(ok.estado, 201);
  assert.equal(ok.cuerpo.saldoApertura, '200.00');
  assert.equal((await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '1' } })).estado, 409);
  assert.equal((await llamar('/api/caja/apertura', { metodo: 'POST', token: t.oficial, cuerpo: { saldoApertura: '1' } })).estado, 403);
});

test('deposito: comprobante 1, saldo, movimiento y asiento cuadrado contra caja y ahorros', async () => {
  const r = await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'DEPOSITO', monto: '150.25',
    concepto: 'Deposito de prueba',
    efectivo: [{ codigo: 'B100', cantidad: 1 }, { codigo: 'B50', cantidad: 1 }, { codigo: 'M0.25', cantidad: 1 }] });
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.comprobante, 1);
  assert.equal(r.cuerpo.monto, '150.25');
  assert.equal(r.cuerpo.saldo, '150.25');
  assert.match(r.cuerpo.fecha, /-05:00$/);

  const libro = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT pc.codigo, d.tipo_asiento, d.valor
       FROM tecnifin.transacciones_caja t
       JOIN tecnifin.detalle_asiento d ON d.asiento_id = t.asiento_contable_id
       JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE t.numero_comprobante = 1 ORDER BY d.tipo_asiento`));
  assert.deepEqual(libro.rows, [
    { codigo: '110105', tipo_asiento: 'D', valor: '150.25' }, { codigo: '210135', tipo_asiento: 'H', valor: '150.25' }]);
  const detalle = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT sum(total)::text AS s, count(*)::int AS n FROM tecnifin.detalle_efectivo_transaccion`));
  assert.deepEqual(detalle.rows[0], { s: '150.25', n: 3 });
  const movimiento = await llamar(`/api/cuentas/${t.cuentas.ahorro}/movimientos`, { token: t.caja });
  assert.deepEqual(movimiento.cuerpo.movimientos.map(m => [m.tipo, m.monto, m.saldoResultante]),
    [['DEPOSITO', '150.25', '150.25']]);
});

test('el efectivo que no suma el monto se rechaza y no deja rastro', async () => {
  const r = await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'DEPOSITO', monto: '30',
    efectivo: [{ codigo: 'B20', cantidad: 1 }] });
  assert.equal(r.estado, 400);
  const n = await withTenant(coopA.cooperativa_id, tx => tx.query(`SELECT count(*)::int AS n FROM tecnifin.transacciones_caja`));
  assert.equal(n.rows[0].n, 1);
});

test('retiro: saldo insuficiente 409, certificado no admite retiro, retiro valido descuenta', async () => {
  assert.equal((await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'RETIRO', monto: '150.26' })).estado, 409);
  assert.equal((await operar(t.caja, { numeroCuenta: t.cuentas.certificado, tipo: 'RETIRO', monto: '1' })).estado, 409);
  const r = await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'RETIRO', monto: '50.25' });
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.saldo, '100.00');
});

test('10 retiros simultaneos de 20 sobre 100: exactamente 5 pasan y el saldo nunca es negativo', async () => {
  const resultados = await Promise.all(Array.from({ length: 10 }, () =>
    operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'RETIRO', monto: '20' })));
  assert.equal(resultados.filter(r => r.estado === 201).length, 5);
  assert.equal(resultados.filter(r => r.estado === 409).length, 5);
  const cuenta = await llamar(`/api/cuentas/${t.cuentas.ahorro}`, { token: t.caja });
  assert.equal(cuenta.cuerpo.saldo, '0.00');
  const saldos = resultados.filter(r => r.estado === 201).map(r => r.cuerpo.saldo).sort();
  assert.deepEqual(saldos, ['0.00', '20.00', '40.00', '60.00', '80.00']);
});

test('anulacion: solo supervisor, nunca el mismo que cobro, en el dia, con asiento contrario', async () => {
  const dep = (await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'DEPOSITO', monto: '40' })).cuerpo;
  assert.equal((await llamar(`/api/caja/transacciones/${dep.comprobante}/anular`, { metodo: 'POST', token: t.caja,
    cuerpo: { motivo: 'Error de digitacion' } })).estado, 403);
  assert.equal((await llamar(`/api/caja/transacciones/${dep.comprobante}/anular`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'no' } })).estado, 400);
  const ok = await llamar(`/api/caja/transacciones/${dep.comprobante}/anular`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'Error de digitacion del monto' } });
  assert.equal(ok.estado, 200);
  assert.equal(ok.cuerpo.saldo, '0.00');
  assert.equal((await llamar(`/api/caja/transacciones/${dep.comprobante}/anular`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'Otra vez la misma' } })).estado, 409);

  const asientos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT pc.codigo, d.tipo_asiento FROM tecnifin.asientos_contables a
       JOIN tecnifin.detalle_asiento d ON d.asiento_id = a.asiento_id
       JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE a.origen_modulo = 'CAJA' AND a.origen_id = @c ORDER BY a.asiento_id, d.tipo_asiento`,
    { c: String(dep.comprobante) }));
  assert.deepEqual(asientos.rows.map(f => `${f.codigo}${f.tipo_asiento}`),
    ['110105D', '210135H', '210135D', '110105H'], 'el original y su reverso');
  const fila = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT anulado, motivo_anulacion FROM tecnifin.transacciones_caja WHERE numero_comprobante = @c`, { c: dep.comprobante }));
  assert.deepEqual(fila.rows[0], { anulado: true, motivo_anulacion: 'Error de digitacion del monto' });
});

test('la cooperativa B no ve ni anula comprobantes de A', async () => {
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.cajaB, cuerpo: { saldoApertura: '0' } });
  assert.equal((await operar(t.cajaB, { numeroCuenta: t.cuentas.ahorro, tipo: 'DEPOSITO', monto: '5' })).estado, 404);
});

test('cierre: esperado = apertura + depositos - retiros sin anulados; despues no se opera', async () => {
  const estado = await llamar('/api/caja', { token: t.caja });
  // 200 + 150.25 depositados - (50.25 + 5 x 20) retirados; el deposito de 40 esta anulado.
  assert.deepEqual([estado.cuerpo.ingresos, estado.cuerpo.egresos, estado.cuerpo.saldoEsperado, estado.cuerpo.anuladas],
    ['150.25', '150.25', '200.00', 1]);
  const cierre = await llamar('/api/caja/cierre', { metodo: 'POST', token: t.caja,
    cuerpo: { efectivo: [{ codigo: 'B100', cantidad: 1 }, { codigo: 'B50', cantidad: 1 }, { codigo: 'B20', cantidad: 2 }] } });
  assert.equal(cierre.estado, 200);
  assert.deepEqual([cierre.cuerpo.saldoEsperado, cierre.cuerpo.saldoContado, cierre.cuerpo.diferencia],
    ['200.00', '190.00', '-10.00']);
  assert.equal((await operar(t.caja, { numeroCuenta: t.cuentas.ahorro, tipo: 'DEPOSITO', monto: '1' })).estado, 409);
  assert.equal((await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '1' } })).estado, 409);
});

test('libro mayor: todo lo contabilizado por caja cuadra y la cuenta coincide con sus movimientos', async () => {
  const r = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT (SELECT sum(valor) FILTER (WHERE tipo_asiento = 'D') - sum(valor) FILTER (WHERE tipo_asiento = 'H')
               FROM tecnifin.detalle_asiento)::text AS descuadre,
            (SELECT saldo::text FROM tecnifin.cuentas WHERE numero_cuenta = @c) AS saldo,
            (SELECT saldo_resultante::text FROM tecnifin.movimientos_cuenta m JOIN tecnifin.cuentas c USING (cooperativa_id, cuenta_id)
              WHERE c.numero_cuenta = @c ORDER BY m.movimiento_id DESC LIMIT 1) AS ultimo`, { c: t.cuentas.ahorro }));
  assert.deepEqual(r.rows[0], { descuadre: '0.00', saldo: '0.00', ultimo: '0.00' });
});
