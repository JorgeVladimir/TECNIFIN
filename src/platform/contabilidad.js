// Contabilizacion comun a todos los modulos que mueven dinero (patron 05). Una sola forma
// de abrir el periodo, encontrar una cuenta y escribir un asiento; la base garantiza el
// cuadre (trigger diferido) y que no se use una cuenta de agrupacion.
import { ErrorConflicto } from './autenticacion.js';

// Fecha de negocio: hoy en Ecuador (UTC-5, sin horario de verano).
export const HOY = `(now() AT TIME ZONE 'America/Guayaquil')::date`;

// Periodo contable del dia: se crea si no existe; cerrado = no se contabiliza nada.
export async function periodoDelDia(tx) {
  const fila = (await tx.query(
    `SELECT periodo_id, cerrado FROM tecnifin.periodos_contables
      WHERE anio = extract(year FROM ${HOY})::int AND mes = extract(month FROM ${HOY})::int`)).rows[0];
  if (fila?.cerrado) throw new ErrorConflicto('El periodo contable del mes esta cerrado');
  if (fila) return fila.periodo_id;
  return (await tx.query(
    `INSERT INTO tecnifin.periodos_contables (anio, mes)
     VALUES (extract(year FROM ${HOY})::int, extract(month FROM ${HOY})::int)
     ON CONFLICT (cooperativa_id, anio, mes) DO UPDATE SET cerrado = periodos_contables.cerrado
     RETURNING periodo_id`)).rows[0].periodo_id;
}

export async function cuentaContableId(tx, codigo) {
  const fila = (await tx.query(
    `SELECT cuenta_contable_id FROM tecnifin.plan_cuentas WHERE codigo = @codigo AND activa`, { codigo })).rows[0];
  if (!fila) throw new ErrorConflicto(`La cuenta contable ${codigo} no existe o esta inactiva en el plan de cuentas`);
  return fila.cuenta_contable_id;
}

// Asiento de n lineas. lineas: [{ codigo, tipo: 'D'|'H', valor (texto), socioId }].
// Las lineas del mismo codigo y lado se agrupan para que el libro no se llene de filas iguales.
export async function asentar(tx, actor, { concepto, origenModulo, origenId, tipoDocumento, lineas }) {
  const periodo = await periodoDelDia(tx);
  const asiento = (await tx.query(
    `INSERT INTO tecnifin.asientos_contables (periodo_contable_id, fecha, tipo_documento, concepto, usuario_id, origen_modulo, origen_id)
     VALUES (@periodo, ${HOY}, @tipo, @concepto, @usuario, @origen, @origenId) RETURNING asiento_id`,
    { periodo, tipo: tipoDocumento, concepto: concepto.slice(0, 300), usuario: actor.usuario_id,
      origen: origenModulo, origenId: String(origenId) })).rows[0].asiento_id;
  const ids = new Map();
  for (const l of lineas) if (!ids.has(l.codigo)) ids.set(l.codigo, await cuentaContableId(tx, l.codigo));
  await tx.query(
    `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor, socio_id)
     SELECT @asiento, x.cuenta, x.tipo, sum(x.valor)::numeric(18,2), x.socio
       FROM jsonb_to_recordset(@lineas::jsonb) AS x(cuenta integer, tipo char(1), valor numeric, socio bigint)
      WHERE x.valor > 0
      GROUP BY x.cuenta, x.tipo, x.socio`,
    { asiento, lineas: JSON.stringify(lineas.map(l => ({ cuenta: ids.get(l.codigo), tipo: l.tipo,
      valor: l.valor, socio: l.socioId ?? null }))) });
  return asiento;
}

// Lineas del asiento contrario exacto de otro (anulaciones y reversos): misma cuenta, valor y
// socio, con Debe y Haber intercambiados. Una sola implementacion (regla 13).
export async function lineasInversas(tx, asientoId) {
  return (await tx.query(
    `SELECT pc.codigo, CASE d.tipo_asiento WHEN 'D' THEN 'H' ELSE 'D' END AS tipo, d.valor::text AS valor, d.socio_id AS "socioId"
       FROM tecnifin.detalle_asiento d
       JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE d.asiento_id = @a ORDER BY d.detalle_id`, { a: asientoId })).rows;
}
