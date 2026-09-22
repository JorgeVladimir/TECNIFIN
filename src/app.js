import { randomUUID } from 'node:crypto';

const MAX_CUERPO = 16 * 1024;

function responder(res, estado, cuerpo, solicitudId) {
  const datos = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(datos),
    'x-request-id': solicitudId,
    'cache-control': 'no-store',
  });
  res.end(datos);
}

async function leerJson(req) {
  let total = 0;
  const partes = [];
  for await (const parte of req) {
    total += parte.length;
    if (total > MAX_CUERPO) throw Object.assign(new Error('Cuerpo demasiado grande'), { statusCode: 413 });
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

export function crearAplicacion(servicio) {
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
      if (req.method === 'GET' && url.pathname === '/api/usuarios') {
        return responder(res, 200, await servicio.listarUsuarios(tokenBearer(req), contexto), solicitudId);
      }
      if (req.method === 'GET' && url.pathname === '/api/configuracion') {
        return responder(res, 200, await servicio.leerConfiguracion(tokenBearer(req), contexto), solicitudId);
      }
      return responder(res, 404, { error: 'Ruta no encontrada' }, solicitudId);
    } catch (error) {
      const estado = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      const mensaje = estado >= 500 && estado !== 503 ? 'Error interno' : error.message;
      return responder(res, estado, { error: mensaje }, solicitudId);
    }
  };
}

