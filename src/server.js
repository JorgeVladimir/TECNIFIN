import { createServer } from 'node:http';
import { crearAplicacion } from './app.js';
import { crearAlertador } from './platform/alertas.js';
import { crearCorreo } from './platform/correo.js';
import { crearJwt } from './platform/jwt.js';
import { connectPostgres } from './platform/postgres.js';
import { crearServicioPlataforma } from './modules/plataforma/servicio.js';
import { crearServicioSocios } from './modules/socios/servicio.js';

const puerto = Number(process.env.TECNIFIN_PORT || 3000);
if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw new Error('TECNIFIN_PORT invalido');

const db = connectPostgres();
const alertar = crearAlertador();
const jwt = crearJwt();
const correo = crearCorreo();
if (!correo.configurado) console.warn('Correo sin configurar (TECNIFIN_SMTP_*): la recuperacion de clave no enviara correos.');
const servicio = crearServicioPlataforma({ db, jwt, alertar, correo });
const socios = crearServicioSocios({ db, jwt, alertar });
const servidor = createServer(crearAplicacion(servicio, { socios }));

servidor.listen(puerto, '127.0.0.1', () => console.log(`TECNIFIN escucha en 127.0.0.1:${puerto}`));

async function cerrar() {
  servidor.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.once('SIGINT', cerrar);
process.once('SIGTERM', cerrar);

