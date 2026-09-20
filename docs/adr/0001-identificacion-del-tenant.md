# ADR-0001: identificación del tenant

- **Estado:** propuesta
- **Entregable:** ARQ-01 (hito H1, acta 30-oct-2026)
- **Capas afectadas:** aplicación / base de datos / infraestructura y seguridad
- **Revisión requerida:** Desarrollo, y además Infraestructura y Seguridad (Christian Cuenca): toca aislamiento
  y seguridad (cláusula 6.3 del contrato: nunca se aprueba por silencio)
- **Fecha del borrador:** 2026-09-20 · **Autor:** arquitectura TECNIFIN

## Contexto y requisitos

TECNIFIN es un core bancario para ~10 cooperativas de ahorro y crédito en un solo servidor PostgreSQL 18.
El tenant es la **cooperativa**, no el usuario ni la sucursal. Antes de decidir *cómo se aísla* (ADR-0002)
hay que decidir *cómo se sabe de qué cooperativa es cada petición y cada fila*.

Punto de partida: el esquema renombrado de `C:\GUTT_SYSTEM\db\gutt_system\01-09`, que ya tiene la raíz
`dbo.Cooperativas (CooperativaId INT IDENTITY PRIMARY KEY)` y propaga `CooperativaId` a 12 tablas.

Requisitos:

1. El tenant se resuelve **una vez por petición** y nadie lo vuelve a pasar a mano (regla 1 de `CLAUDE.md`).
2. Un usuario autenticado no puede elegir el tenant que quiere leer: el tenant es una propiedad de su
   identidad, no un parámetro de entrada.
3. El valor del tenant tiene que poder llegar hasta la sesión de base de datos, porque ADR-0002 propone
   Row Level Security y una política RLS solo puede leer el estado de la sesión, no el del proceso Node.
4. Debe soportar el caso de soporte (personal de TECNIFIN operando sobre la cooperativa de un cliente)
   sin volverlo la ruta por defecto.

### Hallazgos del esquema viejo que este ADR tiene que resolver

Verificados en los archivos, no supuestos:

| Hallazgo | Evidencia | Por qué rompe multi-tenencia |
|---|---|---|
| `Usuarios.UsuarioId NVARCHAR(20)` es **PK global** | `01_cooperativas_usuarios.sql:48` | Dos cooperativas no pueden tener ambas un usuario `admin` o `caja1`. El identificador del usuario se vuelve un recurso compartido entre clientes |
| `Cuentas.NumeroCuenta NVARCHAR(20) NOT NULL UNIQUE` es **único global** | `03_cuentas_productos.sql:88` | La numeración de cuentas de una cooperativa puede colisionar con la de otra y el error revela que la otra existe |
| `Seq_NumeroSocio` es una **secuencia global** | `02_socios.sql:57` | El `NumeroSocio` de la cooperativa A filtra cuántos socios lleva registrados el conjunto de todas las cooperativas |
| `UC_ControlCaja_Usuario_Fecha UNIQUE (UsuarioId, Fecha)` | `14_fix_fk_usuario_faltantes.sql:47` | Correcto hoy solo porque `UsuarioId` es global; deja de serlo si el usuario pasa a ser por cooperativa |
| `SolicitudID` / `CreditoID` / `DepositoID` son PK de texto (`NVARCHAR(50)`/`(20)`) generadas por la aplicación | `04_creditos.sql:18,52` · `06_caja.sql:43` | Sin `CooperativaId` en la clave, la unicidad del código de crédito es global y su generación es una carrera entre cooperativas |
| 17 de las 30 tablas de `01-09` **no llevan `CooperativaId`**: lo heredan por FK | ver inventario en ADR-0003 | Una política RLS no puede filtrar por una columna que no existe en la tabla |

## Opciones evaluadas

### Cómo se identifica el tenant en la petición

| Opción | Cómo funciona | Evaluación |
|---|---|---|
| **A. Claim en el JWT** (recomendada) | El login resuelve el usuario contra `Usuarios`, que ya lleva `CooperativaId`; el token emitido incluye `coop`. Cada petición trae el tenant firmado | El cliente no puede alterarlo sin invalidar la firma. Una sola fuente. No agrega infraestructura. Cambiar de tenant exige re-autenticarse, que es exactamente lo que se quiere |
| B. Subdominio (`coopx.tecnifin.com`) | El host resuelve el tenant | Bonito para la marca, pero exige DNS y certificado por cooperativa antes de poder desarrollar, y el host lo controla el cliente: hay que validarlo igual contra el token. Duplica la fuente de verdad |
| C. Parámetro en la ruta (`/api/:coop/socios`) | El tenant viaja en la URL | El cliente **elige** el tenant en cada llamada; basta un olvido de validación para tener una fuga. Ensucia todas las rutas. Rechazada por el requisito 2 |
| D. Cabecera `X-Cooperativa` | Igual que C con otro envoltorio | Mismos defectos que C, además invisible en los logs de acceso por defecto |

