// Derivacion y verificacion de secretos (claves de usuario, PIN del canal en linea).
//
// Una sola implementacion (regla 13): el formato que sale de aqui es el que exige el
// dominio tecnifin.hash_secreto del esquema, asi que si los dos se separan el INSERT
// falla en el acto en vez de dejar filas que nadie puede verificar despues.
//
// Formato: <algoritmo>$<sal hex>$<derivado hex>. La etiqueta de algoritmo al frente es lo
// que permite cambiar de funcion o de parametros mas adelante sin migrar las filas viejas:
// cada fila dice con que se genero.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt);
const ALGORITMO = 'scrypt';
const BYTES_SAL = 16;
const BYTES_DERIVADO = 32;

// El login entra en el material derivado: dos personas con la misma clave no comparten
// hash ni aunque la sal fallara.
const material = (login, clave) => `${login}:${clave}`;

export async function hashearClave(login, clave) {
  if (!login || !clave) throw new TypeError('hashearClave necesita login y clave');
  const sal = randomBytes(BYTES_SAL).toString('hex');
  const derivado = await derivar(material(login, clave), sal, BYTES_DERIVADO);
  return `${ALGORITMO}$${sal}$${derivado.toString('hex')}`;
}

// Comparacion en tiempo constante: una comparacion normal responde antes cuanto mas se
// parece el valor, y eso alcanza para adivinar un hash byte a byte.
export async function verificarClave(login, clave, hash) {
  const partes = String(hash || '').split('$');
  if (partes.length !== 3 || partes[0] !== ALGORITMO) return false;
  const [, sal, esperado] = partes;
  const derivado = await derivar(material(login, clave), sal, BYTES_DERIVADO);
  const guardado = Buffer.from(esperado, 'hex');
  return guardado.length === derivado.length && timingSafeEqual(guardado, derivado);
}
