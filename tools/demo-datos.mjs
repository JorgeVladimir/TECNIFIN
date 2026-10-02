// Contenido de la base de DEMOSTRACION (tecnifin_demo). Se construye entero por
// withTenant y con el rol de la aplicacion, igual que lo haria el sistema: ningun INSERT
// nombra cooperativa_id ni se salta RLS.
//
// Todo lo de aqui es SINTETICO y se nota: la cooperativa se llama "Cooperativa Demo", los
// socios se apellidan EJEMPLO / PRUEBA / DEMO y las cedulas, aunque pasan el modulo 10,
// salen de bases inventadas. Nada sale de ninguna cooperativa real (regla 11).
//
// Determinista: fechas, montos y correlativos fijos. Recrear la base desde cero deja
// exactamente el mismo contenido de negocio.
import { altaCooperativa } from '../src/platform/semillas.js';
import { cedulaDesdeBase } from '../src/platform/identificacion.js';
import { bandasDesdePlan, CUENTA_INTERES, cuentaPorBanda, FAMILIA_CARTERA } from '../src/modules/creditos/calculo.js';

export const COOPERATIVA_DEMO = {
  codigo: 'DEMO',
  razonSocial: 'Cooperativa de Ahorro y Credito Demostracion',
  ruc: '9999999999001',
  nombreComercial: 'Cooperativa Demo',
  codigoSeps: 'DEMO-0000',
};

// Fechas y montos fijos a proposito: si dependieran de hoy, la mora de los creditos
// cambiaria cada dia y la demo dejaria de ser reproducible.
export const FECHA_CORTE = '2026-09-30';
const FECHA_CAJA = '2026-09-18';
const MONTO_DPF = 5000;

// El dinero se redondea a centavos en un solo lugar: si alguna vez cambia el criterio
// (por ejemplo a mitad hacia par), se cambia aqui y no en quince sitios.
const centavos = n => Math.round(n * 100) / 100;

const USUARIOS = [
  ['demo.admin', 'Ada Administradora Demo', 'ADMIN'],
  ['demo.cajero', 'Beto Cajero Demo', 'TELLER'],
  ['demo.credito', 'Carla Credito Demo', 'CREDIT_OFFICER'],
  ['demo.cartera', 'Dario Cartera Demo', 'MANAGER'],
  ['demo.contador', 'Elsa Contadora Demo', 'MANAGER'],
];

// Base de 9 digitos + verificador calculado: la cedula sintetica pasa la misma
// validacion que una real (ver src/platform/identificacion.js).
const SOCIOS = [
  ['170000001', 'ANA', 'EJEMPLO', 'PRUEBA', 'F'],
  ['170000002', 'BRUNO', 'MUESTRA', 'DEMO', 'M'],
  ['170000003', 'CARMEN', 'FICTICIA', 'SIMULADA', 'F'],
  ['170000004', 'DIEGO', 'PRUEBAS', 'DEMO', 'M'],
  ['170000005', 'ELENA', 'MODELO', 'EJEMPLO', 'F'],
  ['170000006', 'FELIPE', 'SIMULADO', 'DEMO', 'M'],
].map(([base, nombre, apellido1, apellido2, genero]) =>
  ({ cedula: cedulaDesdeBase(base), nombre, apellido1, apellido2, genero }));

// Cuota francesa. El ultimo capital se ajusta para que la suma cierre exacta contra el
// monto: sin ese ajuste la tabla de amortizacion deja centavos sueltos.
export function amortizacionFrancesa(monto, tasaAnual, cuotas) {
  const i = Number(tasaAnual) / 100 / 12;
  const cuota = centavos(monto * i / (1 - Math.pow(1 + i, -cuotas)));
  const filas = [];
  let saldo = monto;
  for (let n = 1; n <= cuotas; n++) {
    const interes = centavos(saldo * i);
    const capital = n === cuotas ? centavos(saldo) : centavos(cuota - interes);
    saldo = centavos(saldo - capital);
    filas.push({ numero: n, capital, interes, total: centavos(capital + interes) });
  }
  return filas;
}

