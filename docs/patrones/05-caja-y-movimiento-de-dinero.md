# Patron 05 — caja y movimiento de dinero (M2)

Es el patron de **todo** lo que mueve dinero: lo repiten creditos (desembolso y pago de cuota), plazo fijo
(apertura y cancelacion) y transferencias. Si una operacion de dinero no sigue estas reglas, no se acepta.

## 1. Endpoints

| Endpoint | Rol | Efecto |
|---|---|---|
| `POST /api/caja/apertura` | `TELLER`, `MANAGER`, `ADMIN`, `SUPER_USER` | Abre la caja del dia (una por usuario y fecha de Ecuador); efectivo opcional verificado |
| `GET /api/caja` | Igual | Estado: apertura, ingresos, egresos, esperado, operaciones y anuladas |
| `POST /api/caja/transacciones` | Igual | `DEPOSITO` o `RETIRO` a una cuenta; devuelve el comprobante |
| `POST /api/caja/transacciones/:comprobante/anular` | `MANAGER`, `ADMIN`, `SUPER_USER`, **distinto** de quien cobro | Reverso con asiento contrario |
| `POST /api/caja/cierre` | Caja | Cuadre: esperado frente a contado, diferencia registrada |

## 2. Las reglas del dinero

1. **Sin coma flotante.** El monto entra como texto (`montoValido`: positivo, hasta 2 decimales, hasta 15
   enteros); sumas, restas y comparaciones las hace PostgreSQL en `numeric` (`mismoValor`, `saldo + @monto`).
   Sale como texto (`'150.25'`).
2. **Bloqueo antes de leer.** `SELECT ... FOR UPDATE OF c` sobre la cuenta, y la caja del cajero tambien
   `FOR UPDATE`. El `UPDATE ... WHERE saldo - @monto >= 0 RETURNING saldo` es la ultima barrera: probado con 10
   retiros simultaneos (pasan exactamente los que caben).
3. **Todo en una transaccion:** comprobante (`numero_comprobante` por cooperativa desde 1), movimiento de la
   cuenta con `saldo_resultante`, asiento de dos lineas (la base rechaza uno descuadrado y el uso de cuentas de
   agrupacion), desglose de efectivo y auditoria. Si algo falla, no queda nada.
4. **El efectivo se valida con la base:** el total sale de `denominaciones.valor * cantidad`, nunca del total
   que envia el cliente; codigo desconocido o inactivo = 400.
5. **Cuentas contables por dato:** la de efectivo sale de `parametros_cooperativa['caja.cuenta_efectivo']`
   (110105 por defecto); la del producto, de `productos_financieros.cuenta_activa`. Si no existe o esta inactiva
   en el plan de la cooperativa: 409, no un asiento a medias.
6. **Periodo contable:** el del dia (Ecuador) se crea si falta; si esta cerrado, nada se contabiliza (409).
7. **Nada se borra.** Anular = asiento contrario + movimiento `AJUSTE` + marca en el comprobante con motivo,
   fecha y responsable (el CHECK exige los tres juntos). Solo en el dia y con la caja del cajero abierta.
8. **Fechas del negocio en hora de Ecuador:** `(now() AT TIME ZONE 'America/Guayaquil')::date`.

## 3. Asientos

| Operacion | Debe | Haber |
|---|---|---|
| Deposito | Efectivo (110105) | Cuenta del producto (p. ej. 210135 Depositos de ahorro) |
| Retiro | Cuenta del producto | Efectivo |
| Anulacion | El inverso del original | |

`origen_modulo = 'CAJA'`, `origen_id = numero_comprobante`, `tipo_documento = 'COMPROBANTE_CAJA'`,
`socio_id` en ambas lineas.

## 4. Pendiente para los modulos que repiten el patron

- El cierre suma hoy `DEPOSITO_AHORROS` y `RETIRO_AHORROS`. Cuando creditos y plazo fijo registren operaciones
  en caja (pago de cuota, desembolso en efectivo, apertura de DPF), el cierre debe incluir sus tipos como
  ingreso o egreso; se agrega en el mismo cambio que crea el tipo.
- Sucursales: se asume una sola oficina con caja propia por usuario (pregunta 1 de `PENDIENTES_USUARIO.md`).

## 5. Lo que NO se porto del sistema anterior

| Sistema anterior | TECNIFIN |
|---|---|
| Leia el saldo y lo actualizaba sin bloqueo | `FOR UPDATE` + `UPDATE` condicionado |
| `parseFloat` y saldo en `FLOAT` | `numeric` en la base, texto en la API |
| Operaba sin caja abierta | Exige la caja del dia abierta |
| Confiaba en el total de cada billete que enviaba el cliente | Total calculado con la tabla de denominaciones |
| Cuenta de caja escrita en el codigo | Parametro por cooperativa |
| No registraba el movimiento de la cuenta | `movimientos_cuenta` con saldo resultante |
| Id del comprobante = id interno del asiento | Numero de comprobante por cooperativa |
