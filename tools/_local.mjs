// Provision de bases LOCALES: lo que comparten tools/init-db.mjs, tools/demo.mjs y las
// pruebas de integracion, que crean y borran su propia base efimera. Una sola
// implementacion (regla 13). Nada de esto lo usa la aplicacion: son tareas de superusuario.
import pg from 'pg';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { REPO_ROOT } from './_env.mjs';

export const identificador = valor => '"' + String(valor).replaceAll('"', '""') + '"';
export const literal = valor => "'" + String(valor).replaceAll("'", "''") + "'";

// Ninguna herramienta de este repo provisiona ni borra bases en un servidor remoto.
export function exigirDestinoLocal(configuracion) {
  if (!['127.0.0.1', 'localhost'].includes(configuracion.host)) {
    throw new Error('Operacion permitida solo contra PostgreSQL local');
  }
  return configuracion;
}

// Cliente del superusuario postgres, la unica credencial que puede crear roles y bases.
// TECNIFIN_PG_ADMIN_PASSWORD es SOLO esto: no es la del migrador ni la de la aplicacion.
export async function conectarSuperusuario(configuracion, database = 'postgres', env = process.env) {
  exigirDestinoLocal(configuracion);
  if (!env.TECNIFIN_PG_ADMIN_PASSWORD) throw new Error('Falta TECNIFIN_PG_ADMIN_PASSWORD');
  const cliente = new pg.Client({
    ...configuracion, database, user: 'postgres', password: env.TECNIFIN_PG_ADMIN_PASSWORD,
  });
  await cliente.connect();
  return cliente;
}

// Crea una base con el dueno y los permisos que tendra en produccion. Que este en un
// solo lugar no es cosmetica: cuando cada prueba armaba la suya, ninguna hacia el GRANT
// ni el REVOKE, asi que probaban contra una base con permisos distintos a la real.
export async function crearBaseLocal(configuracion, nombre, { dueno, aplicacion }, env = process.env) {
  const superusuario = await conectarSuperusuario(configuracion, 'postgres', env);
  try {
    await superusuario.query(
      `CREATE DATABASE ${identificador(nombre)} OWNER ${identificador(dueno)}`
      + ` TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await superusuario.end();
  }
  const enBase = await conectarSuperusuario(configuracion, nombre, env);
  try {
    await enBase.query(
      `GRANT CONNECT ON DATABASE ${identificador(nombre)} TO ${identificador(aplicacion)}`);
    // public solo aloja las extensiones; la aplicacion no crea objetos en ella.
    await enBase.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  } finally {
    await enBase.end();
  }
  return nombre;
}

// Siempre con FORCE: sin el, un pool que quedo colgado deja la base sin poder borrarse y
// la corrida siguiente encuentra basura. Es el motivo por el que una prueba lo hacia y
// otra no.
export async function borrarBaseLocal(superusuario, nombre) {
  await superusuario.query(`DROP DATABASE IF EXISTS ${identificador(nombre)} WITH (FORCE)`);
}

// El esquema cambia solo por tools/migrate.mjs (regla 3), tambien cuando lo pide una
// prueba: se ejecuta el migrador de verdad, no una copia de sus sentencias.
export async function migrarBase(entorno) {
  await promisify(execFile)(process.execPath, ['tools/migrate.mjs', '--aplicar'],
    { cwd: REPO_ROOT, env: entorno, windowsHide: true });
}

// Que es una "tabla de negocio", en UN solo lugar: lo dice el comentario que deja
// aplicar_rls_plataforma, el mismo criterio que usa tecnifin.verificar_invariantes().
// Antes cada prueba tenia su definicion, y una tabla de plataforma nueva habria sido de
// negocio para una y de plataforma para la otra.
export async function tablasDeNegocio(cliente) {
  const filas = await cliente.query(
    `SELECT relname FROM pg_class
      WHERE relnamespace = 'tecnifin'::regnamespace AND relkind = 'r'
        AND coalesce(obj_description(oid, 'pg_class'), '') NOT LIKE 'plataforma:%'
      ORDER BY relname`);
  return filas.rows.map(f => f.relname);
}

// Un solo viaje para recorrer todas las tablas: un UNION ALL en vez de una ida y vuelta
// por tabla. `expresion` es lo que se calcula sobre cada una.
export function recorrerTablas(ejecutor, tablas, expresion) {
  return ejecutor.query(
    tablas.map(t => `SELECT '${t}' AS tabla, ${expresion} FROM tecnifin.${t}`).join(' UNION ALL '));
}
