# ADR-0002: aislamiento de datos entre cooperativas

- **Estado:** propuesta
- **Entregable:** ARQ-01 (hito H1, acta 30-oct-2026)
- **Capas afectadas:** base de datos / infraestructura y seguridad / aplicación
- **Revisión requerida:** Desarrollo, y **obligatoriamente** Infraestructura y Seguridad (Christian Cuenca):
  toca aislamiento, seguridad, disponibilidad, respaldo, recuperación y capacidad — los cinco supuestos de la
  cláusula 6.3. **Nunca se aprueba por silencio.**
- **Fecha del borrador:** 2026-09-20 · **Autor:** arquitectura TECNIFIN
- **Depende de:** ADR-0001 (de dónde sale el tenant y cómo llega a la sesión)

## Contexto y requisitos

Cada cooperativa es una entidad financiera regulada por la SEPS, independiente de las demás y competidora de
varias de ellas. La filtración de un saldo, un socio o una cartera entre cooperativas no es un defecto
funcional: es un incidente con el cliente y con el regulador.

Escenario a soportar: **~10 cooperativas en un solo servidor PostgreSQL 18**, un solo backend Node, un solo
despliegue. No hay equipo de operación 24/7: lo que sea complicado de operar no se va a operar bien.

El sistema viejo demostró el modo de falla exacto que hay que impedir. `11_prueba_aislamiento_multicooperativa.sql`
(secciones 5 y 6) corre dos consultas reales que mezclan cooperativas: una por olvidar el `WHERE CooperativaId`
y otra insertando una `SolicitudesCredito` con `CooperativaId = 1` apuntando a un socio de otra cooperativa.
Ambas pasaron sin error. El aislamiento por convención de la aplicación **ya falló medido**.

El fix del sistema viejo (`12_fix_consistencia_cooperativa.sql`) fue funciones escalares
`fn_CooperativaDeSocio/Usuario/Producto/TasaPlazoFijo/Periodo` invocadas desde `CHECK` constraints. Ese patrón
**no se porta a PostgreSQL**: un `CHECK` de PostgreSQL debe ser inmutable y no puede consultar otras tablas de
forma confiable (no se re-evalúa cuando cambia la tabla consultada). La idea que hay detrás sí se conserva, con
el mecanismo nativo correcto — ver "Decisión", punto 4.

Requisitos que cualquier opción debe cumplir:

- R1. El motor impide leer o escribir filas ajenas al tenant fijado por una aplicación confiable.
  **No impide que SQL arbitrario cambie ese tenant:** limitación ALTO 1, tratada en la adenda del 22-sep.
- R2. Una consulta mal escrita falla cerrada (0 filas), no abierta.
- R3. Una migración se aplica a las 10 cooperativas de una sola vez y de forma verificable (regla 3).
- R4. Restaurar los datos de **una** cooperativa a una fecha anterior sin tocar a las otras nueve.
- R5. Operable por una persona: el costo operativo crece poco al agregar la cooperativa 11.

## Opciones evaluadas

### Opción A — Una base, un esquema, `cooperativa_id` + Row Level Security (recomendada)

Todas las cooperativas comparten las mismas tablas. Cada tabla de negocio lleva `cooperativa_id integer NOT NULL`
y una política RLS que compara esa columna contra `current_setting('app.cooperativa_id')`, fijado por
`withTenant()` (ADR-0001).

| Dimensión | Evaluación |
|---|---|
| R1 aislamiento | Protege frente a consultas que omiten el filtro, con `FORCE RLS`, rol sin `BYPASSRLS` ni propiedad y sin funciones de negocio `SECURITY DEFINER`. **Además depende de la aplicación que fija el contexto: no resiste SQL arbitrario bajo ese rol** (adenda ALTO 1) |
| R2 falla cerrada | **Sí**, si la política se escribe de modo que un GUC ausente no calce ninguna fila |
| R3 migraciones | **Mejor de las tres.** Un `ALTER TABLE` toca a las 10 cooperativas a la vez. `migrate.mjs` con SHA-256 sigue sirviendo sin cambios |
| R4 restauración por cooperativa | **Punto débil.** Un `pg_restore` de la base entera devuelve a las 10 cooperativas al pasado. Requiere procedimiento aparte (ver Consecuencias) |
| R5 costo operativo | **Bajo.** Un backup, un `vacuum`, un juego de estadísticas, un pool |
| Conexiones | Un pool compartido. ~10 cooperativas no multiplican conexiones |
| Riesgo principal | Un olvido de `ENABLE`/`FORCE` RLS en una tabla nueva pasa desapercibido. Mitigable con una prueba que recorra el catálogo (ver Pruebas) |

