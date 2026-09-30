// M4 · depositos a plazo fijo (patron 07), sobre los patrones 04 y 05.
//
// Lo que se corrige del sistema anterior:
//  * abrir un DPF DEBITA de verdad la cuenta de ahorros del socio (antes solo se contabilizaba
//    y el dinero quedaba en dos lugares);
//  * liquidar, cancelar y renovar ACREDITAN la cuenta de ahorros y contabilizan contra codigos
//    del Catalogo Unico (antes: codigos con puntos que ya no existen);
//  * la penalizacion por cancelacion anticipada reduce el interes pagado; no es una linea
//    aparte que descuadraba el asiento;
//  * retencion, base de dias y cuentas son datos de la cooperativa, no constantes.
//
// Todo el calculo de dinero en numeric: round(capital * tasa/100 * dias / base, 2).
import {
  auditarProceso, crearAutenticador, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar, HOY } from '../../platform/contabilidad.js';
import { montoValido } from '../caja/servicio.js';
import { crearPagoIntereses, DIAS_PERIODO, pagadoDe } from './intereses.js';

const ROLES_OPERACION = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'TELLER']);
const ROLES_SUPERVISOR = new Set(['SUPER_USER', 'ADMIN', 'MANAGER']);
const RENOVACION = new Set(['NO_RENOVAR', 'AUTOMATICO', 'MANUAL']);
const MODALIDADES = new Set(['AL_VENCIMIENTO', ...Object.keys(DIAS_PERIODO)]);
// Parametros por cooperativa y su valor por defecto (el del sistema anterior). La retencion
// y la base de dias deben validarlas el contador y la norma tributaria vigente.
const PARAMETROS = {
  'dpf.retencion_pct': '2',
  'dpf.base_dias': '365',
  'dpf.cuenta_gasto_interes': '410130',
  'dpf.cuenta_retencion': '250405',
};

const plazoDias = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new ErrorSolicitud('plazoDias debe ser un entero de 1 a 3650');
  return n;
};
const codigoDpf = (valor) => {
  const c = String(valor || '').toUpperCase();
  if (!/^DPF-[0-9]{6}-[0-9]{4,8}$/.test(c)) throw new ErrorSolicitud('Codigo de deposito invalido');
  return c;
};

async function parametros(tx) {
  const filas = (await tx.query(
    `SELECT clave, valor FROM tecnifin.parametros_cooperativa WHERE clave = ANY(@claves::text[])`,
    { claves: Object.keys(PARAMETROS) })).rows;
  const p = { ...PARAMETROS };
  for (const f of filas) p[f.clave] = f.valor;
  return p;
}

// Tramo vigente que admite el plazo y el monto.
async function tramo(tx, monto, dias) {
  const t = (await tx.query(
    `SELECT tasa_id, codigo_rango, descripcion_rango, tasa_nominal_anual::text AS tasa, cuenta_contable_dpf,
            porcentaje_penalizacion::text AS penalizacion, monto_minimo, monto_maximo,
            @monto::numeric >= monto_minimo AND (monto_maximo IS NULL OR @monto::numeric <= monto_maximo) AS monto_ok
       FROM tecnifin.tasas_plazo_fijo
      WHERE activo AND fecha_vigencia <= ${HOY} AND @dias BETWEEN dias_desde AND dias_hasta
      ORDER BY fecha_vigencia DESC LIMIT 1`, { monto, dias })).rows[0];
  if (!t) throw new ErrorSolicitud(`No hay un tramo vigente para ${dias} dias`);
  if (!t.monto_ok) {
    throw new ErrorSolicitud(`Monto fuera del tramo ${t.codigo_rango}: minimo ${t.monto_minimo}${t.monto_maximo ? `, maximo ${t.monto_maximo}` : ''}`);
  }
  return t;
}

// Interes, retencion y neto en numeric. penalizacionPct reduce el interes (cancelacion).
async function intereses(tx, { capital, tasa, dias, base, retencionPct, penalizacionPct = '0' }) {
  return (await tx.query(
    `WITH i AS (SELECT round(@capital::numeric * @tasa::numeric / 100 * @dias / @base::numeric
                             * (1 - @pen::numeric / 100), 2) AS interes)
     SELECT interes::text AS interes, round(interes * @ret::numeric / 100, 2)::text AS retencion,
            (interes - round(interes * @ret::numeric / 100, 2))::text AS neto FROM i`,
    { capital, tasa, dias, base, ret: retencionPct, pen: penalizacionPct })).rows[0];
}

