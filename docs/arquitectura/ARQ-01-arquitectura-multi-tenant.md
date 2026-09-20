# ARQ-01 · Arquitectura multi-tenant de TECNIFIN

- **Estado:** BORRADOR (semana 1 de H1, adelantado). No aprobado.
- **Entregable contractual:** ARQ-01, hito **H1** — modelo de base de datos multi-tenant en PostgreSQL,
  acta de aceptación **30-oct-2026**
- **Apartados:** los que exige la cláusula 6.1 del contrato
- **Revisión requerida:** Desarrollo, y **revisión expresa de Christian Cuenca** (Jefe de Proyecto ·
  Infraestructura y Seguridad) por los apartados 6, 9, 12, 13 y 14 — cláusula 6.3: **nunca se aprueba por
  silencio**
- **Fecha del borrador:** 2026-09-20 · **Autor:** arquitectura TECNIFIN
- **Versión:** 0.1

> Este documento **no repite** las decisiones: las referencia. El fundamento, las alternativas descartadas y las
> pruebas de cada una viven en su ADR. Si un apartado de aquí contradice a un ADR, manda el ADR.

| ADR | Decide | Estado |
|---|---|---|
| [ADR-0001](../adr/0001-identificacion-del-tenant.md) | Qué es un tenant, de dónde sale en cada petición, cómo llega a la sesión de base de datos | propuesta |
| [ADR-0002](../adr/0002-aislamiento-de-datos.md) | Una base / un esquema / `cooperativa_id` + Row Level Security, frente a esquema y base por cooperativa | propuesta |
| [ADR-0003](../adr/0003-modelo-y-nomenclatura.md) | Tipos T-SQL → PostgreSQL, nomenclatura, reglas transversales del modelo, alcance de DAT-01 | propuesta |

---

## 1. Objetivo y alcance

**Objetivo.** Definir la arquitectura que permite a TECNIFIN operar el core bancario de **~10 cooperativas de
ahorro y crédito** reguladas por la SEPS sobre **un solo servidor PostgreSQL 18 y un solo backend Node.js**,
con aislamiento de datos garantizado por el motor y no por la disciplina de quien escribe las consultas.

**Dentro del alcance de H1 (1 → 30-oct-2026):**

- Modelo de multi-tenencia: identificación del tenant, aislamiento, modelo de datos y nomenclatura (apartados 4-8).
- El DDL de las **30 tablas** de `db/gutt_system/01-09` traducido a `db/migrations/` (DAT-01, semana 2).
- Catálogos regulatorios sembrados desde `db/seeds/` (semana 3).
- Prueba de aislamiento entre dos cooperativas y prueba de partida doble, en verde en CI (semanas 3-4).
- Fábrica de datos de dos cooperativas (semana 4).

**Fuera del alcance de H1, pero definido aquí para que el modelo no lo impida:**

- El núcleo de aplicación APP-01 (tenant, IAM, auditoría, configuración por tenant) — hasta el 30-nov.
- Los módulos M1-M7 — dic-2026 a feb-2027.
- La migración de datos reales desde `SQLGUTPATATE` (MIG-01) — marzo-2027, sobre restauración del respaldo.
- El dimensionamiento del servidor de producción y el runbook de restauración por cooperativa — Fases 4 y 5.

**Explícitamente fuera:** GUTT_SYSTEM (`server.js`, `SQLGUTPATATE`, servicio `GuttSystemBackend`) no se toca.
Sigue sirviendo la demo y a la COAC 20 de Febrero durante todo el proyecto.

## 2. Estado actual

**El sistema vigente (GUTT_SYSTEM).** Node/Express + SQL Server, `server.js` de ~6.400 líneas, base
`SQLGUTPATATE` **mono-cooperativa: sin `CooperativaId`**. Funciona en producción y es la referencia funcional y
numérica de todo lo que TECNIFIN debe reproducir: reportería SEPS, proceso mensual de cartera, solvencia
regulatoria paramétrica.

**El rediseño a medias.** `db/gutt_system/01-22` es un esquema renombrado y ya multi-tenant (30 tablas con
`CooperativaId`), probado con fixtures pero **nunca desplegado**: vive junto a un segundo backend
(`server.gutt_system.js`, puerto 5006) que no corre. Es el punto de partida de TECNIFIN, no un sistema vivo.

