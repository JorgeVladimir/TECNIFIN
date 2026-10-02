// M3: rubros por cuota como datos (fijo, % del monto, % del saldo). Se generan al desembolsar,
// se cobran con la cuota a su cuenta, quedan sin efecto en las futuras de una cancelacion y se anulan exactos.
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

const nombreBase = `tecnifin_rubros_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-rubros-por-cuota-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-rubros-pruebas',
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
    await tx.query(
      `INSERT INTO tecnifin.rubros_cuota_config (codigo, nombre, base, valor, cuenta_contable)
       VALUES ('SEGURO', 'Seguro de desgravamen', 'PORCENTAJE_SALDO', 0.08, '259090'),
              ('SOLCA', 'Contribucion SOLCA', 'PORCENTAJE_MONTO', 0.05, '250490'),
              ('GASTOS', 'Gastos de cobranza', 'FIJO', 1.50, '569010')`);
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


const rubrosDb = async () => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT estado, count(*)::int AS n FROM tecnifin.rubros_creditos GROUP BY estado ORDER BY estado`))).rows;
const lineas = async (pago) => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT pc.codigo, d.tipo_asiento AS tipo, d.valor::text AS valor FROM tecnifin.pagos_credito p
     JOIN tecnifin.detalle_asiento d ON d.asiento_id = p.asiento_id
     JOIN tecnifin.plan_cuentas pc ON pc.cuenta_contable_id = d.cuenta_contable_id
    WHERE p.numero_pago = @n ORDER BY pc.codigo`, { n: pago }))).rows;
const cuadre = async () => (await withTenant(coopA.cooperativa_id, tx => tx.query(
  `SELECT (sum(valor) FILTER (WHERE tipo_asiento = 'D') - sum(valor) FILTER (WHERE tipo_asiento = 'H'))::text AS d
     FROM tecnifin.detalle_asiento`))).rows[0].d;

test('el desembolso genera los rubros de cada cuota: fijo, % del monto y % del saldo', async () => {
  const tabla1 = await tabla();
  // Cuota 1: seguro 6000 x 0,08 % = 4,80; SOLCA 6000 x 0,05 % = 3,00; gastos 1,50.
  assert.deepEqual([tabla1[0].rubros, tabla1[0].total], ['9.30', '550.85']);
  // El seguro baja con el saldo: la ultima cuota paga menos rubros que la primera.
  assert.ok(Number(tabla1.at(-1).rubros) < 9.30 && Number(tabla1.at(-1).rubros) >= 4.50);
  assert.ok(tabla1.every(q => (Number(q.capital) + Number(q.interes) + Number(q.rubros)).toFixed(2) === q.total));
  assert.deepEqual(await rubrosDb(), [{ estado: 'PENDIENTE', n: 36 }]);
});

test('pagar la cuota cobra sus rubros, cada uno a su cuenta, y la anulacion los devuelve', async () => {
  const r = await llamar('/api/creditos/CRED-000001/pagos', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro, cuotas: 1 } });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.rubros, r.cuerpo.total], ['9.30', '550.85']);
  const l = await lineas(r.cuerpo.pago);
  for (const [codigo, valor] of [['259090', '4.80'], ['250490', '3.00'], ['569010', '1.50']]) {
    assert.deepEqual(l.find(x => x.codigo === codigo), { codigo, tipo: 'H', valor });
  }
  assert.equal(await cuadre(), '0.00');
  assert.deepEqual(await rubrosDb(), [{ estado: 'PAGADO', n: 3 }, { estado: 'PENDIENTE', n: 33 }]);
  const a = await llamar(`/api/creditos/pagos/${r.cuerpo.pago}/anular`, { metodo: 'POST', token: t.gerente2,
    cuerpo: { motivo: 'Prueba de rubros' } });
  assert.equal(a.estado, 200);
  assert.deepEqual(await rubrosDb(), [{ estado: 'PENDIENTE', n: 36 }]);
  assert.equal(await cuadre(), '0.00');
});

test('cancelacion anticipada: la cuota en curso paga sus rubros, las futuras quedan sin efecto', async () => {
  const l = await llamar('/api/creditos/CRED-000001/cancelacion', { token: t.caja });
  assert.equal(l.estado, 200);
  assert.equal(l.cuerpo.rubros, '9.30');
  const r = await llamar('/api/creditos/CRED-000001/cancelacion', { metodo: 'POST', token: t.caja,
    cuerpo: { origen: 'CUENTA', numeroCuenta: t.ahorro } });
  assert.equal(r.estado, 201);
  assert.deepEqual([r.cuerpo.rubros, r.cuerpo.total, r.cuerpo.estadoCredito], ['9.30', l.cuerpo.total, 'CANCELADO']);
  assert.deepEqual(await rubrosDb(), [{ estado: 'ANULADO', n: 33 }, { estado: 'PAGADO', n: 3 }]);
  assert.equal((await llamar(`/api/creditos/pagos/${r.cuerpo.pago}/anular`, { metodo: 'POST', token: t.gerente2,
    cuerpo: { motivo: 'Prueba de rubros' } })).estado, 200);
  assert.deepEqual(await rubrosDb(), [{ estado: 'PENDIENTE', n: 36 }]);
});

test('abono a capital: el seguro sobre saldo se recalcula y la anulacion lo devuelve exacto', async () => {
  const antes = await tabla();
  const r = await llamar('/api/creditos/CRED-000001/abonos', { metodo: 'POST', token: t.caja,
    cuerpo: { monto: '1000', origen: 'CUENTA', numeroCuenta: t.ahorro } });
  assert.equal(r.estado, 201);
  const despues = await tabla();
  assert.deepEqual(despues[0], antes[0]);
  assert.ok(despues.slice(1).every((q, i) => Number(q.rubros) < Number(antes[i + 1].rubros)), 'el seguro baja con el saldo');
  assert.ok(despues.every(q => (Number(q.capital) + Number(q.interes) + Number(q.rubros)).toFixed(2) === q.total));
  const plazo = await llamar('/api/creditos/CRED-000001/abonos', { metodo: 'POST', token: t.caja,
    cuerpo: { monto: '1000', modalidad: 'REDUCIR_PLAZO', origen: 'CUENTA', numeroCuenta: t.ahorro } });
  assert.equal(plazo.estado, 201);
  const extinguidas = (await tabla()).filter(q => q.estado === 'EXTINGUIDA');
  assert.ok(extinguidas.length > 0 && extinguidas.every(q => q.rubros === '0.00' && q.total === '0.00'));
  for (const p of [plazo.cuerpo.pago, r.cuerpo.pago]) {
    assert.equal((await llamar(`/api/creditos/pagos/${p}/anular`, { metodo: 'POST', token: t.gerente2,
      cuerpo: { motivo: 'Prueba de rubros' } })).estado, 200);
  }
  assert.deepEqual(await tabla(), antes);
  assert.deepEqual(await rubrosDb(), [{ estado: 'PENDIENTE', n: 36 }]);
});