### Cómo llega el tenant a la base de datos

| Opción | Evaluación |
|---|---|
| **A. `SET LOCAL app.cooperativa_id` dentro de una transacción, vía `withTenant()`** (recomendada) | Es lo que una política RLS puede leer (`current_setting('app.cooperativa_id', true)`). `LOCAL` acota el valor a la transacción: al hacer COMMIT/ROLLBACK el valor desaparece y la conexión vuelve limpia al pool |
| B. `SET` (sin `LOCAL`) al tomar la conexión del pool | **Rechazada.** Si un camino de error devuelve la conexión sin limpiarla, la siguiente petición hereda el tenant anterior. Es una fuga silenciosa entre cooperativas, el fallo exacto que H1 debe impedir |
| C. Una conexión/pool por cooperativa | Multiplica conexiones por 10 y exige resolver el pool antes de saber quién es el usuario. Se evalúa en ADR-0002 junto con base-por-cooperativa |
| D. Pasar `CooperativaId` como parámetro de cada consulta, sin RLS | Es el modelo del sistema viejo. Funciona hasta el primer `WHERE` olvidado — y `11_prueba_aislamiento_multicooperativa.sql` ya demostró ese olvido con datos reales (sección 5 del script) |

## Decisión y justificación

1. **El tenant es la cooperativa.** Su identificador es `cooperativa_id integer`, la PK de `cooperativas`.
   Es interno: no aparece en URLs, ni en respuestas de la API, ni en documentos impresos. Para lo visible
   (portales, reportes, correspondencia) `cooperativas` lleva un `codigo` corto y estable, independiente
   del entero.
2. **El tenant se toma del claim `coop` del JWT**, emitido en el login a partir de `usuarios.cooperativa_id`.
   Ningún endpoint acepta el tenant por ruta, query o cabecera. El middleware que valida el token lo
   deposita en el contexto de la petición.
3. **Todo acceso a datos pasa por `withTenant(cooperativaId, fn)`** en `src/platform/`, que abre la
   transacción, ejecuta `SET LOCAL app.cooperativa_id = $1` y corre `fn` con el cliente ya marcado.
   Se apoya en `transaction()` de `src/platform/postgres.js`, que ya garantiza BEGIN/COMMIT/ROLLBACK y la
   devolución del cliente al pool. **Nadie escribe `cooperativa_id = ?` a mano** (regla 1 y 13).
   Una consulta fuera de `withTenant` no debe devolver filas: sin el GUC fijado, la política de ADR-0002
   no calza y el resultado es vacío, no "todo".
4. **La unicidad de negocio se vuelve unicidad por tenant.** Se corrigen los cinco hallazgos de arriba:
   - `usuarios`: PK subrogada `bigint`; el nombre de acceso pasa a `UNIQUE (cooperativa_id, login)`.
   - `cuentas`: `UNIQUE (cooperativa_id, numero_cuenta)` en lugar del único global.
   - numeración de socios: por cooperativa, no con una secuencia compartida (ver "Pregunta abierta 3").
   - `control_caja`: `UNIQUE (cooperativa_id, usuario_id, fecha)`.
   - `solicitudes_credito`, `creditos`, `depositos_plazo`: el código de negocio pasa a
     `UNIQUE (cooperativa_id, codigo)`; la PK se decide en ADR-0003.
5. **El tenant es inmutable en la fila.** Ninguna operación de negocio cambia `cooperativa_id` de un
   registro existente; mover datos entre cooperativas no es una función del producto.
6. **`cooperativas` es la única tabla sin tenant propio** (su PK *es* el tenant). Los catálogos que hoy
   no lo llevan se resuelven en ADR-0003: o se les agrega, o se declaran globales explícitamente.

## Consecuencias y riesgos

**Se vuelve más fácil:** auditar quién puede ver qué (una sola pregunta: ¿de dónde salió el `coop` del
token?); escribir los módulos (el tenant no aparece en las firmas de las funciones de negocio); probar el
aislamiento (basta emitir dos tokens y correr el mismo endpoint).

**Se vuelve más difícil / hay que pagar:**

- Un endpoint que legítimamente cruza cooperativas (consolidado de TECNIFIN, tablero interno) **no puede**
  usar la ruta normal: necesita un camino aparte, explícito y auditado. No existe en H1.