**Lo que ya está probado y hay que conservar.** Estos scripts no son documentación: son casos borde pagados con
bugs reales, y su resultado entra al modelo nuevo como requisito, no como sugerencia.

| Script | Qué demostró | Cómo entra a TECNIFIN |
|---|---|---|
| `11_prueba_aislamiento_multicooperativa.sql` | Una consulta sin `WHERE CooperativaId` mezcla dos cooperativas; y el esquema aceptó un crédito de la coop A con un socio de la coop B | Es la prueba 2 y 4 de ADR-0002; ahora ambos casos deben fallar **en el motor** |
| `12_fix_consistencia_cooperativa.sql` | El fix por funciones escalares en `CHECK` (patrón de SQL Server) | No se porta: se reemplaza por **FK compuestas** `(cooperativa_id, padre_id)` — ADR-0002 §4 |
| `13_fix_indices_fk_faltantes.sql` | 27 columnas FK sin índice de soporte | Los índices nacen con el DDL — ADR-0003 §3.8 |
| `14_fix_fk_usuario_faltantes.sql` | FK de usuario faltantes; y que las tablas de auditoría **no deben tenerlas** | Se conserva tal cual — ADR-0003 §3.7 |

**Lo que ya existe en `C:\TECNIFIN`** (Fase 0 cerrada): repo con las 14 reglas en `CLAUDE.md`; capa de acceso
`src/platform/postgres.js` (`postgresConfig`, `bindNamed`, `createDatabase` con `query`/`transaction`/`close`,
`connectPostgres`); `tools/migrate.mjs` con control SHA-256; base `tecnifin_dev` en `127.0.0.1:5432` con roles
`tecnifin_admin`/`tecnifin_app`; 15 pruebas en verde (9 unitarias + 6 de higiene); CI escrito.
`db/migrations/` y `db/seeds/` están **vacíos**: eso es DAT-01.

## 3. Alternativas evaluadas

Se evaluaron tres modelos de multi-tenencia. La comparación completa, dimensión por dimensión, está en
**ADR-0002**; aquí el resumen para el acta:

| | A · una base, un esquema, RLS | B · un esquema por cooperativa | C · una base por cooperativa |
|---|:--:|:--:|:--:|
| Aislamiento garantizado por el motor | sí | sí | sí |
| Migración aplicada de una sola pasada | **sí** | no (N veces) | no (N veces) |
| Restaurar una cooperativa sola | **requiere procedimiento** | sí | sí |
| Costo operativo con 10 tenants | bajo | medio | alto |
| Conexiones | 1 pool | 1 pool | 10 pools |
| Agregar la cooperativa 11 | una fila | 30 tablas | base + respaldo + monitoreo |
| Modo de falla si alguien olvida un paso | 1 tabla sin RLS | 1 esquema desactualizado | 1 base sin respaldo |

También se evaluó, y se descartó, el modelo del sistema viejo: **aislamiento por convención de la aplicación**
(filtrar `CooperativaId` en cada consulta, sin RLS). Está descartado por evidencia, no por preferencia:
`11_prueba_aislamiento_multicooperativa.sql` ya lo rompió dos veces con datos reales.

## 4. Modelo seleccionado

**Opción A: una base de datos, un esquema (`tecnifin`), `cooperativa_id NOT NULL` en toda tabla de negocio y
Row Level Security forzado**, con separación de roles entre DDL y DML.

Por qué, en una línea: es la única de las tres que **no empeora el error de origen nº 3 de GUTT_SYSTEM**
(migraciones que se creen aplicadas y no lo están), y su desventaja — la restauración por cooperativa — es la
única que se puede cubrir con un procedimiento operativo en vez de con arquitectura.

La decisión lleva **cuatro condiciones que no son negociables** y que forman parte de ella (ADR-0002 §Decisión):
`FORCE ROW LEVEL SECURITY` en cada tabla; rol de aplicación sin `BYPASSRLS` y que no sea dueño; política que
falla cerrada sin el GUC de sesión; y FK compuestas con el tenant.

**Puerta de salida.** Si la Pregunta abierta 3 de ADR-0002 cambia (un cliente exige base dedicada), se saca a
*esa* cooperativa a su propia base **con el mismo esquema y el mismo código**: el modelo A no lo impide. El
camino inverso — de bases separadas a una compartida — sí sería costoso.

## 5. Identificación del tenant

