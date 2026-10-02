# deploy/ — operación (regla 10)

Se mantiene desde la Fase 0 y se prueba en cada fase. Ningún script se copia tal cual de GUTT_SYSTEM: allí
asumen SQL Server y el servicio `GuttSystemBackend`.

| Pieza | Qué hace | Estado |
|---|---|---|
| `tools/respaldo.mjs` (`npm run respaldo`) | `pg_dump` custom a `var/respaldos/`, **restaura en una base temporal**, compara las filas de cada tabla y corre la auditoría contable sobre la copia; poda a los últimos 14 (`TECNIFIN_RESPALDO_RETENER`) | **Hecho 2-oct** (prueba `respaldo.integration`) |
| `deploy/programar-respaldo.ps1` | Tarea diaria `TECNIFIN-Respaldo` (23:30, SYSTEM) que corre el respaldo; `-Instalar` / `-Quitar` como administrador | **Hecho 2-oct**; falta instalarla (Jorge, como administrador) |
| `tools/auditoria.mjs` (`npm run auditoria`) | Mayor contra auxiliares por cooperativa y controles del esquema | **Hecho 1-oct** |
| `tools/preflight.mjs` (`npm run preflight`) | Checklist: `.env`, migraciones, auditoría, respaldo de menos de 26 h, tarea programada; BLOQUEA / AVISO / OK | **Hecho 2-oct**; servicio y sitio público entran en la Fase 4 |
| `install-service.ps1` | Servicio de Windows (NSSM) con arranque automático y reinicio | Fase 4 (depende de dónde vive el servidor) |
| `docs/DESPLIEGUE.md` | Runbook: instalar, respaldar, restaurar, actualizar, revertir | Fase 4 |

**El respaldo corre como el superusuario `postgres`**: con RLS `FORCE`, el dueño del esquema no ve filas sin
cooperativa fijada y `pg_dump` fallaría. Un rol de respaldo propio con `BYPASSRLS` (y dónde viven sus claves y
las de cifrado de los respaldos) es decisión de Christian (preguntas 4 y 5 de `PENDIENTES_USUARIO.md`).

**Restaurar** un respaldo en una base nueva: `pg_restore -h 127.0.0.1 -U postgres -d <base_nueva> <archivo>.dump`
(la base debe existir y estar vacía; los roles `tecnifin_admin` y `tecnifin_app` deben existir: `npm run db:init`).
La restauración de **una sola cooperativa** sin tocar a las demás sigue abierta (RPO/RTO, Christian 1).

Reglas: archivos `.ps1` en ASCII puro; el despliegue es manual (el CI no publica).
