// Endurecimiento del login: bloqueo de cuenta por intentos fallidos (0031), respuesta que no
// delata si la cuenta existe o esta bloqueada, desbloqueo por restablecimiento, alerta al
// bloquear y cabeceras de seguridad en toda respuesta.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { crearAplicacion } from '../src/app.js';
import { hashearClave } from '../src/platform/credenciales.js';
import { crearJwt } from '../src/platform/jwt.js';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { crearServicioPlataforma } from '../src/modules/plataforma/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_seg_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-seguridad-login-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-seguridad-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB, tokenAdminA, claveCajero;
const alertas = [];

async function preparar(cooperativa, usuarios) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol, clave] of usuarios) {
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
         VALUES (@login, @nombre, @hash, @rol)`,
        { login, nombre: `Usuario ${login}`, hash: await hashearClave(login, clave), rol });
    }
    await tx.query(
      `INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
  });
}

async function llamar(ruta, { metodo = 'GET', token, cuerpo } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  const respuesta = await fetch(baseUrl + ruta, {
    method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { estado: respuesta.status, cuerpo: await respuesta.json() };
}

const entrar = (cooperativa, usuario, clave) =>
  llamar('/api/auth/login', { metodo: 'POST', cuerpo: { cooperativa, usuario, clave } });

const conceptos = cooperativa => withTenant(cooperativa.cooperativa_id, async tx =>
  (await tx.query(`SELECT concepto FROM tecnifin.auditoria_usuarios ORDER BY auditoria_id`)).rows
    .map(f => f.concepto));

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
  await preparar(coopA, [['admin', 'ADMIN', 'clave-admin-alfa'], ['root', 'SUPER_USER', 'clave-root-alfa'],
    ['oficial', 'CREDIT_OFFICER', 'clave-oficial-alfa']]);
  await preparar(coopB, [['admin', 'ADMIN', 'clave-admin-beta'], ['solo.beta', 'TELLER', 'clave-solo-beta']]);

  await withTenant(coopA.cooperativa_id, tx => tx.query(
    `INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.max_intentos', '3'), ('auth.bloqueo_minutos', '10')`));
  const servicio = crearServicioPlataforma({ db: app, jwt: crearJwt(entornoJwt), alertar: async a => { alertas.push(a); } });
  servidor = createServer(crearAplicacion(servicio));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  tokenAdminA = (await entrar('COOP-A', 'admin', 'clave-admin-alfa')).cuerpo.token;
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

const estadoCuenta = (login) => withTenant(coopA.cooperativa_id, async tx => (await tx.query(
  `SELECT intentos_fallidos AS intentos, bloqueado_hasta IS NOT NULL AS bloqueado FROM tecnifin.usuarios WHERE login = @l`,
  { l: login })).rows[0]);

test('cada clave equivocada suma un intento y un login correcto los limpia', async () => {
  for (let i = 0; i < 2; i++) assert.equal((await entrar('COOP-A', 'oficial', 'equivocada')).estado, 401);
  assert.deepEqual(await estadoCuenta('oficial'), { intentos: 2, bloqueado: false });
  assert.equal((await entrar('COOP-A', 'oficial', 'clave-oficial-alfa')).estado, 200);
  assert.deepEqual(await estadoCuenta('oficial'), { intentos: 0, bloqueado: false });
});

test('al llegar al maximo la cuenta se bloquea: ni la clave correcta entra y la respuesta es la misma', async () => {
  const fallida = await entrar('COOP-A', 'oficial', 'equivocada');
  for (let i = 0; i < 2; i++) await entrar('COOP-A', 'oficial', 'equivocada');
  assert.deepEqual(await estadoCuenta('oficial'), { intentos: 0, bloqueado: true });
  const correcta = await entrar('COOP-A', 'oficial', 'clave-oficial-alfa');
  assert.equal(correcta.estado, 401);
  assert.deepEqual(correcta.cuerpo.error, fallida.cuerpo.error, 'no delata el bloqueo');
  const inexistente = await entrar('COOP-A', 'no.existe', 'equivocada');
  assert.deepEqual([inexistente.estado, inexistente.cuerpo.error], [401, fallida.cuerpo.error]);
  assert.ok(alertas.some(a => a.tipo === 'USUARIO_BLOQUEADO' && a.usuario === 'oficial'));
  const c = await conceptos(coopA);
  assert.ok(c.includes('USUARIO_BLOQUEADO') && c.includes('LOGIN_BLOQUEADO'));
});

test('el bloqueo es por cooperativa: el mismo login en B no se ve afectado', async () => {
  for (let i = 0; i < 6; i++) await entrar('COOP-B', 'solo.beta', 'equivocada');
  // B no configuro la politica: rige el defecto de 5 intentos.
  assert.equal((await entrar('COOP-B', 'admin', 'clave-admin-beta')).estado, 200);
  assert.equal((await entrar('COOP-A', 'admin', 'clave-admin-alfa')).estado, 200);
});

test('restablecer la clave desbloquea la cuenta', async () => {
  const r = await llamar('/api/usuarios/oficial/restablecer-clave', { metodo: 'POST', token: tokenAdminA });
  assert.equal(r.estado, 200);
  assert.deepEqual(await estadoCuenta('oficial'), { intentos: 0, bloqueado: false });
  assert.equal((await entrar('COOP-A', 'oficial', r.cuerpo.claveTemporal)).estado, 200);
});

test('el bloqueo vence solo al cumplirse el plazo', async () => {
  for (let i = 0; i < 3; i++) await entrar('COOP-A', 'admin', 'equivocada');
  assert.equal((await entrar('COOP-A', 'admin', 'clave-admin-alfa')).estado, 401);
  await withTenant(coopA.cooperativa_id, tx => tx.query(
    `UPDATE tecnifin.usuarios SET bloqueado_hasta = now() - interval '1 second' WHERE login = 'admin'`));
  assert.equal((await entrar('COOP-A', 'admin', 'clave-admin-alfa')).estado, 200);
});

test('toda respuesta lleva las cabeceras de seguridad', async () => {
  for (const ruta of ['/api/health', '/api/auth/login', '/api/no-existe']) {
    const r = await fetch(baseUrl + ruta, { method: ruta.includes('login') ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' }, body: ruta.includes('login') ? '{}' : undefined });
    await r.text();
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', ruta);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', ruta);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/, ruta);
    assert.equal(r.headers.get('cache-control'), 'no-store', ruta);
  }
});
