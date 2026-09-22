// Unica puerta de entrada a los datos de una cooperativa (regla 1 y 13).
// Nadie escribe "cooperativa_id = ?" a mano: el tenant se fija en la sesion de base de
// datos y las politicas RLS hacen el resto. Una consulta fuera de withTenant() no
// devuelve el universo: devuelve cero filas, porque sin el valor fijado la politica no
// calza ninguna (ADR-0001 punto 3, ADR-0002 punto 3).
import { connectPostgres } from './postgres.js';

// Nombre del parametro de sesion que leen las politicas RLS (tecnifin.cooperativa_actual()).
export const CLAVE_TENANT = 'app.cooperativa_id';
export const CLAVE_CODIGO_LOGIN = 'app.cooperativa_codigo';

export class ErrorDesvioContextoTenant extends Error {
  constructor(detalle) {
    super('El contexto de tenant cambio durante la transaccion');
    this.name = 'ErrorDesvioContextoTenant';
    this.code = 'TECNIFIN_TENANT_CONTEXT_DRIFT';
    this.descartarConexion = true;
    this.detalle = detalle;
  }
}

export class ErrorCooperativaLogin extends Error {
  constructor() {
    super('Cooperativa de login no disponible');
    this.name = 'ErrorCooperativaLogin';
  }
}

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
export function crearWithTenant(db, { alertarDesvio = async () => {} } = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError('crearWithTenant necesita una base con transaction()');
  }
  // async a proposito: un tenant invalido vuelve como promesa rechazada, no como
  // excepcion sincrona que se escaparia de un .catch() del llamador.
  return async function withTenant(cooperativaId, fn, transaccionExistente = null, contexto = {}) {
    const cooperativa = validarCooperativaId(cooperativaId);
    if (typeof fn !== 'function') throw new TypeError('withTenant necesita una funcion de trabajo');
    if (transaccionExistente !== null
      && (!transaccionExistente || typeof transaccionExistente.query !== 'function')) {
      throw new TypeError('transaccionExistente debe exponer query()');
    }
    const comprobar = async (tx, cooperativa, fase) => {
      const resultado = await tx.query(
        `SELECT current_setting(@clave, true) AS cooperativa_id,
                pg_backend_pid()::text AS conexion_id,
                txid_current_if_assigned()::text AS transaccion_id`,
        { clave: CLAVE_TENANT });
      const actual = resultado.rows[0] || {};
      if (actual.cooperativa_id !== String(cooperativa)) {
        throw new ErrorDesvioContextoTenant({
          tipo: 'DESVIO_CONTEXTO_TENANT', fase,
          cooperativaEsperada: cooperativa,
          cooperativaObservada: actual.cooperativa_id || null,
          solicitudId: contexto.solicitudId || null,
          usuarioLogin: contexto.usuarioLogin || null,
          conexionId: actual.conexion_id || null,
          transaccionId: actual.transaccion_id || null,
        });
      }
    };
    const ejecutar = async tx => {
      // set_config(clave, valor, true) es SET LOCAL parametrizado: acotado a esta
      // transaccion y sin interpolar nada en el SQL. Al COMMIT o ROLLBACK el valor
      // desaparece y la conexion vuelve limpia al pool. Un SET sin LOCAL dejaria el
      // tenant pegado a la conexion: esa es la fuga que H1 existe para impedir.
      await tx.query('SELECT set_config(@clave, @valor, true)', {
        clave: CLAVE_TENANT, valor: String(cooperativa),
      });
      await comprobar(tx, cooperativa, 'entrada');
      const resultado = await fn(tx, cooperativa);
      await comprobar(tx, cooperativa, 'salida');
      return resultado;
    };
    // Las operaciones de plataforma que tambien escriben datos del tenant (por ejemplo,
    // el alta atomica de una cooperativa) entregan su transaccion ya abierta. Asi la fila
    // de plataforma y sus datos de negocio confirman o revierten como una sola unidad.
    try {
      if (transaccionExistente) return await ejecutar(transaccionExistente);
      return await db.transaction(ejecutar);
    } catch (error) {
      if (error instanceof ErrorDesvioContextoTenant) await alertarDesvio(error.detalle);
      throw error;
    }
  };
}

export function crearWithTenantPorCodigo(db, withTenant) {
  if (!db || typeof db.transaction !== 'function' || typeof withTenant !== 'function') {
    throw new TypeError('crearWithTenantPorCodigo necesita base y withTenant');
  }
  return async function withTenantPorCodigo(codigo, fn, contexto = {}) {
    const canonico = String(codigo || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,20}$/.test(canonico)) throw new ErrorCooperativaLogin();
    if (typeof fn !== 'function') throw new TypeError('withTenantPorCodigo necesita una funcion');
    return db.transaction(async tx => {
      await tx.query('SELECT set_config(@clave, @valor, true)', {
        clave: CLAVE_CODIGO_LOGIN, valor: canonico,
      });
      const filas = await tx.query(
        `SELECT cooperativa_id FROM tecnifin.cooperativas
          WHERE codigo = @codigo AND activa`, { codigo: canonico });
      if (filas.rows.length !== 1) throw new ErrorCooperativaLogin();
      return withTenant(filas.rows[0].cooperativa_id, fn, tx, contexto);
    });
  };
}

let baseCompartida = null;

// withTenant(cooperativaId, fn) de la aplicacion, sobre el pool compartido del proceso.
export function withTenant(cooperativaId, fn, transaccionExistente = null, contexto = {}) {
  baseCompartida ??= connectPostgres();
  return crearWithTenant(baseCompartida)(cooperativaId, fn, transaccionExistente, contexto);
}

export async function cerrarTenant() {
  const base = baseCompartida;
  baseCompartida = null;
  if (base) await base.close();
}
