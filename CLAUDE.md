# TECNIFIN

Core bancario **multi-tenant** para cooperativas de ahorro y crédito reguladas por la **SEPS** (Ecuador).
PostgreSQL · Node.js. Denominación principal **TECNIFIN S.A.S.**, alterna **GUTT COMPANY S.A.S.**

## Quién manda aquí

El plan, el calendario, los agentes, las skills y el tablero viven en **`C:\GUTT_SYSTEM`** (orquestador y
fuente del conocimiento del sistema viejo). Este repo solo contiene el producto. No re-derivar decisiones:
leer el plan (`C:\GUTT_SYSTEM\DOCS_SISTEMA_FINANCIERO\plan_proyecto_tecnifin.md`) y `docs/adr/`.
El sistema vigente (GUTT_SYSTEM, SQL Server `SQLGUTPATATE`, `server.js`) **no se toca desde aquí**.

## Comandos

```bash
npm install            # una vez
npm run db:init        # crea rol y base LOCALES (usa TECNIFIN_PG_ADMIN_PASSWORD de .env)
npm run migrate        # estado; sale con 1 si hay pendientes
npm run migrate:apply  # aplica lo pendiente, en orden, transaccional, con SHA-256
npm test               # unitarias + higiene (las reglas de abajo, comprobadas con código)
```

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
11. **Datos de demo aparte de los reales.** Datos reales solo por migración controlada (MIG-01), ensayada
    primero sobre una restauración del respaldo.
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
aceptado por acta el **30-oct-2026**.
