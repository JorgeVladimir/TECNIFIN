// M3 · creditos (patron 06): solicitud -> decision -> desembolso, sobre los patrones 04
// (entidades de negocio) y 05 (dinero). Lo que cambia frente al sistema anterior:
//  * la tasa, el monto y el plazo salen de la LINEA de credito (tasas_credito), no del cliente;
//  * quien registra la solicitud no la aprueba (tambien lo exige un CHECK de la base);
//  * el capital de cada cuota se contabiliza en la banda de su plazo remanente, dentro de la
//    familia por vencer del segmento (1401..1404), leida del plan de cuentas; el sistema
//    anterior mandaba todo a 140205;
//  * los descuentos al desembolso son datos de la cooperativa (descuentos_credito).
import {
  auditarProceso, crearAutenticador, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar, HOY } from '../../platform/contabilidad.js';
import { cajaAbierta, efectivoValido, mismoValor, montoValido, totalEfectivo } from '../caja/servicio.js';
import {
  amortizacionFrancesa, bandasDesdePlan, CUENTA_INTERES, cuentaPorBanda, FAMILIA_CARTERA, tablaEnTexto,
} from './calculo.js';

const ROLES_ANALISIS = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER']);
// Cobra quien opera caja (el pago por debito tambien lo registra ventanilla).
const ROLES_COBRO = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'TELLER']);
const ROLES_DECISION = new Set(['SUPER_USER', 'ADMIN', 'MANAGER']);
const CERTIFICADO_MINIMO_DEFECTO = '1.00';

const codigoValido = (valor, prefijo) => {
  const c = String(valor || '').toUpperCase();
  if (!new RegExp(`^${prefijo}-[0-9]{6,12}$`).test(c)) throw new ErrorSolicitud('Codigo invalido');
  return c;
};
const plazoValido = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 600) throw new ErrorSolicitud('plazo debe ser un numero entero de meses');
  return n;
};