const mesesDespues = (fecha, n) => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const diasEntre = (desde, hasta) =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000);

const CREDITOS = [
  {
    codigo: 'CRED-000001', socio: 0, monto: 6000, tasa: 15, cuotas: 12,
    desembolso: '2026-01-15', tipo: 'CONSUMO ORDINARIO', segmento: 'CONSUMO', pagadas: 6,
  },
  {
    codigo: 'CRED-000002', socio: 2, monto: 3000, tasa: 22, cuotas: 24,
    desembolso: '2026-08-20', tipo: 'MICROCREDITO MINORISTA', segmento: 'MICROEMPRESA', pagadas: 0,
  },
];

const unica = async (tx, sql, params) => (await tx.query(sql, params)).rows[0];
// Capital de las cuotas agrupado por subcuenta de cartera, en centavos exactos.
const porCuenta = cuotas => [...cuotas.reduce((m, c) => m.set(c.cuenta, (m.get(c.cuenta) || 0) + Math.round(c.capital * 100)),
  new Map())].map(([codigo, ct]) => [codigo, ct / 100]);

async function crearUsuarios(tx, secretos) {
  const filas = await tx.query(
    `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
     SELECT * FROM unnest(@logins::varchar[], @nombres::varchar[], @hashes::varchar[], @roles::varchar[])
     RETURNING usuario_id, login`,
    {
      logins: USUARIOS.map(u => u[0]), nombres: USUARIOS.map(u => u[1]),
      roles: USUARIOS.map(u => u[2]), hashes: USUARIOS.map(u => secretos.get(u[0])),
    });
  return Object.fromEntries(filas.rows.map(f => [f.login, f.usuario_id]));
}

async function crearCatalogosPropios(tx, usuarios) {
  const producto = await unica(tx,
    `INSERT INTO tecnifin.productos_financieros
       (codigo_producto, nombre, tipo_deposito, cuenta_activa, cuenta_inactiva)
     VALUES (2, 'AHORRO A LA VISTA', 'AHORRO A LA VISTA', '210135', '210135')
     RETURNING producto_id`);

  const tasasDpf = await tx.query(
    `INSERT INTO tecnifin.tasas_plazo_fijo
       (codigo_rango, descripcion_rango, dias_desde, dias_hasta, tasa_nominal_anual,
        tasa_maxima_bce, cuenta_contable_dpf, usuario_config_id)
     VALUES ('R30', 'De 1 a 30 dias',  1,  30, 4.5000, 6.0000, '210305', @usuario),
            ('R90', 'De 31 a 90 dias', 31, 90, 5.5000, 7.0000, '210310', @usuario)
     RETURNING tasa_id, codigo_rango`, { usuario: usuarios['demo.admin'] });

  await tx.query(
    `INSERT INTO tecnifin.tasas_credito
       (linea_credito, clase_credito, monto_minimo, monto_maximo, plazo_minimo, plazo_maximo,
        tasa_inicial, tasa_final, tasa_aplicable)
     VALUES ('CONSUMO ORDINARIO',      'CONSUMO',      100.00,  50000.00,  3,  60, 14.0000, 16.0000, 15.0000),
            ('MICROCREDITO MINORISTA', 'MICROEMPRESA', 100.00,  20000.00,  3,  36, 20.0000, 24.0000, 22.0000),
            ('VIVIENDA HIPOTECARIA',   'VIVIENDA',    5000.00, 120000.00, 12, 180,  9.0000, 11.0000, 10.0000)`);

  // Rubros por cuota (patron 06 §7) para que la simulacion y los creditos nuevos de la demo los
  // muestren. Los creditos sembrados abajo son anteriores a esta configuracion y no los llevan.
  await tx.query(
    `INSERT INTO tecnifin.rubros_cuota_config (codigo, nombre, base, valor, cuenta_contable)
     VALUES ('SEGURO', 'Seguro de desgravamen', 'PORCENTAJE_SALDO', 0.0800, '259090'),
            ('GASTOS', 'Gastos de cobranza', 'FIJO', 1.5000, '569010')`);

  return { productoId: producto.producto_id, tasaDpf: tasasDpf.rows.find(t => t.codigo_rango === 'R90').tasa_id };
}

