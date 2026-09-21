# Encargo: corregir los hallazgos MEDIO y los ALTO mecánicos de la revisión cruzada de DAT-01/02

**Rol:** `docs/roles/ejecutor.md` · **Perfil:** `ejecutor-dinero` (GPT-5.6-Sol, `high`) · **Informe de origen:** `docs/handoff/revision-cruzada-dat01-02-informe.md` (léelo completo; tiene archivo:línea y reproducción de cada hallazgo).
**Rama:** el orquestador ya creó y activó `wip/correcciones-revision`. **No** ejecutes comandos de escritura de git (tu sandbox tiene `.git` en solo lectura): edita archivos y deja el árbol en verde; el orquestador hace el commit. No fusiones ni hagas `git push`.

## Alcance (solo esto)
1. **ALTO 2** — trigger de partida doble (`db/migrations/0007_contabilidad.sql:135`): la marca de cuadre evita revalidar dentro de la misma transacción y se elude cambiando de tenant. El cuadre debe recalcularse **siempre** que cambie una línea del asiento, sin marca que lo omita.
2. **ALTO 3** — `valor > 0` admite `NaN` (`0007_contabilidad.sql:105`): rechaza `NaN`/`Infinity` en todas las columnas de dinero (dominio o CHECK común) y agrega la prueba.
3. **MEDIO 4** — `db/seeds/plan_cuentas_seps.json`, códigos 260305/260310/260320 con nombres de bancos concretos: sustituye por nombres genéricos del catálogo nacional y amplía la lista de `tests/higiene.test.mjs` (regla 11) para que esos nombres no puedan volver.
4. **MEDIO 5** — `tecnifin.verificar_invariantes()` ignora tablas particionadas (`relkind` `p`): cúbrelas, con prueba.
5. **MEDIO 6** — CHECK de `reclasificacion_cartera` (`0011_cartera_seps.sql:129`): una corrida `APLICADO` debe exigir `asiento_id` y `provision_contabilizada` coherentes; agrega la prueba.
6. **MEDIO 7** — `altaCooperativa` (`src/platform/semillas.js:141`): alta y siembra en **una** transacción; que un fallo no deje una cooperativa sin catálogos y que reintentar sea posible. Prueba de fallo a mitad.

## Fuera de alcance (NO lo toques)
- **ALTO 1** (el tenant depende de un parámetro de sesión que `tecnifin_app` puede cambiar): es una decisión de diseño de ADR-0002. No lo arregles; deja una nota en `docs/handoff/PENDIENTES_USUARIO.md`.
- Los riesgos ya documentados (PA6, PA9-PA13).

## Reglas
Las migraciones ya aplicadas **no se editan** (cambia su hash): agrega migraciones nuevas `0014+` para los cambios de esquema; los seeds y el código sí se editan. Cada migración nueva llama a `aplicar_rls` cuando cree tablas. `npm run verificar` en verde antes de cada commit; deja un archivo `docs/handoff/mensajes-commit.md` con una línea por hallazgo (para el historial).

## Entrega (máx. 25 líneas)
Por hallazgo: corregido/no, archivos, prueba que lo demuestra. Resultado final de `npm run verificar` y cuántas migraciones nuevas. Al terminar, agrega una línea a `docs/handoff/ESTADO.md` en tu rama.