→ **ADR-0001**. Resumen operativo:

- El tenant es la **cooperativa**; su clave interna es `cooperativa_id integer`. Nunca aparece en URLs ni en
  documentos; para lo visible, `cooperativas` lleva un código corto y estable.
- Se toma del claim **`coop` del JWT**, emitido en el login desde `usuarios.cooperativa_id`. Ningún endpoint lo
  acepta por ruta, query ni cabecera.
- Llega a la base por **`withTenant(cooperativaId, fn)`** (`src/platform/`), que abre transacción, ejecuta
  `SET LOCAL app.cooperativa_id` y corre el trabajo. `LOCAL` es lo que impide que el tenant quede pegado a una
  conexión del pool.
- La unicidad de negocio pasa a ser **unicidad por tenant** (usuario, número de cuenta, número de socio, códigos
  de crédito y DPF, control de caja).

```
  HTTP  ──►  middleware JWT  ──►  contexto { cooperativaId, usuarioId, rol }
                                        │
                                        ▼
                         withTenant(cooperativaId, async db => { ... })
                                        │  BEGIN; SET LOCAL app.cooperativa_id = $1
                                        ▼
                         PostgreSQL · política RLS por tabla
                         USING (cooperativa_id = current_setting('app.cooperativa_id')::int)
```

## 6. Aislamiento de datos · *(revisión expresa de Christian — cl. 6.3)*

→ **ADR-0002**. El aislamiento se sostiene en **cuatro capas**, y ninguna sustituye a la anterior:

1. **Motor — RLS forzado.** Política `USING` + `WITH CHECK` por tabla contra el GUC de la sesión. Impide leer y
   también escribir con el tenant de otro. Sin GUC: 0 filas.
2. **Motor — integridad referencial.** FK compuestas `(cooperativa_id, padre_id)`: un hijo no puede apuntar a un
   padre de otra cooperativa. Es el caso que el esquema viejo aceptaba.
3. **Privilegios.** `tecnifin_app` no es dueño, no tiene `BYPASSRLS`, no hace DDL. `tecnifin_admin` solo corre
   migraciones. La aplicación nunca se conecta como dueño.
4. **Aplicación.** `withTenant` como única puerta; nadie filtra `cooperativa_id` a mano (regla 1 de `CLAUDE.md`).

**Debilidad reconocida y su compromiso:** restaurar una sola cooperativa no es un comando. Se cubre con un
runbook ensayado más un volcado lógico diario por cooperativa (apartado 13). **Este es el punto que requiere la
firma de Christian:** es un compromiso de recuperación frente a un cliente, no un detalle de implementación.

## 7. Modelo de aplicación

Un solo backend Node.js, una sola base activa por entorno (regla 2 — prohibidos los `server.x.js` paralelos que
causaron la confusión en GUTT_SYSTEM).

```
src/platform/     pool y bindNamed (ya existe) · withTenant · auth/JWT · auditoría · config por tenant
src/modules/<dominio>/    routes · service · queries      (≤ 500 líneas por archivo, regla 4)
db/migrations/    NNNN_*.sql, aplicadas solo por tools/migrate.mjs con SHA-256 (regla 3)
db/seeds/         plan de cuentas SEPS, ponderaciones, parámetros regulatorios
tests/fixtures/   fábrica de datos de DOS cooperativas
tools/            migrate.mjs · db.mjs (solo lectura) · token.mjs · paridad.mjs
```

Reglas de construcción que afectan a la arquitectura y no solo al estilo:

- **Una sola implementación de cada paso compartido** (regla 13). Lo que se repite en más de un módulo vive en
  `src/platform/`: `withTenant`, auditoría, JWT, configuración por tenant, y **el motor de cartera SEPS**
  (portado una sola vez desde `services/carteraSeps.js`, compartido por el proceso mensual y por los reportes,
  para que no puedan discrepar — ese fue precisamente el arreglo del sistema viejo).
- **Ninguna consulta usa el pool crudo** fuera de `src/platform/`; una prueba de higiene lo comprueba.
- **Paridad numérica antes de cerrar** créditos, cartera y contabilidad: `tools/paridad.mjs` compara contra SQL
  Server con los mismos datos (conteos, saldos, asientos cuadrados, cartera bruta frente a amortización).

## 8. Modelo de base de datos

