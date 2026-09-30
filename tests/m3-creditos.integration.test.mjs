// M3 · creditos, patron 06: solicitud -> decision -> desembolso, con la cartera
// contabilizada por banda de plazo remanente y descuentos configurables.
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
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_m3_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m3-creditos-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m3-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB;
const t = {};

async function preparar(cooperativa, conDescuentos) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol] of [['caja', 'TELLER'], ['oficial', 'CREDIT_OFFICER'], ['gerente', 'MANAGER'], ['gerente2', 'MANAGER']]) {
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
    await tx.query(
      `INSERT INTO tecnifin.tasas_credito (linea_credito, clase_credito, monto_minimo, monto_maximo, plazo_minimo, plazo_maximo,
                                          tasa_inicial, tasa_final, tasa_aplicable)
       VALUES ('CONSUMO ORDINARIO', 'CONSUMO', 100, 50000, 3, 60, 14, 16, 15),
              ('MICROCREDITO MINORISTA', 'MICROEMPRESA', 100, 20000, 3, 36, 20, 24, 22)`);
    if (conDescuentos) {
      await tx.query(
        `INSERT INTO tecnifin.descuentos_credito (codigo, nombre, porcentaje, cuenta_contable) VALUES
           ('COMISION', 'Comision de desembolso', 1.0, '529010'),
           ('FONDO', 'Fondo irrepartible de reserva', 0.5, '330105'),
           ('SOLCA', 'Contribucion SOLCA', 0.5, '250490')`);
    }
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
const solicitar = (token, extra = {}) => llamar('/api/creditos/solicitudes', { metodo: 'POST', token,
  cuerpo: { numeroSocio: 1, lineaCredito: 'CONSUMO ORDINARIO', monto: '6000', plazo: 12, destino: 'Consumo', ...extra } });
const decidir = (token, codigo, cuerpo) => llamar(`/api/creditos/solicitudes/${codigo}/decision`, { metodo: 'POST', token, cuerpo });

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
  await Promise.all([preparar(coopA, true), preparar(coopB, false)]);

  const jwt = crearJwt(entornoJwt);
  servidor = createServer(crearAplicacion(crearServicioPlataforma({ db: app, jwt }), {
    socios: crearServicioSocios({ db: app, jwt }), caja: crearServicioCaja({ db: app, jwt }),
    creditos: crearServicioCreditos({ db: app, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [t.caja, t.oficial, t.gerente, t.gerente2, t.oficialB] = await Promise.all([
    entrar('COOP-A', 'caja'), entrar('COOP-A', 'oficial'), entrar('COOP-A', 'gerente'), entrar('COOP-A', 'gerente2'),
    entrar('COOP-B', 'oficial')]);

  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Rosa', primerApellido: 'Yupanqui' } });
  t.certificado = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 1 } })).cuerpo.numeroCuenta;
  t.ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
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

test('lineas y simulacion: la tasa sale de la linea y los limites se validan', async () => {
  const lineas = await llamar('/api/creditos/lineas', { token: t.oficial });
  assert.deepEqual(lineas.cuerpo.map(l => [l.linea, l.segmento, l.tasa]),
    [['CONSUMO ORDINARIO', 'CONSUMO', '15.0000'], ['MICROCREDITO MINORISTA', 'MICROEMPRESA', '22.0000']]);
  const sim = await llamar('/api/creditos/simulacion', { metodo: 'POST', token: t.oficial,
    cuerpo: { lineaCredito: 'CONSUMO ORDINARIO', monto: '6000', plazo: 12, tasa: '1' } });
  assert.equal(sim.estado, 200);
  assert.equal(sim.cuerpo.tasa, '15.0000', 'la tasa del cliente se ignora');
  assert.equal(sim.cuerpo.cuota, '541.55');
  assert.equal((await llamar('/api/creditos/simulacion', { metodo: 'POST', token: t.oficial,
    cuerpo: { lineaCredito: 'CONSUMO ORDINARIO', monto: '60000', plazo: 12 } })).estado, 400);
  assert.equal((await llamar('/api/creditos/simulacion', { metodo: 'POST', token: t.oficial,
    cuerpo: { lineaCredito: 'CONSUMO ORDINARIO', monto: '600', plazo: 2 } })).estado, 400);
  assert.equal((await llamar('/api/creditos/lineas', { token: t.caja })).estado, 403, 'caja no analiza credito');
});

test('sin aportacion en certificados no hay solicitud; con ella se registra SOL-000001', async () => {
  const sin = await solicitar(t.oficial);
  assert.equal(sin.estado, 409);
  assert.match(sin.cuerpo.error, /certificados/);

  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  const dep = await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja,
    cuerpo: { numeroCuenta: t.certificado, tipo: 'DEPOSITO', monto: '25' } });
  assert.equal(dep.estado, 201);

  const ok = await solicitar(t.oficial);
  assert.equal(ok.estado, 201);
  assert.deepEqual([ok.cuerpo.codigo, ok.cuerpo.estado, ok.cuerpo.monto, ok.cuerpo.segmento, ok.cuerpo.cuota],
    ['SOL-000001', 'SOLICITADO', '6000.00', 'CONSUMO', '541.55']);
  const ver = await llamar('/api/creditos/solicitudes/SOL-000001', { token: t.gerente });
  assert.equal(ver.cuerpo.plan.length, 12);
});

