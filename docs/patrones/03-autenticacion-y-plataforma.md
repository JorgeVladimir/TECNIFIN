# Patron 03 — autenticacion y nucleo de plataforma (APP-01)

Este documento fija el patron que el ejecutor repite en los endpoints restantes de APP-01. Complementa
`01-plataforma-multitenant.md`: no cambia el riesgo residual ni aprueba la ADR-0002 para produccion.

## 1. Los tres endpoints de referencia

| Endpoint | Autenticacion | Rol | Efecto y auditoria |
|---|---|---|---|
| `POST /api/auth/login` | Codigo publico de cooperativa + login + clave | Publico | Emite JWT; registra `LOGIN_EXITOSO`, `LOGIN_FALLIDO` o configuracion incompleta |
| `GET /api/usuarios` | Bearer JWT | Lista blanca `SUPER_USER`, `ADMIN` | Lista solo usuarios del tenant; registra consulta o denegacion |
| `GET /api/configuracion` | Bearer JWT | Cualquier usuario activo | Lee marca y parametros del tenant; registra la lectura |

El codigo HTTP vive en `src/app.js`; el proceso unico esta en `src/server.js`; la logica de negocio queda en
`src/modules/plataforma/servicio.js`. Los controladores no consultan PostgreSQL directamente.

## 2. Mapeo viejo a nuevo

| Sistema anterior | TECNIFIN |
|---|---|
| `POST /api/auth/login.php`, login global | `POST /api/auth/login`, login unico dentro de la cooperativa |
| JWT con `usuarioId` y `rol` | JWT HS256 con `sub`, `coop`, `rol`, `login`, `iss`, `aud`, `iat`, `exp`, `jti` |
| Duracion `10h` escrita en codigo | `auth.jwt_vida_segundos` en `parametros_cooperativa`, sin valor por defecto |
| Consulta directa a `Usuarios` | `withTenant` + RLS sobre `tecnifin.usuarios` |
| Auditoria dispersa | `tecnifin.auditoria_usuarios`, append-only y dentro de la transaccion sensible |
| Configuracion mezclada con constantes | `parametros_plataforma` global y `parametros_cooperativa` por tenant |

`usuarios.password_hash` se crea y verifica unicamente con `src/platform/credenciales.js`. `usuarios.pin` y
`socios.pin` siguen en claro hasta resolver PA6; no son credenciales de login y APP-01 no los migra ni los usa.

## 3. Como se resuelve el tenant

En un endpoint protegido, `cooperativa_id` sale exclusivamente del claim `coop` despues de verificar firma,
algoritmo HS256, emisor, audiencia y vigencia. Ruta, query, cuerpo y cabeceras como `X-Cooperativa` se ignoran.
La pertenencia se vuelve a comprobar contra un usuario activo y una cooperativa activa dentro de `withTenant`.

El login es la unica etapa anterior al JWT. Para desambiguar dos usuarios `admin`, recibe el **codigo publico**
de la cooperativa (`COOP-X`), nunca el `cooperativa_id`. `crearWithTenantPorCodigo` lo canoniza, permite leer
solo la cooperativa activa coincidente y, ya con su id interno, entra por `withTenant`. El id no aparece en la
URL, el cuerpo ni la respuesta.

Consulta protegida, en forma resumida:

```js
const claims = jwt.verificar(token);
return withTenant(claims.coop, async tx => {
  // comprobar usuario y cooperativa activos
  // ejecutar consulta sin WHERE cooperativa_id
  // insertar auditoria en la misma transaccion
});
```

## 4. JWT y preguntas abiertas

La clave de firma sale de `TECNIFIN_JWT_SECRET`; emisor y audiencia salen de
`TECNIFIN_JWT_ISSUER`/`TECNIFIN_JWT_AUDIENCE`. Ningun valor secreto se versiona.

La tabla `parametros_cooperativa` admite, al menos, estas claves:

- `auth.jwt_vida_segundos`: entero positivo requerido para emitir un token.
- `auth.refresh_habilitado`: configuracion reservada; APP-01 no implementa refresh.
- `auth.invalidacion_modo`: configuracion reservada; APP-01 no fija un mecanismo.

La vida, refresh e invalidacion siguen siendo PREGUNTA ABIERTA de Christian. No hay valor sembrado ni fallback
global: una cooperativa sin vigencia configurada recibe 503 y el intento queda auditado. El rol efectivo se lee
de la base en cada operacion, por lista blanca; no se autoriza usando solamente el rol incluido en el token.

## 5. Auditoria y alertas

Una accion sensible confirma junto con su fila de `auditoria_usuarios`; si la accion falla, no se deja una
auditoria que afirme que ocurrio. Los rechazos de credenciales se devuelven con un mensaje generico para no
revelar si existe la cooperativa o el usuario.

`withTenant` comprueba el contexto al entrar y salir, correlaciona solicitud, usuario, tenant, conexion y
transaccion. Si observa un cambio, revierte, marca la conexion para descarte y emite una alerta JSON externa a
la transaccion. La alerta enumera campos permitidos: nunca incluye token, clave, cuerpo ni SQL.

Este control es de deteccion parcial: SQL arbitrario que cambie a B y restaure A dentro de una sola sentencia
puede evadir la comprobacion de salida. La opcion 1 de la adenda ADR-0002 conserva ese riesgo; Christian debe
aceptarlo expresamente o exigir las opciones 2/3 antes de produccion.

