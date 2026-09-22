// Alta de una cooperativa y siembra de SUS catalogos (DAT-02, parte B).
//
// El plan de cuentas es UNO POR COOPERATIVA (decision de Jorge, 2026-09-20): ninguna se
// relaciona con otra y no existe un catalogo compartido. Dar de alta una cooperativa
// siembra su plan, sus denominaciones y sus parametros regulatorios; a partir de ahi
// cada una edita el suyo sin tocar el de nadie.
//
// Los DATOS de las semillas son catalogos publicos de la SEPS -- el Catalogo Unico de
// Cuentas y las resoluciones 127/128-2015-F -- y viven como archivos versionados en
// db/seeds/. No son datos de ninguna cooperativa: la base de TECNIFIN nace en blanco
// (regla 11).
//
// Por que esto es JavaScript y no una funcion SQL tecnifin.sembrar_cooperativa(): una
// funcion SQL no puede leer db/seeds/ (haria falta COPY, que es de superusuario), asi
// que el catalogo tendria que vivir duplicado dentro de una migracion. Aqui el dato
// vive UNA vez, en su archivo, y entra por withTenant como cualquier otra escritura:
// nadie se salta RLS ni nombra cooperativa_id a mano.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ_SEMILLAS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds');

export function leerSemilla(nombre) {
  const { filas } = JSON.parse(readFileSync(join(RAIZ_SEMILLAS, `${nombre}.json`), 'utf8'));
  if (!Array.isArray(filas) || filas.length === 0) throw new Error(`Semilla vacia: ${nombre}`);
  return filas;
}

// Los seis catalogos, descritos en vez de escritos seis veces. La clave de cada columna
// es a la vez el nombre en el JSON, el nombre de la columna y el nombre del parametro:
// con una sola lista no puede desalinearse el orden entre el INSERT y los tipos, que es
// la forma en que esto falla en silencio.
const CATALOGOS = [
  {
    semilla: 'plan_cuentas_seps', tabla: 'plan_cuentas', conflicto: 'codigo',
    columnas: { codigo: 'varchar', nombre: 'varchar', tipo_cuenta: 'varchar', es_agrupador: 'boolean' },
  },
  {
    semilla: 'denominaciones_usd', tabla: 'denominaciones', conflicto: 'codigo_denominacion',
    columnas: { codigo_denominacion: 'varchar', valor: 'numeric', tipo: 'varchar', descripcion: 'varchar' },
  },
  {
    // Los porcentajes son MINIMOS de la Resolucion 128-2015-F: cada cooperativa puede
    // constituir por encima, y por eso la tabla es suya y editable.
    semilla: 'parametros_provision_cartera', tabla: 'parametros_provision_cartera',
    conflicto: 'segmento, calificacion',
    columnas: {
      segmento: 'varchar', calificacion: 'varchar', dias_mora_desde: 'integer',
      dias_mora_hasta: 'integer', porcentaje_provision: 'numeric',
      cuenta_provision: 'varchar', base_normativa: 'varchar',
    },
  },
  {
    semilla: 'ponderaciones_riesgo', tabla: 'ponderaciones_riesgo', conflicto: 'prefijo_cuenta',
    columnas: {
      prefijo_cuenta: 'varchar', ponderacion: 'numeric', categoria: 'varchar',
      descripcion: 'varchar', base_normativa: 'varchar',
    },
  },
  {
    semilla: 'parametros_patrimonio_tecnico', tabla: 'parametros_patrimonio_tecnico',
    conflicto: 'componente, prefijo_cuenta',
    columnas: {
      componente: 'varchar', prefijo_cuenta: 'varchar', factor: 'numeric', saldo_como: 'varchar',
      limite_pct_apr: 'numeric', descripcion: 'varchar', base_normativa: 'varchar',
    },
  },
  {
    semilla: 'parametros_regulatorios', tabla: 'parametros_regulatorios', conflicto: 'clave',
    columnas: {
      clave: 'varchar', valor: 'numeric', unidad: 'varchar',
      descripcion: 'varchar', base_normativa: 'varchar',
    },
  },
];

