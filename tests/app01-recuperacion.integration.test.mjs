// APP-01: recuperacion de clave por correo y diagnostico de correo. El transporte es falso
// (captura los mensajes): ninguna prueba envia correo real.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { crearAplicacion } from '../src/app.js';
import { crearCorreo } from '../src/platform/correo.js';
import { hashearClave } from '../src/platform/credenciales.js';
import { crearJwt } from '../src/platform/jwt.js';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { crearServicioPlataforma } from '../src/modules/plataforma/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_rec_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-recuperacion-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-recuperacion-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};
const SMTP_FALSO = { TECNIFIN_SMTP_HOST: 'smtp.prueba.local', TECNIFIN_SMTP_USER: 'envios@prueba.local',
  TECNIFIN_SMTP_PASS: 'clave-smtp-que-nunca-debe-salir', TECNIFIN_SMTP_FROM: 'envios@prueba.local' };

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB, tokenAdminA;
const enviados = [];
const alertas = [];
let transporteFalla = false;

async function preparar(cooperativa, usuarios) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol, clave, correo] of usuarios) {
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol, correo)
         VALUES (@login, @nombre, @hash, @rol, @correo)`,
        { login, nombre: `Usuario ${login}`, hash: await hashearClave(login, clave), rol, correo });
    }
    await tx.query(`INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
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
const entrar = (cooperativa, usuario, clave) =>
  llamar('/api/auth/login', { metodo: 'POST', cuerpo: { cooperativa, usuario, clave } });
const olvide = (cooperativa, usuario) =>
  llamar('/api/auth/olvide-clave', { metodo: 'POST', cuerpo: { cooperativa, usuario } });
const codigoDe = mensaje => /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(mensaje.text)[1];

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
  await preparar(coopA, [['admin', 'ADMIN', 'clave-admin-alfa', 'admin@alfa.test'],
    ['cajera', 'TELLER', 'clave-cajera-alfa', 'cajera@alfa.test'], ['sincorreo', 'TELLER', 'clave-sin-correo', null]]);
  await preparar(coopB, [['cajera', 'TELLER', 'clave-cajera-beta', 'cajera@beta.test']]);

  const transporte = { sendMail: async mensaje => {
    if (transporteFalla) throw Object.assign(new Error('535 auth failed clave-smtp-que-nunca-debe-salir'), { code: 'EAUTH' });
    enviados.push(mensaje);
  } };
  const correo = crearCorreo(SMTP_FALSO, { transporte });
  const servicio = crearServicioPlataforma({ db: app, jwt: crearJwt(entornoJwt), correo,
    alertar: evento => alertas.push(evento) });
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

test('la respuesta es identica exista o no la cooperativa, el usuario o su correo', async () => {
  const casos = [['COOP-A', 'nadie'], ['COOP-Z', 'cajera'], ['COOP-A', 'sincorreo'], ['COOP-A', '!!'], ['COOP-A', 'cajera']];
  const respuestas = [];
  for (const [coop, usuario] of casos) respuestas.push(await olvide(coop, usuario));
  for (const r of respuestas) {
    assert.equal(r.estado, 202);
    assert.deepEqual(r.cuerpo, respuestas[0].cuerpo);
  }
  assert.equal(enviados.length, 1, 'solo el usuario real con correo recibe mensaje');
  assert.equal(enviados[0].to, 'cajera@alfa.test');
  assert.match(enviados[0].text, /COOP-A/);
});