async function crearSocios(tx, productoId, secretos) {
  const socios = [];
  for (const s of SOCIOS) {
    const socio = await unica(tx,
      `INSERT INTO tecnifin.socios
         (tipo_persona, tipo_identificacion, identificacion, primer_nombre, primer_apellido,
          segundo_apellido, genero, consentimiento_datos)
       VALUES ('SOCIO', 'CEDULA', @cedula, @nombre, @apellido1, @apellido2, @genero, true)
       RETURNING socio_id, numero_socio, identificacion`,
      { cedula: s.cedula, nombre: s.nombre, apellido1: s.apellido1, apellido2: s.apellido2, genero: s.genero });
    const cuenta = await unica(tx,
      `INSERT INTO tecnifin.cuentas (socio_id, producto_id, fecha_apertura)
       VALUES (@socio, @producto, DATE '2026-01-05') RETURNING cuenta_id, numero_cuenta`,
      { socio: socio.socio_id, producto: productoId });
    socios.push({ ...s, socioId: socio.socio_id, numeroSocio: socio.numero_socio, cuentaId: cuenta.cuenta_id });
  }

  // Canal en linea de los dos primeros socios: el PIN entra HASHEADO. El dominio
  // tecnifin.hash_secreto rechaza cualquier cosa que no tenga el formato del hash.
  for (const socio of socios.slice(0, 2)) {
    await tx.query(
      `INSERT INTO tecnifin.activacion_banca_linea
         (socio_id, pin_hash, acepto_datos_personales, fecha_aceptacion_datos, activo)
       VALUES (@socio, @pin, true, TIMESTAMPTZ '2026-09-10 09:00:00-05', true)`,
      { socio: socio.socioId, pin: secretos.get(`pin-${socio.cedula}`) });
  }

  // Excepcion de documento: imagen dentro de la base (bytea), no una ruta a disco.
  await tx.query(
    `INSERT INTO tecnifin.socio_documento_excepcion
       (socio_id, identificacion, imagen_frontal, tipo_mime, motivo)
     VALUES (@socio, @cedula, @imagen, 'image/png', 'Cedula deteriorada: respaldo cargado en oficina')`,
    {
      socio: socios[3].socioId, cedula: socios[3].cedula,
      imagen: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    });

  return socios;
}

// Un asiento cuadrado, con todas sus lineas, en UNA sentencia: la CTE inserta la
// cabecera y el INSERT de abajo cuelga las lineas del asiento que acaba de devolver. El
// cuadre lo verifica el motor al COMMIT (trigger diferido de 0007), asi que da igual que
// las lineas entren juntas o de a una.
async function asentar(tx, { periodoId, fecha, concepto, usuarioId, origen, origenId, cuentas, lineas }) {
  const filas = await tx.query(
    `WITH cabecera AS (
       INSERT INTO tecnifin.asientos_contables
         (periodo_contable_id, fecha, concepto, usuario_id, origen_modulo, origen_id)
       VALUES (@periodo, @fecha::date, @concepto, @usuario, @origen, @origenId)
       RETURNING asiento_id)
     INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor, socio_id)
     SELECT cabecera.asiento_id, l.cuenta, l.tipo, l.valor, l.socio
       FROM cabecera,
            unnest(@cuentasLinea::integer[], @tipos::varchar[], @valores::numeric[], @socios::bigint[])
              AS l(cuenta, tipo, valor, socio)
     RETURNING asiento_id`,
    {
      periodo: periodoId, fecha, concepto, usuario: usuarioId, origen, origenId: origenId ?? null,
      cuentasLinea: lineas.map(l => cuentas[l[0]]), tipos: lineas.map(l => l[1]),
      valores: lineas.map(l => l[2]), socios: lineas.map(l => l[3] ?? null),
    });
  return filas.rows[0].asiento_id;
}