test('decision: solo gerencia, nunca quien registro, el rechazo exige motivo', async () => {
  assert.equal((await decidir(t.oficial, 'SOL-000001', { decision: 'APROBAR' })).estado, 403);
  const propia = await solicitar(t.gerente, { monto: '1000', plazo: 6 });
  assert.equal(propia.cuerpo.codigo, 'SOL-000002');
  assert.equal((await decidir(t.gerente, 'SOL-000002', { decision: 'APROBAR' })).estado, 409, 'no aprueba la suya');
  assert.equal((await decidir(t.gerente2, 'SOL-000002', { decision: 'RECHAZAR' })).estado, 400, 'rechazo sin motivo');
  const rech = await decidir(t.gerente2, 'SOL-000002', { decision: 'RECHAZAR', observaciones: 'Capacidad de pago insuficiente' });
  assert.deepEqual(rech.cuerpo, { codigo: 'SOL-000002', estado: 'RECHAZADO' });
  assert.equal((await decidir(t.gerente2, 'SOL-000002', { decision: 'APROBAR' })).estado, 409, 'ya decidida');

  const apr = await decidir(t.gerente, 'SOL-000001', { decision: 'APROBAR', tipoAprobacion: 'COMITE', actaSesion: 'ACTA-2026-10' });
  assert.deepEqual(apr.cuerpo, { codigo: 'SOL-000001', estado: 'APROBADO' });
});

test('desembolso: solo a una cuenta de ahorro del socio y solo si esta aprobada', async () => {
  assert.equal((await llamar('/api/creditos/solicitudes/SOL-000002/desembolso', { metodo: 'POST', token: t.gerente,
    cuerpo: { numeroCuenta: t.ahorro } })).estado, 409, 'rechazada');
  assert.equal((await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente,
    cuerpo: { numeroCuenta: t.certificado } })).estado, 409, 'certificado no recibe desembolso');
  assert.equal((await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.oficial,
    cuerpo: { numeroCuenta: t.ahorro } })).estado, 403);

  const d = await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente,
    cuerpo: { numeroCuenta: t.ahorro } });
  assert.equal(d.estado, 201);
  // 6000 - 1 % (60) - 0,5 % (30) - 0,5 % (30) = 5880.
  assert.deepEqual([d.cuerpo.credito, d.cuerpo.monto, d.cuerpo.neto, d.cuerpo.saldoCuenta, d.cuerpo.cuotas],
    ['CRED-000001', '6000.00', '5880.00', '5880.00', 12]);
  assert.deepEqual(d.cuerpo.descuentos.map(x => [x.codigo, x.valor]), [['COMISION', '60.00'], ['FONDO', '30.00'], ['SOLCA', '30.00']]);
  assert.equal((await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente,
    cuerpo: { numeroCuenta: t.ahorro } })).estado, 409, 'no se desembolsa dos veces');
});

