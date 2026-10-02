// M3: abono extraordinario a capital. Reduce la cuota o el plazo desde la cuota siguiente a la
// que esta en curso, mueve solo la diferencia de capital por subcuenta y se anula exacto.
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

const nombreBase = `tecnifin_abono_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-abono-capital-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-abono-pruebas',
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
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: t.ahorro, tipo: 'DEPOSITO', monto: '5000' } });
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

const libro = async () => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT (sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END)
             FILTER (WHERE pc.codigo >= '1401' AND pc.codigo < '1429'))::text AS cartera,
          (sum(valor) FILTER (WHERE tipo_asiento = 'D') - sum(valor) FILTER (WHERE tipo_asiento = 'H'))::text AS descuadre
     FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id`))).rows[0];
// El mayor de cada subcuenta de cartera debe ser igual al capital pendiente de las cuotas que apuntan a ella.
const porSubcuenta = async () => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `WITH mayor AS (
     SELECT pc.codigo, sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END) AS saldo
       FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE pc.codigo >= '1401' AND pc.codigo < '1429' GROUP BY pc.codigo),
   cuotas AS (
     SELECT cuenta_capital AS codigo, sum(capital) AS saldo FROM tecnifin.tabla_amortizacion
      WHERE estado IN ('PENDIENTE', 'VENCIDA') GROUP BY cuenta_capital)
   SELECT count(*)::int AS n FROM mayor m FULL JOIN cuotas c USING (codigo)
    WHERE coalesce(m.saldo, 0) <> coalesce(c.saldo, 0)`))).rows[0].n;
const suma = (cuotas, campo) => cuotas.reduce((s, q) => s + Math.round(Number(q[campo]) * 100), 0) / 100;

test('entradas invalidas y abono que cubre todo lo que falta se rechazan', async () => {
  const ruta = '/api/creditos/CRED-000001/abonos/simulacion';
  assert.equal((await llamar(ruta, { metodo: 'POST', token: t.caja, cuerpo: { monto: '-5' } })).estado, 400);
  assert.equal((await llamar(ruta, { metodo: 'POST', token: t.caja, cuerpo: { monto: '10', modalidad: 'OTRA' } })).estado, 400);
  const cuotas = await tabla();
  const resto = (6000 - Number(cuotas[0].capital)).toFixed(2);
  const r = await llamar(ruta, { metodo: 'POST', token: t.caja, cuerpo: { monto: resto } });
  assert.equal(r.estado, 409);
  assert.match(r.cuerpo.error, /cancelacion anticipada/);
});

test('simulacion REDUCIR_CUOTA: misma cantidad de cuotas, cuota menor y ahorro de interes', async () => {
  const r = await llamar('/api/creditos/CRED-000001/abonos/simulacion', { metodo: 'POST', token: t.caja,
    cuerpo: { monto: '1000' } });
  assert.equal(r.estado, 200);
  assert.equal(r.cuerpo.cuotasRestantes, 12);
  assert.equal(r.cuerpo.cuotas.length, 11);
  assert.ok(Number(r.cuerpo.nuevaCuota) < 541.55);
  assert.ok(Number(r.cuerpo.ahorroInteres) > 0);
  // Solo simula: la tabla no cambio.
  assert.equal(suma(await tabla(), 'capital'), 6000);
});

test('abono REDUCIR_CUOTA por cuenta: la cuota en curso no cambia, el saldo baja y el mayor cuadra por subcuenta', async () => {
  const antes = await tabla();
  const r = await llamar('/api/creditos/CRED-000001/abonos', { metodo: 'POST', token: t.caja,
    cuerpo: { monto: '1000', origen: 'CUENTA', numeroCuenta: t.ahorro } });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.tipo, r.cuerpo.total, r.cuerpo.saldoCredito], ['ABONO', '1000.00', '5000.00']);
  const despues = await tabla();
  assert.deepEqual(despues[0], antes[0]);
  assert.equal(suma(despues, 'capital'), 5000);
  assert.ok(despues.slice(1).every(q => q.estado === 'PENDIENTE' && Number(q.total) < Number(antes[1].total)));
  assert.equal(r.cuerpo.vence, antes.at(-1).fecha);
  assert.deepEqual(await libro(), { cartera: '5000.00', descuadre: '0.00' });
  assert.equal(await porSubcuenta(), 0);
  t.abono1 = r.cuerpo.pago;
  t.tablaOriginal = antes;
});

