# Estado del proyecto (se actualiza al cerrar cada unidad de trabajo)

**Modo:** RESERVA — Claude Code ha llegado al ~90 % del limite semanal (88 % semanal / 89 % de sesion a las 20:53; reinicia el jueves 24-sep 11:59). Codex continua solo; Claude solo orquesta con el minimo de tokens.
**Actualizado:** 2026-09-22 · **Fase:** 1 (arquitectura y núcleo multi-tenant) · **Hito H1:** modelo de BD multi-tenant, acta el 30-oct-2026.

## Hecho (último commit verde: `97adaef`, 44 pruebas, 13 migraciones)
- Fase 0: proyecto, reglas 1-14, pruebas de higiene, CI verde en GitHub (ejecución #1 sobre `953ee54`).
- DAT-01: 31 tablas multi-tenant, RLS `FORCE`, `withTenant`, roles `tecnifin_admin`/`tecnifin_app`, numeración por cooperativa desde 1.
- DAT-02: cartera SEPS, solvencia, tasas de crédito, banca en línea; semillas del Catálogo Único (994 cuentas, por cooperativa); base `tecnifin_demo`. 40 tablas, 42 políticas.
- Borradores ADR-0001/0002/0003 y ARQ-01 (estado «propuesta»).
- Traspaso Claude/Codex: `AGENTS.md`, `docs/roles/`, `docs/handoff/`, `npm run estado`, `npm run verificar`, agentes de Codex en `.codex/agents/`.
- Correcciones mecánicas DAT-01/02: ALTO 2-3 y MEDIO 4-7 cerrados con migración 0014 y 51 pruebas; ALTO 1 sigue reservado a ADR-0002.

## En curso
Unidad 2b entregada en `wip/alto1-fijacion-tenant`, pendiente de revisión expresa de Christian y commit del
orquestador. La siguiente unidad es redactar el encargo #3 (APP-01), respetando las preguntas abiertas.

## Riesgos vivos
- ADR-0001/0002/0003 sin revisar por Christian (ADR-0002 no se aprueba por silencio).
- ALTO 1: decisión provisional de Jorge (22-sep), opción 1 con controles; SQL arbitrario aún permite acceso cruzado. JWT y detección/alerta pendientes APP-01; no habilita producción.
- `socios.pin` y `usuarios.pin` en claro (PA6, seguridad).
- Push a GitHub: lo hace Jorge; hay 4 commits locales sin subir en este repo.

## Cola nocturna de Codex (20-sep)
- El limite semanal de Codex **no** se reinicio a las 21:09: el propio Codex indica **22:08** (smoke de las 21:14 fallo por limite de uso).
- Un proceso independiente de Claude (`node tools/codex-cola-nocturna.mjs 22:12`, lanzado desde `C:\GUTT_SYSTEM`) corre a las **22:12**: smoke y, si sale bien, la revision cruzada de DAT-01/02 (perfil `revision`).
  Resultado: `var/codex/RESUMEN.md` (y el informe completo en `var/codex/revision-cruzada-dat01-02.md`). Si el equipo se apaga o suspende antes de esa hora, el proceso se pierde: repetirlo a mano.
- **Retomar con Codex a mano** (abrir Codex en `C:\TECNIFIN` y pegar): `Lee AGENTS.md, docs/handoff/ESTADO.md y docs/handoff/COLA.md. Ejecuta la primera unidad pendiente de la cola siguiendo tu rol de docs/roles/, cierra con npm run verificar y entrega un informe de maximo 25 lineas.`
- Limites de autonomia de Codex hasta el jueves 24-sep 11:59 (mientras Claude esta en Reserva): puede ejecutar la cola en orden 1, 2 y 3; **se detiene** ante un hallazgo ALTO sin resolver, una suite en rojo, o una PREGUNTA ABIERTA de `PENDIENTES_USUARIO.md` que bloquee la unidad. Trabajo de codigo siempre en ramas `wip/`, sin fusionar en `main` ni hacer `git push`.

## 21-sep
- Unidad 2a cerrada y fusionada en main (adaab61). Aprendizajes: el sandbox de Codex no escribe en .git (rama y commit los hace codex-delegar); el migrador hashea con LF (git en Windows convierte a CRLF al cambiar de rama; corregido con .gitattributes y normalizacion). Revision con Astra xhigh gasto la ventana de 5 h en 7 min: usar high y partir por areas.
- Sigue abierta la unidad 2b (ALTO 1: tenant por parametro de sesion) y 3 (APP-01), ambas esperan decision.

## 22-sep
- Unidad 2b entregada: adenda ADR-0002 (opción 1 provisional de Jorge; Christian pendiente), patrón y pendientes actualizados, higiene de fijación y caracterización adversaria A→B con rollback. `npm run verificar`: 54/54, 14 migraciones, 0 pendientes; sin cambio de esquema, commit a cargo del orquestador. ALTO 1 sigue como riesgo residual, no como corrección aprobada.
