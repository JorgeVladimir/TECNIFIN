// Lado del dinero de cualquier cobro a un socio (cuotas, cancelacion, abono, recuperacion de
// castigados): efectivo en la caja abierta del cajero o debito a una cuenta de ahorro del mismo
// socio. Una sola implementacion (regla 13); antes cartera tenia su propia copia.
import { ErrorConflicto, ErrorSolicitud } from '../../platform/autenticacion.js';
import { cajaAbierta, efectivoValido, mismoValor, totalEfectivo } from './servicio.js';

export function entradaOrigen({ origen = 'CAJA', efectivo }) {
  const via = String(origen).toUpperCase();
  if (!['CAJA', 'CUENTA'].includes(via)) throw new ErrorSolicitud('origen debe ser CAJA o CUENTA');
  return { via, detalle: via === 'CAJA' ? efectivoValido(efectivo) : null };
}

// Lado del dinero de un cobro: efectivo en la caja abierta del cajero (con su comprobante y,
// si viene, el detalle de billetes) o debito a una cuenta de ahorro del mismo socio. Devuelve
// la cuenta contable que va al Debe del asiento.
export async function debitarOrigen(tx, actor, cr, total, { via, numeroCuenta, detalle, concepto, tipoOperacion = 'PAGO_CREDITO' }) {
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
       VALUES (@control, @socio, @credito, @tipoOperacion, @total::numeric, @usuario, @concepto)
       RETURNING transaccion_id, numero_comprobante`,
      { control: control.control_id, socio: cr.socio_id, credito: cr.credito_id, total: suma.total,
        usuario: actor.usuario_id, concepto, tipoOperacion })).rows[0];
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
export async function enlazarOrigen(tx, actor, { transaccionId, cuentaId, saldoCuenta, total, glosa, asiento }) {
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
