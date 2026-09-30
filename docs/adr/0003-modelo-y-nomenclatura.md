# ADR-0003: modelo de datos, tipos y nomenclatura

- **Estado:** propuesta
- **Entregable:** ARQ-01 / DAT-01 (hito H1, acta 31-oct-2026)
- **Capas afectadas:** base de datos / aplicación
- **Revisión requerida:** Desarrollo. Infraestructura y Seguridad (Christian Cuenca) **sí** para los puntos que
  tocan capacidad y respaldo: los binarios en la base (§ Preguntas abiertas) y los nombres de roles y esquemas
  (cláusula 6.3)
- **Fecha del borrador:** 2026-09-20 · **Autor:** arquitectura TECNIFIN
- **Depende de:** ADR-0001 (identificación del tenant) y ADR-0002 (RLS)

## Contexto y requisitos

DAT-01 (semana del 12-16 oct) traduce el esquema renombrado de `C:\GUTT_SYSTEM\db\gutt_system\01-09` —
SQL Server, 30 tablas — a migraciones PostgreSQL en `db/migrations/`. Antes de escribir la primera línea de
DDL hay que fijar las reglas de traducción, porque una decisión de tipo tomada tabla por tabla produce un
esquema incoherente que ningún `simplify` posterior arregla.

Este ADR fija esas reglas y define el **alcance exacto de DAT-01**. No escribe migraciones: eso es la semana 2.

Restricciones heredadas que el modelo debe respetar (de `C:\GUTT_SYSTEM\CLAUDE.md`, ya pagadas en producción):

- Los códigos contables son dígitos **sin puntos** (`'210305'`), y las fórmulas regulatorias leen **prefijos
  numéricos**, nunca nombres de cuenta.
- La cartera de crédito vive en la familia **`1401-1428`**. `{14}` es cartera **neta** e incluye `1499`
  (provisiones, activo de saldo acreedor): sirve solo cuando el denominador también va neto.
- Las bandas de antigüedad SEPS **no son simétricas y cambian por familia** (`1402` corta en 181-360/>360;
  `1422` en 181-270/>270; `1423`/`1427` tienen seis bandas). Se **leen de la tabla del plan de cuentas**,
  nunca se hardcodean.
- `registro_contable.socio_id` acepta NULL: los asientos agregados de cierre no pertenecen a un socio.
  En el modelo nuevo esto es `detalle_asiento.socio_id NULL` (ya está así en `07_contabilidad.sql:132`,
  con índice parcial `WHERE SocioId IS NOT NULL`).

## Opciones evaluadas

### Nomenclatura física de tablas y columnas

| Opción | Evaluación |
|---|---|
| **A. `snake_case` en minúsculas** (`socios`, `cooperativa_id`, `asientos_contables`) — recomendada | Es el caso plegado por defecto de PostgreSQL: `SELECT CooperativaId` funciona sin comillas porque el motor lo baja a minúsculas. Nadie tiene que acordarse de citar nada, ni en psql, ni en `pg_dump`, ni en una herramienta externa |
| B. `PascalCase` citado (`"Socios"."CooperativaId"`) | Conserva la grafía del esquema viejo y del plan. Pero obliga a comillas dobles en **toda** consulta, script, índice y política para siempre; un olvido produce `column "cooperativaid" does not exist`, un error confuso que se repite eternamente |
| C. `PascalCase` sin comillas | No existe: PostgreSQL lo pliega a minúsculas igual, con lo que el esquema queda en `cooperativaid` (ilegible) |

### Dinero

| Opción | Evaluación |
|---|---|
| **A. `numeric(18,2)` uniforme** — recomendada | Aritmética decimal exacta. Unifica los cuatro anchos distintos del esquema viejo (`DECIMAL(15,2)` ×28, `(18,2)` ×8, `(10,2)` ×2) |
| B. Conservar el ancho de cada columna | Reproduce una inconsistencia que no tiene razón de ser: `TransaccionesCaja.Monto` es `(18,2)` y `Creditos.Monto` es `(15,2)` sin motivo documentado |
| C. `double precision` | Descartado sin discusión: no es exacto. Es la causa clásica de descuadres de centavos en contabilidad |
| D. Enteros de centavos | Exacto y rápido, pero obliga a convertir en cada lectura y escritura y hace ilegible cualquier consulta manual sobre una base que va a ser auditada a mano |

### Fecha y hora

El esquema viejo usa `DATETIME2(0)` (21 usos) y `DATE` (6). `DATETIME2` no tiene zona y se llena con
`SYSDATETIME()`, que es la hora local del servidor.

| Opción | Evaluación |
|---|---|
| **A. Distinguir por significado** — recomendada: `timestamptz(0)` para **momentos** (cuándo ocurrió algo) y `date` para **fechas de negocio** (fecha contable, corte, vencimiento, período) | Un momento tiene zona; una fecha contable no. Poner la fecha de un asiento en `timestamptz` hace que un cambio de zona del servidor mueva un asiento de período — un descuadre regulatorio silencioso |
| B. Todo `timestamp` sin zona | Reproduce el comportamiento del viejo, pero deja el sistema sin defensa si alguna vez hay un servidor en otra zona o un respaldo restaurado en otra máquina |
| C. Todo `timestamptz` | Contamina las fechas contables con el problema del punto A |

### Comparación de texto (collation)

SQL Server compara con una collation **insensible a mayúsculas y a acentos**; PostgreSQL es sensible a ambas.
Esto no es cosmético: `TipoIdentificacion = 'CÉDULA'`, `Estado = 'ACTIVO'` y la búsqueda de socios por apellido
cambian de resultado al portarse.

| Opción | Evaluación |
|---|---|
| **A. Base con collation determinista (`es-EC-x-icu`), canonicalización en escritura para códigos y estados, e índices funcionales `lower(unaccent(...))` + `pg_trgm` para búsqueda de personas** — recomendada | Es la única que permite `LIKE`, `ILIKE` y búsqueda por prefijo sobre las columnas de nombres |
| B. Collation **no determinista** por columna (ICU con fuerza primaria) en nombres e identificaciones | Reproduce el comportamiento de SQL Server, pero PostgreSQL **prohíbe `LIKE` y los operadores de patrón** sobre columnas con collation no determinista. La búsqueda de socios por apellido parcial — que el sistema usa constantemente — dejaría de compilar |
| C. Dejarlo sensible y no hacer nada | La consulta "buscar socio Perez" deja de encontrar a "PÉREZ". Es un cambio de comportamiento visible para el cajero |

