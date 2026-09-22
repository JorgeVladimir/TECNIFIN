import { createServer } from 'node:http';
import { crearAplicacion } from './app.js';
import { crearAlertador } from './platform/alertas.js';
import { crearJwt } from './platform/jwt.js';
import { connectPostgres } from './platform/postgres.js';
import { crearServicioPlataforma } from './modules/plataforma/servicio.js';

const puerto = Number(process.env.TECNIFIN_PORT || 3000);
if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw new Error('TECNIFIN_PORT invalido');

const db = connectPostgres();
const alertar = crearAlertador();
const jwt = crearJwt();
const servicio = crearServicioPlataforma({ db, jwt, alertar });
const servidor = createServer(crearAplicacion(servicio));

servidor.listen(puerto, '127.0.0.1', () => console.log(`TECNIFIN escucha en 127.0.0.1:${puerto}`));

async function cerrar() {
  servidor.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.once('SIGINT', cerrar);
process.once('SIGTERM', cerrar);

