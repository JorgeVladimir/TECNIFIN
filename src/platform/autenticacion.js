// Nucleo comun de toda operacion autenticada (patron 03): verificar el JWT, entrar por
// withTenant(claims.coop), releer la identidad en la base, exigir el rol por lista blanca y
// auditar dentro de la misma transaccion. Cada modulo (plataforma, socios, caja...) usa esto
// en vez de repetirlo: una sola implementacion, un solo lugar donde corregir.
import { ErrorAutenticacion } from './jwt.js';
import { crearWithTenant, crearWithTenantPorCodigo } from './tenant.js';

export class ErrorSolicitud extends Error {
  constructor(message) { super(message); this.name = 'ErrorSolicitud'; this.statusCode = 400; }
}
export class ErrorAutorizacion extends Error {
  constructor() { super('No autorizado'); this.name = 'ErrorAutorizacion'; this.statusCode = 403; }
}
export class ErrorNoEncontrado extends Error {
  constructor() { super('No encontrado'); this.name = 'ErrorNoEncontrado'; this.statusCode = 404; }
}
export class ErrorConflicto extends Error {
  constructor(message) { super(message); this.name = 'ErrorConflicto'; this.statusCode = 409; }
}
export class ErrorCambioClavePendiente extends Error {
  constructor() { super('Debe cambiar su clave antes de continuar'); this.name = 'ErrorCambioClavePendiente'; this.statusCode = 403; }
}

export async function auditar(tx, usuarioLogin, concepto, detalle) {
  await tx.query(
    `INSERT INTO tecnifin.auditoria_usuarios (usuario_login, concepto, detalle)
     VALUES (@usuario, @concepto, @detalle)`, { usuario: usuarioLogin, concepto, detalle });
}

// Auditoria de procesos de negocio (alta de socio, apertura de cuenta...): quien, que
// entidad y que cambio. Append-only por la base (0008).
export async function auditarProceso(tx, actor, { proceso, accion, entidadTipo, entidadId = null,
  campo = null, anterior = null, nuevo = null, detalle = null }) {
  await tx.query(
    `INSERT INTO tecnifin.auditoria_procesos
       (proceso, accion, entidad_tipo, entidad_id, usuario_login, campo_afectado, valor_anterior, valor_nuevo, detalle)
     VALUES (@proceso, @accion, @entidad_tipo, @entidad_id, @login, @campo, @anterior, @nuevo, @detalle)`,
    { proceso, accion, entidad_tipo: entidadTipo, entidad_id: entidadId === null ? null : String(entidadId),
      login: actor.login, campo, anterior, nuevo, detalle });
}

export function crearAutenticador({ db, jwt, alertar = async () => {} }) {
  if (!db || typeof db.transaction !== 'function' || !jwt || typeof jwt.verificar !== 'function') {
    throw new TypeError('crearAutenticador necesita db y jwt');
  }
  const withTenant = crearWithTenant(db, { alertarDesvio: alertar });
  const withTenantPorCodigo = crearWithTenantPorCodigo(db, withTenant);

  async function ejecutarAutenticado(token, contexto, operacion, { permitirCambioPendiente = false } = {}) {
    let claims;
    try { claims = jwt.verificar(token); }
    catch (error) {
      await alertar({ tipo: 'TOKEN_RECHAZADO', solicitudId: contexto.solicitudId, motivo: 'jwt_invalido' });
      throw error;
    }
    const resultado = await withTenant(claims.coop, async tx => {
      const identidad = (await tx.query(
        `SELECT u.usuario_id, u.login, u.nombre_completo, u.rol, u.activo, u.requiere_cambio_pin,
                u.impresora_predeterminada, u.password_hash
           FROM tecnifin.usuarios u
           JOIN tecnifin.cooperativas c ON c.cooperativa_id = u.cooperativa_id
          WHERE u.usuario_id = @usuario AND c.activa`, { usuario: claims.sub })).rows[0];
      if (!identidad || !identidad.activo || identidad.login !== claims.login) {
        await auditar(tx, claims.login, 'TOKEN_RECHAZADO', 'Identidad inactiva o sin pertenencia vigente.');
        return { error: new ErrorAutenticacion() };
      }
      // Con clave temporal solo se puede ver el perfil y cambiar la clave: una clave que
      // conoce el administrador no debe servir para operar.
      if (identidad.requiere_cambio_pin && !permitirCambioPendiente) {
        return { error: new ErrorCambioClavePendiente() };
      }
      return operacion(tx, identidad);
    }, null, { solicitudId: contexto.solicitudId, usuarioLogin: claims.login });
    if (resultado?.error) throw resultado.error;
    return resultado;
  }

  // Operacion reservada a una lista blanca de roles; la denegacion se audita y confirma.
  function conRoles(token, contexto, roles, concepto, operacion) {
    return ejecutarAutenticado(token, contexto, async (tx, actor) => {
      if (!roles.has(actor.rol)) {
        await auditar(tx, actor.login, `${concepto}_DENEGADO`, 'Intento sin rol autorizado.');
        return { error: new ErrorAutorizacion() };
      }
      return operacion(tx, actor);
    });
  }

  return { withTenant, withTenantPorCodigo, ejecutarAutenticado, conRoles };
}
