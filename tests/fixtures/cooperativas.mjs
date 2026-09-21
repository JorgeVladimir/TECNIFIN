// Fabrica de datos: dos cooperativas con contenido equivalente. Es la base de toda
// prueba de aislamiento -- si A y B no tienen lo mismo, "no veo nada de B" no prueba nada.
// Las altas de negocio se hacen SIEMPRE por withTenant, igual que la aplicacion, y
// NINGUNA pasa cooperativa_id: lo pone el DEFAULT que instala tecnifin.aplicar_rls().
// Tampoco pasan el numero de socio ni el de cuenta: los pone tecnifin.siguiente_numero().
import { altaCooperativa } from '../../src/platform/semillas.js';
import { hashearClave } from '../../src/platform/credenciales.js';

// El alta pasa por la MISMA funcion que usa el sistema (regla 13): crea la fila de
// plataforma con el rol dueno y siembra los catalogos SEPS de esa cooperativa por
// withTenant. Asi la prueba de aislamiento ejercita el camino real del alta, no una
// version reducida que podria divergir.
export async function crearDosCooperativas(admin, withTenant) {
  // En paralelo: son tenants distintos y cada alta siembra ~1.300 filas. Ponerlas en
  // serie duplica el arranque de cada prueba sin ganar nada.
  return Promise.all([
    { codigo: 'COOP-A', razonSocial: 'Cooperativa Alfa', ruc: '1800000000011', nombreComercial: 'Alfa' },
    { codigo: 'COOP-B', razonSocial: 'Cooperativa Beta', ruc: '1800000000022', nombreComercial: 'Beta' },
  ].map(fila => altaCooperativa(admin, withTenant, fila)));
}