export function crearServicioCreditos({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });
  const analisis = (token, ctx, concepto, op) => conRoles(token, ctx, ROLES_ANALISIS, concepto, op);

  // La linea vigente con sus limites; monto y plazo se validan contra ella en numeric.
  async function lineaValida(tx, nombre, monto, plazo) {
    const linea = (await tx.query(
      `SELECT tasa_credito_id, linea_credito, clase_credito AS segmento, tasa_aplicable::text AS tasa,
              monto_minimo, monto_maximo, plazo_minimo, plazo_maximo,
              @monto::numeric BETWEEN monto_minimo AND monto_maximo AS monto_ok
         FROM tecnifin.tasas_credito
        WHERE linea_credito = @linea AND activo AND fecha_vigencia <= ${HOY}
        ORDER BY fecha_vigencia DESC LIMIT 1`, { linea: String(nombre || ''), monto })).rows[0];
    if (!linea) throw new ErrorSolicitud('Linea de credito inexistente o inactiva');
    if (!linea.monto_ok) throw new ErrorSolicitud(`El monto debe estar entre ${linea.monto_minimo} y ${linea.monto_maximo}`);
    if (plazo < linea.plazo_minimo || plazo > linea.plazo_maximo) {
      throw new ErrorSolicitud(`El plazo debe estar entre ${linea.plazo_minimo} y ${linea.plazo_maximo} meses`);
    }
    return linea;
  }

  async function lineasCredito(token, contexto = {}) {
    return analisis(token, contexto, 'CONSULTA_CREDITOS', async tx => (await tx.query(
      `SELECT linea_credito AS linea, clase_credito AS segmento, monto_minimo AS "montoMinimo",
              monto_maximo AS "montoMaximo", plazo_minimo AS "plazoMinimo", plazo_maximo AS "plazoMaximo",
              tasa_aplicable::text AS tasa
         FROM tecnifin.tasas_credito WHERE activo AND fecha_vigencia <= ${HOY}
        ORDER BY linea_credito`)).rows);
  }

  async function simular(token, { lineaCredito, monto, plazo } = {}, contexto = {}) {
    const m = montoValido(monto);
    const p = plazoValido(plazo);
    return analisis(token, contexto, 'SIMULACION_CREDITO', async tx => {
      const linea = await lineaValida(tx, lineaCredito, m, p);
      return { linea: linea.linea_credito, segmento: linea.segmento, tasa: linea.tasa, plazo: p,
        ...tablaEnTexto(amortizacionFrancesa(m, linea.tasa, p)) };
    });
  }

  async function crearSolicitud(token, entrada = {}, contexto = {}) {
    const m = montoValido(entrada.monto);
    const p = plazoValido(entrada.plazo);
    const numeroSocio = Number(entrada.numeroSocio);
    if (!Number.isSafeInteger(numeroSocio) || numeroSocio < 1) throw new ErrorSolicitud('numeroSocio invalido');
    const destino = entrada.destino ? String(entrada.destino).trim().slice(0, 200) : null;
    const garantia = entrada.garantia ? String(entrada.garantia).trim().slice(0, 2000) : null;

    return analisis(token, contexto, 'SOLICITUD_CREDITO', async (tx, actor) => {
      const socio = (await tx.query(
        `SELECT socio_id, identificacion, tipo_persona, estado FROM tecnifin.socios WHERE numero_socio = @n`,
        { n: numeroSocio })).rows[0];
      if (!socio) return { error: new ErrorNoEncontrado() };
      if (socio.tipo_persona !== 'SOCIO') throw new ErrorConflicto('Solo un SOCIO puede solicitar credito');
      if (socio.estado !== 'ACTIVO') throw new ErrorConflicto(`El socio esta ${socio.estado}`);

      // Aportacion minima en certificado: requisito de socio para acceder al credito.
      const minimo = (await tx.query(
        `SELECT valor FROM tecnifin.parametros_cooperativa WHERE clave = 'credito.certificado_minimo'`)).rows[0]?.valor
        || CERTIFICADO_MINIMO_DEFECTO;
      const aporte = (await tx.query(
        `SELECT coalesce(sum(c.saldo), 0) >= @minimo::numeric AS cumple, coalesce(sum(c.saldo), 0)::text AS saldo
           FROM tecnifin.cuentas c
           JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
          WHERE c.socio_id = @socio AND p.es_certificado AND c.estado = 'ACTIVA'`,
        { socio: socio.socio_id, minimo })).rows[0];
      if (!aporte.cumple) throw new ErrorConflicto(`Requiere al menos ${minimo} en certificados de aportacion (tiene ${aporte.saldo})`);

      const linea = await lineaValida(tx, entrada.lineaCredito, m, p);
      const tabla = tablaEnTexto(amortizacionFrancesa(m, linea.tasa, p));
      const fila = (await tx.query(
        `INSERT INTO tecnifin.solicitudes_credito
           (codigo, socio_id, identificacion, monto, saldo, tasa, plazo, tipo, estado, plan_pagos, garantia_info,
            origen, segmento, tasa_credito_id, destino, usuario_registro_id)
         VALUES ('SOL-' || lpad(tecnifin.siguiente_numero('solicitud_credito')::text, 6, '0'),
                 @socio, @identificacion, @monto::numeric, @monto::numeric, @tasa::numeric, @plazo, @linea, 'SOLICITADO',
                 @plan, @garantia, 'VENTANILLA', @segmento, @tasaId, @destino, @usuario)
         RETURNING codigo, monto::text AS monto`,
        { socio: socio.socio_id, identificacion: socio.identificacion, monto: m, tasa: linea.tasa, plazo: p,
          linea: linea.linea_credito, plan: JSON.stringify(tabla.cuotas), garantia, segmento: linea.segmento,
          tasaId: linea.tasa_credito_id, destino, usuario: actor.usuario_id })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'SOLICITAR', entidadTipo: 'SOLICITUD_CREDITO',
        entidadId: fila.codigo, nuevo: m, detalle: `${linea.linea_credito}, ${p} meses, socio ${numeroSocio}.` });
      return { codigo: fila.codigo, estado: 'SOLICITADO', monto: fila.monto, linea: linea.linea_credito,
        segmento: linea.segmento, tasa: linea.tasa, plazo: p, cuota: tabla.cuota };
    });
  }

  async function verSolicitud(token, codigo, contexto = {}) {
    const c = codigoValido(codigo, 'SOL');
    return analisis(token, contexto, 'CONSULTA_CREDITOS', async tx => {
      const s = (await tx.query(
        `SELECT s.codigo, s.estado, s.monto::text AS monto, s.tasa::text AS tasa, s.plazo, s.tipo AS linea, s.segmento,
                s.destino, s.observaciones, so.numero_socio, s.plan_pagos,
                to_char(s.fecha_solicitud AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD"T"HH24:MI:SS') || '-05:00' AS fecha
           FROM tecnifin.solicitudes_credito s
           JOIN tecnifin.socios so ON so.cooperativa_id = s.cooperativa_id AND so.socio_id = s.socio_id
          WHERE s.codigo = @c`, { c })).rows[0];
      if (!s) return { error: new ErrorNoEncontrado() };
      return { codigo: s.codigo, estado: s.estado, numeroSocio: Number(s.numero_socio), linea: s.linea,
        segmento: s.segmento, monto: s.monto, tasa: s.tasa, plazo: s.plazo, destino: s.destino,
        observaciones: s.observaciones, fecha: s.fecha, plan: s.plan_pagos ? JSON.parse(s.plan_pagos) : [] };
    });
  }

  async function decidir(token, codigo, { decision, observaciones, tipoAprobacion, actaSesion } = {}, contexto = {}) {
    const c = codigoValido(codigo, 'SOL');
    const d = String(decision || '').toUpperCase();
    if (!['APROBAR', 'RECHAZAR'].includes(d)) throw new ErrorSolicitud('decision debe ser APROBAR o RECHAZAR');
    const obs = observaciones ? String(observaciones).trim().slice(0, 500) : null;
    if (d === 'RECHAZAR' && (!obs || obs.length < 5)) throw new ErrorSolicitud('El rechazo requiere el motivo');

    return conRoles(token, contexto, ROLES_DECISION, 'DECISION_CREDITO', async (tx, actor) => {
      const s = (await tx.query(
        `SELECT solicitud_id, estado, usuario_registro_id FROM tecnifin.solicitudes_credito WHERE codigo = @c FOR UPDATE`,
        { c })).rows[0];
      if (!s) return { error: new ErrorNoEncontrado() };
      if (!['SOLICITADO', 'EN_ANALISIS'].includes(s.estado)) throw new ErrorConflicto(`La solicitud esta ${s.estado}`);
      if (String(s.usuario_registro_id) === String(actor.usuario_id)) {
        throw new ErrorConflicto('Quien registro la solicitud no puede decidirla');
      }
      const estado = d === 'APROBAR' ? 'APROBADO' : 'RECHAZADO';
      await tx.query(
        `UPDATE tecnifin.solicitudes_credito
            SET estado = @estado, observaciones = coalesce(@obs, observaciones), usuario_decision_id = @usuario,
                fecha_decision = now(), tipo_aprobacion = @tipoAprobacion, acta_sesion = @acta
          WHERE solicitud_id = @id`,
        { estado, obs, usuario: actor.usuario_id, id: s.solicitud_id,
          tipoAprobacion: tipoAprobacion ? String(tipoAprobacion).slice(0, 50) : null,
          acta: actaSesion ? String(actaSesion).slice(0, 100) : null });
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: d, entidadTipo: 'SOLICITUD_CREDITO',
        entidadId: c, campo: 'estado', anterior: s.estado, nuevo: estado, detalle: obs });
      return { codigo: c, estado };
    });
  }

  async function desembolsar(token, codigo, { numeroCuenta } = {}, contexto = {}) {
    const c = codigoValido(codigo, 'SOL');
    const nCuenta = Number(numeroCuenta);
    if (!Number.isSafeInteger(nCuenta) || nCuenta < 1) throw new ErrorSolicitud('numeroCuenta invalido');

    return conRoles(token, contexto, ROLES_DECISION, 'DESEMBOLSO_CREDITO', async (tx, actor) => {
      const s = (await tx.query(
        `SELECT s.solicitud_id, s.estado, s.socio_id, s.monto::text AS monto, s.tasa::text AS tasa, s.plazo, s.tipo,
                s.segmento, s.tipo_aprobacion, s.acta_sesion, so.estado AS estado_socio
           FROM tecnifin.solicitudes_credito s
           JOIN tecnifin.socios so ON so.cooperativa_id = s.cooperativa_id AND so.socio_id = s.socio_id
          WHERE s.codigo = @c FOR UPDATE OF s`, { c })).rows[0];
      if (!s) return { error: new ErrorNoEncontrado() };
      if (s.estado !== 'APROBADO') throw new ErrorConflicto(`Solo se desembolsa una solicitud APROBADA (esta ${s.estado})`);
      if (s.estado_socio !== 'ACTIVO') throw new ErrorConflicto(`El socio esta ${s.estado_socio}`);
      if (!FAMILIA_CARTERA[s.segmento]) throw new ErrorConflicto('La solicitud no tiene segmento SEPS');

      const cuenta = (await tx.query(
        `SELECT c.cuenta_id, c.socio_id, c.estado, c.numero_cuenta, p.es_certificado, p.permite_depositos, p.cuenta_activa
           FROM tecnifin.cuentas c
           JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
          WHERE c.numero_cuenta = @n FOR UPDATE OF c`, { n: nCuenta })).rows[0];
      if (!cuenta || String(cuenta.socio_id) !== String(s.socio_id)) {
        throw new ErrorConflicto('La cuenta de acreditacion debe ser del mismo socio');
      }
      if (cuenta.estado !== 'ACTIVA' || cuenta.es_certificado || !cuenta.permite_depositos) {
        throw new ErrorConflicto('La cuenta de acreditacion debe ser de ahorro, activa y admitir depositos');
      }

      // Bandas de la familia por vencer del segmento, leidas del plan de ESTA cooperativa.
      const familia = FAMILIA_CARTERA[s.segmento].POR_VENCER;
      const bandas = bandasDesdePlan((await tx.query(
        `SELECT codigo, nombre FROM tecnifin.plan_cuentas WHERE length(codigo) = 6 AND codigo LIKE @f || '%' AND activa`,
        { f: familia })).rows);
      if (!bandas[familia]) throw new ErrorConflicto(`El plan de cuentas no tiene las bandas de ${familia}`);

      const { filas } = amortizacionFrancesa(s.monto, s.tasa, s.plazo);
      const fechas = (await tx.query(
        `SELECT n, (${HOY} + make_interval(months => n))::date::text AS fecha,
                ((${HOY} + make_interval(months => n))::date - ${HOY}) AS dias
           FROM generate_series(1, @plazo) AS n ORDER BY n`, { plazo: s.plazo })).rows;
      const cuotas = filas.map((f, i) => ({ ...f, fecha: fechas[i].fecha,
        cuenta: cuentaPorBanda(bandas, familia, Number(fechas[i].dias)) }));

      const descuentos = (await tx.query(
        `SELECT codigo, nombre, cuenta_contable, round(@monto::numeric * porcentaje / 100, 2)::text AS valor
           FROM tecnifin.descuentos_credito WHERE activo ORDER BY codigo`, { monto: s.monto })).rows;
      const neto = (await tx.query(
        `SELECT (@monto::numeric - coalesce(sum(v), 0))::numeric(18,2)::text AS neto,
                @monto::numeric - coalesce(sum(v), 0) > 0 AS positivo
           FROM unnest(@valores::numeric[]) AS v`, { monto: s.monto, valores: descuentos.map(x => x.valor) })).rows[0];
      if (!neto.positivo) throw new ErrorConflicto('Los descuentos no pueden igualar o superar el monto');

      const credito = (await tx.query(
        `INSERT INTO tecnifin.creditos (codigo, solicitud_id, socio_id, monto, saldo, tasa, plazo, tipo, estado,
                                        fecha_desembolso, fecha_vencimiento, tipo_aprobacion, acta_sesion, segmento,
                                        cuenta_acreditacion_id)
         VALUES ('CRED-' || lpad(tecnifin.siguiente_numero('credito')::text, 6, '0'), @solicitud, @socio,
                 @monto::numeric, @monto::numeric, @tasa::numeric, @plazo, @tipo, 'VIGENTE', ${HOY}, @vence::date,
                 @tipoAprobacion, @acta, @segmento, @cuenta)
         RETURNING credito_id, codigo, fecha_desembolso::text AS fecha_desembolso`,
        { solicitud: s.solicitud_id, socio: s.socio_id, monto: s.monto, tasa: s.tasa, plazo: s.plazo, tipo: s.tipo,
          vence: cuotas.at(-1).fecha, tipoAprobacion: s.tipo_aprobacion, acta: s.acta_sesion, segmento: s.segmento,
          cuenta: cuenta.cuenta_id })).rows[0];

      const texto = (ct) => `${Math.trunc(ct / 100)}.${String(ct % 100).padStart(2, '0')}`;
      await tx.query(
        `INSERT INTO tecnifin.tabla_amortizacion (credito_id, numero_cuota, fecha_pago, capital, interes, total, estado, cuenta_capital)
         SELECT @credito, x.numero, x.fecha::date, x.capital::numeric, x.interes::numeric, x.total::numeric, 'PENDIENTE', x.cuenta
           FROM jsonb_to_recordset(@cuotas::jsonb) AS x(numero int, fecha text, capital text, interes text, total text, cuenta text)`,
        { credito: credito.credito_id, cuotas: JSON.stringify(cuotas.map(q => ({ numero: q.numero, fecha: q.fecha,
          capital: texto(q.capital), interes: texto(q.interes), total: texto(q.total), cuenta: q.cuenta }))) });

      const saldo = (await tx.query(
        `UPDATE tecnifin.cuentas SET saldo = saldo + @neto::numeric WHERE cuenta_id = @cuenta RETURNING saldo::text AS saldo`,
        { neto: neto.neto, cuenta: cuenta.cuenta_id })).rows[0].saldo;

      // Debe: capital por banda. Haber: el neto a la cuenta de ahorros y cada descuento a su cuenta.
      const glosa = `Desembolso del credito ${credito.codigo} (${c})`;
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: credito.codigo,
        tipoDocumento: 'DESEMBOLSO_CREDITO', lineas: [
          ...cuotas.map(q => ({ codigo: q.cuenta, tipo: 'D', valor: texto(q.capital), socioId: s.socio_id })),
          { codigo: cuenta.cuenta_activa, tipo: 'H', valor: neto.neto, socioId: s.socio_id },
          ...descuentos.map(x => ({ codigo: x.cuenta_contable, tipo: 'H', valor: x.valor, socioId: s.socio_id })),
        ] });
      await tx.query(`UPDATE tecnifin.creditos SET asiento_desembolso_id = @a WHERE credito_id = @id`,
        { a: asiento, id: credito.credito_id });
      await tx.query(
        `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
         VALUES (@cuenta, 'TRANSFERENCIA_ENTRADA', @neto::numeric, @saldo::numeric, @concepto, @usuario, @a)`,
        { cuenta: cuenta.cuenta_id, neto: neto.neto, saldo, concepto: glosa, usuario: actor.usuario_id, a: asiento });
      await tx.query(`UPDATE tecnifin.solicitudes_credito SET estado = 'DESEMBOLSADO', descuentos_desembolso = @d,
                        fecha_vencimiento = @vence::date WHERE solicitud_id = @id`,
        { d: JSON.stringify(descuentos.map(x => ({ codigo: x.codigo, valor: x.valor }))), vence: cuotas.at(-1).fecha,
          id: s.solicitud_id });
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'DESEMBOLSAR', entidadTipo: 'CREDITO',
        entidadId: credito.codigo, nuevo: s.monto, detalle: `Neto ${neto.neto} a la cuenta ${cuenta.numero_cuenta}.` });

      return { credito: credito.codigo, solicitud: c, monto: s.monto, neto: neto.neto,
        descuentos: descuentos.map(x => ({ codigo: x.codigo, nombre: x.nombre, valor: x.valor })),
        numeroCuenta: Number(cuenta.numero_cuenta), saldoCuenta: saldo, fechaDesembolso: credito.fecha_desembolso,
        fechaVencimiento: cuotas.at(-1).fecha, cuotas: cuotas.length };
    });
  }

  async function verCredito(token, codigo, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    return analisis(token, contexto, 'CONSULTA_CREDITOS', async tx => {
      const cr = (await tx.query(
        `SELECT cr.credito_id, cr.codigo, cr.estado, cr.monto::text AS monto, cr.saldo::text AS saldo, cr.tasa::text AS tasa,
                cr.plazo, cr.tipo, cr.segmento, cr.fecha_desembolso::text AS desembolso, cr.fecha_vencimiento::text AS vence,
                so.numero_socio
           FROM tecnifin.creditos cr
           JOIN tecnifin.socios so ON so.cooperativa_id = cr.cooperativa_id AND so.socio_id = cr.socio_id
          WHERE cr.codigo = @c`, { c })).rows[0];
      if (!cr) return { error: new ErrorNoEncontrado() };
      const tabla = (await tx.query(
        `SELECT numero_cuota AS numero, fecha_pago::text AS fecha, capital::text AS capital, interes::text AS interes,
                total::text AS total, estado, cuenta_capital AS "cuentaCapital"
           FROM tecnifin.tabla_amortizacion WHERE credito_id = @id ORDER BY numero_cuota`, { id: cr.credito_id })).rows;
      return { codigo: cr.codigo, estado: cr.estado, numeroSocio: Number(cr.numero_socio), linea: cr.tipo,
        segmento: cr.segmento, monto: cr.monto, saldo: cr.saldo, tasa: cr.tasa, plazo: cr.plazo,
        fechaDesembolso: cr.desembolso, fechaVencimiento: cr.vence, tabla };
    });
  }

  // Pago de las n cuotas pendientes siguientes, completas y en orden. Por caja (efectivo,
  // entra al cuadre de la caja) o por debito a una cuenta de ahorro del socio. El capital se
  // descarga de la misma subcuenta de banda donde se contabilizo cada cuota.
  async function pagarCuotas(token, codigo, { cuotas = 1, origen = 'CAJA', numeroCuenta, efectivo } = {}, contexto = {}) {
    const c = codigoValido(codigo, 'CRED');
    const n = Number(cuotas);
    if (!Number.isInteger(n) || n < 1 || n > 600) throw new ErrorSolicitud('cuotas debe ser un entero positivo');
    const via = String(origen).toUpperCase();
    if (!['CAJA', 'CUENTA'].includes(via)) throw new ErrorSolicitud('origen debe ser CAJA o CUENTA');
    const detalle = via === 'CAJA' ? efectivoValido(efectivo) : null;

    return conRoles(token, contexto, ROLES_COBRO, 'PAGO_CREDITO', async (tx, actor) => {
      const cr = (await tx.query(
        `SELECT credito_id, codigo, estado, socio_id, segmento FROM tecnifin.creditos WHERE codigo = @c FOR UPDATE`,
        { c })).rows[0];
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      const pendientes = (await tx.query(
        `SELECT amortizacion_id, numero_cuota, capital::text AS capital, interes::text AS interes, cuenta_capital
           FROM tecnifin.tabla_amortizacion WHERE credito_id = @id AND estado IN ('PENDIENTE', 'VENCIDA')
          ORDER BY numero_cuota LIMIT @n FOR UPDATE`, { id: cr.credito_id, n })).rows;
      if (pendientes.length < n) throw new ErrorConflicto(`Solo quedan ${pendientes.length} cuota(s) por pagar`);
      if (pendientes.some(q => !q.cuenta_capital)) throw new ErrorConflicto('El credito no tiene la cuenta contable de sus cuotas');
      const suma = (await tx.query(
        `SELECT sum(capital)::numeric(18,2)::text AS capital, sum(interes)::numeric(18,2)::text AS interes,
                sum(capital + interes)::numeric(18,2)::text AS total
           FROM jsonb_to_recordset(@q::jsonb) AS x(capital numeric, interes numeric)`,
        { q: JSON.stringify(pendientes.map(q => ({ capital: q.capital, interes: q.interes }))) })).rows[0];

      let cuentaDebito; let transaccionId = null; let cuentaId = null; let comprobante = null; let saldoCuenta = null;
      if (via === 'CAJA') {
        const control = await cajaAbierta(tx, actor);
        if (!control) throw new ErrorConflicto('Abra su caja del dia antes de cobrar');
        let filasEfectivo = [];
        if (detalle) {
          const { suma: contado, filas } = await totalEfectivo(tx, detalle);
          if (!await mismoValor(tx, contado, suma.total)) throw new ErrorSolicitud(`El efectivo suma ${contado}, no ${suma.total}`);
          filasEfectivo = filas;
        }
        const t = (await tx.query(
          `INSERT INTO tecnifin.transacciones_caja (control_caja_id, socio_id, credito_id, tipo_operacion, monto, usuario_id, concepto)
           VALUES (@control, @socio, @credito, 'PAGO_CREDITO', @total::numeric, @usuario, @concepto)
           RETURNING transaccion_id, numero_comprobante`,
          { control: control.control_id, socio: cr.socio_id, credito: cr.credito_id, total: suma.total,
            usuario: actor.usuario_id, concepto: `Pago del credito ${c}` })).rows[0];
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

      const desde = pendientes[0].numero_cuota;
      const hasta = pendientes.at(-1).numero_cuota;
      const glosa = `Pago del credito ${c}, cuotas ${desde} a ${hasta}`;
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: c,
        tipoDocumento: 'PAGO_CREDITO', lineas: [
          { codigo: cuentaDebito, tipo: 'D', valor: suma.total, socioId: cr.socio_id },
          ...pendientes.map(q => ({ codigo: q.cuenta_capital, tipo: 'H', valor: q.capital, socioId: cr.socio_id })),
          { codigo: CUENTA_INTERES[cr.segmento], tipo: 'H', valor: suma.interes, socioId: cr.socio_id },
        ] });
      if (transaccionId) {
        await tx.query(`UPDATE tecnifin.transacciones_caja SET asiento_contable_id = @a WHERE transaccion_id = @t`,
          { a: asiento, t: transaccionId });
      } else {
        await tx.query(
          `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
           VALUES (@cuenta, 'TRANSFERENCIA_SALIDA', @total::numeric, @saldo::numeric, @concepto, @usuario, @a)`,
          { cuenta: cuentaId, total: suma.total, saldo: saldoCuenta, concepto: glosa, usuario: actor.usuario_id, a: asiento });
      }
      const pago = (await tx.query(
        `INSERT INTO tecnifin.pagos_credito (credito_id, cuota_desde, cuota_hasta, capital, interes, total, origen,
                                            transaccion_caja_id, cuenta_id, asiento_id, usuario_id)
         VALUES (@credito, @desde, @hasta, @capital::numeric, @interes::numeric, @total::numeric, @origen, @t, @cuenta, @a, @usuario)
         RETURNING pago_id, numero_pago`,
        { credito: cr.credito_id, desde, hasta, capital: suma.capital, interes: suma.interes, total: suma.total,
          origen: via, t: transaccionId, cuenta: cuentaId, a: asiento, usuario: actor.usuario_id })).rows[0];
      await tx.query(
        `UPDATE tecnifin.tabla_amortizacion SET estado = 'PAGADA', interes_pagado = interes, pago_id = @pago
          WHERE amortizacion_id = ANY(@ids::bigint[])`, { pago: pago.pago_id, ids: pendientes.map(q => q.amortizacion_id) });
      const credito = (await tx.query(
        `UPDATE tecnifin.creditos
            SET saldo = saldo - @capital::numeric,
                estado = CASE WHEN saldo - @capital::numeric = 0 THEN 'CANCELADO' ELSE estado END
          WHERE credito_id = @id RETURNING saldo::text AS saldo, estado`,
        { capital: suma.capital, id: cr.credito_id })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'PAGAR', entidadTipo: 'CREDITO', entidadId: c,
        campo: 'saldo', nuevo: credito.saldo, detalle: `Pago ${pago.numero_pago} por ${via}: ${suma.total}.` });
      return { pago: Number(pago.numero_pago), credito: c, cuotas: [desde, hasta], capital: suma.capital,
        interes: suma.interes, total: suma.total, origen: via, comprobante, saldoCredito: credito.saldo,
        estadoCredito: credito.estado };
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
        `SELECT p.*, p.capital::text AS capital_t, p.interes::text AS interes_t, p.total::text AS total_t,
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

      const cuotas = (await tx.query(
        `SELECT capital::text AS capital, cuenta_capital FROM tecnifin.tabla_amortizacion WHERE pago_id = @p`,
        { p: p.pago_id })).rows;
      let cuentaDebito;
      if (p.origen === 'CAJA') {
        const t = (await tx.query(
          `SELECT t.transaccion_id, cc.estado FROM tecnifin.transacciones_caja t
             JOIN tecnifin.control_caja cc ON cc.cooperativa_id = t.cooperativa_id AND cc.control_id = t.control_caja_id
            WHERE t.transaccion_id = @t FOR UPDATE OF t`, { t: p.transaccion_caja_id })).rows[0];
        if (t.estado !== 'ABIERTO') throw new ErrorConflicto('La caja que cobro ya esta cerrada');
        await tx.query(
          `UPDATE tecnifin.transacciones_caja SET anulado = true, motivo_anulacion = @m, fecha_anulacion = now(),
                  usuario_anulacion_id = @u WHERE transaccion_id = @t`, { m: razon, u: actor.usuario_id, t: t.transaccion_id });
        cuentaDebito = (await tx.query(
          `SELECT valor FROM tecnifin.parametros_cooperativa WHERE clave = 'caja.cuenta_efectivo'`)).rows[0]?.valor || '110105';
      } else {
        const c = (await tx.query(
          `UPDATE tecnifin.cuentas SET saldo = saldo + @total::numeric WHERE cuenta_id = @id
            RETURNING saldo::text AS saldo, (SELECT cuenta_activa FROM tecnifin.productos_financieros pf
                                               WHERE pf.cooperativa_id = cuentas.cooperativa_id AND pf.producto_id = cuentas.producto_id) AS cuenta_activa`,
          { total: p.total_t, id: p.cuenta_id })).rows[0];
        cuentaDebito = c.cuenta_activa;
        p.saldoCuenta = c.saldo;
      }
      const glosa = `Anulacion del pago ${numero} del credito ${p.codigo}: ${razon}`;
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: p.codigo,
        tipoDocumento: 'ANULACION_PAGO_CREDITO', lineas: [
          ...cuotas.map(q => ({ codigo: q.cuenta_capital, tipo: 'D', valor: q.capital, socioId: p.socio_id })),
          { codigo: CUENTA_INTERES[p.segmento], tipo: 'D', valor: p.interes_t, socioId: p.socio_id },
          { codigo: cuentaDebito, tipo: 'H', valor: p.total_t, socioId: p.socio_id },
        ] });
      if (p.origen === 'CUENTA') {
        await tx.query(
          `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id, asiento_contable_id)
           VALUES (@cuenta, 'AJUSTE', @total::numeric, @saldo::numeric, @concepto, @usuario, @a)`,
          { cuenta: p.cuenta_id, total: p.total_t, saldo: p.saldoCuenta, concepto: glosa.slice(0, 200),
            usuario: actor.usuario_id, a: asiento });
      }
      await tx.query(
        `UPDATE tecnifin.tabla_amortizacion SET estado = 'PENDIENTE', interes_pagado = NULL, pago_id = NULL WHERE pago_id = @p`,
        { p: p.pago_id });
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

  return { lineasCredito, simular, crearSolicitud, verSolicitud, decidir, desembolsar, verCredito, pagarCuotas, anularPago };
}
