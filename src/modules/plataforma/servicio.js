import { randomUUID } from 'node:crypto';
import { hashearClave, verificarClave } from '../../platform/credenciales.js';
import { ErrorAutenticacion } from '../../platform/jwt.js';
import {
  crearWithTenant, crearWithTenantPorCodigo, ErrorCooperativaLogin,
} from '../../platform/tenant.js';

export class ErrorSolicitud extends Error {
  constructor(message) { super(message); this.name = 'ErrorSolicitud'; this.statusCode = 400; }
}
export class ErrorAutorizacion extends Error {
  constructor() { super('No autorizado'); this.name = 'ErrorAutorizacion'; this.statusCode = 403; }
}
export class ErrorConfiguracion extends Error {
  constructor() { super('Configuracion de autenticacion incompleta'); this.name = 'ErrorConfiguracion'; this.statusCode = 503; }
}

const ROLES_ADMIN_USUARIOS = new Set(['SUPER_USER', 'ADMIN']);

function loginCanonico(valor) {
  const login = String(valor || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(login)) throw new ErrorSolicitud('Credenciales incompletas');
  return login;
}

async function auditar(tx, usuarioLogin, concepto, detalle) {
  await tx.query(
    `INSERT INTO tecnifin.auditoria_usuarios (usuario_login, concepto, detalle)
     VALUES (@usuario, @concepto, @detalle)`, { usuario: usuarioLogin, concepto, detalle });
}

function vidaJwt(filas) {
  const valor = filas.find(fila => fila.clave === 'auth.jwt_vida_segundos')?.valor;
  const segundos = Number(valor);
  return Number.isSafeInteger(segundos) && segundos > 0 ? segundos : null;
}

