// M7 · reportes regulatorios SEPS (patron 10). Todos salen del mismo libro (M5) y del mismo
// motor de cartera (M6), a una fecha de corte, y en centavos enteros: un reporte no puede
// decir algo distinto de la contabilidad ni del proceso de cartera.
//
//   esf                -> Estado de situacion financiera por rubro (2 digitos), cuadrado
//   perlas             -> Indicadores (liquidez, morosidad, cobertura, rentabilidad, solvencia)
//   b11                -> Estructura de cartera por cuenta, segmento, estado y banda
//   uaf                -> Operaciones en efectivo sobre umbrales (individual y acumulado mensual)
//   situacion-general  -> Resumen operativo
//   solvencia          -> Patrimonio tecnico / activos ponderados por riesgo (Res. 127-2015-F)
// El balance de comprobacion es GET /api/contabilidad/balance (M5).
import { crearAutenticador, ErrorSolicitud } from '../../platform/autenticacion.js';
import { HOY } from '../../platform/contabilidad.js';
import { clasificar } from '../cartera/servicio.js';

const ROLES_REPORTES = new Set(['SUPER_USER', 'ADMIN', 'MANAGER']);
const ACREEDORAS = new Set(['PASIVO', 'PATRIMONIO', 'INGRESO']);
const PREFIJOS_CARTERA_BRUTA = Array.from({ length: 28 }, (_, i) => String(1401 + i));
const PREFIJOS_IMPRODUCTIVA = [...Array.from({ length: 8 }, (_, i) => String(1411 + i)), ...Array.from({ length: 8 }, (_, i) => String(1421 + i))];

const centavos = (t) => {
  const neg = String(t).startsWith('-');
  const [e, d = ''] = String(t).replace('-', '').split('.');
  const v = Number(e) * 100 + Number((d + '00').slice(0, 2));
  return neg ? -v : v;
};
const texto = (c) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
// Porcentaje num/den con 2 decimales, redondeo a la mitad hacia arriba, con BigInt.
export function porcentaje(num, den) {
  if (!den) return null;
  const negativo = (num < 0) !== (den < 0) && num !== 0;
  const n = BigInt(Math.abs(num)) * 1000000n;
  const d = BigInt(Math.abs(den));
  const q = n / d;                               // puntos basicos x 100
  const pb = Number(q / 100n + (q % 100n >= 50n ? 1n : 0n));
  return `${negativo && pb ? '-' : ''}${Math.trunc(pb / 100)}.${String(pb % 100).padStart(2, '0')}`;
}
// centavos x fraccion ("0.2", "1", "0.0125") redondeado al centavo, en BigInt.
export function porFraccion(cents, fraccion) {
  const [e, d = ''] = String(fraccion).split('.');
  const escala = 10n ** BigInt(d.length);
  const f = BigInt(e + d);
  const p = BigInt(cents) * f;
  const q = p / escala;
  const r = p % escala;
  return Number(q + (2n * (r < 0n ? -r : r) >= escala ? (p < 0n ? -1n : 1n) : 0n));
}

async function corteValido(tx, valor) {
  if (valor && !/^\d{4}-\d{2}-\d{2}$/.test(String(valor))) throw new ErrorSolicitud('fecha debe tener el formato AAAA-MM-DD');
  const r = (await tx.query(`SELECT coalesce(@f::date, ${HOY})::text AS f, coalesce(@f::date, ${HOY}) <= ${HOY} AS ok`,
    { f: valor || null })).rows[0];
  if (!r.ok) throw new ErrorSolicitud('La fecha de corte no puede ser futura');
  return r.f;
}

