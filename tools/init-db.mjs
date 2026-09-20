// Provisiona los dos roles y la base LOCALES de desarrollo (nunca un servidor remoto).
//
// Separacion de roles de ADR-0002: tecnifin_admin es DUENO de la base y ejecuta las
// migraciones; tecnifin_app solo hace DML, no es dueno de nada y no tiene BYPASSRLS.
// Si la aplicacion fuera la duena de sus tablas, FORCE ROW LEVEL SECURITY seria lo unico
// que la contendria; con los roles separados hay dos barreras en vez de una.
import { entornoAdmin } from './_env.mjs';
import pg from 'pg';
import { conectarSuperusuario, identificador, literal } from './_local.mjs';
import { postgresConfig } from '../src/platform/postgres.js';

const esIdentificadorSimple = valor => /^[a-z][a-z0-9_]{0,62}$/.test(valor || '');

async function asegurarRol(cliente, nombre, clave) {
  const atributos = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  const existe = await cliente.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [nombre]);
  await cliente.query(
    `${existe.rowCount ? 'ALTER ROLE' : 'CREATE ROLE'} ${identificador(nombre)}`
    + ` WITH ${atributos} PASSWORD ${literal(clave)}`);
  // El esquema de la plataforma primero; public queda para las extensiones.
  await cliente.query(`ALTER ROLE ${identificador(nombre)} SET search_path = tecnifin, public`);
  return existe.rowCount ? 'actualizado' : 'creado';
}

let superusuario, enBase, aplicacion;
try {
  const configuracion = postgresConfig();
  // El migrador se lee con el mismo helper que usan migrate.mjs y las pruebas.
  const { TECNIFIN_PG_USER: duenoNombre, TECNIFIN_PG_PASSWORD: duenoClave } = entornoAdmin();
  if (duenoNombre === configuracion.user) {
    throw new Error('El rol de la aplicacion no puede ser el dueno del esquema (ADR-0002)');
  }
  for (const nombre of [configuracion.user, duenoNombre, configuracion.database]) {
    if (!esIdentificadorSimple(nombre)) {
      throw new Error('Roles y base deben ser identificadores simples de hasta 63 caracteres');
    }
  }

  superusuario = await conectarSuperusuario(configuracion);
  console.log(`Rol dueno ${duenoNombre}: ${await asegurarRol(superusuario, duenoNombre, duenoClave)}.`);
  console.log(`Rol de aplicacion ${configuracion.user}: `
    + `${await asegurarRol(superusuario, configuracion.user, configuracion.password)}.`);

  const base = await superusuario.query(
    'SELECT pg_get_userbyid(datdba) AS dueno FROM pg_database WHERE datname=$1', [configuracion.database]);
  if (!base.rowCount) {
    await superusuario.query(
      `CREATE DATABASE ${identificador(configuracion.database)} OWNER ${identificador(duenoNombre)}`
      + ` TEMPLATE template0 ENCODING 'UTF8'`);
    console.log('Base de desarrollo creada.');
  } else if (base.rows[0].dueno !== duenoNombre) {
    throw new Error(
      `La base ${configuracion.database} pertenece a ${base.rows[0].dueno} y deberia pertenecer a `
      + `${duenoNombre}. Borrarla (esta vacia) o transferirla antes de continuar.`);
  }

  // La aplicacion entra a la base pero no crea objetos en ella.
  enBase = await conectarSuperusuario(configuracion, configuracion.database);
  await enBase.query(
    `GRANT CONNECT ON DATABASE ${identificador(configuracion.database)} TO ${identificador(configuracion.user)}`);
  await enBase.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

  aplicacion = new pg.Client(configuracion);
  await aplicacion.connect();
  const resultado = await aplicacion.query(`SELECT current_database() AS base, current_user AS rol,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls,
    pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database())) AS dueno_base`);
  const estado = resultado.rows[0];
  if (estado.bypassrls) throw new Error('El rol de la aplicacion tiene BYPASSRLS');
  if (estado.dueno_base === estado.rol) throw new Error('El rol de la aplicacion es dueno de la base');
  console.log(JSON.stringify(estado));
} catch (error) {
  console.error('Inicializacion PostgreSQL:', error.code || error.message);
  process.exitCode = 1;
} finally {
  for (const cliente of [aplicacion, enBase, superusuario]) if (cliente) await cliente.end();
}