→ **ADR-0003** para tipos, nomenclatura y reglas transversales; el inventario de las 30 tablas y el desglose por
archivo están ahí y son el alcance exacto de DAT-01.

Lo que un lector del acta necesita saber sin abrir el ADR:

- **30 tablas**, nombres de negocio en español, identificadores físicos en `snake_case`, esquema `tecnifin`.
- **Dinero en `numeric(18,2)`**; nunca coma flotante.
- **Momentos en `timestamptz(0)`, fechas de negocio en `date`**: una fecha contable no tiene zona horaria, y
  confundirlas mueve asientos de período.
- **Hoy solo 13 de las 30 tablas llevan `cooperativa_id`.** Las otras 17 lo heredan por FK y **todas lo
  reciben**: una política RLS no puede filtrar por una columna que no existe. Es el trabajo con más riesgo de
  omisión de DAT-01 y por eso la prueba de catálogo (ADR-0002, prueba 1) recorre el diccionario en vez de
  confiar en una lista.
- **Los datos regulatorios son datos.** Bandas de antigüedad SEPS leídas del plan de cuentas por familia
  (`1402` corta distinto que `1422`, y `1423`/`1427` tienen seis bandas); ponderaciones y parámetros de
  patrimonio técnico en tablas. Ninguna constante de banda en el código.
- **Las cuentas se seleccionan por prefijo numérico sin puntos**, nunca por nombre. La cartera es
  `1401..1428`; `{14}` es **neta** e incluye `1499`. Esto está en el modelo como `CHECK` de formato y como
  prueba, no como advertencia en un comentario.

## 9. IAM — identidad, autenticación y autorización · *(revisión de Christian)*

**Borrador.** Se detalla en APP-01 (hasta el 30-nov); aquí queda lo que el modelo de H1 ya condiciona.

- **Identidad.** `usuarios` pertenece a una cooperativa (`cooperativa_id NOT NULL`). El nombre de acceso es
  único **por cooperativa**, no global (ADR-0001). Un usuario **no** puede pertenecer a dos cooperativas;
  si hiciera falta, son dos identidades distintas.
- **Autenticación.** JWT emitido en el login, con `sub` (usuario), `coop` (tenant) y `rol`. Contraseñas con
  hash; el `PIN` de cuatro dígitos del esquema viejo es un segundo factor operativo de caja, **no** una
  credencial de autenticación: no sustituye a la contraseña.
- **Autorización.** Roles del esquema viejo: `SUPER_USER`, `ADMIN`, `MANAGER`, `CREDIT_OFFICER`, `TELLER`,
  `MEMBER` (`CHECK` en `usuarios.rol`). **Se corrige un defecto conocido del sistema viejo:** `server.js` no
  tiene lista blanca de roles para aprobar créditos — solo **bloquea** `CREDIT_OFFICER`, con lo que cualquier
  otro rol puede aprobar. TECNIFIN usa **lista blanca explícita por operación**, nunca lista negra.
- **Roles de base de datos.** `tecnifin_admin` (dueño, DDL, migraciones) y `tecnifin_app` (DML, sujeto a RLS,
  sin `BYPASSRLS`). Son roles de infraestructura y no tienen relación con los roles de negocio de arriba.
- **Sin rol capaz de cruzar tenants.** El acceso de soporte de personal de TECNIFIN es la **Pregunta abierta 1
  de ADR-0001** y no tiene respuesta técnica hasta que exista la contractual.

## 10. Auditoría

- Dos tablas heredadas: `auditoria_procesos` (qué proceso corrió, sobre qué entidad) y `auditoria_usuarios`
  (accesos e intentos). Ambas con `cooperativa_id` y RLS.
- **Sin FK hacia `usuarios`, deliberadamente**: un intento de acceso con un usuario inexistente es exactamente
  el evento que hay que poder registrar (decisión ya tomada y documentada en `14_fix_fk_usuario_faltantes.sql`).
- **Append-only para la aplicación:** `tecnifin_app` inserta y lee; no actualiza ni borra.
- Toda operación que mueve dinero o cambia el estado de un crédito, una cuenta o un período contable deja
  rastro con usuario, momento (`timestamptz`) y tenant.
- **Pendiente de APP-01:** política de retención de la auditoría y si se separa del respaldo transaccional.
  Relacionado con la Pregunta abierta 4 de ADR-0003 (retención y particionado).

## 11. Configuración por tenant

