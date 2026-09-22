// Unica puerta de entrada a los datos de una cooperativa (regla 1 y 13).
// Nadie escribe "cooperativa_id = ?" a mano: el tenant se fija en la sesion de base de
// datos y las politicas RLS hacen el resto. Una consulta fuera de withTenant() no
// devuelve el universo: devuelve cero filas, porque sin el valor fijado la politica no
// calza ninguna (ADR-0001 punto 3, ADR-0002 punto 3).
import { connectPostgres } from './postgres.js';

// Nombre del parametro de sesion que leen las politicas RLS (tecnifin.cooperativa_actual()).
export const CLAVE_TENANT = 'app.cooperativa_id';

export function validarCooperativaId(cooperativaId) {
  // Number.isInteger ya descarta texto, bigint, null y objetos: no hace falta typeof.
  if (!Number.isInteger(cooperativaId) || cooperativaId < 1) {
    throw new TypeError('cooperativaId debe ser un entero positivo');
  }
  // La columna es integer en la base; un valor mayor reventaria recien en el servidor.
  if (cooperativaId > 2147483647) throw new RangeError('cooperativaId fuera del rango de integer');
  return cooperativaId;
}

// Construye withTenant sobre una base concreta. Se usa asi en las pruebas y en cualquier
// proceso que necesite su propio pool; la aplicacion usa el withTenant de abajo.
export function crearWithTenant(db) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError('crearWithTenant necesita una base con transaction()');
  }
  // async a proposito: un tenant invalido vuelve como promesa rechazada, no como
  // excepcion sincrona que se escaparia de un .catch() del llamador.
  return async function withTenant(cooperativaId, fn, transaccionExistente = null) {
    const cooperativa = validarCooperativaId(cooperativaId);
    if (typeof fn !== 'function') throw new TypeError('withTenant necesita una funcion de trabajo');
    if (transaccionExistente !== null
      && (!transaccionExistente || typeof transaccionExistente.query !== 'function')) {
      throw new TypeError('transaccionExistente debe exponer query()');
    }
    const ejecutar = async tx => {
      // set_config(clave, valor, true) es SET LOCAL parametrizado: acotado a esta
      // transaccion y sin interpolar nada en el SQL. Al COMMIT o ROLLBACK el valor
      // desaparece y la conexion vuelve limpia al pool. Un SET sin LOCAL dejaria el
      // tenant pegado a la conexion: esa es la fuga que H1 existe para impedir.
      await tx.query('SELECT set_config(@clave, @valor, true)', {
        clave: CLAVE_TENANT, valor: String(cooperativa),
      });
      return fn(tx, cooperativa);
    };
    // Las operaciones de plataforma que tambien escriben datos del tenant (por ejemplo,
    // el alta atomica de una cooperativa) entregan su transaccion ya abierta. Asi la fila
    // de plataforma y sus datos de negocio confirman o revierten como una sola unidad.
    if (transaccionExistente) return ejecutar(transaccionExistente);
    return db.transaction(ejecutar);
  };
}

let baseCompartida = null;

// withTenant(cooperativaId, fn) de la aplicacion, sobre el pool compartido del proceso.
export function withTenant(cooperativaId, fn) {
  baseCompartida ??= connectPostgres();
  return crearWithTenant(baseCompartida)(cooperativaId, fn);
}

export async function cerrarTenant() {
  const base = baseCompartida;
  baseCompartida = null;
  if (base) await base.close();
}
