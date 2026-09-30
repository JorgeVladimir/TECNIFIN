// M1 · socios y cuentas (patron 04). Todo pasa por el autenticador comun: JWT verificado,
// withTenant(claims.coop), rol por lista blanca y auditoria en la misma transaccion.
// El socio se identifica hacia afuera por su numero_socio (por cooperativa, desde 1);
// socio_id y cuenta_id son internos y no salen en las respuestas.
import { correoValido } from '../../platform/correo.js';
import { identificacionValida, TIPOS_IDENTIFICACION } from '../../platform/identificacion.js';
import {
  auditar, auditarProceso, crearAutenticador, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';

// Personal que atiende socios. MEMBER (el propio socio) entra por el canal en linea, no por aqui.
const ROLES_ATENCION = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER', 'TELLER']);
const TIPOS_PERSONA = new Set(['SOCIO', 'CLIENTE', 'CLIENTE_EXTERNO']);
const ESTADOS_CIVILES = new Set(['SOLTERO', 'CASADO', 'DIVORCIADO', 'VIUDO', 'UNION_LIBRE']);
const CON_CONYUGE = new Set(['CASADO', 'UNION_LIBRE']);

function texto(valor, campo, { max, min = 1, opcional = false } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    if (opcional) return null;
    throw new ErrorSolicitud(`Falta ${campo}`);
  }
  const limpio = String(valor).trim().replace(/\s+/g, ' ');
  if (limpio.length < min || limpio.length > max) throw new ErrorSolicitud(`${campo} debe tener entre ${min} y ${max} caracteres`);
  return limpio;
}

function telefono(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return null;
  const limpio = String(valor).replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(limpio)) throw new ErrorSolicitud(`${campo} invalido`);
  return limpio;
}

function fecha(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))) {
    throw new ErrorSolicitud(`${campo} debe tener el formato AAAA-MM-DD`);
  }
  if (new Date(`${valor}T00:00:00Z`) > new Date()) throw new ErrorSolicitud(`${campo} no puede ser futura`);
  return valor;
}

function numeroPositivo(valor, campo) {
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n < 1) throw new ErrorSolicitud(`${campo} invalido`);
  return n;
}

function lista(valor, campo, max) {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > max) throw new ErrorSolicitud(`${campo}: hasta ${max} elementos`);
  return valor;
}