### Identificadores (claves primarias)

El esquema viejo mezcla `INT IDENTITY`, `BIGINT IDENTITY` y **PK de texto generadas por la aplicación**
(`SolicitudID NVARCHAR(50)`, `CreditoID NVARCHAR(50)`, `DepositoID NVARCHAR(20)`, `UsuarioId NVARCHAR(20)`).

| Opción | Evaluación |
|---|---|
| **A. PK subrogada `bigint GENERATED ALWAYS AS IDENTITY` en todas las tablas; el código de negocio pasa a columna con `UNIQUE (cooperativa_id, codigo)`** — recomendada | Resuelve de una vez el problema de ADR-0001 (el código de crédito era único global entre cooperativas), hace las FK compuestas de ADR-0002 baratas, y deja el código visible libre para cambiar de formato sin migrar claves |
| B. Conservar las PK de texto | Mantiene la trazabilidad literal con el sistema viejo y los documentos impresos, pero arrastra el único global entre tenants y hace que cada FK compuesta cargue 50 caracteres |
| C. `uuid` | Útil si hubiera generación distribuida o sincronización offline. Hoy no la hay; solo agrega peso al índice y ruido a los reportes que se leen a mano |

## Decisión y justificación

### 1. Nomenclatura

- **Físico: `snake_case` minúsculas.** `cooperativa_id`, `asientos_contables`, `detalle_asiento`,
  `transacciones_caja`. Los **nombres de negocio siguen en español** (regla del esquema renombrado): no se
  traduce `Socios` a `members`.
- **Conceptual: se sigue diciendo `CooperativaId` y `Socios`** en el plan, las actas y los ADR. La
  correspondencia PascalCase ↔ snake_case se documenta **una sola vez** en `docs/patrones/` y en la skill
  `tecnifin-traducir-modulo`; no se re-deriva por módulo.
- Claves y objetos: `pk_<tabla>`, `fk_<tabla>_<referencia>`, `uq_<tabla>_<columnas>`, `ck_<tabla>_<regla>`,
  `ix_<tabla>_<columnas>`, `pol_<tabla>_tenant` (política RLS).
- **Esquema `tecnifin`, no `public`.** `public` queda sin objetos y sin `CREATE` para `tecnifin_app`.
- **Roles:** `tecnifin_admin` (dueño, DDL) y `tecnifin_app` (DML, sujeto a RLS). Variables `TECNIFIN_PG_*`.
  Bases `tecnifin_dev` y `tecnifin` (regla 9).
- **El nombre visible de la plataforma es un dato**, no una constante: vive en `parametros_plataforma`
  (clave/valor, global). El código tiene **una sola** constante de respaldo por si la tabla no responde.
  La marca **por cooperativa** (nombre comercial, colores, logo) ya vive en `cooperativas`
  (`ColorPrimario`, `ColorAcento`, `LogoUrl` en `01_cooperativas_usuarios.sql`) y ahí se queda.

### 2. Tabla de mapeo T-SQL → PostgreSQL

Regla general: se traduce el **significado**, no la grafía. Los usos listados son los contados en `01-09`.

| Tipo T-SQL (usos en 01-09) | Tipo PostgreSQL | Nota de traducción |
|---|---|---|
| `INT IDENTITY(1,1)` PK | `integer GENERATED ALWAYS AS IDENTITY` | Solo en catálogos pequeños (`cooperativas`, `productos_financieros`, `plan_cuentas`, `periodos_contables`) |
| `BIGINT IDENTITY(1,1)` PK | `bigint GENERATED ALWAYS AS IDENTITY` | Por defecto en tablas transaccionales. `ALWAYS` (no `BY DEFAULT`) para que ninguna inserción fije el id a mano; la migración MIG-01 usará `OVERRIDING SYSTEM VALUE` de forma explícita |
| `INT` (59) | `integer` | |
| `BIGINT` (22) | `bigint` | |
| `BIT` (19) | `boolean` | `DEFAULT(1)` → `DEFAULT true`. Cuidado en la migración: `1/0` no es `true/false` implícito |
| `DATETIME2(0)` (21) | `timestamptz(0)` **o** `date` | Según § Fecha y hora. `DEFAULT(SYSDATETIME())` → `DEFAULT now()` |
| `DATE` (6) | `date` | |
| `DECIMAL(15,2)` (28) · `DECIMAL(18,2)` (8) · `DECIMAL(10,2)` (2) | `numeric(18,2)` | Montos, saldos, debe/haber. Unificado |
| `DECIMAL(5,2)` (8) | `numeric(9,4)` | Tasas y porcentajes. `(5,2)` no representa una tasa con más de dos decimales; la SEPS publica tasas con cuatro. **Ver Pregunta abierta 1** |
| `NVARCHAR(n)` (n ≤ 500) | `varchar(n)` | Se conserva `n` cuando corresponde a un ancho real (identificación 20, RUC 13, código contable 15, moneda 3). Donde `n` era arbitrario, se conserva igual: es una red contra datos basura y no cuesta nada |
| `NVARCHAR(MAX)` (9) | `text` | `Socios.PatrimonioIngresos` y demás JSON heredados quedan `text` en DAT-01. Normalizarlos es trabajo de M1, no de H1 |
| `CHAR(1)` / `CHAR(2)` | `char(1)` / `char(2)` | Solo si son realmente de ancho fijo; si no, `varchar` |
| `VARBINARY(MAX)` (2) | `bytea` | `socio_ubicacion_mapa` y `socio_croquis_trabajo`. **Decidido por Jorge (2026-09-20): las imágenes van dentro de la base** |
| `CHECK (X IN (...))` | `CHECK (x IN (...))` | Se conservan como `CHECK`, **no** como `enum` de PostgreSQL: agregar un valor a un `CHECK` es un `ALTER` transaccional y reversible; a un `enum` no lo es |
| `SEQUENCE Seq_NumeroSocio` | por cooperativa | Una secuencia global filtra el conteo entre tenants (ADR-0001, hallazgo 3). **Ver Pregunta abierta 2 de ADR-0001** |
| Función escalar en `CHECK` (`fn_CooperativaDe*`, `12_fix`) | **FK compuesta** `(cooperativa_id, padre_id)` | No se porta. PostgreSQL exige que un `CHECK` sea inmutable y no consulte otras tablas. El equivalente nativo y más fuerte es la FK compuesta de ADR-0002 §4 |
| `SCOPE_IDENTITY()` | `INSERT ... RETURNING id` | |
| `ISNULL(a,b)` · `GETDATE()`/`SYSDATETIME()` · `TOP n` · `+` de cadenas | `COALESCE(a,b)` · `now()` · `LIMIT n` · `\|\|` | Recetas completas en la skill `tecnifin-traducir-modulo` |
| `NVARCHAR` insensible a mayúsculas por collation | `varchar` + canonicalización o índice funcional | § Comparación de texto |

