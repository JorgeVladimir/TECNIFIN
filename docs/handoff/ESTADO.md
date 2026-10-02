# Estado del proyecto (se actualiza al cerrar cada unidad de trabajo)

**Modo:** NORMAL — Claude orquesta y ejecuta; Codex disponible para unidades repetibles.
**Actualizado:** 2026-09-29 · **Fase:** 1 (arquitectura y núcleo multi-tenant) · **Entregable 1:** revisión el 15-oct-2026 (sistema y web, sin dominio) · **Hito H1:** confirmación del Jefe de Proyecto el 31-oct-2026 (contrato consolidado v2, 29-sep).

## Hecho (último commit verde en main: ver git log; 158 pruebas, 27 migraciones)
- Fase 0: proyecto, reglas 1-14, pruebas de higiene, CI verde en GitHub (ejecución #1 sobre `953ee54`).
- DAT-01: 31 tablas multi-tenant, RLS `FORCE`, `withTenant`, roles `tecnifin_admin`/`tecnifin_app`, numeración por cooperativa desde 1.
- DAT-02: cartera SEPS, solvencia, tasas de crédito, banca en línea; semillas del Catálogo Único (994 cuentas, por cooperativa); base `tecnifin_demo`. 40 tablas, 42 políticas.
- Borradores ADR-0001/0002/0003 y ARQ-01 (estado «propuesta»).
- Traspaso Claude/Codex: `AGENTS.md`, `docs/roles/`, `docs/handoff/`, `npm run estado`, `npm run verificar`, agentes de Codex en `.codex/agents/`.
- Correcciones mecánicas DAT-01/02: ALTO 2-3 y MEDIO 4-7 cerrados con migración 0014 y 51 pruebas; ALTO 1 sigue reservado a ADR-0002.
- APP-01 patrón: login JWT, usuarios por rol/tenant, auditoría, configuración por cooperativa y detección/alerta de desvío; migración 0015 y patrón 03 (fusionado en main el 29-sep).
- M6 cierre mensual (2-oct): POST /api/cartera/cierre-mensual corre devengo y proceso de cartera al mismo corte en una sola transaccion (todo o nada); los cuerpos de ambos se extrajeron (ejecutarProceso, aplicarDevengoEn) para reutilizarlos; 190 pruebas.
- Endurecimiento (2-oct, Fase 5 adelantada): bloqueo de cuenta por intentos fallidos parametrizable por cooperativa, sin enumeracion de usuarios, alerta al bloquear, desbloqueo al restablecer clave; cabeceras de seguridad en toda respuesta; migracion 0031; 6 pruebas (189).
- Operacion (2-oct, regla 10): tools/respaldo.mjs (pg_dump, restauracion en base temporal con conteos y auditoria, poda), deploy/programar-respaldo.ps1 (tarea diaria SYSTEM) y tools/preflight.mjs (BLOQUEA/AVISO/OK). 183 pruebas.
- tools/auditoria.mjs (npm run auditoria, 1-oct): auditoria contable de solo lectura por cooperativa, 10 controles del mayor contra sus auxiliares mas los del esquema; la usan la prueba de la demo y la de rubros (que comprueba que detecta un saldo alterado). 181 pruebas.
- Regla 13 (1-oct): el lado del dinero de un cobro (caja o cuenta) vive en src/modules/caja/origen.js y lo usan cobro, abono y recuperacion de castigados (cartera tenia su copia); las lineas del asiento inverso, en platform/contabilidad.js (lineasInversas), usadas por anulacion de pagos y reversos de cartera y devengo.
- M3 rubros por cuota (1-oct): configuracion por cooperativa (FIJO, % del monto, % del saldo) con su cuenta; se generan al desembolsar, se cobran a su cuenta, quedan sin efecto en las futuras de una cancelacion, el abono recalcula los de saldo y la anulacion los devuelve; migracion 0030; 4 pruebas (178 en total).
- M6 devengo de intereses (1-oct): lineal por dias del periodo, a 1603/5104 si el credito devenga y a suspenso 7109/7209 si no; control del mayor antes de aplicar, reversion exacta; el cobro descarga 1603 y baja el suspenso; el castigo reversa lo devengado; la anulacion de pagos ahora invierte el asiento original; migracion 0029 (2 tablas, 48 en total); 6 pruebas.
- M3 abono extraordinario a capital (1-oct): REDUCIR_CUOTA o REDUCIR_PLAZO desde la cuota siguiente a la en curso, asiento por diferencia de capital en cada subcuenta, anulacion exacta con foto antes/despues; la reversion de cartera ahora tambien compara el capital; migracion 0028; 8 pruebas. Corregida prueba de M3 que dependia de que el mes tuviera 30 dias.
- Demo alineada con M3-M6 (1-oct): cuotas con cuenta_capital por banda, segmento, cuotas pagadas asentadas, DPF con base 365; el mayor de cartera cuadra con las cuotas (antes 9000 vs 6111.74). Base tecnifin_demo recreada.
- M4 pago periódico de intereses DPF (1-oct): MENSUAL/TRIMESTRAL, por diferencia de acumulados (la suma cuadra con el total del plazo), idempotente; liquidación y cancelación descuentan lo pagado; migración 0027.
- M6 recuperación de castigados (1-oct): a ingreso 560405, baja el control de orden, tope en lo castigado; migración 0026.
- M6 castigo de cartera (1-oct): contra provisión constituida, control en cuentas de orden 710310/7203xx; 3 pruebas.
- M3 mora y cancelación anticipada (1-oct): interés de mora a 510430, cancelación sin penalización con interés corrido, anulación que devuelve cada cuota a su estado real; cobro separado en cobro.js; migración 0025; 5 pruebas.
- M7 reportes SEPS (1-oct): ESF, PERLAS, B11, UAF, situación general y solvencia regulatoria desde el mismo libro y motor de cartera, en centavos y BigInt; 9 pruebas.
- M5 contabilidad (1-oct): libro diario paginado, balance de comprobación jerárquico con saldo por naturaleza, mayor con saldo acumulado, asiento manual y cierre de período; 6 pruebas.
- M6 cartera SEPS (1-oct): clasificación por cuota (por vencer, no devenga, vencida) con bandas del plan, calificación y provisión, simulación, aplicación con control contable al centavo, reversión exacta cuota por cuota; migraciones 0022-0024; 7 pruebas.
- M4 plazo fijo (1-oct): tramos, simulación, apertura con débito real, liquidación, cancelación con penalización, renovación; parámetros de retención y base por cooperativa; migración 0021; 7 pruebas.
- M3 créditos parte 2 (1-oct): pago de cuotas por caja o débito a cuenta, capital desde su banda e interés por segmento, anulación por supervisor en orden inverso; migración 0020; 5 pruebas.
- M3 créditos parte 1 (1-oct): líneas, simulación, solicitud, decisión con separación de funciones, desembolso con capital por banda de plazo remanente y descuentos configurables; contabilidad común (src/platform/contabilidad.js); migración 0019; 10 pruebas.
- M2 caja (30-sep): apertura, depósito/retiro con asiento, anulación por supervisor, cierre con cuadre; FOR UPDATE probado con 10 retiros simultáneos; migración 0018; 10 pruebas.
- M1 resto (30-sep): perfil con auditoría por campo, estado del socio, ubicación y croquis en bytea, cuenta y movimientos; log de errores 500 con id de solicitud.
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
