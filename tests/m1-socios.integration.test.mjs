// M1 · socios y cuentas, patron 04: alta con validacion de identificacion ecuatoriana,
// busqueda, ficha con cuentas y apertura de cuenta; todo dentro del tenant del token.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { crearAplicacion } from '../src/app.js';
import { hashearClave } from '../src/platform/credenciales.js';
import { crearJwt } from '../src/platform/jwt.js';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { cedulaDesdeBase, esRucValido, identificacionValida } from '../src/platform/identificacion.js';
import { crearServicioPlataforma } from '../src/modules/plataforma/servicio.js';
import { crearServicioSocios } from '../src/modules/socios/servicio.js';
import { entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_m1_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-m1-socios-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-m1-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};
const CEDULA_1 = cedulaDesdeBase('170000011');
const CEDULA_2 = cedulaDesdeBase('090000013');

let app, admin, withTenant, servidor, baseUrl, creada = false;
let coopA, coopB, tokenCajaA, tokenCajaB, tokenSocioA;

async function preparar(cooperativa) {
  return withTenant(cooperativa.cooperativa_id, async tx => {
    for (const [login, rol] of [['caja', 'TELLER'], ['socio.web', 'MEMBER']]) {
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
         VALUES (@login, @nombre, @hash, @rol)`,
        { login, nombre: `Usuario ${login}`, hash: await hashearClave(login, `clave-${login}-2026`), rol });
    }
    await tx.query(`INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
    await tx.query(
      `INSERT INTO tecnifin.productos_financieros (codigo_producto, nombre, tipo_deposito, es_certificado, cuenta_activa, cuenta_inactiva)
       VALUES (1, 'CERTIFICADO DE APORTACION', 'CERTIFICADO', true, '3103', '3103'),
              (2, 'AHORRO A LA VISTA', 'AHORRO A LA VISTA', false, '210135', '210135')`);
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

const socioValido = (extra = {}) => ({
  tipoIdentificacion: 'CEDULA', identificacion: CEDULA_1, primerNombre: 'María', segundoNombre: 'Fernanda',
  primerApellido: 'Chimbo', segundoApellido: 'Tibán', email: 'Maria.Chimbo@correo.test', telefono: '099 123 4567',
  fechaNacimiento: '1990-05-14', estadoCivil: 'casado',
  direccion: { provinciaResidencia: 'Tungurahua', cantonResidencia: 'Ambato', domicilio: 'Av. Cevallos y Montalvo' },
  conyuge: { nombre: 'Luis Pérez', telefono: '0987654321' },
  referencias: [{ nombre: 'Ana Tibán', telefono: '032456789', relacion: 'Hermana' }],
  cargas: [{ nombre: 'Mateo Pérez', parentesco: 'Hijo', edad: 7 }],
  consentimientoDatos: true, ...extra,
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
  await Promise.all([preparar(coopA), preparar(coopB)]);

  const jwt = crearJwt(entornoJwt);
  const aplicacion = crearAplicacion(crearServicioPlataforma({ db: app, jwt }),
    { socios: crearServicioSocios({ db: app, jwt }) });
  servidor = createServer(aplicacion);
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  [tokenCajaA, tokenCajaB, tokenSocioA] = await Promise.all([
    entrar('COOP-A', 'caja'), entrar('COOP-B', 'caja'), entrar('COOP-A', 'socio.web')]);
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

test('identificacion: cedula por modulo 10, RUC natural y de sociedad, pasaporte', () => {
  assert.equal(identificacionValida('CEDULA', CEDULA_1), CEDULA_1);
  assert.equal(identificacionValida('CEDULA', '1700000110'), null, 'verificador equivocado');
  assert.ok(esRucValido(`${CEDULA_1}001`));
  assert.equal(esRucValido(`${CEDULA_1}000`), false, 'establecimiento 000 no existe');
  assert.equal(esRucValido('1790012345001'), true, 'sociedad privada: estructura');
  assert.equal(esRucValido('1770012345001'), false, 'tercer digito 7 no existe');
  assert.equal(identificacionValida('PASAPORTE', ' ab12345 '), 'AB12345');
  assert.equal(identificacionValida('DNI', '123'), null);
});

test('alta de socio: numero desde 1, datos completos y auditoria del proceso', async () => {
  const r = await llamar('/api/socios', { metodo: 'POST', token: tokenCajaA, cuerpo: socioValido() });
  assert.equal(r.estado, 201);
  assert.deepEqual(r.cuerpo, { numeroSocio: 1, identificacion: CEDULA_1,
    nombre: 'María Fernanda Chimbo Tibán', estado: 'ACTIVO' });

  const guardado = await withTenant(coopA.cooperativa_id, async tx => ({
    socio: (await tx.query(`SELECT email, telefono, estado_civil, usuario_registro_id FROM tecnifin.socios`)).rows[0],
    hijos: (await tx.query(`SELECT (SELECT count(*) FROM tecnifin.socio_direccion)::int AS dir,
      (SELECT count(*) FROM tecnifin.socio_conyuge)::int AS con, (SELECT count(*) FROM tecnifin.socio_referencia)::int AS ref,
      (SELECT count(*) FROM tecnifin.socio_carga)::int AS car`)).rows[0],
    auditoria: (await tx.query(`SELECT proceso, accion, entidad_id, usuario_login FROM tecnifin.auditoria_procesos`)).rows,
  }));
  assert.equal(guardado.socio.email, 'maria.chimbo@correo.test');
  assert.equal(guardado.socio.telefono, '0991234567');
  assert.equal(guardado.socio.estado_civil, 'CASADO');
  assert.ok(guardado.socio.usuario_registro_id);
  assert.deepEqual(guardado.hijos, { dir: 1, con: 1, ref: 1, car: 1 });
  assert.deepEqual(guardado.auditoria, [{ proceso: 'SOCIOS', accion: 'CREAR', entidad_id: '1', usuario_login: 'caja' }]);
});

test('alta: identificacion repetida 409, cedula invalida 400, fecha futura 400', async () => {
  assert.equal((await llamar('/api/socios', { metodo: 'POST', token: tokenCajaA, cuerpo: socioValido() })).estado, 409);
  assert.equal((await llamar('/api/socios', { metodo: 'POST', token: tokenCajaA,
    cuerpo: socioValido({ identificacion: '1700000110' }) })).estado, 400);
  assert.equal((await llamar('/api/socios', { metodo: 'POST', token: tokenCajaA,
    cuerpo: socioValido({ identificacion: CEDULA_2, fechaNacimiento: '2999-01-01' }) })).estado, 400);
  assert.equal((await llamar('/api/socios', { metodo: 'POST', token: tokenCajaA,
    cuerpo: socioValido({ identificacion: CEDULA_2, email: 'no-es-correo' }) })).estado, 400);
});

test('la misma cedula es otro socio en B, con su propio numero 1', async () => {
  const r = await llamar('/api/socios', { metodo: 'POST', token: tokenCajaB, cuerpo: socioValido() });
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.numeroSocio, 1);
});

test('busqueda por numero, identificacion y apellido sin acentos; nunca ve B', async () => {
  await llamar('/api/socios', { metodo: 'POST', token: tokenCajaA,
    cuerpo: socioValido({ identificacion: CEDULA_2, primerNombre: 'José', segundoNombre: null,
      primerApellido: 'Guamán', segundoApellido: null, estadoCivil: 'soltero', conyuge: null }) });
  const porNumero = await llamar('/api/socios?q=2', { token: tokenCajaA });
  assert.deepEqual(porNumero.cuerpo.map(s => s.numeroSocio), [2]);
  const porCedula = await llamar(`/api/socios?q=${CEDULA_1.slice(0, 6)}`, { token: tokenCajaA });
  assert.deepEqual(porCedula.cuerpo.map(s => s.identificacion), [CEDULA_1]);
  const sinAcento = await llamar('/api/socios?q=guaman', { token: tokenCajaA });
  assert.deepEqual(sinAcento.cuerpo.map(s => s.nombre), ['José Guamán']);
  assert.equal((await llamar('/api/socios?q=ab', { token: tokenCajaA })).estado, 400);
  const comodin = await llamar('/api/socios?q=%25%25%25', { token: tokenCajaA });
  assert.deepEqual(comodin.cuerpo, [], 'los comodines de LIKE se escapan');
  const enB = await llamar('/api/socios?q=guaman', { token: tokenCajaB });
  assert.deepEqual(enB.cuerpo, []);
});

test('apertura de cuentas: certificado unico, ahorros multiples, numeracion desde 1', async () => {
  const cert = await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: tokenCajaA, cuerpo: { codigoProducto: 1 } });
  assert.equal(cert.estado, 201);
  assert.equal(cert.cuerpo.numeroCuenta, 1);
  assert.equal(cert.cuerpo.saldo, '0.00');
  assert.equal((await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: tokenCajaA,
    cuerpo: { codigoProducto: 1 } })).estado, 409);
  const ahorro = await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: tokenCajaA, cuerpo: { codigoProducto: 2 } });
  assert.equal(ahorro.cuerpo.numeroCuenta, 2);
  assert.equal((await llamar('/api/socios/1/cuentas', { metodo: 'POST', token: tokenCajaA,
    cuerpo: { codigoProducto: 99 } })).estado, 400);
  assert.equal((await llamar('/api/socios/77/cuentas', { metodo: 'POST', token: tokenCajaA,
    cuerpo: { codigoProducto: 2 } })).estado, 404);
});

