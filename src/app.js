import { randomUUID } from 'node:crypto';

const MAX_CUERPO = 16 * 1024;
// Solo las rutas que suben imagenes (mapa y croquis del socio) aceptan mas.
const MAX_CUERPO_IMAGEN = 1536 * 1024;

function responder(res, estado, cuerpo, solicitudId) {
  const datos = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(datos),
    'x-request-id': solicitudId,
    'cache-control': 'no-store',
  });
  res.end(datos);
  // true: la ruta ya respondio (los enrutadores de modulo devuelven undefined si no es suya).
  return true;
}

async function leerJson(req, maximo = MAX_CUERPO) {
  let total = 0;
  const partes = [];
  for await (const parte of req) {
    total += parte.length;
    if (total > maximo) throw Object.assign(new Error('Cuerpo demasiado grande'), { statusCode: 413 });
    partes.push(parte);
  }
  try { return JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON invalido'), { statusCode: 400 }); }
}

function tokenBearer(req) {
  const coincidencia = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    String(req.headers.authorization || ''));
  if (!coincidencia) throw Object.assign(new Error('No autenticado'), { statusCode: 401 });
  return coincidencia[1];
}

// Rutas de M1 (socios y cuentas). Devuelve undefined si la ruta no es de este modulo.
async function rutasSocios(socios, req, res, url, contexto) {
  const { solicitudId } = contexto;
  if (url.pathname === '/api/socios') {
    if (req.method === 'GET') {
      return responder(res, 200, await socios.buscarSocios(tokenBearer(req), url.searchParams.get('q'), contexto), solicitudId);
    }
    if (req.method === 'POST') {
      const token = tokenBearer(req);
      return responder(res, 201, await socios.registrarSocio(token, await leerJson(req), contexto), solicitudId);
    }
  }
  // El token se valida ANTES de leer el cuerpo: nadie sin sesion hace leer 1,5 MB al servidor.
  const socio = /^\/api\/socios\/([0-9]{1,15})(?:\/(cuentas|estado|ubicacion))?$/.exec(url.pathname);
  if (socio) {
    const [, numero, sub] = socio;
    if (!sub && req.method === 'GET') {
      return responder(res, 200, await socios.fichaSocio(tokenBearer(req), numero, contexto), solicitudId);
    }
    if (!sub && req.method === 'PUT') {
      const token = tokenBearer(req);
      return responder(res, 200, await socios.actualizarSocio(token, numero, await leerJson(req), contexto), solicitudId);
    }
    if (sub === 'cuentas' && req.method === 'POST') {
      const token = tokenBearer(req);
      return responder(res, 201, await socios.abrirCuenta(token, numero, await leerJson(req), contexto), solicitudId);
    }
    if (sub === 'estado' && req.method === 'PUT') {
      const token = tokenBearer(req);
      return responder(res, 200, await socios.cambiarEstadoSocio(token, numero, await leerJson(req), contexto), solicitudId);
    }
    if (sub === 'ubicacion' && req.method === 'POST') {
      const token = tokenBearer(req);
      return responder(res, 201,
        await socios.guardarUbicacion(token, numero, await leerJson(req, MAX_CUERPO_IMAGEN), contexto), solicitudId);
    }
    return undefined;
  }
  const cuenta = /^\/api\/cuentas\/([0-9]{1,15})(\/movimientos)?$/.exec(url.pathname);
  if (cuenta && req.method === 'GET') {
    if (!cuenta[2]) return responder(res, 200, await socios.consultarCuenta(tokenBearer(req), cuenta[1], contexto), solicitudId);
    const filtros = { desde: url.searchParams.get('desde'), hasta: url.searchParams.get('hasta'),
      pagina: url.searchParams.get('pagina') };
    return responder(res, 200, await socios.movimientosCuenta(tokenBearer(req), cuenta[1], filtros, contexto), solicitudId);
  }
  return undefined;
}

export function crearAplicacion(servicio, modulos = {}) {
  if (!servicio) throw new TypeError('crearAplicacion necesita un servicio');
  return async function aplicacion(req, res) {
    const solicitudId = randomUUID();
    const contexto = { solicitudId };
    try {
      const url = new URL(req.url, 'http://tecnifin.local');
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const cuerpo = await leerJson(req);
        return responder(res, 200, await servicio.login(cuerpo, contexto), solicitudId);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return responder(res, 200, await servicio.salud(), solicitudId);
      }
      if (req.method === 'GET' && url.pathname === '/api/perfil') {
        return responder(res, 200, await servicio.perfil(tokenBearer(req), contexto), solicitudId);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/olvide-clave') {
        return responder(res, 202, await servicio.olvideClave(await leerJson(req), contexto), solicitudId);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/restablecer-con-codigo') {
        return responder(res, 200, await servicio.restablecerConCodigo(await leerJson(req), contexto), solicitudId);
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/correo') {
        return responder(res, 200, await servicio.estadoCorreo(tokenBearer(req), contexto), solicitudId);
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/correo/prueba') {
        const token = tokenBearer(req);
        return responder(res, 200, await servicio.probarCorreo(token, await leerJson(req), contexto), solicitudId);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/cambiar-clave') {
        const token = tokenBearer(req);
        return responder(res, 200, await servicio.cambiarClave(token, await leerJson(req), contexto), solicitudId);
      }
      if (url.pathname === '/api/usuarios') {
        if (req.method === 'GET') {
          return responder(res, 200, await servicio.listarUsuarios(tokenBearer(req), contexto), solicitudId);
        }
        if (req.method === 'POST') {
          const token = tokenBearer(req);
          return responder(res, 201, await servicio.crearUsuario(token, await leerJson(req), contexto), solicitudId);
        }
      }
      // El login viaja en la ruta ya validado por el servicio (loginCanonico); nunca el id interno.
      const rutaUsuario = /^\/api\/usuarios\/([^/]+)(\/restablecer-clave)?$/.exec(url.pathname);
      if (rutaUsuario) {
        let loginObjetivo;
        try { loginObjetivo = decodeURIComponent(rutaUsuario[1]); }
        catch { throw Object.assign(new Error('Ruta invalida'), { statusCode: 400 }); }
        if (!rutaUsuario[2] && req.method === 'PUT') {
          const token = tokenBearer(req);
          return responder(res, 200,
            await servicio.actualizarUsuario(token, loginObjetivo, await leerJson(req), contexto), solicitudId);
        }
        if (rutaUsuario[2] && req.method === 'POST') {
          return responder(res, 200,
            await servicio.restablecerClave(tokenBearer(req), loginObjetivo, contexto), solicitudId);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/configuracion') {
        return responder(res, 200, await servicio.leerConfiguracion(tokenBearer(req), contexto), solicitudId);
      }
      if (modulos.socios && /^\/api\/(socios|cuentas)(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasSocios(modulos.socios, req, res, url, contexto);
        if (respuesta !== undefined) return respuesta;
      }
      return responder(res, 404, { error: 'Ruta no encontrada' }, solicitudId);
    } catch (error) {
      const estado = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      // Un 500 es un defecto nuestro: se registra con el id de solicitud (el mismo de la
      // cabecera x-request-id), el tipo y el codigo; nunca el cuerpo ni el token.
      if (estado >= 500) {
        console.error(JSON.stringify({ nivel: 'ERROR', solicitudId, tipo: error?.name, codigo: error?.code,
          mensaje: error?.message, pila: error?.stack?.split('\n').slice(1, 4).map(l => l.trim()) }));
      }
      const mensaje = estado >= 500 && estado !== 503 ? 'Error interno' : error.message;
      return responder(res, estado, { error: mensaje }, solicitudId);
    }
  };
}

