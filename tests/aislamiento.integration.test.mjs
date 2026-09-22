// Aislamiento entre cooperativas, contra una base EFIMERA que se crea y se borra sola.
// Es la prueba que H1 existe para tener: en el sistema viejo,
// 11_prueba_aislamiento_multicooperativa.sql demostro con datos reales que el aislamiento
// por convencion de la aplicacion ya habia fallado. Aqui lo impide el motor.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { REPO_ROOT, entornoAdmin } from '../tools/_env.mjs';
import {
  conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase, tablasDeNegocio, recorrerTablas,
} from '../tools/_local.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { crearDosCooperativas, sembrarCooperativa, crearSocio } from './fixtures/cooperativas.mjs';

const ejecutar = promisify(execFile);
const nombreBase = `tecnifin_aisl_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };
const migrar = args => ejecutar(process.execPath, ['tools/migrate.mjs', ...args],
  { cwd: REPO_ROOT, env: entorno, windowsHide: true });

let app, admin, withTenant, creada = false;
let coopA, coopB, datosA, datosB, tablas;

const recorrer = (ejecutor, expresion) => recorrerTablas(ejecutor, tablas, expresion);

const crearAsientoPrueba = async (tx, concepto) => (await tx.query(
  `INSERT INTO tecnifin.asientos_contables (periodo_contable_id, fecha, concepto, usuario_id, origen_modulo)
   VALUES (@periodo, DATE '2026-09-21', @concepto, @usuario, 'MANUAL') RETURNING asiento_id`,
  { periodo: datosA.periodoId, usuario: datosA.usuarioId, concepto })).rows[0].asiento_id;

before(async () => {
  const configuracion = postgresConfig();
  // Misma provision que la base real: dueno, GRANT CONNECT y REVOKE CREATE incluidos.
  await crearBaseLocal(configuracion, nombreBase,
    { dueno: entornoAdmin().TECNIFIN_PG_USER, aplicacion: configuracion.user });
  creada = true;

  await migrarBase(entorno);

  admin = connectPostgres(entornoAdmin(entorno));
  app = connectPostgres(entorno);
  withTenant = crearWithTenant(app);

  [coopA, coopB] = await crearDosCooperativas(admin, withTenant);
  // Tenants distintos: no hay motivo para sembrarlos en serie.
  [datosA, datosB] = await Promise.all([
    sembrarCooperativa(withTenant, coopA.cooperativa_id, 'ALFA'),
    sembrarCooperativa(withTenant, coopB.cooperativa_id, 'BETA'),
  ]);

  tablas = await tablasDeNegocio(admin);
});

after(async () => {
  if (app) await app.close();
  if (admin) await admin.close();
  if (creada) {
    const superusuario = await conectarSuperusuario(postgresConfig());
    try { await borrarBaseLocal(superusuario, nombreBase); }
    finally { await superusuario.end(); }
  }
});

// (iv) Catalogo: ninguna tabla puede quedarse fuera del aislamiento por olvido.
// La regla vive en tecnifin.verificar_invariantes() y la exige migrate.mjs tras cada
// migracion; aqui se comprueba que sigue valiendo y se agrega lo que el SQL no ve: los
// duenos de los objetos y los atributos del rol de la aplicacion.
test('el esquema cumple sus invariantes y la aplicacion no es duena ni tiene BYPASSRLS', async () => {
  const problemas = await admin.query('SELECT objeto, problema FROM tecnifin.verificar_invariantes()');
  assert.deepEqual(problemas.rows, []);

  const dueno = entornoAdmin().TECNIFIN_PG_USER;
  const aplicacion = postgresConfig().user;
  const catalogo = await admin.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE pg_get_userbyid(relowner) <> @dueno)::int AS ajenas,
            count(*) FILTER (WHERE NOT relforcerowsecurity)::int AS sin_force
       FROM pg_class
      WHERE relnamespace = 'tecnifin'::regnamespace AND relkind = 'r'`, { dueno });
  // 41 = las 40 de DAT-01/DAT-02 mas parametros_cooperativa de APP-01. Si cambia, se actualiza el
  // inventario de ADR-0003 a la vez.
  assert.deepEqual(catalogo.rows[0], { total: 41, ajenas: 0, sin_force: 0 },
    'toda tabla del esquema es del dueno y lleva FORCE, sin excepciones');
  assert.equal(tablas.length, 39, 'solo cooperativas y parametros_plataforma son de plataforma');

  const rol = await admin.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = @rol`,
    { rol: aplicacion });
  assert.deepEqual(rol.rows[0], { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });

  const propias = await admin.query(
    `SELECT count(*)::int AS n FROM pg_class
      WHERE relnamespace = 'tecnifin'::regnamespace AND pg_get_userbyid(relowner) = @rol`,
    { rol: aplicacion });
  assert.equal(propias.rows[0].n, 0, 'la aplicacion no es duena de ningun objeto del esquema');
});

test('el verificador de invariantes incluye las raices particionadas', async () => {
  await assert.rejects(
    admin.transaction(async tx => {
      await tx.query(
        `CREATE TABLE tecnifin.sonda_particionada (
           cooperativa_id integer NOT NULL, id integer NOT NULL
         ) PARTITION BY RANGE (id)`);
      const problemas = await tx.query(
        `SELECT problema FROM tecnifin.verificar_invariantes()
          WHERE objeto = 'sonda_particionada' ORDER BY problema`);
      assert.deepEqual(problemas.rows, [
        { problema: 'RLS sin habilitar, sin FORCE o sin politica' },
      ]);
      throw new Error('revertir sonda particionada');
    }),
    /revertir sonda particionada/,
  );
});

test('todas las columnas de dinero usan el dominio finito', async () => {
  const tipos = await admin.query(
    `SELECT count(*) FILTER (WHERE t.typname = 'dinero')::int AS con_dominio,
            count(*) FILTER (WHERE format_type(a.atttypid, a.atttypmod) = 'numeric(18,2)')::int AS crudas
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE c.relnamespace = 'tecnifin'::regnamespace AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped`);
  assert.ok(tipos.rows[0].con_dominio > 30, 'las columnas monetarias fueron migradas al dominio comun');
  assert.equal(tipos.rows[0].crudas, 0, 'no queda dinero como numeric(18,2) sin el dominio');

  await assert.rejects(
    admin.query(`SELECT 'NaN'::tecnifin.dinero`),
    error => error.code === '23514' && error.constraint === 'ck_dinero_finito',
    'NaN debe ser rechazado por el dominio de dinero',
  );
  for (const valor of ['Infinity', '-Infinity']) {
    await assert.rejects(
      admin.query(`SELECT @valor::tecnifin.dinero`, { valor }),
      error => ['22003', '23514'].includes(error.code),
      `${valor} debe ser rechazado por el importe con precision acotada`,
    );
  }
});

// (ii) Sin tenant fijado no se ve el universo: se ven cero filas.
test('sin withTenant no se ve ninguna fila de ninguna tabla de negocio', async () => {
  const visto = await recorrer(app, 'count(*)::int AS n');
  assert.deepEqual(visto.rows.filter(f => f.n !== 0), [], 'alguna tabla devolvio filas sin tenant');

  // Tambien falla cerrada al escribir: sin tenant, el DEFAULT de cooperativa_id queda
  // NULL y el WITH CHECK de la politica no calza (42501). La fila no se escribe "sin
  // cooperativa": no se escribe.
  await assert.rejects(
    app.query(`INSERT INTO tecnifin.auditoria_procesos (proceso, accion, entidad_tipo, usuario_login)
               VALUES ('SEGURIDAD', 'PRUEBA', 'SOCIO', 'admin')`),
    error => error.code === '42501');
  // Y el mismo rol, con tenant, si puede leer: la prueba anterior no fue un falso verde.
  const conTenant = await withTenant(coopA.cooperativa_id, tx =>
    tx.query('SELECT count(*)::int AS n FROM tecnifin.socios'));
  assert.ok(conTenant.rows[0].n > 0);
});

// (i) A no ve ni modifica filas de B. Portacion de 11_prueba_aislamiento_multicooperativa.sql.
test('la cooperativa A no lee ni escribe filas de la B en ninguna tabla', async () => {
  for (const propia of [coopA, coopB]) {
    const visto = await withTenant(propia.cooperativa_id, tx =>
      recorrer(tx, `count(*)::int AS total,
        count(*) FILTER (WHERE cooperativa_id <> ${propia.cooperativa_id})::int AS ajenas`));
    assert.deepEqual(visto.rows.filter(f => f.ajenas > 0), [],
      `filas de otra cooperativa visibles desde ${propia.codigo}`);
    assert.ok(visto.rows.filter(f => f.total > 0).length >= 10,
      'la fabrica tiene que dejar datos en varios dominios');
  }

  // Modificar: un UPDATE sin WHERE dentro del tenant alcanza solo a las filas del tenant.
  const tocadas = await withTenant(coopA.cooperativa_id, async tx =>
    (await tx.query(`UPDATE tecnifin.socios SET estado = 'INACTIVO'`)).rowCount);
  const estadoB = await withTenant(coopB.cooperativa_id, tx =>
    tx.query(`SELECT count(*)::int AS n FROM tecnifin.socios WHERE estado = 'ACTIVO'`));
  assert.ok(tocadas >= 1);
  assert.equal(estadoB.rows[0].n, 1, 'el UPDATE de A no toco a B');
  await withTenant(coopA.cooperativa_id, tx => tx.query(`UPDATE tecnifin.socios SET estado = 'ACTIVO'`));

  // Escribir con el tenant del otro esta prohibido por el WITH CHECK de la politica.
  await assert.rejects(
    withTenant(coopA.cooperativa_id, tx => tx.query(
      `INSERT INTO tecnifin.auditoria_usuarios (cooperativa_id, usuario_login, concepto, detalle)
       VALUES (@coop, 'admin', 'PRUEBA', 'fuga')`, { coop: coopB.cooperativa_id })),
    error => error.code === '42501');
});

// (iii) FK compuesta: el motor rechaza el hijo cuyo padre es de otra cooperativa.
// Es el bug de la seccion 6 de 11_..., que en SQL Server paso sin error.
test('una FK compuesta impide colgar un registro del padre de otra cooperativa', async () => {
  await assert.rejects(
    withTenant(coopA.cooperativa_id, tx => tx.query(
      `INSERT INTO tecnifin.cuentas (socio_id, producto_id) VALUES (@socioAjeno, @producto)`,
      { socioAjeno: datosB.socioId, producto: datosA.productoId })),
    error => error.code === '23503', 'un socio de B no puede tener cuenta en A');

  await assert.rejects(
    withTenant(coopA.cooperativa_id, tx => tx.query(
      `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
       VALUES (@asiento, @cuentaAjena, 'D', 1.00)`,
      { asiento: datosA.asientoId, cuentaAjena: datosB.cuentaAhorrosId })),
    error => error.code === '23503', 'una cuenta contable de B no se puede usar en un asiento de A');

  // Y el catalogo contable tampoco se contamina: no se contabiliza contra una agrupadora.
  await assert.rejects(
    withTenant(coopA.cooperativa_id, tx => tx.query(
      `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
       VALUES (@asiento, @agrupadora, 'D', 1.00)`,
      { asiento: datosA.asientoId, agrupadora: datosA.cuentaAgrupadoraId })),
    error => error.code === '23514');
});

// (vii) Partida doble: la hace cumplir el motor al cerrar la transaccion.
test('un asiento descuadrado se rechaza al confirmar la transaccion', async () => {
  await assert.rejects(
    withTenant(coopA.cooperativa_id, async tx => {
      const asiento = await crearAsientoPrueba(tx, 'Asiento descuadrado');
      await tx.query(
        `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
         VALUES (@asiento, @debe, 'D', 100.00), (@asiento, @haber, 'H', 90.00)`,
        { asiento, debe: datosA.cuentaCajaId, haber: datosA.cuentaAhorrosId });
    }),
    error => error.code === '23514' && /descuadrado/.test(error.message));

  // El diferimiento es lo que permite armar el asiento linea por linea: entre las dos
  // filas el asiento esta descuadrado y aun asi la transaccion sigue viva.
  const cuadrado = await withTenant(coopA.cooperativa_id, async tx => {
    const asiento = await crearAsientoPrueba(tx, 'Asiento cuadrado en dos pasos');
    for (const [tipo, cuenta] of [['D', datosA.cuentaCajaId], ['H', datosA.cuentaAhorrosId]]) {
      await tx.query(
        `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
         VALUES (@asiento, @cuenta, @tipo, 55.55)`, { asiento, cuenta, tipo });
    }
    return asiento;
  });
  assert.ok(cuadrado > 0);

  // El asiento rechazado no dejo rastro: la cabecera se fue con el ROLLBACK.
  const conceptos = await withTenant(coopA.cooperativa_id, tx => tx.query(
    `SELECT count(*)::int AS n FROM tecnifin.asientos_contables WHERE concepto = 'Asiento descuadrado'`));
  assert.equal(conceptos.rows[0].n, 0);
});

test('el cuadre se recalcula tras cada cambio aunque ya se haya validado', async () => {
  await assert.rejects(
    withTenant(coopA.cooperativa_id, async tx => {
      const asiento = await crearAsientoPrueba(tx, 'Revalidacion de cuadre');
      await tx.query(
        `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
         VALUES (@asiento, @debe, 'D', 100.00), (@asiento, @haber, 'H', 100.00)`,
        { asiento, debe: datosA.cuentaCajaId, haber: datosA.cuentaAhorrosId });
      await tx.query('SET CONSTRAINTS tg_detalle_asiento_cuadre IMMEDIATE');
      await tx.query(
        `UPDATE tecnifin.detalle_asiento SET valor = 90.00
          WHERE asiento_id = @asiento AND tipo_asiento = 'H'`, { asiento });
    }),
    error => error.code === '23514' && /descuadrado/.test(error.message),
  );
});

test('cambiar el tenant antes de ejecutar el trigger diferido no elude el cuadre', async () => {
  await assert.rejects(
    withTenant(coopA.cooperativa_id, async tx => {
      const asiento = await crearAsientoPrueba(tx, 'Cuadre con tenant cambiado');
      await tx.query(
        `INSERT INTO tecnifin.detalle_asiento (asiento_id, cuenta_contable_id, tipo_asiento, valor)
         VALUES (@asiento, @debe, 'D', 100.00), (@asiento, @haber, 'H', 90.00)`,
        { asiento, debe: datosA.cuentaCajaId, haber: datosA.cuentaAhorrosId });
      await tx.query(`SELECT set_config('app.cooperativa_id', @tenant, true)`,
        { tenant: String(coopB.cooperativa_id) });
      await tx.query('SET CONSTRAINTS tg_detalle_asiento_cuadre IMMEDIATE');
    }),
    error => error.code === '23514' && /descuadrado/.test(error.message),
  );
});

test('una corrida aplicada exige asiento y provision contabilizada coherentes', async () => {
  for (const caso of [
    { asiento: null, provision: 100 },
    { asiento: datosA.asientoId, provision: 0 },
  ]) {
    await assert.rejects(
      withTenant(coopA.cooperativa_id, tx => tx.query(
        `INSERT INTO tecnifin.reclasificacion_cartera
           (fecha_corte, estado, usuario_id, asiento_id, provision_contabilizada)
         VALUES (DATE '2026-10-31', 'APLICADO', @usuario, @asiento, @provision)`,
        { usuario: datosA.usuarioId, ...caso })),
      error => error.code === '23514'
        && error.constraint === 'ck_reclasificacion_cartera_contabilizacion',
    );
  }

  await withTenant(coopA.cooperativa_id, tx => tx.query(
    `INSERT INTO tecnifin.reclasificacion_cartera
       (fecha_corte, estado, usuario_id, asiento_id, provision_contabilizada)
     VALUES (DATE '2026-10-31', 'APLICADO', @usuario, @asiento, 100.00)`,
    { usuario: datosA.usuarioId, asiento: datosA.asientoId }));
});

// (v) Numeracion por cooperativa desde 1, atomica y sin huecos bajo concurrencia.
test('la numeracion arranca en 1 por cooperativa y 20 altas paralelas no dejan huecos', async () => {
  assert.equal(String(datosA.numeroSocio), '1');
  assert.equal(String(datosB.numeroSocio), '1');

  const altas = [];
  for (const coop of [coopA, coopB]) {
    for (let i = 0; i < 20; i++) {
      altas.push(withTenant(coop.cooperativa_id, tx =>
        crearSocio(tx, `${coop.codigo}-${String(i).padStart(4, '0')}`, coop.codigo)));
    }
  }
  await Promise.all(altas);

  for (const coop of [coopA, coopB]) {
    const estado = await withTenant(coop.cooperativa_id, async tx => ({
      numeros: (await tx.query('SELECT numero_socio FROM tecnifin.socios ORDER BY numero_socio'))
        .rows.map(f => Number(f.numero_socio)),
      contador: (await tx.query(`SELECT valor FROM tecnifin.secuencias_tenant WHERE nombre = 'socio'`))
        .rows[0].valor,
    }));
    // 1 de la fabrica + 20 de las altas paralelas: exactamente 1..21, sin repetidos ni huecos.
    assert.deepEqual(estado.numeros, Array.from({ length: 21 }, (_, i) => i + 1),
      `numeracion con huecos o duplicados en ${coop.codigo}`);
    assert.equal(String(estado.contador), '21');
  }

  // Sin tenant el generador no inventa un numero: se niega.
  await assert.rejects(app.query(`SELECT tecnifin.siguiente_numero('socio')`),
    error => error.code === '42501');
  // Y el contador no retrocede ni aunque lo intente el dueno: lo impide el motor.
  await assert.rejects(
    withTenant(coopA.cooperativa_id, tx => tx.query(
      `UPDATE tecnifin.secuencias_tenant SET valor = 1 WHERE nombre = 'socio'`)),
    error => error.code === '23514');
});

// (vi) El tenant no se filtra entre transacciones que comparten el pool.
test('transacciones A y B concurrentes sobre el mismo pool no se contaminan', async () => {
  const tareas = [];
  for (let i = 0; i < 60; i++) {
    const coop = i % 2 === 0 ? coopA : coopB;
    tareas.push(withTenant(coop.cooperativa_id, async tx => {
      const visto = await tx.query(
        `SELECT coalesce(array_agg(DISTINCT cooperativa_id), '{}') AS tenants,
                current_setting('app.cooperativa_id') AS fijado
           FROM tecnifin.socios`);
      return { esperado: coop.cooperativa_id, ...visto.rows[0] };
    }));
  }
  for (const r of await Promise.all(tareas)) {
    assert.deepEqual(r.tenants, [r.esperado], 'una transaccion vio el tenant de otra');
    assert.equal(Number(r.fijado), r.esperado);
  }

  // SET LOCAL muere con la transaccion: la conexion vuelve limpia al pool.
  const despues = await app.query(`SELECT current_setting('app.cooperativa_id', true) AS valor`);
  assert.ok(despues.rows[0].valor === null || despues.rows[0].valor === '');
  assert.equal(app.stats().total - app.stats().idle, 0, 'quedaron conexiones tomadas');
});

// Caracterizacion del riesgo ACEPTADO SOLO PROVISIONALMENTE (ADR-0002, ALTO 1).
// Verde significa que el riesgo sigue reproducible; NO certifica resistencia a SQL arbitrario.
test('ALTO 1 residual: SQL arbitrario bajo tecnifin_app puede leer y escribir otro tenant', async () => {
  const revertir = new Error('revertir sonda ALTO 1');
  const leer = tx => tx.query('SELECT cooperativa_id, nombre_completo FROM tecnifin.usuarios WHERE usuario_id = @id',
    { id: datosB.usuarioId });
  const original = await withTenant(coopB.cooperativa_id, leer);
  assert.equal(original.rows.length, 1);
  await assert.rejects(withTenant(coopA.cooperativa_id, async tx => {
    const inicial = await tx.query('SELECT DISTINCT cooperativa_id FROM tecnifin.usuarios');
    assert.deepEqual(inicial.rows, [{ cooperativa_id: coopA.cooperativa_id }]);
    // Pasa por bindNamed: parametrizar valores no autoriza el texto SQL.
    await tx.query("SELECT set_config('app.cooperativa_id', @tenant, true)",
      { tenant: String(coopB.cooperativa_id) });
    assert.deepEqual((await leer(tx)).rows, original.rows);
    const escritura = await tx.query(
      `UPDATE tecnifin.usuarios SET nombre_completo = 'Sonda ALTO 1'
        WHERE usuario_id = @id RETURNING cooperativa_id, nombre_completo`, { id: datosB.usuarioId });
    assert.deepEqual(escritura.rows, [{ cooperativa_id: coopB.cooperativa_id, nombre_completo: 'Sonda ALTO 1' }]);
    throw revertir;
  }), error => error === revertir);
  assert.deepEqual((await withTenant(coopB.cooperativa_id, leer)).rows, original.rows,
    'la sonda debe revertir toda escritura');
});

test('el rol de la aplicacion no hace DDL y la auditoria es append-only', async () => {
  for (const sentencia of ['ALTER TABLE tecnifin.socios ADD COLUMN colado integer',
    'CREATE TABLE tecnifin.colada (id integer)', 'SET ROLE tecnifin_admin']) {
    await assert.rejects(app.query(sentencia), error => error.code === '42501', sentencia);
  }

  await withTenant(coopA.cooperativa_id, tx => tx.query(
    `INSERT INTO tecnifin.auditoria_procesos (proceso, accion, entidad_tipo, usuario_login, detalle)
     VALUES ('SEGURIDAD', 'LOGIN_FALLIDO', 'USUARIO', 'no.existe', 'usuario inexistente')`));
  for (const sentencia of [`UPDATE tecnifin.auditoria_procesos SET detalle = 'editado'`,
    'DELETE FROM tecnifin.auditoria_procesos']) {
    await assert.rejects(withTenant(coopA.cooperativa_id, tx => tx.query(sentencia)),
      error => error.code === '42501', sentencia);
  }
  // El dueno tampoco puede: el append-only es un trigger, no solo un REVOKE. Necesita
  // withTenant igual que la aplicacion -- con FORCE, el dueno tampoco ve filas sin tenant.
  await assert.rejects(
    crearWithTenant(admin)(coopA.cooperativa_id, tx =>
      tx.query(`UPDATE tecnifin.auditoria_procesos SET detalle = 'editado'`)),
    error => error.code === '42501' && /solo agregar/.test(error.message));
});

test('el codigo contable solo acepta digitos y el migrador detecta un archivo alterado', async () => {
  await assert.rejects(
    withTenant(coopA.cooperativa_id, tx => tx.query(
      `INSERT INTO tecnifin.plan_cuentas (codigo, nombre, tipo_cuenta)
       VALUES ('2.1.03.05', 'PUNTEADO', 'PASIVO')`)),
    error => error.code === '23514');
  // Codigo fuera del Catalogo Unico sembrado: el catalogo ya ocupa los reales.
  await withTenant(coopA.cooperativa_id, tx => tx.query(
    `INSERT INTO tecnifin.plan_cuentas (codigo, nombre, tipo_cuenta)
     VALUES ('888888', 'CUENTA PROPIA DE LA COOPERATIVA', 'PASIVO')`));

  await admin.query(
    `UPDATE public.tecnifin_schema_migrations SET content_hash = 'alterado' WHERE file_name = '0001_plataforma.sql'`);
  await assert.rejects(migrar([]),
    error => error.stderr.includes('Migracion ALTERADA: 0001_plataforma.sql'));
});
