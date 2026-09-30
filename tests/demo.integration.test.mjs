// La base de demostracion (DAT-02, partes C y D).
//
// Corre el comando real (npm run demo:crear) y comprueba las tres cosas que importan:
//   1. Despues de crearla, tecnifin_demo TIENE datos y la base de trabajo NO.
//   2. Es reproducible: recrearla desde cero deja el mismo contenido de negocio.
//   3. Los asientos cuadran, la numeracion arranca en 1 y las cedulas son validas.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { REPO_ROOT, entornoAdmin } from '../tools/_env.mjs';
import { conectarSuperusuario } from '../tools/_local.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { nombreBaseDemo, MARCA_DEMO } from '../tools/demo.mjs';
import { FECHA_CORTE } from '../tools/demo-datos.mjs';
import { esCedulaValida } from '../src/platform/identificacion.js';

const ejecutar = promisify(execFile);
const demo = nombreBaseDemo();
const entornoDemo = { ...process.env, TECNIFIN_PG_DATABASE: demo };

let db, withTenant, cooperativaId;

// El contenido de negocio que tiene que repetirse identico entre dos creaciones. No se
// comparan fechas de registro ni identificadores: se compara lo que un demostrador ve.
async function retrato() {
  const base = connectPostgres(entornoAdmin(entornoDemo));
  try {
    const coop = (await base.query(
      `SELECT cooperativa_id, codigo, razon_social FROM tecnifin.cooperativas`)).rows;
    assert.equal(coop.length, 1, 'la demo tiene exactamente una cooperativa');
    return await crearWithTenant(base)(coop[0].cooperativa_id, async tx => ({
      cooperativa: coop[0].codigo,
      resumen: (await tx.query(
        `SELECT (SELECT count(*) FROM tecnifin.usuarios)::int usuarios,
                (SELECT count(*) FROM tecnifin.socios)::int socios,
                (SELECT count(*) FROM tecnifin.cuentas)::int cuentas,
                (SELECT count(*) FROM tecnifin.creditos)::int creditos,
                (SELECT count(*) FROM tecnifin.tabla_amortizacion)::int cuotas,
                (SELECT count(*) FROM tecnifin.depositos_plazo)::int dpf,
                (SELECT count(*) FROM tecnifin.transacciones_caja)::int caja,
                (SELECT count(*) FROM tecnifin.detalle_asiento)::int lineas,
                (SELECT count(*) FROM tecnifin.plan_cuentas)::int plan`)).rows[0],
      creditos: (await tx.query(
        `SELECT codigo, monto, saldo, tasa, plazo FROM tecnifin.creditos ORDER BY codigo`)).rows,
      cartera: (await tx.query(
        `SELECT categoria, dias_mora, saldo_capital, valor_provision
           FROM tecnifin.calificacion_cartera ORDER BY credito_id`)).rows,
      socios: (await tx.query(
        `SELECT numero_socio, identificacion, primer_apellido FROM tecnifin.socios ORDER BY numero_socio`)).rows,
    }));
  } finally { await base.close(); }
}

before(async () => {
  await ejecutar(process.execPath, ['tools/demo.mjs'], { cwd: REPO_ROOT, windowsHide: true });
  db = connectPostgres(entornoAdmin(entornoDemo));
  withTenant = crearWithTenant(db);
  cooperativaId = (await db.query('SELECT cooperativa_id FROM tecnifin.cooperativas')).rows[0].cooperativa_id;
});

after(async () => { if (db) await db.close(); });

test('la demo se llama como corresponde y nunca puede ser la base de trabajo', async () => {
  // Primera barrera, por el nombre: un valor mal puesto en .env no puede apuntar a la
  // base de desarrollo ni a la de produccion.
  assert.throws(() => nombreBaseDemo({ TECNIFIN_PG_DEMO_DATABASE: 'tecnifin' }), /_demo/);
  assert.throws(() => nombreBaseDemo({
    TECNIFIN_PG_DEMO_DATABASE: 'produccion_demo', TECNIFIN_PG_DATABASE: 'produccion_demo',
  }), /no puede ser la misma/);

  // La barrera de verdad: la base que se recrea lleva NUESTRA marca. Otra base llamada
  // igual en el mismo servidor no la tiene, y por eso no se borra.
  const superusuario = await conectarSuperusuario(postgresConfig());
  try {
    const marca = await superusuario.query(
      `SELECT shobj_description(oid, 'pg_database') AS marca FROM pg_database WHERE datname = $1`,
      [demo]);
    assert.equal(marca.rows[0].marca, MARCA_DEMO);
  } finally { await superusuario.end(); }
});

