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

// Rutas de M2 (caja y ventanilla).
async function rutasCaja(caja, req, res, url, contexto) {
  const { solicitudId } = contexto;
  const p = url.pathname;
  if (p === '/api/caja' && req.method === 'GET') {
    return responder(res, 200, await caja.estadoCaja(tokenBearer(req), contexto), solicitudId);
  }
  if (req.method !== 'POST') return undefined;
  const token = tokenBearer(req);
  if (p === '/api/caja/apertura') return responder(res, 201, await caja.abrirCaja(token, await leerJson(req), contexto), solicitudId);
  if (p === '/api/caja/cierre') return responder(res, 200, await caja.cerrarCaja(token, await leerJson(req), contexto), solicitudId);
  if (p === '/api/caja/transacciones') {
    return responder(res, 201, await caja.registrarTransaccion(token, await leerJson(req), contexto), solicitudId);
  }
  const anular = /^\/api\/caja\/transacciones\/([0-9]{1,15})\/anular$/.exec(p);
  if (anular) {
    return responder(res, 200, await caja.anularTransaccion(token, anular[1], await leerJson(req), contexto), solicitudId);
  }
  return undefined;
}

// Rutas de M3 (creditos).
async function rutasCreditos(creditos, req, res, url, contexto) {
  const { solicitudId } = contexto;
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/creditos/lineas') {
    return responder(res, 200, await creditos.lineasCredito(tokenBearer(req), contexto), solicitudId);
  }
  if (req.method === 'POST' && p === '/api/creditos/simulacion') {
    const token = tokenBearer(req);
    return responder(res, 200, await creditos.simular(token, await leerJson(req), contexto), solicitudId);
  }
  if (req.method === 'POST' && p === '/api/creditos/solicitudes') {
    const token = tokenBearer(req);
    return responder(res, 201, await creditos.crearSolicitud(token, await leerJson(req), contexto), solicitudId);
  }
  const sol = /^\/api\/creditos\/solicitudes\/(SOL-[0-9]{6,12})(?:\/(decision|desembolso))?$/i.exec(p);
  if (sol) {
    const [, codigo, accion] = sol;
    if (!accion && req.method === 'GET') {
      return responder(res, 200, await creditos.verSolicitud(tokenBearer(req), codigo, contexto), solicitudId);
    }
    if (accion && req.method === 'POST') {
      const token = tokenBearer(req);
      const cuerpo = await leerJson(req);
      return accion.toLowerCase() === 'decision'
        ? responder(res, 200, await creditos.decidir(token, codigo, cuerpo, contexto), solicitudId)
        : responder(res, 201, await creditos.desembolsar(token, codigo, cuerpo, contexto), solicitudId);
    }
    return undefined;
  }
  const cred = /^\/api\/creditos\/(CRED-[0-9]{6,12})(\/pagos|\/cancelacion)?$/i.exec(p);
  if (cred && !cred[2] && req.method === 'GET') {
    return responder(res, 200, await creditos.verCredito(tokenBearer(req), cred[1], contexto), solicitudId);
  }
  if (cred && cred[2] === '/cancelacion' && req.method === 'GET') {
    return responder(res, 200, await creditos.liquidacionCancelacion(tokenBearer(req), cred[1], contexto), solicitudId);
  }
  if (cred && cred[2] && req.method === 'POST') {
    const token = tokenBearer(req);
    const cuerpo = await leerJson(req);
    return cred[2] === '/pagos'
      ? responder(res, 201, await creditos.pagarCuotas(token, cred[1], cuerpo, contexto), solicitudId)
      : responder(res, 201, await creditos.cancelarAnticipado(token, cred[1], cuerpo, contexto), solicitudId);
  }
  const anular = /^\/api\/creditos\/pagos\/([0-9]{1,15})\/anular$/.exec(p);
  if (anular && req.method === 'POST') {
    const token = tokenBearer(req);
    return responder(res, 200, await creditos.anularPago(token, anular[1], await leerJson(req), contexto), solicitudId);
  }
  return undefined;
}

// Rutas de M4 (plazo fijo).
async function rutasPlazoFijo(dpf, req, res, url, contexto) {
  const { solicitudId } = contexto;
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/dpf/tramos') return responder(res, 200, await dpf.tramos(tokenBearer(req), contexto), solicitudId);
  if (req.method === 'POST' && p === '/api/dpf/intereses/pagos') {
    return responder(res, 200, await dpf.pagarIntereses(tokenBearer(req), contexto), solicitudId);
  }
  if (req.method === 'POST' && (p === '/api/dpf/simulacion' || p === '/api/dpf')) {
    const token = tokenBearer(req);
    const cuerpo = await leerJson(req);
    return p === '/api/dpf'
      ? responder(res, 201, await dpf.abrir(token, cuerpo, contexto), solicitudId)
      : responder(res, 200, await dpf.simular(token, cuerpo, contexto), solicitudId);
  }
  const m = /^\/api\/dpf\/(DPF-[0-9]{6}-[0-9]{4,8})(?:\/(liquidar|cancelar|renovar))?$/i.exec(p);
  if (!m) return undefined;
  const [, codigo, accion] = m;
  if (!accion && req.method === 'GET') return responder(res, 200, await dpf.ver(tokenBearer(req), codigo, contexto), solicitudId);
  if (accion && req.method === 'POST') {
    const token = tokenBearer(req);
    const cuerpo = await leerJson(req);
    if (accion === 'liquidar') return responder(res, 200, await dpf.liquidar(token, codigo, contexto), solicitudId);
    if (accion === 'cancelar') return responder(res, 200, await dpf.cancelar(token, codigo, cuerpo, contexto), solicitudId);
    return responder(res, 201, await dpf.renovar(token, codigo, cuerpo, contexto), solicitudId);
  }
  return undefined;
}

