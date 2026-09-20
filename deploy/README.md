# deploy/ — operación (regla 10)

Esta carpeta se mantiene desde la Fase 0. **Estado real al 2026-09-20: todavía no hay scripts**; solo la lista de lo
que debe existir antes de cerrar la Fase 4. Ningún script se copia tal cual de GUTT_SYSTEM: allí asumen SQL Server
y el servicio `GuttSystemBackend`.

| Pieza | Qué debe hacer | Referencia del sistema viejo | Fase |
|---|---|---|---|
| `backup-db.ps1` | `pg_dump` completo + verificación de restauración en una base temporal | `deploy/backup-db.ps1` | 4 |
| `install-service.ps1` | Servicio de Windows (NSSM) con arranque automático y reinicio | `deploy/install-service.ps1` | 4 |
| `preflight.ps1` | Checklist ejecutable de «listo para producción»; correr como administrador | `deploy/preflight.ps1` | 4 |
| `docs/DESPLIEGUE.md` | Runbook: instalar, respaldar, restaurar, actualizar, revertir | `deploy/DESPLIEGUE.md` | 4 |

Reglas: archivos `.ps1` en ASCII puro; el despliegue es manual (el CI no publica).
