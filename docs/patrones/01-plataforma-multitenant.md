# Patrón 01 — plataforma multi-tenant (DAT-01)

Este documento es el **contrato de traducción** del sistema viejo (SQL Server, `dbo.*`, PascalCase) al
esquema nuevo (PostgreSQL, `tecnifin.*`, snake_case). Se escribe una vez: ningún módulo lo re-deriva.

Estado: el DDL está aplicado en `tecnifin_dev` (31 tablas, 33 políticas RLS) y probado en
`tests/aislamiento.integration.test.mjs`. Lo que sigue es lo que un ejecutor necesita para portar un endpoint.

---

## 1. Las tres reglas que no se negocian

1. **Nadie escribe `cooperativa_id = ?` a mano, ni al leer ni al insertar.** Todo acceso a datos pasa por
   `withTenant(cooperativaId, fn)` de `src/platform/tenant.js`. Al leer, el filtro lo pone la política RLS;
   al insertar, el valor lo pone el `DEFAULT` de la columna. El tenant no aparece en el código de negocio.
2. **Sin tenant fijado se ven cero filas, no todas.** Si una consulta devuelve vacío donde esperabas datos,
   lo primero que hay que mirar es si estaba dentro de `withTenant`.
3. **El esquema cambia solo por una migración** en `db/migrations/NNNN_nombre.sql`. Nunca por un script suelto
   ni por psql a mano.

---

## 2. Mapeo de nombres: viejo → nuevo

### Tablas

| SQL Server (`dbo.`) | PostgreSQL (`tecnifin.`) | SQL Server | PostgreSQL |
|---|---|---|---|
| `Cooperativas` | `cooperativas` | `ControlCaja` | `control_caja` |
| `Usuarios` | `usuarios` | `TransaccionesCaja` | `transacciones_caja` |
| `Socios` | `socios` | `Denominaciones` | `denominaciones` |
| `SocioDireccion` | `socio_direccion` | `DetalleEfectivoTransaccion` | `detalle_efectivo_transaccion` |
| `SocioConyuge` | `socio_conyuge` | `PlanCuentas` | `plan_cuentas` |
| `SocioReferencia` | `socio_referencia` | `PeriodosContables` | `periodos_contables` |
| `SocioCarga` | `socio_carga` | `AsientosContables` | `asientos_contables` |
| `SocioUbicacionMapa` | `socio_ubicacion_mapa` | `DetalleAsiento` | `detalle_asiento` |
| `SocioCroquisTrabajo` | `socio_croquis_trabajo` | `AuditoriaProcesos` | `auditoria_procesos` |
| `ProductosFinancieros` | `productos_financieros` | `AuditoriaUsuarios` | `auditoria_usuarios` |
| `Cuentas` | `cuentas` | `SolicitudesCredito` | `solicitudes_credito` |
| `MovimientosCuenta` | `movimientos_cuenta` | `Creditos` | `creditos` |
| `TasasPlazoFijo` | `tasas_plazo_fijo` | `TablaAmortizacion` | `tabla_amortizacion` |
| `DepositosPlazo` | `depositos_plazo` | `RubrosCreditos` | `rubros_creditos` |
| `SecuenciaDPF` | **no existe** (ver §6) | `CalificacionCartera` | `calificacion_cartera` |

Tablas nuevas que el origen no tenía: `parametros_plataforma` y `secuencias_tenant`.

### Columnas

La regla es mecánica: `PascalCase` → `snake_case`, conservando el nombre de negocio en español.
`CooperativaId` → `cooperativa_id`, `NumeroCuenta` → `numero_cuenta`, `FechaDesembolso` → `fecha_desembolso`.
Las excepciones, que **no** son mecánicas, son estas y solo estas:

| Viejo | Nuevo | Por qué |
|---|---|---|
| `Usuarios.UsuarioId` (texto, PK global) | `usuarios.login` (texto) + `usuarios.usuario_id` (bigint) | Dos cooperativas no podían tener ambas un `admin` |
| `SolicitudesCredito.SolicitudID` (texto, PK) | `solicitudes_credito.codigo` + `solicitud_id` (bigint) | El código era único global entre cooperativas |
| `Creditos.CreditoID` (texto, PK) | `creditos.codigo` + `credito_id` (bigint) | Igual |
| `DepositosPlazo.DepositoID` (texto, PK) | `depositos_plazo.codigo` + `deposito_id` (bigint) | Igual |
| `Socios.NumeroSocio` (texto, de secuencia global) | `socios.numero_socio` (bigint) + `numero_socio_anterior` | Correlativo por cooperativa desde 1 |
| `Cuentas.NumeroCuenta` (texto, único global) | `cuentas.numero_cuenta` (bigint) + `numero_cuenta_anterior` | Igual |
| `DepositosPlazo.CuentaAhorrosRelacionada` (texto) | `depositos_plazo.cuenta_ahorros_id` (bigint, FK) | Era texto sin FK |
| `AuditoriaProcesos.UsuarioId` | `auditoria_procesos.usuario_login` (texto, **sin FK**) | Un intento con un usuario inexistente *es* el dato a registrar |
| `SocioUbicacionMapa.UbicacionMapaID` | `socio_ubicacion_mapa.ubicacion_mapa_id` | Solo grafía |