### 3. Reglas transversales del modelo

1. **Toda tabla de negocio: `cooperativa_id integer NOT NULL`**, FK a `cooperativas`, primera columna después
   de la PK, y primera columna de los índices compuestos de las tablas grandes.
2. **Toda relación padre-hijo dentro del tenant usa FK compuesta** `(cooperativa_id, padre_id)`, lo que exige
   `UNIQUE (cooperativa_id, pk)` en el padre además de su PK.
3. **Catálogos globales (sin tenant):** solo dos candidatos, y ambos se declaran de forma explícita en el DDL y
   en la lista de excepciones de la prueba de catálogo de ADR-0002:
   `denominaciones` (billetes y monedas del USD: es el circulante del país, no de una cooperativa) y
   `parametros_plataforma`. **Todo lo demás lleva tenant**, incluido `plan_cuentas`: **el plan de cuentas es uno por cooperativa**
   (decisión de Jorge, 2026-09-20). Cada cooperativa tiene su propia copia; ninguna se relaciona con la de otra y
   no existe un catálogo compartido. Dar de alta una cooperativa siembra su plan y sus parámetros.
4. **Datos regulatorios en tablas, nunca en código** (regla 5): bandas de antigüedad por familia leídas del plan
   de cuentas, ponderaciones de riesgo y parámetros de patrimonio técnico en sus propias tablas, sembradas
   desde `db/seeds/`. Ninguna constante de banda ni de prefijo contable en JavaScript.
5. **Códigos contables `varchar(15)`, solo dígitos**, con `CHECK (codigo ~ '^[0-9]+$')`. El formato punteado no
   entra a la base. Toda selección de cartera se hace por prefijo (`codigo LIKE '14%'` acotado a `1401..1428`),
   nunca por nombre de cuenta.
6. **`detalle_asiento.socio_id` es NULL-able**, con índice parcial `WHERE socio_id IS NOT NULL`. Ponerle `0`
   rompe la FK contra `socios`; es un error ya cometido en el sistema viejo.
7. **Auditoría append-only.** `auditoria_procesos` y `auditoria_usuarios` no tienen FK a `usuarios`
   (decisión deliberada de `14_fix_fk_usuario_faltantes.sql`: un intento de acceso con un usuario inexistente
   *es* el dato que hay que registrar). Sí llevan `cooperativa_id` y RLS; ninguna es actualizable ni borrable
   por `tecnifin_app`.
8. **Índices de FK desde el primer DDL.** `13_fix_indices_fk_faltantes.sql` encontró 27 columnas FK sin índice
   en el esquema viejo, con `tabla_amortizacion.credito_id` como caso urgente. Nacen indexadas: no se repite
   el hallazgo como "fix".
9. **Cero objetos `SECURITY DEFINER`** sin justificación escrita en un ADR (anularían el RLS de ADR-0002).

## Alcance de DAT-01: inventario de `db/gutt_system/01-09`

30 tablas. `09_relaciones_cruzadas.sql` no crea tablas: agrega 3 FK que no podían declararse antes
(`movimientos_cuenta → transacciones_caja`, `movimientos_cuenta → asientos_contables`,
`transacciones_caja → asientos_contables`). En PostgreSQL esas 3 se resuelven ordenando las migraciones o con
`ALTER TABLE` al final; el archivo 09 no genera una migración propia.

| Archivo | Tablas | Nombres | Con `cooperativa_id` hoy |
|---|:--:|---|:--:|
| `01_cooperativas_usuarios.sql` | **2** | `Cooperativas`, `Usuarios` | 2 (una como PK) |
| `02_socios.sql` | **7** | `Socios`, `SocioDireccion`, `SocioConyuge`, `SocioReferencia`, `SocioCarga`, `SocioUbicacionMapa`, `SocioCroquisTrabajo` | 1 |
| `03_cuentas_productos.sql` | **3** | `ProductosFinancieros`, `Cuentas`, `MovimientosCuenta` | 1 |
| `04_creditos.sql` | **5** | `SolicitudesCredito`, `Creditos`, `TablaAmortizacion`, `RubrosCreditos`, `CalificacionCartera` | 2 |
| `05_plazo_fijo.sql` | **3** | `TasasPlazoFijo`, `DepositosPlazo`, `SecuenciaDPF` | 2 |
| `06_caja.sql` | **4** | `ControlCaja`, `TransaccionesCaja`, `Denominaciones`, `DetalleEfectivoTransaccion` | 1 |
| `07_contabilidad.sql` | **4** | `PlanCuentas`, `PeriodosContables`, `AsientosContables`, `DetalleAsiento` | 3 |
| `08_auditoria.sql` | **2** | `AuditoriaProcesos`, `AuditoriaUsuarios` | 1 |
| `09_relaciones_cruzadas.sql` | **0** | (3 FK entre tablas de archivos distintos) | — |
| **Total** | **30** | | **13** |

**Consecuencia directa para DAT-01: 17 tablas no tienen `cooperativa_id` y lo heredan por FK.** Todas lo
reciben (ADR-0002 §4), y es el trabajo de traducción con más riesgo de omisión:

