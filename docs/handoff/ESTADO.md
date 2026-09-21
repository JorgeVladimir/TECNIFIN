# Estado del proyecto (se actualiza al cerrar cada unidad de trabajo)

**Modo:** ECONOMIA — Claude Code al 86 % del límite semanal (reinicia el jueves 24-sep 12:00); Codex con límite semanal nuevo desde ~21:09 del 20-sep.
**Actualizado:** 2026-09-20 20:30 · **Fase:** 1 (arquitectura y núcleo multi-tenant) · **Hito H1:** modelo de BD multi-tenant, acta el 30-oct-2026.

## Hecho (último commit verde: `97adaef`, 44 pruebas, 13 migraciones)
- Fase 0: proyecto, reglas 1-14, pruebas de higiene, CI verde en GitHub (ejecución #1 sobre `953ee54`).
- DAT-01: 31 tablas multi-tenant, RLS `FORCE`, `withTenant`, roles `tecnifin_admin`/`tecnifin_app`, numeración por cooperativa desde 1.
- DAT-02: cartera SEPS, solvencia, tasas de crédito, banca en línea; semillas del Catálogo Único (994 cuentas, por cooperativa); base `tecnifin_demo`. 40 tablas, 42 políticas.
- Borradores ADR-0001/0002/0003 y ARQ-01 (estado «propuesta»).
- Traspaso Claude/Codex: `AGENTS.md`, `docs/roles/`, `docs/handoff/`, `npm run estado`, `npm run verificar`, agentes de Codex en `.codex/agents/`.

## En curso
Nada. La siguiente unidad es la primera de `COLA.md`.

## Riesgos vivos
- ADR-0001/0002/0003 sin revisar por Christian (ADR-0002 no se aprueba por silencio).
- `socios.pin` y `usuarios.pin` en claro (PA6, seguridad).
- Push a GitHub: lo hace Jorge; hay 4 commits locales sin subir en este repo.