test('despues de crearla la demo tiene datos y la base de trabajo sigue en blanco', async () => {
  const conDatos = await retrato();
  assert.equal(conDatos.cooperativa, 'DEMO');
  assert.ok(conDatos.resumen.socios >= 4 && conDatos.resumen.creditos >= 1);

  // La base de trabajo (desarrollo, y con la misma prueba produccion) no recibio nada.
  // Se cuenta con el superusuario: con FORCE RLS, un cero del dueno no probaria nada.
  const trabajo = await conectarSuperusuario(postgresConfig(), postgresConfig().database);
  try {
    const filas = await trabajo.query(
      `SELECT (SELECT count(*) FROM tecnifin.cooperativas)::int cooperativas,
              (SELECT count(*) FROM tecnifin.socios)::int socios,
              (SELECT count(*) FROM tecnifin.plan_cuentas)::int plan,
              (SELECT count(*) FROM tecnifin.asientos_contables)::int asientos`);
    assert.deepEqual(filas.rows[0], { cooperativas: 0, socios: 0, plan: 0, asientos: 0 },
      `${postgresConfig().database} tiene datos: la demo se creo en la base equivocada`);
  } finally { await trabajo.end(); }
});

test('los asientos de la demo cuadran y la numeracion arranca en 1 sin huecos', async () => {
  const estado = await withTenant(cooperativaId, async tx => ({
    descuadrados: (await tx.query(
      `SELECT a.asiento_id FROM tecnifin.asientos_contables a
         JOIN tecnifin.detalle_asiento d USING (cooperativa_id, asiento_id)
        GROUP BY a.asiento_id
       HAVING sum(d.valor) FILTER (WHERE d.tipo_asiento = 'D')
           <> sum(d.valor) FILTER (WHERE d.tipo_asiento = 'H')`)).rows,
    sinLineas: (await tx.query(
      `SELECT a.asiento_id FROM tecnifin.asientos_contables a
        WHERE NOT EXISTS (SELECT 1 FROM tecnifin.detalle_asiento d
                           WHERE d.cooperativa_id = a.cooperativa_id AND d.asiento_id = a.asiento_id)`)).rows,
    socios: (await tx.query('SELECT numero_socio, identificacion FROM tecnifin.socios ORDER BY numero_socio')).rows,
    cuentas: (await tx.query('SELECT numero_cuenta FROM tecnifin.cuentas ORDER BY numero_cuenta')).rows,
    capital: (await tx.query(
      `SELECT c.codigo, c.monto, sum(t.capital) AS capital FROM tecnifin.creditos c
         JOIN tecnifin.tabla_amortizacion t USING (cooperativa_id, credito_id)
        GROUP BY c.codigo, c.monto ORDER BY c.codigo`)).rows,
  }));

  assert.deepEqual(estado.descuadrados, [], 'partida doble: todo asiento cuadra');
  assert.deepEqual(estado.sinLineas, [],
    'el trigger de cuadre no ve un asiento sin lineas; la demo no deja ninguno');
  assert.deepEqual(estado.socios.map(s => Number(s.numero_socio)),
    estado.socios.map((_, i) => i + 1), 'numeracion de socios 1..N sin huecos');
  assert.deepEqual(estado.cuentas.map(c => Number(c.numero_cuenta)),
    estado.cuentas.map((_, i) => i + 1));
  for (const s of estado.socios) {
    assert.ok(esCedulaValida(s.identificacion), `cedula sintetica invalida: ${s.identificacion}`);
  }
  // La tabla de amortizacion devuelve exactamente el capital prestado.
  for (const c of estado.capital) assert.equal(Number(c.capital), Number(c.monto));
});

