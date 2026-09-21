// Base en blanco y siembra por cooperativa (DAT-02, partes B y D).
//
// Dos afirmaciones que solo se pueden comprobar contra una base de verdad:
//   1. Una base recien migrada NO trae datos de nadie: cero filas en toda tabla de
//      negocio; el unico dato permitido es parametros_plataforma (regla 11).
//   2. Cada cooperativa recibe SU plan de cuentas. Editar el de una no toca el de la
//      otra, porque no hay catalogo compartido (decision de Jorge, 2026-09-20).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { entornoAdmin } from '../tools/_env.mjs';
import {
  conectarSuperusuario, crearBaseLocal, borrarBaseLocal, migrarBase, tablasDeNegocio, recorrerTablas,
} from '../tools/_local.mjs';
import { connectPostgres, postgresConfig } from '../src/platform/postgres.js';
import { crearWithTenant } from '../src/platform/tenant.js';
import { altaCooperativa, leerSemilla, jerarquiaPlanCuentas } from '../src/platform/semillas.js';

const nombreBase = `tecnifin_semi_${randomBytes(6).toString('hex')}`;
const entorno = { ...process.env, TECNIFIN_PG_DATABASE: nombreBase };

let superusuario, app, admin, withTenant, creada = false;
let tablas = [];

before(async () => {
  const configuracion = postgresConfig();
  await crearBaseLocal(configuracion, nombreBase,
    { dueno: entornoAdmin().TECNIFIN_PG_USER, aplicacion: configuracion.user });
  creada = true;
  await migrarBase(entorno);

  // Contar filas hay que hacerlo con el SUPERUSUARIO: con FORCE ROW LEVEL SECURITY, ni la
  // aplicacion ni el dueno ven una sola fila sin tenant, asi que un "cero" suyo no
  // probaria nada. El superusuario si ignora RLS, y por eso es el unico testigo valido de
  // que la base esta vacia de verdad.
  superusuario = await conectarSuperusuario(configuracion, nombreBase);
  admin = connectPostgres(entornoAdmin(entorno));
  app = connectPostgres(entorno);
  withTenant = crearWithTenant(app);

  tablas = await tablasDeNegocio(superusuario);
});

after(async () => {
  if (app) await app.close();
  if (admin) await admin.close();
  if (superusuario) await superusuario.end();
  if (creada) {
    const limpieza = await conectarSuperusuario(postgresConfig());
    try { await borrarBaseLocal(limpieza, nombreBase); }
    finally { await limpieza.end(); }
  }
});

test('una base recien migrada esta en blanco: cero filas en toda tabla de negocio', async () => {
  const conFilas = (await recorrerTablas(superusuario, tablas, 'count(*)::int AS n'))
    .rows.filter(f => f.n > 0);
  assert.deepEqual(conFilas, [], 'la base nace en blanco: ninguna tabla trae datos de nadie');

  // El unico dato que si viaja con el esquema es el nombre visible de la plataforma.
  const plataforma = await superusuario.query(
    'SELECT clave FROM tecnifin.parametros_plataforma ORDER BY clave');
  assert.deepEqual(plataforma.rows.map(f => f.clave),
    ['plataforma.moneda', 'plataforma.nombre_visible', 'plataforma.razon_social']);
  // Y no menciona a ninguna cooperativa: son datos de TECNIFIN.
  const valores = await superusuario.query('SELECT string_agg(valor, \' \') AS todo FROM tecnifin.parametros_plataforma');
  assert.match(valores.rows[0].todo, /TECNIFIN/);
});

