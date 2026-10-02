// El catalogo de la API (docs/api/CATALOGO.md) contra la aplicacion real: cada fila tiene una
// ruta detras (con un token valido no da 404 ni 5xx) y las no publicas rechazan sin token (401).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { crearAplicacion } from '../src/app.js';
import { hashearClave } from '../src/platform/credenciales.js';
import { crearJwt } from '../src/platform/jwt.js';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { crearServicioPlataforma } from '../src/modules/plataforma/servicio.js';
import { crearServicioSocios } from '../src/modules/socios/servicio.js';
import { crearServicioCaja } from '../src/modules/caja/servicio.js';
import { crearServicioCreditos } from '../src/modules/creditos/servicio.js';
import { crearServicioPlazoFijo } from '../src/modules/plazo_fijo/servicio.js';
import { crearServicioCartera } from '../src/modules/cartera/servicio.js';
import { crearServicioContabilidad } from '../src/modules/contabilidad/servicio.js';
import { crearServicioReportes } from '../src/modules/reportes/servicio.js';
import { REPO_ROOT, entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase } from '../tools/_local.mjs';
import { crearDosCooperativas } from './fixtures/cooperativas.mjs';

const nombreBase = `tecnifin_api_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const entornoJwt = {
  TECNIFIN_JWT_SECRET: 'clave-de-prueba-catalogo-api-con-mas-de-32-bytes',
  TECNIFIN_JWT_ISSUER: 'tecnifin-catalogo-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
};
const FILA = /^\| `(GET|POST|PUT)` \| `([^`]+)` \| ([^|]+?) \|/;
const rutas = readFileSync(`${REPO_ROOT}/docs/api/CATALOGO.md`, 'utf8').split(/\r?\n/)
  .map(l => FILA.exec(l)).filter(Boolean).map(([, metodo, ruta, roles]) => ({ metodo, ruta, publica: roles.trim() === 'PÚBLICO' }));

let app, admin, servidor, baseUrl, token, creada = false;

before(async () => {
  const configuracion = postgresConfig();
  await crearBaseLocal(configuracion, nombreBase, { dueno: entornoAdmin().TECNIFIN_PG_USER, aplicacion: configuracion.user });
  creada = true;
  await migrarBase(entorno);
  admin = connectPostgres(entornoAdmin(entorno));
  app = connectPostgres(entorno);
  const withTenant = crearWithTenant(app);
  const [coopA] = await crearDosCooperativas(admin, withTenant);
  await withTenant(coopA.cooperativa_id, async tx => {
    await tx.query(`INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
                    VALUES ('socio.web', 'Socio web', @h, 'MEMBER')`, { h: await hashearClave('socio.web', 'clave-socio-2026') });
    await tx.query(`INSERT INTO tecnifin.parametros_cooperativa (clave, valor) VALUES ('auth.jwt_vida_segundos', '900')`);
  });
  const db = app; const jwt = crearJwt(entornoJwt);
  servidor = createServer(crearAplicacion(crearServicioPlataforma({ db, jwt }), {
    socios: crearServicioSocios({ db, jwt }), caja: crearServicioCaja({ db, jwt }), creditos: crearServicioCreditos({ db, jwt }),
    plazoFijo: crearServicioPlazoFijo({ db, jwt }), cartera: crearServicioCartera({ db, jwt }),
    contabilidad: crearServicioContabilidad({ db, jwt }), reportes: crearServicioReportes({ db, jwt }) }));
  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  token = (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cooperativa: 'COOP-A', usuario: 'socio.web', clave: 'clave-socio-2026' }) })).json()).token;
});

after(async () => {
  if (servidor) await new Promise(resolve => servidor.close(resolve));
  if (app) await app.close();
  if (admin) await admin.close();
  if (creada) {
    const superusuario = await conectarSuperusuario(postgresConfig());
    try { await borrarBaseLocal(superusuario, nombreBase); } finally { await superusuario.end(); }
  }
});

const llamar = async (metodo, ruta, conToken) => {
  const r = await fetch(baseUrl + ruta, { method: metodo,
    headers: { 'content-type': 'application/json', ...(conToken ? { authorization: `Bearer ${token}` } : {}) },
    body: metodo === 'GET' ? undefined : '{}' });
  await r.text();
  return r.status;
};

test('el catalogo lista todas las areas de la API', () => {
  assert.ok(rutas.length >= 60, `solo ${rutas.length} filas`);
  assert.ok(token, 'el usuario de prueba entro');
});

test('cada ruta del catalogo existe y las no publicas exigen token', async () => {
  const problemas = [];
  for (const { metodo, ruta, publica } of rutas) {
    if (!publica) {
      const sin = await llamar(metodo, ruta, false);
      if (sin !== 401) problemas.push(`${metodo} ${ruta}: sin token dio ${sin}`);
    }
    const con = await llamar(metodo, ruta, !publica);
    if (con === 404 || con >= 500) problemas.push(`${metodo} ${ruta}: con token dio ${con}`);
  }
  assert.deepEqual(problemas, []);
});