// Traduce la entrada del alta a filas ya validadas. Nada llega a SQL sin pasar por aqui.
function datosAlta(entrada = {}) {
  const tipoIdentificacion = String(entrada.tipoIdentificacion || '').toUpperCase();
  if (!TIPOS_IDENTIFICACION.has(tipoIdentificacion)) throw new ErrorSolicitud('Tipo de identificacion invalido');
  const identificacion = identificacionValida(tipoIdentificacion, entrada.identificacion);
  if (!identificacion) throw new ErrorSolicitud(`${tipoIdentificacion} invalida`);
  const tipoPersona = String(entrada.tipoPersona || 'SOCIO').toUpperCase();
  if (!TIPOS_PERSONA.has(tipoPersona)) throw new ErrorSolicitud('Tipo de persona invalido');
  const estadoCivil = entrada.estadoCivil ? String(entrada.estadoCivil).toUpperCase() : null;
  if (estadoCivil && !ESTADOS_CIVILES.has(estadoCivil)) throw new ErrorSolicitud('Estado civil invalido');
  let email = null;
  if (entrada.email) {
    email = String(entrada.email).trim().toLowerCase();
    if (!correoValido(email)) throw new ErrorSolicitud('Correo invalido');
  }

  const socio = {
    tipo_persona: tipoPersona,
    tipo_identificacion: tipoIdentificacion,
    identificacion,
    primer_nombre: texto(entrada.primerNombre, 'primerNombre', { max: 50 }),
    segundo_nombre: texto(entrada.segundoNombre, 'segundoNombre', { max: 50, opcional: true }),
    primer_apellido: texto(entrada.primerApellido, 'primerApellido', { max: 50 }),
    segundo_apellido: texto(entrada.segundoApellido, 'segundoApellido', { max: 50, opcional: true }),
    solo_un_nombre: !entrada.segundoNombre,
    solo_un_apellido: !entrada.segundoApellido,
    email,
    telefono: telefono(entrada.telefono, 'telefono'),
    fecha_nacimiento: fecha(entrada.fechaNacimiento, 'fechaNacimiento'),
    estado_civil: estadoCivil,
    etnia: texto(entrada.etnia, 'etnia', { max: 20, opcional: true }),
    genero: texto(entrada.genero, 'genero', { max: 20, opcional: true }),
    nivel_instruccion: texto(entrada.nivelInstruccion, 'nivelInstruccion', { max: 50, opcional: true }),
    profesion: texto(entrada.profesion, 'profesion', { max: 100, opcional: true }),
    consentimiento_datos: entrada.consentimientoDatos === true,
  };

  const d = entrada.direccion || {};
  const campoDir = (k, max) => texto(d[k], `direccion.${k}`, { max, opcional: true });
  const direccion = {
    pais_nacimiento: campoDir('paisNacimiento', 50), provincia_nacimiento: campoDir('provinciaNacimiento', 50),
    canton_nacimiento: campoDir('cantonNacimiento', 50), parroquia_nacimiento: campoDir('parroquiaNacimiento', 50),
    pais_residencia: campoDir('paisResidencia', 50), provincia_residencia: campoDir('provinciaResidencia', 50),
    canton_residencia: campoDir('cantonResidencia', 50), parroquia_residencia: campoDir('parroquiaResidencia', 50),
    direccion_domicilio: campoDir('domicilio', 200), lugar_trabajo: campoDir('lugarTrabajo', 200),
    provincia_trabajo: campoDir('provinciaTrabajo', 50), canton_trabajo: campoDir('cantonTrabajo', 50),
    parroquia_trabajo: campoDir('parroquiaTrabajo', 50),
  };
  const hayDireccion = Object.values(direccion).some(v => v !== null);

  let conyuge = null;
  if (entrada.conyuge && CON_CONYUGE.has(estadoCivil)) {
    const c = entrada.conyuge;
    conyuge = {
      cedula_conyuge: c.cedula ? identificacionValida('CEDULA', c.cedula) : null,
      nombre_conyuge: texto(c.nombre, 'conyuge.nombre', { max: 150, opcional: true }),
      telefono_conyuge: telefono(c.telefono, 'conyuge.telefono'),
    };
    if (c.cedula && !conyuge.cedula_conyuge) throw new ErrorSolicitud('conyuge.cedula invalida');
  }

  const referencias = lista(entrada.referencias, 'referencias', 5).map((r, i) => ({
    nombre: texto(r?.nombre, `referencias[${i}].nombre`, { max: 150 }),
    telefono: telefono(r?.telefono, `referencias[${i}].telefono`),
    relacion: texto(r?.relacion, `referencias[${i}].relacion`, { max: 50, opcional: true }),
  }));
  const cargas = lista(entrada.cargas, 'cargas', 20).map((c, i) => {
    const edad = c?.edad === undefined || c?.edad === null ? null : Number(c.edad);
    if (edad !== null && (!Number.isInteger(edad) || edad < 0 || edad > 120)) {
      throw new ErrorSolicitud(`cargas[${i}].edad invalida`);
    }
    return { nombre: texto(c?.nombre, `cargas[${i}].nombre`, { max: 150 }),
      parentesco: texto(c?.parentesco, `cargas[${i}].parentesco`, { max: 50, opcional: true }), edad };
  });
  return { socio, direccion: hayDireccion ? direccion : null, conyuge, referencias, cargas };
}

const nombreCompleto = s => [s.primer_nombre, s.segundo_nombre, s.primer_apellido, s.segundo_apellido]
  .filter(Boolean).join(' ');

// INSERT con columnas fijas por codigo: los nombres de columna salen de objetos escritos
// aqui, nunca de la entrada; los valores van siempre por parametro.
async function insertar(tx, tabla, fila, extra = {}) {
  const datos = { ...fila, ...extra };
  const columnas = Object.keys(datos);
  await tx.query(
    `INSERT INTO tecnifin.${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(c => `@${c}`).join(', ')})`, datos);
}

