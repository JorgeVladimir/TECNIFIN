// Auditoria contable de solo lectura: el mayor contra sus auxiliares, por cooperativa.
//
//   npm run auditoria                      # base de trabajo (.env) y base de demostracion
//   node tools/auditoria.mjs tecnifin_demo # una base concreta
//
// Sale con 1 si encuentra cualquier diferencia. Comprueba el esquema (invariantes, RLS+FORCE,
// restricciones sin validar, roles) y, en cada cooperativa: asientos cuadrados y con detalle,
// ahorros (saldo de las cuentas vs su cuenta contable), cartera 1401..1428 por subcuenta vs el
// capital pendiente de las cuotas, saldo de cada credito vs sus cuotas, intereses por cobrar
// 1603 vs lo devengado, suspenso 7109 vs lo reconocido en orden, depositos a plazo 2103,
// castigados 710310 vs lo castigado sin recuperar y rubros cobrados vs los pagos.
// Nacio como el auditor ad hoc del 1-oct-2026 que encontro la demo descuadrada (9000 vs 6111,74).
import { fileURLToPath } from 'node:url';
import { entornoAdmin } from './_env.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';

const MAYOR = (desde, hasta, signo = 'D') => `
  SELECT pc.codigo, sum(CASE WHEN d.tipo_asiento = '${signo}' THEN d.valor ELSE -d.valor END) AS saldo
    FROM tecnifin.detalle_asiento d
    JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
   WHERE pc.codigo >= '${desde}' AND pc.codigo < '${hasta}' GROUP BY pc.codigo`;
const CONTRA = (aux, mayor) => `
  WITH aux AS (${aux}), mayor AS (${mayor})
  SELECT coalesce(aux.codigo, mayor.codigo) AS codigo, coalesce(aux.saldo, 0)::text AS auxiliar,
         coalesce(mayor.saldo, 0)::text AS mayor
    FROM aux FULL JOIN mayor USING (codigo) WHERE coalesce(aux.saldo, 0) <> coalesce(mayor.saldo, 0)`;
const VIGENTES = `FROM tecnifin.tabla_amortizacion ta
  JOIN tecnifin.creditos cr ON cr.cooperativa_id = ta.cooperativa_id AND cr.credito_id = ta.credito_id
 WHERE cr.estado = 'VIGENTE' AND ta.estado IN ('PENDIENTE', 'VENCIDA')`;

const SEGMENTO = (prefijo) => `CASE cr.segmento WHEN 'COMERCIAL' THEN '${prefijo}05' WHEN 'CONSUMO' THEN '${prefijo}10'
  WHEN 'VIVIENDA' THEN '${prefijo}15' ELSE '${prefijo}20' END`;

// Cada control: nombre y consulta que devuelve una fila por diferencia.
export const CONTROLES = [
  ['asientos descuadrados', `SELECT asiento_id::text AS codigo, sum(CASE WHEN tipo_asiento = 'D' THEN valor ELSE -valor END)::text AS diferencia
     FROM tecnifin.detalle_asiento GROUP BY asiento_id HAVING sum(CASE WHEN tipo_asiento = 'D' THEN valor ELSE -valor END) <> 0`],
  ['asientos sin detalle', `SELECT a.asiento_id::text AS codigo FROM tecnifin.asientos_contables a
     WHERE NOT EXISTS (SELECT 1 FROM tecnifin.detalle_asiento d WHERE d.asiento_id = a.asiento_id)`],
  ['ahorros: cuentas vs mayor', CONTRA(
    `SELECT p.cuenta_activa AS codigo, sum(c.saldo) AS saldo FROM tecnifin.cuentas c
       JOIN tecnifin.productos_financieros p ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id GROUP BY 1`,
    `SELECT m.* FROM (${MAYOR('2', '4', 'H')}) m
      WHERE m.codigo IN (SELECT cuenta_activa FROM tecnifin.productos_financieros)`)],
  ['cartera: cuotas vs mayor 1401..1428', CONTRA(
    `SELECT ta.cuenta_capital AS codigo, sum(ta.capital) AS saldo ${VIGENTES} GROUP BY 1`, MAYOR('1401', '1429'))],
  ['creditos: saldo vs cuotas', `SELECT cr.codigo, cr.saldo::text AS saldo, coalesce(sum(ta.capital), 0)::text AS cuotas
     FROM tecnifin.creditos cr LEFT JOIN tecnifin.tabla_amortizacion ta
       ON ta.cooperativa_id = cr.cooperativa_id AND ta.credito_id = cr.credito_id AND ta.estado IN ('PENDIENTE', 'VENCIDA')
    WHERE cr.estado IN ('VIGENTE', 'CANCELADO') GROUP BY cr.codigo, cr.saldo HAVING cr.saldo <> coalesce(sum(ta.capital), 0)`],
  ['intereses por cobrar: devengado vs mayor 1603', CONTRA(
    `SELECT ${SEGMENTO('1603')} AS codigo, sum(ta.interes_devengado) AS saldo ${VIGENTES} GROUP BY 1`, MAYOR('1603', '1604'))],
  ['intereses en suspenso: cuotas vs mayor 7109', CONTRA(
    `SELECT ${SEGMENTO('7109')} AS codigo, sum(ta.interes_suspenso) AS saldo ${VIGENTES} GROUP BY 1`, MAYOR('7109', '7110'))],
  ['depositos a plazo: certificados vs mayor 2103', CONTRA(
    `SELECT cuenta_contable_dpf AS codigo, sum(monto_capital) AS saldo FROM tecnifin.depositos_plazo
      WHERE estado IN ('ACTIVO', 'VENCIDO') GROUP BY 1`, MAYOR('2103', '2104', 'H'))],
  ['castigados: pendiente vs control 710310', CONTRA(
    `SELECT '710310' AS codigo, sum(monto_castigado - monto_recuperado) AS saldo FROM tecnifin.creditos
      WHERE estado = 'CASTIGADO' HAVING count(*) > 0`, MAYOR('710310', '710311'))],
  ['rubros: cobrados vs pagos', `SELECT p.numero_pago::text AS codigo, p.rubros::text AS pago, coalesce(sum(r.monto), 0)::text AS rubros
     FROM tecnifin.pagos_credito p LEFT JOIN tecnifin.rubros_creditos r
       ON r.cooperativa_id = p.cooperativa_id AND r.pago_id = p.pago_id AND r.estado = 'PAGADO'
    WHERE NOT p.anulado GROUP BY p.numero_pago, p.rubros HAVING p.rubros <> coalesce(sum(r.monto), 0)`],
];