`SocioDireccion`, `SocioConyuge`, `SocioReferencia`, `SocioCarga`, `SocioUbicacionMapa`, `SocioCroquisTrabajo`,
`Cuentas`, `MovimientosCuenta`, `TablaAmortizacion`, `RubrosCreditos`, `CalificacionCartera`, `SecuenciaDPF`,
`TransaccionesCaja`, `Denominaciones` (candidata a catálogo global, § Reglas 3),
`DetalleEfectivoTransaccion`, `DetalleAsiento`, `AuditoriaUsuarios`.

**Fuera del alcance de DAT-01** (se conocen, se hacen después): las tablas paramétricas de solvencia
(`PonderacionesRiesgo`, `ParametrosPatrimonioTecnico`, `ParametrosRegulatorios`, en `db/sqlserver/31_*.sql`
del sistema viejo) entran con M6/M7; `parametros_cooperativa` entra con APP-01; la carga del Catálogo Único
de cuentas y de las ponderaciones son los seeds de la semana 3; las migraciones de datos reales son MIG-01.

**Adelantado a DAT-02**: las tres tablas de solvencia y los seeds del Catálogo Único, que quedaban para M6/M7
y la semana 3, entraron en DAT-02 (ver más abajo). No por adelantar trabajo: `parametros_provision_cartera`
tiene una FK contra `plan_cuentas`, así que sin el catálogo sembrado la tabla no se puede llenar, y sin ella
el proceso de cartera no tiene parámetros. Quedan en su sitio `parametros_cooperativa` (APP-01) y MIG-01.

## Resultado de DAT-01: lo que quedó construido y lo que cambió al construirlo

Aplicado en `tecnifin_dev` con `npm run migrate:apply`, sin pendientes ni alteradas. **31 tablas, 33
políticas RLS, 60 claves foráneas, 107 índices**, en 10 migraciones agrupadas por dominio. Las 31 tablas
llevan `ENABLE` **y** `FORCE ROW LEVEL SECURITY`: no hay excepciones.

| Migración | Tablas |
|---|---|
| `0001_plataforma.sql` | `cooperativas`, `parametros_plataforma`, `usuarios`, `secuencias_tenant` |
| `0002_socios.sql` | `socios`, `socio_direccion`, `socio_conyuge`, `socio_referencia`, `socio_carga`, `socio_ubicacion_mapa`, `socio_croquis_trabajo` |
| `0003_cuentas_productos.sql` | `productos_financieros`, `cuentas`, `movimientos_cuenta` |
| `0004_creditos.sql` | `solicitudes_credito`, `creditos`, `tabla_amortizacion`, `rubros_creditos`, `calificacion_cartera` |
| `0005_plazo_fijo.sql` | `tasas_plazo_fijo`, `depositos_plazo` |
| `0006_caja.sql` | `control_caja`, `transacciones_caja`, `denominaciones`, `detalle_efectivo_transaccion` |
| `0007_contabilidad.sql` | `plan_cuentas`, `periodos_contables`, `asientos_contables`, `detalle_asiento` |
| `0008_auditoria.sql` | `auditoria_procesos`, `auditoria_usuarios` |
| `0009_relaciones_cruzadas.sql` | (11 FK entre dominios, ninguna tabla) |
| `0010_rls_y_permisos.sql` | (verificación de catálogo y permisos, ninguna tabla) |

Las 30 del inventario menos `SecuenciaDPF`, más `parametros_plataforma` y `secuencias_tenant`.

## Resultado de DAT-02: las tablas que DAT-01 no cubría, y las semillas

Tres migraciones más, aplicadas con `npm run migrate:apply` sin pendientes ni alteradas. El esquema pasa a
**40 tablas, 42 políticas RLS, 75 claves foráneas, 132 índices y 4 dominios**. Las 40 llevan `ENABLE` **y**
`FORCE ROW LEVEL SECURITY`: sigue sin haber excepciones, y `verificar_invariantes()` pasó después de cada una.

| Migración | Tablas |
|---|---|
| `0011_cartera_seps.sql` | `parametros_provision_cartera`, `reclasificacion_cartera`, `reclasificacion_cartera_detalle` |
| `0012_solvencia_regulatoria.sql` | `ponderaciones_riesgo`, `parametros_patrimonio_tecnico`, `parametros_regulatorios` |
| `0013_tasas_credito_canal_socio.sql` | `tasas_credito`, `activacion_banca_linea`, `socio_documento_excepcion` |

**Inventario final de DAT-02: 40 tablas.** 38 de negocio (con `cooperativa_id`) y 2 de plataforma (`cooperativas` y
`parametros_plataforma`). APP-01 agrega 2 de negocio: `parametros_cooperativa` (0015) y `recuperaciones_clave`
(0016), más la columna `usuarios.correo`: **42 tablas en total**. El inventario vivo lo da
`node tools/diccionario.mjs`. El detalle de traducción —mapeo de nombres, unidades, cómo se siembra una
cooperativa, cómo se usa la demo— está en **`docs/patrones/02-catalogos-y-demo.md`**.

### Nueve decisiones tomadas al construir DAT-02

1. **`TasasCredito` no se funde en `productos_financieros`.** `productos_financieros` es el catálogo de
   productos de **captación** (tipo de depósito, cuentas contables activa/inactiva, permisos de depósito y
   retiro, meses de acreditación). `tasas_credito` es un tarifario de **colocación** (montos, plazos, tres
   tasas). De las 20 columnas de una no aplicaría ninguna a la otra: fundirlas dejaría las dos mitades en NULL
   y un `CHECK` condicional por tipo. Son dos catálogos.
2. **El vocabulario de segmento y el de calificación viven en un dominio, no en cinco `CHECK` copiados.**
   El origen decía `MICROCREDITO` en el tarifario y `MICROEMPRESA` en la provisión: con dos vocabularios, la
   calificación no encuentra sus parámetros y la provisión sale en cero **sin que nada falle**.
   `tecnifin.segmento_credito` y `tecnifin.calificacion_riesgo` hacen que eso sea imposible por construcción
   en las seis columnas que los usan —incluida `calificacion_cartera.categoria`, de DAT-01, que pasa al
   dominio y suelta su `CHECK` propio—. Ampliar la lista es un `ALTER DOMAIN`, no cuatro migraciones. Es el
   mismo patrón que `tecnifin.codigo_contable`.