// Saldos por cuenta de movimiento hasta el corte, con su tipo.
async function libro(tx, corte) {
  const filas = (await tx.query(
    `SELECT pc.codigo, pc.tipo_cuenta,
            (sum(d.valor) FILTER (WHERE d.tipo_asiento = 'D'))::text AS debe, (sum(d.valor) FILTER (WHERE d.tipo_asiento = 'H'))::text AS haber
       FROM tecnifin.detalle_asiento d
       JOIN tecnifin.asientos_contables a ON a.cooperativa_id = d.cooperativa_id AND a.asiento_id = d.asiento_id
       JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE a.fecha <= @corte::date GROUP BY pc.codigo, pc.tipo_cuenta`, { corte })).rows;
  const cuentas = filas.map(f => ({ codigo: f.codigo, tipo: f.tipo_cuenta, deudor: centavos(f.debe || '0') - centavos(f.haber || '0') }));
  // Saldo natural de todo lo que empieza con el prefijo (activo/gasto D-H; resto H-D).
  const natural = (prefijo) => cuentas.filter(c => c.codigo.startsWith(prefijo))
    .reduce((s, c) => s + (ACREEDORAS.has(c.tipo) ? -c.deudor : c.deudor), 0);
  const deudor = (prefijo) => cuentas.filter(c => c.codigo.startsWith(prefijo)).reduce((s, c) => s + c.deudor, 0);
  const porTipo = (tipo) => cuentas.filter(c => c.tipo === tipo).reduce((s, c) => s + (ACREEDORAS.has(tipo) ? -c.deudor : c.deudor), 0);
  return { cuentas, natural, deudor, porTipo };
}

async function nombres(tx, codigos) {
  if (!codigos.length) return {};
  return Object.fromEntries((await tx.query(
    `SELECT codigo, nombre FROM tecnifin.plan_cuentas WHERE codigo = ANY(@c::text[])`, { c: codigos })).rows.map(r => [r.codigo, r.nombre]));
}

export async function calcularSolvencia(tx, corte) {
  const l = await libro(tx, corte);
  const [ponderaciones, componentes, limites] = await Promise.all([
    tx.query(`SELECT prefijo_cuenta, ponderacion::text AS p, categoria FROM tecnifin.ponderaciones_riesgo WHERE activo`),
    tx.query(`SELECT componente, prefijo_cuenta, factor::text AS factor, saldo_como, limite_pct_apr::text AS limite, descripcion
                FROM tecnifin.parametros_patrimonio_tecnico WHERE activo ORDER BY parametro_id`),
    tx.query(`SELECT clave, valor::text AS valor FROM tecnifin.parametros_regulatorios`),
  ]);
  const limite = (k, d) => limites.rows.find(r => r.clave === k)?.valor ?? d;
  const pesos = ponderaciones.rows.sort((a, b) => b.prefijo_cuenta.length - a.prefijo_cuenta.length);

  let activo = 0; let apr = 0;
  const categorias = {};
  const sinPonderar = [];
  for (const c of l.cuentas.filter(x => x.tipo === 'ACTIVO')) {
    activo += c.deudor;
    const peso = pesos.find(p => c.codigo.startsWith(p.prefijo_cuenta));
    if (!peso) { sinPonderar.push({ cuenta: c.codigo, saldo: texto(c.deudor) }); continue; }
    const ponderado = porFraccion(c.deudor, peso.p);
    apr += ponderado;
    const s = categorias[peso.categoria] ||= { categoria: peso.categoria, saldo: 0, ponderado: 0 };
    s.saldo += c.deudor; s.ponderado += ponderado;
  }
  let primario = 0; let secundario = 0; let deducciones = 0;
  for (const c of componentes.rows) {
    const bruto = c.saldo_como === 'DEUDOR' ? l.deudor(c.prefijo_cuenta) : -l.deudor(c.prefijo_cuenta);
    let valor = porFraccion(bruto, c.factor);
    if (c.limite !== null) valor = Math.min(valor, porFraccion(apr, c.limite));
    if (valor < 0) valor = 0;
    if (c.componente === 'PRIMARIO') primario += valor;
    else if (c.componente === 'SECUNDARIO') secundario += valor;
    else deducciones += valor;
  }
  // Resultado del ejercicio aun no cerrado: utilidad al secundario, perdida a deducciones.
  const resultado = l.porTipo('INGRESO') - l.porTipo('GASTO');
  if (resultado >= 0) secundario += resultado; else deducciones += -resultado;
  const secundarioComputable = Math.min(secundario, porFraccion(primario, limite('PT_SECUNDARIO_TOPE_PRIMARIO', '1')));
  const pt = primario + secundarioComputable - deducciones;
  const minimo = limite('SOLVENCIA_MINIMA', '0.09');
  const indice = apr > 0 ? porcentaje(pt, apr) : null;
  const minimoPct = porcentaje(porFraccion(10000, minimo), 10000);
  return {
    fechaCorte: corte, activoContable: texto(activo), activosPonderados: texto(apr),
    categorias: Object.values(categorias).map(c => ({ categoria: c.categoria, saldo: texto(c.saldo), ponderado: texto(c.ponderado) })),
    cuentasSinPonderar: sinPonderar,
    patrimonioTecnico: { primario: texto(primario), secundario: texto(secundario), secundarioComputable: texto(secundarioComputable),
      deducciones: texto(deducciones), constituido: texto(pt), resultadoEjercicio: texto(resultado) },
    solvencia: { indice, minimo: minimoPct, cumple: indice === null ? null : pt >= porFraccion(apr, minimo),
      formula: 'Patrimonio tecnico constituido / activos ponderados por riesgo (Resolucion 127-2015-F)' },
  };
}

