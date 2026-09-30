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
import { montoValido } from '../caja/servicio.js';
import { crearCobroCreditos } from './cobro.js';
import {
  amortizacionFrancesa, bandasDesdePlan, cuentaPorBanda, FAMILIA_CARTERA, tablaEnTexto,
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

  const cobro = crearCobroCreditos({ conRoles, codigoValido, ROLES_COBRO, ROLES_DECISION });

  return { lineasCredito, simular, crearSolicitud, verSolicitud, decidir, desembolsar, verCredito, ...cobro };
}