// Un solo viaje por catalogo: pg manda cada arreglo como un parametro y unnest los abre
// en filas. Mil cuentas de a una serian mil idas y vueltas.
async function insertarLote(tx, { tabla, conflicto, columnas }, filas) {
  const nombres = Object.keys(columnas);
  await tx.query(
    `INSERT INTO tecnifin.${tabla} (${nombres.join(', ')})
     SELECT * FROM unnest(${nombres.map(c => `@${c}::${columnas[c]}[]`).join(', ')})
     ON CONFLICT (cooperativa_id, ${conflicto}) DO NOTHING`,
    Object.fromEntries(nombres.map(c => [c, filas.map(f => f[c])])));
}

// Padre = el prefijo mas largo que existe en el catalogo. Se calcula aqui y no con una
// subconsulta correlacionada por fila: la jerarquia del Catalogo Unico esta en el propio
// codigo (1 -> 11 -> 1101 -> 110105) y resolverla en SQL seria un barrido por cuenta.
export function jerarquiaPlanCuentas(filas) {
  const codigos = new Set(filas.map(f => f.codigo));
  const pares = [];
  for (const { codigo } of filas) {
    for (let largo = codigo.length - 1; largo >= 1; largo--) {
      const padre = codigo.slice(0, largo);
      if (codigos.has(padre)) { pares.push([codigo, padre]); break; }
    }
  }
  return pares;
}

async function sembrarPlanCuentas(tx, catalogo) {
  const filas = leerSemilla(catalogo.semilla);
  const pares = jerarquiaPlanCuentas(filas);
  // es_agrupador NO viene del archivo: una cuenta es agrupadora si y solo si tiene hijas
  // en este catalogo. Guardarlo como dato dejaria que el archivo contradiga a la
  // jerarquia -- una cuenta marcada hoja que si tiene hijas, contra la que se podria
  // contabilizar duplicando el saldo de sus hijas.
  const conHijas = new Set(pares.map(p => p[1]));
  await insertarLote(tx, catalogo,
    filas.map(f => ({ ...f, es_agrupador: conHijas.has(f.codigo) })));

  await tx.query(
    `UPDATE tecnifin.plan_cuentas h SET cuenta_padre_id = p.cuenta_contable_id
       FROM unnest(@hijos::varchar[], @padres::varchar[]) AS m(hijo, padre), tecnifin.plan_cuentas p
      WHERE h.codigo = m.hijo AND p.codigo = m.padre AND p.cooperativa_id = h.cooperativa_id
        AND h.cuenta_padre_id IS NULL`,
    { hijos: pares.map(p => p[0]), padres: pares.map(p => p[1]) });
}

// Siembra los catalogos de UNA cooperativa. Todo en una transaccion y por withTenant:
// ningun INSERT nombra cooperativa_id -- lo pone el DEFAULT que instala aplicar_rls.
// El orden importa: cuenta_provision es FK contra plan_cuentas, asi que el plan va
// primero. Idempotente: repetirla no duplica ni pisa lo que la cooperativa ya edito.
async function sembrarCatalogosEn(tx) {
  for (const catalogo of CATALOGOS) {
    if (catalogo.tabla === 'plan_cuentas') await sembrarPlanCuentas(tx, catalogo);
    else await insertarLote(tx, catalogo, leerSemilla(catalogo.semilla));
  }
}

export async function sembrarCatalogos(withTenant, cooperativaId) {
  await withTenant(cooperativaId, sembrarCatalogosEn);
}

// Unico camino para dar de alta una cooperativa (regla 13). La fila de plataforma y los
// catalogos se escriben con el dueno en UNA transaccion; FORCE RLS sigue exigiendo que
// los catalogos entren dentro del tenant fijado por withTenant.
export async function altaCooperativa(admin, withTenant, datos) {
  const { codigo, razonSocial, ruc, nombreComercial, codigoSeps = null } = datos;
  if (!admin || typeof admin.transaction !== 'function') {
    throw new TypeError('altaCooperativa necesita una base admin con transaction()');
  }
  return admin.transaction(async tx => {
    const fila = await tx.query(
      `INSERT INTO tecnifin.cooperativas (codigo, razon_social, ruc, nombre_comercial, codigo_seps)
       VALUES (@codigo, @razonSocial, @ruc, @nombreComercial, @codigoSeps)
       RETURNING cooperativa_id, codigo, nombre_comercial`,
      { codigo, razonSocial, ruc, nombreComercial, codigoSeps });
    const cooperativa = fila.rows[0];
    await withTenant(cooperativa.cooperativa_id, sembrarCatalogosEn, tx);
    return cooperativa;
  });
}
