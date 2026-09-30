// M6: castigo de cartera contra la provision constituida, con control en cuentas de orden.
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

const nombreBase = `tecnifin_cast_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-castigo-cartera-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-castigo-pruebas',
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
const castigar = (token, motivo = 'Credito incobrable, gestion de cobro agotada') =>
  llamar('/api/cartera/castigos/CRED-000001', { metodo: 'POST', token, cuerpo: { motivo } });
const saldos = () => withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT pc.codigo, sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END)::text AS saldo
     FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
    GROUP BY pc.codigo`)).then(r => Object.fromEntries(r.rows.map(f => [f.codigo, f.saldo])));

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
  [t.caja, t.oficial, t.gerente] = await Promise.all([entrar('COOP-A', 'caja'), entrar('COOP-A', 'oficial'), entrar('COOP-A', 'gerente')]);

  await llamar('/api/socios', { metodo: 'POST', token: t.caja, cuerpo: {
    tipoIdentificacion: 'CEDULA', identificacion: cedulaDesdeBase('170000011'), primerNombre: 'Mario', primerApellido: 'Quishpe' } });
  const cert = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 1 } })).cuerpo.numeroCuenta;
  const ahorro = (await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: t.caja, cuerpo: { codigoProducto: 2 } })).cuerpo.numeroCuenta;
  await llamar('/api/caja/apertura', { metodo: 'POST', token: t.caja, cuerpo: { saldoApertura: '0' } });
  await llamar('/api/caja/transacciones', { metodo: 'POST', token: t.caja, cuerpo: { numeroCuenta: cert, tipo: 'DEPOSITO', monto: '10' } });
  await llamar('/api/creditos/solicitudes', { metodo: 'POST', token: t.oficial,
    cuerpo: { numeroSocio: 1, lineaCredito: 'CONSUMO ORDINARIO', monto: '3000', plazo: 6 } });
  await llamar('/api/creditos/solicitudes/SOL-000001/decision', { metodo: 'POST', token: t.gerente, cuerpo: { decision: 'APROBAR' } });
  await llamar('/api/creditos/solicitudes/SOL-000001/desembolso', { metodo: 'POST', token: t.gerente, cuerpo: { numeroCuenta: ahorro } });
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

test('no se castiga un credito al dia, ni sin rol, ni sin motivo', async () => {
  assert.equal((await castigar(t.gerente)).estado, 409);
  assert.equal((await castigar(t.oficial)).estado, 403);
  assert.equal((await castigar(t.gerente, 'corto')).estado, 400);
});

test('vencido pero sin provision suficiente: primero el proceso de cartera', async () => {
  await withTenant(coopA.cooperativa_id, async tx => {
    await tx.query(`UPDATE tecnifin.creditos SET fecha_desembolso = fecha_desembolso - 400`);
    await tx.query(`UPDATE tecnifin.tabla_amortizacion SET fecha_pago = fecha_pago - 400`);
  });
  const r = await castigar(t.gerente);
  assert.equal(r.estado, 409);
  assert.match(r.cuerpo.error, /provision/);
});

test('con provision al 100 %: baja contra 1499, capital fuera de la cartera y control en cuentas de orden', async () => {
  const proceso = await llamar('/api/cartera/procesos', { metodo: 'POST', token: t.gerente, cuerpo: { aplicar: true } });
  assert.equal(proceso.estado, 201);
  assert.equal(proceso.cuerpo.operaciones[0].calificacion, 'E');
  const r = await castigar(t.gerente);
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.estado, r.cuerpo.saldoCastigado], ['CASTIGADO', '3000.00']);
  const s = await saldos();
  const cartera = Object.entries(s).filter(([k]) => k >= '1401' && k < '1429').reduce((x, [, v]) => x + Number(v), 0);
  assert.equal(cartera.toFixed(2), '0.00', 'el credito sale de la cartera');
  assert.equal(s['149910'], '0.00', 'la provision se usa entera');
  assert.equal(s['710310'], '3000.00');
  assert.equal(s['720310'], '-3000.00');
  const clasificacion = await llamar('/api/cartera/clasificacion', { token: t.gerente });
  assert.equal(clasificacion.cuerpo.totales.carteraBruta, '0.00', 'un castigado ya no es cartera');
  assert.equal((await castigar(t.gerente)).estado, 409, 'no se castiga dos veces');
});
