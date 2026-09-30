// APP-01, resto de endpoints de plataforma con el patron 03: salud, perfil, cambio de clave
// y administracion de usuarios (alta, rol/activo, restablecer clave), cada uno con su
// auditoria y sin salir del tenant del token.
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

const nombreBase = `tecnifin_usr_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-usuarios-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-usuarios-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB, tokenAdminA, claveCajero;

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

  const servicio = crearServicioPlataforma({ db: app, jwt: crearJwt(entornoJwt) });
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

test('salud responde sin autenticacion y sin revelar datos', async () => {
  const r = await llamar('/api/health');
  assert.equal(r.estado, 200);
  assert.deepEqual(r.cuerpo, { estado: 'ok', base: 'ok' });
});

test('alta de usuario: clave temporal una vez, rol validado, duplicado 409, SUPER_USER solo por SUPER_USER', async () => {
  const alta = await llamar('/api/usuarios', { metodo: 'POST', token: tokenAdminA,
    cuerpo: { login: 'Cajero1', nombre: 'Cajero Uno', rol: 'TELLER' } });
  assert.equal(alta.estado, 201);
  assert.equal(alta.cuerpo.login, 'cajero1');
  assert.equal(alta.cuerpo.requiereCambioPin, true);
  assert.ok(alta.cuerpo.claveTemporal.length >= 16);
  claveCajero = alta.cuerpo.claveTemporal;

  const repetida = await llamar('/api/usuarios', { metodo: 'POST', token: tokenAdminA,
    cuerpo: { login: 'cajero1', nombre: 'Otro', rol: 'TELLER' } });
  assert.equal(repetida.estado, 409);

  const rolMalo = await llamar('/api/usuarios', { metodo: 'POST', token: tokenAdminA,
    cuerpo: { login: 'x-malo', nombre: 'Rol malo', rol: 'DUENO' } });
  assert.equal(rolMalo.estado, 400);

  const elevacion = await llamar('/api/usuarios', { metodo: 'POST', token: tokenAdminA,
    cuerpo: { login: 'otro.root', nombre: 'Intento', rol: 'SUPER_USER' } });
  assert.equal(elevacion.estado, 403);
});

test('clave temporal: solo perfil y cambio de clave hasta cambiarla', async () => {
  const ingreso = await entrar('COOP-A', 'cajero1', claveCajero);
  assert.equal(ingreso.estado, 200);
  assert.equal(ingreso.cuerpo.usuario.requiereCambioPin, true);
  const token = ingreso.cuerpo.token;

  assert.equal((await llamar('/api/configuracion', { token })).estado, 403);
  const perfil = await llamar('/api/perfil', { token });
  assert.equal(perfil.estado, 200);
  assert.equal(perfil.cuerpo.login, 'cajero1');
  assert.equal(perfil.cuerpo.rol, 'TELLER');
  assert.equal(perfil.cuerpo.password_hash, undefined);

  const mala = await llamar('/api/auth/cambiar-clave', { metodo: 'POST', token,
    cuerpo: { claveActual: 'no-es-esta', claveNueva: 'una-clave-larga-1' } });
  assert.equal(mala.estado, 400);
  const debil = await llamar('/api/auth/cambiar-clave', { metodo: 'POST', token,
    cuerpo: { claveActual: claveCajero, claveNueva: 'corta' } });
  assert.equal(debil.estado, 400);
  const conLogin = await llamar('/api/auth/cambiar-clave', { metodo: 'POST', token,
    cuerpo: { claveActual: claveCajero, claveNueva: 'mi-cajero1-2026' } });
  assert.equal(conLogin.estado, 400);

  const buena = await llamar('/api/auth/cambiar-clave', { metodo: 'POST', token,
    cuerpo: { claveActual: claveCajero, claveNueva: 'caja-segura-2026' } });
  assert.equal(buena.estado, 200);
  assert.equal((await llamar('/api/configuracion', { token })).estado, 200);
  assert.equal((await entrar('COOP-A', 'cajero1', claveCajero)).estado, 401);
  assert.equal((await entrar('COOP-A', 'cajero1', 'caja-segura-2026')).estado, 200);
});

test('solo ADMIN/SUPER_USER administran usuarios', async () => {
  const token = (await entrar('COOP-A', 'oficial', 'clave-oficial-alfa')).cuerpo.token;
  assert.equal((await llamar('/api/usuarios', { token })).estado, 403);
  assert.equal((await llamar('/api/usuarios', { metodo: 'POST', token,
    cuerpo: { login: 'nuevo', nombre: 'Nuevo', rol: 'TELLER' } })).estado, 403);
  assert.equal((await llamar('/api/usuarios/cajero1', { metodo: 'PUT', token,
    cuerpo: { activo: false } })).estado, 403);
});

test('desactivar corta el token vigente; nadie se administra a si mismo; ADMIN no toca SUPER_USER', async () => {
  const tokenCajero = (await entrar('COOP-A', 'cajero1', 'caja-segura-2026')).cuerpo.token;
  const baja = await llamar('/api/usuarios/cajero1', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { activo: false } });
  assert.equal(baja.estado, 200);
  assert.deepEqual(baja.cuerpo, { login: 'cajero1', rol: 'TELLER', activo: false });
  assert.equal((await llamar('/api/perfil', { token: tokenCajero })).estado, 401);

  assert.equal((await llamar('/api/usuarios/admin', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { activo: false } })).estado, 400);
  assert.equal((await llamar('/api/usuarios/root', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { activo: false } })).estado, 403);
  assert.equal((await llamar('/api/usuarios/oficial', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { rol: 'SUPER_USER' } })).estado, 403);
  assert.equal((await llamar('/api/usuarios/oficial', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { activo: 'no' } })).estado, 400);
});

test('un login que solo existe en B no se ve ni se toca desde A', async () => {
  assert.equal((await llamar('/api/usuarios/solo.beta', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { activo: false } })).estado, 404);
  assert.equal((await llamar('/api/usuarios/solo.beta/restablecer-clave', { metodo: 'POST',
    token: tokenAdminA })).estado, 404);
  assert.equal((await entrar('COOP-B', 'solo.beta', 'clave-solo-beta')).estado, 200);
});

test('restablecer clave emite temporal nueva e invalida la anterior', async () => {
  await llamar('/api/usuarios/cajero1', { metodo: 'PUT', token: tokenAdminA, cuerpo: { activo: true } });
  const r = await llamar('/api/usuarios/cajero1/restablecer-clave', { metodo: 'POST', token: tokenAdminA });
  assert.equal(r.estado, 200);
  assert.equal(r.cuerpo.requiereCambioPin, true);
  assert.equal((await entrar('COOP-A', 'cajero1', 'caja-segura-2026')).estado, 401);
  assert.equal((await entrar('COOP-A', 'cajero1', r.cuerpo.claveTemporal)).estado, 200);
  assert.equal((await llamar('/api/usuarios/root/restablecer-clave', { metodo: 'POST',
    token: tokenAdminA })).estado, 403);
});

test('SUPER_USER si administra a otro SUPER_USER candidato', async () => {
  const tokenRoot = (await entrar('COOP-A', 'root', 'clave-root-alfa')).cuerpo.token;
  const r = await llamar('/api/usuarios', { metodo: 'POST', token: tokenRoot,
    cuerpo: { login: 'root2', nombre: 'Segundo root', rol: 'SUPER_USER' } });
  assert.equal(r.estado, 201);
});

test('auditoria de A registra cada accion y B no recibe nada de A', async () => {
  const a = await conceptos(coopA);
  for (const esperado of ['ALTA_USUARIO', 'ALTA_USUARIO_DENEGADO', 'CAMBIO_CLAVE_FALLIDO', 'CAMBIO_CLAVE',
    'USUARIOS_DENEGADO', 'ALTA_USUARIO_DENEGADO', 'CAMBIO_USUARIO', 'CAMBIO_USUARIO_DENEGADO',
    'RESTABLECER_CLAVE', 'RESTABLECER_CLAVE_DENEGADO']) {
    assert.ok(a.includes(esperado), `falta ${esperado}`);
  }
  const b = await conceptos(coopB);
  assert.ok(b.every(c => c.startsWith('LOGIN_')), `B tiene eventos ajenos: ${b.join(',')}`);
});
