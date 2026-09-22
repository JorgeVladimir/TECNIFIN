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

const nombreBase = `tecnifin_app01_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-app01-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-app01-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB, tokenA;
const alertas = [];

async function preparar(cooperativa, etiqueta, clave) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    const usuario = (await tx.query(
      `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
       VALUES ('admin', @nombre, @hash, 'ADMIN')
       RETURNING usuario_id, login`, {
        nombre: `Administrador ${etiqueta}`, hash: await hashearClave('admin', clave),
      })).rows[0];
    await tx.query(
      `INSERT INTO tecnifin.parametros_cooperativa (clave, valor, descripcion) VALUES
       ('auth.jwt_vida_segundos', '900', 'Vigencia configurada para la prueba'),
       ('auth.refresh_habilitado', 'false', 'Pendiente de decision'),
       ('auth.invalidacion_modo', 'pendiente', 'Pendiente de decision'),
       ('interfaz.saludo', @saludo, 'Valor distinto por tenant')`, { saludo: `Hola ${etiqueta}` });
    return usuario;
  });
}

async function llamar(ruta, opciones = {}) {
  const respuesta = await fetch(baseUrl + ruta, opciones);
  return { estado: respuesta.status, cuerpo: await respuesta.json() };
}

const login = (cooperativa, clave) => llamar('/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cooperativa, usuario: 'admin', clave }),
});

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
  await Promise.all([preparar(coopA, 'ALFA', 'clave-alfa'), preparar(coopB, 'BETA', 'clave-beta')]);

  const servicio = crearServicioPlataforma({ db: app, jwt: crearJwt(entornoJwt),
    alertar: evento => alertas.push(evento) });
  servidor = createServer(crearAplicacion(servicio));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
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

test('login correcto emite JWT y login incorrecto responde 401 sin filtrar el motivo', async () => {
  const incorrecto = await login('COOP-A', 'equivocada');
  assert.equal(incorrecto.estado, 401);
  assert.deepEqual(incorrecto.cuerpo, { error: 'Credenciales invalidas' });

  const correcto = await login('COOP-A', 'clave-alfa');
  assert.equal(correcto.estado, 200);
  assert.equal(correcto.cuerpo.usuario.rol, 'ADMIN');
  assert.equal(typeof correcto.cuerpo.token, 'string');
  tokenA = correcto.cuerpo.token;
});

test('token de A ignora selectores de B y solo lista usuarios de A', async () => {
  const respuesta = await llamar(`/api/usuarios?cooperativa_id=${coopB.cooperativa_id}`, {
    headers: { authorization: `Bearer ${tokenA}`, 'x-cooperativa': String(coopB.cooperativa_id) },
  });
  assert.equal(respuesta.estado, 200);
  assert.deepEqual(respuesta.cuerpo, [{ login: 'admin', nombre: 'Administrador ALFA',
    rol: 'ADMIN', activo: true, requiereCambioPin: false }]);
});

test('configuracion devuelta pertenece al tenant del token', async () => {
  const respuesta = await llamar('/api/configuracion', {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(respuesta.estado, 200);
  assert.equal(respuesta.cuerpo.cooperativa.codigo, 'COOP-A');
  assert.equal(respuesta.cuerpo.parametros['interfaz.saludo'].valor, 'Hola ALFA');
  assert.doesNotMatch(JSON.stringify(respuesta.cuerpo), /BETA|COOP-B/);
});

test('auditoria registra login fallido, acceso y acciones sensibles', async () => {
  const eventos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT concepto FROM tecnifin.auditoria_usuarios ORDER BY auditoria_id`));
  assert.deepEqual(eventos.rows.map(f => f.concepto), [
    'LOGIN_FALLIDO', 'LOGIN_EXITOSO', 'CONSULTA_USUARIOS', 'LECTURA_CONFIGURACION',
  ]);
});

test('JWT con coop manipulado es rechazado y genera alerta sin incluir el token', async () => {
  const partes = tokenA.split('.');
  const cuerpo = JSON.parse(Buffer.from(partes[1], 'base64url'));
  cuerpo.coop = coopB.cooperativa_id;
  partes[1] = Buffer.from(JSON.stringify(cuerpo)).toString('base64url');
  const respuesta = await llamar('/api/configuracion', {
    headers: { authorization: `Bearer ${partes.join('.')}` },
  });
  assert.equal(respuesta.estado, 401);
  assert.equal(alertas.at(-1).tipo, 'TOKEN_RECHAZADO');
  assert.doesNotMatch(JSON.stringify(alertas.at(-1)), new RegExp(tokenA.replaceAll('.', '\\.')));
});