// Siembra el minimo viable de cada dominio dentro de una cooperativa: usuario, producto,
// socio, cuenta, periodo y asiento cuadrado. El plan de cuentas y las denominaciones ya
// los sembro el alta; aqui solo se buscan los codigos que hacen falta.
export async function sembrarCooperativa(withTenant, cooperativaId, etiqueta) {
  return withTenant(cooperativaId, async tx => {
    const unica = async (sql, params) => (await tx.query(sql, params)).rows[0];

    const usuario = await unica(
      `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
       VALUES ('admin', @nombre, 'hash-de-prueba', 'ADMIN') RETURNING usuario_id`,
      { nombre: `Administrador ${etiqueta}` });

    // Del Catalogo Unico ya sembrado: una agrupadora ('11'), la caja y los ahorros.
    const cuentas = await tx.query(
      `SELECT codigo, cuenta_contable_id, es_agrupador FROM tecnifin.plan_cuentas
        WHERE codigo IN ('11', '110105', '210135')`);
    const porCodigo = Object.fromEntries(cuentas.rows.map(f => [f.codigo, f.cuenta_contable_id]));

    const producto = await unica(
      `INSERT INTO tecnifin.productos_financieros
         (codigo_producto, nombre, tipo_deposito, cuenta_activa, cuenta_inactiva)
       VALUES (2, 'AHORRO A LA VISTA', 'AHORRO A LA VISTA', '210135', '210135')
       RETURNING producto_id`);

    const socio = await crearSocio(tx, `${etiqueta}0000001`, etiqueta);
    const cuenta = await unica(
      `INSERT INTO tecnifin.cuentas (socio_id, producto_id) VALUES (@socio, @producto)
       RETURNING cuenta_id, numero_cuenta`,
      { socio: socio.socio_id, producto: producto.producto_id });

    const periodo = await unica(
      `INSERT INTO tecnifin.periodos_contables (anio, mes) VALUES (2026, 9) RETURNING periodo_id`);

    const asiento = await unica(
      `INSERT INTO tecnifin.asientos_contables (periodo_contable_id, fecha, concepto, usuario_id, origen_modulo)
       VALUES (@periodo, DATE '2026-09-20', @concepto, @usuario, 'CAJA') RETURNING asiento_id`,
      { periodo: periodo.periodo_id, usuario: usuario.usuario_id, concepto: `Deposito de apertura ${etiqueta}` });

    await tx.query(
      `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor, socio_id)
       VALUES (@asiento, @debe, 'D', 100.00, @socio),
              (@asiento, @haber, 'H', 100.00, @socio)`,
      { asiento: asiento.asiento_id, debe: porCodigo['110105'],
        haber: porCodigo['210135'], socio: socio.socio_id });

    // Una corrida del proceso de cartera y una activacion del canal en linea: son las
    // tablas de DAT-02, y sin datos en ellas la prueba de aislamiento no las examina.
    const proceso = await unica(
      `INSERT INTO tecnifin.reclasificacion_cartera (fecha_corte, usuario_id, observaciones)
       VALUES (DATE '2026-09-30', @usuario, @observacion) RETURNING proceso_id`,
      { usuario: usuario.usuario_id, observacion: `Simulacion de ${etiqueta}` });
    await tx.query(
      `INSERT INTO tecnifin.reclasificacion_cartera_detalle
         (proceso_id, tipo, segmento, cuenta_origen, cuenta_destino, operaciones, monto)
       VALUES (@proceso, 'RECLASIFICACION', 'CONSUMO', '140205', '142210', 1, 100.00)`,
      { proceso: proceso.proceso_id });
    // El PIN se deriva con la MISMA funcion que usa el sistema: el dominio
    // tecnifin.hash_secreto exige ese formato, asi que un hash inventado aqui haria que
    // la prueba pasara con una forma de dato que la aplicacion nunca produce.
    await tx.query(
      `INSERT INTO tecnifin.activacion_banca_linea
         (socio_id, pin_hash, acepto_datos_personales, fecha_aceptacion_datos, activo)
       VALUES (@socio, @pin, true, now(), true)`,
      { socio: socio.socio_id, pin: await hashearClave(`socio-${etiqueta}`, '1234') });
    await tx.query(
      `INSERT INTO tecnifin.socio_documento_excepcion (socio_id, identificacion, imagen_frontal, tipo_mime)
       VALUES (@socio, @identificacion, @imagen, 'image/png')`,
      { socio: socio.socio_id, identificacion: `${etiqueta}0000001`,
        imagen: Buffer.from('89504e470d0a1a0a', 'hex') });
    await tx.query(
      `INSERT INTO tecnifin.tasas_credito
         (linea_credito, clase_credito, monto_minimo, monto_maximo, plazo_minimo, plazo_maximo,
          tasa_inicial, tasa_final, tasa_aplicable)
       VALUES (@linea, 'CONSUMO', 100.00, 20000.00, 3, 48, 14.0000, 16.0000, 15.0000)`,
      { linea: `CONSUMO ${etiqueta}` });

    return {
      cooperativaId, etiqueta,
      usuarioId: usuario.usuario_id,
      socioId: socio.socio_id,
      numeroSocio: socio.numero_socio,
      productoId: producto.producto_id,
      cuentaId: cuenta.cuenta_id,
      periodoId: periodo.periodo_id,
      asientoId: asiento.asiento_id,
      procesoCarteraId: proceso.proceso_id,
      cuentaCajaId: porCodigo['110105'],
      cuentaAhorrosId: porCodigo['210135'],
      cuentaAgrupadoraId: porCodigo['11'],
    };
  });
}

// numero_socio no se pasa: su DEFAULT es tecnifin.siguiente_numero('socio'), el unico
// generador de correlativos del modelo (por cooperativa, desde 1 y sin huecos).
export async function crearSocio(tx, identificacion, etiqueta) {
  const filas = await tx.query(
    `INSERT INTO tecnifin.socios
       (tipo_persona, tipo_identificacion, identificacion, primer_nombre, primer_apellido, pin)
     VALUES ('SOCIO', 'CEDULA', @identificacion, 'PRUEBA', @apellido, '1234')
     RETURNING socio_id, numero_socio`,
    { identificacion, apellido: `PEREZ ${etiqueta}` });
  return filas.rows[0];
}
