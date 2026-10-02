// M3 · abono extraordinario a capital (patron 06 §6, migracion 0028).
// El socio entrega dinero que no es una cuota: baja el capital y la tabla se recalcula desde la
// cuota que sigue a la cuota en curso. La cuota en curso no cambia (su interes se calculo sobre
// el saldo con que empezo el periodo) y las fechas tampoco, asi que cada cuota conserva su
// subcuenta de cartera por banda: el asiento solo mueve la diferencia de capital en cada una.
import {
  auditarProceso, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar, HOY } from '../../platform/contabilidad.js';
import { aTexto, recalcularTrasAbono } from './calculo.js';

const MODALIDADES = ['REDUCIR_CUOTA', 'REDUCIR_PLAZO'];
const centavos = (texto) => {
  const [e, d = ''] = String(texto).split('.');
  return Number(e) * 100 + Number((d + '00').slice(0, 2));
};

// Deja cada cuota con sus valores de "antes" o "despues" (foto guardada en el abono) y
// recalcula el vencimiento final del credito con las cuotas que siguen existiendo.
export async function restaurarTabla(tx, cambios, lado) {
  const filas = (await tx.query(
    `UPDATE tecnifin.tabla_amortizacion ta
        SET capital = (x.v->>'capital')::numeric, interes = (x.v->>'interes')::numeric,
            total = (x.v->>'capital')::numeric + (x.v->>'interes')::numeric
                    + ta.seguro_desgravamen + ta.contribucion_solca + ta.gastos_administrativos,
            cuenta_capital = x.v->>'cuenta', estado = x.v->>'estado'
       FROM (SELECT (e->>'id')::bigint AS id, e->(@lado::text) AS v FROM jsonb_array_elements(@q::jsonb) AS e) AS x
      WHERE ta.amortizacion_id = x.id
      RETURNING ta.credito_id`, { q: JSON.stringify(cambios), lado })).rows;
  if (filas.length !== cambios.length) throw new ErrorConflicto('La tabla del credito no coincide con el abono');
  await tx.query(
    `UPDATE tecnifin.creditos cr SET fecha_vencimiento = (SELECT max(fecha_pago) FROM tecnifin.tabla_amortizacion ta
                                                          WHERE ta.credito_id = cr.credito_id AND ta.estado <> 'EXTINGUIDA')
      WHERE cr.credito_id = @id`, { id: filas[0].credito_id });
}