Tres niveles, deliberadamente separados:

| Nivel | Dónde vive | Ejemplos |
|---|---|---|
| **Plataforma** (global, sin tenant) | `parametros_plataforma` (clave/valor) | Nombre visible del producto — es un **dato**, no una constante regada por el código (regla 9); versión del esquema |
| **Cooperativa — marca** | columnas de `cooperativas` | Razón social, RUC, código SEPS, nombre comercial, colores, logo (ya existen en el esquema heredado) |
| **Cooperativa — operación y regulación** | tablas paramétricas con `cooperativa_id` | Plan de cuentas activo y sus bandas, productos financieros, tasas de plazo fijo, ponderaciones de riesgo, parámetros de patrimonio técnico, períodos contables |

Principio: **se edita el dato, no el código.** Es lo que ya se logró en el sistema viejo con la solvencia
regulatoria (`PonderacionesRiesgo`, `ParametrosPatrimonioTecnico`, `ParametrosRegulatorios`) y lo que evita que
agregar una cooperativa sea un despliegue.

## 12. Respaldo y restauración · *(revisión expresa de Christian — cl. 6.3)*

**Borrador con compromiso pendiente.** El detalle operativo es de las Fases 4 y 5; lo que sigue es lo que la
arquitectura ya obliga y lo que hay que acordar antes de aceptar ADR-0002.

- **Respaldo completo del clúster** (físico o `pg_dump` completo), verificado — no basta con generarlo: hay que
  probar que restaura, como ya se hace en GUTT_SYSTEM con `RESTORE VERIFYONLY`.
- **Volcado lógico diario por cooperativa**, filtrado con el tenant fijado. Es lo que hace barato el caso
  frecuente: "la cooperativa X necesita volver atrás un día".
- **Restaurar una cooperativa sin tocar a las otras nueve** es un **procedimiento de varios pasos**, no un
  comando: restaurar el respaldo completo a una base temporal, extraer las filas del tenant, reinsertar bajo
  transacción. **Escrito y ensayado** en `deploy/`; nunca improvisado durante un incidente.
- **Migraciones y respaldo van juntos:** ningún DDL sobre producción sin respaldo verificado inmediatamente
  antes. Un `ALTER` erróneo alcanza a las 10 cooperativas a la vez (consecuencia aceptada del modelo A).
- **Ensayo de migración de datos reales (MIG-01) solo sobre una restauración del respaldo**, nunca contra la
  base viva (regla 11).

**Sin respuesta a las Preguntas abiertas 1 y 4 de ADR-0002 (RPO/RTO y cifrado), este apartado no se puede
cerrar y ADR-0002 no se puede aprobar.**

## 13. Capacidad y rendimiento · *(revisión de Christian)*

**Borrador — sin cifras comprometidas.** Cualquier número aquí antes de la Pregunta abierta 2 de ADR-0002
(volumen por cooperativa) sería una suposición, y este documento no las va a presentar como hechos.

Lo que sí está decidido:

- `cooperativa_id` es la **primera columna** de los índices compuestos de las tablas grandes
  (`movimientos_cuenta`, `transacciones_caja`, `detalle_asiento`, `tabla_amortizacion`). RLS añade un predicado
  a cada consulta; si el índice no lo lleva al frente, el plan degrada.
- Se mide en H1 con la fábrica de dos cooperativas y se registra la **línea base** de las consultas de saldo,
  mayor general y cartera. Esa línea base es el criterio contra el cual se juzgará la Fase 5.
- **Vecino ruidoso:** en el modelo A, el cierre de mes o un reporte SEPS pesado de una cooperativa compiten con
  las demás. Se acepta para 10 tenants en un servidor; se vigila con la línea base.
- **Particionado por fecha** de las tres tablas de mayor crecimiento: decisión abierta, atada a la retención
  (Pregunta abierta 4 de ADR-0003). Hacerlo en DAT-01 es barato; hacerlo después cuesta una ventana de
  indisponibilidad.
- Un solo pool de conexiones para todas las cooperativas; `max_connections` se dimensiona en la Fase 4.

## 14. Observabilidad y operación

