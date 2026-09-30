import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashearClave, verificarClave } from '../../platform/credenciales.js';
import { correoValido } from '../../platform/correo.js';
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
export class ErrorNoEncontrado extends Error {
  constructor() { super('No encontrado'); this.name = 'ErrorNoEncontrado'; this.statusCode = 404; }
}
export class ErrorConflicto extends Error {
  constructor(message) { super(message); this.name = 'ErrorConflicto'; this.statusCode = 409; }
}
export class ErrorCambioClavePendiente extends Error {
  constructor() { super('Debe cambiar su clave antes de continuar'); this.name = 'ErrorCambioClavePendiente'; this.statusCode = 403; }
}

const ROLES_ADMIN_USUARIOS = new Set(['SUPER_USER', 'ADMIN']);
// Mismo conjunto que ck_usuarios_rol: validar aqui da un 400 claro en vez de un error de la base.
const ROLES_VALIDOS = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER', 'TELLER', 'MEMBER']);
const CLAVE_MINIMA = 10;

// Un ADMIN administra a todos salvo a SUPER_USER: ni lo toca ni lo crea. Asi nadie se
// eleva por encima de su propio rol.
function puedeAdministrar(actor, rolObjetivo) {
  return actor.rol === 'SUPER_USER' || rolObjetivo !== 'SUPER_USER';
}

function validarClaveNueva(login, clave) {
  if (typeof clave !== 'string' || clave.length < CLAVE_MINIMA || clave.length > 128) {
    throw new ErrorSolicitud(`La clave debe tener entre ${CLAVE_MINIMA} y 128 caracteres`);
  }
  if (clave.toLowerCase().includes(login)) throw new ErrorSolicitud('La clave no puede contener el usuario');
}

// Clave temporal de un solo uso: se entrega una vez al administrador y obliga a cambiarla
// en el primer ingreso (requiere_cambio_pin). No se guarda ni se registra en claro.
const claveTemporal = () => randomBytes(12).toString('base64url');

// Correo opcional del usuario: undefined = no se toca, null o '' = se borra.
function correoNormalizado(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  const correo = String(valor).trim().toLowerCase();
  if (!correoValido(correo)) throw new ErrorSolicitud('Correo invalido');
  return correo;
}

const sha256 = valor => createHash('sha256').update(valor).digest('hex');
// Respuesta unica de la recuperacion: la misma exista o no la cooperativa, el usuario o su correo.
const RESPUESTA_RECUPERACION = { mensaje: 'Si los datos son correctos, enviaremos las instrucciones al correo registrado.' };
const RECUPERACIONES_POR_HORA = 3;

function nombreValido(valor) {
  const nombre = String(valor || '').trim();
  if (nombre.length < 3 || nombre.length > 150) throw new ErrorSolicitud('Nombre invalido');
  return nombre;
}

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

