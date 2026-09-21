# Cola de trabajo (en orden; cada unidad termina en `npm run verificar` verde)

| # | Unidad | Perfil de Codex | Encargo |
|---|---|---|---|
| 1 | **Revisión cruzada de DAT-01/02** (lo escribió Claude; lo revisa otra herramienta) | `revision` (Astra, `xhigh`) | `encargos/revision-cruzada-dat01-02.md` |
| 2 | Corregir lo que salga de la revisión #1 (solo lo que el informe marque como alto/medio) | `ejecutor` (Terra) o `ejecutor-dinero` (Sol) | se redacta con el informe |
| 3 | APP-01 · patrón: autenticación (JWT), usuarios y roles por cooperativa, auditoría, configuración por tenant | `arquitecto` (Astra, `high`) | por redactar tras #2 |
| 4 | APP-01 · resto de endpoints de plataforma con el patrón de #3 | `ejecutor` (Terra) | por redactar tras #3 |
| 5 | M1 · socios y cuentas: patrón (primeros 2-3 endpoints) | `arquitecto` | por redactar |

Bloqueos que no son técnicos están en `PENDIENTES_USUARIO.md`. No se empieza una unidad que dependa de una pregunta abierta.