test('ficha del socio con cuentas y saldos en texto; B no ve la ficha de A', async () => {
  const ficha = await llamar('/api/socios/1', { token: tokenCajaA });
  assert.equal(ficha.estado, 200);
  assert.equal(ficha.cuerpo.fechaNacimiento, '1990-05-14');
  assert.equal(ficha.cuerpo.direccion.canton_residencia, 'Ambato');
  assert.deepEqual(ficha.cuerpo.cuentas.map(c => [c.numeroCuenta, c.certificado, c.saldo]),
    [[1, true, '0.00'], [2, false, '0.00']]);
  assert.equal(ficha.cuerpo.socio_id, undefined);
  const enB = await llamar('/api/socios/2', { token: tokenCajaB });
  assert.equal(enB.estado, 404, 'B solo tiene su socio 1');
});

test('el rol MEMBER no atiende socios y la denegacion queda auditada', async () => {
  assert.equal((await llamar('/api/socios?q=1', { token: tokenSocioA })).estado, 403);
  assert.equal((await llamar('/api/socios', { metodo: 'POST', token: tokenSocioA, cuerpo: socioValido() })).estado, 403);
  const eventos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT concepto FROM tecnifin.auditoria_usuarios WHERE usuario_login = 'socio.web' AND concepto LIKE '%DENEGADO'`));
  assert.deepEqual(eventos.rows.map(f => f.concepto).sort(), ['ALTA_SOCIO_DENEGADO', 'CONSULTA_SOCIOS_DENEGADO']);
});

test('la base ya no tiene columnas de PIN en claro (PA6)', async () => {
  const columnas = await admin.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'tecnifin' AND column_name = 'pin'`);
  assert.deepEqual(columnas.rows, []);
});