3. **Las unidades no se unificaron, se hicieron incompatibles.** `porcentaje_provision`, `ponderacion` y
   `factor` son fracciones (`CHECK <= 1`); las tasas son porcentajes (`CHECK <= 100`). Unificarlas habría
   cambiado números ya calculados en el sistema anterior; dejarlas sin marcar habría dejado pasar el valor de
   una en la otra. Con los `CHECK` cruzados, el error se ve en el `INSERT`.
4. **El PIN de la banca en línea deja de guardarse en claro.** Era `PIN NVARCHAR(4)` legible en la tabla, y el
   código de verificación también: cualquiera con `SELECT` entraba como el socio. Ahora los dos usan el
   dominio **`tecnifin.hash_secreto`**, que exige el formato `<algoritmo>$<cuerpo>` que emite
   `hashearClave()` de `src/platform/credenciales.js`. Un `CHECK` de longitud mínima habría sido una
   heurística disfrazada de invariante —una clave en claro de veinte caracteres pasaría—; el formato, no. La
   etiqueta de algoritmo permite además rotar la función sin migrar las filas viejas. El código de
   verificación lleva caducidad obligatoria. **Pendiente relacionado:** `socios.pin` y `usuarios.pin` de
   DAT-01 siguen en claro, heredados del origen. Es una migración aditiva y una decisión de seguridad
   (ver Preguntas abiertas, PA6).
5. **`reclasificacion_cartera` gana `asiento_id`.** El origen guardaba solo el monto provisionado, así que la
   reversa no podía enlazarse con lo que había asentado y tenía que buscar el asiento por fecha y concepto.
6. **Las cuentas del detalle del proceso son FK reales** contra el plan de la propia cooperativa. En el origen
   eran texto libre, y por eso `30_*.sql` terminaba con una consulta manual de verificación.
7. **`es_agrupador` del plan sembrado se deriva de la jerarquía**, no se copia de la fuente: una cuenta es
   agrupadora si y solo si tiene hijas en el catálogo. La bandera del origen marcaba como agrupadoras 101
   cuentas cuyas únicas hijas eran auxiliares de la entidad, que no se sembraron; con la bandera copiada, una
   cooperativa nueva se quedaba sin cuenta donde contabilizar los depósitos de ahorro.
8. **El nivel de 8 dígitos del catálogo de origen no entra**, y la prueba de higiene lo exige. Es el auxiliar
   que abre cada entidad y contenía **nombres de personas** (anticipos al personal) y de instituciones
   concretas. Junto con tres cuentas de 6 dígitos que nombraban instituciones y 19 de relleno, el catálogo
   queda en **994 cuentas** de niveles 1/2/4/6.
9. **La siembra es JavaScript, no una función SQL.** Una función SQL no puede leer `db/seeds/` sin `COPY`
   (superusuario), así que el catálogo tendría que vivir duplicado dentro de una migración. `altaCooperativa()`
   de `src/platform/semillas.js` es el único camino de alta —lo usa también la fábrica de pruebas, para que no
   haya dos— y siembra por `withTenant`, sin nombrar `cooperativa_id`.

### La base nace en blanco, y la demostración va aparte

`tecnifin_demo` se crea y se recrea con `npm run demo:crear`: mismas migraciones y mismos dos roles, nombre
propio. El nombre **tiene que terminar en `_demo`** y no puede coincidir con `TECNIFIN_PG_DATABASE`; las dos
comprobaciones existen para que un valor mal puesto en `.env` no borre la base de desarrollo o la de
producción. El contenido se construye **por `withTenant` y con el rol de la aplicación**, con cédulas válidas
generadas por el módulo 10 y nombres inequívocamente falsos.

Cuatro pruebas nuevas sostienen la regla 11: base recién migrada con **cero filas** en las 38 tablas de
negocio (contadas con el superusuario, porque con `FORCE` un cero del dueño no probaría nada); la demo con
datos y la base de trabajo vacía; recrear la demo deja el mismo contenido; y las semillas no contienen
códigos fuera de los niveles nacionales ni nombres de entidades.

### Once decisiones tomadas al construir que este ADR no tenía

1. **`SecuenciaDPF` no se porta como tabla.** Habría sido una segunda implementación del mismo mecanismo de
   numeración (regla 13). El correlativo `DPF-AAAAMM-NNNN` sale de
   `tecnifin.siguiente_numero('dpf_AAAAMM')`, igual que el número de socio y el de cuenta. La tabla del
   viejo además no tenía `CooperativaId`: el correlativo era compartido entre cooperativas.
2. **`denominaciones` lleva tenant.** La § Reglas 3 la daba como catálogo global. Se decidió lo contrario:
   permite que una cooperativa deshabilite una denominación sin afectar a las otras, y deja la prueba de
   catálogo con **una sola** excepción operativa en vez de dos. Costo: 12 filas por cooperativa, sembradas
   al dar de alta la cooperativa. `parametros_plataforma` sigue siendo el único catálogo global.
3. **Ninguna tabla se salta `FORCE`, ni siquiera las de plataforma.** El primer intento dejó `cooperativas`
   con RLS sin `FORCE`, porque con `FORCE` el `WITH CHECK` de una fila cuyo tenant es su propia PK todavía
   inexistente no se puede satisfacer y el alta de la cooperativa 11 sería imposible. La forma correcta no
   es la excepción: es una **segunda política** `TO tecnifin_admin USING (true) WITH CHECK (true)`. Las
   políticas se suman con OR por rol, así que el dueño administra la tabla **pasando por el motor** en vez
   de saltárselo, y la aplicación sigue viendo solo su fila. `tecnifin.aplicar_rls_plataforma()` hace eso
   para `cooperativas` y `parametros_plataforma`, y es lo único que exime a una tabla de llevar
   `cooperativa_id` (deja un `COMMENT ON TABLE ... 'plataforma: …'` que la verificación lee). Resultado:
   31 de 31 tablas con `FORCE`, y cero listas de excepciones repartidas entre el SQL y las pruebas.
