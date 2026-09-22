import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class ErrorAutenticacion extends Error {
  constructor(message = 'No autenticado') {
    super(message);
    this.name = 'ErrorAutenticacion';
    this.statusCode = 401;
  }
}

const b64url = valor => Buffer.from(valor).toString('base64url');
const jsonB64 = valor => b64url(JSON.stringify(valor));

function configuracionJwt(env) {
  const secreto = env.TECNIFIN_JWT_SECRET;
  const emisor = env.TECNIFIN_JWT_ISSUER;
  const audiencia = env.TECNIFIN_JWT_AUDIENCE;
  if (!secreto || Buffer.byteLength(secreto) < 32) {
    throw new Error('TECNIFIN_JWT_SECRET debe tener al menos 32 bytes');
  }
  if (!emisor || !audiencia) {
    throw new Error('Configurar TECNIFIN_JWT_ISSUER y TECNIFIN_JWT_AUDIENCE');
  }
  return { secreto, emisor, audiencia };
}

function leerJson(parte) {
  try { return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')); }
  catch { throw new ErrorAutenticacion(); }
}

export function crearJwt(env = process.env, reloj = () => Date.now()) {
  const { secreto, emisor, audiencia } = configuracionJwt(env);
  const firmar = contenido => createHmac('sha256', secreto).update(contenido).digest();

  return {
    emitir({ usuarioId, cooperativaId, rol, login, vidaSegundos }) {
      if (!/^\d+$/.test(String(usuarioId)) || !Number.isInteger(cooperativaId)
          || cooperativaId < 1 || !rol || !login) {
        throw new TypeError('Identidad incompleta para emitir JWT');
      }
      if (!Number.isSafeInteger(vidaSegundos) || vidaSegundos < 1) {
        throw new TypeError('auth.jwt_vida_segundos debe ser un entero positivo');
      }
      const ahora = Math.floor(reloj() / 1000);
      const cabecera = jsonB64({ alg: 'HS256', typ: 'JWT' });
      const cuerpo = jsonB64({
        iss: emisor, aud: audiencia, sub: String(usuarioId), coop: cooperativaId,
        rol, login, iat: ahora, exp: ahora + vidaSegundos, jti: randomUUID(),
      });
      const contenido = `${cabecera}.${cuerpo}`;
      return `${contenido}.${firmar(contenido).toString('base64url')}`;
    },

    verificar(token) {
      const partes = String(token || '').split('.');
      if (partes.length !== 3 || partes.some(parte => !parte)) throw new ErrorAutenticacion();
      const [cabeceraB64, cuerpoB64, firmaB64] = partes;
      const cabecera = leerJson(cabeceraB64);
      if (cabecera.alg !== 'HS256' || cabecera.typ !== 'JWT') throw new ErrorAutenticacion();

      let recibida;
      try { recibida = Buffer.from(firmaB64, 'base64url'); }
      catch { throw new ErrorAutenticacion(); }
      const esperada = firmar(`${cabeceraB64}.${cuerpoB64}`);
      if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) {
        throw new ErrorAutenticacion();
      }

      const claims = leerJson(cuerpoB64);
      const ahora = Math.floor(reloj() / 1000);
      if (claims.iss !== emisor || claims.aud !== audiencia
          || !/^\d+$/.test(String(claims.sub))
          || !Number.isInteger(claims.coop) || claims.coop < 1
          || typeof claims.rol !== 'string' || typeof claims.login !== 'string'
          || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
          || claims.iat > ahora || claims.exp <= ahora
          || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > ahora))) {
        throw new ErrorAutenticacion();
      }
      return claims;
    },
  };
}