test('el mayor de cartera cuadra con las cuotas pendientes, subcuenta por subcuenta', async () => {
  // El proceso de cartera (M6) se niega a aplicar si no cuadra. La demo de antes de M3
  // contabilizaba todo en 140205 y no asentaba las cuotas pagadas: 9000 contra 6111.74.
  const descuadre = await withTenant(cooperativaId, tx => tx.query(
    `WITH aux AS (SELECT t.cuenta_capital AS codigo, sum(t.capital) AS s
                    FROM tecnifin.tabla_amortizacion t JOIN tecnifin.creditos c USING (cooperativa_id, credito_id)
                   WHERE c.estado = 'VIGENTE' AND t.estado IN ('PENDIENTE', 'VENCIDA') GROUP BY 1),
          mayor AS (SELECT pc.codigo, sum(CASE WHEN d.tipo_asiento = 'D' THEN d.valor ELSE -d.valor END) AS s
                      FROM tecnifin.detalle_asiento d JOIN tecnifin.plan_cuentas pc USING (cooperativa_id, cuenta_contable_id)
                     WHERE pc.codigo >= '1401' AND pc.codigo < '1429' GROUP BY 1)
     SELECT coalesce(aux.codigo, mayor.codigo) AS codigo, aux.s::text AS auxiliar, mayor.s::text AS mayor
       FROM aux FULL JOIN mayor USING (codigo) WHERE coalesce(aux.s, 0) <> coalesce(mayor.s, 0)`));
  assert.deepEqual(descuadre.rows, []);
});

test('la cartera SEPS de la demo sale de los parametros sembrados, no de constantes', async () => {
  // El segmento de la operacion sale del tarifario (tasas_credito.clase_credito), que
  // usa el MISMO vocabulario que parametros_provision_cartera.segmento. Si el tarifario
  // dijera 'MICROCREDITO' y la provision 'MICROEMPRESA', este join no devolveria filas
  // y la provision saldria en cero sin que nada fallara: por eso los dos CHECK comparten
  // la lista de valores.
  const cartera = await withTenant(cooperativaId, async tx => (await tx.query(
    `SELECT k.categoria, k.dias_mora, k.saldo_capital, k.valor_provision,
            p.porcentaje_provision, p.segmento
       FROM tecnifin.calificacion_cartera k
       JOIN tecnifin.creditos c
         ON c.cooperativa_id = k.cooperativa_id AND c.credito_id = k.credito_id
       JOIN tecnifin.tasas_credito t
         ON t.cooperativa_id = c.cooperativa_id AND t.linea_credito = c.tipo
       JOIN tecnifin.parametros_provision_cartera p
         ON p.cooperativa_id = k.cooperativa_id AND p.segmento = t.clase_credito
        AND p.calificacion = k.categoria
      WHERE k.fecha_corte = @corte::date
        AND k.dias_mora BETWEEN p.dias_mora_desde AND coalesce(p.dias_mora_hasta, 2147483647)
      ORDER BY k.credito_id`, { corte: FECHA_CORTE })).rows);

  assert.ok(cartera.length >= 2, 'hay cartera calificada al corte de la demo');
  for (const fila of cartera) {
    const esperado = Math.round(Number(fila.saldo_capital) * Number(fila.porcentaje_provision) * 100) / 100;
    assert.equal(Number(fila.valor_provision), esperado,
      `la provision de ${fila.segmento} no coincide con el parametro sembrado`);
  }
  // Mora y calificacion tienen que moverse juntas: si todo cayera en A1 el demo no
  // mostraria nada del proceso de cartera.
  assert.ok(new Set(cartera.map(f => f.categoria)).size >= 2, 'la demo muestra mas de una calificacion');

  const proceso = await withTenant(cooperativaId, async tx => (await tx.query(
    `SELECT r.estado, r.provision_requerida, count(d.detalle_id)::int AS renglones
       FROM tecnifin.reclasificacion_cartera r
       LEFT JOIN tecnifin.reclasificacion_cartera_detalle d USING (cooperativa_id, proceso_id)
      GROUP BY r.proceso_id, r.estado, r.provision_requerida`)).rows[0]);
  // Simular es lo predeterminado: la demo no deja asientos de provision aplicados.
  assert.equal(proceso.estado, 'SIMULADO');
  assert.ok(proceso.renglones >= 2);
  assert.equal(Number(proceso.provision_requerida),
    cartera.reduce((s, f) => s + Number(f.valor_provision), 0));
});

test('recrear la demo desde cero deja el mismo contenido de negocio', async () => {
  const antes = await retrato();
  // La recreacion borra la base con WITH (FORCE): hay que soltar el pool de esta prueba
  // antes, o el motor le corta la conexion por debajo.
  await db.close();
  db = null;
  await ejecutar(process.execPath, ['tools/demo.mjs'], { cwd: REPO_ROOT, windowsHide: true });
  const despues = await retrato();
  assert.deepEqual(despues, antes, 'la demo no es reproducible');
});
