// M4 · depositos a plazo fijo, patron 07: apertura con debito real, liquidacion,
// cancelacion anticipada con penalizacion y renovacion, todo con asiento cuadrado.
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
import { crearServicioPlazoFijo } from '../src/modules/plazo_fijo/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_m4_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m4-plazo-fijo-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m4-pruebas',
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
    await tx.query(
      `INSERT INTO tecnifin.tasas_plazo_fijo (codigo_rango, descripcion_rango, dias_desde, dias_hasta, tasa_nominal_anual,
                                             tasa_maxima_bce, cuenta_contable_dpf, porcentaje_penalizacion)
       VALUES ('R30', 'De 1 a 30 dias', 1, 30, 4.5, 6, '210305', 50),
              ('R90', 'De 31 a 90 dias', 31, 90, 5.5, 7, '210310', 50),
              ('R180', 'De 91 a 180 dias', 91, 180, 6.5, 8, '210315', 50)`);
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
const abrir = (cuerpo) => llamar('/api/dpf', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: t.ahorro, ...cuerpo } });
const saldo = async () => (await llamar(`/api/cuentas/${t.ahorro}`, { token: t.caja })).cuerpo.saldo;
// Mueve un deposito en el tiempo: se abrio hace `dias` dias (el vencimiento se corre igual).
const envejecer = (codigo, dias) => withTenant(coopA.cooperativa_id, tx => tx.query(
  `UPDATE tecnifin.depositos_plazo
      SET fecha_apertura = (now() AT TIME ZONE 'America/Guayaquil')::date - @d::int,
          fecha_vencimiento = (now() AT TIME ZONE 'America/Guayaquil')::date - @d::int + plazo_dias
    WHERE codigo = @c`, { c: codigo, d: dias }));
