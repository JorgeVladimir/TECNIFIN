# Encargo: ALTO 1 — el tenant se fija con un parámetro de sesión que `tecnifin_app` puede cambiar

**Rol:** `docs/roles/arquitecto.md` · **Perfil:** `arquitecto` (GPT-6-Astra, `high`) · Toca aislamiento (cláusula 6.3): **decisión provisional de Jorge, requiere revisión expresa de Christian antes de producción — no la des por aprobada.**

## El hallazgo (informe: `docs/handoff/revision-cruzada-dat01-02-informe.md`, ALTO 1)
`withTenant()` fija el tenant con `SET LOCAL app.cooperativa_id = ...`. Las políticas RLS confían en ese parámetro de sesión. El rol `tecnifin_app` (el mismo con el que se conecta la aplicación) tiene permiso de ejecutar `SET` sobre su propia sesión. Quien logre ejecutar SQL arbitrario con esa conexión (p. ej. una inyección que se saltara `bindNamed`) podría cambiar el parámetro a otra cooperativa y leer o escribir sus filas.

## Qué evaluar (al menos estas opciones, con sus consecuencias)
1. **Aceptar el riesgo residual con controles compensatorios**, documentado por acta: la defensa real contra la inyección ya es `bindNamed` (parametriza toda consulta; hay prueba de que rechaza SQL suelto). El riesgo exige que la capa de aplicación ya esté comprometida. Controles: `withTenant` es el único punto que llama a `SET LOCAL` (nadie más lo hace a mano — verificar con una prueba de higiene que ningún otro archivo invoque `set_config`/`SET LOCAL app.cooperativa_id`); el valor que recibe sale siempre del token verificado (JWT), nunca de un campo del cuerpo de la petición; registro/alerta ante un cambio de tenant dentro de la misma conexión que no venga de `withTenant`.
2. **Endurecer con una función de verificación**: una función `SECURITY DEFINER`, propiedad de `tecnifin_admin`, que sea el único camino para fijar el tenant, validando algo que el propio `tecnifin_app` no pueda falsificar sin el secreto de firma de la aplicación (p. ej. un HMAC del `cooperativa_id` firmado por la capa de aplicación con una clave que la base nunca ve, o un token de sesión emitido por la propia función al autenticar). Evalúa si esto es viable con el modelo actual (no hay todavía capa de autenticación: APP-01 es la unidad siguiente) o si conviene diseñarlo junto con APP-01.
3. Cualquier otra opción real que conozcas para PostgreSQL multi-tenant por `SET LOCAL` (p. ej. roles por tenant, políticas adicionales, límites de conexión). Si la descartas, di por qué.

## Entregable
- **Adenda a `docs/adr/0002-aislamiento-de-datos.md`**: el hallazgo, las opciones evaluadas, la decisión (marca a Jorge como quien la tomó de forma provisional el 22-sep-2026) y las consecuencias. Sigue en estado **«propuesta»**: agrega una línea explícita de que falta la revisión expresa de Christian antes de producción (cláusula 6.3, no se aprueba por silencio).
- Si la decisión exige cambios de código o de esquema: impleméntalos con su prueba (p. ej. la prueba de higiene de la opción 1, o la función `SECURITY DEFINER` de la opción 2) en migración nueva `0015+`. Si es solo control de proceso, no toques el esquema — dilo en el informe.
- Actualiza `docs/handoff/PENDIENTES_USUARIO.md`: mueve el punto del ALTO 1 a «decisión provisional tomada, pendiente de aprobación expresa de Christian» con un resumen de una línea de la opción elegida.
- Cierra con `npm run verificar` en verde.

## Reglas
No ejecutes comandos de escritura de git (el orquestador ya te dejó en la rama `wip/alto1-fijacion-tenant`; el commit lo hace él tras verificar). No toques `C:\GUTT_SYSTEM`. No implementes APP-01 completo aquí — solo lo que esta decisión requiera del mecanismo de fijación de tenant. Informe final de máximo 25 líneas: opción elegida y por qué, qué cambió, resultado de `npm run verificar`, y qué queda explícitamente para que Christian confirme.