// Transaccion de caja, su asiento y el enlace de vuelta. El UPDATE existe porque la
// referencia es circular: el asiento nombra a la transaccion en origen_id y la
// transaccion guarda el asiento que la respalda.
async function asentarTransaccion(tx, transaccionId, asiento) {
  const asientoId = await asentar(tx, { ...asiento, origenId: asiento.origenId ?? String(transaccionId) });
  await tx.query(
    'UPDATE tecnifin.transacciones_caja SET asiento_contable_id = @asiento WHERE transaccion_id = @id',
    { asiento: asientoId, id: transaccionId });
  return asientoId;
}

async function crearContabilidad(tx) {
  const periodos = await tx.query(
    `INSERT INTO tecnifin.periodos_contables (anio, mes)
     SELECT 2026, m FROM generate_series(1, 9) AS m RETURNING periodo_id, mes`);
  // Cartera por vencer (1401..1404, por banda) e intereses (5104xx) con el mismo plan que usa M3.
  const cuentas = await tx.query(
    `SELECT codigo, nombre, cuenta_contable_id FROM tecnifin.plan_cuentas
      WHERE codigo IN ('110105','210135','210310','310305','140205','142210','149910','440210')
         OR (length(codigo) = 6 AND (codigo BETWEEN '1401' AND '1405' OR codigo LIKE '5104%'))`);
  return {
    periodos: Object.fromEntries(periodos.rows.map(f => [f.mes, f.periodo_id])),
    cuentas: Object.fromEntries(cuentas.rows.map(f => [f.codigo, f.cuenta_contable_id])),
    bandas: bandasDesdePlan(cuentas.rows.filter(f => f.codigo < '1405' && f.codigo >= '1401')),
  };
}