**Toda tabla de negocio lleva ahora `cooperativa_id`, incluidas las 17 que en el viejo lo heredaban por FK.**

**La clave primaria de toda tabla de negocio es `(cooperativa_id, <id>)`**, no el id solo: es el destino de las
FK compuestas y deja el índice agrupado por cooperativa, que es como lo recorre RLS.

### Tipos

| T-SQL | PostgreSQL |
|---|---|
| `INT/BIGINT IDENTITY` PK | `integer`/`bigint GENERATED ALWAYS AS IDENTITY` |
| `DECIMAL(15,2)` · `(18,2)` · `(10,2)` (dinero) | `tecnifin.dinero` (`numeric(18,2)` finito) |
| `DECIMAL(5,2)` (tasas, porcentajes) | `numeric(9,4)` |
| `BIT` | `boolean` (`1/0` **no** es `true/false` implícito en la migración) |
| `DATETIME2(0)` de un **momento** | `timestamptz(0)` |
| `DATETIME2(0)`/`NVARCHAR` de una **fecha de negocio** | `date` |
| `NVARCHAR(n)` | `varchar(n)` |
| `NVARCHAR(MAX)` | `text` |
| `NVARCHAR(15)` de un código contable | `tecnifin.codigo_contable` (dominio: `varchar(15)` de solo dígitos) |
| `VARBINARY(MAX)` | `bytea` |

### Recetas de consulta

| T-SQL | PostgreSQL |
|---|---|
| `SCOPE_IDENTITY()` | `INSERT ... RETURNING id` |
| `ISNULL(a, b)` | `COALESCE(a, b)` |
| `GETDATE()` / `SYSDATETIME()` | `now()` (momento) · `current_date` (fecha de negocio) |
| `TOP n` | `LIMIT n` |
| `a + b` (cadenas) | `a \|\| b` |
| `DATEADD(MONTH, n, f)` | `f + (n \|\| ' month')::interval` |
| `LEN(x)` | `length(x)` |
| `@parametro` | `@parametro` (igual: `bindNamed` de `src/platform/postgres.js` lo traduce a `$1`) |
| `WHERE Nombre = 'PEREZ'` (insensible por collation) | `WHERE lower(tecnifin.sin_acentos(primer_apellido)) = 'perez'` |

---

## 3. Una consulta antes y después

**Antes** (`server.js`, SQL Server, mono-cooperativa):

```sql
SELECT TOP 50 s.SocioId, s.NumeroSocio, s.PrimerApellido, c.NumeroCuenta, c.Saldo
FROM dbo.Socios s
JOIN dbo.Cuentas c ON c.SocioId = s.SocioId
WHERE s.Estado = 'ACTIVO' AND s.PrimerApellido = @apellido
```

**Después** (PostgreSQL, multi-tenant):

```js
const filas = await withTenant(cooperativaId, tx => tx.query(`
  SELECT s.socio_id, s.numero_socio, s.primer_apellido, c.numero_cuenta, c.saldo
    FROM tecnifin.socios s
    JOIN tecnifin.cuentas c ON c.cooperativa_id = s.cooperativa_id AND c.socio_id = s.socio_id
   WHERE s.estado = 'ACTIVO'
     AND lower(tecnifin.sin_acentos(s.primer_apellido)) = lower(tecnifin.sin_acentos(@apellido))
   LIMIT 50`, { apellido }));
```

Qué cambió y qué **no**:

- **No aparece `cooperativa_id = ...` en el `WHERE`.** Lo pone la política RLS. Escribirlo a mano no es un
  error de estilo: es señal de que alguien no confía en el modelo, y el `code-review` lo rechaza.
- **Sí aparece `cooperativa_id` en el `JOIN`.** No es un filtro de tenant, es el uso de la clave primaria
  compuesta `(cooperativa_id, socio_id)`: es la que está indexada y la que el motor valida en la FK.
- La búsqueda por apellido necesita `lower(sin_acentos(...))` en los **dos** lados; así usa
  `ix_socios_apellidos_busqueda`. Sin eso funciona, pero barre la tabla.

---

## 4. Cómo se usa `withTenant`

