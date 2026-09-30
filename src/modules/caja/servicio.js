// M2 · caja y ventanilla (patron 05): el patron de todo movimiento de dinero.
//
// Reglas que no se negocian:
//  * el dinero nunca pasa por coma flotante: entra como texto con 2 decimales y la
//    aritmetica la hace PostgreSQL en numeric;
//  * la cuenta se bloquea (FOR UPDATE) antes de leer el saldo: dos cajeros sobre la misma
//    cuenta no pierden una operacion;
//  * cada operacion deja, en la misma transaccion: comprobante, movimiento de la cuenta,
//    asiento en partida doble (la base rechaza uno descuadrado), desglose de efectivo
//    verificado contra la tabla de denominaciones y auditoria;
//  * nada se borra: una anulacion es un asiento y un movimiento contrarios.
import {
  auditarProceso, crearAutenticador, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar as asentarComun, HOY } from '../../platform/contabilidad.js';

const ROLES_CAJA = new Set(['SUPER_USER', 'ADMIN', 'MANAGER', 'TELLER']);
// La anulacion la hace un supervisor, no quien cobro: separacion de funciones.
const ROLES_SUPERVISOR = new Set(['SUPER_USER', 'ADMIN', 'MANAGER']);
const TIPOS = { DEPOSITO: 'DEPOSITO_AHORROS', RETIRO: 'RETIRO_AHORROS' };
const CUENTA_EFECTIVO_DEFECTO = '110105';

// Dinero de entrada: texto o numero con hasta 2 decimales, positivo, hasta 15 enteros.
export function montoValido(valor, campo = 'monto') {
  const texto = typeof valor === 'number' ? String(valor) : String(valor ?? '').trim();
  if (!/^[0-9]{1,15}(\.[0-9]{1,2})?$/.test(texto) || /^0+(\.0+)?$/.test(texto)) {
    throw new ErrorSolicitud(`${campo} debe ser positivo y con hasta 2 decimales`);
  }
  return texto;
}

export function efectivoValido(efectivo, campo = 'efectivo') {
  if (efectivo === undefined || efectivo === null) return null;
  if (!Array.isArray(efectivo) || efectivo.length === 0 || efectivo.length > 20) {
    throw new ErrorSolicitud(`${campo}: entre 1 y 20 denominaciones`);
  }
  const vistos = new Set();
  return efectivo.map((e, i) => {
    const codigo = String(e?.codigo || '').toUpperCase();
    const cantidad = Number(e?.cantidad);
    if (!/^[A-Z0-9.]{1,10}$/.test(codigo) || vistos.has(codigo)) throw new ErrorSolicitud(`${campo}[${i}].codigo invalido`);
    if (!Number.isSafeInteger(cantidad) || cantidad < 1 || cantidad > 100000) {
      throw new ErrorSolicitud(`${campo}[${i}].cantidad invalida`);
    }
    vistos.add(codigo);
    return { codigo, cantidad };
  });
}

// Total del efectivo calculado con los valores de LA BASE, no con lo que diga el cliente.
export async function totalEfectivo(tx, efectivo) {
  const filas = (await tx.query(
    `SELECT e.codigo, e.cantidad, d.valor, (d.valor * e.cantidad)::numeric(18,2) AS total
       FROM jsonb_to_recordset(@efectivo::jsonb) AS e(codigo text, cantidad integer)
       LEFT JOIN tecnifin.denominaciones d ON d.codigo_denominacion = e.codigo AND d.activa`,
    { efectivo: JSON.stringify(efectivo) })).rows;
  const desconocida = filas.find(f => f.valor === null);
  if (desconocida) throw new ErrorSolicitud(`Denominacion inexistente o inactiva: ${desconocida.codigo}`);
  const suma = (await tx.query(`SELECT sum(t)::numeric(18,2)::text AS suma FROM unnest(@totales::numeric[]) AS t`,
    { totales: filas.map(f => f.total) })).rows[0].suma;
  return { suma, filas };
}

// Igualdad de dinero en numeric, no en coma flotante.
export async function mismoValor(tx, a, b) {
  return (await tx.query(`SELECT @a::numeric = @b::numeric AS igual`, { a, b })).rows[0].igual;
}

// Caja del dia del usuario, ABIERTA y bloqueada hasta el COMMIT (null si no hay).
export async function cajaAbierta(tx, actor) {
  return (await tx.query(
    `SELECT control_id, saldo_apertura, fecha::text AS fecha FROM tecnifin.control_caja
      WHERE usuario_id = @usuario AND fecha = ${HOY} AND estado = 'ABIERTO' FOR UPDATE`,
    { usuario: actor.usuario_id })).rows[0] || null;
}