// Hallazgos de una base: [{ ambito, control, filas }]. db: conexion como dueno del esquema.
export async function auditarBase(db) {
  const hallazgos = [];
  const q = async (s) => (await db.query(s)).rows;
  const agregar = (ambito, control, filas) => { if (filas.length) hallazgos.push({ ambito, control, filas }); };
  agregar('esquema', 'invariantes', await q(`SELECT objeto, problema FROM tecnifin.verificar_invariantes()`));
  agregar('esquema', 'tablas sin RLS o sin FORCE', await q(
    `SELECT relname FROM pg_class WHERE relnamespace = 'tecnifin'::regnamespace AND relkind = 'r'
        AND (NOT relrowsecurity OR NOT relforcerowsecurity) AND relname NOT IN ('cooperativas', 'parametros_plataforma')`));
  agregar('esquema', 'restricciones sin validar', await q(
    `SELECT conrelid::regclass::text AS tabla, conname FROM pg_constraint
      WHERE connamespace = 'tecnifin'::regnamespace AND NOT convalidated`));
  agregar('esquema', 'roles con superusuario o BYPASSRLS', await q(
    `SELECT rolname FROM pg_roles WHERE rolname LIKE 'tecnifin%' AND (rolsuper OR rolbypassrls)`));
  const withTenant = crearWithTenant(db);
  const coops = await q(`SELECT cooperativa_id, codigo FROM tecnifin.cooperativas ORDER BY 1`);
  for (const co of coops) {
    await withTenant(co.cooperativa_id, async tx => {
      for (const [nombre, sql] of CONTROLES) agregar(co.codigo, nombre, (await tx.query(sql)).rows);
    });
  }
  return { cooperativas: coops.length, hallazgos };
}

async function principal() {
  const nombres = process.argv.slice(2).length ? process.argv.slice(2)
    : [postgresConfig().database, process.env.TECNIFIN_PG_DEMO_DATABASE || 'tecnifin_demo'];
  let problemas = 0;
  for (const nombre of [...new Set(nombres)]) {
    const db = connectPostgres(entornoAdmin({ ...process.env, TECNIFIN_PG_DATABASE: nombre }));
    try {
      const { cooperativas, hallazgos } = await auditarBase(db);
      console.log(`${nombre}: ${cooperativas} cooperativa(s), ${CONTROLES.length} controles por cooperativa, ${hallazgos.length} hallazgo(s)`);
      for (const h of hallazgos) console.log(`  [${h.ambito}] ${h.control}:`, JSON.stringify(h.filas.slice(0, 5)));
      problemas += hallazgos.length;
    } catch (e) {
      console.log(`${nombre}: ERROR ${e.message}`);
      problemas++;
    } finally { await db.close(); }
  }
  process.exit(problemas ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await principal();