### Opción B — Un esquema PostgreSQL por cooperativa (`coop_001.socios`, `coop_002.socios`)

| Dimensión | Evaluación |
|---|---|
| R1 aislamiento | Fuerte y más fácil de explicar: los `GRANT` son por esquema. Pero el aislamiento depende del `search_path`, que es estado de sesión igual que el GUC de la opción A — no es cualitativamente más seguro, solo distinto |
| R2 falla cerrada | Sí: una tabla que no existe en el esquema da error, no filas de otro |
| R3 migraciones | **Peor.** Cada DDL se repite N veces. Si falla en la cooperativa 7 de 10, el esquema queda desparejo y hay que reconciliar. `migrate.mjs` tendría que crecer para manejar "aplicada en 6 de 10" |
| R4 restauración por cooperativa | **Mejor de las tres.** `pg_dump -n coop_007` restaura una cooperativa sola |
| R5 costo operativo | Medio-alto: 10 esquemas × 30 tablas = 300 tablas, 300+ índices y sus estadísticas en un solo catálogo; el planificador y `autovacuum` lo notan |
| Conexiones | Un pool, con `SET LOCAL search_path` por transacción |
| Costo de cambio | Alto: `migrate.mjs`, los seeds y la fábrica de datos se reescriben |

### Opción C — Una base de datos por cooperativa

| Dimensión | Evaluación |
|---|---|
| R1 aislamiento | El más fuerte posible dentro de un servidor: no hay consulta que cruce bases |
| R2 falla cerrada | Sí |
| R3 migraciones | Peor que B: N conexiones, N transacciones, sin transacción global. Un fallo parcial deja versiones distintas en producción |
| R4 restauración por cooperativa | Excelente y trivial de explicar a un auditor |
| R5 costo operativo | **El más alto.** 10 bases = 10 respaldos, 10 juegos de conexiones, 10 verificaciones de restauración. Es el modelo que TECNIFIN no tiene gente para operar hoy |
| Conexiones | **El problema real.** El pool se multiplica por 10 y hay que abrirlo antes de saber quién es el usuario, o mantener 10 pools tibios. Con `max_connections` por defecto y 10 cooperativas ya hay que dimensionar a mano |
| Reportes consolidados | Imposible con SQL directo; exige `postgres_fdw` o ETL |

### Comparación resumida

| | A: RLS | B: esquema/coop | C: base/coop |
|---|:--:|:--:|:--:|
| Aislamiento garantizado por el motor | respecto al GUC, no frente a su manipulación | depende de permisos por esquema | depende de credenciales por base |
| Migraciones de una sola pasada | **sí** | no | no |
| Restaurar una cooperativa sola | **no, requiere procedimiento** | sí | sí |
| Costo operativo con 10 tenants | bajo | medio | alto |
| Conexiones | 1 pool | 1 pool | 10 pools |
| Costo de agregar la cooperativa 11 | insertar una fila | crear 30 tablas | crear una base + respaldo + monitoreo |
| Se rompe si alguien olvida un paso | olvidar `FORCE RLS` en 1 tabla | olvidar un DDL en 1 esquema | olvidar un respaldo en 1 base |

## Decisión y justificación

**Se adopta la Opción A: una base, un esquema, `cooperativa_id NOT NULL` + Row Level Security**, con estas
condiciones, que forman parte de la decisión y no son detalles de implementación:

