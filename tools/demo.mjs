// Crea (y RECREA) la base de DEMOSTRACION desde cero: node tools/demo.mjs
//
// La base de demostracion es una base APARTE (tecnifin_demo). La de desarrollo y la de
// produccion nacen y siguen en blanco: ningun dato sintetico entra en ellas (regla 11).
// Mismas migraciones y mismos dos roles que las demas; lo unico propio es el nombre.
//
// Idempotente por construccion: la base se borra y se vuelve a crear, asi que dos
// corridas dejan exactamente el mismo contenido de negocio.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { entornoAdmin } from './_env.mjs';
import {
  conectarSuperusuario, identificador, literal, crearBaseLocal, borrarBaseLocal, migrarBase,
} from './_local.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { hashearClave } from '../src/platform/credenciales.js';
import { construirDemo, COOPERATIVA_DEMO, FECHA_CORTE } from './demo-datos.mjs';

// Marca que esta base es nuestra y es desechable. El nombre no alcanza como defensa:
// en un servidor compartido puede haber un otroproyecto_demo, y un DROP no se deshace.
export const MARCA_DEMO = 'tecnifin:demo';

// El nombre de la base de demostracion tiene que TERMINAR en _demo. Es la primera
// barrera, barata: impide que un TECNIFIN_PG_DEMO_DATABASE mal puesto apunte a la base
// de desarrollo o a la de produccion, que es un error de una letra.
export function nombreBaseDemo(env = process.env) {
  const nombre = env.TECNIFIN_PG_DEMO_DATABASE || 'tecnifin_demo';
  if (!/^[a-z][a-z0-9_]*_demo$/.test(nombre)) {
    throw new Error(`La base de demostracion debe llamarse <algo>_demo, no "${nombre}"`);
  }
  if (nombre === env.TECNIFIN_PG_DATABASE) {
    throw new Error('La base de demostracion no puede ser la misma que la de trabajo');
  }
  return nombre;
}

// La clave de los usuarios de la demo sale de .env y NUNCA se imprime ni se versiona.
// Sin ella la demo se crea igual, con una clave aleatoria que nadie conoce: los datos se
// pueden mirar, pero no se entra con una clave adivinada.
function hashDeClave(env = process.env) {
  const clave = env.TECNIFIN_DEMO_PASSWORD || randomBytes(32).toString('hex');
  return login => hashearClave(login, clave);
}

async function crearBaseDemo(env = process.env) {
  const nombre = nombreBaseDemo(env);
  const configuracion = postgresConfig(env);
  const superusuario = await conectarSuperusuario(configuracion, 'postgres', env);
  try {
    // La barrera de verdad: si la base ya existe y no lleva NUESTRA marca, no es la
    // nuestra y no se borra, se llame como se llame. El nombre solo dice como se llama;
    // la marca dice de quien es.
    const existente = await superusuario.query(
      `SELECT shobj_description(oid, 'pg_database') AS marca FROM pg_database WHERE datname = $1`,
      [nombre]);
    if (existente.rowCount && existente.rows[0].marca !== MARCA_DEMO) {
      throw new Error(
        `La base ${nombre} existe y no lleva la marca ${MARCA_DEMO}: no se puede saber que es`
        + ' desechable, asi que no se toca. Si de verdad es una demo vieja, borrela a mano'
        + ` (DROP DATABASE ${identificador(nombre)}) y vuelva a correr el comando.`);
    }
    await borrarBaseLocal(superusuario, nombre);
  } finally {
    await superusuario.end();
  }

  await crearBaseLocal(configuracion, nombre,
    { dueno: entornoAdmin(env).TECNIFIN_PG_USER, aplicacion: configuracion.user }, env);

  const marcar = await conectarSuperusuario(configuracion, 'postgres', env);
  try {
    await marcar.query(`COMMENT ON DATABASE ${identificador(nombre)} IS ${literal(MARCA_DEMO)}`);
  } finally {
    await marcar.end();
  }
  return nombre;
}

export async function poblarBaseDemo(entorno) {
  const admin = connectPostgres(entornoAdmin(entorno));
  const app = connectPostgres(entorno);
  try {
    // El contenido entra por withTenant y con el rol de la aplicacion: la demo recorre
    // el mismo camino que recorreria el sistema, RLS incluido.
    return await construirDemo({ admin, withTenant: crearWithTenant(app), hash: hashDeClave(entorno) });
  } finally {
    await app.close();
    await admin.close();
  }
}

// Ejecutado como script (npm run demo:crear), no importado por una prueba.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const nombre = await crearBaseDemo();
    const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombre };
    await migrarBase(entorno);
    const resumen = await poblarBaseDemo(entorno);
    console.log(`Base de demostracion ${nombre} creada desde cero.`);
    console.log(`Cooperativa ${COOPERATIVA_DEMO.codigo} (${COOPERATIVA_DEMO.nombreComercial}),`
      + ` ${resumen.usuarios} usuarios, ${resumen.socios} socios, ${resumen.creditos} creditos,`
      + ` plazo fijo ${resumen.plazoFijo}, corte de cartera ${FECHA_CORTE}.`);
    if (!process.env.TECNIFIN_DEMO_PASSWORD) {
      console.log('Aviso: sin TECNIFIN_DEMO_PASSWORD en .env, los usuarios quedan sin clave utilizable.');
    }
  } catch (error) {
    console.error(`Base de demostracion: ${error.message}`);
    process.exitCode = 1;
  }
}