```js
import { withTenant } from '../platform/tenant.js';

export async function listarSocios(cooperativaId, apellido) {
  return withTenant(cooperativaId, async tx => {
    const socios = await tx.query('SELECT ... FROM tecnifin.socios WHERE ...', { apellido });
    await tx.query('INSERT INTO tecnifin.auditoria_procesos ...', { ... });
    return socios.rows;            // todo dentro de UNA transacción
  });
}
```

- Para endpoints, `cooperativaId` debe salir del claim `coop` del JWT **verificado** (ADR-0001).
  **Nunca** del cuerpo, la ruta, la query o una cabecera que pretenda elegir tenant. Este contrato está
  pendiente de implementación y pruebas en APP-01; la validación de entero de `withTenant` no autentica.
- `withTenant` abre la transacción, ejecuta `set_config('app.cooperativa_id', …, true)` —que es `SET LOCAL`
  parametrizado— y pasa el cliente ya marcado. Al COMMIT o ROLLBACK el valor desaparece y la conexión vuelve
  limpia al pool.
- Todo lo que hace `fn` está en la misma transacción: si algo falla, no queda un asiento sin su movimiento.
- Los flujos de plataforma que ya abrieron una transacción pueden entregarla como tercer argumento a
  `withTenant(cooperativaId, fn, tx)`. Es la excepción usada por `altaCooperativa`: fila de plataforma y
  catálogos confirman o revierten juntos, sin abrir una transacción anidada.
- **Nunca usar `db.query` directo** para datos de negocio: no tiene tenant y devuelve cero filas.
- `crearWithTenant(db)` existe para pruebas y procesos con su propio pool.