1. **Separación de roles.** `tecnifin_admin` es dueño del esquema y hace DDL (migraciones). `tecnifin_app` es
   el rol de la aplicación: solo DML, **no es dueño de ninguna tabla**, **no tiene `BYPASSRLS`** y no es
   `SUPERUSER`. La aplicación nunca se conecta como `tecnifin_admin`.
2. **`ENABLE` + `FORCE ROW LEVEL SECURITY` en toda tabla de negocio.** `FORCE` no es opcional: sin él, el dueño
   de la tabla lee todo, y basta una tarea de mantenimiento conectada como dueño para saltarse el aislamiento.
3. **Política única y falla cerrada.** Una sola política `USING`/`WITH CHECK` por tabla, generada con el mismo
   texto para todas, comparando `cooperativa_id` contra el GUC de la sesión. Sin GUC fijado, la comparación no
   calza y el resultado es vacío. El `WITH CHECK` impide además **escribir** una fila con el tenant de otro.
4. **`cooperativa_id` en las 30 tablas**, incluidas las 17 que hoy lo heredan por FK (inventario en ADR-0003).
   Es denormalización deliberada: RLS no puede filtrar por una columna que no está en la tabla. La consistencia
   entre el tenant propio y el del padre se garantiza con **claves foráneas compuestas**
   (`FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios (cooperativa_id, socio_id)`), que requieren una
   clave única `(cooperativa_id, pk)` en el padre. Esto reemplaza a las funciones escalares de
   `12_fix_consistencia_cooperativa.sql`: mismo objetivo — que el motor rechace una fila cuyo tenant no coincide
   con el de su padre — con un mecanismo nativo, declarativo y verificado por el motor en todo momento.
5. **La restauración por cooperativa se resuelve por procedimiento, no por el modelo de datos**, y ese
   procedimiento es entregable de la Fase 4/5, no de H1. Diseño propuesto:
   `pg_restore` de la base completa a una base temporal → extraer las filas de la cooperativa afectada con el
   GUC fijado → reinsertar bajo transacción. Documentado y **ensayado** en `deploy/`, nunca improvisado. La
   alternativa barata para el caso más frecuente (error humano de un día) es un volcado lógico diario filtrado
   por cooperativa, además del respaldo físico.
6. **Reevaluación explícita.** Si se supera el umbral de la Pregunta abierta 3 (cooperativa que exige base
   separada por contrato, o > ~30 cooperativas), se revisa esta decisión. La opción B queda como camino de
   salida: mover de un esquema compartido a un esquema por tenant es mecánico si el `cooperativa_id` ya está
   en todas las tablas; al revés no lo es. La opción C queda disponible *por cooperativa*: nada impide en el
   futuro sacar a una sola cooperativa a su propia base con el mismo esquema y el mismo código.

**Por qué no B:** su única ventaja real sobre A (R4) es la que TECNIFIN puede cubrir con procedimiento, y su
desventaja (R3) ataca directamente al error de origen nº 3 de GUTT_SYSTEM — migraciones que se creen aplicadas
y no lo están. Con 10 esquemas, "aplicada en 6 de 10" es un estado nuevo que hoy no existe.

**Por qué no C:** paga todo el costo operativo de B más el de las conexiones y los respaldos, para 10 tenants en
un solo servidor y sin equipo de operaciones. Es la opción correcta con clientes que exigen base dedicada por
contrato — hoy ninguno lo exige (Pregunta abierta 3).

## Consecuencias y riesgos

**Más fácil:** migrar el esquema (una pasada); reportes internos consolidados; agregar la cooperativa 11
(insertar una fila en `cooperativas`); probar el aislamiento (dos tokens, mismos endpoints).

**Más difícil / lo que hay que pagar:**