4. **La inmutabilidad del tenant en la fila (ADR-0001 §5) no necesita trigger.** La política RLS ya la
   garantiza: desde el tenant A, un `UPDATE` que ponga `cooperativa_id = B` falla el `WITH CHECK`; y desde
   el tenant B la fila ni siquiera es visible para actualizarla. Treinta triggers habrían sido peso muerto.
5. **La partida doble la hace cumplir el motor**, con un `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY
   DEFERRED` sobre `detalle_asiento` que verifica `sum(D) = sum(H)` al COMMIT. Diferido porque el asiento se
   arma línea por línea. **Límite conocido:** un asiento **sin ninguna línea** no dispara el trigger y por lo
   tanto no se detecta aquí; se cubre en la capa de aplicación (M5) o con una verificación de cierre de
   período. Queda escrito para que nadie lo descubra como sorpresa.
6. **Las FK de código contable (`18_fix`) se declaran en `0009`.** `productos_financieros.cuenta_*`,
   `tasas_plazo_fijo.cuenta_contable_dpf` y `depositos_plazo.cuenta_contable_dpf` referencian
   `plan_cuentas (cooperativa_id, codigo)`. Consecuencia operativa: **no se puede crear un producto ni una
   tasa antes de sembrar el plan de cuentas de esa cooperativa.** Es el orden correcto, pero condiciona la
   secuencia del alta de una cooperativa nueva y la de los seeds de la semana 3.
7. **`unaccent` y `pg_trgm` viven en `public`.** La § Decisión 1 pedía `public` sin objetos; se cumple para
   tablas de negocio, pero las extensiones van ahí por convención (y `public.tecnifin_schema_migrations`
   del migrador ya estaba). `public` no tiene `CREATE` para `tecnifin_app`. El envoltorio inmutable
   `tecnifin.sin_acentos()` es lo que permite indexar la búsqueda de personas.

8. **La PK de toda tabla de negocio es `(cooperativa_id, <id>)`**, no el id subrogado solo. El primer intento
   usaba PK simple más un `UNIQUE (cooperativa_id, id)` aparte —el destino de las FK compuestas—, es decir
   dos índices por tabla para la misma información. Con la PK compuesta hay uno, y además queda agrupado por
   cooperativa, que es como lo recorre RLS. Junto con cuatro índices que ya cubría un `UNIQUE` más largo y
   uno de baja selectividad, el esquema pasó de 128 a **107 índices**: 21 menos que escribir en cada
   `INSERT` y que guardar en cada respaldo. La decisión de ADR-0003 § Identificadores no cambia —el id
   sigue siendo subrogado `bigint IDENTITY`—, cambia dónde vive la unicidad.
9. **El tenant y el correlativo son `DEFAULT` de la columna, no argumentos del código.**
   `aplicar_rls` pone `cooperativa_id DEFAULT tecnifin.cooperativa_actual()`, y `socios.numero_socio` y
   `cuentas.numero_cuenta` tienen `DEFAULT tecnifin.siguiente_numero(...)`. Ningún `INSERT` de negocio
   vuelve a nombrar el tenant, con lo que desaparece la clase de error "me olvidé de `cooperativa_id`", y
   nadie puede inventarse un número de socio por descuido. Fuera de `withTenant` el `DEFAULT` es NULL y la
   fila se rechaza: sigue fallando cerrada.
10. **El formato del código contable vive en un dominio**, `tecnifin.codigo_contable` (`varchar(15)` de solo
    dígitos). Antes era el mismo `CHECK (~ '^[0-9]+$')` copiado en ocho columnas de cuatro tablas. Ahora la
    regla se cambia en un solo sitio y ninguna columna de código contable puede nacer sin ella.
11. **Append-only y contador monótono los exige el motor, no el `REVOKE`.** `aplicar_rls(tabla, true)`
    instala un trigger que rechaza `UPDATE` y `DELETE` en las tablas de auditoría —también al dueño—, y
    `secuencias_tenant` tiene un trigger que solo admite `valor = valor + 1`. Un `REVOKE` protege de un rol;
    un trigger protege de todos, incluida una tarea de mantenimiento conectada como `tecnifin_admin`.

### Reglas de esquema que quedaron comprobadas por el propio motor

La regla vive en **`tecnifin.verificar_invariantes()`** (migración 0001) y la exige **`tools/migrate.mjs`
después de cada migración, dentro de su transacción**. Una tabla que quede sin `cooperativa_id NOT NULL`
(y sin la marca de plataforma), sin RLS, sin `FORCE`, sin política, o una FK sin índice de soporte, o una
función `SECURITY DEFINER`, **no llega a existir**: la migración se revierte con el detalle del problema.

Que la comprobación esté en el migrador y no en `0010` es deliberado: comprobarla solo dentro de `0010`
habría dejado fuera a la migración 0011 en adelante, que es exactamente cuando el olvido ocurre. La prueba
de aislamiento llama a la misma función, de modo que la regla está escrita una sola vez.

Toda migración futura que agregue una tabla llama a `SELECT tecnifin.aplicar_rls('tecnifin.<tabla>')` —o a
`aplicar_rls_plataforma` si de verdad no pertenece a ninguna cooperativa.

## Consecuencias y riesgos

**Más fácil:** escribir consultas sin comillas ni conversiones; que dos módulos escritos por personas distintas
se parezcan; auditar el esquema (una regla por tipo, no una decisión por columna).

**Más difícil / lo que hay que pagar:**

- **Todo el código y toda la documentación heredada habla en PascalCase.** Cada consulta portada requiere la
  traducción de nombres. Mitigación: se escribe una vez en `docs/patrones/` y en la skill de traducción.
- **Las PK de texto desaparecen.** `CreditoID = 'CRED-0001'` deja de ser la clave y pasa a ser un código con
  índice único por cooperativa. Toda consulta del sistema viejo que une por ese texto cambia. Es trabajo
  conocido de M3, no un imprevisto.
