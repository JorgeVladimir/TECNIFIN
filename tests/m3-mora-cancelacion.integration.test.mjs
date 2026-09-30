// M3: interes de mora en el cobro de cuotas vencidas, anulacion que devuelve la cuota a su
// estado real, y cancelacion anticipada sin penalizacion (interes solo hasta hoy).
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
import { crearServicioCartera } from '../src/modules/cartera/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_mora_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-mora-cancelacion-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-mora-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB;
const t = {};
const c2 = (x) => Math.round(x * 100) / 100;

async function preparar(cooperativa) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol] of [['caja', 'TELLER'], ['oficial', 'CREDIT_OFFICER'], ['gerente', 'MANAGER'], ['gerente2', 'MANAGER']]) {
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
const tabla = async () => (await llamar('/api/creditos/CRED-000001', { token: t.oficial })).cuerpo.tabla;
const diasDesde = (fecha) => {
  const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  return (Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${fecha}T00:00:00Z`)) / 86400000;
};

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
    creditos: crearServicioCreditos({ db: app, jwt }), cartera: crearServicioCartera({ db: app, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [t.caja, t.oficial, t.gerente, t.gerente2] = await Promise.all([
    entrar('COOP-A', 'caja'), entrar('COOP-A', 'oficial'), entrar('COOP-A', 'gerente'), entrar('COOP-A', 'gerente2')]);

  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Rene', primerApellido: 'Toapanta' } });
  const cert = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 1 } })).cuerpo.numeroCuenta;
  t.ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: cert, tipo: 'DEPOSITO', monto: '10' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: t.ahorro, tipo: 'DEPOSITO', monto: '1000' } });
  await llamar('/api/creditos/solicitudes', { metodo: 'POST', token: t.oficial,
    cuerpo: { numeroSocio: 1, lineaCredito: 'CONSUMO ORDINARIO', monto: '6000', plazo: 12 } });
  await llamar('/api/creditos/solicitudes/SOL-000001/decision', { metodo: 'POST', token: t.gerente, cuerpo: { decision: 'APROBAR' } });
  await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente, cuerpo: { numeroCuenta: t.ahorro } });
  // 45 dias atras: la primera cuota queda vencida y la segunda en curso.
  await withTenant(coopA.cooperativa_id, async tx => {
    await tx.query(`UPDATE tecnifin.creditos SET fecha_desembolso = fecha_desembolso - 45`);
    await tx.query(`UPDATE tecnifin.tabla_amortizacion SET fecha_pago = fecha_pago - 45`);
  });
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

test('la cuota vencida se cobra con interes de mora: capital x tasa x 1,1 x dias / 360, a 510430', async () => {
  // El proceso de cartera marca la cuota vencida (VENCIDA) antes del cobro.
  assert.equal((await llamar('/api/cartera/procesos', { metodo: 'POST', token: t.gerente, cuerpo: { aplicar: true } })).estado, 201);
  const q1 = (await tabla())[0];
  assert.equal(q1.estado, 'VENCIDA');
  const dias = diasDesde(q1.fecha);
  const mora = c2(Number(q1.capital) * 0.15 * 1.1 * dias / 360).toFixed(2);
  const r = await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 } });
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.mora, mora);
  assert.equal(r.cuerpo.total, (Number(q1.total) + Number(mora)).toFixed(2));
  const libro = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT d.valor::text AS valor FROM tecnifin.pagos_credito p
       JOIN tecnifin.detalle_asiento d ON d.asiento_id = p.asiento_id
       JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE p.numero_pago = @n AND pc.codigo = '510430'`, { n: r.cuerpo.pago }));
  assert.deepEqual(libro.rows, [{ valor: mora }]);
  t.pagoMora = r.cuerpo.pago;
});

test('anular el pago devuelve la cuota a VENCIDA (su estado real), no a PENDIENTE', async () => {
  const a = await llamar(`/api/creditos/pagos/${t.pagoMora}/anular`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'Debito equivocado' } });
  assert.equal(a.estado, 200);
  const q1 = (await tabla())[0];
  assert.equal(q1.estado, 'VENCIDA');
});

test('liquidacion de cancelacion: vencida completa con mora, en curso con interes corrido, futuras sin interes', async () => {
  const cuotas = await tabla();
  const [q1, q2] = cuotas;
  const dias = diasDesde(q1.fecha);
  const noVencido = 6000 - Number(q1.capital);
  const corrido = Math.min(c2(noVencido * 0.15 * dias / 360), Number(q2.interes));
  const mora = c2(Number(q1.capital) * 0.15 * 1.1 * dias / 360);
  const l = await llamar('/api/creditos/CRED-000001/cancelacion', { token: t.caja });
  assert.equal(l.estado, 200);
  assert.deepEqual([l.cuerpo.cuotas, l.cuerpo.capital, l.cuerpo.interes, l.cuerpo.mora],
    [12, '6000.00', (Number(q1.interes) + corrido).toFixed(2), mora.toFixed(2)]);
  t.totalCancelacion = l.cuerpo.total;
});

test('cancelacion anticipada: sin penalizacion, credito CANCELADO y cartera en cero', async () => {
  const r = await llamar('/api/creditos/CRED-000001/cancelacion', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro } });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.tipo, r.cuerpo.total, r.cuerpo.saldoCredito, r.cuerpo.estadoCredito],
    ['CANCELACION', t.totalCancelacion, '0.00', 'CANCELADO']);
  const libro = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT (sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END)
               FILTER (WHERE pc.codigo >= '1401' AND pc.codigo < '1429'))::text AS cartera,
            (sum(valor) FILTER (WHERE tipo_asiento = 'D') - sum(valor) FILTER (WHERE tipo_asiento = 'H'))::text AS descuadre
       FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id`));
  assert.deepEqual(libro.rows[0], { cartera: '0.00', descuadre: '0.00' });
  assert.equal((await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro } })).estado, 409);
});

test('la cancelacion se anula como cualquier pago y el credito vuelve a VIGENTE', async () => {
  const pagos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT numero_pago FROM tecnifin.pagos_credito WHERE tipo = 'CANCELACION'`));
  const a = await llamar(`/api/creditos/pagos/${pagos.rows[0].numero_pago}/anular`, { metodo: 'POST', token: t.gerente2,
    cuerpo: { motivo: 'El socio desistio de cancelar' } });
  assert.equal(a.estado, 200);
  assert.equal(a.cuerpo.saldoCredito, '6000.00');
  const cuotas = await tabla();
  assert.equal(cuotas[0].estado, 'VENCIDA');
  assert.ok(cuotas.slice(1).every(q => q.estado === 'PENDIENTE'));
});
