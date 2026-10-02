// M6 · devengo de intereses de cartera (patron 08 §8, migracion 0029).
//
// A una fecha de corte, el interes de cada cuota pendiente se reconoce en proporcion lineal a
// los dias corridos de su periodo (desde la cuota anterior o el desembolso hasta su fecha de
// pago); una cuota ya vencida reconoce todo su interes. Lo que falta por reconocer va:
//   credito que devenga (ninguna cuota vencida)  -> Debe 1603xx intereses por cobrar / Haber 5104xx
//   credito en no devenga (alguna cuota vencida) -> Debe 7109xx / Haber 7209xx (en suspenso, orden)
// El mismo criterio de "vencida" que la clasificacion de cartera (dias de mora > 0 al corte).
// El cobro de la cuota descarga 1603 y baja el suspenso (creditos/cobro.js).
//
// Antes de aplicar, el mayor de 1603xx y 7109xx debe coincidir al centavo con lo acumulado en
// las cuotas pendientes; si no, se niega (igual que la reclasificacion de capital).
import { auditarProceso, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud } from '../../platform/autenticacion.js';
import { asentar } from '../../platform/contabilidad.js';
import {
  aTexto, CUENTA_INTERES, CUENTA_INTERES_POR_COBRAR, CUENTA_SUSPENSO, CUENTA_SUSPENSO_CONTRA,
} from '../creditos/calculo.js';

const ROLES_CONSULTA = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER']);
const ROLES_APLICA = new Set(['SUPER_USER', 'ADMIN', 'MANAGER']);
const cent = (t) => Math.round(Number(t || 0) * 100);