- **La insensibilidad a mayúsculas y acentos deja de ser gratis.** Cada búsqueda de personas necesita su índice
  funcional; si se olvida, la consulta funciona pero hace scan. Se revisa en el `code-review` de M1.
- **Riesgo de paridad numérica:** cambiar `DECIMAL(15,2)` por `numeric(18,2)` no altera resultados, pero cambiar
  tasas de `(5,2)` a `(9,4)` **sí** puede producir diferencias de centavos contra SQL Server en amortizaciones.
  Debe medirse con el arnés de paridad (`tools/paridad.mjs`) antes de aceptar M3, no en H1 a ciegas.
- **Riesgo de zona horaria:** clasificar mal una columna entre `date` y `timestamptz` mueve asientos de período.
  Se revisa columna por columna en el `code-review` de DAT-01, con el criterio de § Fecha y hora escrito.

## Pruebas requeridas y criterio de aceptación

| # | Prueba | Criterio |
|---|---|---|
| 1 | Conteo de objetos tras aplicar las migraciones de DAT-01 | **30 tablas** en el esquema `tecnifin`, con los nombres del inventario |
| 2 | Catálogo de tipos | Ninguna columna de dinero fuera de `numeric(18,2)`; ninguna `double precision` ni `money` en el esquema; ninguna columna de fecha contable en `timestamptz` |
| 3 | Nomenclatura | Todo identificador en `snake_case` minúsculas: ningún objeto del esquema requiere comillas |
| 4 | Índices de FK | Toda columna FK tiene índice de soporte (la comprobación que `13_fix` tuvo que hacer a posteriori) |
| 5 | Código contable | `INSERT` de `'2.1.03.05'` rechazado por el `CHECK`; `'210305'` aceptado |
| 6 | Bandas SEPS | Las bandas se leen del plan de cuentas sembrado; una prueba compara las seis bandas de `1423` contra el catálogo y falla si alguna está en el código |
| 7 | Cartera | La consulta de cartera suma `1401..1428` y **no** usa `{14}`; una prueba con provisión (`1499`) distinta de cero detecta la diferencia entre bruta y neta |
| 8 | `detalle_asiento` sin socio | Asiento agregado de cierre con `socio_id NULL` se inserta; con `socio_id = 0` es rechazado por la FK |
| 9 | Partida doble | Por cada asiento, suma de debe = suma de haber, dentro del tenant |
| 10 | `migrate.mjs` | Sin pendientes ni alteradas tras aplicar DAT-01 (regla 3) |
| 11 | Reaplicación | Base vacía → `migrate:apply` → esquema idéntico al de la base de desarrollo (mismo SHA-256, mismo catálogo) |

Criterio de aceptación: las 11 en verde en CI sobre `tecnifin_dev`, más las pruebas de ADR-0001 y ADR-0002.

## Preguntas abiertas

### Decisiones de Jorge del 2026-09-20

1. **Numeración por cooperativa desde 1** (socios y cuentas). Ya implementada.
2. **La base nace en blanco.** TECNIFIN es un sistema nuevo con el mismo funcionamiento que GUTT_SYSTEM, pero sin datos
   ni referencias a ninguna cooperativa. Lo único que existe además es la **base de demostración** (`tecnifin_demo`),
   separada, para demostraciones y pruebas de funcionamiento. Los datos sintéticos del sistema anterior pasan a ella.
3. **Plan de cuentas uno por cooperativa**, sin relación entre cooperativas (§ Reglas 3).
4. **Imágenes dentro de la base** (`bytea`). Consecuencia: los respaldos crecen; el volumen sigue siendo la Pregunta
   abierta 3 para Christian, pero ya no como alternativa de diseño sino como dato de capacidad.
5. ~~**DAT-02 abierto**~~: **cerrado**. Cartera SEPS (reclasificación y provisiones), solvencia regulatoria
   (ponderaciones, patrimonio técnico, parámetros), tasas de crédito, activación de la banca en línea y
   excepciones de documentos del socio. Las nueve, por cooperativa y con RLS `FORCE`. Ver «Resultado de DAT-02».

### Preguntas abiertas que DAT-02 dejó

| # | Pregunta | Para quién | Qué bloquea |
|---|---|---|---|
| **PA6** | **`socios.pin` y `usuarios.pin` siguen en claro** (`varchar(4)`), heredados del sistema anterior. DAT-02 hasheó el PIN de la banca en línea, con lo que el esquema quedó incoherente: el PIN del canal móvil está protegido y el de ventanilla no. ¿Se hashean también? | Christian (seguridad) · Jorge | No bloquea a H1: es una migración **aditiva** (`pin_hash` + backfill) y la decisión se necesita antes de M1 (socios) y M2 (autenticación), porque después hay pantallas que ya lo escriben |
| **PA7** | **Unidad de `tasas_credito.plazo_minimo/maximo`.** El origen traía `1..360` sin documentar si son meses o días. DAT-02 asume **meses**, por coherencia con `creditos.plazo` y con el motor de amortización, que avanza las cuotas con `DATEADD(MONTH, …)` | Jorge / negocio | Nada hoy (no hay dato migrado). Si fueran días, cambia el `CHECK` y las validaciones de M3, no el tipo |
| **PA8** | **Nombres del Catálogo Único truncados a ~30 caracteres** por el ancho de la columna en el sistema de origen (`(PROVISIONES PARA CREDITOS INC)`). ¿Se reemplaza el archivo de semilla por el catálogo completo de la SEPS? | Jorge | Nada técnico: se cambia el archivo y se vuelve a sembrar. Importa para los reportes que imprimen el nombre de la cuenta |
| **PA9** | **Una cuenta de movimiento que reciba subcuentas tiene que pasar a agrupadora.** Hoy es una regla escrita, no un trigger. ¿Se hace cumplir por el motor, como la partida doble? | Desarrollo | Nada. Es una migración aditiva; se decide al abrir M5 (contabilidad) |
| **PA10** | **Las bandas de mora se detectan parseando el NOMBRE de la cuenta** (`'De 91 a 270 días'`), como en el sistema anterior. Pero el plan es **editable y de cada cooperativa**: si una renombra la cuenta a `'91-270 d.'`, el motor de cartera pierde la banda y no falla nada. La alternativa es guardarlas como dato: `plan_cuentas.banda_dias_desde/hasta`, pobladas al sembrar, y el parseo se va al generador de la semilla | Desarrollo · Jorge | Se decide **antes de portar el motor de cartera** (M6). Después, cuesta reescribir sus consultas. La migración en sí es aditiva |
| **PA11** | **`creditos.tipo` es texto libre** y el segmento se deduce uniéndolo con `tasas_credito.linea_credito`. Un crédito cuyo tipo no coincida con ninguna línea se queda sin segmento y **sin provisión**, en silencio. La defensa real sería una FK compuesta `(cooperativa_id, tipo)` contra el tarifario —el `UNIQUE` destino ya existe— o una columna `creditos.segmento` con el dominio | Desarrollo | Se decide al abrir M3 (créditos). Hoy solo lo detecta la prueba de la demo, que es el nivel equivocado |
| **PA12** | **Los rangos de mora de `parametros_provision_cartera` pueden solaparse.** El `UNIQUE (segmento, calificación)` no lo impide, y una cooperativa edita esa tabla. Con dos filas aplicables, la consulta devuelve una cualquiera y la provisión cambia sin aviso. Se cierra con un `EXCLUDE USING gist (… int4range(…) WITH &&)`, que necesita la extensión `btree_gist` | Christian (extensión) · Desarrollo | Nada hoy. Es dinero regulatorio: conviene antes de que una cooperativa edite sus parámetros en producción |
| **PA13** | **El detalle de una corrida aplicada es editable y borrable** (`ON DELETE CASCADE`, y la aplicación tiene `DELETE`). La reversa reconstruye desde ese detalle, así que su inmutabilidad es hoy un comentario, no una regla del motor. La plataforma ya tiene `aplicar_rls(tabla, true)` para esto; el costo es que dejarían de poder borrarse las simulaciones | Desarrollo | Se decide al portar el proceso de cartera (M6) |