const libroDe = (codigo, tipo) => withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT pc.codigo, d.tipo_asiento, d.valor::text AS valor
     FROM tecnifin.asientos_contables a
     JOIN tecnifin.detalle_asiento d ON d.asiento_id = a.asiento_id
     JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
    WHERE a.origen_modulo = 'PLAZO_FIJO' AND a.origen_id = @c AND a.tipo_documento = @t
    ORDER BY d.tipo_asiento, pc.codigo`, { c: codigo, t: tipo })).then(r => r.rows.map(f => [f.codigo, f.tipo_asiento, f.valor]));

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
    plazoFijo: crearServicioPlazoFijo({ db: app, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [t.caja, t.gerente, t.cajaB] = await Promise.all([entrar('COOP-A', 'caja'), entrar('COOP-A', 'gerente'), entrar('COOP-B', 'caja')]);

  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Luz', primerApellido: 'Caiza' } });
  t.ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja,
    cuerpo: { numeroCuenta: t.ahorro, tipo: 'DEPOSITO', monto: '2500' } });
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

test('tramos y simulacion: interes en numeric con base 365 y retencion del 2 %', async () => {
  const tramos = await llamar('/api/dpf/tramos', { token: t.caja });
  assert.deepEqual(tramos.cuerpo.map(x => x.codigo), ['R30', 'R90', 'R180']);
  const sim = await llamar('/api/dpf/simulacion', { metodo: 'POST', token: t.caja, cuerpo: { monto: '1000', plazoDias: 90 } });
  // 1000 * 5.5 % * 90 / 365 = 13.5616 -> 13.56; retencion 0.2712 -> 0.27; neto 13.29.
  assert.deepEqual([sim.cuerpo.tramo, sim.cuerpo.interes, sim.cuerpo.retencion, sim.cuerpo.interesNeto], ['R90', '13.56', '0.27', '13.29']);
  assert.equal((await llamar('/api/dpf/simulacion', { metodo: 'POST', token: t.caja, cuerpo: { monto: '100', plazoDias: 90 } })).estado, 400,
    'por debajo del minimo del tramo');
  assert.equal((await llamar('/api/dpf/simulacion', { metodo: 'POST', token: t.caja, cuerpo: { monto: '1000', plazoDias: 400 } })).estado, 400,
    'sin tramo');
});

test('apertura: debita de verdad la cuenta del socio y pasa el dinero al pasivo del tramo', async () => {
  assert.equal((await abrir({ monto: '9000', plazoDias: 90 })).estado, 409, 'saldo insuficiente');
  const r = await abrir({ monto: '1000', plazoDias: 90 });
  assert.equal(r.estado, 201);
  assert.match(r.cuerpo.codigo, /^DPF-[0-9]{6}-0001$/);
  assert.deepEqual([r.cuerpo.capital, r.cuerpo.tramo, r.cuerpo.interesNetoProyectado, r.cuerpo.saldoCuenta],
    ['1000.00', 'R90', '13.29', '1500.00']);
  t.dpf1 = r.cuerpo.codigo;
  assert.deepEqual(await libroDe(t.dpf1, 'APERTURA_DPF'), [['210135', 'D', '1000.00'], ['210310', 'H', '1000.00']]);
});

test('liquidacion: solo al vencer; acredita capital + interes neto y registra gasto y retencion', async () => {
  assert.equal((await llamar(`/api/dpf/${t.dpf1}/liquidar`, { metodo: 'POST', token: t.caja, cuerpo: {} })).estado, 409);
  await envejecer(t.dpf1, 90);
  const r = await llamar(`/api/dpf/${t.dpf1}/liquidar`, { metodo: 'POST', token: t.caja, cuerpo: {} });
  assert.equal(r.estado, 200);
  assert.deepEqual([r.cuerpo.estado, r.cuerpo.interes, r.cuerpo.retencion, r.cuerpo.totalAcreditado, r.cuerpo.saldoCuenta],
    ['LIQUIDADO', '13.56', '0.27', '1013.29', '2513.29']);
  assert.deepEqual(await libroDe(t.dpf1, 'LIQUIDAR_DPF'), [
    ['210310', 'D', '1000.00'], ['410130', 'D', '13.56'], ['210135', 'H', '1013.29'], ['250405', 'H', '0.27']]);
  assert.equal((await llamar(`/api/dpf/${t.dpf1}/liquidar`, { metodo: 'POST', token: t.caja, cuerpo: {} })).estado, 409);
});

test('cancelacion anticipada: solo supervisor, con motivo, la penalizacion reduce el interes', async () => {
  const r = await abrir({ monto: '1000', plazoDias: 90 });
  t.dpf2 = r.cuerpo.codigo;
  await envejecer(t.dpf2, 45);
  assert.equal((await llamar(`/api/dpf/${t.dpf2}/cancelar`, { metodo: 'POST', token: t.caja,
    cuerpo: { motivo: 'Emergencia medica' } })).estado, 403);
  assert.equal((await llamar(`/api/dpf/${t.dpf2}/cancelar`, { metodo: 'POST', token: t.gerente, cuerpo: {} })).estado, 400);
  const c = await llamar(`/api/dpf/${t.dpf2}/cancelar`, { metodo: 'POST', token: t.gerente,
    cuerpo: { motivo: 'Emergencia medica del socio' } });
  assert.equal(c.estado, 200);
  // 45 dias: 1000 * 5.5 % * 45/365 = 6.78 bruto; con 50 % de penalizacion 3.39; retencion 0.07.
  assert.deepEqual([c.cuerpo.estado, c.cuerpo.diasReconocidos, c.cuerpo.interes, c.cuerpo.penalizacion, c.cuerpo.retencion,
    c.cuerpo.totalAcreditado], ['CANCELADO', 45, '3.39', '3.39', '0.07', '1003.32']);
  const libro = await libroDe(t.dpf2, 'CANCELAR_DPF');
  const suma = lado => libro.filter(f => f[1] === lado).reduce((s, f) => s + Math.round(Number(f[2]) * 100), 0);
  assert.equal(suma('D'), suma('H'), 'la penalizacion no descuadra el asiento');
});

test('renovacion: liquida el vencido y abre otro por el mismo capital, enlazado', async () => {
  const r = await abrir({ monto: '500', plazoDias: 30, tipoRenovacion: 'MANUAL' });
  const codigo = r.cuerpo.codigo;
  assert.equal((await llamar(`/api/dpf/${codigo}/renovar`, { metodo: 'POST', token: t.caja, cuerpo: {} })).estado, 409, 'no vencido');
  await envejecer(codigo, 30);
  const antes = await saldo();
  const ren = await llamar(`/api/dpf/${codigo}/renovar`, { metodo: 'POST', token: t.caja, cuerpo: { plazoDias: 60 } });
  assert.equal(ren.estado, 201);
  assert.equal(ren.cuerpo.anterior.estado, 'RENOVADO');
  assert.deepEqual([ren.cuerpo.nuevo.capital, ren.cuerpo.nuevo.tramo, ren.cuerpo.nuevo.plazoDias], ['500.00', 'R90', 60]);
  // El socio recibe solo el interes neto: el capital vuelve a quedar invertido.
  assert.equal((Number(await saldo()) - Number(antes)).toFixed(2), ren.cuerpo.anterior.interesNeto);
  const nuevo = await llamar(`/api/dpf/${ren.cuerpo.nuevo.codigo}`, { token: t.caja });
  assert.equal(nuevo.cuerpo.numeroRenovacion, 1);
});

test('libro mayor: todo cuadra y el pasivo 2103 es el capital de los depositos vigentes', async () => {
  const r = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT (SELECT (sum(valor) FILTER (WHERE tipo_asiento = 'D') - sum(valor) FILTER (WHERE tipo_asiento = 'H'))::text
               FROM tecnifin.detalle_asiento) AS descuadre,
            (SELECT sum(CASE WHEN d.tipo_asiento = 'H' THEN d.valor ELSE -d.valor END)::text
               FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
              WHERE pc.codigo LIKE '2103%') AS pasivo,
            (SELECT sum(monto_capital)::text FROM tecnifin.depositos_plazo WHERE estado = 'ACTIVO') AS vigentes`));
  assert.deepEqual(r.rows[0], { descuadre: '0.00', pasivo: '500.00', vigentes: '500.00' });
});

test('la cooperativa B no ve depositos de A', async () => {
  assert.equal((await llamar(`/api/dpf/${t.dpf1}`, { token: t.cajaB })).estado, 404);
});
