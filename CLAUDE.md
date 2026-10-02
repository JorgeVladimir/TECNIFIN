# TECNIFIN

Core bancario **multi-tenant** para cooperativas de ahorro y crédito reguladas por la **SEPS** (Ecuador).
PostgreSQL · Node.js. Denominación principal **TECNIFIN S.A.S.**, alterna **GUTT COMPANY S.A.S.**

## Quién manda aquí

El plan, el calendario, los agentes, las skills y el tablero viven en **`C:\GUTT_SYSTEM`** (orquestador y
fuente del conocimiento del sistema viejo). Este repo solo contiene el producto. No re-derivar decisiones:
leer el plan (`C:\GUTT_SYSTEM\DOCS_SISTEMA_FINANCIERO\plan_proyecto_tecnifin.md`) y `docs/adr/`.
El sistema anterior (GUTT_SYSTEM: SQL Server y `server.js`) **no se toca desde aquí**. TECNIFIN es un sistema nuevo: **nace en blanco**, sin datos de ninguna cooperativa; solo existe la base de demostración.

## Comandos

```bash
npm install            # una vez
npm run db:init        # crea los DOS roles y la base LOCALES (usa TECNIFIN_PG_ADMIN_PASSWORD, la del superusuario)
npm run migrate        # estado; sale con 1 si hay pendientes. Corre como tecnifin_admin
npm run migrate:apply  # aplica lo pendiente, en orden, transaccional, con SHA-256
npm test               # unitarias + higiene + aislamiento + semillas + demo (crean y borran sus bases)
npm run test:aislamiento  # solo la prueba de aislamiento entre dos cooperativas
npm run demo:crear     # borra y recrea la base de DEMOSTRACIÓN entera (tecnifin_demo)
npm run auditoria      # solo lectura: mayor contra auxiliares (cartera, 1603, suspenso, DPF, ahorros...) en dev y demo; sale con 1 si algo no cuadra
```

**La base de demostración es otra base.** `demo:crear` la borra y la vuelve a crear desde cero con las mismas
migraciones y los mismos dos roles; solo cambia el nombre. Para conectarse a ella se usa el mismo `.env`
cambiando **una** variable: `TECNIFIN_PG_DATABASE=tecnifin_demo`. El nombre sale de
`TECNIFIN_PG_DEMO_DATABASE` y **tiene que terminar en `_demo`**: es lo que impide que un valor mal puesto
borre la base de desarrollo o la de producción. Los usuarios de la demo solo tienen clave utilizable si
`TECNIFIN_DEMO_PASSWORD` está en `.env`; sin ella la demo se crea igual y nadie entra.

**Dos roles, y no se mezclan** (ADR-0002): `tecnifin_admin` es dueño del esquema y el único que hace DDL
(`TECNIFIN_PG_ADMIN_USER` / `TECNIFIN_PG_ADMIN_DB_PASSWORD`); `tecnifin_app` es el de la aplicación, solo
DML, no es dueño de nada y no tiene `BYPASSRLS` (`TECNIFIN_PG_USER` / `TECNIFIN_PG_PASSWORD`).
`TECNIFIN_PG_ADMIN_PASSWORD` es la clave del superusuario `postgres` y solo la usan `db:init` y las pruebas
de integración, que crean y borran su propia base.

Secretos: todo en `.env` (fuera de Git). Este archivo se commitea: **cero credenciales aquí**.

## Reglas (nacieron de los errores de GUTT_SYSTEM; `tests/higiene.test.mjs` comprueba las marcadas ✔)

1. **Multi-tenant desde el día 1**: toda tabla de negocio lleva `CooperativaId NOT NULL` + Row Level Security;
   el acceso pasa por `withTenant()`. Nadie filtra `CooperativaId` a mano. Prueba de aislamiento entre dos
   cooperativas obligatoria.
2. ✔ **Un backend, una base activa por entorno.** Prohibidos `server.x.js` paralelos.
3. ✔ **El esquema cambia solo por `tools/migrate.mjs`** (`db/migrations/NNNN_nombre.sql`). Estar commiteada no
   es estar aplicada: antes de dar por bueno un módulo, `npm run migrate` sin pendientes. Sin scripts sueltos.
4. ✔ **Un módulo por dominio** en `src/modules/<dominio>/`, archivos ≤ 500 líneas. Nunca leer un archivo
   enorme entero: `Grep` primero, luego `Read` con rango.
5. **Datos regulatorios paramétricos** (bandas SEPS, ponderaciones) en tablas, nunca hardcodeados. Cuentas por
   **prefijo numérico** del Catálogo Único, sin puntos (`'210305'`); nunca por parecido de nombre.
   Cartera en la familia `1401-1428`; `{14}` es cartera **neta** (incluye `1499`).