export function crearServicioPlataforma({ db, jwt, alertar = async () => {}, correo = null }) {
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

  // Estado del servicio: no revela version, host ni datos de ninguna cooperativa.
  async function salud() {
    try {
      await db.query('SELECT 1');
      return { estado: 'ok', base: 'ok' };
    } catch {
      throw Object.assign(new Error('Base de datos no disponible'), { statusCode: 503 });
    }
  }

  async function perfil(token, contexto = {}) {
    return ejecutarAutenticado(token, contexto, async (_tx, actor) => ({
      login: actor.login, nombre: actor.nombre_completo, rol: actor.rol,
      requiereCambioPin: actor.requiere_cambio_pin, impresora: actor.impresora_predeterminada,
    }), { permitirCambioPendiente: true });
  }

  async function cambiarClave(token, { claveActual, claveNueva } = {}, contexto = {}) {
    return ejecutarAutenticado(token, contexto, async (tx, actor) => {
      if (typeof claveActual !== 'string' || !claveActual) throw new ErrorSolicitud('Credenciales incompletas');
      validarClaveNueva(actor.login, claveNueva);
      if (!await verificarClave(actor.login, claveActual, actor.password_hash)) {
        await auditar(tx, actor.login, 'CAMBIO_CLAVE_FALLIDO', 'Clave actual incorrecta.');
        return { error: new ErrorSolicitud('Clave actual incorrecta') };
      }
      if (claveActual === claveNueva) throw new ErrorSolicitud('La clave nueva debe ser distinta');
      await tx.query(
        `UPDATE tecnifin.usuarios SET password_hash = @hash, requiere_cambio_pin = false
          WHERE usuario_id = @id`, { hash: await hashearClave(actor.login, claveNueva), id: actor.usuario_id });
      await auditar(tx, actor.login, 'CAMBIO_CLAVE', 'El usuario cambio su clave.');
      return { ok: true };
    }, { permitirCambioPendiente: true });
  }

  // Envoltura comun de la administracion de usuarios: lista blanca de roles y auditoria
  // de la denegacion en la misma transaccion.
  function comoAdministrador(token, contexto, concepto, operacion) {
    return ejecutarAutenticado(token, contexto, async (tx, actor) => {
      if (!ROLES_ADMIN_USUARIOS.has(actor.rol)) {
        await auditar(tx, actor.login, `${concepto}_DENEGADO`, 'Intento sin rol autorizado.');
        return { error: new ErrorAutorizacion() };
      }
      return operacion(tx, actor);
    });
  }

  async function buscarObjetivo(tx, actor, loginObjetivo, concepto) {
    const login = loginCanonico(loginObjetivo);
    const objetivo = (await tx.query(
      `SELECT usuario_id, login, rol, activo, correo FROM tecnifin.usuarios WHERE login = @login`, { login })).rows[0];
    if (!objetivo) return { error: new ErrorNoEncontrado() };
    // Sobre si mismo se usa cambiar-clave: asi un administrador no se desactiva ni se
    // quita el rol por error y deja a la cooperativa sin nadie que administre.
    if (objetivo.usuario_id === actor.usuario_id) {
      return { error: new ErrorSolicitud('No puede administrar su propio usuario') };
    }
    if (!puedeAdministrar(actor, objetivo.rol)) {
      await auditar(tx, actor.login, `${concepto}_DENEGADO`, `Intento sobre ${objetivo.login} (${objetivo.rol}).`);
      return { error: new ErrorAutorizacion() };
    }
    return { objetivo };
  }

  async function crearUsuario(token, { login: loginNuevo, nombre, rol, correo: correoUsuario } = {}, contexto = {}) {
    return comoAdministrador(token, contexto, 'ALTA_USUARIO', async (tx, actor) => {
      const login = loginCanonico(loginNuevo);
      const nombreCompleto = nombreValido(nombre);
      const correoFinal = correoNormalizado(correoUsuario) ?? null;
      if (!ROLES_VALIDOS.has(rol)) throw new ErrorSolicitud('Rol invalido');
      if (!puedeAdministrar(actor, rol)) {
        await auditar(tx, actor.login, 'ALTA_USUARIO_DENEGADO', `Intento de crear ${login} con rol ${rol}.`);
        return { error: new ErrorAutorizacion() };
      }
      const existe = (await tx.query(`SELECT 1 FROM tecnifin.usuarios WHERE login = @login`, { login })).rows[0];
      if (existe) throw new ErrorConflicto('El usuario ya existe');
      const temporal = claveTemporal();
      await tx.query(
        `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol, requiere_cambio_pin, fecha_registro, correo)
         VALUES (@login, @nombre, @hash, @rol, true, current_date, @correo)`,
        { login, nombre: nombreCompleto, hash: await hashearClave(login, temporal), rol, correo: correoFinal });
      await auditar(tx, actor.login, 'ALTA_USUARIO', `Alta de ${login} con rol ${rol}.`);
      return { login, rol, correo: correoFinal, claveTemporal: temporal, requiereCambioPin: true };
    });
  }

  async function actualizarUsuario(token, loginObjetivo, { rol, activo, correo: correoUsuario } = {}, contexto = {}) {
    return comoAdministrador(token, contexto, 'CAMBIO_USUARIO', async (tx, actor) => {
      if (rol === undefined && activo === undefined && correoUsuario === undefined) {
        throw new ErrorSolicitud('Nada que actualizar');
      }
      const correoNuevo = correoNormalizado(correoUsuario);
      if (rol !== undefined && !ROLES_VALIDOS.has(rol)) throw new ErrorSolicitud('Rol invalido');
      if (activo !== undefined && typeof activo !== 'boolean') throw new ErrorSolicitud('activo debe ser booleano');
      const busqueda = await buscarObjetivo(tx, actor, loginObjetivo, 'CAMBIO_USUARIO');
      if (busqueda.error) return busqueda;
      const { objetivo } = busqueda;
      const rolFinal = rol ?? objetivo.rol;
      const activoFinal = activo ?? objetivo.activo;
      if (!puedeAdministrar(actor, rolFinal)) {
        await auditar(tx, actor.login, 'CAMBIO_USUARIO_DENEGADO', `Intento de asignar ${rolFinal} a ${objetivo.login}.`);
        return { error: new ErrorAutorizacion() };
      }
      const correoFinal = correoNuevo === undefined ? objetivo.correo : correoNuevo;
      await tx.query(
        `UPDATE tecnifin.usuarios SET rol = @rol, activo = @activo, correo = @correo WHERE usuario_id = @id`,
        { rol: rolFinal, activo: activoFinal, correo: correoFinal, id: objetivo.usuario_id });
      await auditar(tx, actor.login, 'CAMBIO_USUARIO',
        `${objetivo.login}: rol ${objetivo.rol} -> ${rolFinal}; activo ${objetivo.activo} -> ${activoFinal}`
        + `${correoNuevo === undefined ? '' : '; correo actualizado'}.`);
      return { login: objetivo.login, rol: rolFinal, activo: activoFinal, correo: correoFinal };
    });
  }

  async function restablecerClave(token, loginObjetivo, contexto = {}) {
    return comoAdministrador(token, contexto, 'RESTABLECER_CLAVE', async (tx, actor) => {
      const busqueda = await buscarObjetivo(tx, actor, loginObjetivo, 'RESTABLECER_CLAVE');
      if (busqueda.error) return busqueda;
      const { objetivo } = busqueda;
      const temporal = claveTemporal();
      await tx.query(
        `UPDATE tecnifin.usuarios SET password_hash = @hash, requiere_cambio_pin = true WHERE usuario_id = @id`,
        { hash: await hashearClave(objetivo.login, temporal), id: objetivo.usuario_id });
      await auditar(tx, actor.login, 'RESTABLECER_CLAVE', `Clave temporal emitida para ${objetivo.login}.`);
      return { login: objetivo.login, claveTemporal: temporal, requiereCambioPin: true };
    });
  }

  // Paso 1 de la recuperacion. Siempre responde lo mismo: no revela si existe la cooperativa,
  // el usuario o su correo. El correo sale despues de confirmar la transaccion; si falla, se
  // alerta a operacion y el usuario simplemente vuelve a pedirlo.
  async function olvideClave({ cooperativa, usuario } = {}, contexto = {}) {
    let loginUsuario;
    try { loginUsuario = loginCanonico(usuario); } catch { return RESPUESTA_RECUPERACION; }
    let envio = null;
    try {
      envio = await withTenantPorCodigo(cooperativa, async tx => {
        const u = (await tx.query(
          `SELECT u.usuario_id, u.login, u.nombre_completo, u.correo, u.activo, c.codigo
             FROM tecnifin.usuarios u JOIN tecnifin.cooperativas c ON c.cooperativa_id = u.cooperativa_id
            WHERE u.login = @login`, { login: loginUsuario })).rows[0];
        if (!u || !u.activo || !u.correo) {
          await auditar(tx, loginUsuario, 'RECUPERACION_SIN_ENVIO', 'Usuario inexistente, inactivo o sin correo.');
          return null;
        }
        const recientes = (await tx.query(
          `SELECT count(*)::int AS n FROM tecnifin.recuperaciones_clave
            WHERE usuario_id = @id AND fecha_creacion > now() - interval '1 hour'`, { id: u.usuario_id })).rows[0].n;
        if (recientes >= RECUPERACIONES_POR_HORA) {
          await auditar(tx, u.login, 'RECUPERACION_LIMITADA', `Mas de ${RECUPERACIONES_POR_HORA} solicitudes en una hora.`);
          return null;
        }
        const minutos = Number((await tx.query(
          `SELECT valor FROM tecnifin.parametros_cooperativa WHERE clave = 'auth.recuperacion_minutos'`)).rows[0]?.valor);
        // 60 minutos por defecto, igual que el sistema anterior; cada cooperativa lo puede acortar.
        const vigencia = Number.isSafeInteger(minutos) && minutos > 0 && minutos <= 1440 ? minutos : 60;
        const token = randomBytes(32).toString('base64url');
        // Un token nuevo anula los anteriores sin usar: solo el ultimo correo sirve.
        await tx.query(
          `UPDATE tecnifin.recuperaciones_clave SET consumida = now()
            WHERE usuario_id = @id AND consumida IS NULL`, { id: u.usuario_id });
        await tx.query(
          `INSERT INTO tecnifin.recuperaciones_clave (usuario_id, token_hash, expira)
           VALUES (@id, @hash, now() + make_interval(mins => @minutos))`,
          { id: u.usuario_id, hash: sha256(token), minutos: vigencia });
        await auditar(tx, u.login, 'RECUPERACION_SOLICITADA', `Codigo emitido, vigente ${vigencia} minutos.`);
        return { para: u.correo, nombre: u.nombre_completo, login: u.login, codigoCoop: u.codigo, token, vigencia };
      }, { solicitudId: contexto.solicitudId, usuarioLogin: loginUsuario });
    } catch (error) {
      if (error instanceof ErrorCooperativaLogin) return RESPUESTA_RECUPERACION;
      throw error;
    }
    if (envio) {
      try {
        if (!correo) throw new Error('sin correo');
        await correo.enviar({
          para: envio.para,
          asunto: 'Restablecer tu clave',
          texto: `Hola ${envio.nombre}:\n\nRecibimos una solicitud para restablecer la clave del usuario ${envio.login} `
            + `en la cooperativa ${envio.codigoCoop}.\n\nTu código es:\n\n${envio.token}\n\n`
            + `Vence en ${envio.vigencia} minutos y sirve una sola vez. Si no lo pediste, ignora este correo: `
            + 'tu clave actual sigue igual.',
        });
      } catch {
        await alertar({ tipo: 'RECUPERACION_SIN_CORREO', solicitudId: contexto.solicitudId,
          usuarioLogin: envio.login, motivo: 'envio_fallido' });
      }
    }
    return RESPUESTA_RECUPERACION;
  }

  // Paso 2: el codigo del correo y la clave nueva. Un codigo vencido, usado o ajeno da el
  // mismo error; el intento queda auditado.
  async function restablecerConCodigo({ cooperativa, codigo, claveNueva } = {}, contexto = {}) {
    if (typeof codigo !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codigo)) {
      throw new ErrorSolicitud('Codigo invalido o vencido');
    }
    let resultado;
    try {
      resultado = await withTenantPorCodigo(cooperativa, async tx => {
        const fila = (await tx.query(
          `SELECT r.recuperacion_id, u.usuario_id, u.login, u.activo
             FROM tecnifin.recuperaciones_clave r
             JOIN tecnifin.usuarios u ON u.cooperativa_id = r.cooperativa_id AND u.usuario_id = r.usuario_id
            WHERE r.token_hash = @hash AND r.consumida IS NULL AND r.expira > now()
            FOR UPDATE OF r`, { hash: sha256(codigo) })).rows[0];
        if (!fila || !fila.activo) {
          await auditar(tx, 'desconocido', 'RECUPERACION_INVALIDA', 'Codigo inexistente, usado o vencido.');
          return { error: new ErrorSolicitud('Codigo invalido o vencido') };
        }
        validarClaveNueva(fila.login, claveNueva);
        await tx.query(
          `UPDATE tecnifin.usuarios SET password_hash = @hash, requiere_cambio_pin = false WHERE usuario_id = @id`,
          { hash: await hashearClave(fila.login, claveNueva), id: fila.usuario_id });
        await tx.query(
          `UPDATE tecnifin.recuperaciones_clave SET consumida = now() WHERE recuperacion_id = @id`,
          { id: fila.recuperacion_id });
        await auditar(tx, fila.login, 'RECUPERACION_COMPLETADA', 'Clave restablecida con el codigo enviado por correo.');
        return { ok: true };
      }, { solicitudId: contexto.solicitudId });
    } catch (error) {
      if (error instanceof ErrorCooperativaLogin) throw new ErrorSolicitud('Codigo invalido o vencido');
      throw error;
    }
    if (resultado.error) throw resultado.error;
    return resultado;
  }

  // Diagnostico de correo para administracion: configuracion sin la clave, y un envio de prueba.
  async function estadoCorreo(token, contexto = {}) {
    return comoAdministrador(token, contexto, 'CORREO', async () =>
      correo ? correo.estado() : { configurado: false });
  }

  async function probarCorreo(token, { destino } = {}, contexto = {}) {
    return comoAdministrador(token, contexto, 'CORREO', async (tx, actor) => {
      const para = correoNormalizado(destino);
      if (!para) throw new ErrorSolicitud('Correo invalido');
      if (!correo || !correo.configurado) {
        return { error: Object.assign(new Error('El correo no esta configurado'), { statusCode: 503 }) };
      }
      try {
        await correo.enviar({ para, asunto: 'Prueba de correo',
          texto: `Este es un correo de prueba enviado por ${actor.login}. Si lo recibes, el envio funciona.` });
      } catch (error) {
        await auditar(tx, actor.login, 'PRUEBA_CORREO_FALLIDA', `Destino ${para}; codigo ${error.codigo || 'desconocido'}.`);
        return { error };
      }
      await auditar(tx, actor.login, 'PRUEBA_CORREO', `Correo de prueba enviado a ${para}.`);
      return { enviado: true, destino: para };
    });
  }

  return {
    login, listarUsuarios, leerConfiguracion, salud, perfil, cambiarClave,
    crearUsuario, actualizarUsuario, restablecerClave,
    olvideClave, restablecerConCodigo, estadoCorreo, probarCorreo,
  };
}