export function crearServicioPlataforma({ db, jwt, alertar = async () => {} }) {
  if (!db || typeof db.transaction !== 'function' || !jwt
      || typeof jwt.emitir !== 'function' || typeof jwt.verificar !== 'function') {
    throw new TypeError('crearServicioPlataforma necesita db y jwt');
  }
  const withTenant = crearWithTenant(db, { alertarDesvio: alertar });
  const withTenantPorCodigo = crearWithTenantPorCodigo(db, withTenant);
  const hashFicticio = hashearClave('__usuario_inexistente__', randomUUID());

  async function login({ cooperativa, usuario, clave }, contexto = {}) {
    const loginUsuario = loginCanonico(usuario);
    if (typeof clave !== 'string' || clave.length < 1) throw new ErrorSolicitud('Credenciales incompletas');
    let resultado;
    try {
      resultado = await withTenantPorCodigo(cooperativa, async tx => {
        const usuarios = await tx.query(
          `SELECT usuario_id, cooperativa_id, login, nombre_completo, password_hash, rol, activo, requiere_cambio_pin
             FROM tecnifin.usuarios WHERE login = @login`, { login: loginUsuario });
        const encontrado = usuarios.rows[0];
        const coincide = await verificarClave(
          encontrado?.login || '__usuario_inexistente__', clave,
          encontrado?.password_hash || await hashFicticio);
        if (!encontrado || !encontrado.activo || !coincide) {
          await auditar(tx, loginUsuario, 'LOGIN_FALLIDO', 'Credenciales invalidas o usuario inactivo.');
          return { error: new ErrorAutenticacion('Credenciales invalidas') };
        }

        const parametros = (await tx.query(
          `SELECT clave, valor FROM tecnifin.parametros_cooperativa
            WHERE clave IN ('auth.jwt_vida_segundos', 'auth.refresh_habilitado', 'auth.invalidacion_modo')`
        )).rows;
        const vidaSegundos = vidaJwt(parametros);
        if (!vidaSegundos) {
          await auditar(tx, loginUsuario, 'LOGIN_NO_CONFIGURADO', 'Falta configurar la vigencia JWT del tenant.');
          return { error: new ErrorConfiguracion() };
        }
        await auditar(tx, loginUsuario, 'LOGIN_EXITOSO', `Acceso autenticado con rol ${encontrado.rol}.`);
        return { usuario: encontrado, vidaSegundos };
      }, { solicitudId: contexto.solicitudId, usuarioLogin: loginUsuario });
    } catch (error) {
      if (error instanceof ErrorCooperativaLogin) {
        await alertar({ tipo: 'LOGIN_RECHAZADO', solicitudId: contexto.solicitudId, motivo: 'cooperativa_no_disponible' });
        throw new ErrorAutenticacion('Credenciales invalidas');
      }
      throw error;
    }
    if (resultado.error) throw resultado.error;
    const u = resultado.usuario;
    return {
      token: jwt.emitir({ usuarioId: u.usuario_id, cooperativaId: u.cooperativa_id,
        rol: u.rol, login: u.login, vidaSegundos: resultado.vidaSegundos }),
      usuario: { login: u.login, nombre: u.nombre_completo, rol: u.rol,
        requiereCambioPin: u.requiere_cambio_pin },
    };
  }

  async function ejecutarAutenticado(token, contexto, operacion) {
    let claims;
    try { claims = jwt.verificar(token); }
    catch (error) {
      await alertar({ tipo: 'TOKEN_RECHAZADO', solicitudId: contexto.solicitudId, motivo: 'jwt_invalido' });
      throw error;
    }
    const resultado = await withTenant(claims.coop, async tx => {
      const identidad = (await tx.query(
        `SELECT u.usuario_id, u.login, u.nombre_completo, u.rol, u.activo
           FROM tecnifin.usuarios u
           JOIN tecnifin.cooperativas c ON c.cooperativa_id = u.cooperativa_id
          WHERE u.usuario_id = @usuario AND c.activa`, { usuario: claims.sub })).rows[0];
      if (!identidad || !identidad.activo || identidad.login !== claims.login) {
        await auditar(tx, claims.login, 'TOKEN_RECHAZADO', 'Identidad inactiva o sin pertenencia vigente.');
        return { error: new ErrorAutenticacion() };
      }
      return operacion(tx, identidad);
    }, null, { solicitudId: contexto.solicitudId, usuarioLogin: claims.login });
    if (resultado?.error) throw resultado.error;
    return resultado;
  }

  async function listarUsuarios(token, contexto = {}) {
    return ejecutarAutenticado(token, contexto, async (tx, actor) => {
      if (!ROLES_ADMIN_USUARIOS.has(actor.rol)) {
        await auditar(tx, actor.login, 'USUARIOS_DENEGADO', 'Intento de consultar usuarios sin rol autorizado.');
        return { error: new ErrorAutorizacion() };
      }
      const filas = await tx.query(
        `SELECT login, nombre_completo AS nombre, rol, activo, requiere_cambio_pin
           FROM tecnifin.usuarios ORDER BY login`);
      await auditar(tx, actor.login, 'CONSULTA_USUARIOS', 'Consulta del directorio de usuarios del tenant.');
      return filas.rows.map(fila => ({ login: fila.login, nombre: fila.nombre, rol: fila.rol,
        activo: fila.activo, requiereCambioPin: fila.requiere_cambio_pin }));
    });
  }

  async function leerConfiguracion(token, contexto = {}) {
    return ejecutarAutenticado(token, contexto, async (tx, actor) => {
      const marca = (await tx.query(
        `SELECT codigo, razon_social, nombre_comercial, color_primario, color_acento, logo_url
           FROM tecnifin.cooperativas`)).rows[0];
      const parametros = (await tx.query(
        `SELECT clave, valor, descripcion FROM tecnifin.parametros_cooperativa ORDER BY clave`)).rows;
      await auditar(tx, actor.login, 'LECTURA_CONFIGURACION', 'Lectura de configuracion del tenant.');
      return { cooperativa: marca, parametros: Object.fromEntries(parametros.map(f => [f.clave, {
        valor: f.valor, descripcion: f.descripcion,
      }])) };
    });
  }

  return { login, listarUsuarios, leerConfiguracion };
}
