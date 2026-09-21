# Encargo: revisión cruzada de DAT-01 y DAT-02

**Rol:** `docs/roles/revisor.md` · **Perfil:** `revision` (GPT-6-Astra, razonamiento `xhigh`) · **Solo lectura:** no modifiques archivos del repo; escribe el informe en `var/codex/revision-dat01-02.md`.

## Contexto
DAT-01 y DAT-02 (migraciones `db/migrations/0001`-`0013`, `src/platform/`, `tests/`) los escribió Claude Code. Tú eres la segunda mirada. Commit de referencia: `97adaef`.

## Qué revisar (en este orden)
1. **Aislamiento.** ¿Hay alguna tabla de negocio donde una cooperativa pueda leer, escribir o referenciar filas de otra? Revisa políticas RLS (`USING` y `WITH CHECK`), `FORCE`, la segunda política de `tecnifin_admin`, claves foráneas compuestas, funciones `SECURITY DEFINER`, `withTenant` (uso de `SET LOCAL`) y el rol `tecnifin_app`.
2. **Migraciones.** Orden, idempotencia, que `tecnifin.verificar_invariantes()` haga lo que dice, y que una migración futura que olvide `aplicar_rls` falle.
3. **Dinero y contabilidad.** Tipos, redondeos, el trigger de partida doble (¿qué se cuela? el agente ya documentó que un asiento sin líneas no dispara).
4. **Cartera y semillas.** Bandas SEPS, provisiones, `es_agrupador` derivado, y que ninguna semilla contenga nombres de personas o de entidades.
5. **Secretos y datos reales** (regla 11): nada de credenciales, nada que identifique a una cooperativa concreta.

## Cómo
Lee primero `AGENTS.md`, `CLAUDE.md`, `docs/adr/0002-aislamiento-de-datos.md`, `docs/adr/0003-modelo-y-nomenclatura.md` y `docs/patrones/`. Corre `npm run verificar`. Intenta romper el aislamiento con una consulta concreta (pruébala contra `tecnifin_dev`, sin modificar datos permanentes).

## Entrega (máx. 25 líneas)
Hallazgos ordenados por gravedad (ALTO / MEDIO / BAJO), cada uno con `archivo:línea`, qué pasa y cómo reproducirlo. Si no hay hallazgos altos, dilo y lista qué intentaste. Al final: cuánto tardó y una nota de cuánto pareció consumir (para calibrar la matriz de modelos).