export function crearDevengo({ conRoles, saldosContables, fechaCorteValida }) {
  // Lo que movera cada cuota al corte. No escribe nada.
  async function calcular(tx, corte) {
    const cuotas = (await tx.query(
      `WITH t AS (
         SELECT ta.amortizacion_id, ta.credito_id, ta.estado, ta.fecha_pago, ta.interes, ta.interes_devengado, ta.interes_suspenso,
                cr.codigo, cr.segmento, cr.fecha_desembolso,
                coalesce(lag(ta.fecha_pago) OVER (PARTITION BY ta.credito_id ORDER BY ta.numero_cuota), cr.fecha_desembolso) AS inicio
           FROM tecnifin.tabla_amortizacion ta
           JOIN tecnifin.creditos cr ON cr.cooperativa_id = ta.cooperativa_id AND cr.credito_id = ta.credito_id
          WHERE cr.estado = 'VIGENTE' AND cr.fecha_desembolso <= @corte::date),
       nd AS (
         SELECT credito_id, bool_or(estado IN ('PENDIENTE', 'VENCIDA') AND fecha_pago < @corte::date) AS no_devenga
           FROM t GROUP BY credito_id)
       SELECT t.amortizacion_id, t.codigo, t.segmento, nd.no_devenga,
              greatest(CASE WHEN t.fecha_pago <= @corte::date THEN t.interes
                            WHEN t.inicio >= @corte::date THEN 0
                            ELSE round(t.interes * (@corte::date - t.inicio) / (t.fecha_pago - t.inicio), 2) END
                       - t.interes_devengado - t.interes_suspenso, 0)::text AS delta
         FROM t JOIN nd ON nd.credito_id = t.credito_id
        WHERE t.estado IN ('PENDIENTE', 'VENCIDA')`, { corte })).rows.filter(q => cent(q.delta) > 0);
    const porSegmento = {};
    for (const q of cuotas) {
      const s = (porSegmento[q.segmento] ??= { devengado: 0, suspenso: 0 });
      s[q.no_devenga ? 'suspenso' : 'devengado'] += cent(q.delta);
    }
    const total = (campo) => Object.values(porSegmento).reduce((s, x) => s + x[campo], 0);
    return { cuotas, porSegmento, devengado: total('devengado'), suspenso: total('suspenso') };
  }

  // Control: el mayor de intereses por cobrar y de suspenso igual a lo acumulado en las cuotas.
  async function control(tx) {
    const acumulado = (await tx.query(
      `SELECT cr.segmento, sum(ta.interes_devengado)::text AS devengado, sum(ta.interes_suspenso)::text AS suspenso
         FROM tecnifin.tabla_amortizacion ta
         JOIN tecnifin.creditos cr ON cr.cooperativa_id = ta.cooperativa_id AND cr.credito_id = ta.credito_id
        WHERE cr.estado = 'VIGENTE' AND ta.estado IN ('PENDIENTE', 'VENCIDA') GROUP BY cr.segmento`)).rows;
    const mayor = { ...await saldosContables(tx, '1603', '1604', '9999-12-31'),
      ...await saldosContables(tx, '7109', '7110', '9999-12-31') };
    const diferencias = [];
    for (const seg of Object.keys(CUENTA_INTERES_POR_COBRAR)) {
      const a = acumulado.find(x => x.segmento === seg);
      for (const [cuenta, esperado] of [[CUENTA_INTERES_POR_COBRAR[seg], cent(a?.devengado)], [CUENTA_SUSPENSO[seg], cent(a?.suspenso)]]) {
        if ((mayor[cuenta] || 0) !== esperado) diferencias.push({ cuenta, contable: aTexto(mayor[cuenta] || 0), cuotas: aTexto(esperado) });
      }
    }
    return diferencias;
  }

  const resumen = (corte, c) => ({ fechaCorte: corte, cuotas: c.cuotas.length, devengado: aTexto(c.devengado),
    suspenso: aTexto(c.suspenso), porSegmento: Object.fromEntries(Object.entries(c.porSegmento)
      .map(([k, v]) => [k, { devengado: aTexto(v.devengado), suspenso: aTexto(v.suspenso) }])) });

  async function simularDevengo(token, fecha, contexto = {}) {
    return conRoles(token, contexto, ROLES_CONSULTA, 'CONSULTA_DEVENGO', async tx => {
      const corte = await fechaCorteValida(tx, fecha);
      return { ...resumen(corte, await calcular(tx, corte)), control: await control(tx) };
    });
  }

  async function aplicarDevengo(token, { fechaCorte } = {}, contexto = {}) {
    return conRoles(token, contexto, ROLES_APLICA, 'DEVENGO_INTERESES', async (tx, actor) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cartera:' || tecnifin.cooperativa_actual()))`);
      const corte = await fechaCorteValida(tx, fechaCorte);
      const ultimo = (await tx.query(
        `SELECT max(fecha_corte)::text AS f FROM tecnifin.devengo_intereses WHERE estado = 'APLICADO'`)).rows[0].f;
      if (ultimo && corte < ultimo) throw new ErrorConflicto(`Ya hay un devengo aplicado al ${ultimo}`);
      const diferencias = await control(tx);
      if (diferencias.length) {
        throw new ErrorConflicto(`El mayor de intereses no cuadra con las cuotas: ${diferencias.map(d => `${d.cuenta} ${d.contable} vs ${d.cuotas}`).join('; ')}`);
      }
      const c = await calcular(tx, corte);
      let asiento = null;
      if (c.devengado + c.suspenso > 0) {
        const lineas = [];
        for (const [seg, v] of Object.entries(c.porSegmento)) {
          lineas.push(
            { codigo: CUENTA_INTERES_POR_COBRAR[seg], tipo: 'D', valor: aTexto(v.devengado) },
            { codigo: CUENTA_INTERES[seg], tipo: 'H', valor: aTexto(v.devengado) },
            { codigo: CUENTA_SUSPENSO[seg], tipo: 'D', valor: aTexto(v.suspenso) },
            { codigo: CUENTA_SUSPENSO_CONTRA[seg], tipo: 'H', valor: aTexto(v.suspenso) });
        }
        asiento = await asentar(tx, actor, { concepto: `Devengo de intereses de cartera al ${corte}`, origenModulo: 'CREDITOS',
          origenId: `DEVENGO-${corte}`, tipoDocumento: 'DEVENGO_INTERESES', lineas });
      }
      const proceso = (await tx.query(
        `INSERT INTO tecnifin.devengo_intereses (fecha_corte, devengado, suspenso, asiento_id, usuario_id)
         VALUES (@corte::date, @d::numeric, @s::numeric, @a, @u) RETURNING proceso_id`,
        { corte, d: aTexto(c.devengado), s: aTexto(c.suspenso), a: asiento, u: actor.usuario_id })).rows[0].proceso_id;
      const filas = JSON.stringify(c.cuotas.map(q => ({ id: q.amortizacion_id,
        d: q.no_devenga ? '0' : q.delta, s: q.no_devenga ? q.delta : '0' })));
      await tx.query(
        `INSERT INTO tecnifin.devengo_cuota (proceso_id, amortizacion_id, devengado, suspenso)
         SELECT @p, x.id, x.d, x.s FROM jsonb_to_recordset(@q::jsonb) AS x(id bigint, d numeric, s numeric)`, { p: proceso, q: filas });
      await tx.query(
        `UPDATE tecnifin.tabla_amortizacion ta
            SET interes_devengado = ta.interes_devengado + x.d, interes_suspenso = ta.interes_suspenso + x.s
           FROM jsonb_to_recordset(@q::jsonb) AS x(id bigint, d numeric, s numeric) WHERE ta.amortizacion_id = x.id`, { q: filas });
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'DEVENGAR', entidadTipo: 'PROCESO_DEVENGO',
        entidadId: proceso, detalle: `Corte ${corte}: devengado ${aTexto(c.devengado)}, suspenso ${aTexto(c.suspenso)}.` });
      return { proceso: Number(proceso), estado: 'APLICADO', asiento: asiento && Number(asiento), ...resumen(corte, c) };
    });
  }

  // Reversion exacta del ultimo devengo aplicado, solo si ninguna de sus cuotas se cobro,
  // castigo o volvio a devengar despues.
  async function reversarDevengo(token, procesoId, { motivo } = {}, contexto = {}) {
    const id = Number(procesoId);
    if (!Number.isSafeInteger(id) || id < 1) throw new ErrorSolicitud('Proceso invalido');
    const razon = String(motivo || '').trim();
    if (razon.length < 5 || razon.length > 500) throw new ErrorSolicitud('motivo: entre 5 y 500 caracteres');
    return conRoles(token, contexto, ROLES_APLICA, 'REVERSAR_DEVENGO', async (tx, actor) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cartera:' || tecnifin.cooperativa_actual()))`);
      const pr = (await tx.query(
        `SELECT proceso_id, estado, fecha_corte::text AS corte, asiento_id FROM tecnifin.devengo_intereses
          WHERE proceso_id = @id FOR UPDATE`, { id })).rows[0];
      if (!pr) return { error: new ErrorNoEncontrado() };
      if (pr.estado !== 'APLICADO') throw new ErrorConflicto(`El devengo esta ${pr.estado}`);
      if ((await tx.query(`SELECT 1 FROM tecnifin.devengo_intereses WHERE estado = 'APLICADO' AND proceso_id > @id`, { id })).rows[0]) {
        throw new ErrorConflicto('Reverse primero los devengos posteriores');
      }
      const cambiadas = (await tx.query(
        `SELECT count(*)::int AS n FROM tecnifin.devengo_cuota dc
           JOIN tecnifin.tabla_amortizacion ta ON ta.cooperativa_id = dc.cooperativa_id AND ta.amortizacion_id = dc.amortizacion_id
          WHERE dc.proceso_id = @id AND ta.estado NOT IN ('PENDIENTE', 'VENCIDA')`, { id })).rows[0].n;
      if (cambiadas) throw new ErrorConflicto(`${cambiadas} cuota(s) se cobraron o castigaron despues del devengo: no se puede reversar`);
      let reverso = null;
      if (pr.asiento_id) {
        const lineas = (await tx.query(
          `SELECT pc.codigo, CASE d.tipo_asiento WHEN 'D' THEN 'H' ELSE 'D' END AS tipo, d.valor::text AS valor
             FROM tecnifin.detalle_asiento d
             JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
            WHERE d.asiento_id = @a`, { a: pr.asiento_id })).rows;
        reverso = await asentar(tx, actor, { concepto: `Reverso del devengo al ${pr.corte}: ${razon}`, origenModulo: 'CREDITOS',
          origenId: `DEVENGO-${pr.corte}`, tipoDocumento: 'REVERSO_DEVENGO', lineas });
      }
      await tx.query(
        `UPDATE tecnifin.tabla_amortizacion ta
            SET interes_devengado = ta.interes_devengado - dc.devengado, interes_suspenso = ta.interes_suspenso - dc.suspenso
           FROM tecnifin.devengo_cuota dc
          WHERE dc.cooperativa_id = ta.cooperativa_id AND dc.amortizacion_id = ta.amortizacion_id AND dc.proceso_id = @id`, { id });
      await tx.query(
        `UPDATE tecnifin.devengo_intereses SET estado = 'REVERSADO', motivo_reverso = @m, asiento_reverso_id = @a
          WHERE proceso_id = @id`, { m: razon, a: reverso, id });
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'REVERSAR_DEVENGO', entidadTipo: 'PROCESO_DEVENGO',
        entidadId: id, detalle: razon });
      return { proceso: id, estado: 'REVERSADO', asientoReverso: reverso && Number(reverso) };
    });
  }

  return { simularDevengo, aplicarDevengo, reversarDevengo };
}
