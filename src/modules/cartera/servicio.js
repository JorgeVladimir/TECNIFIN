// M6 · proceso mensual de cartera SEPS (patron 08).
//
// A una fecha de corte, cada cuota pendiente se clasifica:
//   vencida (dias de mora > 0)                     -> familia VENCIDA  (142x), banda por dias de MORA
//   no vencida de un credito con alguna vencida    -> NO DEVENGA       (141x), banda por plazo remanente
//   resto                                          -> POR VENCER       (140x), banda por plazo remanente
// Las bandas se leen del plan de cuentas (no son simetricas entre familias). La calificacion
// (A1..E) y la provision minima salen de parametros_provision_cartera y se aplican sobre el
// saldo TOTAL de la operacion.
//
// Diferencia con el motor anterior: aqui cada cuota sabe en que subcuenta esta su capital
// (tabla_amortizacion.cuenta_capital), asi que la reclasificacion mueve cuotas exactas y la
// reversion las devuelve una por una. Antes de aplicar, la contabilidad de 1401..1428 debe
// coincidir al centavo con el capital pendiente: si no, el proceso se niega (reclasificar
// taparia el descuadre en vez de corregirlo).
//
// Dinero en centavos enteros de punta a punta.
import {
  auditarProceso, crearAutenticador, ErrorConflicto, ErrorNoEncontrado, ErrorSolicitud,
} from '../../platform/autenticacion.js';
import { asentar, HOY, lineasInversas } from '../../platform/contabilidad.js';
import {
  aTexto, bandasDesdePlan, cuentaPorBanda, CUENTA_INTERES, CUENTA_INTERES_POR_COBRAR, CUENTA_SUSPENSO, CUENTA_SUSPENSO_CONTRA,
  FAMILIA_CARTERA,
} from '../creditos/calculo.js';
import { montoValido } from '../caja/servicio.js';
import { debitarOrigen, enlazarOrigen, entradaOrigen } from '../caja/origen.js';
import { crearDevengo } from './devengo.js';
import { ROLES_ANALISIS, ROLES_CAJA, ROLES_SUPERVISOR } from '../../platform/roles.js';

const ROLES_CONSULTA = ROLES_ANALISIS;
const ROLES_APLICA = ROLES_SUPERVISOR;
const GASTO_PROVISION = { COMERCIAL: '440205', CONSUMO: '440210', VIVIENDA: '440215', MICROEMPRESA: '440220' };
const CUENTA_REVERSION_PROVISION = '560410';

const centavos = (texto) => {
  const negativo = String(texto).startsWith('-');
  const [e, d = ''] = String(texto).replace('-', '').split('.');
  const v = Number(e) * 100 + Number((d + '00').slice(0, 2));
  return negativo ? -v : v;
};

async function fechaCorteValida(tx, valor) {
  const fecha = valor ? String(valor) : null;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorSolicitud('fechaCorte debe tener el formato AAAA-MM-DD');
  const r = (await tx.query(`SELECT coalesce(@f::date, ${HOY})::text AS f, coalesce(@f::date, ${HOY}) <= ${HOY} AS ok`,
    { f: fecha })).rows[0];
  if (!r.ok) throw new ErrorSolicitud('La fecha de corte no puede ser futura');
  return r.f;
}