| Consecuencia | Mitigación |
|---|---|
| **Restaurar una sola cooperativa no es un comando.** Es el punto débil reconocido de esta opción | Runbook escrito **y ensayado** en Fase 4/5 (punto 5 de la decisión) + volcado lógico diario por cooperativa. **Requiere el visto bueno de Christian: es un compromiso de recuperación, no un detalle** |
| Una tabla nueva sin RLS es una fuga silenciosa | Prueba automática que recorre `pg_class`/`pg_policy` y falla si alguna tabla del esquema `tecnifin` no tiene `relrowsecurity` **y** `relforcerowsecurity` **y** al menos una política |
| Un `SECURITY DEFINER` mal puesto rompe todo el modelo | Prueba de higiene: el esquema no debe tener funciones `SECURITY DEFINER` sin justificación escrita |
| El rendimiento de una cooperativa afecta a las otras (vecino ruidoso): cierres de mes, reportes SEPS | `cooperativa_id` como **primera columna** de los índices de las tablas grandes (`movimientos_cuenta`, `transacciones_caja`, `detalle_asiento`, `tabla_amortizacion`). Medir en H1 con la fábrica de datos, no suponer |
| `pg_dump` completo crece con el total de cooperativas; la ventana de respaldo también | Dimensionar con el volumen de la base de demostración y con las cifras de Christian (Pregunta abierta 2) antes de la Fase 4. Ver Pregunta abierta 2 |
| RLS añade un predicado a cada consulta; con índices mal ordenados puede cambiar planes | Medido en H1 sobre la fábrica de datos, antes de aceptar el acta |
| Un `TRUNCATE`, `ALTER` o `DROP` erróneo afecta a las 10 cooperativas a la vez | Solo `tecnifin_admin` hace DDL, solo por `migrate.mjs`, solo con respaldo verificado previo |

## Pruebas requeridas y criterio de aceptación

| # | Prueba | Criterio |
|---|---|---|
| 1 | **Catálogo**: recorrer todas las tablas del esquema `tecnifin` | Todas con `cooperativa_id NOT NULL`, `relrowsecurity`, `relforcerowsecurity` y ≥ 1 política. Las excepciones (catálogos globales de ADR-0003) están en una lista explícita dentro de la prueba |
| 2 | **Lectura cruzada**: `withTenant(A)` sobre cada tabla de negocio con datos en A y B | 0 filas de B. Portación de `11_prueba_aislamiento_multicooperativa.sql` |
| 3 | **Escritura cruzada**: `withTenant(A)` intenta insertar con `cooperativa_id` de B | Rechazado por el `WITH CHECK` de la política |
| 4 | **Padre cruzado** (el bug de `11`, sección 6): crear un crédito de la coop A cuyo socio es de la B | Rechazado por la FK compuesta. Es el mismo caso que el script viejo probaba; aquí debe fallar en el motor |
| 5 | **Sin tenant**: consulta sobre tabla de negocio sin `withTenant` | 0 filas |
| 6 | **Rol**: `tecnifin_app` intenta DDL, `SET ROLE tecnifin_admin` y cambiar el GUC | DDL y escalamiento rechazados. El cambio de GUC **sí permite acceso cruzado**; se conserva una prueba de caracterización del riesgo, no se declara corregido (adenda ALTO 1) |
| 7 | **Fuga por pool**: 200 transacciones alternando tenant A/B en concurrencia sobre el mismo pool | Ninguna ve el tenant de la otra |
| 8 | **Partida doble por tenant**: sumar debe y haber de `detalle_asiento` bajo cada tenant | Cuadra dentro de cada cooperativa, y la suma de ambas no se mezcla |
| 9 | **Rendimiento**: consultas de saldo, mayor y cartera con 2 cooperativas cargadas | Los planes usan los índices con `cooperativa_id` al frente; se registra el tiempo como línea base para la Fase 5 |

Criterio de aceptación de H1 para este ADR: pruebas 1-8 en verde en CI, con la excepción de seguridad de la
prueba 6 **aceptada expresamente por Christian en acta o corregida**; controles pendientes de la adenda
verificados; la 9 con números registrados en ARQ-01; y el runbook de restauración por cooperativa (punto 5)
**con fecha comprometida**, aunque su ensayo sea posterior a H1. Una suite verde no acepta el riesgo.

## Preguntas abiertas