// Igual que el desembolso de M3: cada cuota nace en la subcuenta por vencer de su segmento y
// banda (dias del desembolso al vencimiento) y guarda esa cuenta; las cuotas ya pagadas se
// contabilizan con su propio asiento. Asi el mayor de 1401..1428 cuadra al centavo con las
// cuotas pendientes, que es lo que el proceso de cartera (M6) exige antes de aplicar.
async function crearCreditos(tx, { socios, usuarios, periodos, cuentas, bandas }) {
  const resultado = [];
  for (const credito of CREDITOS) {
    const socio = socios[credito.socio];
    const cuotas = amortizacionFrancesa(credito.monto, credito.tasa, credito.cuotas);
    const pagado = cuotas.slice(0, credito.pagadas).reduce((s, c) => s + c.capital, 0);
    const saldo = Math.round((credito.monto - pagado) * 100) / 100;
    const familia = FAMILIA_CARTERA[credito.segmento].POR_VENCER;
    for (const c of cuotas) {
      c.fecha = mesesDespues(credito.desembolso, c.numero);
      c.cuenta = cuentaPorBanda(bandas, familia, diasEntre(credito.desembolso, c.fecha));
    }

    const solicitud = await unica(tx,
      `INSERT INTO tecnifin.solicitudes_credito
         (codigo, socio_id, identificacion, monto, saldo, tasa, plazo, tipo, estado,
          usuario_decision_id, fecha_decision, segmento)
       VALUES (@codigo, @socio, @cedula, @monto, @saldo, @tasa, @plazo, @tipo, 'DESEMBOLSADO',
               @usuario, @fecha::date, @segmento) RETURNING solicitud_id`,
      {
        codigo: credito.codigo.replace('CRED', 'SOL'), socio: socio.socioId, cedula: socio.cedula,
        monto: credito.monto, saldo, tasa: credito.tasa, plazo: credito.cuotas, tipo: credito.tipo,
        usuario: usuarios['demo.credito'], fecha: credito.desembolso, segmento: credito.segmento,
      });

    const fila = await unica(tx,
      `INSERT INTO tecnifin.creditos
         (codigo, solicitud_id, socio_id, monto, saldo, tasa, plazo, tipo, estado,
          fecha_desembolso, fecha_vencimiento, segmento)
       VALUES (@codigo, @solicitud, @socio, @monto, @saldo, @tasa, @plazo, @tipo, 'VIGENTE',
               @desembolso::date, @vencimiento::date, @segmento) RETURNING credito_id`,
      {
        codigo: credito.codigo, solicitud: solicitud.solicitud_id, socio: socio.socioId,
        monto: credito.monto, saldo, tasa: credito.tasa, plazo: credito.cuotas, tipo: credito.tipo,
        desembolso: credito.desembolso, vencimiento: mesesDespues(credito.desembolso, credito.cuotas),
        segmento: credito.segmento,
      });

    await tx.query(
      `INSERT INTO tecnifin.tabla_amortizacion
         (credito_id, numero_cuota, fecha_pago, capital, interes, total, estado, cuenta_capital)
       SELECT @credito, * FROM unnest(@numeros::integer[], @fechas::date[], @capitales::numeric[],
         @intereses::numeric[], @totales::numeric[], @estados::varchar[], @cuentasCuota::varchar[])`,
      {
        credito: fila.credito_id,
        numeros: cuotas.map(c => c.numero),
        fechas: cuotas.map(c => c.fecha), cuentasCuota: cuotas.map(c => c.cuenta),
        capitales: cuotas.map(c => c.capital), intereses: cuotas.map(c => c.interes),
        totales: cuotas.map(c => c.total),
        estados: cuotas.map(c => c.numero <= credito.pagadas ? 'PAGADA' : 'PENDIENTE'),
      });

    const mes = Number(credito.desembolso.slice(5, 7));
    await asentar(tx, {
      periodoId: periodos[mes], fecha: credito.desembolso, usuarioId: usuarios['demo.credito'],
      concepto: `Desembolso ${credito.codigo}`, origen: 'CREDITOS', origenId: credito.codigo, cuentas,
      lineas: [...porCuenta(cuotas).map(([codigo, valor]) => [codigo, 'D', valor, socio.socioId]),
        ['110105', 'H', credito.monto, null]],
    });
    for (const c of cuotas.slice(0, credito.pagadas)) {
      await asentar(tx, {
        periodoId: periodos[Number(c.fecha.slice(5, 7))], fecha: c.fecha, usuarioId: usuarios['demo.cajero'],
        concepto: `Pago cuota ${c.numero} ${credito.codigo}`, origen: 'CREDITOS', origenId: credito.codigo, cuentas,
        lineas: [['110105', 'D', c.total, null], [c.cuenta, 'H', c.capital, socio.socioId],
          [CUENTA_INTERES[credito.segmento], 'H', c.interes, socio.socioId]],
      });
    }

    // Cuota mas antigua sin pagar: es lo que define la mora de la operacion.
    const primeraImpaga = cuotas[credito.pagadas];
    const vence = mesesDespues(credito.desembolso, primeraImpaga.numero);
    resultado.push({
      ...credito, creditoId: fila.credito_id, socioId: socio.socioId, saldo,
      diasMora: Math.max(0, diasEntre(vence, FECHA_CORTE)),
    });
  }
  return resultado;
}

