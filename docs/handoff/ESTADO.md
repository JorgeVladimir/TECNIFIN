# Estado del proyecto (se actualiza al cerrar cada unidad de trabajo)

**Modo:** RESERVA — Claude Code ha llegado al ~90 % del limite semanal (88 % semanal / 89 % de sesion a las 20:53; reinicia el jueves 24-sep 11:59). Codex continua solo; Claude solo orquesta con el minimo de tokens.
**Actualizado:** 2026-09-20 21:00 · **Fase:** 1 (arquitectura y núcleo multi-tenant) · **Hito H1:** modelo de BD multi-tenant, acta el 30-oct-2026.

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

## Cola nocturna de Codex (20-sep)
- El limite semanal de Codex **no** se reinicio a las 21:09: el propio Codex indica **22:08** (smoke de las 21:14 fallo por limite de uso).
- Un proceso independiente de Claude (`node tools/codex-cola-nocturna.mjs 22:12`, lanzado desde `C:\GUTT_SYSTEM`) corre a las **22:12**: smoke y, si sale bien, la revision cruzada de DAT-01/02 (perfil `revision`).
  Resultado: `var/codex/RESUMEN.md` (y el informe completo en `var/codex/revision-cruzada-dat01-02.md`). Si el equipo se apaga o suspende antes de esa hora, el proceso se pierde: repetirlo a mano.
- **Retomar con Codex a mano** (abrir Codex en `C:\TECNIFIN` y pegar): `Lee AGENTS.md, docs/handoff/ESTADO.md y docs/handoff/COLA.md. Ejecuta la primera unidad pendiente de la cola siguiendo tu rol de docs/roles/, cierra con npm run verificar y entrega un informe de maximo 25 lineas.`
- Limites de autonomia de Codex hasta el jueves 24-sep 11:59 (mientras Claude esta en Reserva): puede ejecutar la cola en orden 1, 2 y 3; **se detiene** ante un hallazgo ALTO sin resolver, una suite en rojo, o una PREGUNTA ABIERTA de `PENDIENTES_USUARIO.md` que bloquee la unidad. Trabajo de codigo siempre en ramas `wip/`, sin fusionar en `main` ni hacer `git push`.