**Límite de seguridad (ALTO 1, 22-sep-2026):** el rol de aplicación puede cambiar el parámetro de sesión
con SQL arbitrario; RLS no prueba que el contexto proceda de `withTenant`. `bindNamed` separa valores del SQL,
no autoriza el texto. La [adenda ADR-0002](../adr/0002-aislamiento-de-datos.md#adenda-22-sep-2026--alto-1-confianza-en-la-fijación-del-tenant)
documenta la opción 1 provisional de Jorge, pendiente de revisión expresa de Christian antes de producción.
La higiene impide nuevas fijaciones directas en código; sus excepciones SQL/pruebas están enumeradas.
APP-01 implementó JWT, detección y alerta; el patrón y sus límites están en
`03-autenticacion-y-plataforma.md`. Los procesos
internos de alta/semillas y la demo usan IDs confiables de plataforma: no son autorización para aceptar
un tenant de una petición. La prueba de caracterización ALTO 1 documenta el riesgo, no su corrección.

---

## 5. Las claves foráneas son compuestas

Todo hijo referencia a su padre con `(cooperativa_id, padre_id)`:

```sql
CONSTRAINT fk_cuentas_socio FOREIGN KEY (cooperativa_id, socio_id)
  REFERENCES tecnifin.socios (cooperativa_id, socio_id)
```

Esto reemplaza a las funciones escalares en `CHECK` de `12_fix_consistencia_cooperativa.sql`, que en
PostgreSQL no son portables. Consecuencias para quien escribe código:

- Un `INSERT` de un hijo **no** pasa `cooperativa_id`: lo pone el `DEFAULT tecnifin.cooperativa_actual()`
  que instala `aplicar_rls`. Fuera de `withTenant` ese valor es NULL y la fila se rechaza.
- Un `JOIN` al padre sí incluye `cooperativa_id` en la condición (ver §3): es su clave primaria.
- Si creás una tabla nueva, su clave primaria es `(cooperativa_id, <id>)` y así sirve de destino a las FK
  compuestas de sus hijos. No hace falta un `UNIQUE` aparte.

---

## 6. Numeración: un solo generador

Decisión de Jorge, **2026-09-20**: los socios y las cuentas se numeran **por cooperativa, desde 1**. No se
conserva la numeración del sistema anterior; ese número, si existe, va a `numero_socio_anterior` /
`numero_cuenta_anterior` y solo lo usa la migración.

```sql
-- Ni el tenant ni el correlativo se pasan: los dos son DEFAULT de la columna.
INSERT INTO tecnifin.socios (tipo_persona, identificacion, primer_nombre, ...)
VALUES ('SOCIO', @identificacion, @nombre, ...)
RETURNING socio_id, numero_socio
```

- `tecnifin.siguiente_numero(nombre)` incrementa `secuencias_tenant` de forma atómica y **sin huecos**: toma
  el bloqueo de fila hasta el COMMIT, y si la transacción aborta el contador vuelve atrás con ella (una
  `SEQUENCE` de PostgreSQL dejaría hueco, y un hueco en la numeración de socios es un hallazgo de auditoría).
- `socios.numero_socio` y `cuentas.numero_cuenta` ya tienen ese generador como `DEFAULT`: nadie puede
  inventarse un número por descuido. Para los códigos visibles se llama a mano:
  `siguiente_numero('credito')`, `'solicitud'`, `'dpf_AAAAMM'`.
- El contador **solo avanza de uno en uno**, y lo exige un trigger: un `UPDATE` que intente retrocederlo
  falla con `23514`, aunque lo ejecute el dueño del esquema.
- **No existe `secuencia_dpf`.** El correlativo `DPF-AAAAMM-NNNN` se arma con
  `siguiente_numero('dpf_' || to_char(now(),'YYYYMM'))`. Una segunda implementación del mismo mecanismo
  violaría la regla 13.
- Fuera de `withTenant` la función falla (`42501`): nunca inventa un número.

---

## 7. Contabilidad

- **Códigos de cuenta: dígitos sin puntos.** El tipo es el dominio `tecnifin.codigo_contable`, que lleva la
  regla de formato en **un solo lugar**; toda columna de código contable lo usa. `'2.1.03.05'` es rechazado
  por el motor (`23514`). Las fórmulas regulatorias seleccionan por **prefijo numérico**
  (`codigo LIKE '14%'` acotado a `1401..1428`), nunca por parecido de nombre.
- **`{14}` es cartera neta** e incluye `1499` (provisiones, activo de saldo acreedor). Para morosidad se suma
  `1401..1428`.
- **Las bandas de antigüedad se leen de `plan_cuentas`**, por familia. Nunca una tabla de bandas en JS.
- **Partida doble: la hace cumplir el motor.** Un trigger de restricción diferido verifica al COMMIT que
  `sum(D) = sum(H)` por asiento. Podés insertar las líneas de a una; el asiento descuadrado no llega a
  existir. Error `23514` con el texto "Asiento N descuadrado".
- **No se contabiliza contra una cuenta agrupadora** (`es_agrupador = true`): error `23514`.
- **`detalle_asiento.socio_id` acepta NULL** (asientos agregados de cierre). Poner `0` rompe la FK.

---

## 8. Qué probar en cada módulo

Mínimo, sobre la fábrica de `tests/fixtures/cooperativas.mjs` (dos cooperativas con datos equivalentes):

1. **Aislamiento de lectura:** el endpoint con el tenant A no devuelve ni una fila de B.
2. **Aislamiento de escritura:** intentar escribir con el `cooperativa_id` de B desde el tenant A → `42501`.
3. **Padre ajeno:** colgar un registro de un padre de la otra cooperativa → `23503`.
4. **Sin tenant:** la misma consulta fuera de `withTenant` → 0 filas, nunca el universo.
5. **Concurrencia:** si el módulo genera números, N altas paralelas sin duplicados ni huecos.
6. **En dinero** (créditos, cartera, contabilidad): paridad numérica contra SQL Server antes de aceptar.

**Una migración que agregue una tabla tiene que llamar a `SELECT tecnifin.aplicar_rls('tecnifin.<tabla>')`.**
No es una convención que haya que recordar: `tools/migrate.mjs` ejecuta `tecnifin.verificar_invariantes()`
después de **cada** migración y dentro de su transacción, así que una tabla sin `cooperativa_id`, sin RLS,
sin FORCE, sin política o con una FK sin índice **no llega a existir**. La prueba de aislamiento llama a esa
misma función, para que el CI lo diga también.
La misma función revisa raíces particionadas (`relkind = 'p'`) e impide reintroducir columnas monetarias como
`numeric(18,2)` crudo: todos los importes usan `tecnifin.dinero`, que rechaza `NaN` e infinitos.

Para una tabla de plataforma (que no pertenece a ninguna cooperativa) se usa
`tecnifin.aplicar_rls_plataforma('tecnifin.<tabla>', '<expresión de lectura>')`, que además deja el
comentario que la exime de llevar `cooperativa_id`. Hoy solo la usan `cooperativas` y
`parametros_plataforma`. **No hay tablas sin FORCE.**

---

## 9. Códigos de error que vas a ver

| Código | Qué pasó |
|---|---|
| `42501` | Escribiste con el tenant de otro (WITH CHECK), o sin tenant, o pediste un permiso que el rol de la aplicación no tiene (DDL, `UPDATE`/`DELETE` sobre auditoría, `siguiente_numero` fuera de `withTenant`) |
| `23503` | FK compuesta: el padre no existe **en esa cooperativa** |
| `23505` | Único por tenant: código, login, identificación o número repetido dentro de la cooperativa |
| `23514` | `CHECK`: código contable punteado, asiento descuadrado, cuenta agrupadora, estado inválido, contador que no avanza de uno en uno |
| 0 filas donde esperabas datos | Casi siempre: consulta fuera de `withTenant` |