test('anular el abono devuelve la tabla y el saldo exactos; quien cobro no puede anular', async () => {
  const ruta = `/api/creditos/pagos/${t.abono1}/anular`;
  assert.equal((await llamar(ruta, { metodo: 'POST', token: t.caja, cuerpo: { motivo: 'Abono equivocado' } })).estado, 403);
  const a = await llamar(ruta, { metodo: 'POST', token: t.gerente2, cuerpo: { motivo: 'Abono equivocado' } });
  assert.equal(a.estado, 200);
  assert.equal(a.cuerpo.saldoCredito, '6000.00');
  assert.deepEqual(await tabla(), t.tablaOriginal);
  assert.deepEqual(await libro(), { cartera: '6000.00', descuadre: '0.00' });
  assert.equal(await porSubcuenta(), 0);
});

test('abono REDUCIR_PLAZO por caja: misma cuota, se extinguen las ultimas y el vencimiento se adelanta', async () => {
  const antes = await tabla();
  const r = await llamar('/api/creditos/CRED-000001/abonos', { metodo: 'POST', token: t.caja,
    cuerpo: { monto: '2000', modalidad: 'REDUCIR_PLAZO', origen: 'CAJA' } });
  assert.equal(r.estado, 201);
  assert.ok(r.cuerpo.comprobante > 0);
  const despues = await tabla();
  const extinguidas = despues.filter(q => q.estado === 'EXTINGUIDA');
  assert.ok(extinguidas.length >= 3);
  assert.ok(extinguidas.every(q => Number(q.capital) === 0 && q.numero > despues.length - extinguidas.length));
  const vivas = despues.filter(q => q.estado === 'PENDIENTE');
  assert.equal(suma(vivas, 'capital'), 4000);
  assert.ok(vivas.slice(1, -1).every(q => q.total === antes[1].total));
  assert.equal(r.cuerpo.vence, vivas.at(-1).fecha);
  assert.equal(r.cuerpo.cuotasRestantes, vivas.length);
  assert.deepEqual(await libro(), { cartera: '4000.00', descuadre: '0.00' });
  assert.equal(await porSubcuenta(), 0);
});

test('pagar despues del abono cierra el credito al pagar la ultima cuota viva', async () => {
  const vivas = (await tabla()).filter(q => q.estado === 'PENDIENTE');
  const r = await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: vivas.length } });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.saldoCredito, r.cuerpo.estadoCredito], ['0.00', 'CANCELADO']);
  assert.deepEqual(await libro(), { cartera: '0.00', descuadre: '0.00' });
  // Anulo para seguir probando sobre un credito vigente.
  assert.equal((await llamar(`/api/creditos/pagos/${r.cuerpo.pago}/anular`, { metodo: 'POST', token: t.gerente2,
    cuerpo: { motivo: 'Prueba de cierre' } })).estado, 200);
});

test('con una cuota vencida no se abona: primero se paga lo vencido', async () => {
  await withTenant(coopA.cooperativa_id, async tx => {
    await tx.query(`UPDATE tecnifin.tabla_amortizacion SET fecha_pago = fecha_pago - 45`);
  });
  const r = await llamar('/api/creditos/CRED-000001/abonos', { metodo: 'POST', token: t.caja,
    cuerpo: { monto: '100', origen: 'CUENTA', numeroCuenta: t.ahorro } });
  assert.equal(r.estado, 409);
  assert.match(r.cuerpo.error, /vencidas/);
});

test('otra cooperativa no ve el credito', async () => {
  const tB = await entrar('COOP-B', 'caja');
  const r = await llamar('/api/creditos/CRED-000001/abonos/simulacion', { metodo: 'POST', token: tB, cuerpo: { monto: '10' } });
  assert.equal(r.estado, 404);
});
