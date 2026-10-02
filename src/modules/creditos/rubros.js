// M3 · rubros por cuota (patron 06 §7, migracion 0030): seguro, gastos y contribuciones que se
// cobran con cada cuota, definidos por la cooperativa en rubros_cuota_config. Todo el calculo de
// importes en numeric (SQL), nunca en coma flotante.

// Rubros de cada cuota al desembolsar. cuotas: [{ id, saldoInicial }] (saldo de capital con que
// empieza la cuota). Inserta en rubros_creditos con la base y el valor vigentes hoy.
export async function generarRubros(tx, monto, cuotas) {
  await tx.query(
    `INSERT INTO tecnifin.rubros_creditos (amortizacion_id, nombre_rubro, monto, estado, codigo, base, valor, cuenta_contable)
     SELECT x.id, r.nombre,
            round(CASE r.base WHEN 'FIJO' THEN r.valor
                              WHEN 'PORCENTAJE_MONTO' THEN @monto::numeric * r.valor / 100
                              ELSE x.saldo * r.valor / 100 END, 2),
            'PENDIENTE', r.codigo, r.base, r.valor, r.cuenta_contable
       FROM jsonb_to_recordset(@q::jsonb) AS x(id bigint, saldo numeric)
       CROSS JOIN tecnifin.rubros_cuota_config r
      WHERE r.activo`,
    { monto, q: JSON.stringify(cuotas.map(c => ({ id: c.id, saldo: c.saldoInicial }))) });
  await recalcularTotales(tx, cuotas.map(c => c.id));
}

// total de la cuota = capital + interes + rubros vigentes (no ANULADO).
export async function recalcularTotales(tx, ids) {
  await tx.query(
    `UPDATE tecnifin.tabla_amortizacion ta
        SET total = ta.capital + ta.interes + coalesce((SELECT sum(r.monto) FROM tecnifin.rubros_creditos r
                                                         WHERE r.amortizacion_id = ta.amortizacion_id AND r.estado <> 'ANULADO'), 0)
      WHERE ta.amortizacion_id = ANY(@ids::bigint[])`, { ids });
}

// Rubros pendientes de las cuotas que se cobran, agrupados por cuenta.
export async function rubrosPorCobrar(tx, ids) {
  const filas = (await tx.query(
    `SELECT cuenta_contable AS codigo, sum(monto)::numeric(18,2)::text AS valor
       FROM tecnifin.rubros_creditos WHERE amortizacion_id = ANY(@ids::bigint[]) AND estado = 'PENDIENTE'
      GROUP BY cuenta_contable ORDER BY cuenta_contable`, { ids })).rows;
  const total = (await tx.query(
    `SELECT coalesce(sum(v), 0)::numeric(18,2)::text AS t FROM unnest(@v::numeric[]) AS v`,
    { v: filas.map(f => f.valor) })).rows[0].t;
  return { porCuenta: filas, total };
}

// Cierra los rubros de un pago: PAGADO los cobrados, ANULADO los que quedan sin efecto
// (cuotas futuras en una cancelacion anticipada). La anulacion del pago los devuelve.
export async function cerrarRubros(tx, pagoId, idsCobrados, idsSinEfecto = []) {
  await tx.query(
    `UPDATE tecnifin.rubros_creditos SET pago_id = @p,
            estado = CASE WHEN amortizacion_id = ANY(@cobro::bigint[]) THEN 'PAGADO' ELSE 'ANULADO' END
      WHERE estado = 'PENDIENTE' AND amortizacion_id = ANY(@todos::bigint[])`,
    { p: pagoId, cobro: idsCobrados, todos: [...idsCobrados, ...idsSinEfecto] });
}

export async function reabrirRubros(tx, pagoId) {
  const ids = (await tx.query(
    `UPDATE tecnifin.rubros_creditos SET estado = 'PENDIENTE', pago_id = NULL WHERE pago_id = @p RETURNING amortizacion_id`,
    { p: pagoId })).rows.map(r => r.amortizacion_id);
  return ids;
}

// Abono a capital: los rubros sobre saldo de las cuotas que cambian se recalculan con el saldo
// nuevo. Devuelve la foto antes/despues (para anular) sin escribir.
export async function rubrosTrasAbono(tx, cambios) {
  return (await tx.query(
    `SELECT r.rubro_id AS id, r.amortizacion_id AS cuota, r.monto::text AS antes,
            round(x.saldo * r.valor / 100, 2)::text AS despues
       FROM jsonb_to_recordset(@q::jsonb) AS x(id bigint, saldo numeric)
       JOIN tecnifin.rubros_creditos r ON r.amortizacion_id = x.id
      WHERE r.base = 'PORCENTAJE_SALDO' AND r.estado = 'PENDIENTE' AND x.saldo IS NOT NULL`,
    { q: JSON.stringify(cambios.map(c => ({ id: c.id, saldo: c.saldoNuevo }))) })).rows
    .filter(r => r.antes !== r.despues);
}

export async function fijarMontosRubros(tx, rubros, lado) {
  if (!rubros?.length) return;
  await tx.query(
    `UPDATE tecnifin.rubros_creditos r SET monto = (x.v->>(@lado::text))::numeric
       FROM (SELECT (e->>'id')::bigint AS id, e AS v FROM jsonb_array_elements(@q::jsonb) AS e) AS x
      WHERE r.rubro_id = x.id`, { q: JSON.stringify(rubros), lado });
}
