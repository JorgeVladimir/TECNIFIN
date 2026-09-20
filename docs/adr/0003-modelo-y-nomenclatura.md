# ADR-0003: modelo de datos, tipos y nomenclatura

- **Estado:** propuesta
- **Entregable:** ARQ-01 / DAT-01 (hito H1, acta 30-oct-2026)
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
| `VARBINARY(MAX)` (2) | `bytea` | `socio_ubicacion_mapa` y `socio_croquis_trabajo`. **Ver Pregunta abierta 3** |
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
   `parametros_plataforma`. **Todo lo demás lleva tenant**, incluido `plan_cuentas`: el Catálogo Único es común,
   pero cada cooperativa activa su propio subconjunto y sus propias bandas, y así está ya en el esquema viejo
   (`UQ_PlanCuentas_Cooperativa_Codigo`).
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
del sistema viejo) entran con M6/M7; `parametros_plataforma` y `parametros_cooperativa` entran con APP-01;
las migraciones de datos reales son MIG-01 (fase 3).

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

- **PREGUNTA ABIERTA 1 (Jorge / negocio) — precisión de las tasas.** ¿Con cuántos decimales se pacta y se
  calcula una tasa? El sistema viejo usa `DECIMAL(5,2)` (dos decimales). Si la SEPS o el contrato de crédito
  exigen cuatro, el cambio a `numeric(9,4)` es correcto pero **produce diferencias de centavos contra el
  sistema actual en las tablas de amortización**, y hay que decidir si las amortizaciones ya emitidas se
  recalculan o se congelan tal como están. Bloquea el criterio de paridad de M3.
- **PREGUNTA ABIERTA 2 (Jorge / negocio) — códigos de negocio visibles.** ¿El formato de `CreditoID`,
  `SolicitudID` y `DepositoID` es exigido por algún documento impreso, contrato o reporte a la SEPS? Si lo es,
  el código se conserva literal como columna única por cooperativa; si no, se puede simplificar. No cambia el
  modelo, sí cambia la migración.
- **PREGUNTA ABIERTA 3 (Christian) — binarios en la base.** `socio_ubicacion_mapa` y `socio_croquis_trabajo`
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