async function crearCaja(tx, { socios, usuarios, periodos, cuentas }) {
  const depositos = [[0, 500], [1, 300], [2, 1200]];
  const control = await unica(tx,
    `INSERT INTO tecnifin.control_caja
       (usuario_id, fecha, saldo_apertura, saldo_cierre, hora_cierre, estado)
     VALUES (@usuario, @fecha::date, 1000.00, @cierre, (@fecha || ' 17:30:00-05')::timestamptz, 'CERRADO')
     RETURNING control_id`,
    {
      usuario: usuarios['demo.cajero'], fecha: FECHA_CAJA,
      cierre: 1000 + depositos.reduce((s, d) => s + d[1], 0) + MONTO_DPF,
    });
  await tx.query(
    `INSERT INTO tecnifin.control_caja (usuario_id, fecha, saldo_apertura)
     VALUES (@usuario, DATE '2026-09-21', 1000.00)`, { usuario: usuarios['demo.cajero'] });

  for (const [indice, monto] of depositos) {
    const socio = socios[indice];
    const transaccion = await unica(tx,
      `INSERT INTO tecnifin.transacciones_caja
         (control_caja_id, socio_id, cuenta_id, tipo_operacion, monto, fecha_hora, usuario_id)
       VALUES (@control, @socio, @cuenta, 'DEPOSITO_AHORROS', @monto,
               (@fecha || ' 10:00:00-05')::timestamptz, @usuario) RETURNING transaccion_id`,
      { control: control.control_id, socio: socio.socioId, cuenta: socio.cuentaId, monto,
        fecha: FECHA_CAJA, usuario: usuarios['demo.cajero'] });
    await tx.query(
      `INSERT INTO tecnifin.detalle_efectivo_transaccion (transaccion_id, codigo_denominacion, cantidad, total)
       VALUES (@transaccion, 'B100', @cantidad, @monto)`,
      { transaccion: transaccion.transaccion_id, cantidad: monto / 100, monto });

    const asientoId = await asentarTransaccion(tx, transaccion.transaccion_id, {
      periodoId: periodos[9], fecha: FECHA_CAJA, usuarioId: usuarios['demo.cajero'],
      concepto: `Deposito en ahorros socio ${socio.numeroSocio}`, origen: 'CAJA', cuentas,
      lineas: [['110105', 'D', monto, null], ['210135', 'H', monto, socio.socioId]],
    });
    await tx.query(
      `INSERT INTO tecnifin.movimientos_cuenta
         (cuenta_id, tipo, monto, saldo_resultante, concepto, fecha, usuario_id,
          transaccion_caja_id, asiento_contable_id)
       VALUES (@cuenta, 'DEPOSITO', @monto, @monto, 'Deposito en ventanilla',
               (@fecha || ' 10:00:00-05')::timestamptz, @usuario, @transaccion, @asiento)`,
      { cuenta: socio.cuentaId, monto, fecha: FECHA_CAJA, usuario: usuarios['demo.cajero'],
        transaccion: transaccion.transaccion_id, asiento: asientoId });
    await tx.query('UPDATE tecnifin.cuentas SET saldo = @monto WHERE cuenta_id = @cuenta',
      { monto, cuenta: socio.cuentaId });
  }
  return { controlId: control.control_id };
}

