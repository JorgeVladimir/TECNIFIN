// Salida de correo de la plataforma. Una sola configuracion SMTP por proceso, leida del
// entorno (TECNIFIN_SMTP_*); la clave nunca sale de este modulo: estado() la omite y los
// errores se reducen a un codigo, sin el texto del servidor que podria repetirla.
import nodemailer from 'nodemailer';

export class ErrorCorreo extends Error {
  constructor(codigo) {
    super('No se pudo enviar el correo');
    this.name = 'ErrorCorreo';
    this.statusCode = 502;
    this.codigo = codigo || 'SIN_CODIGO';
  }
}

const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const correoValido = valor => typeof valor === 'string' && valor.length <= 150 && CORREO.test(valor);

export function configuracionCorreo(env = process.env) {
  const puerto = Number(env.TECNIFIN_SMTP_PORT || 587);
  return {
    host: env.TECNIFIN_SMTP_HOST || '',
    puerto: Number.isInteger(puerto) ? puerto : 587,
    seguro: env.TECNIFIN_SMTP_SECURE === 'true' || puerto === 465,
    usuario: env.TECNIFIN_SMTP_USER || '',
    clave: env.TECNIFIN_SMTP_PASS || '',
    remitente: env.TECNIFIN_SMTP_FROM || env.TECNIFIN_SMTP_USER || '',
  };
}

// transporte se inyecta en las pruebas; en la aplicacion se crea con nodemailer.
export function crearCorreo(env = process.env, { transporte } = {}) {
  const cfg = configuracionCorreo(env);
  const configurado = Boolean(transporte || (cfg.host && cfg.usuario && cfg.clave && correoValido(cfg.remitente)));
  let canal = transporte || null;

  function obtenerCanal() {
    if (!configurado) throw new ErrorCorreo('NO_CONFIGURADO');
    canal ??= nodemailer.createTransport({
      host: cfg.host, port: cfg.puerto, secure: cfg.seguro,
      auth: { user: cfg.usuario, pass: cfg.clave },
      disableFileAccess: true, disableUrlAccess: true,
    });
    return canal;
  }

  return {
    configurado,
    estado() {
      return { configurado, host: cfg.host || null, puerto: cfg.puerto, seguro: cfg.seguro,
        remitente: cfg.remitente || null };
    },
    async enviar({ para, asunto, texto, html }) {
      if (!correoValido(para)) throw new ErrorCorreo('DESTINO_INVALIDO');
      try {
        await obtenerCanal().sendMail({ from: cfg.remitente || 'no-responder@tecnifin.local', to: para,
          subject: asunto, text: texto, html });
      } catch (error) {
        if (error instanceof ErrorCorreo) throw error;
        throw new ErrorCorreo(error?.code || error?.responseCode);
      }
    },
  };
}
