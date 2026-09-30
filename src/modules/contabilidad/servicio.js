// M5 · contabilidad (patron 09): libro diario, balance de comprobacion jerarquico, mayor,
// asiento manual y cierre de periodo. Todo se lee del mismo libro que escriben caja,
// creditos, plazo fijo y cartera: no hay una segunda fuente de verdad.
import {
  auditarProceso, crearAutenticador, ErrorConflicto, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar, HOY } from '../../platform/contabilidad.js';
import { montoValido } from '../caja/servicio.js';

const ROLES_CONTABLES = new Set(['SUPER_USER', 'ADMIN', 'MANAGER']);
// Cuentas de naturaleza acreedora: su saldo se lee Haber - Debe.
const ACREEDORAS = new Set(['PASIVO', 'PATRIMONIO', 'INGRESO']);

const fechaValida = (valor, campo) => {
  if (valor === undefined || valor === null || valor === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor) || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))) {
    throw new ErrorSolicitud(`${campo} debe tener el formato AAAA-MM-DD`);
  }
  return valor;
};

export function crearServicioContabilidad({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });
  const contable = (token, ctx, concepto, op) => conRoles(token, ctx, ROLES_CONTABLES, concepto, op);

  async function libroDiario(token, { desde, hasta, pagina } = {}, contexto = {}) {
    const d = fechaValida(desde, 'desde');
    const h = fechaValida(hasta, 'hasta');
    const n = pagina ? Number(pagina) : 1;
    if (!Number.isSafeInteger(n) || n < 1) throw new ErrorSolicitud('pagina invalida');
    return contable(token, contexto, 'LIBRO_DIARIO', async tx => {
      const filas = (await tx.query(
        `SELECT a.asiento_id, a.fecha::text AS fecha, a.concepto, a.tipo_documento, a.origen_modulo, a.origen_id, u.login,
                coalesce(jsonb_agg(jsonb_build_object('cuenta', pc.codigo, 'nombre', pc.nombre, 'tipo', d.tipo_asiento,
                                                      'valor', d.valor::text) ORDER BY d.tipo_asiento, pc.codigo)
                         FILTER (WHERE d.detalle_id IS NOT NULL), '[]') AS lineas
           FROM tecnifin.asientos_contables a
           JOIN tecnifin.usuarios u ON u.cooperativa_id = a.cooperativa_id AND u.usuario_id = a.usuario_id
           LEFT JOIN tecnifin.detalle_asiento d ON d.cooperativa_id = a.cooperativa_id AND d.asiento_id = a.asiento_id
           LEFT JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
          WHERE (@d::date IS NULL OR a.fecha >= @d::date) AND (@h::date IS NULL OR a.fecha <= @h::date)
          GROUP BY a.cooperativa_id, a.asiento_id, u.login
          ORDER BY a.asiento_id DESC LIMIT 51 OFFSET @salto`, { d, h, salto: (n - 1) * 50 })).rows;
      return { pagina: n, hayMas: filas.length > 50, asientos: filas.slice(0, 50).map(a => ({ numero: Number(a.asiento_id),
        fecha: a.fecha, concepto: a.concepto, documento: a.tipo_documento, modulo: a.origen_modulo, referencia: a.origen_id,
        usuario: a.login, lineas: a.lineas })) };
    });
  }

  // Balance de comprobacion a una fecha: cada cuenta del plan que tenga movimiento en ella o en
  // alguna de sus hijas, con el saldo agregado por prefijo (los agrupadores suman a sus hijas).
  async function balanceComprobacion(token, { hasta } = {}, contexto = {}) {
    const h = fechaValida(hasta, 'hasta');
    return contable(token, contexto, 'BALANCE_COMPROBACION', async tx => {
      const corte = (await tx.query(`SELECT coalesce(@h::date, ${HOY})::text AS f`, { h })).rows[0].f;
      const filas = (await tx.query(
        `WITH mov AS (
           SELECT pc.codigo, sum(d.valor) FILTER (WHERE d.tipo_asiento = 'D') AS debe,
                  sum(d.valor) FILTER (WHERE d.tipo_asiento = 'H') AS haber
             FROM tecnifin.detalle_asiento d
             JOIN tecnifin.asientos_contables a ON a.cooperativa_id = d.cooperativa_id AND a.asiento_id = d.asiento_id
             JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
            WHERE a.fecha <= @corte::date
            GROUP BY pc.codigo)
         SELECT p.codigo, p.nombre, p.tipo_cuenta, p.es_agrupador, length(p.codigo) AS nivel,
                coalesce(sum(m.debe), 0)::numeric(18,2)::text AS debe, coalesce(sum(m.haber), 0)::numeric(18,2)::text AS haber,
                (coalesce(sum(m.debe), 0) - coalesce(sum(m.haber), 0))::numeric(18,2)::text AS saldo_deudor
           FROM tecnifin.plan_cuentas p
           JOIN mov m ON m.codigo LIKE p.codigo || '%'
          GROUP BY p.codigo, p.nombre, p.tipo_cuenta, p.es_agrupador
          ORDER BY p.codigo`, { corte })).rows;
      const totales = (await tx.query(
        `SELECT coalesce(sum(d.valor) FILTER (WHERE d.tipo_asiento = 'D'), 0)::numeric(18,2)::text AS debe,
                coalesce(sum(d.valor) FILTER (WHERE d.tipo_asiento = 'H'), 0)::numeric(18,2)::text AS haber
           FROM tecnifin.detalle_asiento d
           JOIN tecnifin.asientos_contables a ON a.cooperativa_id = d.cooperativa_id AND a.asiento_id = d.asiento_id
          WHERE a.fecha <= @corte::date`, { corte })).rows[0];
      return {
        fechaCorte: corte, totalDebe: totales.debe, totalHaber: totales.haber, cuadrado: totales.debe === totales.haber,
        cuentas: filas.map(f => ({ codigo: f.codigo, nombre: f.nombre, tipo: f.tipo_cuenta, nivel: f.nivel,
          agrupador: f.es_agrupador, debe: f.debe, haber: f.haber,
          // Saldo segun la naturaleza de la cuenta: deudora D - H, acreedora H - D.
          saldo: ACREEDORAS.has(f.tipo_cuenta) ? negar(f.saldo_deudor) : f.saldo_deudor })),
      };
    });
  }

  async function mayor(token, codigo, { desde, hasta } = {}, contexto = {}) {
    const c = String(codigo || '');
    if (!/^[0-9]{1,12}$/.test(c)) throw new ErrorSolicitud('Codigo de cuenta invalido');
    const d = fechaValida(desde, 'desde');
    const h = fechaValida(hasta, 'hasta');
    return contable(token, contexto, 'LIBRO_MAYOR', async tx => {
      const cuenta = (await tx.query(`SELECT codigo, nombre, tipo_cuenta FROM tecnifin.plan_cuentas WHERE codigo = @c`, { c })).rows[0];
      if (!cuenta) throw new ErrorSolicitud('La cuenta no existe en el plan');
      const signo = ACREEDORAS.has(cuenta.tipo_cuenta) ? -1 : 1;
      // Saldo inicial = todo lo anterior a "desde"; luego cada linea con su saldo acumulado.
      const filas = (await tx.query(
        `WITH lineas AS (
           SELECT a.asiento_id, a.fecha, a.concepto, pc.codigo, d.tipo_asiento, d.valor,
                  CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END * @signo AS efecto
             FROM tecnifin.detalle_asiento d
             JOIN tecnifin.asientos_contables a ON a.cooperativa_id = d.cooperativa_id AND a.asiento_id = d.asiento_id
             JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
            WHERE pc.codigo LIKE @c || '%' AND (@h::date IS NULL OR a.fecha <= @h::date))
         SELECT (SELECT coalesce(sum(efecto), 0) FROM lineas WHERE @d::date IS NOT NULL AND fecha < @d::date)::numeric(18,2)::text AS inicial,
                coalesce(jsonb_agg(jsonb_build_object('asiento', asiento_id, 'fecha', fecha::text, 'concepto', concepto,
                  'cuenta', codigo, 'tipo', tipo_asiento, 'valor', valor::text) ORDER BY fecha, asiento_id)
                  FILTER (WHERE @d::date IS NULL OR fecha >= @d::date), '[]') AS movimientos
           FROM lineas`, { c, d, h, signo })).rows[0];
      // Saldo acumulado en centavos enteros.
      let saldo = aCentavos(filas.inicial);
      const movimientos = filas.movimientos.map(m => {
        saldo += (m.tipo === 'D' ? 1 : -1) * signo * aCentavos(m.valor);
        return { ...m, saldo: aTexto(saldo) };
      });
      return { cuenta: cuenta.codigo, nombre: cuenta.nombre, naturaleza: signo === 1 ? 'DEUDORA' : 'ACREEDORA',
        saldoInicial: filas.inicial, saldoFinal: aTexto(saldo), movimientos };
    });
  }

  // Asiento manual: el unico camino para contabilizar fuera de un modulo. La base exige el cuadre
  // y rechaza cuentas de agrupacion; aqui se validan formato y cuentas activas.
  async function asientoManual(token, { concepto, lineas } = {}, contexto = {}) {
    const glosa = String(concepto || '').trim();
    if (glosa.length < 5 || glosa.length > 300) throw new ErrorSolicitud('concepto: entre 5 y 300 caracteres');
    if (!Array.isArray(lineas) || lineas.length < 2 || lineas.length > 100) throw new ErrorSolicitud('lineas: entre 2 y 100');
    const normalizadas = lineas.map((l, i) => {
      const tipo = String(l?.tipo || '').toUpperCase();
      if (!['D', 'H'].includes(tipo)) throw new ErrorSolicitud(`lineas[${i}].tipo debe ser D o H`);
      if (!/^[0-9]{1,12}$/.test(String(l?.cuenta || ''))) throw new ErrorSolicitud(`lineas[${i}].cuenta invalida`);
      return { codigo: String(l.cuenta), tipo, valor: montoValido(l.valor, `lineas[${i}].valor`) };
    });
    return contable(token, contexto, 'ASIENTO_MANUAL', async (tx, actor) => {
      const cuadre = (await tx.query(
        `SELECT sum(v) FILTER (WHERE t = 'D') = sum(v) FILTER (WHERE t = 'H') AS ok,
                sum(v) FILTER (WHERE t = 'D')::text AS debe, sum(v) FILTER (WHERE t = 'H')::text AS haber
           FROM jsonb_to_recordset(@l::jsonb) AS x(t text, v numeric)`,
        { l: JSON.stringify(normalizadas.map(l => ({ t: l.tipo, v: l.valor }))) })).rows[0];
      if (!cuadre.ok) throw new ErrorSolicitud(`El asiento no cuadra: debe ${cuadre.debe}, haber ${cuadre.haber}`);
      const agrupadoras = (await tx.query(
        `SELECT codigo FROM tecnifin.plan_cuentas WHERE codigo = ANY(@c::text[]) AND es_agrupador`,
        { c: normalizadas.map(l => l.codigo) })).rows;
      if (agrupadoras.length) throw new ErrorSolicitud(`No se contabiliza en cuentas de agrupacion: ${agrupadoras.map(a => a.codigo).join(', ')}`);
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'MANUAL', origenId: actor.login,
        tipoDocumento: 'ASIENTO_MANUAL', lineas: normalizadas });
      await auditarProceso(tx, actor, { proceso: 'CONTABILIDAD', accion: 'ASIENTO_MANUAL', entidadTipo: 'ASIENTO',
        entidadId: asiento, detalle: `${glosa.slice(0, 200)} (${cuadre.debe}).` });
      return { asiento: Number(asiento), debe: cuadre.debe, haber: cuadre.haber };
    });
  }

  // Cierre de periodo: despues de cerrado ningun modulo contabiliza en ese mes (periodoDelDia
  // lo rechaza). Solo se cierra un mes ya terminado y con el libro cuadrado.
  async function cerrarPeriodo(token, anio, mes, contexto = {}) {
    const a = Number(anio);
    const m = Number(mes);
    if (!Number.isInteger(a) || a < 1990 || a > 2200 || !Number.isInteger(m) || m < 1 || m > 12) {
      throw new ErrorSolicitud('Periodo invalido');
    }
    return contable(token, contexto, 'CIERRE_PERIODO', async (tx, actor) => {
      const terminado = (await tx.query(
        `SELECT make_date(@a, @m, 1) + interval '1 month' <= ${HOY} AS ok`, { a, m })).rows[0].ok;
      if (!terminado) throw new ErrorConflicto('Solo se cierra un mes que ya termino');
      const p = (await tx.query(
        `SELECT periodo_id, cerrado FROM tecnifin.periodos_contables WHERE anio = @a AND mes = @m FOR UPDATE`, { a, m })).rows[0];
      if (p?.cerrado) throw new ErrorConflicto('El periodo ya esta cerrado');
      if (p) {
        await tx.query(`UPDATE tecnifin.periodos_contables SET cerrado = true WHERE periodo_id = @p`, { p: p.periodo_id });
      } else {
        await tx.query(`INSERT INTO tecnifin.periodos_contables (anio, mes, cerrado) VALUES (@a, @m, true)`, { a, m });
      }
      await auditarProceso(tx, actor, { proceso: 'CONTABILIDAD', accion: 'CERRAR_PERIODO', entidadTipo: 'PERIODO',
        entidadId: `${a}-${String(m).padStart(2, '0')}` });
      return { anio: a, mes: m, cerrado: true };
    });
  }

  return { libroDiario, balanceComprobacion, mayor, asientoManual, cerrarPeriodo };
}

const aCentavos = (t) => {
  const neg = String(t).startsWith('-');
  const [e, d = ''] = String(t).replace('-', '').split('.');
  const v = Number(e) * 100 + Number((d + '00').slice(0, 2));
  return neg ? -v : v;
};
const aTexto = (c) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const negar = (t) => aTexto(-aCentavos(t));