### Supuestos pendientes con los que DAT-01 ya construyó

Tres preguntas de Jorge siguen sin respuesta. DAT-01 no podía esperarlas, así que tomó el valor por defecto
más barato de revertir. **Ninguno está decidido; todos son supuestos.**

| # | Supuesto adoptado | Qué cuesta cambiarlo después |
|---|---|---|
| (a) **Sucursales** | El esquema **no tiene dimensión oficina**. `control_caja` sigue siendo único por `(cooperativa_id, usuario_id, fecha)` | **Barato.** Agregar `oficinas` y una `oficina_id` a `control_caja`, `transacciones_caja` y `cuentas` es una migración **aditiva**; lo único que se rehace es el único de `control_caja`. Se decide antes de M4 (caja) para no rehacer sus consultas |
| (b) **Precisión de tasas** | `numeric(9,4)` en toda tasa y porcentaje (era `DECIMAL(5,2)`) | **Nulo en el esquema, no nulo en los números.** `(9,4)` es superset de `(5,2)`: ningún valor existente cambia. Pero si el negocio decide calcular **con** cuatro decimales, las amortizaciones difieren en centavos contra SQL Server. Se mide con `tools/paridad.mjs` antes de aceptar M3; es ahí donde bloquea, no aquí |
| (c) **Formato de los códigos visibles** | `CRED-`/`SOL-`/`DPF-` se conservan literales como `codigo varchar`, `UNIQUE (cooperativa_id, codigo)`; la PK es subrogada | **Barato.** Cambiar el formato es cambiar el generador de la aplicación, no el esquema: ninguna FK cuelga del texto |

- ~~**PREGUNTA ABIERTA 1 (Jorge / negocio) — precisión de las tasas.**~~ Sigue abierta; ver supuesto (b).
  ¿Con cuántos decimales se **pacta** y se **calcula** una tasa? Si son cuatro, hay que decidir si las
  amortizaciones ya emitidas se recalculan o se congelan. Bloquea el criterio de paridad de M3, no a H1.
- **PREGUNTA ABIERTA 2 (Jorge / negocio) — códigos de negocio visibles.** Sigue abierta; ver supuesto (c).
  ¿El formato de `CreditoID`, `SolicitudID` y `DepositoID` es exigido por algún documento impreso, contrato o
  reporte a la SEPS? No cambia el modelo, sí cambia el generador y la migración.
- **PREGUNTA ABIERTA 5 (Jorge / negocio) — sucursales.** Heredada de ADR-0001 §PA4; ver supuesto (a). Se
  necesita **antes de M4 (caja)**: después de que las consultas de caja estén escritas, agregarla cuesta
  reescribirlas, aunque la migración siga siendo aditiva.
- **PREGUNTA ABIERTA 3 (Christian) — binarios en la base. Decisión de diseño tomada por Jorge (dentro de la base); queda como dato de capacidad.** `socio_ubicacion_mapa` y `socio_croquis_trabajo`
  guardan imágenes en `VARBINARY(MAX)` → `bytea`. Con 10 cooperativas eso infla el respaldo completo, alarga
  la ventana de restauración y empeora justamente el punto débil de ADR-0002 (R4). ¿Se quedan en la base
  (simple, transaccional, todo en un respaldo) o salen a almacenamiento de archivos con la base guardando solo
  la referencia (respaldo liviano, pero un segundo sistema que respaldar y un caso nuevo de inconsistencia)?
  Es decisión de respaldo y capacidad, cláusula 6.3.
- **PREGUNTA ABIERTA 4 (Christian) — retención y particionado.** ¿Cuántos años de `movimientos_cuenta`,
  `transacciones_caja` y `detalle_asiento` deben estar en línea? Si la respuesta supera los ~3 años con 10
  cooperativas, esas tres tablas conviene que nazcan particionadas por fecha en DAT-01; hacerlo después cuesta
  una migración con ventana de indisponibilidad. Es la misma pregunta de capacidad de ADR-0002.

## Aprobaciones

| Nombre | Rol | Fecha | Acta |
|---|---|---|---|
| | Desarrollo | | |
| Christian Cuenca | Jefe de Proyecto · Infraestructura y Seguridad | | |