- **PREGUNTA ABIERTA 1 (Christian) — objetivo de recuperación.** ¿Cuál es el RPO y el RTO comprometidos con una
  cooperativa? ¿Y el compromiso para el caso "una cooperativa necesita volver atrás sin afectar a las otras
  nueve"? La respuesta decide si el punto 5 de la decisión es suficiente o si hay que reabrir la opción B.
  **Este ADR no puede aprobarse sin esta respuesta.**
- **PREGUNTA ABIERTA 2 (Christian) — capacidad.** Volumen estimado por cooperativa (socios, transacciones/día,
  retención en años) para dimensionar el servidor, la ventana de respaldo y decidir si `movimientos_cuenta`,
  `transacciones_caja` y `detalle_asiento` nacen particionadas. Sin esto, cualquier cifra de capacidad en
  ARQ-01 es una suposición.
- **PREGUNTA ABIERTA 3 (Christian / Jorge / comercial) — exigencia contractual.** ¿Alguna cooperativa objetivo
  exige, o va a exigir, base de datos o servidor dedicado? Si la SEPS o el cliente lo pide, la opción A no
  cambia — se saca a esa cooperativa a su propia base con el mismo esquema — pero hay que saberlo antes de
  firmar y ponerle precio.
- **PREGUNTA ABIERTA 4 (Christian) — cifrado y claves.** ¿Se exige cifrado en reposo? ¿Y de los respaldos?
  ¿Dónde viven las claves? Con una base compartida por 10 cooperativas, el cifrado a nivel de base no separa
  tenants: si se necesita separación criptográfica por cooperativa, eso sí reabre la opción C.
- **PREGUNTA ABIERTA 5 (Christian) — quién puede conectarse a la base.** ¿Hay acceso directo (psql, herramienta
  de reportes) al servidor productivo, y con qué rol? Un rol de lectura sin RLS forzado anula todo este ADR.

## Adenda 22-sep-2026 — ALTO 1: confianza en la fijación del tenant

**Estado: propuesta. Decisión provisional tomada por Jorge el 22-sep-2026**, según el
[encargo ALTO 1](../handoff/encargos/alto1-fijacion-tenant.md): opción 1, conservar el mecanismo actual
con controles compensatorios y riesgo residual explícito mientras se construye APP-01.
**Falta la revisión y aprobación expresa de Christian antes de producción (cláusula 6.3);
no se aprueba por silencio.** Esta adenda no llena el acta ni cierra técnicamente el ALTO 1.

### Hallazgo y límite de confianza

`tecnifin_app` puede cambiar `app.cooperativa_id` dentro de la misma transacción y leer/actualizar usuarios
de B después de entrar por `withTenant(A)`. La política sigue aplicándose, pero a un contexto elegido por
el atacante. No hace falta controlar todo Node: basta una vía de ejecución de SQL arbitrario con ese rol.
No se ha demostrado una inyección HTTP; todavía no existe la capa de autenticación APP-01.

`bindNamed` mantiene los **valores** fuera del texto SQL; no valida ni autoriza ese texto, ni rechaza SQL
arbitrario bien formado. Las pruebas actuales de parámetros y SQL incompleto no prueban lo contrario.
Se exige SQL escrito por el desarrollador y valores enlazados; identificadores u ordenaciones variables
requieren listas permitidas. Nunca concatenar entrada de la petición al SQL.