- La migración de datos reales (MIG-01, fase 3) tiene que asignar `cooperativa_id` a cada fila de
  `SQLGUTPATATE`, que es mono-cooperativa: todo va a la COAC 20 de Febrero. Es mecánico, pero hay que
  verificar que ninguna fila quede sin tenant.
- Cambiar `usuarios` a PK subrogada rompe todas las FK que hoy apuntan a `UsuarioId NVARCHAR(20)`
  (`socios.UsuarioRegistroId`, `transacciones_caja`, `movimientos_cuenta`, `asientos_contables`,
  `control_caja`, `depositos_plazo` x2, `tasas_plazo_fijo`). Es trabajo de DAT-01, no una sorpresa.
- **Riesgo alto:** una consulta que se ejecute con el pool crudo (`db.query`) en vez de `withTenant`
  no tiene el GUC fijado. Mitigación: la política RLS se escribe de modo que sin GUC no devuelva filas,
  y una prueba de higiene busca usos de `db.query` fuera de `src/platform/`.
- **Riesgo medio:** el claim `coop` de un token emitido antes de desactivar una cooperativa sigue siendo
  válido hasta que expire. Mitigación: vida corta del token y verificación de `cooperativas.activa` en el
  middleware, no solo en el login.

## Pruebas requeridas y criterio de aceptación

| # | Prueba | Criterio |
|---|---|---|
| 1 | Dos cooperativas con datos equivalentes (fábrica de `tests/fixtures/`). Token de la coop A consulta socios, cuentas, créditos, asientos | 0 filas de la coop B en cualquier respuesta |
| 2 | Petición con `coop` manipulado en el payload del JWT sin re-firmar | 401, y el intento queda en auditoría |
| 3 | Endpoint llamado con `?cooperativaId=` o `X-Cooperativa` de otra cooperativa | El parámetro se ignora por completo; el resultado es idéntico al del tenant del token |
| 4 | Consulta ejecutada sin `withTenant` sobre una tabla de negocio | Devuelve 0 filas (no el universo) |
| 5 | `withTenant(A)` y `withTenant(B)` concurrentes sobre el mismo pool, 200 iteraciones alternadas | Ninguna transacción ve el tenant de la otra: el `SET LOCAL` no se filtra entre conexiones reutilizadas |
| 6 | Crear en la coop B un usuario con el mismo login, una cuenta con el mismo número y un código de crédito ya usados en la coop A | Las tres operaciones tienen éxito |
| 7 | `UPDATE` que intente cambiar `cooperativa_id` de una fila existente | Rechazado |

Criterio de aceptación: las 7 en verde en CI, sobre `tecnifin_dev`, con las dos cooperativas de la fábrica
de datos. La prueba 1 es la portación de `11_prueba_aislamiento_multicooperativa.sql`.

## Preguntas abiertas

- **PREGUNTA ABIERTA 1 (Christian) — acceso de soporte.** ¿Puede personal de TECNIFIN operar dentro de la
  cooperativa de un cliente? Si sí: ¿con un usuario nominal creado dentro de esa cooperativa (auditable,
  revocable por el cliente) o con un rol de plataforma que puede cambiar de tenant? La propuesta técnica es
  la primera — no hay rol capaz de cruzar tenants — pero es una decisión contractual con el cliente, no de
  arquitectura. Afecta ADR-0002 y el modelo IAM de ARQ-01.
- **PREGUNTA ABIERTA 2 (Christian) — vida del token y cierre de sesión.** Duración del JWT, si hay refresh
  y si un cambio de rol o la baja de una cooperativa deben invalidar tokens ya emitidos. Afecta la
  mitigación del riesgo medio de arriba.
- **PREGUNTA ABIERTA 3 (Jorge / negocio) — numeración de socios y de cuentas.** ¿El número de socio y el
  número de cuenta son correlativos **por cooperativa** empezando en 1, o conservan la numeración que cada
  cooperativa ya tiene en su sistema actual? Lo segundo obliga a que la migración fije el punto de partida
  de cada secuencia por cooperativa. Afecta DAT-01 y MIG-01.
- **PREGUNTA ABIERTA 4 (Jorge / negocio) — sucursales.** ¿Alguna cooperativa objetivo tiene más de una
  oficina con caja propia? Si la respuesta es sí, `oficina` es una dimensión que conviene meter en el
  modelo ahora y no después; hoy el esquema viejo no la tiene. No cambia el tenant, pero sí las claves
  de `control_caja` y la numeración.

## Aprobaciones

| Nombre | Rol | Fecha | Acta |
|---|---|---|---|
| | Desarrollo | | |
| Christian Cuenca | Jefe de Proyecto · Infraestructura y Seguridad | | |
