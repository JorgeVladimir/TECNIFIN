// Provision de bases LOCALES: lo que comparten tools/init-db.mjs y las pruebas de
// integracion, que crean y borran su propia base efimera. Una sola implementacion
// (regla 13). Nada de esto lo usa la aplicacion: son tareas de superusuario.
import pg from 'pg';

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