// Clasificacion completa a una fecha de corte. No escribe nada.
export async function clasificar(tx, fechaCorte) {
  const bandas = bandasDesdePlan((await tx.query(
    `SELECT codigo, nombre FROM tecnifin.plan_cuentas
      WHERE length(codigo) = 6 AND codigo >= '1401' AND codigo < '1429' AND activa`)).rows);
  const parametros = (await tx.query(
    `SELECT segmento, calificacion, dias_mora_desde, dias_mora_hasta, porcentaje_provision::text AS pct, cuenta_provision
       FROM tecnifin.parametros_provision_cartera WHERE activo ORDER BY segmento, dias_mora_desde`)).rows;
  const cuotas = (await tx.query(
    `SELECT ta.amortizacion_id, cr.credito_id, cr.codigo, cr.segmento, ta.numero_cuota, ta.capital::text AS capital,
            ta.cuenta_capital, ta.estado, (@corte::date - ta.fecha_pago) AS dias
       FROM tecnifin.tabla_amortizacion ta
       JOIN tecnifin.creditos cr ON cr.cooperativa_id = ta.cooperativa_id AND cr.credito_id = ta.credito_id
      WHERE cr.estado = 'VIGENTE' AND ta.estado IN ('PENDIENTE', 'VENCIDA') AND cr.fecha_desembolso <= @corte::date
      ORDER BY cr.credito_id, ta.numero_cuota`, { corte: fechaCorte })).rows;

  const operaciones = new Map();
  for (const q of cuotas) {
    const op = operaciones.get(q.credito_id) || { creditoId: q.credito_id, codigo: q.codigo, segmento: q.segmento,
      cuotas: [], saldo: 0, diasMora: 0 };
    op.cuotas.push(q);
    op.saldo += centavos(q.capital);
    op.diasMora = Math.max(op.diasMora, Number(q.dias));
    operaciones.set(q.credito_id, op);
  }

  const movimientos = [];
  const porCuenta = {};
  const operacionesPorCuenta = {};
  const provisiones = {};
  const detalle = [];
  for (const op of operaciones.values()) {
    const familias = FAMILIA_CARTERA[op.segmento];
    if (!familias) throw new ErrorConflicto(`El credito ${op.codigo} no tiene segmento SEPS`);
    const enMora = op.diasMora > 0;
    for (const q of op.cuotas) {
      const dias = Number(q.dias);
      const familia = dias > 0 ? familias.VENCIDA : enMora ? familias.NO_DEVENGA : familias.POR_VENCER;
      const destino = cuentaPorBanda(bandas, familia, dias > 0 ? dias : -dias);
      if (!destino) throw new ErrorConflicto(`El plan de cuentas no tiene las bandas de ${familia}`);
      const estadoNuevo = dias > 0 ? 'VENCIDA' : 'PENDIENTE';
      const capital = centavos(q.capital);
      porCuenta[destino] = (porCuenta[destino] || 0) + capital;
      (operacionesPorCuenta[destino] ??= new Set()).add(op.codigo);
      if (destino !== q.cuenta_capital || estadoNuevo !== q.estado) {
        movimientos.push({ amortizacionId: q.amortizacion_id, credito: op.codigo, cuota: q.numero_cuota,
          origen: q.cuenta_capital, destino, estadoAnterior: q.estado, estadoNuevo, capital });
      }
    }
    const tabla = parametros.filter(p => p.segmento === op.segmento);
    const calif = tabla.find(p => op.diasMora >= p.dias_mora_desde && (p.dias_mora_hasta === null || op.diasMora <= p.dias_mora_hasta))
      || tabla.at(-1);
    if (!calif) throw new ErrorConflicto(`No hay parametros de provision para ${op.segmento}`);
    // Provision por operacion en centavos: redondeo al centavo sobre el saldo total.
    const provision = Math.round(op.saldo * Number(calif.pct));
    const slot = provisiones[calif.cuenta_provision] || { cuentaProvision: calif.cuenta_provision, segmento: op.segmento,
      requerida: 0, operaciones: 0 };
    slot.requerida += provision;
    slot.operaciones += 1;
    provisiones[calif.cuenta_provision] = slot;
    detalle.push({ credito: op.codigo, creditoId: op.creditoId, segmento: op.segmento, saldo: op.saldo,
      diasMora: Math.max(0, op.diasMora), calificacion: calif.calificacion, porcentaje: calif.pct, provision });
  }

  const suma = (pred) => Object.entries(porCuenta).filter(([c]) => pred(c)).reduce((s, [, v]) => s + v, 0);
  const esFamilia = (c, clave) => Object.values(FAMILIA_CARTERA).some(f => c.startsWith(f[clave]));
  const bruta = suma(() => true);
  const improductiva = suma(c => esFamilia(c, 'NO_DEVENGA') || esFamilia(c, 'VENCIDA'));
  return {
    fechaCorte, operaciones: detalle, movimientos, porCuenta, provisiones: Object.values(provisiones),
    operacionesPorCuenta: Object.fromEntries(Object.entries(operacionesPorCuenta).map(([k, v]) => [k, v.size])),
    totales: {
      operaciones: operaciones.size, carteraBruta: bruta, porVencer: suma(c => esFamilia(c, 'POR_VENCER')),
      noDevenga: suma(c => esFamilia(c, 'NO_DEVENGA')), vencida: suma(c => esFamilia(c, 'VENCIDA')), improductiva,
      // Morosidad en puntos basicos (1 = 0,01 %), sin coma flotante.
      morosidadPb: bruta > 0 ? Math.round((improductiva * 10000) / bruta) : 0,
    },
  };
}

