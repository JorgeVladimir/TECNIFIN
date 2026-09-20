// Fabrica de datos: dos cooperativas con contenido equivalente. Es la base de toda
// prueba de aislamiento -- si A y B no tienen lo mismo, "no veo nada de B" no prueba nada.
// Las altas de negocio se hacen SIEMPRE por withTenant, igual que la aplicacion, y
// NINGUNA pasa cooperativa_id: lo pone el DEFAULT que instala tecnifin.aplicar_rls().
// Tampoco pasan el numero de socio ni el de cuenta: los pone tecnifin.siguiente_numero().

// Alta de cooperativas: operacion de plataforma, la hace el dueno del esquema. La
// aplicacion no tiene INSERT sobre tecnifin.cooperativas (ver 0010_rls_y_permisos.sql).
export async function crearDosCooperativas(admin) {
  const filas = await admin.query(
    `INSERT INTO tecnifin.cooperativas (codigo, razon_social, ruc, nombre_comercial)
     VALUES ('COOP-A', 'Cooperativa Alfa', '1800000000011', 'Alfa'),
            ('COOP-B', 'Cooperativa Beta', '1800000000022', 'Beta')
     RETURNING cooperativa_id, codigo, nombre_comercial AS nombre`);
  return filas.rows;
}

// Siembra el minimo viable de cada dominio dentro de una cooperativa: usuario, plan de
// cuentas, producto, socio, cuenta, periodo, asiento cuadrado y denominaciones.
export async function sembrarCooperativa(withTenant, cooperativaId, etiqueta) {
  return withTenant(cooperativaId, async tx => {
    const unica = async (sql, params) => (await tx.query(sql, params)).rows[0];

    const usuario = await unica(
      `INSERT INTO tecnifin.usuarios (login, nombre_completo, password_hash, rol)
       VALUES ('admin', @nombre, 'hash-de-prueba', 'ADMIN') RETURNING usuario_id`,
      { nombre: `Administrador ${etiqueta}` });

    // Plan de cuentas minimo, con codigos de digitos sin puntos y una cuenta agrupadora.
    // El producto y las tasas no pueden existir antes que el catalogo: desde 0009 sus
    // codigos contables son FK reales contra plan_cuentas.
    const cuentas = await tx.query(
      `INSERT INTO tecnifin.plan_cuentas (codigo, nombre, tipo_cuenta, es_agrupador)
       VALUES ('11', 'FONDOS DISPONIBLES', 'ACTIVO', true),
              ('210135', 'DEPOSITOS DE AHORRO', 'PASIVO', false)
       RETURNING cuenta_contable_id, codigo`);
    const porCodigo = Object.fromEntries(cuentas.rows.map(f => [f.codigo, f.cuenta_contable_id]));
    const caja = await unica(
      `INSERT INTO tecnifin.plan_cuentas (codigo, nombre, tipo_cuenta, cuenta_padre_id)
       VALUES ('110105', 'CAJA', 'ACTIVO', @padre) RETURNING cuenta_contable_id`,
      { padre: porCodigo['11'] });

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
      { asiento: asiento.asiento_id, debe: caja.cuenta_contable_id,
        haber: porCodigo['210135'], socio: socio.socio_id });

    await tx.query(
      `INSERT INTO tecnifin.denominaciones (codigo_denominacion, valor, tipo, descripcion)
       VALUES ('B20', 20.00, 'BILLETE', 'Billete de 20'),
              ('B10', 10.00, 'BILLETE', 'Billete de 10')`);

    return {
      cooperativaId, etiqueta,
      usuarioId: usuario.usuario_id,
      socioId: socio.socio_id,
      numeroSocio: socio.numero_socio,
      productoId: producto.producto_id,
      cuentaId: cuenta.cuenta_id,
      periodoId: periodo.periodo_id,
      asientoId: asiento.asiento_id,
      cuentaCajaId: caja.cuenta_contable_id,
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
