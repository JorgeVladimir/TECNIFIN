# Patron 04 — socios y cuentas (M1)

Fija como se porta un modulo de negocio sobre el nucleo de APP-01. Lo repite el resto de M1 y sirve de
modelo para M2 (caja), M3 (creditos) y M4 (plazo fijo).

## 1. Los endpoints de referencia

| Endpoint | Rol | Efecto y auditoria |
|---|---|---|
| `POST /api/socios` | Atencion: `SUPER_USER`, `ADMIN`, `MANAGER`, `CREDIT_OFFICER`, `TELLER` | Alta con direccion, conyuge, referencias y cargas; `auditoria_procesos` SOCIOS/CREAR |
| `GET /api/socios?q=` | Atencion | Busqueda por numero, identificacion (prefijo) o nombre/apellido sin acentos; maximo 20 |
| `GET /api/socios/:numero` | Atencion | Ficha con direccion y cuentas; `CONSULTA_SOCIO` |
| `POST /api/socios/:numero/cuentas` | Atencion | Apertura; un solo certificado de aportacion vigente; `auditoria_procesos` AHORROS/ABRIR |

`MEMBER` (el propio socio) no usa estas rutas: entra por el canal en linea, que es otra superficie.

## 2. Reglas que se repiten

1. **Autenticador comun** (`src/platform/autenticacion.js`): `conRoles(token, contexto, ROLES, CONCEPTO, op)`.
   Nada de volver a escribir verificacion de JWT, withTenant o lectura de identidad.
2. **Identificador externo = numero por cooperativa** (`numero_socio`, `numero_cuenta`). `socio_id` y
   `cuenta_id` son internos: no entran por la URL ni salen en respuestas.
3. **Entrada validada en un solo lugar** (`datosAlta`): cada campo tiene tipo y largo; los nombres de columna
   del INSERT salen de objetos escritos en el codigo, nunca de la entrada; los valores van por parametro.
4. **Identificacion ecuatoriana** (`src/platform/identificacion.js`): cedula por modulo 10 con provincia y tercer
   digito; RUC natural = cedula + establecimiento != 000; RUC de sociedad (6/9) solo estructura, porque el SRI
   emitio RUC que no cumplen el modulo 11; pasaporte alfanumerico de 5 a 20.
5. **Dinero como texto** (`'0.00'`), tal como lo entrega `numeric(18,2)`; nunca `Number`/`FLOAT`.
6. **Fechas como texto ISO desde SQL** (`fecha::text`): `toISOString()` sobre un `date` corre el dia segun la zona.
7. **Busqueda de personas**: `lower(sin_acentos(...)) LIKE`, con `%`, `_` y `\` de la entrada escapados.
8. **Auditoria**: `auditoria_procesos` para cambios de entidades de negocio (procesos permitidos por el CHECK:
   CREDITOS, CAJA, AHORROS, PLAZO_FIJO, CONTABILIDAD, SOCIOS, SEGURIDAD, REPORTES_SEPS);
   `auditoria_usuarios` para consultas y denegaciones.
9. **Errores**: validacion -> 400 lanzado (revierte); duplicado -> 409; inexistente -> 404 devuelto como
   `{ error }`; denegacion -> 403 devuelta para que la auditoria confirme.
10. **Enrutador por modulo** en `src/app.js` (`rutasSocios`): devuelve `undefined` si la ruta no es suya.
    `responder()` devuelve `true`.

## 3. Lo que NO se porto del sistema anterior (y por que)

| Sistema anterior | TECNIFIN |
|---|---|
| `POST /api/socios/registrar` sin autenticacion | Exige JWT y rol de atencion |
| Devolvia el codigo de activacion en la respuesta | El codigo del canal en linea se emite en su propio flujo, nunca en la respuesta del alta |
| PIN del socio en claro en dos tablas | PA6: solo `activacion_banca_linea.pin_hash`; columnas `pin` eliminadas (0017) |
| Fotos de cedula escritas en disco (`uploads/`) | `socio_documento_excepcion` guarda la imagen en la base (bytea), con RLS |
| El login del socio creaba cuentas como efecto colateral | La apertura es una operacion explicita y auditada |
| Saldos como `FLOAT` | `numeric(18,2)` entregado como texto |

## 4. Endpoints de M1 que repiten este patron

| Sistema anterior | Destino |
|---|---|
| `POST /api/socios/update-profile`, `update-report-profile` | `PUT /api/socios/:numero` (datos de contacto y perfil) |
| `POST /api/socios/guardar-mapa`, `guardar-croquis` | `PUT /api/socios/:numero/ubicacion` (bytea en `socio_ubicacion_mapa`) |
| `GET /api/socios/consultas`, `siguiente-numero` | Cubiertos por la busqueda; el numero lo asigna la base |
| `GET /api/ahorros/resumen`, `/:cuentaId/movimientos` | `GET /api/cuentas/:numero` y `/movimientos` |
| `POST /api/socios/verificar-email`, `aceptar-terminos`, `/api/auth/socio-login` | Canal del socio (banca en linea): superficie propia, con `activacion_banca_linea` |