// Saldo contable por cuenta (Debe - Haber) de un rango de codigos hasta la fecha de corte.
async function saldosContables(tx, desde, hasta, fechaCorte) {
  const filas = (await tx.query(
    `SELECT pc.codigo, sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END)::text AS saldo
       FROM tecnifin.detalle_asiento d
       JOIN tecnifin.asientos_contables a ON a.cooperativa_id = d.cooperativa_id AND a.asiento_id = d.asiento_id
       JOIN tecnifin.plan_cuentas pc ON pc.cooperativa_id = d.cooperativa_id AND pc.cuenta_contable_id = d.cuenta_contable_id
      WHERE pc.codigo >= @desde AND pc.codigo < @hasta AND a.fecha <= @corte::date
      GROUP BY pc.codigo`, { desde, hasta, corte: fechaCorte })).rows;
  return Object.fromEntries(filas.map(f => [f.codigo, centavos(f.saldo)]));
}

const pesos = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, aTexto(v)]));

export function crearServicioCartera({ db, jwt, alertar = async () => {} }) {
  const { conRoles } = crearAutenticador({ db, jwt, alertar });

  // Todo lo que decide si un proceso se puede aplicar, calculado igual al simular y al aplicar.
  async function preparar(tx, fechaCorte) {
    const c = await clasificar(tx, fechaCorte);
    // Control: la contabilidad de cartera debe coincidir con el capital pendiente por cuenta.
    // Todo el libro (no solo hasta el corte): se compara contra el capital pendiente de HOY.
    const contable = await saldosContables(tx, '1401', '1429', '9999-12-31');
    const operativo = {};
    const actuales = (await tx.query(
      `SELECT ta.cuenta_capital AS cuenta, sum(ta.capital)::text AS saldo
         FROM tecnifin.tabla_amortizacion ta
         JOIN tecnifin.creditos cr ON cr.cooperativa_id = ta.cooperativa_id AND cr.credito_id = ta.credito_id
        WHERE cr.estado = 'VIGENTE' AND ta.estado IN ('PENDIENTE', 'VENCIDA') GROUP BY ta.cuenta_capital`)).rows;
    for (const a of actuales) operativo[a.cuenta] = centavos(a.saldo);
    const cuentas = new Set([...Object.keys(contable), ...Object.keys(operativo)]);
    const descuadres = [...cuentas].map(k => ({ cuenta: k, contable: contable[k] || 0, cartera: operativo[k] || 0 }))
      .filter(x => x.contable !== x.cartera);

    // Provision requerida contra la constituida (1499xx: activo de saldo acreedor -> Haber - Debe).
    const constituidas = await saldosContables(tx, '1499', '1500', '9999-12-31');
    const provisiones = c.provisiones.map(p => {
      const constituida = -(constituidas[p.cuentaProvision] || 0);
      return { ...p, constituida, ajuste: p.requerida - constituida };
    });
    const ajustes = provisiones.filter(a => a.ajuste !== 0);

    const grupos = {};
    for (const m of c.movimientos) {
      if (m.origen === m.destino) continue;
      const k = `${m.origen}>${m.destino}`;
      grupos[k] = grupos[k] || { origen: m.origen, destino: m.destino, monto: 0, creditos: new Set() };
      grupos[k].monto += m.capital;
      grupos[k].creditos.add(m.credito);
    }
    return { c, descuadres, provisiones, ajustes, grupos: Object.values(grupos),
      bloqueos: descuadres.length ? [`La contabilidad de cartera no coincide con el capital pendiente en ${descuadres
        .map(d => `${d.cuenta} (contable ${aTexto(d.contable)}, cartera ${aTexto(d.cartera)})`).join(', ')}`] : [] };
  }

  const resumen = (p, extra = {}) => ({
    fechaCorte: p.c.fechaCorte, ...extra,
    totales: { ...pesos({ carteraBruta: p.c.totales.carteraBruta, porVencer: p.c.totales.porVencer,
      noDevenga: p.c.totales.noDevenga, vencida: p.c.totales.vencida, improductiva: p.c.totales.improductiva }),
      operaciones: p.c.totales.operaciones, morosidad: `${Math.trunc(p.c.totales.morosidadPb / 100)}.${String(p.c.totales.morosidadPb % 100).padStart(2, '0')}` },
    porCuenta: pesos(p.c.porCuenta),
    reclasificaciones: p.grupos.map(g => ({ origen: g.origen, destino: g.destino, monto: aTexto(g.monto), creditos: g.creditos.size })),
    cuotasMovidas: p.c.movimientos.length,
    provisiones: p.ajustes.map(a => ({ cuenta: a.cuentaProvision, segmento: a.segmento, requerida: aTexto(a.requerida),
      constituida: aTexto(a.constituida), ajuste: aTexto(a.ajuste) })),
    operaciones: p.c.operaciones.map(o => ({ credito: o.credito, segmento: o.segmento, saldo: aTexto(o.saldo),
      diasMora: o.diasMora, calificacion: o.calificacion, provision: aTexto(o.provision) })),
    aplicable: p.bloqueos.length === 0, bloqueos: p.bloqueos,
  });

  async function consultar(token, fecha, contexto = {}) {
    return conRoles(token, contexto, ROLES_CONSULTA, 'CONSULTA_CARTERA', async tx =>
      resumen(await preparar(tx, await fechaCorteValida(tx, fecha))));
  }

  // Simula por defecto; aplicar es explicito y solo para supervisores.
  async function procesar(token, { fechaCorte, aplicar = false } = {}, contexto = {}) {
    const roles = aplicar === true ? ROLES_APLICA : ROLES_CONSULTA;
    return conRoles(token, contexto, roles, aplicar === true ? 'APLICAR_CARTERA' : 'SIMULAR_CARTERA',
      (tx, actor) => ejecutarProceso(tx, actor, fechaCorte, aplicar));
  }

  // Cuerpo del proceso dentro de una transaccion ya autorizada (lo reutiliza el cierre mensual).
  async function ejecutarProceso(tx, actor, fechaCorte, aplicar) {
    const corte = await fechaCorteValida(tx, fechaCorte);
    if (aplicar === true) {
      // Un proceso a la vez por cooperativa: el bloqueo evita dos aplicaciones cruzadas.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cartera:' || tecnifin.cooperativa_actual()))`);
      const posterior = (await tx.query(
        `SELECT fecha_corte::text AS f FROM tecnifin.reclasificacion_cartera
          WHERE estado = 'APLICADO' AND fecha_corte >= @c::date AND reversa_de_proceso_id IS NULL`, { c: corte })).rows[0];
      if (posterior) throw new ErrorConflicto(`Ya hay un proceso aplicado con corte ${posterior.f}`);
    }
    const p = await preparar(tx, corte);
    if (aplicar === true && p.bloqueos.length) throw new ErrorConflicto(p.bloqueos.join(' '));

    const requerida = p.c.provisiones.reduce((s, x) => s + x.requerida, 0);
    const constituida = p.provisiones.reduce((s, x) => s + x.constituida, 0);
    const ajusteTotal = p.ajustes.reduce((s, a) => s + a.ajuste, 0);
    const proceso = (await tx.query(
      `INSERT INTO tecnifin.reclasificacion_cartera (fecha_corte, estado, usuario_id, operaciones_evaluadas, monto_reclasificado,
                                                     cartera_bruta, cartera_improductiva, provision_requerida,
                                                     provision_constituida, provision_contabilizada)
       VALUES (@corte::date, 'SIMULADO', @u, @ops, @reclas::numeric, @bruta::numeric, @improd::numeric, @req::numeric,
               @cons::numeric, 0) RETURNING proceso_id`,
      { corte, u: actor.usuario_id, ops: p.c.totales.operaciones,
        reclas: aTexto(p.grupos.reduce((s, g) => s + g.monto, 0)), bruta: aTexto(p.c.totales.carteraBruta),
        improd: aTexto(p.c.totales.improductiva), req: aTexto(requerida), cons: aTexto(constituida) })).rows[0].proceso_id;
    for (const g of p.grupos) {
      await tx.query(
        `INSERT INTO tecnifin.reclasificacion_cartera_detalle (proceso_id, tipo, cuenta_origen, cuenta_destino, operaciones, monto)
         VALUES (@p, 'RECLASIFICACION', @o, @d, @n, @m::numeric)`,
        { p: proceso, o: g.origen, d: g.destino, n: g.creditos.size, m: aTexto(g.monto) });
    }
    for (const a of p.ajustes) {
      await tx.query(
        `INSERT INTO tecnifin.reclasificacion_cartera_detalle (proceso_id, tipo, segmento, cuenta_destino, operaciones, monto)
         VALUES (@p, 'PROVISION', @s, @c, @n, @m::numeric)`,
        { p: proceso, s: a.segmento, c: a.cuentaProvision, n: a.operaciones, m: aTexto(a.ajuste) });
    }
    if (aplicar !== true) return resumen(p, { proceso: Number(proceso), estado: 'SIMULADO' });

    // Aplicar: un asiento con la reclasificacion y el ajuste de provisiones.
    const lineas = [];
    for (const g of p.grupos) {
      lineas.push({ codigo: g.destino, tipo: 'D', valor: aTexto(g.monto) }, { codigo: g.origen, tipo: 'H', valor: aTexto(g.monto) });
    }
    for (const a of p.ajustes) {
      const v = aTexto(Math.abs(a.ajuste));
      if (a.ajuste > 0) lineas.push({ codigo: GASTO_PROVISION[a.segmento], tipo: 'D', valor: v }, { codigo: a.cuentaProvision, tipo: 'H', valor: v });
      else lineas.push({ codigo: a.cuentaProvision, tipo: 'D', valor: v }, { codigo: CUENTA_REVERSION_PROVISION, tipo: 'H', valor: v });
    }
    let asiento = null;
    if (lineas.length) {
      asiento = await asentar(tx, actor, { concepto: `Proceso de cartera al ${corte}`, origenModulo: 'CREDITOS',
        origenId: `CARTERA-${proceso}`, tipoDocumento: 'PROCESO_CARTERA', lineas });
    }
    for (const m of p.c.movimientos) {
      await tx.query(
        `INSERT INTO tecnifin.reclasificacion_cuota (proceso_id, amortizacion_id, cuenta_anterior, cuenta_nueva, estado_anterior,
                                                    estado_nuevo, capital)
         VALUES (@p, @a, @o, @d, @ea, @en, @c::numeric)`,
        { p: proceso, a: m.amortizacionId, o: m.origen, d: m.destino, ea: m.estadoAnterior, en: m.estadoNuevo, c: aTexto(m.capital) });
      await tx.query(`UPDATE tecnifin.tabla_amortizacion SET cuenta_capital = @d, estado = @e WHERE amortizacion_id = @a`,
        { d: m.destino, e: m.estadoNuevo, a: m.amortizacionId });
    }
    for (const o of p.c.operaciones) {
      await tx.query(
        `INSERT INTO tecnifin.calificacion_cartera (credito_id, fecha_corte, saldo_capital, dias_mora, categoria,
                                                   porcentaje_provision, valor_provision)
         VALUES (@c, @f::date, @s::numeric, @d, @cat, @pct::numeric, @v::numeric)
         ON CONFLICT (cooperativa_id, credito_id, fecha_corte) DO UPDATE
           SET saldo_capital = EXCLUDED.saldo_capital, dias_mora = EXCLUDED.dias_mora, categoria = EXCLUDED.categoria,
               porcentaje_provision = EXCLUDED.porcentaje_provision, valor_provision = EXCLUDED.valor_provision`,
        { c: o.creditoId, f: corte, s: aTexto(o.saldo), d: o.diasMora, cat: o.calificacion, pct: o.porcentaje, v: aTexto(o.provision) });
    }
    await tx.query(
      `UPDATE tecnifin.reclasificacion_cartera SET estado = 'APLICADO', asiento_id = @a, provision_contabilizada = @pc::numeric
        WHERE proceso_id = @p`, { a: asiento, pc: aTexto(ajusteTotal), p: proceso });
    await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'APLICAR_CARTERA', entidadTipo: 'PROCESO_CARTERA',
      entidadId: proceso, detalle: `Corte ${corte}: ${p.c.movimientos.length} cuotas reclasificadas, ajuste de provision ${aTexto(ajusteTotal)}.` });
    return resumen(p, { proceso: Number(proceso), estado: 'APLICADO' });
  }

  // Reversion exacta del ultimo proceso aplicado: cuotas a su cuenta y estado anteriores y
  // asiento inverso. Se niega si alguna cuota movida cambio despues (por ejemplo, se pago).
  async function reversar(token, procesoId, { motivo } = {}, contexto = {}) {
    const id = Number(procesoId);
    if (!Number.isSafeInteger(id) || id < 1) throw new ErrorSolicitud('Proceso invalido');
    const razon = String(motivo || '').trim();
    if (razon.length < 5 || razon.length > 500) throw new ErrorSolicitud('motivo: entre 5 y 500 caracteres');
    return conRoles(token, contexto, ROLES_APLICA, 'REVERSAR_CARTERA', async (tx, actor) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cartera:' || tecnifin.cooperativa_actual()))`);
      const pr = (await tx.query(
        `SELECT proceso_id, estado, fecha_corte::text AS corte, asiento_id FROM tecnifin.reclasificacion_cartera
          WHERE proceso_id = @id FOR UPDATE`, { id })).rows[0];
      if (!pr) return { error: new ErrorNoEncontrado() };
      if (pr.estado !== 'APLICADO') throw new ErrorConflicto(`El proceso esta ${pr.estado}`);
      const posterior = (await tx.query(
        `SELECT 1 FROM tecnifin.reclasificacion_cartera WHERE estado = 'APLICADO' AND proceso_id > @id`, { id })).rows[0];
      if (posterior) throw new ErrorConflicto('Reverse primero los procesos posteriores');
      const cambiadas = (await tx.query(
        `SELECT count(*)::int AS n FROM tecnifin.reclasificacion_cuota rc
           JOIN tecnifin.tabla_amortizacion ta ON ta.cooperativa_id = rc.cooperativa_id AND ta.amortizacion_id = rc.amortizacion_id
          WHERE rc.proceso_id = @id AND (ta.cuenta_capital <> rc.cuenta_nueva OR ta.estado <> rc.estado_nuevo OR ta.capital <> rc.capital)`, { id })).rows[0].n;
      if (cambiadas) throw new ErrorConflicto(`${cambiadas} cuota(s) cambiaron despues del proceso (pagos o abonos): no se puede reversar`);

      let contra = null;
      if (pr.asiento_id) {
        const lineas = await lineasInversas(tx, pr.asiento_id);
        contra = await asentar(tx, actor, { concepto: `Reverso del proceso de cartera al ${pr.corte}: ${razon}`,
          origenModulo: 'CREDITOS', origenId: `CARTERA-${id}`, tipoDocumento: 'REVERSO_CARTERA',
          lineas });
      }
      await tx.query(
        `UPDATE tecnifin.tabla_amortizacion ta SET cuenta_capital = rc.cuenta_anterior, estado = rc.estado_anterior
           FROM tecnifin.reclasificacion_cuota rc
          WHERE rc.cooperativa_id = ta.cooperativa_id AND rc.amortizacion_id = ta.amortizacion_id AND rc.proceso_id = @id`, { id });
      await tx.query(`DELETE FROM tecnifin.calificacion_cartera WHERE fecha_corte = @c::date`, { c: pr.corte });
      await tx.query(`UPDATE tecnifin.reclasificacion_cartera SET estado = 'REVERSADO', observaciones = @m WHERE proceso_id = @id`,
        { m: razon, id });
      const reverso = (await tx.query(
        `INSERT INTO tecnifin.reclasificacion_cartera (fecha_corte, estado, usuario_id, asiento_id, reversa_de_proceso_id, observaciones)
         VALUES (@c::date, 'REVERSADO', @u, @a, @id, @m) RETURNING proceso_id`,
        { c: pr.corte, u: actor.usuario_id, a: contra, id, m: razon })).rows[0].proceso_id;
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'REVERSAR_CARTERA', entidadTipo: 'PROCESO_CARTERA',
        entidadId: id, detalle: razon });
      return { proceso: id, estado: 'REVERSADO', reverso: Number(reverso) };
    });
  }

  // Castigo: baja de un credito vencido contra la provision constituida de su segmento. El
  // capital sale de la subcuenta donde esta cada cuota; el control queda en cuentas de orden
  // (710310 cartera castigada contra 7203xx del segmento) para su gestion de recuperacion.
  async function castigar(token, codigo, { motivo } = {}, contexto = {}) {
    const c = String(codigo || '').toUpperCase();
    if (!/^CRED-[0-9]{6,12}$/.test(c)) throw new ErrorSolicitud('Codigo de credito invalido');
    const razon = String(motivo || '').trim();
    if (razon.length < 10 || razon.length > 500) throw new ErrorSolicitud('motivo: entre 10 y 500 caracteres');
    return conRoles(token, contexto, ROLES_APLICA, 'CASTIGO_CARTERA', async (tx, actor) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cartera:' || tecnifin.cooperativa_actual()))`);
      const cr = (await tx.query(
        `SELECT credito_id, estado, segmento, socio_id FROM tecnifin.creditos WHERE codigo = @c FOR UPDATE`, { c })).rows[0];
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'VIGENTE') throw new ErrorConflicto(`El credito esta ${cr.estado}`);
      const cuotas = (await tx.query(
        `SELECT amortizacion_id, capital::text AS capital, cuenta_capital, fecha_pago < ${HOY} AS vencida,
                interes_devengado::text AS devengado, interes_suspenso::text AS suspenso
           FROM tecnifin.tabla_amortizacion WHERE credito_id = @id AND estado IN ('PENDIENTE', 'VENCIDA')
          ORDER BY numero_cuota FOR UPDATE`, { id: cr.credito_id })).rows;
      if (!cuotas.some(q => q.vencida)) throw new ErrorConflicto('Solo se castiga cartera vencida');
      const saldo = cuotas.reduce((s, q) => s + centavos(q.capital), 0);
      const cuentaProvision = (await tx.query(
        `SELECT cuenta_provision FROM tecnifin.parametros_provision_cartera WHERE segmento = @s AND activo LIMIT 1`,
        { s: cr.segmento })).rows[0]?.cuenta_provision;
      if (!cuentaProvision) throw new ErrorConflicto(`No hay cuenta de provision para ${cr.segmento}`);
      const constituida = -((await saldosContables(tx, cuentaProvision, `${cuentaProvision}~`, '9999-12-31'))[cuentaProvision] || 0);
      if (constituida < saldo) {
        throw new ErrorConflicto(`La provision constituida (${aTexto(constituida)}) no cubre el saldo (${aTexto(saldo)}): corra el proceso de cartera`);
      }
      const orden = { COMERCIAL: '720305', CONSUMO: '720310', VIVIENDA: '720315', MICROEMPRESA: '720320' }[cr.segmento];
      const total = aTexto(saldo);
      // El interes devengado y no cobrado se reversa contra el ingreso y el suspenso sale de orden:
      // el credito castigado ya no genera intereses por cobrar (patron 08 §7; lo valida el contador).
      const devengado = aTexto(cuotas.reduce((s, q) => s + centavos(q.devengado), 0));
      const suspenso = aTexto(cuotas.reduce((s, q) => s + centavos(q.suspenso), 0));
      const seg = cr.segmento;
      const asiento = await asentar(tx, actor, { concepto: `Castigo del credito ${c}: ${razon}`.slice(0, 300),
        origenModulo: 'CREDITOS', origenId: c, tipoDocumento: 'CASTIGO_CARTERA', lineas: [
          { codigo: cuentaProvision, tipo: 'D', valor: total, socioId: cr.socio_id },
          ...cuotas.map(q => ({ codigo: q.cuenta_capital, tipo: 'H', valor: q.capital, socioId: cr.socio_id })),
          { codigo: '710310', tipo: 'D', valor: total, socioId: cr.socio_id },
          { codigo: orden, tipo: 'H', valor: total, socioId: cr.socio_id },
          { codigo: CUENTA_INTERES[seg], tipo: 'D', valor: devengado, socioId: cr.socio_id },
          { codigo: CUENTA_INTERES_POR_COBRAR[seg], tipo: 'H', valor: devengado, socioId: cr.socio_id },
          { codigo: CUENTA_SUSPENSO_CONTRA[seg], tipo: 'D', valor: suspenso, socioId: cr.socio_id },
          { codigo: CUENTA_SUSPENSO[seg], tipo: 'H', valor: suspenso, socioId: cr.socio_id },
        ] });
      await tx.query(`UPDATE tecnifin.tabla_amortizacion SET estado = 'CASTIGADA' WHERE amortizacion_id = ANY(@ids::bigint[])`,
        { ids: cuotas.map(q => q.amortizacion_id) });
      await tx.query(`UPDATE tecnifin.creditos SET estado = 'CASTIGADO', monto_castigado = @m::numeric WHERE credito_id = @id`,
        { id: cr.credito_id, m: total });
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'CASTIGAR', entidadTipo: 'CREDITO', entidadId: c,
        campo: 'estado', anterior: 'VIGENTE', nuevo: 'CASTIGADO', detalle: `${razon.slice(0, 400)} Saldo ${total}.` });
      return { credito: c, estado: 'CASTIGADO', saldoCastigado: total, asiento: Number(asiento) };
    });
  }

  // Recuperacion de un credito castigado: lo cobrado va a ingreso (560405 De activos castigados)
  // y baja el control de orden en el mismo monto. Nunca mas de lo castigado pendiente.
  const ROLES_COBRO = ROLES_CAJA;
  async function recuperar(token, codigo, { monto, origen = 'CAJA', numeroCuenta, efectivo } = {}, contexto = {}) {
    const c = String(codigo || '').toUpperCase();
    if (!/^CRED-[0-9]{6,12}$/.test(c)) throw new ErrorSolicitud('Codigo de credito invalido');
    const m = montoValido(monto);
    const { via, detalle } = entradaOrigen({ origen, efectivo });
    return conRoles(token, contexto, ROLES_COBRO, 'RECUPERACION_CASTIGO', async (tx, actor) => {
      const cr = (await tx.query(
        `SELECT credito_id, estado, segmento, socio_id, @m::numeric <= monto_castigado - monto_recuperado AS cabe,
                (monto_castigado - monto_recuperado)::text AS pendiente
           FROM tecnifin.creditos WHERE codigo = @c FOR UPDATE`, { c, m })).rows[0];
      if (!cr) return { error: new ErrorNoEncontrado() };
      if (cr.estado !== 'CASTIGADO') throw new ErrorConflicto('Solo se recupera un credito castigado');
      if (!cr.cabe) throw new ErrorConflicto(`El monto supera lo castigado pendiente (${cr.pendiente})`);

      const glosa = `Recuperacion del credito castigado ${c}`;
      const origenCobro = await debitarOrigen(tx, actor, cr, m,
        { via, numeroCuenta, detalle, concepto: glosa, tipoOperacion: 'RECUPERACION_CASTIGO' });
      const orden = { COMERCIAL: '720305', CONSUMO: '720310', VIVIENDA: '720315', MICROEMPRESA: '720320' }[cr.segmento];
      const asiento = await asentar(tx, actor, { concepto: glosa, origenModulo: 'CREDITOS', origenId: c,
        tipoDocumento: 'RECUPERACION_CASTIGO', lineas: [
          { codigo: origenCobro.cuentaDebito, tipo: 'D', valor: m, socioId: cr.socio_id },
          { codigo: '560405', tipo: 'H', valor: m, socioId: cr.socio_id },
          { codigo: orden, tipo: 'D', valor: m, socioId: cr.socio_id },
          { codigo: '710310', tipo: 'H', valor: m, socioId: cr.socio_id },
        ] });
      await enlazarOrigen(tx, actor, { ...origenCobro, total: m, glosa, asiento });
      const fila = (await tx.query(
        `UPDATE tecnifin.creditos SET monto_recuperado = monto_recuperado + @m::numeric WHERE credito_id = @id
         RETURNING monto_recuperado::text AS recuperado, (monto_castigado - monto_recuperado)::text AS pendiente`,
        { m, id: cr.credito_id })).rows[0];
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'RECUPERAR_CASTIGO', entidadTipo: 'CREDITO', entidadId: c,
        campo: 'monto_recuperado', nuevo: fila.recuperado, detalle: `${via}: ${m}.` });
      return { credito: c, recuperado: fila.recuperado, pendiente: fila.pendiente,
        comprobante: origenCobro.comprobante };
    });
  }

  const { aplicarDevengoEn, ...devengo } = crearDevengo({ conRoles, saldosContables, fechaCorteValida });

  // Cierre mensual de cartera: devengo de intereses y proceso de cartera (reclasificacion,
  // calificacion y provisiones) al mismo corte, en UNA transaccion: o queda todo o nada. Cada
  // parte se puede reversar por separado (primero la cartera, luego el devengo).
  async function cierreMensual(token, { fechaCorte } = {}, contexto = {}) {
    return conRoles(token, contexto, ROLES_APLICA, 'CIERRE_CARTERA', async (tx, actor) => {
      const corte = await fechaCorteValida(tx, fechaCorte);
      const intereses = await aplicarDevengoEn(tx, actor, corte);
      const cartera = await ejecutarProceso(tx, actor, corte, true);
      await auditarProceso(tx, actor, { proceso: 'CREDITOS', accion: 'CIERRE_CARTERA', entidadTipo: 'PROCESO_CARTERA',
        entidadId: cartera.proceso, detalle: `Corte ${corte}: devengo ${intereses.proceso}, cartera ${cartera.proceso}.` });
      return { fechaCorte: corte, devengo: intereses, cartera };
    });
  }

  return { consultar, procesar, reversar, castigar, recuperar, ...devengo, cierreMensual };
}