**Borrador.** `deploy/` se construye desde la Fase 0 y se prueba en cada fase (regla 10), no al final — ese fue
el error nº 10 de GUTT_SYSTEM. Hoy `C:\TECNIFIN\deploy\` tiene solo un README con lo que falta.

- Salud del backend y de la base, con una comprobación que **verifique la conexión a PostgreSQL**, no solo que
  el proceso esté vivo.
- Registro de operaciones con `cooperativa_id` y usuario en cada línea, para poder responder "qué pasó en la
  cooperativa X" sin cruzar datos entre clientes.
- `preflight` ejecutable como checklist de "listo para producción", corrido **como administrador** (en Windows,
  `Get-ScheduledTask` devuelve vacío sin elevación en vez de fallar, y eso ya declaró "no listo" a un equipo
  bien instalado).
- Trampas de Windows ya pagadas y documentadas en `CLAUDE.md`: `.ps1` en ASCII puro; `Start-Process` **sin**
  redirección de salida (con redirección el proceso queda vivo pero sin escuchar el puerto).
- **El CI solo prueba** (regla 12). El despliegue es manual y pasa por `preflight`. Un push a `main` no publica
  nada — al revés que los repos hermanos.

## 15. Riesgos

| Riesgo | Impacto | Mitigación | Dueño |
|---|---|---|---|
| Una tabla nueva sin RLS o sin `FORCE` | Fuga entre cooperativas, silenciosa | Prueba que recorre el catálogo, no una lista escrita a mano (ADR-0002, prueba 1) | Desarrollo |
| Una consulta ejecutada fuera de `withTenant` | Devuelve 0 filas: se nota, pero como bug funcional | Falla cerrada por diseño + prueba de higiene sobre el uso del pool | Desarrollo |
| Restaurar una cooperativa sola no está ensayado cuando se necesite | Incidente con cliente, sin plan | Runbook con fecha comprometida y ensayo en Fase 5 | Christian |
| Omitir `cooperativa_id` en alguna de las 17 tablas que hoy no lo llevan | La tabla queda sin aislamiento | Inventario explícito en ADR-0003 + prueba de catálogo | Desarrollo |
| Cambio de precisión de tasas (`(5,2)` → `(9,4)`) | Diferencias de centavos contra el sistema actual | Arnés de paridad antes de cerrar M3; Pregunta abierta 1 de ADR-0003 | Jorge |
| Clasificar mal `date` frente a `timestamptz` | Asientos que cambian de período | Criterio escrito en ADR-0003 + revisión columna por columna en DAT-01 | Desarrollo |
| ADR-0002 sin revisión expresa de Christian | **H1 se atrasa** (riesgo ya registrado en el plan) | Borrador enviado el 2-oct; acta explícita, nunca silencio | Christian |
| Volumen real desconocido | Servidor mal dimensionado; ventana de respaldo insuficiente | Preguntas abiertas 2 de ADR-0002 y 4 de ADR-0003, antes de la Fase 4 | Christian |
| El nombre TECNIFIN no se aprueba en la reserva | Renombrado | Identificadores TECNIFIN en un solo lugar y nombre visible como dato: renombrar es barato **si se hace antes de H1** | Jorge |

## 16. Supuestos

Si alguno resulta falso, este documento se revisa:

1. ~10 cooperativas, un solo servidor, sin equipo de operación 24/7.
2. Ninguna cooperativa exige hoy base de datos o servidor dedicado por contrato.
3. Una cooperativa = una entidad contable. **No hay sucursales con caja independiente** (Pregunta abierta 4 de
   ADR-0001): si las hay, `oficina` entra al modelo en DAT-01, no después.
4. Un usuario pertenece a una sola cooperativa.
5. Moneda única USD; Ecuador es una sola zona horaria sin horario de verano, y el servidor corre en ella.
6. El esquema `db/gutt_system/01-09` más sus fixes es funcionalmente completo para H1: **no se inventan tablas
   ni columnas que no estén ahí**; lo que falte se reporta antes de escribirlo.

## 17. Criterios de aceptación de H1

Del plan, más lo que estos tres ADR agregan:

- [ ] ADR-0001, ADR-0002 y ADR-0003 **aprobados por acta**, con la firma expresa de Christian Cuenca en
      ADR-0002 (y en los apartados 6, 12 y 13 de este documento). Sin aprobación por silencio.
- [ ] DAT-01 aplicado: **30 tablas** en `tecnifin_dev`, `npm run migrate` sin pendientes ni alteradas.
- [ ] Prueba de aislamiento entre dos cooperativas **sin una sola filtración** (ADR-0002, pruebas 1-8).
- [ ] Partida doble cuadrada dentro de cada tenant.
- [ ] Catálogos regulatorios sembrados y **leídos de la tabla**, no del código (ADR-0003, pruebas 6 y 7).
- [ ] Fábrica de datos de dos cooperativas, usable por todos los módulos.
- [ ] `npm test` de TECNIFIN en verde en CI; `npm test` de **GUTT_SYSTEM sigue en verde (55 pruebas)**: prueba
      de que el legado no se tocó.
- [ ] Línea base de rendimiento registrada en este documento (apartado 13).
- [ ] Este documento y ARQ-02 aprobados en el acta del **30-oct-2026**.

## 18. Preguntas abiertas

Ninguna se decide en ingeniería. Listadas aquí para el acta; el detalle está en cada ADR.

**Para Christian Cuenca** (Infraestructura y Seguridad, cl. 6.3):

1. **RPO/RTO y restauración por cooperativa** — ADR-0002 §PA1. *Bloquea la aprobación de ADR-0002 y el
   apartado 12.*
2. **Volumen y retención por cooperativa** — ADR-0002 §PA2 y ADR-0003 §PA4. *Bloquea el apartado 13 y la
   decisión de particionar en DAT-01.*
3. **¿Algún cliente exige base o servidor dedicado?** — ADR-0002 §PA3.
4. **Cifrado en reposo y de respaldos; dónde viven las claves** — ADR-0002 §PA4. *Si se exige separación
   criptográfica por cooperativa, se reabre el modelo.*
5. **¿Quién más se conecta a la base productiva y con qué rol?** — ADR-0002 §PA5. *Un rol de lectura sin RLS
   forzado anula todo el apartado 6.*
6. **Acceso de soporte de personal de TECNIFIN a la cooperativa de un cliente** — ADR-0001 §PA1. *Decisión
   contractual antes que técnica; condiciona el apartado 9.*
7. **Vida del token, refresh e invalidación** — ADR-0001 §PA2.
8. **¿Imágenes (croquis, ubicación) dentro de la base o fuera?** — ADR-0003 §PA3. *Decide el tamaño del
   respaldo y la ventana de restauración.*

**Para Jorge Tuquinga** (Desarrollo / negocio):

9. **Numeración de socios y de cuentas**: ¿correlativo por cooperativa desde 1, o se conserva la numeración que
   cada cooperativa ya tiene? — ADR-0001 §PA3. *Afecta DAT-01 y MIG-01.*
10. **Sucursales**: ¿alguna cooperativa objetivo tiene más de una oficina con caja propia? — ADR-0001 §PA4.
    *Si la respuesta es sí, entra al modelo en DAT-01; después cuesta una migración.*
11. **Precisión de las tasas**: ¿dos decimales o cuatro? — ADR-0003 §PA1. *Cambia las amortizaciones y el
    criterio de paridad de M3; hay que decidir si lo ya emitido se recalcula o se congela.*
12. **Códigos de negocio visibles** (`CRED-…`, `SOL-…`, DPF): ¿su formato lo exige algún documento impreso o
    reporte a la SEPS? — ADR-0003 §PA2.

## 19. Trazabilidad

| Fuente | Uso |
|---|---|
| `C:\GUTT_SYSTEM\DOCS_SISTEMA_FINANCIERO\plan_proyecto_tecnifin.md` §0, §1, §1.1 | Alcance, calendario de H1, decisiones ya tomadas |
| `C:\TECNIFIN\CLAUDE.md` | Las 14 reglas; se citan por número, no se reescriben |
| `C:\GUTT_SYSTEM\CLAUDE.md` | Trampas regulatorias y de Windows ya pagadas |
| `C:\GUTT_SYSTEM\db\gutt_system\01-09` | Las 30 tablas: alcance de DAT-01 |
| `C:\GUTT_SYSTEM\db\gutt_system\11, 12, 13, 14` | Casos borde ya resueltos; entran como requisitos, no se redescubren |
| `C:\TECNIFIN\src\platform\postgres.js` | Capa de acceso existente sobre la que se monta `withTenant` |

## Aprobaciones

| Nombre | Rol | Fecha | Acta |
|---|---|---|---|
| | Desarrollo | | |
| Christian Cuenca | Jefe de Proyecto · Infraestructura y Seguridad | | |
| | Aceptación H1 | | |
