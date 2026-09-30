# Cola de trabajo (en orden; cada unidad termina en `npm run verificar` verde)

| # | Unidad | Perfil de Codex | Encargo |
|---|---|---|---|
| 1 | ~~Revisión cruzada de DAT-01/02~~ **HECHA 20-sep 22:19**: 3 ALTO, 4 MEDIO (informe: `revision-cruzada-dat01-02-informe.md`) | `revision` (Astra) | `encargos/revision-cruzada-dat01-02.md` |
| 2a | ~~Corregir ALTO 2-3 y MEDIO 4-7~~ **HECHA 21-sep**: migración 0014, 51 pruebas | `ejecutor-dinero` (Sol, high) | `encargos/correcciones-revision-dat01-02.md` |
| 2b | **ENTREGADA 22-sep**: adenda ALTO 1 + higiene y prueba del riesgo residual, 54 pruebas; opción 1 provisional de Jorge, pendiente de revisión expresa de Christian y commit del orquestador | `arquitecto` (Astra, high) | `encargos/alto1-fijacion-tenant.md` |
| 3 | ~~APP-01 patrón~~ **FUSIONADA 29-sep** APP-01 · 3 endpoints, migración 0015, patrón 03 y 62 pruebas | `arquitecto` | `encargos/app01-autenticacion-usuarios-auditoria.md` |
| 4 | ~~APP-01 resto~~ **HECHA 29-sep (Claude)**: salud, perfil, cambiar-clave, alta/rol/activo, restablecer clave; 71 pruebas. Recuperación por correo + SMTP **HECHA 30-sep** (0016, 78 pruebas) | — | patrón 03 §5b |
| 5 | ~~M1 patrón~~ **HECHA 30-sep**: 4 endpoints, 87 pruebas | Claude | patrón 04 |
| 6 | ~~M1 resto~~ **HECHA 30-sep**: 92 pruebas | Claude | patrón 04 §4 |
| 7 | ~~M2 caja~~ **HECHA 30-sep**: 102 pruebas | Claude | patrón 05 |
| 8 | Canal del socio: login, activación, transferencias (decidir autenticación con Christian) | Claude | patrones 03 y 05 |
| 9 | M3 créditos partes 1 y 2 **HECHAS 1-oct** (117 pruebas) | Claude | patrón 06 |
| 10 | ~~M4 plazo fijo~~ **HECHA 1-oct** (124 pruebas) | Claude | patrón 07 |
| 11 | ~~M6 cartera SEPS~~ **HECHA 1-oct** (131 pruebas) | Claude | patrón 08 |
| 12 | **SIGUIENTE** M5 contabilidad (balance, mayor) y M7 reportes SEPS | Claude | por redactar |

Bloqueos que no son técnicos están en `PENDIENTES_USUARIO.md`. No se empieza una unidad que dependa de una pregunta abierta.

El encargo #3 incorporó los controles de la adenda ALTO 1: tenant desde JWT verificado y detección/alerta de
desvíos con cobertura probada. No corrige la capacidad de SQL arbitrario de cambiar y restaurar el tenant
dentro de una sentencia ni aprueba el riesgo para producción; Christian debe decidirlo expresamente.