// Rutas de M6 (proceso de cartera SEPS).
async function rutasCartera(cartera, req, res, url, contexto) {
  const { solicitudId } = contexto;
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/cartera/clasificacion') {
    return responder(res, 200, await cartera.consultar(tokenBearer(req), url.searchParams.get('fecha'), contexto), solicitudId);
  }
  if (req.method === 'POST' && p === '/api/cartera/procesos') {
    const token = tokenBearer(req);
    const cuerpo = await leerJson(req);
    return responder(res, cuerpo.aplicar === true ? 201 : 200, await cartera.procesar(token, cuerpo, contexto), solicitudId);
  }
  const castigo = /^\/api\/cartera\/castigos\/(CRED-[0-9]{6,12})(\/recuperacion)?$/i.exec(p);
  if (castigo && req.method === 'POST') {
    const token = tokenBearer(req);
    const cuerpo = await leerJson(req);
    return castigo[2]
      ? responder(res, 201, await cartera.recuperar(token, castigo[1], cuerpo, contexto), solicitudId)
      : responder(res, 201, await cartera.castigar(token, castigo[1], cuerpo, contexto), solicitudId);
  }
  const rev = /^\/api\/cartera\/procesos\/([0-9]{1,15})\/reversar$/.exec(p);
  if (rev && req.method === 'POST') {
    const token = tokenBearer(req);
    return responder(res, 200, await cartera.reversar(token, rev[1], await leerJson(req), contexto), solicitudId);
  }
  return undefined;
}

// Rutas de M5 (contabilidad).
async function rutasContabilidad(conta, req, res, url, contexto) {
  const { solicitudId } = contexto;
  const p = url.pathname;
  const q = (k) => url.searchParams.get(k);
  if (req.method === 'GET' && p === '/api/contabilidad/libro-diario') {
    return responder(res, 200, await conta.libroDiario(tokenBearer(req), { desde: q('desde'), hasta: q('hasta'), pagina: q('pagina') }, contexto), solicitudId);
  }
  if (req.method === 'GET' && p === '/api/contabilidad/balance') {
    return responder(res, 200, await conta.balanceComprobacion(tokenBearer(req), { hasta: q('hasta') }, contexto), solicitudId);
  }
  const mayor = /^\/api\/contabilidad\/mayor\/([0-9]{1,12})$/.exec(p);
  if (mayor && req.method === 'GET') {
    return responder(res, 200, await conta.mayor(tokenBearer(req), mayor[1], { desde: q('desde'), hasta: q('hasta') }, contexto), solicitudId);
  }
  if (req.method === 'POST' && p === '/api/contabilidad/asientos') {
    const token = tokenBearer(req);
    return responder(res, 201, await conta.asientoManual(token, await leerJson(req), contexto), solicitudId);
  }
  const cierre = /^\/api\/contabilidad\/periodos\/([0-9]{4})\/([0-9]{1,2})\/cerrar$/.exec(p);
  if (cierre && req.method === 'POST') {
    return responder(res, 200, await conta.cerrarPeriodo(tokenBearer(req), cierre[1], cierre[2], contexto), solicitudId);
  }
  return undefined;
}

// Rutas de M7 (reportes SEPS). El balance de comprobacion es /api/contabilidad/balance (M5).
async function rutasReportes(reportes, req, res, url, contexto) {
  const m = /^\/api\/reportes\/(esf|perlas|b11|uaf|situacion-general|solvencia)$/.exec(url.pathname);
  if (!m || req.method !== 'GET') return undefined;
  const token = tokenBearer(req);
  const fecha = url.searchParams.get('fecha');
  const r = {
    esf: () => reportes.esf(token, fecha, contexto),
    perlas: () => reportes.perlas(token, fecha, contexto),
    b11: () => reportes.b11(token, fecha, contexto),
    uaf: () => reportes.uaf(token, url.searchParams.get('periodo'), contexto),
    'situacion-general': () => reportes.situacionGeneral(token, contexto),
    solvencia: () => reportes.solvencia(token, fecha, contexto),
  }[m[1]];
  return responder(res, 200, await r(), contexto.solicitudId);
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
      if (modulos.reportes && /^\/api\/reportes(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasReportes(modulos.reportes, req, res, url, contexto);
        if (respuesta !== undefined) return respuesta;
      }
      if (modulos.contabilidad && /^\/api\/contabilidad(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasContabilidad(modulos.contabilidad, req, res, url, contexto);
        if (respuesta !== undefined) return respuesta;
      }
      if (modulos.cartera && /^\/api\/cartera(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasCartera(modulos.cartera, req, res, url, contexto);
        if (respuesta !== undefined) return respuesta;
      }
      if (modulos.plazoFijo && /^\/api\/dpf(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasPlazoFijo(modulos.plazoFijo, req, res, url, contexto);
        if (respuesta !== undefined) return respuesta;
      }
      if (modulos.creditos && /^\/api\/creditos(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasCreditos(modulos.creditos, req, res, url, contexto);
        if (respuesta !== undefined) return respuesta;
      }
      if (modulos.caja && /^\/api\/caja(\/|$)/.test(url.pathname)) {
        const respuesta = await rutasCaja(modulos.caja, req, res, url, contexto);
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