test('el capital de cada cuota queda en la banda de su plazo remanente, no todo en 140205', async () => {
  const cred = await llamar('/api/creditos/CRED-000001', { token: t.oficial });
  assert.equal(cred.estado, 200);
  // Banda esperada por los dias reales de cada cuota (1402: 1-30, 31-90, 91-180, 181-360, >360).
  const desembolso = Date.parse(`${cred.cuerpo.fechaDesembolso}T00:00:00Z`);
  for (const c of cred.cuerpo.tabla) {
    const dias = (Date.parse(`${c.fecha}T00:00:00Z`) - desembolso) / 86400000;
    const esperada = dias <= 30 ? '140205' : dias <= 90 ? '140210' : dias <= 180 ? '140215' : dias <= 360 ? '140220' : '140225';
    assert.equal(c.cuentaCapital, esperada, `cuota ${c.numero} a ${dias} dias`);
  }
  assert.ok(new Set(cred.cuerpo.tabla.map(c => c.cuentaCapital)).size >= 4, 'el capital se reparte en varias bandas');

  const libro = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT pc.codigo, d.tipo_asiento, d.valor::text AS valor
       FROM tecnifin.creditos cr
       JOIN tecnifin.detalle_asiento d ON d.asiento_id = cr.asiento_desembolso_id
       JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE cr.codigo = 'CRED-000001' ORDER BY d.tipo_asiento, pc.codigo`));
  const debe = libro.rows.filter(f => f.tipo_asiento === 'D');
  const haber = libro.rows.filter(f => f.tipo_asiento === 'H');
  assert.deepEqual(debe.map(f => f.codigo), [...new Set(cred.cuerpo.tabla.map(c => c.cuentaCapital))].sort());
  const suma = filas => filas.reduce((s, f) => s + Math.round(Number(f.valor) * 100), 0);
  assert.equal(suma(debe), 600000);
  assert.equal(suma(haber), 600000);
  assert.deepEqual(haber.map(f => [f.codigo, f.valor]),
    [['210135', '5880.00'], ['250490', '30.00'], ['330105', '30.00'], ['529010', '60.00']]);
  const capital = cred.cuerpo.tabla.reduce((s, c) => s + Math.round(Number(c.capital) * 100), 0);
  assert.equal(capital, 600000, 'la tabla suma exactamente el monto');
});

test('la cooperativa B no ve solicitudes ni creditos de A', async () => {
  assert.equal((await llamar('/api/creditos/solicitudes/SOL-000001', { token: t.oficialB })).estado, 404);
  assert.equal((await llamar('/api/creditos/CRED-000001', { token: t.oficialB })).estado, 404);
});

const pagar = (token, cuerpo) => llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token, cuerpo });
const anularPago = (token, n, motivo = 'Error de registro del pago') =>
  llamar(`/api/creditos/pagos/${n}/anular`, { metodo: 'POST', token, cuerpo: { motivo } });

test('pago por debito a la cuenta: capital desde su banda e interes a 510410', async () => {
  const r = await pagar(t.caja, { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.pago, r.cuerpo.cuotas, r.cuerpo.capital, r.cuerpo.interes, r.cuerpo.total, r.cuerpo.saldoCredito],
    [1, [1, 1], '466.55', '75.00', '541.55', '5533.45']);
  const cuenta = await llamar(`/api/cuentas/${t.ahorro}`, { token: t.caja });
  assert.equal(cuenta.cuerpo.saldo, '5338.45');
  const libro = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT pc.codigo, d.tipo_asiento, d.valor::text AS valor FROM tecnifin.pagos_credito p
       JOIN tecnifin.detalle_asiento d ON d.asiento_id = p.asiento_id
       JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE p.numero_pago = 1 ORDER BY d.tipo_asiento, pc.codigo`));
  assert.deepEqual(libro.rows.map(f => [f.codigo, f.tipo_asiento, f.valor]),
    [['210135', 'D', '541.55'], ['140205', 'H', '466.55'], ['510410', 'H', '75.00']]);
});

