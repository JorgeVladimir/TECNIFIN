# Patrón 02 — catálogos por cooperativa y base de demostración (DAT-02)

Complementa a `01-plataforma-multitenant.md`, que sigue siendo el contrato de traducción. Aquí está lo que
DAT-02 agregó: las **nueve tablas** que DAT-01 no cubría, cómo se **siembra** una cooperativa nueva y cómo se
usa la base de **demostración**. Se escribe una vez: ningún módulo lo re-deriva.

---

## 1. La regla que gobierna todo esto

**La base de TECNIFIN nace en blanco** (regla 11, decisión de Jorge del 2026-09-20). Ni en el repo ni en una
base recién migrada hay datos de ninguna cooperativa. Lo único que existe además es `tecnifin_demo`, una base
**aparte**, con datos claramente sintéticos, que se crea y se recrea con un comando.

Dos pruebas lo sostienen y no se tocan:

- `tests/semillas.integration.test.mjs` — una base recién migrada tiene **cero filas** en las 38 tablas de
  negocio. Se cuenta con el **superusuario**: con `FORCE ROW LEVEL SECURITY`, un cero del dueño no probaría
  nada, porque sin tenant nadie ve nada.
- `tests/demo.integration.test.mjs` — después de `npm run demo:crear`, `tecnifin_demo` tiene datos y la base
  de trabajo sigue vacía.

---

## 2. Mapeo de nombres: viejo → nuevo (lo que agrega DAT-02)

| SQL Server (`dbo.`) | PostgreSQL (`tecnifin.`) | Origen |
|---|---|---|
| `ReclasificacionCartera` | `reclasificacion_cartera` | `db/sqlserver/30_*.sql` |
| `ReclasificacionCarteraDetalle` | `reclasificacion_cartera_detalle` | `30_*.sql` |
| `ParametrosProvisionCartera` | `parametros_provision_cartera` | `30_*.sql` |
| `PonderacionesRiesgo` | `ponderaciones_riesgo` | `31_*.sql` |
| `ParametrosPatrimonioTecnico` | `parametros_patrimonio_tecnico` | `31_*.sql` |
| `ParametrosRegulatorios` | `parametros_regulatorios` | `31_*.sql` |
| `TasasCredito` | `tasas_credito` | `10_*.sql` |
| `ActivacionBancaLinea` | `activacion_banca_linea` | `09_activacion_banca_linea.sql` |
| `SocioDocumentoExcepcion` | `socio_documento_excepcion` | `18_*.sql` |

Las columnas siguen la regla mecánica de `01-…` (`PascalCase` → `snake_case`). Las excepciones que **no** son
mecánicas:

| Viejo | Nuevo | Por qué |
|---|---|---|
| `ReclasificacionCartera.UsuarioId` (texto, sin FK, `'sistema'` como relleno) | `usuario_id bigint NOT NULL`, FK a `usuarios` | Una corrida que mueve el balance regulatorio siempre tiene responsable |
| `ReclasificacionCartera.AsientoProvisionado` (solo el monto) | `provision_contabilizada` **+** `asiento_id` FK | El origen no guardaba el asiento: la reversa no podía enlazarse con lo que había asentado |
| `ActivacionBancaLinea.PIN NVARCHAR(4)` (en claro) | `pin_hash tecnifin.hash_secreto` | El PIN legible en la tabla dejaba entrar como el socio a cualquiera con lectura |
| `ActivacionBancaLinea.CodigoVerificacion` (en claro, sin caducidad) | `codigo_verificacion_hash` + `codigo_verificacion_expira` | Un código sin fecha de caducidad sirve para siempre |
| `SocioDocumentoExcepcion.RutaCaraFrontal/Posterior` (rutas a disco) | `imagen_frontal` / `imagen_posterior` `bytea` | Las imágenes van dentro de la base (decisión de Jorge). Un respaldo no incluía los archivos y una ruta rota no se notaba hasta la revisión |
| `TasasCredito.LineaCredito UNIQUE` (global) | `UNIQUE (cooperativa_id, linea_credito)` | Dos cooperativas no podían tener ambas una línea "CONSUMO ORDINARIO" |
| `ParametrosRegulatorios.Clave` PK global | PK `(cooperativa_id, clave)` | Segunda y última excepción a la PK `(cooperativa_id, <id>)`, como `denominaciones` |

### Unidades: la trampa que hay que mirar dos veces

| Columna | Unidad |
|---|---|
| `parametros_provision_cartera.porcentaje_provision` | **fracción** — `0.0600` = 6% |
| `ponderaciones_riesgo.ponderacion` · `parametros_patrimonio_tecnico.factor` | **fracción** |
| `tasas_credito.tasa_*` · `tasas_plazo_fijo.tasa_*` · `creditos.tasa` | **porcentaje** — `14.0000` = 14% |

Viene del sistema de origen y no se unificó para no cambiar números ya calculados. Está escrito en los `CHECK`
de cada tabla (`<= 1` contra `<= 100`), así que ninguna puede recibir el valor de la otra sin fallar.

