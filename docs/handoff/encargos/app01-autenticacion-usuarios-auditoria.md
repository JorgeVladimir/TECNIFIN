# Encargo: APP-01 · patrón de autenticación, usuarios/roles por cooperativa, auditoría y configuración por tenant

**Rol:** `docs/roles/arquitecto.md` · **Perfil:** `arquitecto` (GPT-6-Astra, `high`) · **Requiere:** la unidad 2 de `COLA.md` cerrada (revisión cruzada sin hallazgos ALTO abiertos).

## Objetivo
Fijar el patrón del núcleo de aplicación (entregable APP-01 del contrato, vence el 30-nov-2026) con sus **primeros 2-3 endpoints** y su prueba:
inicio de sesión con JWT, usuarios y roles **por cooperativa** (nunca globales), registro de auditoría de cada acción sensible y lectura de la configuración del tenant.
El resto de endpoints de plataforma los repite después el ejecutor con tu patrón.

## Fuentes
- Reglas y decisiones: `AGENTS.md`, `CLAUDE.md`, `docs/adr/0001` (tenant en el token) y `0002` (aislamiento), `docs/patrones/01` y `02`.
- Sistema anterior (solo lectura, `C:\GUTT_SYSTEM`): `Grep` de `/api/auth`, `login` y roles en `server.js`; tablas `usuarios`, `auditoria_usuarios`, `parametros_plataforma` en las migraciones actuales. **No leas `server.js` entero.**

## Restricciones (no negociables)
1. El `cooperativa_id` sale del **token** y nunca del cuerpo de la petición; toda consulta pasa por `withTenant`.
2. PIN/clave con hash (`src/platform/credenciales.js`); `socios.pin` y `usuarios.pin` en claro siguen sin decidir (PA6 en `PENDIENTES_USUARIO.md`): **no lo resuelvas por tu cuenta**, deja el punto de extensión y anótalo.
3. Vida del token, refresh e invalidación son una **PREGUNTA ABIERTA de Christian**: hazlos parámetros configurables por cooperativa y **no fijes valores definitivos**.
4. Un solo backend (regla 2): el servidor vive en `src/`; sin `server.x.js` paralelos. Archivos ≤ 500 líneas.
5. Sin secretos en el repo: la clave de firma sale de `.env` (agrega la variable a `.env.example` sin valor).

## Criterio de aceptación
- `npm run verificar` en verde, con pruebas nuevas de: login correcto/incorrecto, un usuario de la cooperativa A **no** puede operar sobre la B con el token de A, la auditoría registra el acceso, y la configuración devuelta es la del tenant del token.
- `docs/patrones/03-autenticacion-y-plataforma.md` escrito (mapeo, antes/después, qué probar): sin él el ejecutor no arranca.
- Commit local en la rama `wip/app01-patron`; **no** fusionar en `main`. Informe de ≤ 25 líneas con las decisiones que tomaste y las PREGUNTAS ABIERTAS nuevas.
