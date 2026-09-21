# Semillas: catálogos públicos de la SEPS

Estos archivos **no son datos de ninguna cooperativa**. Son catálogos públicos —el Catálogo Único de Cuentas
y las tablas de las resoluciones 127/128-2015-F de la JPRMF— que cada cooperativa recibe **en copia propia**
al darse de alta. El plan de cuentas es uno por cooperativa: ninguna se relaciona con otra y no existe un
catálogo compartido (decisión de Jorge, 2026-09-20; ADR-0003).

La base de TECNIFIN **nace en blanco** (regla 11). Estas semillas son lo único que entra, y entran por
`tecnifin.aplicar_rls` + `withTenant` como cualquier otra escritura: nadie se salta RLS.

| Archivo | Filas | Qué es |
|---|--:|---|
| `plan_cuentas_seps.json` | 994 | Catálogo Único de Cuentas, niveles de 1, 2, 4 y 6 dígitos |
| `parametros_provision_cartera.json` | 36 | Calificación y provisión mínima por segmento y días de mora |
| `ponderaciones_riesgo.json` | 28 | Ponderación por familia de activo para los APR |
| `parametros_patrimonio_tecnico.json` | 15 | Composición del patrimonio técnico: primario, secundario, deducciones |
| `parametros_regulatorios.json` | 4 | Límites: solvencia mínima, topes, umbrales |
| `denominaciones_usd.json` | 12 | Circulante del USD (billetes y monedas) |

## Cómo se usan

`src/platform/semillas.js`. `altaCooperativa(admin, withTenant, datos)` crea la fila de plataforma y siembra
los seis catálogos dentro del tenant. Es **idempotente**: repetirla no duplica ni pisa lo que la cooperativa
ya editó (`ON CONFLICT DO NOTHING`).

## Cómo se obtuvieron, y qué se dejó fuera a propósito

El catálogo se exportó en solo lectura del sistema anterior y se limpió antes de versionarlo. Se excluyeron:

- **El nivel de 8 dígitos (88 cuentas).** Es el auxiliar que abre cada entidad, no el catálogo nacional.
  Contenía **nombres de personas** (anticipos al personal) y de instituciones concretas. Por eso
  `tests/higiene.test.mjs` exige que todo código tenga entre 1 y 6 dígitos: el nivel donde estaba la fuga no
  puede volver a entrar por descuido.
- **Tres cuentas de 6 dígitos** que nombraban a instituciones concretas: eran detalle de una entidad, no del
  Catálogo Único.
- **19 cuentas de relleno** llamadas `NN`, todas hojas y sin información.

**`es_agrupador` no está en el archivo: se deriva al sembrar.** Una cuenta es agrupadora si y solo si tiene
hijas en este catálogo. Guardarlo como dato dejaría que el archivo contradiga a la jerarquía —una cuenta
marcada hoja que sí tiene hijas es una contra la que se puede contabilizar duplicando el saldo de sus hijas—.
La bandera del origen marcaba como agrupadoras 101 cuentas cuyas únicas hijas eran auxiliares de la entidad;
al no existir aquí, esas cuentas son de movimiento. Cuando una cooperativa abra subcuentas bajo una de ellas,
tiene que marcarla como agrupadora: es la misma regla, aplicada a su propio plan.

**Los nombres vienen truncados a unos 30 caracteres** por el ancho de la columna en el sistema de origen
(`(PROVISIONES PARA CREDITOS INC)`). Es fiel al dato de origen; si hace falta el nombre completo del Catálogo
Único, se reemplaza el archivo y se vuelve a sembrar.

## Formato

JSON con `_` (una línea de qué es) y `filas`, **un objeto por línea** para que el diff de git muestre qué
cuenta cambió y no un bloque entero. **Cada campo se llama igual que su columna**: `src/platform/semillas.js`
describe cada catálogo con una sola lista (nombre del campo → tipo SQL) y de ahí salen el `INSERT`, los tipos
del `unnest` y los parámetros. Con una sola lista no puede desalinearse el orden entre ellos, que es la forma
en que esto falla en silencio.

**Cuidado con las unidades, que no son las mismas:** `porcentaje_provision`, `ponderacion` y `factor` son
**fracciones** (`0.0600` = 6%); las tasas de `tasas_credito` son **porcentajes** (`14.0000` = 14%). La
diferencia viene del sistema de origen y está escrita en los `CHECK` de cada tabla.
