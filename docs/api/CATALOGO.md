# Catálogo de la API de TECNIFIN

Todas las rutas responden JSON. Salvo las marcadas **PÚBLICO**, exigen `Authorization: Bearer <JWT>` (obtenido en
`POST /api/auth/login`) y operan **solo** sobre la cooperativa del token. Sin token responden 401; con un rol que no
corresponde, 403. El detalle de reglas, asientos y casos borde está en el patrón indicado (`docs/patrones/`).

`tests/api-catalogo.test.mjs` lee esta tabla y comprueba contra la aplicación real que **cada ruta existe** y que
las no públicas **rechazan la llamada sin token**. Si se agrega un endpoint, se agrega aquí; si una fila no tiene
ruta detrás, la prueba falla.

**Roles** (grupos): **TODOS** cualquier usuario autenticado · **ATENCIÓN** SUPER_USER, ADMIN, MANAGER,
CREDIT_OFFICER, TELLER · **CAJA** SUPER_USER, ADMIN, MANAGER, TELLER · **ANÁLISIS** SUPER_USER, ADMIN, MANAGER,
CREDIT_OFFICER · **SUPERVISOR** SUPER_USER, ADMIN, MANAGER · **ADMIN** SUPER_USER, ADMIN.

## Plataforma (patrón 03)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `POST` | `/api/auth/login` | PÚBLICO | Cooperativa, usuario y clave → JWT. Bloqueo por intentos (§7) |
| `GET` | `/api/health` | PÚBLICO | Salud del servicio y de la base |
| `POST` | `/api/auth/olvide-clave` | PÚBLICO | Envía un código de recuperación por correo (respuesta igual exista o no) |
| `POST` | `/api/auth/restablecer-con-codigo` | PÚBLICO | Código + clave nueva |
| `GET` | `/api/perfil` | TODOS | Datos del usuario del token |
| `POST` | `/api/auth/cambiar-clave` | TODOS | Clave actual + nueva |
| `GET` | `/api/configuracion` | TODOS | Marca y parámetros visibles de la cooperativa |
| `GET` | `/api/usuarios` | ADMIN | Usuarios de la cooperativa |
| `POST` | `/api/usuarios` | ADMIN | Alta con clave temporal |
| `PUT` | `/api/usuarios/demo.usuario` | ADMIN | Rol, activo, correo |
| `POST` | `/api/usuarios/demo.usuario/restablecer-clave` | ADMIN | Clave temporal nueva; desbloquea |
| `GET` | `/api/admin/correo` | ADMIN | Diagnóstico SMTP (sin secretos) |
| `POST` | `/api/admin/correo/prueba` | ADMIN | Envía un correo de prueba |

## M1 Socios y cuentas (patrón 04)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/socios?q=` | ATENCIÓN | Búsqueda por nombre, identificación o número |
| `POST` | `/api/socios` | ATENCIÓN | Alta de socio |
| `GET` | `/api/socios/1` | ATENCIÓN | Ficha con cuentas |
| `PUT` | `/api/socios/1` | ATENCIÓN | Actualiza el perfil (auditoría por campo) |
| `POST` | `/api/socios/1/cuentas` | ATENCIÓN | Abre una cuenta de un producto |
| `PUT` | `/api/socios/1/estado` | SUPERVISOR | ACTIVO / INACTIVO / … con motivo |
| `POST` | `/api/socios/1/ubicacion` | ATENCIÓN | Ubicación y croquis |
| `GET` | `/api/cuentas/1` | ATENCIÓN | Saldo y datos de una cuenta |
| `GET` | `/api/cuentas/1/movimientos` | ATENCIÓN | Movimientos paginados (`desde`, `hasta`, `pagina`) |

## M2 Caja (patrón 05)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/caja` | CAJA | Estado de la caja del día del usuario |
| `POST` | `/api/caja/apertura` | CAJA | Abre la caja con saldo inicial |
| `POST` | `/api/caja/transacciones` | CAJA | Depósito o retiro con comprobante y asiento |
| `POST` | `/api/caja/transacciones/1/anular` | SUPERVISOR | Anulación por un supervisor distinto |
| `POST` | `/api/caja/cierre` | CAJA | Cierre con cuadre de efectivo |