PostgreSQL acepta parámetros personalizados de dos componentes. El privilegio `SET ON PARAMETER` sirve
para conceder cambios de parámetros restringidos; revocarlo no convierte este GUC ordinario en uno
protegido. Véanse [opciones personalizadas](https://www.postgresql.org/docs/18/runtime-config-custom.html)
y [privilegios de parámetros](https://www.postgresql.org/docs/18/ddl-priv.html).

### Opciones evaluadas

| Opción | Ventaja y costo | Decisión provisional |
|---|---|---|
| 1. GUC + controles compensatorios | Conserva pool, roles y migraciones; complejidad baja. RLS protege contra filtros olvidados, pero SQL arbitrario permite acceso cruzado | Elegida para continuar desarrollo; requiere completar controles y aceptación expresa del riesgo antes de producción |
| 2. Contexto autenticado verificado por la base | Puede resistir falsificación desde SQL; exige autenticación, gestión de claves/sesiones y cambios de RLS. Complejidad alta | Diseñar junto con APP-01 si Christian exige impedir el cambio desde SQL; no introducir un verificador incompleto aquí |
| 3. Login y pool por tenant, sin permisos sobre otros tenants | La identidad de conexión puede ser una frontera independiente del GUC | Viable, pero multiplica credenciales, rotación y pools; cambia el contrato operativo. No elegida ahora |
| 4. Esquema/base por tenant con permisos separados | Reduce el alcance de una credencial comprometida | Mayor costo de migraciones, conexiones y recuperación; reabrir si se exige aislamiento de credenciales/infraestructura |
| 5. Más políticas sobre el mismo GUC, límites de conexión o revocar SET | Los límites ayudan a disponibilidad; otra política puede reforzar reglas de negocio | No autentican el tenant; no corrigen ALTO 1. No se presentan como solución |

**Viabilidad de la opción 2.** Una función `SECURITY DEFINER` que sólo comprueba una firma y luego fija el
mismo GUC es eludible: el rol sigue pudiendo hacer `SET` después. RLS debe consumir un contexto autenticado
completo o consultar un registro protegido, nunca confiar sólo en un entero modificable.

Un HMAC necesita la misma clave para generar y verificar; «HMAC con una clave que la base nunca ve» no
permite verificación local. Una clave compartida guardada fuera del alcance de `tecnifin_app` es viable;
para que la base no tenga la clave privada hace falta firma asimétrica y un verificador adecuado.
La documentación de [HMAC en pgcrypto](https://www.postgresql.org/docs/18/pgcrypto.html) define la clave
como entrada de la operación; no se ha seleccionado ni instalado un verificador de JWT en PostgreSQL.

Otra alternativa es una sesión opaca emitida tras autenticar credenciales y comprobar pertenencia al tenant,
guardada en una tabla inaccesible al rol de aplicación. Una función que acepte únicamente un tenant solicitado
y emita una sesión para él no autentica nada. Deben definirse caducidad, revocación, rotación, vinculación a
usuario/tenant y defensa frente a reutilización de tokens, sin exponerlos en logs o consultas de otras sesiones.
Eso depende del diseño de APP-01 y de las preguntas abiertas de autenticación; no se decide aquí.

Si se usa `SECURITY DEFINER`, deberá pertenecer a `tecnifin_admin`, tener `search_path` seguro, nombres
cualificados y `EXECUTE` revocado a `PUBLIC`, con privilegios mínimos y prueba adversaria. Son requisitos
de implementación, no una aprobación anticipada; véase [seguridad de funciones](https://www.postgresql.org/docs/18/sql-createfunction.html).
También habrá que adaptar el trigger de cuadre de 0014, que hoy cambia/restaura temporalmente el tenant.

**Límite de la opción 3.** Un rol común con permiso para `SET ROLE` a todos los tenants conserva la capacidad
de cambiar de identidad. Se necesitan logins aislados y políticas basadas en identidad no falsificable por
esa conexión, sin pertenencias cruzadas. [SET ROLE](https://www.postgresql.org/docs/18/sql-set-role.html)
depende de los permisos de pertenencia; cambiar sólo el nombre del rol no crea una frontera.
Un compromiso completo del proceso que custodia todas las credenciales o la clave de firma sigue fuera
de la protección de estas opciones; requeriría separar procesos y credenciales.

### Controles, responsables y evidencia exigida

| Control | Estado y responsable | Evidencia para aceptar |
|---|---|---|
| Fijador único en código de aplicación | Implementado aquí: `tests/higiene-tenant.test.mjs`; mantenimiento por desarrollo | Recorre código de `src`, `tools`, `deploy`, `db` y `tests`; rechaza nuevas llamadas a `set_config`, escrituras directas SET/RESET del tenant y limpieza global del contexto fuera de excepciones explícitas |
| Consultas parametrizadas y revisión de SQL | `bindNamed` ya existe; revisión obligatoria por desarrollo | Valores hostiles permanecen como parámetros; revisar SQL dinámico en cada endpoint. La higiene textual no detecta todas las construcciones dinámicas ni sustituye revisión |
| Tenant desde identidad autenticada | **Implementado en APP-01, 22-sep-2026**, pendiente revisión | JWT verificado (HS256 permitido, emisor, audiencia, vigencia y pertenencia autorizada); claim `coop` como única fuente en endpoints protegidos. Cuerpo, ruta, query y cabeceras no lo sustituyen. El login resuelve el código público, nunca recibe el id interno |
| Detección y registro de cambios inesperados | **Implementado en APP-01, 22-sep-2026**, desarrollo + operación de Christian | Correlaciona petición, usuario, tenant esperado, conexión y transacción; comprueba al entrar/salir, revierte, descarta conexión y emite evento externo sin tokens, claves ni SQL. La prueba fuerza el desvío y verifica rollback, descarte y alerta |
| Credenciales y acceso directo | **Pendiente confirmación de Christian** | Acceso a `tecnifin_app` sólo del servicio; reportes y soporte sin credenciales compartidas del servicio; probar permisos y gestión de secretos |

La detección en los límites de una consulta/transacción es **parcial**: puede omitir un cambio a B seguido
de restauración a A dentro del SQL ejecutado. Registrar sólo las llamadas a `withTenant` tampoco observa
las demás vías. No hay una alerta completa implementada hoy; su cobertura y limitaciones deben quedar
ensayadas y aceptadas. Si Christian exige prevención frente a SQL arbitrario, la opción 1 es insuficiente
y se reabre la opción 2 o 3 antes de producción.

Excepciones de higiene cerradas: `tenant.js` es el fijador; `tests/tenant.test.mjs` comprueba su SQL;
`tests/aislamiento.integration.test.mjs` contiene ataques de caracterización y la regresión del cuadre;
la prueba de higiene contiene sus propios ejemplos. `0007_contabilidad.sql` conserva una marca histórica
reemplazada por 0014; `0014_correcciones_revision_dat01_02.sql` cambia/restaura el contexto desde `OLD/NEW`
para validar el cuadre diferido. No se reescriben migraciones aplicadas ni se permite por defecto a futuras
migraciones fijar el tenant. Estas excepciones no son caminos de selección de tenant para endpoints.

### Consecuencias y pruebas de esta unidad

- Sin cambios de esquema ni de API de `withTenant`: no corresponde migración 0015. Se agregan controles
  de higiene y una prueba de caracterización sobre la base efímera con datos sintéticos.
- La prueba ALTO 1 entra por A con el rol real de aplicación, cambia a B, demuestra lectura y escritura,
  fuerza `ROLLBACK` y verifica que B conserva su valor original. **Verde significa riesgo reproducible,
  no ataque impedido.** Cuando se endurezca, deberá exigir rechazo y ausencia de efectos cruzados.
- Siguen vigentes las pruebas de aislamiento normal, ausencia de tenant, permisos, FK y reutilización
  concurrente del pool. `SET LOCAL` limita la duración del contexto; no autentica a quien lo modifica.
- APP-01 implementó JWT y detección/alerta el 22-sep-2026. La detección sigue siendo parcial según el límite
  descrito arriba y la aceptación expresa del riesgo continúa pendiente; no se declara aprobado ADR-0002
  ni habilitada producción.
- Christian debe confirmar por acta si acepta el alcance de la opción 1 y los controles pendientes o exige
  la opción 2/3, además de las preguntas abiertas de este ADR. La revisión cruzada de aislamiento no la
  sustituye quien implementó esta unidad.

## Aprobaciones

| Nombre | Rol | Fecha | Acta |
|---|---|---|---|
| | Desarrollo | | |
| Christian Cuenca | Jefe de Proyecto · Infraestructura y Seguridad | | |
