# Cola de trabajo (en orden; cada unidad termina en `npm run verificar` verde)

| # | Unidad | Perfil de Codex | Encargo |
|---|---|---|---|
| 1 | ~~Revisión cruzada de DAT-01/02~~ **HECHA 20-sep 22:19**: 3 ALTO, 4 MEDIO (informe: `revision-cruzada-dat01-02-informe.md`) | `revision` (Astra) | `encargos/revision-cruzada-dat01-02.md` |
| 2a | ~~Corregir ALTO 2-3 y MEDIO 4-7~~ **HECHA 21-sep**: migración 0014, 51 pruebas | `ejecutor-dinero` (Sol, high) | `encargos/correcciones-revision-dat01-02.md` |
| 2b | **ENTREGADA 22-sep**: adenda ALTO 1 + higiene y prueba del riesgo residual, 54 pruebas; opción 1 provisional de Jorge, pendiente de revisión expresa de Christian y commit del orquestador | `arquitecto` (Astra, high) | `encargos/alto1-fijacion-tenant.md` |
| 3 | **EN CURSO 22-sep** APP-01 · patrón: autenticación (JWT), usuarios y roles por cooperativa, auditoría, configuración por tenant | `ejecutor-dinero` (Sol, high: Astra se reserva por límite semanal) | `encargos/app01-autenticacion-usuarios-auditoria.md` |
| 4 | APP-01 · resto de endpoints de plataforma con el patrón de #3 | `ejecutor` (Terra) | por redactar tras #3 |
| 5 | M1 · socios y cuentas: patrón (primeros 2-3 endpoints) | `arquitecto` | por redactar |

Bloqueos que no son técnicos están en `PENDIENTES_USUARIO.md`. No se empieza una unidad que dependa de una pregunta abierta.

El encargo #3 debe incorporar los controles pendientes de la adenda ALTO 1 de ADR-0002: tenant desde JWT
verificado y detección/alerta de desvíos con cobertura probada. La entrega de #2b no corrige la capacidad de
SQL arbitrario de cambiar el tenant ni aprueba el riesgo para producción; Christian debe decidirlo expresamente.