6. **Suite roja = no se fusiona.** Pruebas desde el primer commit y con JWT. Un test que falla por una razón
   obsoleta puede tapar un fallo real: se arregla o se borra, nunca se deja rojo.
7. ✔ **Secretos solo en `.env`**; `.env.example` sin valores; un único prefijo `TECNIFIN_*`.
8. ✔ **Raíz limpia**: logs, respaldos y cargas en `var/` (ignorado); sin `test-*.js` ni `*.log` sueltos.
9. ✔ **Identificadores TECNIFIN** (base `tecnifin_dev`/`tecnifin`, roles `tecnifin_*`, `TECNIFIN_PG_*`). El nombre
   visible es un **dato** (parámetros de la plataforma), no una constante regada por el código.
10. **Operación desde la Fase 0**: `deploy/` (servicio, respaldo, preflight, runbook) se mantiene y se prueba en
    cada fase, no al final.
11. ✔ **La base nace en blanco y la demo va aparte.** Ningún dato ni referencia a una cooperativa concreta en el repo
    (semillas, fixtures, docs). Existe `tecnifin_demo`, una base separada con datos sintéticos, solo para
    demostraciones y pruebas de funcionamiento. Si algún día una cooperativa trae datos de su sistema anterior, esa
    carga (MIG-01) es un proyecto aparte, ensayado sobre una restauración del respaldo.
12. **El CI solo prueba.** El despliegue es manual, con `preflight`. Un push a `main` no publica nada.
13. **Una sola implementación**: si un paso se repite en más de un módulo, va a `src/platform/` o a una skill
    del orquestador. Al cerrar cada módulo se busca duplicación.
14. **Un solo plan** (el del orquestador). Los agentes lo leen; no lo reinventan.

## Trampas de Windows (ya pagadas en GUTT_SYSTEM)

- Archivos `.ps1` en **ASCII puro**: PowerShell 5.1 los lee como ANSI; un acento o un guión largo en un
  comentario rompe el parseo (`MissingEndCurlyBrace`).
- `Start-Process` **con** `-RedirectStandardOutput/-RedirectStandardError` deja el proceso vivo pero sin escuchar
  el puerto. Sin redirección arranca bien.
- `Get-ScheduledTask` no ve las tareas del principal SYSTEM sin elevación: devuelve vacío en vez de fallar.
  Correr `preflight` como administrador.
- Las pruebas de integración crean y borran una base efímera con el rol `postgres`; por eso existe
  `TECNIFIN_PG_ADMIN_PASSWORD`. Nunca apuntarlas a una base con datos.

## Estado

Fase 0 (creación del proyecto) en curso. Primer hito: **H1**, modelo de base multi-tenant en PostgreSQL,
aceptado por acta el **31-oct-2026**.

**DAT-01 y DAT-02 construidos** (borrador, pendiente de acta): 14 migraciones en `db/migrations/`,
**40 tablas** (38 de negocio + 2 de plataforma) con `FORCE ROW LEVEL SECURITY` sin excepciones, **42 políticas
RLS** y 5 dominios que guardan reglas comunes (código contable, segmento, calificación, hash de secretos y
dinero finito), `withTenant()` en `src/platform/tenant.js`, alta y siembra atómicas de cooperativas en
`src/platform/semillas.js`, semillas del Catálogo Único SEPS en `db/seeds/` y base de demostración
reproducible. `npm test`: **51 pruebas en verde**.

Los dos patrones de traducción se leen antes de portar cualquier módulo y no se re-derivan:
**`docs/patrones/01-plataforma-multitenant.md`** (mapeo de nombres, consulta antes/después, `withTenant`,
qué probar) y **`docs/patrones/02-catalogos-y-demo.md`** (las 9 tablas de DAT-02, cómo se siembra una
cooperativa, las bandas SEPS leídas del plan, el proceso de cartera y la base de demostración).

Toda migración que agregue una tabla llama a `SELECT tecnifin.aplicar_rls('tecnifin.<tabla>')`.
No es una convención que haya que recordar: `migrate.mjs` corre `tecnifin.verificar_invariantes()` después
de cada migración y dentro de su transacción, así que una tabla sin tenant, sin RLS, sin `FORCE`, sin
política o con una FK sin índice **no llega a existir**.

Los ADR-0001/0002/0003 siguen en **propuesta**: Christian Cuenca no los ha revisado y ADR-0002 no se aprueba
por silencio. Tres supuestos de DAT-01 esperan respuesta de Jorge (sucursales, precisión de tasas, formato
de los códigos visibles) y cuatro preguntas quedaron abiertas en DAT-02 —la más urgente, **los PIN de
`socios` y `usuarios` siguen en claro** (PA6, seguridad: Christian)—. Todas en ADR-0003, secciones
«Supuestos pendientes» y «Preguntas abiertas que DAT-02 dejó».
