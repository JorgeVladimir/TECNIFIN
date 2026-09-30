// M6 · proceso de cartera SEPS, patron 08: clasificacion, simulacion, aplicacion con
// reclasificacion exacta por cuota y provisiones, reversion y el control contable previo.
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

const nombreBase = `tecnifin_m6_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m6-cartera-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m6-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB;
const t = {};

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
const procesar = (token, cuerpo) => llamar('/api/cartera/procesos', { metodo: 'POST', token, cuerpo });
const saldosCartera = () => withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT substr(pc.codigo, 1, 4) AS familia, sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END)::text AS saldo
     FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
    WHERE pc.codigo >= '1401' AND pc.codigo < '1429' OR pc.codigo LIKE '1499%'
    GROUP BY 1 HAVING sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END) <> 0 ORDER BY 1`))
  .then(r => Object.fromEntries(r.rows.map(f => [f.familia, f.saldo])));
const cuentasDeCuotas = () => withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT numero_cuota, cuenta_capital, estado, fecha_pago < (now() AT TIME ZONE 'America/Guayaquil')::date AS vencida
     FROM tecnifin.tabla_amortizacion ORDER BY numero_cuota`)).then(r => r.rows);

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
  [t.caja, t.oficial, t.gerente, t.gerente2, t.gerenteB] = await Promise.all([
    entrar('COOP-A', 'caja'), entrar('COOP-A', 'oficial'), entrar('COOP-A', 'gerente'), entrar('COOP-A', 'gerente2'),
    entrar('COOP-B', 'gerente')]);

  // Un credito de consumo real por el camino completo: socio, certificado, solicitud, aprobacion, desembolso.
  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Olga', primerApellido: 'Tituana' } });
  const cert = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 1 } })).cuerpo.numeroCuenta;
  t.ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: cert, tipo: 'DEPOSITO', monto: '10' } });
  await llamar('/api/creditos/solicitudes', { metodo: 'POST', token: t.oficial,
    cuerpo: { numeroSocio: 1, lineaCredito: 'CONSUMO ORDINARIO', monto: '6000', plazo: 12 } });
  await llamar('/api/creditos/solicitudes/SOL-000001/decision', { metodo: 'POST', token: t.gerente, cuerpo: { decision: 'APROBAR' } });
  const d = await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente,
    cuerpo: { numeroCuenta: t.ahorro } });
  assert.equal(d.estado, 201);
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

test('un credito al dia: todo por vencer, morosidad 0 y provision A1 del 1 %', async () => {
  const c = await llamar('/api/cartera/clasificacion', { token: t.oficial });
  assert.equal(c.estado, 200);
  assert.deepEqual([c.cuerpo.totales.carteraBruta, c.cuerpo.totales.porVencer, c.cuerpo.totales.morosidad], ['6000.00', '6000.00', '0.00']);
  assert.equal(c.cuerpo.cuotasMovidas, 0, 'recien desembolsado ya esta en su banda');
  assert.deepEqual(c.cuerpo.operaciones.map(o => [o.calificacion, o.provision]), [['A1', '60.00']]);
  assert.equal(c.cuerpo.aplicable, true);
  assert.equal((await llamar('/api/cartera/clasificacion', { token: t.caja })).estado, 403);
});

test('con mora: la simulacion clasifica vencida y no devenga sin tocar nada', async () => {
  // Cien dias atras: las cuotas que ya vencieron quedan en mora y el resto deja de devengar.
  await withTenant(coopA.cooperativa_id, async tx => {
    await tx.query(`UPDATE tecnifin.creditos SET fecha_desembolso = fecha_desembolso - 100`);
    await tx.query(`UPDATE tecnifin.tabla_amortizacion SET fecha_pago = fecha_pago - 100`);
  });
  const antes = await cuentasDeCuotas();
  const s = await procesar(t.oficial, {});
  assert.equal(s.estado, 200);
  assert.equal(s.cuerpo.estado, 'SIMULADO');
  assert.equal(s.cuerpo.cuotasMovidas, 12);
  assert.equal(s.cuerpo.totales.morosidad, '100.00', 'toda la operacion es improductiva');
  assert.equal(s.cuerpo.totales.carteraBruta, '6000.00');
  assert.ok(s.cuerpo.reclasificaciones.every(r => r.origen.startsWith('1402') && /^14(12|22)/.test(r.destino)));
  assert.notEqual(s.cuerpo.operaciones[0].calificacion, 'A1');
  assert.deepEqual(await cuentasDeCuotas(), antes, 'simular no cambia las cuotas');
});

test('aplicar: solo supervisor; mueve cada cuota a su familia y constituye la provision', async () => {
  assert.equal((await procesar(t.oficial, { aplicar: true })).estado, 403);
  const a = await procesar(t.gerente, { aplicar: true });
  assert.equal(a.estado, 201);
  assert.equal(a.cuerpo.estado, 'APLICADO');
  t.proceso1 = a.cuerpo.proceso;
  for (const q of await cuentasDeCuotas()) {
    assert.ok(q.cuenta_capital.startsWith(q.vencida ? '1422' : '1412'), `cuota ${q.numero_cuota} en ${q.cuenta_capital}`);
    assert.equal(q.estado, q.vencida ? 'VENCIDA' : 'PENDIENTE');
  }
  const provision = a.cuerpo.provisiones[0];
  assert.equal(provision.cuenta, '149910');
  const libro = await saldosCartera();
  assert.equal(libro['1402'], undefined, 'nada queda por vencer');
  assert.equal((Number(libro['1412']) + Number(libro['1422'])).toFixed(2), '6000.00');
  assert.equal(libro['1499'], `-${provision.ajuste}`, 'provision constituida (saldo acreedor)');
  assert.equal((await procesar(t.gerente, { aplicar: true })).estado, 409, 'ya hay un proceso aplicado para el corte');
});

test('reversar devuelve cada cuota a su cuenta y deja el libro como antes', async () => {
  assert.equal((await llamar(`/api/cartera/procesos/${t.proceso1}/reversar`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'no' } })).estado, 400);
  const r = await llamar(`/api/cartera/procesos/${t.proceso1}/reversar`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'Parametros de provision mal cargados' } });
  assert.equal(r.estado, 200);
  assert.ok((await cuentasDeCuotas()).every(q => q.cuenta_capital.startsWith('1402') && q.estado === 'PENDIENTE'));
  assert.deepEqual(await saldosCartera(), { 1402: '6000.00' });
});

test('despues de un pago la reversion se niega, y el control contable sigue cuadrando', async () => {
  const a = await procesar(t.gerente2, { aplicar: true });
  assert.equal(a.estado, 201);
  const pago = await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 } });
  assert.equal(pago.estado, 201);
  const sim = await procesar(t.oficial, {});
  assert.equal(sim.cuerpo.aplicable, true, 'el pago descargo el capital de la cuenta donde estaba');
  const r = await llamar(`/api/cartera/procesos/${a.cuerpo.proceso}/reversar`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'Intento de reverso tras un pago' } });
  assert.equal(r.estado, 409);
});

test('un descuadre contable bloquea la aplicacion', async () => {
  // Un asiento manual que mueve cartera sin pasar por la tabla de amortizacion.
  await withTenant(coopA.cooperativa_id, async tx => {
    const u = (await tx.query(`SELECT usuario_id FROM tecnifin.usuarios WHERE login = 'gerente'`)).rows[0].usuario_id;
    const p = (await tx.query(`SELECT periodo_id FROM tecnifin.periodos_contables LIMIT 1`)).rows[0].periodo_id;
    const a = (await tx.query(`INSERT INTO tecnifin.asientos_contables (periodo_contable_id, concepto, usuario_id, origen_modulo)
       VALUES (@p, 'Ajuste manual indebido', @u, 'MANUAL') RETURNING asiento_id`, { p, u })).rows[0].asiento_id;
    await tx.query(`INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
       SELECT @a, cuenta_contable_id, CASE codigo WHEN '140205' THEN 'D' ELSE 'H' END, 10.00
         FROM tecnifin.plan_cuentas WHERE codigo IN ('140205', '110105')`, { a });
  });
  const sim = await procesar(t.oficial, {});
  assert.equal(sim.cuerpo.aplicable, false);
  assert.match(sim.cuerpo.bloqueos[0], /140205/);
});

test('la cooperativa B no ve la cartera de A', async () => {
  const c = await llamar('/api/cartera/clasificacion', { token: t.gerenteB });
  assert.deepEqual([c.cuerpo.totales.operaciones, c.cuerpo.totales.carteraBruta], [0, '0.00']);
});