export function crearServicioReportes({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });
  const reporte = (token, ctx, concepto, op) => conRoles(token, ctx, ROLES_REPORTES, concepto, op);

  async function esf(token, fecha, contexto = {}) {
    return reporte(token, contexto, 'REPORTE_ESF', async tx => {
      const corte = await corteValido(tx, fecha);
      const l = await libro(tx, corte);
      const rubros = [...new Set(l.cuentas.filter(c => ['ACTIVO', 'PASIVO', 'PATRIMONIO'].includes(c.tipo)).map(c => c.codigo.slice(0, 2)))].sort();
      const n = await nombres(tx, rubros);
      const seccion = (tipo, prefijo) => rubros.filter(r => r.startsWith(prefijo))
        .map(r => ({ codigo: r, nombre: n[r] || r, monto: l.natural(r) })).filter(r => r.monto !== 0);
      const activo = seccion('ACTIVO', '1'); const pasivo = seccion('PASIVO', '2'); const patrimonio = seccion('PATRIMONIO', '3');
      const suma = (xs) => xs.reduce((s, x) => s + x.monto, 0);
      const resultado = l.porTipo('INGRESO') - l.porTipo('GASTO');
      const totalActivo = suma(activo); const totalPasivo = suma(pasivo); const totalPatrimonio = suma(patrimonio) + resultado;
      const fmt = xs => xs.map(x => ({ ...x, monto: texto(x.monto) }));
      return { fechaCorte: corte, activo: fmt(activo), totalActivo: texto(totalActivo), pasivo: fmt(pasivo), totalPasivo: texto(totalPasivo),
        patrimonio: fmt(patrimonio), resultadoEjercicio: texto(resultado), totalPatrimonio: texto(totalPatrimonio),
        totalPasivoMasPatrimonio: texto(totalPasivo + totalPatrimonio), cuadrado: totalActivo === totalPasivo + totalPatrimonio,
        diferencia: texto(totalActivo - totalPasivo - totalPatrimonio) };
    });
  }

  async function b11(token, fecha, contexto = {}) {
    return reporte(token, contexto, 'REPORTE_B11', async tx => {
      const corte = await corteValido(tx, fecha);
      const c = await clasificar(tx, corte);
      const n = await nombres(tx, Object.keys(c.porCuenta));
      const familia = (cuenta) => ({ 0: 'POR VENCER', 1: 'NO DEVENGA INTERESES', 2: 'VENCIDA' })[Number(cuenta[2])];
      const segmento = (cuenta) => ({ 1: 'COMERCIAL', 2: 'CONSUMO', 3: 'VIVIENDA', 4: 'MICROEMPRESA' })[Number(cuenta[3])];
      return { fechaCorte: corte,
        filas: Object.keys(c.porCuenta).sort().map(k => ({ cuentaSeps: k, segmento: segmento(k), estado: familia(k), banda: n[k] || k,
          operaciones: c.operacionesPorCuenta[k], saldo: texto(c.porCuenta[k]) })),
        operaciones: c.operaciones.map(o => ({ credito: o.credito, segmento: o.segmento, saldo: texto(o.saldo), diasMora: o.diasMora,
          calificacion: o.calificacion, provision: texto(o.provision) })),
        totales: { operaciones: c.totales.operaciones, carteraBruta: texto(c.totales.carteraBruta), porVencer: texto(c.totales.porVencer),
          noDevenga: texto(c.totales.noDevenga), vencida: texto(c.totales.vencida), improductiva: texto(c.totales.improductiva),
          morosidad: porcentaje(c.totales.improductiva, c.totales.carteraBruta) ?? '0.00',
          provisionRequerida: texto(c.provisiones.reduce((s, p) => s + p.requerida, 0)) } };
    });
  }

  async function perlas(token, fecha, contexto = {}) {
    return reporte(token, contexto, 'REPORTE_PERLAS', async tx => {
      const corte = await corteValido(tx, fecha);
      const l = await libro(tx, corte);
      const c = await clasificar(tx, corte);
      const s = await calcularSolvencia(tx, corte);
      const sum = (ps) => ps.reduce((t, p) => t + l.natural(p), 0);
      const activo = l.natural('1');
      const resultado = l.porTipo('INGRESO') - l.porTipo('GASTO');
      const patrimonio = l.natural('3') + resultado;
      const carteraBrutaContable = sum(PREFIJOS_CARTERA_BRUTA);
      const improductivaContable = sum(PREFIJOS_IMPRODUCTIVA);
      const provisiones = -l.natural('1499');
      const ind = (categoria, nombre, formula, valor) => ({ categoria, nombre, formula, valor });
      const indicadores = [
        ind('LIQUIDEZ', 'Indicador de liquidez', '({11} + {13}) / ({2101} + {2103})',
          porcentaje(l.natural('11') + l.natural('13'), l.natural('2101') + l.natural('2103'))),
        ind('CALIDAD DE ACTIVOS', 'Morosidad ampliada', 'Cartera improductiva (no devenga + vencida) / cartera bruta, segun vencimientos reales',
          porcentaje(c.totales.improductiva, c.totales.carteraBruta)),
        ind('CALIDAD DE ACTIVOS', 'Participacion de la cartera en el activo', 'Cartera neta {14} / activo {1}', porcentaje(l.natural('14'), activo)),
        ind('CALIDAD DE ACTIVOS', 'Cobertura de cartera improductiva', 'Provisiones {1499} / (no devenga {141x} + vencida {142x})',
          porcentaje(provisiones, improductivaContable)),
        ind('RENTABILIDAD', 'ROA', '({5} - {4}) / {1}', porcentaje(resultado, activo)),
        ind('RENTABILIDAD', 'ROE', '({5} - {4}) / ({3} + resultado)', porcentaje(resultado, patrimonio)),
        ind('RENTABILIDAD', 'Grado de absorcion del margen financiero', 'Gastos de operacion {45} / ({5} - {41})',
          porcentaje(l.natural('45'), l.porTipo('INGRESO') - l.natural('41'))),
        ind('SOLVENCIA', 'Indice de solvencia', s.solvencia.formula, s.solvencia.indice),
        ind('SOLVENCIA', 'Patrimonio sobre activo', '({3} + resultado) / {1} (apalancamiento contable, no es la solvencia regulatoria)',
          porcentaje(patrimonio, activo)),
      ];
      const alertas = [];
      if (carteraBrutaContable !== c.totales.carteraBruta) {
        alertas.push(`La cartera contable (${texto(carteraBrutaContable)}) no coincide con la de la tabla de amortizacion (${texto(c.totales.carteraBruta)}).`);
      }
      if (improductivaContable !== c.totales.improductiva) {
        alertas.push(`La cartera improductiva contable (${texto(improductivaContable)}) difiere de la real (${texto(c.totales.improductiva)}): corra el proceso de cartera.`);
      }
      if (s.solvencia.cumple === false) alertas.push(`Solvencia ${s.solvencia.indice} % bajo el minimo ${s.solvencia.minimo} %.`);
      return { fechaCorte: corte, indicadores, alertas, solvencia: s.solvencia };
    });
  }

  async function uaf(token, periodo, contexto = {}) {
    const p = periodo ? String(periodo) : null;
    if (p && !/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw new ErrorSolicitud('periodo debe tener el formato AAAA-MM');
    return reporte(token, contexto, 'REPORTE_UAF', async tx => {
      const par = Object.fromEntries((await tx.query(
        `SELECT clave, valor FROM tecnifin.parametros_cooperativa WHERE clave IN ('uaf.umbral_individual', 'uaf.umbral_mensual')`)).rows
        .map(r => [r.clave, r.valor]));
      const individual = par['uaf.umbral_individual'] || '5000';
      const mensual = par['uaf.umbral_mensual'] || '10000';
      const base = `FROM tecnifin.transacciones_caja t
         JOIN tecnifin.socios s ON s.cooperativa_id = t.cooperativa_id AND s.socio_id = t.socio_id
        WHERE NOT t.anulado
          AND to_char(t.fecha_hora AT TIME ZONE 'America/Guayaquil', 'YYYY-MM') = coalesce(@p, to_char(${HOY}, 'YYYY-MM'))`;
      const individuales = (await tx.query(
        `SELECT t.numero_comprobante, to_char(t.fecha_hora AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD') AS fecha, t.tipo_operacion,
                t.monto::text AS monto, s.tipo_identificacion, s.identificacion, s.numero_socio,
                concat_ws(' ', s.primer_nombre, s.segundo_nombre, s.primer_apellido, s.segundo_apellido) AS nombre
           ${base} AND t.monto >= @u::numeric ORDER BY t.fecha_hora, t.numero_comprobante`, { p, u: individual })).rows;
      const acumuladas = (await tx.query(
        `SELECT s.tipo_identificacion, s.identificacion, s.numero_socio,
                concat_ws(' ', s.primer_nombre, s.segundo_nombre, s.primer_apellido, s.segundo_apellido) AS nombre,
                count(*)::int AS operaciones, sum(t.monto)::text AS total
           ${base} GROUP BY s.socio_id, s.tipo_identificacion, s.identificacion, s.numero_socio, s.primer_nombre, s.segundo_nombre,
                            s.primer_apellido, s.segundo_apellido
          HAVING sum(t.monto) >= @m::numeric ORDER BY sum(t.monto) DESC`, { p, m: mensual })).rows;
      const periodoFinal = (await tx.query(`SELECT coalesce(@p, to_char(${HOY}, 'YYYY-MM')) AS p`, { p })).rows[0].p;
      return { periodo: periodoFinal, umbrales: { individual, mensual },
        individuales: individuales.map(r => ({ comprobante: Number(r.numero_comprobante), fecha: r.fecha, operacion: r.tipo_operacion,
          monto: r.monto, numeroSocio: Number(r.numero_socio), tipoIdentificacion: r.tipo_identificacion, identificacion: r.identificacion,
          nombre: r.nombre })),
        acumuladas: acumuladas.map(r => ({ numeroSocio: Number(r.numero_socio), tipoIdentificacion: r.tipo_identificacion,
          identificacion: r.identificacion, nombre: r.nombre, operaciones: r.operaciones, total: r.total })) };
    });
  }

  async function situacionGeneral(token, contexto = {}) {
    return reporte(token, contexto, 'REPORTE_SITUACION', async tx => {
      const r = (await tx.query(
        `SELECT (SELECT count(*) FROM tecnifin.socios WHERE estado = 'ACTIVO')::int AS socios,
                (SELECT coalesce(sum(c.saldo), 0) FROM tecnifin.cuentas c JOIN tecnifin.productos_financieros p
                   ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id WHERE NOT p.es_certificado)::text AS ahorro,
                (SELECT coalesce(sum(c.saldo), 0) FROM tecnifin.cuentas c JOIN tecnifin.productos_financieros p
                   ON p.cooperativa_id = c.cooperativa_id AND p.producto_id = c.producto_id WHERE p.es_certificado)::text AS certificados,
                (SELECT count(*) FROM tecnifin.creditos WHERE estado = 'VIGENTE')::int AS creditos,
                (SELECT coalesce(sum(saldo), 0) FROM tecnifin.creditos WHERE estado = 'VIGENTE')::text AS cartera,
                (SELECT count(*) FROM tecnifin.depositos_plazo WHERE estado = 'ACTIVO')::int AS dpf,
                (SELECT coalesce(sum(monto_capital), 0) FROM tecnifin.depositos_plazo WHERE estado = 'ACTIVO')::text AS capital_dpf`)).rows[0];
      return { sociosActivos: r.socios, ahorroVista: texto(centavos(r.ahorro)), certificadosAportacion: texto(centavos(r.certificados)),
        creditosVigentes: r.creditos, carteraVigente: texto(centavos(r.cartera)), depositosPlazo: r.dpf,
        capitalDepositosPlazo: texto(centavos(r.capital_dpf)),
        captacionesTotales: texto(centavos(r.ahorro) + centavos(r.capital_dpf)) };
    });
  }

  async function solvencia(token, fecha, contexto = {}) {
    return reporte(token, contexto, 'REPORTE_SOLVENCIA', async tx => calcularSolvencia(tx, await corteValido(tx, fecha)));
  }

  return { esf, b11, perlas, uaf, situacionGeneral, solvencia };
}