export function crearServicioSocios({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });
  const atencion = (token, contexto, concepto, operacion) =>
    conRoles(token, contexto, ROLES_ATENCION, concepto, operacion);

  async function socioPorNumero(tx, numero) {
    const socio = (await tx.query(
      `SELECT *, fecha_nacimiento::text AS fecha_nacimiento_texto FROM tecnifin.socios WHERE numero_socio = @numero`, { numero })).rows[0];
    if (!socio) return { error: new ErrorNoEncontrado() };
    return { socio };
  }

  async function registrarSocio(token, entrada, contexto = {}) {
    return atencion(token, contexto, 'ALTA_SOCIO', async (tx, actor) => {
      const { socio, direccion, conyuge, referencias, cargas } = datosAlta(entrada);
      const existe = (await tx.query(
        `SELECT numero_socio FROM tecnifin.socios WHERE identificacion = @identificacion`,
        { identificacion: socio.identificacion })).rows[0];
      if (existe) throw new ErrorConflicto(`La identificacion ya pertenece al socio ${existe.numero_socio}`);

      const nuevo = (await tx.query(
        `INSERT INTO tecnifin.socios (${Object.keys(socio).join(', ')}, usuario_registro_id)
         VALUES (${Object.keys(socio).map(c => `@${c}`).join(', ')}, @usuario)
         RETURNING socio_id, numero_socio`, { ...socio, usuario: actor.usuario_id })).rows[0];
      const ref = { socio_id: nuevo.socio_id };
      if (direccion) await insertar(tx, 'socio_direccion', direccion, ref);
      if (conyuge) await insertar(tx, 'socio_conyuge', conyuge, ref);
      for (const r of referencias) await insertar(tx, 'socio_referencia', r, ref);
      for (const c of cargas) await insertar(tx, 'socio_carga', c, ref);

      await auditarProceso(tx, actor, { proceso: 'SOCIOS', accion: 'CREAR', entidadTipo: 'SOCIO',
        entidadId: nuevo.numero_socio, detalle: `Alta del socio ${nuevo.numero_socio} (${socio.tipo_identificacion}).` });
      return { numeroSocio: Number(nuevo.numero_socio), identificacion: socio.identificacion,
        nombre: nombreCompleto(socio), estado: 'ACTIVO' };
    });
  }

  async function buscarSocios(token, consulta, contexto = {}) {
    return atencion(token, contexto, 'CONSULTA_SOCIOS', async (tx, actor) => {
      const q = String(consulta || '').trim();
      let filas;
      if (/^[0-9]{1,13}$/.test(q)) {
        // Numero de socio exacto o identificacion por prefijo.
        filas = (await tx.query(
          `SELECT numero_socio, identificacion, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido, estado
             FROM tecnifin.socios
            WHERE numero_socio = @numero OR identificacion LIKE @prefijo
            ORDER BY numero_socio LIMIT 20`, { numero: Number(q), prefijo: `${q}%` })).rows;
      } else {
        if (q.length < 3) throw new ErrorSolicitud('Escriba al menos 3 letras del apellido o nombre');
        const patron = `%${q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
        filas = (await tx.query(
          `SELECT numero_socio, identificacion, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido, estado
             FROM tecnifin.socios
            WHERE lower(tecnifin.sin_acentos(primer_apellido || ' ' || coalesce(segundo_apellido, '') || ' '
                  || primer_nombre || ' ' || coalesce(segundo_nombre, ''))) LIKE lower(tecnifin.sin_acentos(@patron))
            ORDER BY primer_apellido, primer_nombre LIMIT 20`, { patron })).rows;
      }
      await auditar(tx, actor.login, 'CONSULTA_SOCIOS', `Busqueda de socios: ${filas.length} resultados.`);
      return filas.map(s => ({ numeroSocio: Number(s.numero_socio), identificacion: s.identificacion,
        nombre: nombreCompleto(s), estado: s.estado }));
    });
  }

  async function fichaSocio(token, numeroSocio, contexto = {}) {
    const numero = numeroPositivo(numeroSocio, 'numero de socio');
    return atencion(token, contexto, 'CONSULTA_SOCIO', async (tx, actor) => {
      const busqueda = await socioPorNumero(tx, numero);
      if (busqueda.error) return busqueda;
      const { socio } = busqueda;
      const direccion = (await tx.query(
        `SELECT * FROM tecnifin.socio_direccion WHERE socio_id = @id`, { id: socio.socio_id })).rows[0] || null;
      const cuentas = (await tx.query(
        `SELECT c.numero_cuenta, c.saldo, c.estado, c.fecha_apertura::text AS fecha_apertura, p.codigo_producto, p.nombre, p.es_certificado
           FROM tecnifin.cuentas c
           JOIN tecnifin.productos_financieros p
             ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
          WHERE c.socio_id = @id ORDER BY c.numero_cuenta`, { id: socio.socio_id })).rows;
      await auditar(tx, actor.login, 'CONSULTA_SOCIO', `Ficha del socio ${numero}.`);
      if (direccion) { delete direccion.socio_id; delete direccion.cooperativa_id; }
      return {
        numeroSocio: Number(socio.numero_socio), tipoPersona: socio.tipo_persona,
        tipoIdentificacion: socio.tipo_identificacion, identificacion: socio.identificacion,
        nombre: nombreCompleto(socio), email: socio.email, telefono: socio.telefono,
        fechaNacimiento: socio.fecha_nacimiento_texto,
        estadoCivil: socio.estado_civil, estado: socio.estado, direccion,
        // Dinero como texto con dos decimales: sin pasar por coma flotante.
        cuentas: cuentas.map(c => ({ numeroCuenta: Number(c.numero_cuenta), producto: c.nombre,
          codigoProducto: c.codigo_producto, certificado: c.es_certificado, saldo: c.saldo,
          estado: c.estado, fechaApertura: c.fecha_apertura })),
      };
    });
  }

  async function abrirCuenta(token, numeroSocio, { codigoProducto } = {}, contexto = {}) {
    const numero = numeroPositivo(numeroSocio, 'numero de socio');
    const codigo = numeroPositivo(codigoProducto, 'codigoProducto');
    return atencion(token, contexto, 'APERTURA_CUENTA', async (tx, actor) => {
      const busqueda = await socioPorNumero(tx, numero);
      if (busqueda.error) return busqueda;
      const { socio } = busqueda;
      if (socio.estado !== 'ACTIVO') throw new ErrorConflicto(`El socio esta ${socio.estado}`);
      const producto = (await tx.query(
        `SELECT producto_id, nombre, es_certificado FROM tecnifin.productos_financieros
          WHERE codigo_producto = @codigo`, { codigo })).rows[0];
      if (!producto) throw new ErrorSolicitud('Producto inexistente');
      // Un solo certificado de aportacion vigente por socio.
      if (producto.es_certificado) {
        const vigente = (await tx.query(
          `SELECT 1 FROM tecnifin.cuentas c
             JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
            WHERE c.socio_id = @socio AND p.es_certificado AND c.estado <> 'CERRADA'`, { socio: socio.socio_id })).rows[0];
        if (vigente) throw new ErrorConflicto('El socio ya tiene un certificado de aportacion vigente');
      }
      const cuenta = (await tx.query(
        `INSERT INTO tecnifin.cuentas (socio_id, producto_id) VALUES (@socio, @producto)
         RETURNING numero_cuenta, saldo, fecha_apertura::text AS fecha_apertura`, { socio: socio.socio_id, producto: producto.producto_id })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'AHORROS', accion: 'ABRIR', entidadTipo: 'CUENTA',
        entidadId: cuenta.numero_cuenta, detalle: `Cuenta ${cuenta.numero_cuenta} (${producto.nombre}) del socio ${numero}.` });
      return { numeroCuenta: Number(cuenta.numero_cuenta), producto: producto.nombre, saldo: cuenta.saldo,
        estado: 'ACTIVA', fechaApertura: cuenta.fecha_apertura };
    });
  }

  return { registrarSocio, buscarSocios, fichaSocio, abrirCuenta };
}
