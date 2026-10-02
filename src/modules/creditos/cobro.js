// M3 · cobro de creditos (patron 06, parte 2): pago de cuotas con interes de mora,
// cancelacion anticipada sin penalizacion y anulacion de pagos. Separado del ciclo
// solicitud -> decision -> desembolso (servicio.js) para respetar la regla 4 (<= 500 lineas).
import {
  auditarProceso, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar, HOY } from '../../platform/contabilidad.js';
import { cajaAbierta, efectivoValido, mismoValor, totalEfectivo } from '../caja/servicio.js';
import {
  aTexto, CUENTA_INTERES, CUENTA_INTERES_MORA, CUENTA_INTERES_POR_COBRAR, CUENTA_SUSPENSO, CUENTA_SUSPENSO_CONTRA,
} from './calculo.js';
import { crearAbonoCapital, restaurarTabla } from './abono.js';

export function crearCobroCreditos({ conRoles, codigoValido, ROLES_COBRO, ROLES_DECISION }) {
  // Parametros de cobro por cooperativa. factor_mora: la tasa de mora es la pactada por este
  // factor (1.1 por defecto) sobre el capital vencido; base_dias: base del interes diario.
  // Ambos debe validarlos el contador con la norma vigente.
  async function parametrosCobro(tx) {
    const filas = (await tx.query(
      `SELECT clave, valor FROM tecnifin.parametros_cooperativa WHERE clave IN ('credito.factor_mora', 'credito.base_dias')`)).rows;
    const p = Object.fromEntries(filas.map(f => [f.clave, f.valor]));
    return { factor: p['credito.factor_mora'] || '1.1', base: p['credito.base_dias'] || '360' };
  }

  // Cuotas pendientes con sus dias de mora, el recargo por mora (en numeric) y la fecha desde
  // la que corre el interes de cada una (la cuota anterior o el desembolso).
  async function cuotasPendientes(tx, cr, limite) {
    const { factor, base } = await parametrosCobro(tx);
    return (await tx.query(
      `WITH todas AS (
         SELECT ta.*, coalesce(lag(ta.fecha_pago) OVER (ORDER BY ta.numero_cuota), cr.fecha_desembolso) AS inicio
           FROM tecnifin.tabla_amortizacion ta
           JOIN tecnifin.creditos cr ON cr.cooperativa_id = ta.cooperativa_id AND cr.credito_id = ta.credito_id
          WHERE ta.credito_id = @id)
       SELECT amortizacion_id, numero_cuota, capital::text AS capital, interes::text AS interes, cuenta_capital, estado,
              interes_devengado::text AS devengado, interes_suspenso::text AS suspenso,
              greatest(${HOY} - fecha_pago, 0) AS dias_mora, fecha_pago > ${HOY} AS futura,
              inicio <= ${HOY} AND fecha_pago > ${HOY} AS en_curso, greatest(${HOY} - inicio, 0) AS dias_corridos,
              round(capital * @tasa::numeric / 100 * @factor::numeric * greatest(${HOY} - fecha_pago, 0) / @base::numeric, 2)::text AS mora
         FROM todas WHERE estado IN ('PENDIENTE', 'VENCIDA')
        ORDER BY numero_cuota LIMIT @limite FOR UPDATE`,
      { id: cr.credito_id, tasa: cr.tasa, factor, base, limite })).rows.map(q => ({ ...q, base }));
  }

  // Ejecutor comun del cobro: debita (caja o cuenta), contabiliza capital por banda, interes del
  // segmento y mora, registra el pago y cierra las cuotas. filas: [{ amortizacion_id, numero_cuota,
  // capital, interes, mora, cuenta_capital, estado }] con importes ya calculados.
  async function cobrar(tx, actor, cr, filas, { via, numeroCuenta, detalle, tipo }) {
    if (filas.some(q => !q.cuenta_capital)) throw new ErrorConflicto('El credito no tiene la cuenta contable de sus cuotas');
    const suma = (await tx.query(
      `SELECT sum(capital)::numeric(18,2)::text AS capital, sum(interes)::numeric(18,2)::text AS interes,
              sum(mora)::numeric(18,2)::text AS mora, sum(capital + interes + mora)::numeric(18,2)::text AS total
         FROM jsonb_to_recordset(@q::jsonb) AS x(capital numeric, interes numeric, mora numeric)`,
      { q: JSON.stringify(filas.map(q => ({ capital: q.capital, interes: q.interes, mora: q.mora }))) })).rows[0];
    const c = cr.codigo;
    const { cuentaDebito, transaccionId, cuentaId, comprobante, saldoCuenta } = await debitarOrigen(tx, actor, cr, suma.total,
      { via, numeroCuenta, detalle, concepto: `${tipo === 'CANCELACION' ? 'Cancelacion' : 'Pago'} del credito ${c}` });

    const desde = filas[0].numero_cuota;
    const hasta = filas.at(-1).numero_cuota;
    const glosa = tipo === 'CANCELACION' ? `Cancelacion anticipada del credito ${c}` : `Pago del credito ${c}, cuotas ${desde} a ${hasta}`;
    const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: c,
      tipoDocumento: tipo === 'CANCELACION' ? 'CANCELACION_CREDITO' : 'PAGO_CREDITO', lineas: [
        { codigo: cuentaDebito, tipo: 'D', valor: suma.total, socioId: cr.socio_id },
        ...filas.map(q => ({ codigo: q.cuenta_capital, tipo: 'H', valor: q.capital, socioId: cr.socio_id })),
        ...lineasInteres(cr, filas, suma.interes),
        { codigo: CUENTA_INTERES_MORA, tipo: 'H', valor: suma.mora, socioId: cr.socio_id },
      ] });
    await enlazarOrigen(tx, actor, { transaccionId, cuentaId, saldoCuenta, total: suma.total, glosa, asiento });
    const pago = (await tx.query(
      `INSERT INTO tecnifin.pagos_credito (credito_id, cuota_desde, cuota_hasta, capital, interes, mora, total, origen, tipo,
                                          transaccion_caja_id, cuenta_id, asiento_id, usuario_id)
       VALUES (@credito, @desde, @hasta, @capital::numeric, @interes::numeric, @mora::numeric, @total::numeric, @origen, @tipo,
               @t, @cuenta, @a, @usuario)
       RETURNING pago_id, numero_pago`,
      { credito: cr.credito_id, desde, hasta, capital: suma.capital, interes: suma.interes, mora: suma.mora, total: suma.total,
        origen: via, tipo, t: transaccionId, cuenta: cuentaId, a: asiento, usuario: actor.usuario_id })).rows[0];
    await tx.query(
      `UPDATE tecnifin.tabla_amortizacion ta
          SET estado_antes_pago = ta.estado, estado = 'PAGADA', interes_pagado = x.interes, mora_pagada = x.mora, pago_id = @pago
         FROM jsonb_to_recordset(@q::jsonb) AS x(id bigint, interes numeric, mora numeric)
        WHERE ta.amortizacion_id = x.id`,
      { pago: pago.pago_id, q: JSON.stringify(filas.map(q => ({ id: q.amortizacion_id, interes: q.interes, mora: q.mora }))) });
    const credito = (await tx.query(
      `UPDATE tecnifin.creditos
          SET saldo = saldo - @capital::numeric,
              estado = CASE WHEN saldo - @capital::numeric = 0 THEN 'CANCELADO' ELSE estado END
        WHERE credito_id = @id RETURNING saldo::text AS saldo, estado`,
      { capital: suma.capital, id: cr.credito_id })).rows[0];
    await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: tipo === 'CANCELACION' ? 'CANCELAR' : 'PAGAR',
      entidadTipo: 'CREDITO', entidadId: c, campo: 'saldo', nuevo: credito.saldo,
      detalle: `Pago ${pago.numero_pago} por ${via}: ${suma.total} (mora ${suma.mora}).` });
    return { pago: Number(pago.numero_pago), credito: c, tipo, cuotas: [desde, hasta], capital: suma.capital,
      interes: suma.interes, mora: suma.mora, total: suma.total, origen: via, comprobante, saldoCredito: credito.saldo,
      estadoCredito: credito.estado };
  }

  // Interes cobrado: lo ya devengado sale de intereses por cobrar (1603) y el resto va a
  // ingreso (5104). Si se cobra menos de lo devengado (cancelacion anticipada de la cuota en
  // curso), la diferencia reversa ingreso. Lo reconocido en suspenso se baja de cuentas de orden.
  function lineasInteres(cr, filas, interesTexto) {
    const cent = (t) => Math.round(Number(t || 0) * 100);
    const devengado = filas.reduce((s, q) => s + cent(q.devengado), 0);
    const suspenso = filas.reduce((s, q) => s + cent(q.suspenso), 0);
    const ingreso = cent(interesTexto) - devengado;
    const seg = cr.segmento;
    return [
      { codigo: CUENTA_INTERES_POR_COBRAR[seg], tipo: 'H', valor: aTexto(devengado), socioId: cr.socio_id },
      { codigo: CUENTA_INTERES[seg], tipo: ingreso >= 0 ? 'H' : 'D', valor: aTexto(Math.abs(ingreso)), socioId: cr.socio_id },
      { codigo: CUENTA_SUSPENSO_CONTRA[seg], tipo: 'D', valor: aTexto(suspenso), socioId: cr.socio_id },
      { codigo: CUENTA_SUSPENSO[seg], tipo: 'H', valor: aTexto(suspenso), socioId: cr.socio_id },
    ];
  }

  // Lado del dinero de un cobro: efectivo en la caja abierta del cajero (con su comprobante y,
  // si viene, el detalle de billetes) o debito a una cuenta de ahorro del mismo socio. Devuelve
  // la cuenta contable que va al Debe del asiento.
  async function debitarOrigen(tx, actor, cr, total, { via, numeroCuenta, detalle, concepto }) {
    let cuentaDebito; let transaccionId = null; let cuentaId = null; let comprobante = null; let saldoCuenta = null;
    const suma = { total };
    if (via === 'CAJA') {
      const control = await cajaAbierta(tx, actor);
      if (!control) throw new ErrorConflicto('Abra su caja del dia antes de cobrar');
      let filasEfectivo = [];
      if (detalle) {
        const { suma: contado, filas: f } = await totalEfectivo(tx, detalle);
        if (!await mismoValor(tx, contado, suma.total)) throw new ErrorSolicitud(`El efectivo suma ${contado}, no ${suma.total}`);
        filasEfectivo = f;
      }
      const t = (await tx.query(
        `INSERT INTO tecnifin.transacciones_caja (control_caja_id, socio_id, credito_id, tipo_operacion, monto, usuario_id, concepto)
         VALUES (@control, @socio, @credito, 'PAGO_CREDITO', @total::numeric, @usuario, @concepto)
         RETURNING transaccion_id, numero_comprobante`,
        { control: control.control_id, socio: cr.socio_id, credito: cr.credito_id, total: suma.total,
          usuario: actor.usuario_id, concepto })).rows[0];
      for (const f of filasEfectivo) {
        await tx.query(
          `INSERT INTO tecnifin.detalle_efectivo_transaccion (transaccion_id, codigo_denominacion, cantidad, total)
           VALUES (@t, @codigo, @cantidad, @total::numeric)`,
          { t: t.transaccion_id, codigo: f.codigo, cantidad: f.cantidad, total: f.total });
      }
      transaccionId = t.transaccion_id;
      comprobante = Number(t.numero_comprobante);
      cuentaDebito = (await tx.query(
        `SELECT valor FROM tecnifin.parametros_cooperativa WHERE clave = 'caja.cuenta_efectivo'`)).rows[0]?.valor || '110105';
    } else {
      const nCuenta = Number(numeroCuenta);
      if (!Number.isSafeInteger(nCuenta) || nCuenta < 1) throw new ErrorSolicitud('numeroCuenta invalido');
      const cuenta = (await tx.query(
        `SELECT c.cuenta_id, c.socio_id, c.estado, p.es_certificado, p.permite_debitos, p.cuenta_activa
           FROM tecnifin.cuentas c
           JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
          WHERE c.numero_cuenta = @n FOR UPDATE OF c`, { n: nCuenta })).rows[0];
      if (!cuenta || String(cuenta.socio_id) !== String(cr.socio_id)) {
        throw new ErrorConflicto('La cuenta de debito debe ser del mismo socio');
      }
      if (cuenta.estado !== 'ACTIVA' || cuenta.es_certificado || !cuenta.permite_debitos) {
        throw new ErrorConflicto('La cuenta de debito debe ser de ahorro, activa y admitir debitos');
      }
      const upd = (await tx.query(
        `UPDATE tecnifin.cuentas SET saldo = saldo - @total::numeric
          WHERE cuenta_id = @id AND saldo - @total::numeric >= 0 RETURNING saldo::text AS saldo`,
        { total: suma.total, id: cuenta.cuenta_id })).rows[0];
      if (!upd) throw new ErrorConflicto('Saldo insuficiente en la cuenta');
      cuentaId = cuenta.cuenta_id;
      saldoCuenta = upd.saldo;
      cuentaDebito = cuenta.cuenta_activa;
    }
    return { cuentaDebito, transaccionId, cuentaId, comprobante, saldoCuenta };
  }

  // Enlaza el asiento con el documento de origen: la transaccion de caja o el movimiento de la
  // cuenta debitada.
  async function enlazarOrigen(tx, actor, { transaccionId, cuentaId, saldoCuenta, total, glosa, asiento }) {
    if (transaccionId) {
      await tx.query(`UPDATE tecnifin.transacciones_caja SET asiento_contable_id = @a WHERE transaccion_id = @t`,
        { a: asiento, t: transaccionId });
    } else {
      await tx.query(
        `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
         VALUES (@cuenta, 'TRANSFERENCIA_SALIDA', @total::numeric, @saldo::numeric, @concepto, @usuario, @a)`,
        { cuenta: cuentaId, total, saldo: saldoCuenta, concepto: glosa.slice(0, 200), usuario: actor.usuario_id, a: asiento });
    }
  }

  const bloquearCredito = async (tx, c) => (await tx.query(
    `SELECT credito_id, codigo, estado, socio_id, segmento, tasa::text AS tasa FROM tecnifin.creditos WHERE codigo = @c FOR UPDATE`,
    { c })).rows[0];

  function entradaCobro({ origen = 'CAJA', efectivo }) {
    const via = String(origen).toUpperCase();
    if (!['CAJA', 'CUENTA'].includes(via)) throw new ErrorSolicitud('origen debe ser CAJA o CUENTA');
    return { via, detalle: via === 'CAJA' ? efectivoValido(efectivo) : null };
  }

  // Pago de las n cuotas pendientes siguientes, completas y en orden, con el recargo por mora
  // de las que ya vencieron.
  async function pagarCuotas(token, codigo, { cuotas = 1, origen, numeroCuenta, efectivo } = {}, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    const n = Number(cuotas);
    if (!Number.isInteger(n) || n < 1 || n > 600) throw new ErrorSolicitud('cuotas debe ser un entero positivo');
    const { via, detalle } = entradaCobro({ origen, efectivo });
    return conRoles(token, contexto, ROLES_COBRO, 'PAGO_CREDITO', async (tx, actor) => {
      const cr = await bloquearCredito(tx, c);
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      const pendientes = await cuotasPendientes(tx, cr, n);
      if (pendientes.length < n) throw new ErrorConflicto(`Solo quedan ${pendientes.length} cuota(s) por pagar`);
      return cobrar(tx, actor, cr, pendientes, { via, numeroCuenta, detalle, tipo: 'CUOTAS' });
    });
  }

  // Cancelacion anticipada: todo el capital pendiente. Las cuotas vencidas se cobran completas
  // con su mora; la cuota en curso, solo el interes corrido hasta hoy; las futuras, sin interes.
  // Sin penalizacion por precancelar.
  async function calcularCancelacion(tx, cr) {
    const pendientes = await cuotasPendientes(tx, cr, 1000);
    if (!pendientes.length) throw new ErrorConflicto('El credito no tiene cuotas pendientes');
    const noVencido = pendientes.filter(q => q.futura).reduce((s, q) => s + Math.round(Number(q.capital) * 100), 0);
    const filas = [];
    for (const q of pendientes) {
      let interes = q.interes;
      if (q.futura && q.en_curso) {
        // Interes corrido sobre el capital aun no vencido, sin pasar el de la cuota.
        interes = (await tx.query(
          `SELECT least(round(@saldo::numeric / 100 * @tasa::numeric / 100 * @dias / @base::numeric, 2), @max::numeric)::text AS i`,
          { saldo: noVencido, tasa: cr.tasa, dias: q.dias_corridos, base: q.base, max: q.interes })).rows[0].i;
      } else if (q.futura) {
        interes = '0.00';
      }
      filas.push({ ...q, interes });
    }
    return filas;
  }

  async function liquidacionCancelacion(token, codigo, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    return conRoles(token, contexto, ROLES_COBRO, 'CONSULTA_CANCELACION', async tx => {
      const cr = await bloquearCredito(tx, c);
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      const filas = await calcularCancelacion(tx, cr);
      const t = (await tx.query(
        `SELECT sum(capital)::numeric(18,2)::text AS capital, sum(interes)::numeric(18,2)::text AS interes,
                sum(mora)::numeric(18,2)::text AS mora, sum(capital + interes + mora)::numeric(18,2)::text AS total
           FROM jsonb_to_recordset(@q::jsonb) AS x(capital numeric, interes numeric, mora numeric)`,
        { q: JSON.stringify(filas.map(q => ({ capital: q.capital, interes: q.interes, mora: q.mora }))) })).rows[0];
      return { credito: c, cuotas: filas.length, ...t };
    });
  }

  async function cancelarAnticipado(token, codigo, { origen, numeroCuenta, efectivo } = {}, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    const { via, detalle } = entradaCobro({ origen, efectivo });
    return conRoles(token, contexto, ROLES_COBRO, 'CANCELACION_CREDITO', async (tx, actor) => {
      const cr = await bloquearCredito(tx, c);
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      return cobrar(tx, actor, cr, await calcularCancelacion(tx, cr), { via, numeroCuenta, detalle, tipo: 'CANCELACION' });
    });
  }

  // Anulacion: supervisor distinto de quien cobro, en el dia, solo el ultimo pago vigente
  // del credito (las cuotas vuelven en orden), con asiento contrario.
  async function anularPago(token, numeroPago, { motivo } = {}, contexto = {}) {
    const numero = Number(numeroPago);
    if (!Number.isSafeInteger(numero) || numero < 1) throw new ErrorSolicitud('Pago invalido');
    const razon = String(motivo || '').trim();
    if (razon.length < 5 || razon.length > 300) throw new ErrorSolicitud('motivo: entre 5 y 300 caracteres');

    return conRoles(token, contexto, ROLES_DECISION, 'ANULACION_PAGO', async (tx, actor) => {
      const p = (await tx.query(
        `SELECT p.*, p.capital::text AS capital_t, p.interes::text AS interes_t, p.mora::text AS mora_t, p.total::text AS total_t,
                (p.fecha AT TIME ZONE 'America/Guayaquil')::date = ${HOY} AS es_de_hoy,
                cr.codigo, cr.socio_id, cr.segmento, cr.credito_id AS cid
           FROM tecnifin.pagos_credito p
           JOIN tecnifin.creditos cr ON cr.cooperativa_id = p.cooperativa_id AND cr.credito_id = p.credito_id
          WHERE p.numero_pago = @n FOR UPDATE OF p, cr`, { n: numero })).rows[0];
      if (!p) return { error: new ErrorNoEncontrado() };
      if (p.anulado) throw new ErrorConflicto('El pago ya esta anulado');
      if (!p.es_de_hoy) throw new ErrorConflicto('Solo se anula un pago del dia');
      if (String(p.usuario_id) === String(actor.usuario_id)) throw new ErrorConflicto('Quien cobro no puede anular su propio pago');
      const posterior = (await tx.query(
        `SELECT 1 FROM tecnifin.pagos_credito WHERE credito_id = @c AND NOT anulado AND pago_id > @p`,
        { c: p.cid, p: p.pago_id })).rows[0];
      if (posterior) throw new ErrorConflicto('Anule primero los pagos posteriores del mismo credito');

      const esAbono = p.tipo === 'ABONO';
      if (esAbono) {
        // La tabla debe seguir exactamente como la dejo el abono (ni pagos ni procesos de cartera
        // posteriores); si no, restaurar "antes" descuadraria el mayor.
        const distintas = (await tx.query(
          `SELECT count(*)::int AS n FROM jsonb_to_recordset(@q::jsonb) AS x(id bigint, despues jsonb)
             JOIN tecnifin.tabla_amortizacion ta ON ta.amortizacion_id = x.id
            WHERE ta.capital <> (x.despues->>'capital')::numeric OR ta.cuenta_capital IS DISTINCT FROM x.despues->>'cuenta'
               OR ta.estado <> x.despues->>'estado'`, { q: JSON.stringify(p.cuotas_abono) })).rows[0].n;
        if (distintas) throw new ErrorConflicto('La tabla cambio despues del abono: no se puede anular');
      }
      if (p.origen === 'CAJA') {
        const t = (await tx.query(
          `SELECT t.transaccion_id, cc.estado FROM tecnifin.transacciones_caja t
             JOIN tecnifin.control_caja cc ON cc.cooperativa_id = t.cooperativa_id AND cc.control_id = t.control_caja_id
            WHERE t.transaccion_id = @t FOR UPDATE OF t`, { t: p.transaccion_caja_id })).rows[0];
        if (t.estado !== 'ABIERTO') throw new ErrorConflicto('La caja que cobro ya esta cerrada');
        await tx.query(
          `UPDATE tecnifin.transacciones_caja SET anulado = true, motivo_anulacion = @m, fecha_anulacion = now(),
                  usuario_anulacion_id = @u WHERE transaccion_id = @t`, { m: razon, u: actor.usuario_id, t: t.transaccion_id });
      } else {
        p.saldoCuenta = (await tx.query(
          `UPDATE tecnifin.cuentas SET saldo = saldo + @total::numeric WHERE cuenta_id = @id RETURNING saldo::text AS saldo`,
          { total: p.total_t, id: p.cuenta_id })).rows[0].saldo;
      }
      // El asiento de anulacion es el inverso exacto del original, linea por linea: cubre capital
      // por banda, interes devengado (1603) o no, suspenso en orden, mora y abonos sin recalcularlos.
      const glosa = `Anulacion del pago ${numero} del credito ${p.codigo}: ${razon}`;
      const inversas = (await tx.query(
        `SELECT pc.codigo, CASE d.tipo_asiento WHEN 'D' THEN 'H' ELSE 'D' END AS tipo, d.valor::text AS valor
           FROM tecnifin.detalle_asiento d
           JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
          WHERE d.asiento_id = @a`, { a: p.asiento_id })).rows.map(l => ({ ...l, socioId: p.socio_id }));
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: p.codigo,
        tipoDocumento: 'ANULACION_PAGO_CREDITO', lineas: inversas });
      if (p.origen === 'CUENTA') {
        await tx.query(
          `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
           VALUES (@cuenta, 'AJUSTE', @total::numeric, @saldo::numeric, @concepto, @usuario, @a)`,
          { cuenta: p.cuenta_id, total: p.total_t, saldo: p.saldoCuenta, concepto: glosa.slice(0, 200),
            usuario: actor.usuario_id, a: asiento });
      }
      if (esAbono) await restaurarTabla(tx, p.cuotas_abono, 'antes');
      else {
        await tx.query(
          `UPDATE tecnifin.tabla_amortizacion SET estado = coalesce(estado_antes_pago, 'PENDIENTE'), estado_antes_pago = NULL, interes_pagado = NULL, mora_pagada = NULL, pago_id = NULL WHERE pago_id = @p`,
          { p: p.pago_id });
      }
      await tx.query(
        `UPDATE tecnifin.pagos_credito SET anulado = true, motivo_anulacion = @m, fecha_anulacion = now(), usuario_anulacion_id = @u
          WHERE pago_id = @p`, { m: razon, u: actor.usuario_id, p: p.pago_id });
      const credito = (await tx.query(
        `UPDATE tecnifin.creditos SET saldo = saldo + @capital::numeric, estado = 'VIGENTE'
          WHERE credito_id = @id RETURNING saldo::text AS saldo`, { capital: p.capital_t, id: p.cid })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'ANULAR_PAGO', entidadTipo: 'PAGO_CREDITO',
        entidadId: numero, detalle: razon });
      return { pago: numero, anulado: true, credito: p.codigo, saldoCredito: credito.saldo };
    });
  }

  const abono = crearAbonoCapital({ conRoles, codigoValido, ROLES_COBRO, bloquearCredito, entradaCobro, debitarOrigen, enlazarOrigen });
  return { pagarCuotas, anularPago, liquidacionCancelacion, cancelarAnticipado, ...abono };
}
