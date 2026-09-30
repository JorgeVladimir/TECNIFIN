// M4 · pago periodico de intereses de depositos a plazo (modalidad MENSUAL o TRIMESTRAL).
//
// El periodo se cuenta en dias desde la apertura (30 o 90, la misma convencion de dias del
// calculo del interes). El interes de un periodo es interesAcumulado(fin) - interesAcumulado(inicio),
// cada uno redondeado al centavo, igual la retencion: la suma de todos los pagos mas la
// liquidacion final da exactamente el interes y la retencion del plazo completo.
//
// El ultimo tramo (hasta el vencimiento) no se paga aqui: lo paga la liquidacion.
import { auditarProceso } from '../../platform/autenticacion.js';
import { asentar, HOY } from '../../platform/contabilidad.js';

export const DIAS_PERIODO = { MENSUAL: 30, TRIMESTRAL: 90 };

// Interes y retencion ya pagados de un deposito (texto numeric), y los dias cubiertos.
export async function pagadoDe(tx, depositoId) {
  return (await tx.query(
    `SELECT coalesce(sum(interes), 0)::text AS interes, coalesce(sum(retencion), 0)::text AS retencion,
            coalesce(max(dias_hasta), 0) AS dias, coalesce(max(periodo), 0) AS periodo
       FROM tecnifin.pagos_interes_dpf WHERE deposito_id = @id`, { id: depositoId })).rows[0];
}

// Interes, retencion y neto de los dias (desde, hasta] como diferencia de acumulados.
async function tramoDeInteres(tx, { capital, tasa, base, retencionPct, desde, hasta }) {
  return (await tx.query(
    `WITH a AS (SELECT round(@c::numeric * @t::numeric / 100 * @desde / @b::numeric, 2) AS i0,
                       round(@c::numeric * @t::numeric / 100 * @hasta / @b::numeric, 2) AS i1),
          r AS (SELECT i0, i1, round(i0 * @r::numeric / 100, 2) AS r0, round(i1 * @r::numeric / 100, 2) AS r1 FROM a)
     SELECT (i1 - i0)::text AS interes, (r1 - r0)::text AS retencion, ((i1 - i0) - (r1 - r0))::text AS neto FROM r`,
    { c: capital, t: tasa, b: base, r: retencionPct, desde, hasta })).rows[0];
}

export function crearPagoIntereses({ conRoles, rolesSupervisor, parametros }) {
  // Paga todos los periodos vencidos hasta hoy de los depositos ACTIVOS con pago periodico.
  // Idempotente: un periodo ya pagado no se vuelve a pagar (UNIQUE deposito + periodo).
  async function pagarIntereses(token, contexto = {}) {
    return conRoles(token, contexto, rolesSupervisor, 'PAGO_INTERESES_DPF', async (tx, actor) => {
      const p = await parametros(tx);
      const depositos = (await tx.query(
        `SELECT d.deposito_id, d.codigo, d.socio_id, d.estado, d.monto_capital::text AS capital,
                d.tasa_nominal_anual::text AS tasa, d.plazo_dias, d.modalidad_pago, d.cuenta_ahorros_id,
                (${HOY} - d.fecha_apertura) AS transcurridos, d.fecha_apertura::text AS apertura, c.numero_cuenta,
                (SELECT pf.cuenta_activa FROM tecnifin.productos_financieros pf
                  WHERE pf.cooperativa_id = c.cooperativa_id AND pf.producto_id = c.producto_id) AS cuenta_activa
           FROM tecnifin.depositos_plazo d
           JOIN tecnifin.cuentas c ON c.cooperativa_id = d.cooperativa_id AND c.cuenta_id = d.cuenta_ahorros_id
          WHERE d.estado = 'ACTIVO' AND d.modalidad_pago <> 'AL_VENCIMIENTO'
          ORDER BY d.deposito_id FOR UPDATE OF d, c`)).rows;

      const pagos = [];
      for (const d of depositos) {
        const largo = DIAS_PERIODO[d.modalidad_pago];
        const ya = await pagadoDe(tx, d.deposito_id);
        for (let k = Number(ya.periodo) + 1; k * largo < d.plazo_dias && k * largo <= Number(d.transcurridos); k++) {
          const hasta = k * largo;
          const i = await tramoDeInteres(tx, { capital: d.capital, tasa: d.tasa, base: p['dpf.base_dias'],
            retencionPct: p['dpf.retencion_pct'], desde: (k - 1) * largo, hasta });
          const glosa = `Interes periodo ${k} del deposito ${d.codigo}`;
          const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'PLAZO_FIJO', origenId: d.codigo,
            tipoDocumento: 'INTERES_DPF', lineas: [
              { codigo: p['dpf.cuenta_gasto_interes'], tipo: 'D', valor: i.interes, socioId: d.socio_id },
              { codigo: d.cuenta_activa, tipo: 'H', valor: i.neto, socioId: d.socio_id },
              { codigo: p['dpf.cuenta_retencion'], tipo: 'H', valor: i.retencion, socioId: d.socio_id },
            ] });
          const saldo = (await tx.query(
            `UPDATE tecnifin.cuentas SET saldo = saldo + @n::numeric WHERE cuenta_id = @id RETURNING saldo::text AS saldo`,
            { n: i.neto, id: d.cuenta_ahorros_id })).rows[0].saldo;
          if (Number(i.neto) > 0) {
            await tx.query(
              `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
               VALUES (@c, 'TRANSFERENCIA_ENTRADA', @n::numeric, @s::numeric, @g, @u, @a)`,
              { c: d.cuenta_ahorros_id, n: i.neto, s: saldo, g: glosa, u: actor.usuario_id, a: asiento });
          }
          const corte = (await tx.query(
            `INSERT INTO tecnifin.pagos_interes_dpf (deposito_id, periodo, dias_hasta, fecha_corte, interes, retencion,
                                                     interes_neto, asiento_id, usuario_id)
             VALUES (@id, @k, @hasta, @apertura::date + @hasta::int, @i::numeric, @r::numeric, @n::numeric, @a, @u)
             RETURNING fecha_corte::text AS corte`,
            { id: d.deposito_id, k, hasta, apertura: d.apertura, i: i.interes, r: i.retencion, n: i.neto, a: asiento,
              u: actor.usuario_id })).rows[0].corte;
          pagos.push({ codigo: d.codigo, periodo: k, fechaCorte: corte, interes: i.interes, retencion: i.retencion,
            interesNeto: i.neto, numeroCuenta: Number(d.numero_cuenta), saldoCuenta: saldo });
        }
      }
      const total = pagos.reduce((s, x) => s + Math.round(Number(x.interesNeto) * 100), 0);
      if (pagos.length) {
        await auditarProceso(tx, actor, { proceso: 'PLAZO_FIJO', accion: 'PAGAR_INTERESES', entidadTipo: 'DPF',
          entidadId: 'LOTE', nuevo: (total / 100).toFixed(2),
          detalle: `${pagos.length} periodos de ${new Set(pagos.map(x => x.codigo)).size} depositos.` });
      }
      return { pagos, periodosPagados: pagos.length, totalNeto: (total / 100).toFixed(2) };
    });
  }

  return { pagarIntereses };
}
