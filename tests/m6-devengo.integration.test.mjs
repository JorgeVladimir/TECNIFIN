// M6: devengo de intereses de cartera. Proporcional a los dias del periodo; a 1603 si el credito
// devenga y a suspenso en orden si no; el cobro descarga lo devengado y todo se reversa exacto.
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

const nombreBase = `tecnifin_devengo_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-devengo-intereses-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-devengo-pruebas',
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
  // 10 dias atras: la primera cuota lleva 10 dias corridos de su periodo.
  await withTenant(coopA.cooperativa_id, async tx => {
    await tx.query(`UPDATE tecnifin.creditos SET fecha_desembolso = fecha_desembolso - 10`);
    await tx.query(`UPDATE tecnifin.tabla_amortizacion SET fecha_pago = fecha_pago - 10`);
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


const saldo = async (codigo) => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT coalesce(sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END), 0)::text AS s
     FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
    WHERE pc.codigo = @c`, { c: codigo }))).rows[0].s;
const acumulado = async () => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT numero_cuota AS n, interes_devengado::text AS d, interes_suspenso::text AS s FROM tecnifin.tabla_amortizacion
    WHERE interes_devengado + interes_suspenso > 0 ORDER BY numero_cuota`))).rows;
const dias = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

test('simulacion: interes de la cuota en curso proporcional a los dias corridos, sin escribir', async () => {
  const credito = (await llamar('/api/creditos/CRED-000001', { token: t.oficial })).cuerpo;
  const q1 = credito.tabla[0];
  t.esperado = (Math.round(Number(q1.interes) * 100 * 10 / dias(credito.fechaDesembolso, q1.fecha)) / 100).toFixed(2);
  t.interes1 = q1.interes;
  const r = await llamar('/api/cartera/devengo', { token: t.oficial });
  assert.equal(r.estado, 200);
  assert.deepEqual([r.cuerpo.cuotas, r.cuerpo.devengado, r.cuerpo.suspenso, r.cuerpo.control], [1, t.esperado, '0.00', []]);
  assert.deepEqual(await acumulado(), []);
});

test('aplicar: solo supervisor; Debe 160310 / Haber 510410 y la cuota guarda lo devengado', async () => {
  assert.equal((await llamar('/api/cartera/devengo', { metodo: 'POST', token: t.oficial, cuerpo: {} })).estado, 403);
  const r = await llamar('/api/cartera/devengo', { metodo: 'POST', token: t.gerente, cuerpo: {} });
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.devengado, t.esperado);
  assert.equal(await saldo('160310'), t.esperado);
  assert.equal(await saldo('510410'), `-${t.esperado}`);
  assert.deepEqual(await acumulado(), [{ n: 1, d: t.esperado, s: '0.00' }]);
  t.devengo1 = r.cuerpo.proceso;
  // Repetirlo al mismo corte no duplica: no hay nada nuevo que devengar.
  const otra = await llamar('/api/cartera/devengo', { metodo: 'POST', token: t.gerente, cuerpo: {} });
  assert.deepEqual([otra.estado, otra.cuerpo.cuotas, otra.cuerpo.asiento], [201, 0, null]);
  t.devengo2 = otra.cuerpo.proceso;
  const atras = await llamar('/api/cartera/devengo', { metodo: 'POST', token: t.gerente, cuerpo: { fechaCorte: '2020-01-01' } });
  assert.equal(atras.estado, 409);
});

test('el cobro de la cuota descarga 1603 y solo el resto va a ingreso; la anulacion lo devuelve', async () => {
  const r = await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 } });
  assert.equal(r.estado, 201);
  assert.equal(await saldo('160310'), '0.00');
  assert.equal(await saldo('510410'), `-${t.interes1}`);
  const a = await llamar(`/api/creditos/pagos/${r.cuerpo.pago}/anular`, { metodo: 'POST', token: t.gerente2,
    cuerpo: { motivo: 'Prueba de devengo' } });
  assert.equal(a.estado, 200);
  assert.equal(await saldo('160310'), t.esperado);
  assert.equal((await llamar('/api/cartera/devengo', { token: t.oficial })).cuerpo.control.length, 0);
});

test('reversar: en orden inverso y exacto', async () => {
  const motivo = { motivo: 'Corrida de prueba' };
  assert.equal((await llamar(`/api/cartera/devengo/${t.devengo1}/reversar`, { metodo: 'POST', token: t.gerente, cuerpo: motivo })).estado, 409);
  assert.equal((await llamar(`/api/cartera/devengo/${t.devengo2}/reversar`, { metodo: 'POST', token: t.gerente, cuerpo: motivo })).estado, 200);
  const r = await llamar(`/api/cartera/devengo/${t.devengo1}/reversar`, { metodo: 'POST', token: t.gerente, cuerpo: motivo });
  assert.equal(r.estado, 200);
  assert.equal(await saldo('160310'), '0.00');
  assert.equal(await saldo('510410'), '0.00');
  assert.deepEqual(await acumulado(), []);
});

test('credito con cuota vencida: no devenga, todo va a suspenso en orden y el cobro lo baja', async () => {
  await withTenant(coopA.cooperativa_id, tx => tx.query(`UPDATE tecnifin.tabla_amortizacion SET fecha_pago = fecha_pago - 35`));
  const r = await llamar('/api/cartera/devengo', { metodo: 'POST', token: t.gerente, cuerpo: {} });
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.devengado, '0.00');
  assert.ok(Number(r.cuerpo.suspenso) > Number(t.interes1), 'la vencida completa mas lo corrido de la segunda');
  assert.equal(await saldo('710910'), r.cuerpo.suspenso);
  assert.equal(await saldo('720910'), `-${r.cuerpo.suspenso}`);
  assert.equal(await saldo('160310'), '0.00');
  const p = await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 } });
  assert.equal(p.estado, 201);
  const resto = (await acumulado()).find(q => q.n === 2).s;
  assert.equal(await saldo('710910'), resto);
  assert.equal((await llamar('/api/cartera/devengo', { token: t.oficial })).cuerpo.control.length, 0);
});

test('otra cooperativa no tiene nada que devengar', async () => {
  const tB = await entrar('COOP-B', 'gerente');
  const r = await llamar('/api/cartera/devengo', { token: tB });
  assert.deepEqual([r.estado, r.cuerpo.cuotas, r.cuerpo.devengado], [200, 0, '0.00']);
});

test('cierre mensual: devengo y proceso de cartera en una sola transaccion, y nada si algo falla', async () => {
  const procesos = async () => (await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT (SELECT count(*) FROM tecnifin.devengo_intereses)::int AS devengos,
            (SELECT count(*) FROM tecnifin.reclasificacion_cartera WHERE estado = 'APLICADO')::int AS carteras`))).rows[0];
  assert.equal((await llamar('/api/cartera/cierre-mensual', { metodo: 'POST', token: t.oficial, cuerpo: {} })).estado, 403);
  const antes = await procesos();
  const r = await llamar('/api/cartera/cierre-mensual', { metodo: 'POST', token: t.gerente, cuerpo: {} });
  assert.equal(r.estado, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devengo.estado, 'APLICADO');
  assert.equal(r.cuerpo.cartera.estado, 'APLICADO');
  assert.equal(r.cuerpo.cartera.totales.operaciones, 1, 'el credito se califico al corte');
  assert.deepEqual(await procesos(), { devengos: antes.devengos + 1, carteras: antes.carteras + 1 });
  // Repetirlo al mismo corte choca con la cartera ya aplicada: el devengo tampoco queda.
  const otra = await llamar('/api/cartera/cierre-mensual', { metodo: 'POST', token: t.gerente, cuerpo: {} });
  assert.equal(otra.estado, 409);
  assert.deepEqual(await procesos(), { devengos: antes.devengos + 1, carteras: antes.carteras + 1 });
  const { auditarBase } = await import('../tools/auditoria.mjs');
  assert.deepEqual((await auditarBase(admin)).hallazgos, []);
});
