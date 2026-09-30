# Estado del proyecto (se actualiza al cerrar cada unidad de trabajo)

**Modo:** NORMAL — Claude orquesta y ejecuta; Codex disponible para unidades repetibles.
**Actualizado:** 2026-09-29 · **Fase:** 1 (arquitectura y núcleo multi-tenant) · **Entregable 1:** revisión el 15-oct-2026 (sistema y web, sin dominio) · **Hito H1:** confirmación del Jefe de Proyecto el 31-oct-2026 (contrato consolidado v2, 29-sep).

## Hecho (último commit verde en main: ver git log; 87 pruebas, 17 migraciones)
- Fase 0: proyecto, reglas 1-14, pruebas de higiene, CI verde en GitHub (ejecución #1 sobre `953ee54`).
- DAT-01: 31 tablas multi-tenant, RLS `FORCE`, `withTenant`, roles `tecnifin_admin`/`tecnifin_app`, numeración por cooperativa desde 1.
- DAT-02: cartera SEPS, solvencia, tasas de crédito, banca en línea; semillas del Catálogo Único (994 cuentas, por cooperativa); base `tecnifin_demo`. 40 tablas, 42 políticas.
- Borradores ADR-0001/0002/0003 y ARQ-01 (estado «propuesta»).
- Traspaso Claude/Codex: `AGENTS.md`, `docs/roles/`, `docs/handoff/`, `npm run estado`, `npm run verificar`, agentes de Codex en `.codex/agents/`.
- Correcciones mecánicas DAT-01/02: ALTO 2-3 y MEDIO 4-7 cerrados con migración 0014 y 51 pruebas; ALTO 1 sigue reservado a ADR-0002.
- APP-01 patrón: login JWT, usuarios por rol/tenant, auditoría, configuración por cooperativa y detección/alerta de desvío; migración 0015 y patrón 03 (fusionado en main el 29-sep).
- M1 patrón (30-sep): alta, búsqueda, ficha y apertura de cuenta; autenticador común (src/platform/autenticacion.js); PA6 provisional (0017, sin PIN en claro); 9 pruebas.
- APP-01 recuperación de clave por correo y diagnóstico SMTP (30-sep, migración 0016, 7 pruebas).
- Entregable 1 (30-sep): informe de avance, diccionario DAT-01 generado del catálogo y sitio web de 4 páginas.
- APP-01 resto (29-sep): salud, perfil, cambio de clave, alta/rol/activo y restablecimiento de clave de usuarios; clave temporal obliga a cambiarla; 9 pruebas nuevas.

## En curso
Unidad 3 APP-01 entregada en `wip/app01-patron`, pendiente de revisión y commit del orquestador. La siguiente
unidad es redactar y ejecutar el resto de endpoints de plataforma (#4) repitiendo el patrón 03.

## Riesgos vivos
- ADR-0001/0002/0003 sin revisar por Christian (ADR-0002 no se aprueba por silencio).
- ALTO 1: opción 1 con controles implementados; SQL arbitrario aún puede cambiar y restaurar el tenant dentro de una sentencia sin ser detectado. Christian debe aceptar el riesgo; no habilita producción.
- `socios.pin` y `usuarios.pin` en claro (PA6, seguridad).
- Restablecer una clave no invalida los JWT ya emitidos hasta su exp (pregunta abierta de invalidación, Christian).
- Push a GitHub: lo hace Jorge; hay commits locales sin subir en este repo.

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
- Unidad 3 APP-01 entregada: tres endpoints de patrón, JWT desde identidad verificada, tabla `parametros_cooperativa`, auditoría, control/alerta de desvío y documento patrón 03. `npm run verificar`: 62/62, 15 migraciones, 0 pendientes; commit a cargo del orquestador. Vida/refresh/invalidación JWT y PA6 siguen abiertas.
