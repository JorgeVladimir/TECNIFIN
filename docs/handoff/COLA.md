# Cola de trabajo (en orden; cada unidad termina en `npm run verificar` verde)

| # | Unidad | Perfil de Codex | Encargo |
|---|---|---|---|
| 1 | ~~Revisión cruzada de DAT-01/02~~ **HECHA 20-sep 22:19**: 3 ALTO, 4 MEDIO (informe: `revision-cruzada-dat01-02-informe.md`) | `revision` (Astra) | `encargos/revision-cruzada-dat01-02.md` |
| 2a | ~~Corregir ALTO 2-3 y MEDIO 4-7~~ **HECHA 21-sep**: migración 0014, 51 pruebas | `ejecutor-dinero` (Sol, high) | `encargos/correcciones-revision-dat01-02.md` |
| 2b | **ALTO 1: el tenant depende de un parámetro de sesión que `tecnifin_app` puede cambiar** — decisión de diseño (ADR-0002); requiere arquitecto y aviso a Christian | `arquitecto` (Astra, high) | por redactar |
| 3 | APP-01 · patrón: autenticación (JWT), usuarios y roles por cooperativa, auditoría, configuración por tenant | `arquitecto` (Astra, `high`) | por redactar tras #2 |
| 4 | APP-01 · resto de endpoints de plataforma con el patrón de #3 | `ejecutor` (Terra) | por redactar tras #3 |
| 5 | M1 · socios y cuentas: patrón (primeros 2-3 endpoints) | `arquitecto` | por redactar |

Bloqueos que no son técnicos están en `PENDIENTES_USUARIO.md`. No se empieza una unidad que dependa de una pregunta abierta.