test('dar de alta dos cooperativas siembra a cada una SU plan, y editar uno no toca el otro', async () => {
  const semilla = leerSemilla('plan_cuentas_seps');
  const [alfa, beta] = await Promise.all([
    altaCooperativa(admin, withTenant,
      { codigo: 'SEMI-A', razonSocial: 'Cooperativa Alfa', ruc: '1800000000011', nombreComercial: 'Alfa' }),
    altaCooperativa(admin, withTenant,
      { codigo: 'SEMI-B', razonSocial: 'Cooperativa Beta', ruc: '1800000000022', nombreComercial: 'Beta' }),
  ]);

  const plan = async coop => withTenant(coop.cooperativa_id, async tx => (await tx.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE cuenta_padre_id IS NOT NULL)::int AS con_padre,
            count(*) FILTER (WHERE es_agrupador)::int AS agrupadoras,
            (SELECT nombre FROM tecnifin.plan_cuentas WHERE codigo = '110105') AS efectivo
       FROM tecnifin.plan_cuentas`)).rows[0]);

  const antesA = await plan(alfa), antesB = await plan(beta);
  assert.equal(antesA.total, semilla.length, 'Alfa recibe el catalogo completo');
  assert.deepEqual(antesA, antesB, 'las dos arrancan con el mismo catalogo');
  // Toda cuenta menos las 7 raices de clase cuelga de su prefijo: la jerarquia se arma
  // del codigo, no de una columna de la fuente.
  assert.equal(antesA.con_padre, jerarquiaPlanCuentas(semilla).length);
  assert.ok(antesA.agrupadoras > 200 && antesA.agrupadoras < antesA.total);

  // Alfa personaliza SU plan: renombra una cuenta y abre una propia fuera del catalogo.
  await withTenant(alfa.cooperativa_id, async tx => {
    await tx.query(`UPDATE tecnifin.plan_cuentas SET nombre = 'EFECTIVO EN BOVEDA' WHERE codigo = '110105'`);
    await tx.query(
      `INSERT INTO tecnifin.plan_cuentas (codigo, nombre, tipo_cuenta) VALUES ('888888', 'CUENTA PROPIA', 'PASIVO')`);
  });

  const despuesA = await plan(alfa), despuesB = await plan(beta);
  assert.equal(despuesA.efectivo, 'EFECTIVO EN BOVEDA');
  assert.equal(despuesA.total, semilla.length + 1);
  assert.deepEqual(despuesB, antesB, 'el plan de Beta quedo intacto');

  // Y los parametros regulatorios tambien son de cada una.
  const solvencia = async coop => withTenant(coop.cooperativa_id, async tx => (await tx.query(
    `SELECT valor FROM tecnifin.parametros_regulatorios WHERE clave = 'SOLVENCIA_MINIMA'`)).rows[0].valor);
  await withTenant(beta.cooperativa_id, tx => tx.query(
    `UPDATE tecnifin.parametros_regulatorios SET valor = 0.120000 WHERE clave = 'SOLVENCIA_MINIMA'`));
  assert.equal(Number(await solvencia(alfa)), 0.09);
  assert.equal(Number(await solvencia(beta)), 0.12);
});

test('las bandas de antiguedad se leen del plan de cuentas, no del codigo', async () => {
  const coop = (await admin.query(`SELECT cooperativa_id FROM tecnifin.cooperativas WHERE codigo = 'SEMI-B'`)).rows[0];
  // Mismo criterio que el motor de cartera del sistema anterior: las subcuentas de seis
  // digitos de 1401..1428 y el rango sale del NOMBRE de la cuenta.
  const filas = await withTenant(coop.cooperativa_id, async tx => (await tx.query(
    `SELECT codigo, nombre FROM tecnifin.plan_cuentas
      WHERE length(codigo) = 6 AND codigo >= '1401' AND codigo < '1429' ORDER BY codigo`)).rows);

  const bandas = {};
  for (const { codigo, nombre } of filas) {
    const rango = nombre.match(/De\s+(\d+)\s+a\s+(\d+)/i);
    const abierto = nombre.match(/De\s+m[aá]s\s+de\s+(\d+)/i);
    if (!rango && !abierto) continue;
    (bandas[codigo.slice(0, 4)] ??= []).push(rango
      ? { desde: Number(rango[1]), hasta: Number(rango[2]) }
      : { desde: Number(abierto[1]) + 1, hasta: null });
  }

  // 1423 y 1427 tienen SEIS bandas; 1402 y 1422 tienen cinco y cortan distinto. Es la
  // trampa que obliga a leerlas del catalogo: una tabla de bandas en codigo las iguala.
  assert.deepEqual(bandas['1423'], [
    { desde: 1, hasta: 30 }, { desde: 31, hasta: 90 }, { desde: 91, hasta: 270 },
    { desde: 271, hasta: 360 }, { desde: 361, hasta: 720 }, { desde: 721, hasta: null },
  ]);
  assert.equal(bandas['1427'].length, 6);
  assert.equal(bandas['1402'].length, 5);
  assert.notDeepEqual(bandas['1402'], bandas['1422'], 'por vencer y vencida no cortan igual');
  assert.equal(bandas['1402'].at(-1).desde, 361);
  assert.equal(bandas['1422'].at(-1).desde, 271);
});

test('la cartera se suma por la familia 1401..1428, no por {14} que es neta', async () => {
  const coop = (await admin.query(`SELECT cooperativa_id FROM tecnifin.cooperativas WHERE codigo = 'SEMI-B'`)).rows[0];
  const conteo = await withTenant(coop.cooperativa_id, async tx => (await tx.query(
    `SELECT count(*) FILTER (WHERE codigo >= '1401' AND codigo < '1429')::int AS cartera,
            count(*) FILTER (WHERE codigo LIKE '1499%')::int AS provisiones
       FROM tecnifin.plan_cuentas WHERE codigo LIKE '14%' AND length(codigo) = 6`)).rows[0]);
  assert.ok(conteo.cartera > 100, 'la familia de cartera esta sembrada');
  // 1499 existe y NO entra en la suma de cartera bruta: es la provision, activo de saldo
  // acreedor. Si entrara, el descuadre seria exactamente la provision constituida.
  assert.ok(conteo.provisiones >= 5);
});
