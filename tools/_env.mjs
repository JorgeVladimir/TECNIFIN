// Carga de .env (raiz del repo) para los scripts de tools/. Loader manual: sin dependencia "dotenv".
// Los secretos salen de .env, que nunca se commitea (ver .gitignore y .env.example).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');

export function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv(join(REPO_ROOT, '.env'));

// Entorno del MIGRADOR: tecnifin_admin es dueno del esquema y el unico que hace DDL.
// La aplicacion nunca se conecta con el (ADR-0002, punto 1). Distinto de
// TECNIFIN_PG_ADMIN_PASSWORD, que es la clave del superusuario postgres y solo la usa
// tools/init-db.mjs para crear roles y bases locales.
export function entornoAdmin(env = process.env) {
  const usuario = env.TECNIFIN_PG_ADMIN_USER;
  const clave = env.TECNIFIN_PG_ADMIN_DB_PASSWORD;
  if (!usuario || !clave) {
    throw new Error('Configurar TECNIFIN_PG_ADMIN_USER y TECNIFIN_PG_ADMIN_DB_PASSWORD en .env');
  }
  return { ...env, TECNIFIN_PG_USER: usuario, TECNIFIN_PG_PASSWORD: clave };
}