async function crearPlazoFijo(tx, { socios, usuarios, periodos, cuentas, tasaDpf, controlId }) {
  const socio = socios[3];
  const correlativo = await unica(tx, `SELECT tecnifin.siguiente_numero('dpf_202609') AS n`);
  const codigo = `DPF-202609-${String(correlativo.n).padStart(4, '0')}`;
  // 5.50% nominal anual sobre 90 dias con la base del parametro dpf.base_dias (365, patron 07);
  // con 360 la liquidacion pagaria distinto de lo proyectado. Retencion del 2%.
  const interes = centavos(MONTO_DPF * 5.5 / 100 * 90 / 365);
  const retencion = centavos(interes * 0.02);

  const deposito = await unica(tx,
    `INSERT INTO tecnifin.depositos_plazo
       (codigo, socio_id, identificacion, nombre_socio, num_certificado, tasa_id, tasa_nominal_anual,
        plazo_dias, monto_capital, interes_proyectado, retencion_proyectada, interes_neto_proyectado,
        fecha_apertura, fecha_vencimiento, cuenta_ahorros_id, cuenta_contable_dpf, usuario_apertura_id)
     VALUES (@codigo, @socio, @cedula, @nombre, @certificado, @tasa, 5.5000, 90, @monto,
             @interes, @retencion, @neto, @fecha::date, DATE '2026-12-17', @cuenta, '210310', @usuario)
     RETURNING deposito_id`,
    {
      codigo, socio: socio.socioId, cedula: socio.cedula,
      nombre: `${socio.nombre} ${socio.apellido1} ${socio.apellido2}`,
      certificado: String(correlativo.n).padStart(6, '0'), tasa: tasaDpf, monto: MONTO_DPF,
      interes, retencion, neto: centavos(interes - retencion),
      fecha: FECHA_CAJA, cuenta: socio.cuentaId, usuario: usuarios['demo.cajero'],
    });

  const transaccion = await unica(tx,
    `INSERT INTO tecnifin.transacciones_caja
       (control_caja_id, socio_id, deposito_plazo_id, tipo_operacion, monto, fecha_hora, usuario_id)
     VALUES (@control, @socio, @deposito, 'APERTURA_DPF', @monto,
             (@fecha || ' 11:30:00-05')::timestamptz, @usuario) RETURNING transaccion_id`,
    { control: controlId, socio: socio.socioId, deposito: deposito.deposito_id, monto: MONTO_DPF,
      fecha: FECHA_CAJA, usuario: usuarios['demo.cajero'] });

  await asentarTransaccion(tx, transaccion.transaccion_id, {
    periodoId: periodos[9], fecha: FECHA_CAJA, usuarioId: usuarios['demo.cajero'],
    concepto: `Apertura ${codigo}`, origen: 'PLAZO_FIJO', origenId: codigo, cuentas,
    lineas: [['110105', 'D', MONTO_DPF, null], ['210310', 'H', MONTO_DPF, socio.socioId]],
  });
  return { codigo };
}

