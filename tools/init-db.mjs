// Provisiona solo el rol y la base LOCALES de desarrollo (nunca un servidor remoto).
import './_env.mjs';
import pg from 'pg';
import { postgresConfig } from '../src/platform/postgres.js';

const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
let admin, app;
try {
  const config = postgresConfig();
  if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('Este inicializador requiere destino local');
  if (!process.env.TECNIFIN_PG_ADMIN_PASSWORD) throw new Error('Falta TECNIFIN_PG_ADMIN_PASSWORD');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(config.user) || !/^[a-z][a-z0-9_]{0,62}$/.test(config.database)) {
    throw new Error('Usuario/base deben ser identificadores simples de hasta 63 caracteres');
  }
  admin = new pg.Client({ ...config, database: 'postgres', user: 'postgres', password: process.env.TECNIFIN_PG_ADMIN_PASSWORD });
  await admin.connect();
  const role = await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=$1', [config.user]);
  if (!role.rowCount) {
    await admin.query(`CREATE ROLE ${identifier(config.user)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(config.password)}`);
    console.log('Usuario de aplicacion creado sin privilegios de administrador.');
  } else if (role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole) {
    throw new Error('El usuario existente tiene privilegios superiores a los previstos');
  }
  const database = await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [config.database]);
  if (!database.rowCount) {
    await admin.query(`CREATE DATABASE ${identifier(config.database)} OWNER ${identifier(config.user)} TEMPLATE template0 ENCODING 'UTF8'`);
    console.log('Base de desarrollo creada.');
  } else if (database.rows[0].owner !== config.user) {
    throw new Error('La base existente pertenece a otro usuario');
  }
  app = new pg.Client(config);
  await app.connect();
  const result = await app.query('SELECT current_database() AS database, current_user AS username, version() AS version');
  console.log(JSON.stringify(result.rows[0]));
} catch (error) {
  console.error('Inicializacion PostgreSQL:', error.code || error.message);
  process.exitCode = 1;
} finally {
  if (app) await app.end();
  if (admin) await admin.end();
}