### Tres dominios donde antes había listas copiadas

Una regla que vive en un solo sitio no puede divergir. Además de `tecnifin.codigo_contable` de DAT-01:

| Dominio | Qué exige | Dónde se usa |
|---|---|---|
| `tecnifin.segmento_credito` | `COMERCIAL\|CONSUMO\|VIVIENDA\|MICROEMPRESA` | `parametros_provision_cartera.segmento`, `reclasificacion_cartera_detalle.segmento`, `tasas_credito.clase_credito` |
| `tecnifin.calificacion_riesgo` | `A1..E` | `parametros_provision_cartera.calificacion`, `reclasificacion_cartera_detalle.calificacion`, `calificacion_cartera.categoria` |
| `tecnifin.hash_secreto` | `<algoritmo>$<cuerpo>` | `activacion_banca_linea.pin_hash` y `codigo_verificacion_hash` |

El de segmento es el que más pesa: si el tarifario dijera `MICROCREDITO` y la provisión `MICROEMPRESA`, la
calificación no encontraría sus parámetros y **la provisión saldría en cero sin que nada fallara**. Con un
dominio eso es imposible por construcción, no por disciplina.

`hash_secreto` no es una heurística de longitud —una clave en claro de veinte caracteres pasaría— sino el
formato que emite `hashearClave()` de `src/platform/credenciales.js`, que ningún secreto tecleado por una
persona tiene. La etiqueta de algoritmo al frente permite además rotar de función sin migrar las filas viejas.

---

## 3. Dar de alta una cooperativa: un solo camino

```js
import { altaCooperativa } from '../platform/semillas.js';

const coop = await altaCooperativa(admin, withTenant, {
  codigo: 'COOP-X', razonSocial: '…', ruc: '1800000000011', nombreComercial: '…',
});
```

- La fila de `cooperativas` es una operación de **plataforma**: la escribe `tecnifin_admin` (la aplicación no
  tiene `INSERT` sobre esa tabla).
- La fila y los seis catálogos se escriben en **una sola transacción** de `tecnifin_admin`; los catálogos
  entran dentro del tenant mediante `withTenant(..., tx)` y `FORCE RLS` sigue aplicando. Ningún `INSERT`
  nombra `cooperativa_id`.
- **Es idempotente** (`ON CONFLICT DO NOTHING`): repetirla no duplica ni pisa lo que la cooperativa ya editó.
- Si una semilla falla, la fila de `cooperativas` también revierte: el mismo código/RUC se puede reintentar.
- La fábrica de pruebas (`tests/fixtures/cooperativas.mjs`) usa **esta misma función**. Si hubiera dos altas
  —una real y otra "de prueba"— divergirían, y la prueba de aislamiento dejaría de probar el camino real.

Qué se siembra, y en este orden porque las FK lo exigen:

1. `plan_cuentas` — 994 cuentas del Catálogo Único, con la jerarquía armada del propio código
   (`1` → `11` → `1101` → `110105`).
2. `denominaciones` — el circulante del USD.
3. `parametros_provision_cartera` — su `cuenta_provision` es FK contra el plan, así que el plan va primero.
4. `ponderaciones_riesgo`, `parametros_patrimonio_tecnico`, `parametros_regulatorios`.

**Consecuencia operativa:** no se puede crear un producto, una tasa de plazo fijo ni un parámetro de provisión
antes de sembrar el plan de esa cooperativa. Es el orden correcto y condiciona la secuencia del alta.

### Por qué la siembra es JavaScript y no `tecnifin.sembrar_cooperativa()`

Una función SQL no puede leer `db/seeds/` (haría falta `COPY`, que es de superusuario), así que el catálogo
tendría que vivir **duplicado** dentro de una migración. Con `src/platform/semillas.js` el dato vive **una
vez**, en su archivo versionado, y entra por `withTenant` como cualquier otra escritura.

---

## 4. Las bandas de antigüedad se leen del plan, siempre

No existe ni existirá una tabla de bandas en JavaScript. Se leen del nombre de las subcuentas de seis dígitos
de `1401..1428`:

```sql
SELECT codigo, nombre FROM tecnifin.plan_cuentas
 WHERE length(codigo) = 6 AND codigo >= '1401' AND codigo < '1429' ORDER BY codigo
```

`'De 1 a 30 días'` → `{desde: 1, hasta: 30}`; `'De más de 720 días'` → `{desde: 721, hasta: null}`.

