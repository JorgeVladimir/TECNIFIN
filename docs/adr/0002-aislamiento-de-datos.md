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

- R1. El motor, no la aplicación, impide leer o escribir filas de otro tenant.
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
| R1 aislamiento | **Fuerte**, si y solo si se cumplen tres condiciones no negociables: `FORCE ROW LEVEL SECURITY` en cada tabla (el **dueño de la tabla ignora RLS** por defecto — es la trampa clásica); el rol de la aplicación **sin** `BYPASSRLS` y sin ser dueño; y ninguna función de negocio `SECURITY DEFINER` |
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
| Aislamiento garantizado por el motor | sí | sí | sí |
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
| `pg_dump` completo crece con el total de cooperativas; la ventana de respaldo también | Dimensionar con datos reales de la 20 de Febrero antes de la Fase 4. Ver Pregunta abierta 2 |
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
| 6 | **Rol**: `tecnifin_app` intenta `ALTER TABLE`, `SET ROLE tecnifin_admin` y `SET app.cooperativa_id` fuera de `withTenant` | Las tres rechazadas o sin efecto sobre el aislamiento |
| 7 | **Fuga por pool**: 200 transacciones alternando tenant A/B en concurrencia sobre el mismo pool | Ninguna ve el tenant de la otra |
| 8 | **Partida doble por tenant**: sumar debe y haber de `detalle_asiento` bajo cada tenant | Cuadra dentro de cada cooperativa, y la suma de ambas no se mezcla |
| 9 | **Rendimiento**: consultas de saldo, mayor y cartera con 2 cooperativas cargadas | Los planes usan los índices con `cooperativa_id` al frente; se registra el tiempo como línea base para la Fase 5 |

Criterio de aceptación de H1 para este ADR: pruebas 1-8 en verde en CI; la 9 con números registrados en
ARQ-01; y el runbook de restauración por cooperativa (punto 5) **con fecha comprometida**, aunque su ensayo
sea posterior a H1.

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

## Aprobaciones

| Nombre | Rol | Fecha | Acta |
|---|---|---|---|
| | Desarrollo | | |
| Christian Cuenca | Jefe de Proyecto · Infraestructura y Seguridad | | |