export function crearAbonoCapital({ conRoles, codigoValido, ROLES_COBRO, bloquearCredito, entradaCobro, debitarOrigen, enlazarOrigen }) {
  function entradaAbono({ monto, modalidad = 'REDUCIR_CUOTA' }) {
    const m = String(monto ?? '').trim();
    if (!/^[0-9]{1,13}(\.[0-9]{1,2})?$/.test(m) || centavos(m) < 1) throw new ErrorSolicitud('monto invalido');
    const modo = String(modalidad).toUpperCase();
    if (!MODALIDADES.includes(modo)) throw new ErrorSolicitud(`modalidad debe ser ${MODALIDADES.join(' o ')}`);
    return { abono: centavos(m), modo };
  }

  // Cuotas por delante y la tabla que resultaria del abono. Sin escribir nada: lo usan la
  // simulacion y el abono.
  async function planAbono(tx, cr, abono, modo) {
    const cuotas = (await tx.query(
      `SELECT amortizacion_id, numero_cuota, capital::text AS capital, interes::text AS interes, total::text AS total,
              cuenta_capital, estado, fecha_pago::text AS fecha, fecha_pago <= ${HOY} AS vencida
         FROM tecnifin.tabla_amortizacion WHERE credito_id = @id AND estado IN ('PENDIENTE', 'VENCIDA')
        ORDER BY numero_cuota FOR UPDATE`, { id: cr.credito_id })).rows;
    if (cuotas.some(q => q.vencida || q.estado === 'VENCIDA')) {
      throw new ErrorConflicto('Pague primero las cuotas vencidas');
    }
    const resto = cuotas.slice(1); // la primera pendiente es la cuota en curso: no cambia
    const capitalResto = resto.reduce((s, q) => s + centavos(q.capital), 0);
    if (!resto.length || abono >= capitalResto) {
      throw new ErrorConflicto(`El abono debe ser menor que el capital de las cuotas siguientes (${aTexto(capitalResto)}); para mas, use la cancelacion anticipada`);
    }
    if (resto.some(q => !q.cuenta_capital)) throw new ErrorConflicto('El credito no tiene la cuenta contable de sus cuotas');
    let filas;
    try {
      filas = recalcularTrasAbono(aTexto(capitalResto - abono), cr.tasa, resto.length, modo, resto[0].total);
    } catch (e) {
      throw new ErrorConflicto(`No se puede recalcular la tabla: ${e.message}`);
    }
    const cambios = resto.map((q, k) => {
      const f = filas[k];
      return { id: Number(q.amortizacion_id), numero: q.numero_cuota, fecha: q.fecha,
        antes: { capital: q.capital, interes: q.interes, cuenta: q.cuenta_capital, estado: q.estado },
        despues: f
          ? { capital: aTexto(f.capital), interes: aTexto(f.interes), cuenta: q.cuenta_capital, estado: q.estado }
          : { capital: '0.00', interes: '0.00', cuenta: q.cuenta_capital, estado: 'EXTINGUIDA' } };
    });
    const interesAntes = resto.reduce((s, q) => s + centavos(q.interes), 0);
    const interesDespues = filas.reduce((s, f) => s + (f ? f.interes : 0), 0);
    return { cambios, ahorroInteres: aTexto(interesAntes - interesDespues),
      cuotasRestantes: filas.filter(Boolean).length + 1,
      nuevaCuota: filas[0] ? aTexto(filas[0].total) : null };
  }

  const vista = (plan) => plan.cambios.filter(c => c.despues.estado !== 'EXTINGUIDA')
    .map(c => ({ numero: c.numero, fecha: c.fecha, capital: c.despues.capital, interes: c.despues.interes }));

  async function simularAbono(token, codigo, cuerpo = {}, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    const { abono, modo } = entradaAbono(cuerpo);
    return conRoles(token, contexto, ROLES_COBRO, 'SIMULACION_ABONO', async tx => {
      const cr = await bloquearCredito(tx, c);
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      const plan = await planAbono(tx, cr, abono, modo);
      return { credito: c, monto: aTexto(abono), modalidad: modo, nuevaCuota: plan.nuevaCuota,
        cuotasRestantes: plan.cuotasRestantes, ahorroInteres: plan.ahorroInteres, cuotas: vista(plan) };
    });
  }

  async function abonarCapital(token, codigo, cuerpo = {}, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    const { abono, modo } = entradaAbono(cuerpo);
    const { via, detalle } = entradaCobro(cuerpo);
    return conRoles(token, contexto, ROLES_COBRO, 'ABONO_CAPITAL', async (tx, actor) => {
      const cr = await bloquearCredito(tx, c);
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      const plan = await planAbono(tx, cr, abono, modo);
      const total = aTexto(abono);

      const origen = await debitarOrigen(tx, actor, cr, total,
        { via, numeroCuenta: cuerpo.numeroCuenta, detalle, concepto: `Abono a capital del credito ${c}` });
      // Diferencia de capital por subcuenta: Haber lo que baja; Debe si alguna cuota sube
      // (REDUCIR_PLAZO: con la misma cuota y menos interes, el capital de la cuota crece).
      const delta = new Map();
      for (const x of plan.cambios) {
        delta.set(x.antes.cuenta, (delta.get(x.antes.cuenta) || 0) + centavos(x.antes.capital) - centavos(x.despues.capital));
      }
      const glosa = `Abono a capital del credito ${c} (${modo === 'REDUCIR_CUOTA' ? 'reduce la cuota' : 'reduce el plazo'})`;
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: c,
        tipoDocumento: 'ABONO_CAPITAL', lineas: [
          { codigo: origen.cuentaDebito, tipo: 'D', valor: total, socioId: cr.socio_id },
          ...[...delta].filter(([, v]) => v !== 0).map(([codigo, v]) => ({
            codigo, tipo: v > 0 ? 'H' : 'D', valor: aTexto(Math.abs(v)), socioId: cr.socio_id })),
        ] });
      await enlazarOrigen(tx, actor, { ...origen, total, glosa, asiento });
      const pago = (await tx.query(
        `INSERT INTO tecnifin.pagos_credito (credito_id, cuota_desde, cuota_hasta, capital, interes, mora, total, origen, tipo,
                                            modalidad, cuotas_abono, transaccion_caja_id, cuenta_id, asiento_id, usuario_id)
         VALUES (@credito, @desde, @hasta, @total::numeric, 0, 0, @total::numeric, @origen, 'ABONO',
                 @modo, @cambios::jsonb, @t, @cuenta, @a, @usuario)
         RETURNING numero_pago`,
        { credito: cr.credito_id, desde: plan.cambios[0].numero, hasta: plan.cambios.at(-1).numero, total, origen: via, modo,
          cambios: JSON.stringify(plan.cambios), t: origen.transaccionId, cuenta: origen.cuentaId, a: asiento,
          usuario: actor.usuario_id })).rows[0];
      await restaurarTabla(tx, plan.cambios, 'despues');
      const credito = (await tx.query(
        `UPDATE tecnifin.creditos SET saldo = saldo - @total::numeric WHERE credito_id = @id
         RETURNING saldo::text AS saldo, fecha_vencimiento::text AS vence`, { total, id: cr.credito_id })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'ABONAR', entidadTipo: 'CREDITO', entidadId: c,
        campo: 'saldo', nuevo: credito.saldo, detalle: `Abono ${pago.numero_pago} por ${via}: ${total}, ${modo}.` });
      return { pago: Number(pago.numero_pago), credito: c, tipo: 'ABONO', modalidad: modo, total, origen: via,
        comprobante: origen.comprobante, saldoCredito: credito.saldo, vence: credito.vence, nuevaCuota: plan.nuevaCuota,
        cuotasRestantes: plan.cuotasRestantes, ahorroInteres: plan.ahorroInteres };
    });
  }

  return { simularAbono, abonarCapital };
}