Un JWT con firma invalida no aporta un tenant confiable para insertar en una tabla RLS. Se rechaza con 401 y se
envia alerta operacional sin confiar en su payload; no se usa el `coop` manipulado para escribir auditoria.

## 5b. Endpoints de plataforma ya repetidos con este patron (29-sep-2026)

| Endpoint | Rol | Auditoria |
|---|---|---|
| `GET /api/health` | Publico; solo `SELECT 1`, sin version ni datos | — |
| `GET /api/perfil` | Cualquier usuario activo, incluso con clave temporal | — |
| `POST /api/auth/cambiar-clave` | El propio usuario; 10-128 caracteres, sin contener el login | `CAMBIO_CLAVE`, `CAMBIO_CLAVE_FALLIDO` |
| `POST /api/usuarios` | `SUPER_USER`/`ADMIN`; `ADMIN` no crea `SUPER_USER` | `ALTA_USUARIO`, `ALTA_USUARIO_DENEGADO` |
| `PUT /api/usuarios/:login` | Igual; cambia `rol`/`activo`; nadie se administra a si mismo | `CAMBIO_USUARIO`, `CAMBIO_USUARIO_DENEGADO` |
| `POST /api/usuarios/:login/restablecer-clave` | Igual; `ADMIN` no toca `SUPER_USER` | `RESTABLECER_CLAVE`, `RESTABLECER_CLAVE_DENEGADO` |

Reglas nuevas que el ejecutor repite:

- **Clave temporal** (alta y restablecimiento): 16 caracteres aleatorios, se devuelve una sola vez y marca
  `requiere_cambio_pin`. Mientras siga marcada, `ejecutarAutenticado` solo deja pasar las operaciones que
  declaran `permitirCambioPendiente` (perfil y cambio de clave); el resto responde 403.
- **Desactivar** corta los tokens vigentes en la siguiente peticion, porque la identidad se relee en cada
  operacion. **Restablecer la clave NO invalida** los tokens ya emitidos hasta su `exp`: depende de la
  pregunta abierta de invalidacion (Christian).
- Validaciones de entrada (`ErrorSolicitud`, `ErrorConflicto`) se lanzan y revierten; las denegaciones se
  **devuelven** como `{ error }` para que su auditoria confirme.

### Recuperacion de clave y correo (30-sep-2026, migracion 0016)

| Endpoint | Rol | Auditoria |
|---|---|---|
| `POST /api/auth/olvide-clave` | Publico: codigo de cooperativa + usuario | `RECUPERACION_SOLICITADA`, `_SIN_ENVIO`, `_LIMITADA` |
| `POST /api/auth/restablecer-con-codigo` | Publico: cooperativa + codigo + clave nueva | `RECUPERACION_COMPLETADA`, `RECUPERACION_INVALIDA` |
| `GET /api/admin/correo` | `SUPER_USER`/`ADMIN`; configuracion sin la clave SMTP | — |
| `POST /api/admin/correo/prueba` | Igual; envia un correo de prueba | `PRUEBA_CORREO`, `PRUEBA_CORREO_FALLIDA` |

- `olvide-clave` responde **siempre 202 con el mismo cuerpo**, exista o no la cooperativa, el usuario o su correo.
- El codigo son 32 bytes aleatorios (43 caracteres); la base guarda solo su **SHA-256** en
  `recuperaciones_clave` (con RLS). Un uso; un codigo nuevo anula los anteriores; vence en
  `auth.recuperacion_minutos` (60 por defecto, maximo 1440). Maximo 3 solicitudes por usuario y hora.
- El correo sale **despues** del COMMIT. Si falla, alerta `RECUPERACION_SIN_CORREO` y la respuesta no cambia.
- `src/platform/correo.js` es la unica salida de correo: SMTP global por `TECNIFIN_SMTP_*`; errores reducidos a
  codigo, nunca el texto del servidor ni la clave. Nodemailer >= 10.0.13 (las 6.x tienen avisos de seguridad).
- `usuarios.correo` (0016) se fija en el alta o con `PUT /api/usuarios/:login`; se guarda en minusculas.

Riesgo menor conocido: la respuesta de `olvide-clave` tarda algo mas cuando el usuario existe (inserta y
envia). No revela datos en el cuerpo, pero un atacante paciente podria medirlo; mitigable con cola de envio.

Pendiente: impresora predeterminada del usuario (preferencia de interfaz; entra con la pantalla de caja).

## 6. Que debe repetir y probar el ejecutor

Cada endpoint nuevo:

1. Verifica Bearer JWT y entra por `withTenant(claims.coop)`.
2. Usa lista blanca explicita de roles cuando la operacion no sea para todo usuario autenticado.
3. No acepta ni filtra `cooperativa_id`; los `JOIN` si incluyen la clave compuesta.
4. Escribe auditoria dentro de la misma transaccion de la accion.
5. No concatena entrada en SQL; todos los valores pasan por `bindNamed`.

Pruebas minimas: credencial correcta e incorrecta; firma/`coop` manipulado; emisor, audiencia y expiracion;
token de A frente a datos de B; selector de tenant hostil en query/cabecera/cuerpo; rol permitido y denegado;
auditoria; configuracion distinta en A/B; cambio de contexto que cause rollback, alerta y descarte de conexion.