test('el codigo funciona una sola vez y la base guarda solo su hash', async () => {
  const codigo = codigoDe(enviados.at(-1));
  const guardado = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT token_hash FROM tecnifin.recuperaciones_clave r JOIN tecnifin.usuarios u USING (cooperativa_id, usuario_id)
      WHERE u.login = 'cajera' ORDER BY recuperacion_id DESC LIMIT 1`));
  assert.notEqual(guardado.rows[0].token_hash, codigo);
  assert.match(guardado.rows[0].token_hash, /^[0-9a-f]{64}$/);

  const debil = await llamar('/api/auth/restablecer-con-codigo', { metodo: 'POST',
    cuerpo: { cooperativa: 'COOP-A', codigo, claveNueva: 'corta' } });
  assert.equal(debil.estado, 400);

  const ok = await llamar('/api/auth/restablecer-con-codigo', { metodo: 'POST',
    cuerpo: { cooperativa: 'COOP-A', codigo, claveNueva: 'nueva-segura-2026' } });
  assert.equal(ok.estado, 200);
  assert.equal((await entrar('COOP-A', 'cajera', 'clave-cajera-alfa')).estado, 401);
  assert.equal((await entrar('COOP-A', 'cajera', 'nueva-segura-2026')).estado, 200);

  const repetido = await llamar('/api/auth/restablecer-con-codigo', { metodo: 'POST',
    cuerpo: { cooperativa: 'COOP-A', codigo, claveNueva: 'otra-segura-2027' } });
  assert.equal(repetido.estado, 400);
});

test('el codigo de A no sirve en B y un codigo nuevo anula el anterior', async () => {
  await olvide('COOP-A', 'cajera');
  const primero = codigoDe(enviados.at(-1));
  await olvide('COOP-A', 'cajera');
  const segundo = codigoDe(enviados.at(-1));
  assert.notEqual(primero, segundo);

  const enB = await llamar('/api/auth/restablecer-con-codigo', { metodo: 'POST',
    cuerpo: { cooperativa: 'COOP-B', codigo: segundo, claveNueva: 'intento-en-beta-1' } });
  assert.equal(enB.estado, 400);
  assert.equal((await entrar('COOP-B', 'cajera', 'clave-cajera-beta')).estado, 200, 'B no cambia');

  const anulado = await llamar('/api/auth/restablecer-con-codigo', { metodo: 'POST',
    cuerpo: { cooperativa: 'COOP-A', codigo: primero, claveNueva: 'intento-con-viejo' } });
  assert.equal(anulado.estado, 400);
});

test('mas de tres solicitudes por hora no envian correo y quedan auditadas', async () => {
  const antes = enviados.length;
  for (let i = 0; i < 3; i++) await olvide('COOP-A', 'cajera');
  // Ya hubo 3 solicitudes en la prueba anterior y 1 en la primera: todas estas se limitan.
  assert.equal(enviados.length, antes);
  const eventos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT count(*)::int AS n FROM tecnifin.auditoria_usuarios WHERE concepto = 'RECUPERACION_LIMITADA'`));
  assert.ok(eventos.rows[0].n >= 3);
});

test('si el envio falla la respuesta no cambia, hay alerta y no se filtra la clave SMTP', async () => {
  transporteFalla = true;
  try {
    const r = await olvide('COOP-A', 'admin');
    assert.equal(r.estado, 202);
    assert.equal(alertas.at(-1).tipo, 'RECUPERACION_SIN_CORREO');
    assert.doesNotMatch(JSON.stringify(alertas), /clave-smtp-que-nunca-debe-salir/);
  } finally { transporteFalla = false; }
});

test('diagnostico de correo: solo administracion, sin la clave, y prueba auditada', async () => {
  const estado = await llamar('/api/admin/correo', { token: tokenAdminA });
  assert.equal(estado.estado, 200);
  assert.equal(estado.cuerpo.configurado, true);
  assert.doesNotMatch(JSON.stringify(estado.cuerpo), /clave-smtp/);

  const tokenCajera = (await entrar('COOP-A', 'cajera', 'nueva-segura-2026')).cuerpo.token;
  assert.equal((await llamar('/api/admin/correo', { token: tokenCajera })).estado, 403);

  const prueba = await llamar('/api/admin/correo/prueba', { metodo: 'POST', token: tokenAdminA,
    cuerpo: { destino: 'Soporte@Alfa.test' } });
  assert.equal(prueba.estado, 200);
  assert.equal(enviados.at(-1).to, 'soporte@alfa.test');

  transporteFalla = true;
  try {
    const fallo = await llamar('/api/admin/correo/prueba', { metodo: 'POST', token: tokenAdminA,
      cuerpo: { destino: 'soporte@alfa.test' } });
    assert.equal(fallo.estado, 502);
    assert.doesNotMatch(JSON.stringify(fallo.cuerpo), /clave-smtp/);
  } finally { transporteFalla = false; }

  const eventos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT concepto, detalle FROM tecnifin.auditoria_usuarios WHERE concepto LIKE 'PRUEBA_CORREO%'`));
  assert.deepEqual(eventos.rows.map(f => f.concepto).sort(), ['PRUEBA_CORREO', 'PRUEBA_CORREO_FALLIDA']);
  assert.doesNotMatch(JSON.stringify(eventos.rows), /clave-smtp/);
});

test('el correo del usuario se valida y se guarda en minusculas', async () => {
  const alta = await llamar('/api/usuarios', { metodo: 'POST', token: tokenAdminA,
    cuerpo: { login: 'nuevo1', nombre: 'Nuevo Uno', rol: 'TELLER', correo: 'Nuevo.Uno@Alfa.TEST' } });
  assert.equal(alta.estado, 201);
  assert.equal(alta.cuerpo.correo, 'nuevo.uno@alfa.test');
  assert.equal((await llamar('/api/usuarios/nuevo1', { metodo: 'PUT', token: tokenAdminA,
    cuerpo: { correo: 'no-es-correo' } })).estado, 400);
  const borrado = await llamar('/api/usuarios/nuevo1', { metodo: 'PUT', token: tokenAdminA, cuerpo: { correo: null } });
  assert.equal(borrado.cuerpo.correo, null);
});