export function crearServicioPlazoFijo({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });
  const operar = (token, ctx, concepto, op) => conRoles(token, ctx, ROLES_OPERACION, concepto, op);

  async function tramos(token, contexto = {}) {
    return operar(token, contexto, 'CONSULTA_DPF', async tx => (await tx.query(
      `SELECT codigo_rango AS codigo, descripcion_rango AS descripcion, dias_desde AS "diasDesde", dias_hasta AS "diasHasta",
              tasa_nominal_anual::text AS tasa, monto_minimo::text AS "montoMinimo", monto_maximo::text AS "montoMaximo"
         FROM tecnifin.tasas_plazo_fijo WHERE activo AND fecha_vigencia <= ${HOY} ORDER BY dias_desde`)).rows);
  }

  async function simular(token, { monto, plazoDias: dias } = {}, contexto = {}) {
    const m = montoValido(monto);
    const d = plazoDias(dias);
    return operar(token, contexto, 'SIMULACION_DPF', async tx => {
      const t = await tramo(tx, m, d);
      const p = await parametros(tx);
      const i = await intereses(tx, { capital: m, tasa: t.tasa, dias: d, base: p['dpf.base_dias'], retencionPct: p['dpf.retencion_pct'] });
      const vence = (await tx.query(`SELECT (${HOY} + @d::int)::text AS v`, { d })).rows[0].v;
      return { tramo: t.codigo_rango, tasa: t.tasa, plazoDias: d, capital: (await tx.query(`SELECT @m::numeric(18,2)::text AS m`, { m })).rows[0].m,
        interes: i.interes, retencion: i.retencion, interesNeto: i.neto, fechaVencimiento: vence };
    });
  }

  // Apertura: el dinero sale de la cuenta de ahorros del socio (debito real) y pasa al
  // pasivo de depositos a plazo de la banda del tramo (2103xx).
  async function abrir(token, entrada = {}, contexto = {}, txExterna = null) {
    const m = montoValido(entrada.monto);
    const d = plazoDias(entrada.plazoDias);
    const nCuenta = Number(entrada.numeroCuenta);
    if (!Number.isSafeInteger(nCuenta) || nCuenta < 1) throw new ErrorSolicitud('numeroCuenta invalido');
    const renovacion = String(entrada.tipoRenovacion || 'NO_RENOVAR').toUpperCase();
    if (!RENOVACION.has(renovacion)) throw new ErrorSolicitud('tipoRenovacion invalido');
    const modalidad = String(entrada.modalidadPago || 'AL_VENCIMIENTO').toUpperCase();
    if (!MODALIDADES.has(modalidad)) throw new ErrorSolicitud('modalidadPago: AL_VENCIMIENTO, MENSUAL o TRIMESTRAL');
    if (DIAS_PERIODO[modalidad] && d <= DIAS_PERIODO[modalidad]) {
      throw new ErrorSolicitud(`Pago ${modalidad.toLowerCase()} exige un plazo mayor a ${DIAS_PERIODO[modalidad]} dias`);
    }
    const observaciones = entrada.observaciones ? String(entrada.observaciones).slice(0, 500) : null;

    const trabajo = async (tx, actor) => {
      const cuenta = (await tx.query(
        `SELECT c.cuenta_id, c.socio_id, c.estado, c.numero_cuenta, p.es_certificado, p.permite_debitos, p.cuenta_activa,
                s.identificacion, s.estado AS estado_socio, s.numero_socio,
                concat_ws(' ', s.primer_nombre, s.segundo_nombre, s.primer_apellido, s.segundo_apellido) AS nombre
           FROM tecnifin.cuentas c
           JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
           JOIN tecnifin.socios s ON s.cooperativa_id = c.cooperativa_id AND s.socio_id = c.socio_id
          WHERE c.numero_cuenta = @n FOR UPDATE OF c`, { n: nCuenta })).rows[0];
      if (!cuenta) return { error: new ErrorNoEncontrado() };
      if (cuenta.estado_socio !== 'ACTIVO') throw new ErrorConflicto(`El socio esta ${cuenta.estado_socio}`);
      if (cuenta.estado !== 'ACTIVA' || cuenta.es_certificado || !cuenta.permite_debitos) {
        throw new ErrorConflicto('Los fondos deben salir de una cuenta de ahorro activa que admita debitos');
      }
      const t = await tramo(tx, m, d);
      const p = await parametros(tx);
      const i = await intereses(tx, { capital: m, tasa: t.tasa, dias: d, base: p['dpf.base_dias'], retencionPct: p['dpf.retencion_pct'] });

      const saldo = (await tx.query(
        `UPDATE tecnifin.cuentas SET saldo = saldo - @m::numeric WHERE cuenta_id = @id AND saldo - @m::numeric >= 0
         RETURNING saldo::text AS saldo`, { m, id: cuenta.cuenta_id })).rows[0];
      if (!saldo) throw new ErrorConflicto('Saldo insuficiente en la cuenta de ahorros');

      const dpf = (await tx.query(
        `WITH n AS (SELECT 'DPF-' || to_char(${HOY}, 'YYYYMM') || '-'
                           || lpad(tecnifin.siguiente_numero('dpf_' || to_char(${HOY}, 'YYYYMM'))::text, 4, '0') AS codigo)
         INSERT INTO tecnifin.depositos_plazo
           (codigo, num_certificado, socio_id, identificacion, nombre_socio, tasa_id, tasa_nominal_anual, plazo_dias,
            monto_capital, interes_proyectado, retencion_proyectada, interes_neto_proyectado, fecha_apertura,
            fecha_vencimiento, tipo_renovacion, modalidad_pago, cuenta_ahorros_id, cuenta_contable_dpf, usuario_apertura_id, observaciones,
            numero_renovacion, deposito_origen_id)
         SELECT n.codigo, n.codigo, @socio, @ident, @nombre, @tasaId, @tasa::numeric, @dias, @m::numeric,
                @interes::numeric, @ret::numeric, @neto::numeric, ${HOY}, ${HOY} + @dias::int, @renov, @modalidad, @cuenta, @ctaDpf,
                @usuario, @obs, @numRenov, @origen
           FROM n
         RETURNING deposito_id, codigo, fecha_vencimiento::text AS vence`,
        { socio: cuenta.socio_id, ident: cuenta.identificacion, nombre: cuenta.nombre.slice(0, 200), tasaId: t.tasa_id,
          tasa: t.tasa, dias: d, m, interes: i.interes, ret: i.retencion, neto: i.neto, renov: renovacion, modalidad,
          cuenta: cuenta.cuenta_id, ctaDpf: t.cuenta_contable_dpf, usuario: actor.usuario_id, obs: observaciones,
          numRenov: entrada.numeroRenovacion || 0, origen: entrada.depositoOrigenId || null })).rows[0];

      const glosa = `Apertura del deposito a plazo ${dpf.codigo}, ${d} dias`;
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'PLAZO_FIJO', origenId: dpf.codigo,
        tipoDocumento: 'APERTURA_DPF', lineas: [
          { codigo: cuenta.cuenta_activa, tipo: 'D', valor: m, socioId: cuenta.socio_id },
          { codigo: t.cuenta_contable_dpf, tipo: 'H', valor: m, socioId: cuenta.socio_id },
        ] });
      await tx.query(`UPDATE tecnifin.depositos_plazo SET asiento_apertura_id = @a WHERE deposito_id = @id`,
        { a: asiento, id: dpf.deposito_id });
      await tx.query(
        `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
         VALUES (@c, 'TRANSFERENCIA_SALIDA', @m::numeric, @s::numeric, @g, @u, @a)`,
        { c: cuenta.cuenta_id, m, s: saldo.saldo, g: glosa, u: actor.usuario_id, a: asiento });
      await auditarProceso(tx, actor, { proceso: 'PLAZO_FIJO', accion: 'ABRIR', entidadTipo: 'DPF', entidadId: dpf.codigo,
        nuevo: m, detalle: `${t.codigo_rango} al ${t.tasa} %, cuenta ${cuenta.numero_cuenta}.` });
      return { codigo: dpf.codigo, numeroSocio: Number(cuenta.numero_socio), capital: (await tx.query(
        `SELECT @m::numeric(18,2)::text AS m`, { m })).rows[0].m, tramo: t.codigo_rango, tasa: t.tasa, plazoDias: d, modalidadPago: modalidad,
        interesProyectado: i.interes, retencionProyectada: i.retencion, interesNetoProyectado: i.neto,
        fechaVencimiento: dpf.vence, saldoCuenta: saldo.saldo };
    };
    if (txExterna) return trabajo(txExterna.tx, txExterna.actor);
    return operar(token, contexto, 'APERTURA_DPF', trabajo);
  }

  async function depositoBloqueado(tx, codigo) {
    return (await tx.query(
      `SELECT d.*, d.monto_capital::text AS capital, d.tasa_nominal_anual::text AS tasa,
              d.fecha_vencimiento <= ${HOY} AS vencido, d.fecha_vencimiento::text AS vence_texto, (${HOY} - d.fecha_apertura) AS dias_transcurridos,
              t.porcentaje_penalizacion::text AS penalizacion, c.numero_cuenta,
              (SELECT pf.cuenta_activa FROM tecnifin.productos_financieros pf
                WHERE pf.cooperativa_id = c.cooperativa_id AND pf.producto_id = c.producto_id) AS cuenta_activa
         FROM tecnifin.depositos_plazo d
         JOIN tecnifin.tasas_plazo_fijo t ON t.cooperativa_id = d.cooperativa_id AND t.tasa_id = d.tasa_id
         JOIN tecnifin.cuentas c ON c.cooperativa_id = d.cooperativa_id AND c.cuenta_id = d.cuenta_ahorros_id
        WHERE d.codigo = @c FOR UPDATE OF d, c`, { c: codigo })).rows[0] || null;
  }

  // Cierre comun a liquidar, cancelar y renovar: acredita capital + interes neto a la cuenta
  // de ahorros de origen y contabiliza el pasivo, el gasto por interes y la retencion.
  // Con pago periodico se descuenta lo ya pagado: se liquida solo el resto del interes total.
  // Si la penalizacion deja el interes total por debajo de lo ya pagado, el resto es 0 y lo
  // pagado no se recupera del capital (decision a validar con el contador).
  async function cerrar(tx, actor, d, { estado, dias, penalizacionPct = '0', motivo = null, accion }) {
    const p = await parametros(tx);
    const totalPlazo = await intereses(tx, { capital: d.capital, tasa: d.tasa, dias, base: p['dpf.base_dias'],
      retencionPct: p['dpf.retencion_pct'], penalizacionPct });
    const ya = await pagadoDe(tx, d.deposito_id);
    const i = (await tx.query(
      `WITH x AS (SELECT CASE WHEN @i::numeric > @pi::numeric THEN @i::numeric - @pi::numeric ELSE 0 END AS interes,
                         CASE WHEN @i::numeric > @pi::numeric THEN greatest(@r::numeric - @pr::numeric, 0) ELSE 0 END AS retencion)
       SELECT interes::numeric(18,2)::text AS interes, retencion::numeric(18,2)::text AS retencion,
              (interes - retencion)::numeric(18,2)::text AS neto FROM x`,
      { i: totalPlazo.interes, r: totalPlazo.retencion, pi: ya.interes, pr: ya.retencion })).rows[0];
    const total = (await tx.query(`SELECT (@c::numeric + @n::numeric)::text AS t`, { c: d.capital, n: i.neto })).rows[0].t;
    const saldo = (await tx.query(
      `UPDATE tecnifin.cuentas SET saldo = saldo + @t::numeric WHERE cuenta_id = @id RETURNING saldo::text AS saldo`,
      { t: total, id: d.cuenta_ahorros_id })).rows[0].saldo;
    const penalizacion = (await tx.query(
      `SELECT (round(@c::numeric * @tasa::numeric / 100 * @dias / @base::numeric, 2) - @pi::numeric - @i::numeric)::text AS p`,
      { c: d.capital, tasa: d.tasa, dias, base: p['dpf.base_dias'], pi: ya.interes, i: i.interes })).rows[0].p;
    const glosa = `${accion === 'CANCELAR' ? 'Cancelacion anticipada' : accion === 'RENOVAR' ? 'Renovacion' : 'Liquidacion'} del deposito ${d.codigo}`;
    const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'PLAZO_FIJO', origenId: d.codigo,
      tipoDocumento: `${accion}_DPF`, lineas: [
        { codigo: d.cuenta_contable_dpf, tipo: 'D', valor: d.capital, socioId: d.socio_id },
        { codigo: p['dpf.cuenta_gasto_interes'], tipo: 'D', valor: i.interes, socioId: d.socio_id },
        { codigo: d.cuenta_activa, tipo: 'H', valor: total, socioId: d.socio_id },
        { codigo: p['dpf.cuenta_retencion'], tipo: 'H', valor: i.retencion, socioId: d.socio_id },
      ] });
    await tx.query(
      `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
       VALUES (@c, 'TRANSFERENCIA_ENTRADA', @t::numeric, @s::numeric, @g, @u, @a)`,
      { c: d.cuenta_ahorros_id, t: total, s: saldo, g: glosa, u: actor.usuario_id, a: asiento });
    await tx.query(
      `UPDATE tecnifin.depositos_plazo
          SET estado = @estado, fecha_liquidacion = ${HOY}, interes_liquidado = @i::numeric, retencion_aplicada = @r::numeric,
              interes_neto_liquidado = @n::numeric, penalizacion_aplicada = @pen::numeric, motivos_cancelacion = @motivo,
              usuario_liquidacion_id = @u, asiento_liquidacion_id = @a, fecha_modificacion = now()
        WHERE deposito_id = @id`,
      { estado, i: i.interes, r: i.retencion, n: i.neto, pen: penalizacion, motivo, u: actor.usuario_id, a: asiento,
        id: d.deposito_id });
    await auditarProceso(tx, actor, { proceso: 'PLAZO_FIJO', accion, entidadTipo: 'DPF', entidadId: d.codigo,
      campo: 'estado', anterior: d.estado, nuevo: estado, detalle: motivo || `Acreditado ${total} a la cuenta ${d.numero_cuenta}.` });
    return { codigo: d.codigo, estado, diasReconocidos: dias, interesPagadoAntes: ya.interes, interes: i.interes,
      penalizacion, retencion: i.retencion,
      interesNeto: i.neto, totalAcreditado: total, numeroCuenta: Number(d.numero_cuenta), saldoCuenta: saldo };
  }

  async function liquidar(token, codigo, contexto = {}) {
    const c = codigoDpf(codigo);
    return operar(token, contexto, 'LIQUIDACION_DPF', async (tx, actor) => {
      const d = await depositoBloqueado(tx, c);
      if (!d) return { error: new ErrorNoEncontrado() };
      if (!['ACTIVO', 'VENCIDO'].includes(d.estado)) throw new ErrorConflicto(`El deposito esta ${d.estado}`);
      if (!d.vencido) throw new ErrorConflicto(`Vence el ${d.vence_texto}: antes de esa fecha se cancela`);
      return cerrar(tx, actor, d, { estado: 'LIQUIDADO', dias: d.plazo_dias, accion: 'LIQUIDAR' });
    });
  }

  async function cancelar(token, codigo, { motivo } = {}, contexto = {}) {
    const c = codigoDpf(codigo);
    const razon = String(motivo || '').trim();
    if (razon.length < 5 || razon.length > 400) throw new ErrorSolicitud('motivo: entre 5 y 400 caracteres');
    return conRoles(token, contexto, ROLES_SUPERVISOR, 'CANCELACION_DPF', async (tx, actor) => {
      const d = await depositoBloqueado(tx, c);
      if (!d) return { error: new ErrorNoEncontrado() };
      if (d.estado !== 'ACTIVO') throw new ErrorConflicto(`El deposito esta ${d.estado}`);
      if (d.vencido) throw new ErrorConflicto('El deposito ya vencio: se liquida, no se cancela');
      return cerrar(tx, actor, d, { estado: 'CANCELADO', dias: Math.max(0, Number(d.dias_transcurridos)),
        penalizacionPct: d.penalizacion, motivo: razon, accion: 'CANCELAR' });
    });
  }

  // Renovacion: se liquida el vencido a la cuenta (interes neto incluido) y se abre uno nuevo
  // por el mismo capital con el tramo vigente de hoy, enlazado al anterior.
  async function renovar(token, codigo, { plazoDias: dias } = {}, contexto = {}) {
    const c = codigoDpf(codigo);
    return operar(token, contexto, 'RENOVACION_DPF', async (tx, actor) => {
      const d = await depositoBloqueado(tx, c);
      if (!d) return { error: new ErrorNoEncontrado() };
      if (!['ACTIVO', 'VENCIDO'].includes(d.estado)) throw new ErrorConflicto(`El deposito esta ${d.estado}`);
      if (!d.vencido) throw new ErrorConflicto('Solo se renueva un deposito vencido');
      const cierre = await cerrar(tx, actor, d, { estado: 'RENOVADO', dias: d.plazo_dias, accion: 'RENOVAR' });
      const nuevo = await abrir(null, { monto: d.capital, plazoDias: dias ?? d.plazo_dias, numeroCuenta: d.numero_cuenta,
        tipoRenovacion: d.tipo_renovacion, modalidadPago: d.modalidad_pago, numeroRenovacion: d.numero_renovacion + 1, depositoOrigenId: d.deposito_id,
        observaciones: `Renovacion de ${d.codigo}` }, contexto, { tx, actor });
      return { anterior: cierre, nuevo };
    });
  }

  async function ver(token, codigo, contexto = {}) {
    const c = codigoDpf(codigo);
    return operar(token, contexto, 'CONSULTA_DPF', async tx => {
      const d = (await tx.query(
        `SELECT d.codigo, d.estado, d.monto_capital::text AS capital, d.tasa_nominal_anual::text AS tasa, d.plazo_dias,
                d.interes_proyectado::text AS interes_proyectado, d.interes_neto_proyectado::text AS neto_proyectado,
                d.fecha_apertura::text AS apertura, d.fecha_vencimiento::text AS vence, d.tipo_renovacion, d.modalidad_pago,
                d.deposito_id,
                d.interes_neto_liquidado::text AS neto_liquidado, d.penalizacion_aplicada::text AS penalizacion,
                d.numero_renovacion, s.numero_socio, c.numero_cuenta
           FROM tecnifin.depositos_plazo d
           JOIN tecnifin.socios s ON s.cooperativa_id = d.cooperativa_id AND s.socio_id = d.socio_id
           LEFT JOIN tecnifin.cuentas c ON c.cooperativa_id = d.cooperativa_id AND c.cuenta_id = d.cuenta_ahorros_id
          WHERE d.codigo = @c`, { c })).rows[0];
      if (!d) return { error: new ErrorNoEncontrado() };
      const pagos = (await tx.query(
        `SELECT periodo, fecha_corte::text AS "fechaCorte", interes::text AS interes, retencion::text AS retencion,
                interes_neto::text AS "interesNeto"
           FROM tecnifin.pagos_interes_dpf WHERE deposito_id = @id ORDER BY periodo`, { id: d.deposito_id })).rows;
      return { codigo: d.codigo, estado: d.estado, modalidadPago: d.modalidad_pago, pagosInteres: pagos, numeroSocio: Number(d.numero_socio), numeroCuenta: Number(d.numero_cuenta),
        capital: d.capital, tasa: d.tasa, plazoDias: d.plazo_dias, fechaApertura: d.apertura, fechaVencimiento: d.vence,
        interesProyectado: d.interes_proyectado, interesNetoProyectado: d.neto_proyectado, tipoRenovacion: d.tipo_renovacion,
        interesNetoLiquidado: d.neto_liquidado, penalizacion: d.penalizacion, numeroRenovacion: d.numero_renovacion };
    });
  }

  const { pagarIntereses } = crearPagoIntereses({ conRoles, rolesSupervisor: ROLES_SUPERVISOR, parametros });
  return { tramos, simular, abrir: (token, entrada, ctx) => abrir(token, entrada, ctx), liquidar, cancelar, renovar, ver,
    pagarIntereses };
}