// Calificacion y provision de cada operacion, leidas de parametros_provision_cartera: ni
// un porcentaje ni un rango de dias escritos aqui. Y una corrida SIMULADA del proceso de
// cartera con su detalle, que es lo que la pantalla de reclasificacion muestra.
async function crearCarteraSeps(tx, { creditos, usuarios }) {
  let provisionTotal = 0, improductiva = 0, bruta = 0;
  const detalle = [];
  for (const credito of creditos) {
    const parametro = await unica(tx,
      `SELECT calificacion, porcentaje_provision, cuenta_provision
         FROM tecnifin.parametros_provision_cartera
        WHERE segmento = @segmento AND activo
          AND @dias BETWEEN dias_mora_desde AND coalesce(dias_mora_hasta, 2147483647)`,
      { segmento: credito.segmento, dias: credito.diasMora });
    const provision = centavos(credito.saldo * Number(parametro.porcentaje_provision));
    await tx.query(
      `INSERT INTO tecnifin.calificacion_cartera
         (credito_id, fecha_corte, saldo_capital, dias_mora, categoria, porcentaje_provision, valor_provision)
       VALUES (@credito, @corte::date, @saldo, @dias, @categoria, @porcentaje, @provision)`,
      {
        credito: credito.creditoId, corte: FECHA_CORTE, saldo: credito.saldo, dias: credito.diasMora,
        categoria: parametro.calificacion, porcentaje: parametro.porcentaje_provision, provision,
      });
    provisionTotal += provision;
    bruta += credito.saldo;
    if (credito.diasMora > 0) improductiva += credito.saldo;
    detalle.push({ credito, parametro, provision });
  }

  const provisionRequerida = centavos(provisionTotal);
  const proceso = await unica(tx,
    `INSERT INTO tecnifin.reclasificacion_cartera
       (fecha_corte, estado, usuario_id, operaciones_evaluadas, monto_reclasificado, cartera_bruta,
        cartera_improductiva, provision_requerida, observaciones)
     VALUES (@corte::date, 'SIMULADO', @usuario, @operaciones, @reclasificado, @bruta, @improductiva,
             @provision, 'Corrida de demostracion: simula, no aplica')
     RETURNING proceso_id`,
    {
      corte: FECHA_CORTE, usuario: usuarios['demo.cartera'], operaciones: creditos.length,
      reclasificado: centavos(improductiva), bruta: centavos(bruta),
      improductiva: centavos(improductiva), provision: provisionRequerida,
    });

  // Renglones con signo: negativo sale de la cuenta, positivo entra. La reversa los
  // invierte, por eso el detalle se guarda y no se recalcula.
  const movida = detalle.find(d => d.credito.diasMora > 0);
  if (movida) {
    await tx.query(
      `INSERT INTO tecnifin.reclasificacion_cartera_detalle
         (proceso_id, tipo, segmento, cuenta_origen, cuenta_destino, estado_destino, banda_destino,
          calificacion, operaciones, monto)
       VALUES (@proceso, 'RECLASIFICACION', @segmento, '140205', NULL, 'POR_VENCER', NULL, NULL, 1, @salida),
              (@proceso, 'RECLASIFICACION', @segmento, NULL, '142210', 'VENCIDA', 'De 31 a 90 dias',
               @calificacion, 1, @entrada)`,
      {
        proceso: proceso.proceso_id, segmento: movida.credito.segmento,
        salida: -movida.credito.saldo, entrada: movida.credito.saldo,
        calificacion: movida.parametro.calificacion,
      });
  }
  for (const d of detalle.filter(x => x.provision > 0)) {
    await tx.query(
      `INSERT INTO tecnifin.reclasificacion_cartera_detalle
         (proceso_id, tipo, segmento, cuenta_origen, cuenta_destino, calificacion, operaciones, monto)
       VALUES (@proceso, 'PROVISION', @segmento, '440210', @cuenta, @calificacion, 1, @monto)`,
      {
        proceso: proceso.proceso_id, segmento: d.credito.segmento,
        cuenta: d.parametro.cuenta_provision, calificacion: d.parametro.calificacion, monto: d.provision,
      });
  }
}

// Punto de entrada. `hash` recibe un texto y devuelve (una promesa de) el hash que se
// guarda; lo provee quien llama para que esta funcion no decida nada sobre credenciales.
export async function construirDemo({ admin, withTenant, hash }) {
  // Derivar un secreto cuesta a proposito -- son siete y suman unas decimas de segundo --
  // asi que se resuelven TODOS antes de abrir la transaccion. Dentro, cada uno seria
  // tiempo de una transaccion abierta reteniendo bloqueos para no hacer nada con la base.
  const aDerivar = [...USUARIOS.map(u => u[0]), ...SOCIOS.map(s => `pin-${s.cedula}`)];
  const secretos = new Map(await Promise.all(
    aDerivar.map(async texto => [texto, await hash(texto)])));

  const cooperativa = await altaCooperativa(admin, withTenant, COOPERATIVA_DEMO);
  const resumen = await withTenant(cooperativa.cooperativa_id, async tx => {
    const usuarios = await crearUsuarios(tx, secretos);
    const { productoId, tasaDpf } = await crearCatalogosPropios(tx, usuarios);
    const socios = await crearSocios(tx, productoId, secretos);
    const { periodos, cuentas, bandas } = await crearContabilidad(tx);
    const creditos = await crearCreditos(tx, { socios, usuarios, periodos, cuentas, bandas });
    const caja = await crearCaja(tx, { socios, usuarios, periodos, cuentas });
    const dpf = await crearPlazoFijo(tx, { socios, usuarios, periodos, cuentas, tasaDpf, ...caja });
    await crearCarteraSeps(tx, { creditos, usuarios });
    return {
      usuarios: Object.keys(usuarios).length, socios: socios.length,
      creditos: creditos.length, plazoFijo: dpf.codigo,
    };
  });
  return { cooperativa, ...resumen };
}