export function crearServicioCaja({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });
  const enCaja = (token, contexto, concepto, op) => conRoles(token, contexto, ROLES_CAJA, concepto, op);


  // Codigo de la cuenta de efectivo: parametro de la cooperativa o 110105.
  async function cuentaEfectivo(tx) {
    const valor = (await tx.query(
      `SELECT valor FROM tecnifin.parametros_cooperativa WHERE clave = 'caja.cuenta_efectivo'`)).rows[0]?.valor;
    return valor || CUENTA_EFECTIVO_DEFECTO;
  }
  const cuentaContable = async (_tx, codigo) => codigo;

  // Asiento de dos lineas con origen CAJA, sobre la contabilidad comun.
  function asentar(tx, actor, { concepto, debe, haber, valor, socioId, origenId }) {
    return asentarComun(tx, actor, { concepto, origenModulo: 'CAJA', origenId, tipoDocumento: 'COMPROBANTE_CAJA',
      lineas: [{ codigo: debe, tipo: 'D', valor, socioId }, { codigo: haber, tipo: 'H', valor, socioId }] });
  }

  async function abrirCaja(token, { saldoApertura, efectivo } = {}, contexto = {}) {
    const saldo = saldoApertura === '0' || saldoApertura === 0 || saldoApertura === '0.00'
      ? '0.00' : montoValido(saldoApertura, 'saldoApertura');
    const detalle = efectivoValido(efectivo);
    return enCaja(token, contexto, 'APERTURA_CAJA', async (tx, actor) => {
      if (detalle) {
        const { suma } = await totalEfectivo(tx, detalle);
        if (!await mismoValor(tx, suma, saldo)) throw new ErrorSolicitud(`El efectivo suma ${suma}, no ${saldo}`);
      }
      const existente = (await tx.query(
        `SELECT estado FROM tecnifin.control_caja WHERE usuario_id = @usuario AND fecha = ${HOY}`,
        { usuario: actor.usuario_id })).rows[0];
      if (existente) throw new ErrorConflicto(`La caja de hoy ya fue ${existente.estado === 'ABIERTO' ? 'abierta' : 'cerrada'}`);
      const control = (await tx.query(
        `INSERT INTO tecnifin.control_caja (usuario_id, fecha, saldo_apertura)
         VALUES (@usuario, ${HOY}, @saldo::numeric) RETURNING control_id, fecha::text AS fecha, saldo_apertura`,
        { usuario: actor.usuario_id, saldo })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'CAJA', accion: 'APERTURA', entidadTipo: 'CONTROL_CAJA',
        entidadId: control.control_id, nuevo: control.saldo_apertura, detalle: `Apertura de caja de ${actor.login}.` });
      return { fecha: control.fecha, estado: 'ABIERTO', saldoApertura: control.saldo_apertura };
    });
  }

  // Totales de una caja en SQL: dinero en numeric hasta el final.
  async function totales(tx, controlId) {
    return (await tx.query(
      `SELECT count(*) FILTER (WHERE NOT anulado)::int AS operaciones,
              count(*) FILTER (WHERE anulado)::int AS anuladas,
              coalesce(sum(monto) FILTER (WHERE NOT anulado AND tipo_operacion IN ('DEPOSITO_AHORROS', 'PAGO_CREDITO')), 0)::numeric(18,2)::text AS ingresos,
              coalesce(sum(monto) FILTER (WHERE NOT anulado AND tipo_operacion = 'RETIRO_AHORROS'), 0)::numeric(18,2)::text AS egresos
         FROM tecnifin.transacciones_caja WHERE control_caja_id = @control`, { control: controlId })).rows[0];
  }

  async function estadoCaja(token, contexto = {}) {
    return enCaja(token, contexto, 'CONSULTA_CAJA', async (tx, actor) => {
      const control = (await tx.query(
        `SELECT control_id, estado, saldo_apertura, saldo_cierre, saldo_esperado, fecha::text AS fecha
           FROM tecnifin.control_caja WHERE usuario_id = @usuario AND fecha = ${HOY}`,
        { usuario: actor.usuario_id })).rows[0];
      if (!control) return { estado: 'SIN_ABRIR' };
      const t = await totales(tx, control.control_id);
      const esperado = (await tx.query(`SELECT (@a::numeric + @i::numeric - @e::numeric)::numeric(18,2)::text AS v`,
        { a: control.saldo_apertura, i: t.ingresos, e: t.egresos })).rows[0].v;
      return { fecha: control.fecha, estado: control.estado, saldoApertura: control.saldo_apertura,
        ingresos: t.ingresos, egresos: t.egresos, saldoEsperado: esperado, operaciones: t.operaciones,
        anuladas: t.anuladas, saldoCierre: control.saldo_cierre };
    });
  }

  async function registrarTransaccion(token, entrada = {}, contexto = {}) {
    const tipo = String(entrada.tipo || '').toUpperCase();
    if (!TIPOS[tipo]) throw new ErrorSolicitud('tipo debe ser DEPOSITO o RETIRO');
    const monto = montoValido(entrada.monto);
    const numeroCuenta = Number(entrada.numeroCuenta);
    if (!Number.isSafeInteger(numeroCuenta) || numeroCuenta < 1) throw new ErrorSolicitud('numeroCuenta invalido');
    const detalle = efectivoValido(entrada.efectivo);
    const concepto = entrada.concepto ? String(entrada.concepto).trim().slice(0, 200) : null;

    return enCaja(token, contexto, 'TRANSACCION_CAJA', async (tx, actor) => {
      const control = await cajaAbierta(tx, actor);
      if (!control) throw new ErrorConflicto('Abra su caja del dia antes de operar');

      // FOR UPDATE: la fila de la cuenta queda bloqueada hasta el COMMIT.
      const cuenta = (await tx.query(
        `SELECT c.cuenta_id, c.numero_cuenta, c.saldo, c.estado, c.socio_id,
                p.nombre AS producto, p.es_certificado, p.permite_depositos, p.permite_retiros, p.cuenta_activa,
                s.numero_socio, s.estado AS estado_socio
           FROM tecnifin.cuentas c
           JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
           JOIN tecnifin.socios s ON s.cooperativa_id = c.cooperativa_id AND s.socio_id = c.socio_id
          WHERE c.numero_cuenta = @numero
          FOR UPDATE OF c`, { numero: numeroCuenta })).rows[0];
      if (!cuenta) return { error: new ErrorNoEncontrado() };
      if (cuenta.estado !== 'ACTIVA') throw new ErrorConflicto(`La cuenta esta ${cuenta.estado}`);
      if (cuenta.estado_socio !== 'ACTIVO') throw new ErrorConflicto(`El socio esta ${cuenta.estado_socio}`);
      if (tipo === 'DEPOSITO' && !cuenta.permite_depositos) throw new ErrorConflicto('El producto no admite depositos');
      if (tipo === 'RETIRO' && (cuenta.es_certificado || !cuenta.permite_retiros)) {
        throw new ErrorConflicto('El producto no admite retiros en ventanilla');
      }

      let filasEfectivo = [];
      if (detalle) {
        const { suma, filas } = await totalEfectivo(tx, detalle);
        if (!await mismoValor(tx, suma, monto)) throw new ErrorSolicitud(`El efectivo suma ${suma}, no ${monto}`);
        filasEfectivo = filas;
      }

      // Nuevo saldo en SQL; el WHERE impide dejarlo negativo aunque dos retiros compitan.
      const signo = tipo === 'DEPOSITO' ? '+' : '-';
      const actualizada = (await tx.query(
        `UPDATE tecnifin.cuentas SET saldo = saldo ${signo} @monto::numeric
          WHERE cuenta_id = @cuenta AND saldo ${signo} @monto::numeric >= 0
          RETURNING saldo`, { monto, cuenta: cuenta.cuenta_id })).rows[0];
      if (!actualizada) throw new ErrorConflicto('Saldo insuficiente');

      const transaccion = (await tx.query(
        `INSERT INTO tecnifin.transacciones_caja (control_caja_id, socio_id, cuenta_id, tipo_operacion, monto, usuario_id, concepto)
         VALUES (@control, @socio, @cuenta, @tipo, @monto::numeric, @usuario, @concepto)
         RETURNING transaccion_id, numero_comprobante,
                   to_char(fecha_hora AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD"T"HH24:MI:SS') || '-05:00' AS fecha`,
        { control: control.control_id, socio: cuenta.socio_id, cuenta: cuenta.cuenta_id, tipo: TIPOS[tipo],
          monto, usuario: actor.usuario_id, concepto })).rows[0];
      for (const f of filasEfectivo) {
        await tx.query(
          `INSERT INTO tecnifin.detalle_efectivo_transaccion (transaccion_id, codigo_denominacion, cantidad, total)
           VALUES (@t, @codigo, @cantidad, @total::numeric)`,
          { t: transaccion.transaccion_id, codigo: f.codigo, cantidad: f.cantidad, total: f.total });
      }

      const efectivoId = await cuentaEfectivo(tx);
      const productoId = await cuentaContable(tx, cuenta.cuenta_activa);
      const glosa = `${tipo === 'DEPOSITO' ? 'Deposito' : 'Retiro'} en ventanilla, comprobante ${transaccion.numero_comprobante}, cuenta ${cuenta.numero_cuenta}`;
      const asiento = await asentar(tx, actor, { concepto: glosa, valor: monto, socioId: cuenta.socio_id,
        origenId: transaccion.numero_comprobante,
        debe: tipo === 'DEPOSITO' ? efectivoId : productoId, haber: tipo === 'DEPOSITO' ? productoId : efectivoId });
      await tx.query(`UPDATE tecnifin.transacciones_caja SET asiento_contable_id = @a WHERE transaccion_id = @t`,
        { a: asiento, t: transaccion.transaccion_id });
      await tx.query(
        `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id,
                                                 transaccion_caja_id, asiento_contable_id)
         VALUES (@cuenta, @tipo, @monto::numeric, @saldo::numeric, @concepto, @usuario, @t, @a)`,
        { cuenta: cuenta.cuenta_id, tipo, monto, saldo: actualizada.saldo, concepto: concepto || glosa,
          usuario: actor.usuario_id, t: transaccion.transaccion_id, a: asiento });
      await auditarProceso(tx, actor, { proceso: 'CAJA', accion: tipo, entidadTipo: 'CUENTA',
        entidadId: cuenta.numero_cuenta, campo: 'saldo', anterior: cuenta.saldo, nuevo: actualizada.saldo,
        detalle: `Comprobante ${transaccion.numero_comprobante}.` });

      return { comprobante: Number(transaccion.numero_comprobante), fecha: transaccion.fecha, tipo, monto: (await tx.query(
        `SELECT @m::numeric(18,2)::text AS m`, { m: monto })).rows[0].m, numeroCuenta: Number(cuenta.numero_cuenta),
        producto: cuenta.producto, numeroSocio: Number(cuenta.numero_socio), saldo: actualizada.saldo };
    });
  }

  async function anularTransaccion(token, numeroComprobante, { motivo } = {}, contexto = {}) {
    const numero = Number(numeroComprobante);
    if (!Number.isSafeInteger(numero) || numero < 1) throw new ErrorSolicitud('Comprobante invalido');
    const razon = String(motivo || '').trim();
    if (razon.length < 5 || razon.length > 300) throw new ErrorSolicitud('motivo: entre 5 y 300 caracteres');

    return conRoles(token, contexto, ROLES_SUPERVISOR, 'ANULACION_CAJA', async (tx, actor) => {
      const t = (await tx.query(
        `SELECT t.transaccion_id, t.numero_comprobante, t.tipo_operacion, t.monto, t.anulado, t.cuenta_id, t.socio_id,
                t.usuario_id, cc.estado AS estado_caja, (cc.fecha = ${HOY}) AS es_de_hoy,
                c.numero_cuenta, p.cuenta_activa
           FROM tecnifin.transacciones_caja t
           JOIN tecnifin.control_caja cc ON cc.cooperativa_id = t.cooperativa_id AND cc.control_id = t.control_caja_id
           JOIN tecnifin.cuentas c ON c.cooperativa_id = t.cooperativa_id AND c.cuenta_id = t.cuenta_id
           JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id
          WHERE t.numero_comprobante = @numero
          FOR UPDATE OF t, cc, c`, { numero })).rows[0];
      if (!t) return { error: new ErrorNoEncontrado() };
      if (t.anulado) throw new ErrorConflicto('El comprobante ya esta anulado');
      if (!t.es_de_hoy || t.estado_caja !== 'ABIERTO') {
        throw new ErrorConflicto('Solo se anula en el dia y con la caja del cajero abierta');
      }
      if (String(t.usuario_id) === String(actor.usuario_id)) {
        throw new ErrorConflicto('Quien registro la operacion no puede anularla');
      }
      const eraDeposito = t.tipo_operacion === 'DEPOSITO_AHORROS';
      const revertida = (await tx.query(
        `UPDATE tecnifin.cuentas SET saldo = saldo ${eraDeposito ? '-' : '+'} @monto::numeric
          WHERE cuenta_id = @cuenta AND saldo ${eraDeposito ? '-' : '+'} @monto::numeric >= 0 RETURNING saldo`,
        { monto: t.monto, cuenta: t.cuenta_id })).rows[0];
      if (!revertida) throw new ErrorConflicto('El saldo actual no alcanza para revertir el deposito');

      const efectivoId = await cuentaEfectivo(tx);
      const productoId = await cuentaContable(tx, t.cuenta_activa);
      const glosa = `Anulacion del comprobante ${t.numero_comprobante}: ${razon}`.slice(0, 300);
      const asiento = await asentar(tx, actor, { concepto: glosa, valor: t.monto, socioId: t.socio_id,
        origenId: t.numero_comprobante,
        debe: eraDeposito ? productoId : efectivoId, haber: eraDeposito ? efectivoId : productoId });
      await tx.query(
        `UPDATE tecnifin.transacciones_caja
            SET anulado = true, motivo_anulacion = @motivo, fecha_anulacion = now(), usuario_anulacion_id = @usuario
          WHERE transaccion_id = @t`, { motivo: razon, usuario: actor.usuario_id, t: t.transaccion_id });
      await tx.query(
        `INSERT INTO tecnifin.movimientos_cuenta (cuenta_id, tipo, monto, saldo_resultante, concepto, usuario_id,
                                                 transaccion_caja_id, asiento_contable_id)
         VALUES (@cuenta, 'AJUSTE', @monto::numeric, @saldo::numeric, @concepto, @usuario, @t, @a)`,
        { cuenta: t.cuenta_id, monto: t.monto, saldo: revertida.saldo, concepto: glosa.slice(0, 200),
          usuario: actor.usuario_id, t: t.transaccion_id, a: asiento });
      await auditarProceso(tx, actor, { proceso: 'CAJA', accion: 'ANULAR', entidadTipo: 'COMPROBANTE_CAJA',
        entidadId: t.numero_comprobante, campo: 'saldo', nuevo: revertida.saldo, detalle: razon });
      return { comprobante: numero, anulado: true, numeroCuenta: Number(t.numero_cuenta), saldo: revertida.saldo };
    });
  }

  async function cerrarCaja(token, { efectivo, saldoContado } = {}, contexto = {}) {
    const detalle = efectivoValido(efectivo);
    if (!detalle && saldoContado === undefined) throw new ErrorSolicitud('Envie el efectivo contado');
    return enCaja(token, contexto, 'CIERRE_CAJA', async (tx, actor) => {
      const control = await cajaAbierta(tx, actor);
      if (!control) throw new ErrorConflicto('No hay caja abierta hoy');
      const contado = detalle ? (await totalEfectivo(tx, detalle)).suma
        : (saldoContado === '0' || saldoContado === 0 ? '0.00' : montoValido(saldoContado, 'saldoContado'));
      const t = await totales(tx, control.control_id);
      const cuadre = (await tx.query(
        `SELECT (@a::numeric + @i::numeric - @e::numeric)::numeric(18,2)::text AS esperado,
                (@c::numeric - (@a::numeric + @i::numeric - @e::numeric))::numeric(18,2)::text AS diferencia,
                @c::numeric(18,2)::text AS contado`,
        { a: control.saldo_apertura, i: t.ingresos, e: t.egresos, c: contado })).rows[0];
      await tx.query(
        `UPDATE tecnifin.control_caja SET estado = 'CERRADO', hora_cierre = now(),
                saldo_cierre = @contado::numeric, saldo_esperado = @esperado::numeric
          WHERE control_id = @id`, { contado: cuadre.contado, esperado: cuadre.esperado, id: control.control_id });
      await auditarProceso(tx, actor, { proceso: 'CAJA', accion: 'CIERRE', entidadTipo: 'CONTROL_CAJA',
        entidadId: control.control_id, anterior: cuadre.esperado, nuevo: cuadre.contado,
        detalle: `Cierre de ${actor.login}: diferencia ${cuadre.diferencia}.` });
      return { fecha: control.fecha, estado: 'CERRADO', saldoApertura: control.saldo_apertura,
        ingresos: t.ingresos, egresos: t.egresos, saldoEsperado: cuadre.esperado, saldoContado: cuadre.contado,
        diferencia: cuadre.diferencia, operaciones: t.operaciones };
    });
  }

  return { abrirCaja, estadoCaja, registrarTransaccion, anularTransaccion, cerrarCaja };
}