test('pago por caja: efectivo verificado, comprobante de caja y entra al cuadre como ingreso', async () => {
  assert.equal((await pagar(t.caja, { origen: 'CAJA', cuotas: 2, efectivo: [{ codigo: 'B100', cantidad: 1 }] })).estado, 400);
  const antes = (await llamar('/api/caja', { token: t.caja })).cuerpo.ingresos;
  const r = await pagar(t.caja, { origen: 'CAJA', cuotas: 2 });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.pago, r.cuerpo.cuotas, r.cuerpo.total], [2, [2, 3], '1083.10']);
  assert.ok(r.cuerpo.comprobante > 0);
  const despues = (await llamar('/api/caja', { token: t.caja })).cuerpo.ingresos;
  assert.equal((Number(despues) - Number(antes)).toFixed(2), '1083.10');
  assert.equal((await pagar(t.oficial, { origen: 'CAJA', cuotas: 1 })).estado, 403, 'el oficial no cobra');
});

test('anulacion de pagos: supervisor, en orden inverso, y todo vuelve a su lugar', async () => {
  assert.equal((await anularPago(t.caja, 2)).estado, 403, 'el cajero no anula');
  assert.equal((await anularPago(t.gerente, 1)).estado, 409, 'hay un pago posterior vigente');
  const a2 = await anularPago(t.gerente, 2);
  assert.equal(a2.estado, 200);
  assert.equal(a2.cuerpo.saldoCredito, '5533.45');
  const a1 = await anularPago(t.gerente, 1);
  assert.equal(a1.cuerpo.saldoCredito, '6000.00');
  assert.equal((await llamar(`/api/cuentas/${t.ahorro}`, { token: t.caja })).cuerpo.saldo, '5880.00');
  const cred = await llamar('/api/creditos/CRED-000001', { token: t.oficial });
  assert.ok(cred.cuerpo.tabla.every(q => q.estado === 'PENDIENTE'));
  const caja = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT anulado FROM tecnifin.transacciones_caja WHERE tipo_operacion = 'PAGO_CREDITO'`));
  assert.deepEqual(caja.rows, [{ anulado: true }]);
  assert.equal((await anularPago(t.gerente, 2)).estado, 409, 'ya anulado');
});

test('pagar todas las cuotas cancela el credito y cierra la tabla', async () => {
  assert.equal((await pagar(t.caja, { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 12 })).estado, 409, 'saldo insuficiente');
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja,
    cuerpo: { numeroCuenta: t.ahorro, tipo: 'DEPOSITO', monto: '1000' } });
  assert.equal((await pagar(t.caja, { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 13 })).estado, 409, 'solo quedan 12');
  const r = await pagar(t.caja, { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 12 });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.capital, r.cuerpo.saldoCredito, r.cuerpo.estadoCredito], ['6000.00', '0.00', 'CANCELADO']);
  assert.equal((await pagar(t.caja, { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 })).estado, 409);
});

test('libro mayor de la cooperativa: todo cuadra y la cartera del credito quedo en cero', async () => {
  const r = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT (SELECT (sum(valor) FILTER (WHERE tipo_asiento = 'D') - sum(valor) FILTER (WHERE tipo_asiento = 'H'))::text
               FROM tecnifin.detalle_asiento) AS descuadre,
            (SELECT coalesce(sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END), 0)::text
               FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
              WHERE pc.codigo >= '1401' AND pc.codigo < '1429') AS cartera`));
  assert.deepEqual(r.rows[0], { descuadre: '0.00', cartera: '0.00' });
});