**Cuando portes el motor de cartera, el parseo va en un solo lugar** —`src/platform/`— y tanto el proceso
como los reportes lo llaman, que es lo que en el sistema anterior evitó que discreparan. Hoy la prueba de
`tests/semillas.integration.test.mjs` tiene su propia copia del parseo porque el motor todavía no existe; al
portarlo, esa prueba pasa a llamar al código real. Y ojo con PA10 de ADR-0003: el plan es editable, así que
detectar la banda por el nombre es frágil a propósito hasta que se decida guardarla como dato.
**No son simétricas y cambian por familia**: `1402` corta en 181-360 / >360, `1422` en 181-270 / >270, y
`1423` y `1427` tienen **seis** bandas. Una tabla de bandas en código las iguala y produce un error que ningún
test de unidad ve. `tests/semillas.integration.test.mjs` compara las seis de `1423` contra el catálogo
sembrado y falla si alguien las escribe en el código.

Y la cartera se suma por `1401..1428`: **`{14}` es cartera neta** e incluye `1499` (provisiones, activo de
saldo acreedor).

---

## 5. El proceso de cartera: simula por defecto

`reclasificacion_cartera.estado` nace en `'SIMULADO'`. Aplicar es un acto explícito y deja asiento
(`asiento_id`). El motor sostiene tres reglas:

- **Un solo `APLICADO` por fecha de corte y cooperativa** (índice único parcial). Sin eso, correr dos veces el
  proceso duplica los asientos de provisión.
- **Reversar** pone el original en `REVERSADO` —con lo que el corte vuelve a quedar libre— y escribe una fila
  nueva con `reversa_de_proceso_id`. Una corrida se reversa **una sola vez** (segundo índice único parcial).
- **La reversa reconstruye los movimientos desde `reclasificacion_cartera_detalle`, no los recalcula**: tiene
  que deshacer exactamente lo que se asentó, aunque los vencimientos hayan cambiado desde entonces. Por eso el
  detalle es parte del dato y sus `cuenta_origen`/`cuenta_destino` son FK reales contra el plan.

El `monto` del detalle va **con signo**: negativo sale de la cuenta, positivo entra. La reversa lo invierte.

---

## 6. La base de demostración

```bash
npm run demo:crear     # borra y recrea tecnifin_demo desde cero
```

- Base **aparte**, mismas migraciones y mismos dos roles. El nombre sale de `TECNIFIN_PG_DEMO_DATABASE` y
  **tiene que terminar en `_demo`**, y se rechaza si coincide con `TECNIFIN_PG_DATABASE`. Eso es la primera
  barrera, contra el error de una letra.
- **La defensa real no es el nombre: es una marca en la propia base.** Al crearla se le pone
  `COMMENT ON DATABASE … IS 'tecnifin:demo'`, y antes de borrarla se lee. Una base que se llame igual en el
  mismo servidor —un `otroproyecto_demo`— no lleva la marca y **no se toca**. Si te encuentras con
  "existe y no lleva la marca", es una demo anterior a esta regla: bórrala a mano una vez y vuelve a correr.
- Se construye **por `withTenant` y con el rol de la aplicación**, igual que lo haría el sistema: RLS incluido,
  partida doble verificada por el motor, correlativos de `siguiente_numero()`.
- **Determinista**: fechas, montos y correlativos fijos (la fecha de corte es `2026-09-30`, no "hoy": si
  dependiera de hoy, la mora cambiaría cada día). Recrearla deja el mismo contenido de negocio, y hay una
  prueba que lo compara.
- Contenido: una cooperativa llamada "Cooperativa Demo", 5 usuarios (uno por rol), 6 socios con **cédulas
  válidas** generadas por el módulo 10 y apellidos inequívocamente falsos (EJEMPLO, MUESTRA, FICTICIA…),
  cuentas, 2 créditos con tabla de amortización, un plazo fijo, caja con denominaciones, asientos cuadrados y
  cartera SEPS calificada contra los parámetros sembrados.

Las cédulas sintéticas pasan **la misma validación** que una real
(`src/platform/identificacion.js`, coeficientes 2,1,2,1,2,1,2,1,2). Una demo con cédulas inválidas esconde el
bug de la validación en vez de mostrarlo.

Para conectarse a ella: las mismas variables de `.env`, cambiando solo la base
(`TECNIFIN_PG_DATABASE=tecnifin_demo`). Los usuarios de la demo solo tienen clave utilizable si
`TECNIFIN_DEMO_PASSWORD` está en `.env`; sin ella la demo se crea igual, con un hash irrepetible.

---

## 7. Qué probar cuando toques estas tablas

Lo de `01-…` §8 sigue valiendo entero. Se agrega:

1. **Base en blanco:** si tu migración siembra algo, la prueba de cero filas falla. Los únicos datos
   permitidos son `parametros_plataforma`.
2. **Independencia del catálogo:** editar el plan de una cooperativa no toca el de la otra.
3. **Bandas desde el plan:** ninguna constante de banda ni de prefijo contable en JavaScript.
4. **Provisión contra el parámetro:** el valor guardado tiene que ser `saldo × porcentaje_provision` del
   parámetro sembrado, no un número escrito en el código.
5. **Cuadre:** todo asiento cuadra y ninguno queda sin líneas (el trigger diferido no ve un asiento vacío; es
   el límite conocido de DAT-01, y la demo comprueba que no deja ninguno).