## M3 Créditos (patrón 06)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/creditos/lineas` | ANÁLISIS | Líneas vigentes |
| `POST` | `/api/creditos/simulacion` | ANÁLISIS | Tabla francesa con rubros por cuota y costo total |
| `POST` | `/api/creditos/solicitudes` | ANÁLISIS | Solicitud `SOL-` |
| `GET` | `/api/creditos/solicitudes/SOL-000001` | ANÁLISIS | Solicitud con su plan |
| `POST` | `/api/creditos/solicitudes/SOL-000001/decision` | SUPERVISOR | Aprobar o rechazar (separación de funciones) |
| `POST` | `/api/creditos/solicitudes/SOL-000001/desembolso` | SUPERVISOR | Crédito `CRED-`, tabla, rubros y asiento |
| `GET` | `/api/creditos/CRED-000001` | ANÁLISIS | Crédito con su tabla |
| `POST` | `/api/creditos/CRED-000001/pagos` | CAJA | Pago de n cuotas (caja o cuenta), con mora y rubros |
| `GET` | `/api/creditos/CRED-000001/cancelacion` | CAJA | Liquidación para cancelar hoy |
| `POST` | `/api/creditos/CRED-000001/cancelacion` | CAJA | Cancelación anticipada sin penalización |
| `POST` | `/api/creditos/CRED-000001/abonos/simulacion` | CAJA | Simula un abono a capital |
| `POST` | `/api/creditos/CRED-000001/abonos` | CAJA | Abono a capital (reduce cuota o plazo) |
| `POST` | `/api/creditos/pagos/1/anular` | SUPERVISOR | Anula el último pago del día (asiento inverso exacto) |

## M4 Plazo fijo (patrón 07)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/dpf/tramos` | CAJA | Tramos y tasas |
| `POST` | `/api/dpf/simulacion` | CAJA | Interés, retención y neto |
| `POST` | `/api/dpf` | CAJA | Apertura con débito a la cuenta del socio |
| `GET` | `/api/dpf/DPF-202609-0001` | CAJA | Certificado |
| `POST` | `/api/dpf/DPF-202609-0001/liquidar` | CAJA | Liquidación al vencimiento |
| `POST` | `/api/dpf/DPF-202609-0001/cancelar` | SUPERVISOR | Cancelación anticipada con penalización |
| `POST` | `/api/dpf/DPF-202609-0001/renovar` | CAJA | Renovación |
| `POST` | `/api/dpf/intereses/pagos` | SUPERVISOR | Pago periódico de intereses vencidos (idempotente) |

## M5 Contabilidad (patrón 09)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/contabilidad/libro-diario` | SUPERVISOR | Asientos paginados |
| `GET` | `/api/contabilidad/balance` | SUPERVISOR | Balance de comprobación jerárquico |
| `GET` | `/api/contabilidad/mayor/110105` | SUPERVISOR | Mayor de una cuenta con saldo acumulado |
| `POST` | `/api/contabilidad/asientos` | SUPERVISOR | Asiento manual cuadrado |
| `POST` | `/api/contabilidad/periodos/2026/9/cerrar` | SUPERVISOR | Cierre de período |

## M6 Cartera SEPS (patrón 08)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/cartera/clasificacion` | ANÁLISIS | Clasificación, calificación y provisión a una fecha |
| `POST` | `/api/cartera/procesos` | ANÁLISIS | Simula; con `aplicar: true` (SUPERVISOR) aplica |
| `POST` | `/api/cartera/procesos/1/reversar` | SUPERVISOR | Reversión exacta del último proceso |
| `GET` | `/api/cartera/devengo` | ANÁLISIS | Simulación del devengo de intereses |
| `POST` | `/api/cartera/devengo` | SUPERVISOR | Aplica el devengo |
| `POST` | `/api/cartera/devengo/1/reversar` | SUPERVISOR | Reversión exacta del último devengo |
| `POST` | `/api/cartera/cierre-mensual` | SUPERVISOR | Devengo + proceso de cartera en una transacción |
| `POST` | `/api/cartera/castigos/CRED-000001` | SUPERVISOR | Castigo contra la provisión |
| `POST` | `/api/cartera/castigos/CRED-000001/recuperacion` | CAJA | Recuperación de cartera castigada |

## M7 Reportes SEPS (patrón 10)

| Método | Ruta | Roles | Qué hace |
|---|---|---|---|
| `GET` | `/api/reportes/esf` | SUPERVISOR | Estado de situación financiera |
| `GET` | `/api/reportes/perlas` | SUPERVISOR | Indicadores PERLAS |
| `GET` | `/api/reportes/b11` | SUPERVISOR | Balance B11 |
| `GET` | `/api/reportes/uaf` | SUPERVISOR | Matriz UAF del período |
| `GET` | `/api/reportes/situacion-general` | SUPERVISOR | Resumen de la cooperativa |
| `GET` | `/api/reportes/solvencia` | SUPERVISOR | Solvencia regulatoria (PTC / APR) |
