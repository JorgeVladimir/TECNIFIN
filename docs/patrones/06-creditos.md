# Patron 06 — creditos (M3)

Solicitud -> decision -> desembolso sobre los patrones 04 (entidades) y 05 (dinero). La contabilidad es comun
(`src/platform/contabilidad.js`: periodo del dia, cuenta por codigo, asiento de n lineas agrupadas); los calculos
sin base viven en `src/modules/creditos/calculo.js`.

## 1. Endpoints (primera parte)

| Endpoint | Rol | Efecto |
|---|---|---|
| `GET /api/creditos/lineas` | Analisis: `CREDIT_OFFICER`, `MANAGER`, `ADMIN`, `SUPER_USER` | Lineas vigentes con limites y tasa |
| `POST /api/creditos/simulacion` | Analisis | Tabla francesa; la tasa sale de la linea (la del cliente se ignora) |
| `POST /api/creditos/solicitudes` | Analisis | `SOL-000001` por cooperativa; socio ACTIVO tipo SOCIO; aportacion minima en certificados |
| `GET /api/creditos/solicitudes/:codigo` | Analisis | Solicitud con su plan simulado |
| `POST /api/creditos/solicitudes/:codigo/decision` | `MANAGER`, `ADMIN`, `SUPER_USER`, **distinto de quien registro** | APROBAR o RECHAZAR (con motivo) |
| `POST /api/creditos/solicitudes/:codigo/desembolso` | Igual | `CRED-000001`, tabla de amortizacion, acreditacion y asiento |
| `GET /api/creditos/:codigo` | Analisis | Credito con su tabla y la cuenta contable de cada cuota |

## 2. Reglas

1. **La linea manda** (`tasas_credito`): monto entre minimo y maximo (comparado en numeric), plazo en meses
   entre minimo y maximo, tasa = `tasa_aplicable`. El segmento SEPS (`clase_credito`) queda en la solicitud y el
   credito.
2. **Separacion de funciones:** quien registra la solicitud no la decide; tambien lo impide un CHECK
   (`ck_solicitudes_credito_separacion`).
3. **Aportacion minima** en certificados: `parametros_cooperativa['credito.certificado_minimo']`, 1.00 por
   defecto (regla del sistema anterior).
4. **Tabla francesa en centavos enteros:** una sola operacion en coma flotante (la potencia de la cuota), luego
   todo entero; el capital suma exactamente el monto y la ultima cuota absorbe el residuo. Fechas de cuota en SQL:
   `hoy + n meses` (PostgreSQL ajusta fin de mes).
5. **Cartera por banda de plazo remanente:** el capital de cada cuota va a la subcuenta de la familia por vencer
   del segmento (1401 comercial, 1402 consumo, 1403 vivienda, 1404 microempresa) segun los dias hasta su
   vencimiento. Las bandas se leen del plan de la cooperativa (`bandasDesdePlan`); nunca una tabla en el codigo.
   La subcuenta queda en `tabla_amortizacion.cuenta_capital` para el pago y la reclasificacion.
6. **Descuentos al desembolso** = datos (`descuentos_credito`: codigo, %, cuenta); se calculan en numeric con
   `round(monto * % / 100, 2)`; el neto debe quedar positivo.
7. **Asiento del desembolso:** Debe capital por banda = monto; Haber neto a la cuenta de ahorros del socio +
   cada descuento a su cuenta. La base rechaza cualquier descuadre.
8. El desembolso se acredita a una cuenta de **ahorro del mismo socio**, activa y que admita depositos
   (movimiento `TRANSFERENCIA_ENTRADA`), nunca a un certificado.

## 3. Hallazgos frente al sistema anterior

| Sistema anterior | TECNIFIN |
|---|---|
| Todo el capital a 140205 (consumo de 1 a 30 dias), cualquiera fuera el segmento o el plazo | Banda por plazo remanente dentro de la familia del segmento |
| Tasa enviada por el cliente, validada solo contra el tope | Tasa aplicable de la linea |
| Comision 1 %, fondo 0,5 %, SOLCA 0,5 % escritos en el codigo | `descuentos_credito` por cooperativa |
| Retencion SOLCA a la cuenta `25049005`, **que no existe en el Catalogo Unico sembrado** | La cooperativa elige la cuenta; si no existe en su plan, el desembolso da 409 sin asiento a medias |
| Seguro 0,08 %, SOLCA por cuota y 1,50 de gastos por cuota fijos en el codigo | `rubros_cuota_config` por cooperativa (§7) |
| Solo bloqueaba al `CREDIT_OFFICER`; cualquier otro rol aprobaba y desembolsaba | Lista blanca y separacion de funciones |

## 4. Pago y anulacion de pago (parte 2, 1-oct-2026, migracion 0020)

| Endpoint | Rol | Efecto |
|---|---|---|
| `POST /api/creditos/:codigo/pagos` | `TELLER`, `MANAGER`, `ADMIN`, `SUPER_USER` | Las `cuotas` pendientes siguientes, completas y en orden; `origen` CAJA (efectivo verificado, comprobante de caja, entra al cuadre) o CUENTA (debito a una cuenta de ahorro del mismo socio) |
| `POST /api/creditos/pagos/:numero/anular` | `MANAGER`, `ADMIN`, `SUPER_USER`, distinto de quien cobro | Solo del dia, solo el ultimo pago vigente del credito; si fue por caja, con la caja abierta |

- Cada pago es un documento `pagos_credito` (numero por cooperativa, tramo de cuotas, capital, interes, origen,
  asiento, anulacion con motivo/fecha/responsable). La cuota guarda `pago_id` para volver a PENDIENTE.
- Asiento del pago: Debe efectivo (110105 o `caja.cuenta_efectivo`) o la cuenta del producto de ahorro; Haber el
  capital de cada cuota a **su** `cuenta_capital` y el interes a la cuenta del segmento (5104: 05 comercial,
  10 consumo, 15 vivienda, 20 microempresa). La anulacion es el asiento inverso.
- Pagar la ultima cuota deja el credito `CANCELADO` con saldo 0; la prueba de libro mayor comprueba que la
  cartera 1401..1428 del credito vuelve a cero.
- El cierre de caja suma `PAGO_CREDITO` como ingreso.

## 5. Mora y cancelacion anticipada (1-oct-2026, migracion 0025, `src/modules/creditos/cobro.js`)

| Endpoint | Rol | Efecto |
|---|---|---|
| `GET /api/creditos/:codigo/cancelacion` | Cobro | Liquidacion a hoy: capital, interes y mora |
| `POST /api/creditos/:codigo/cancelacion` | Cobro | Cobra todo (caja o cuenta) y deja el credito `CANCELADO` |

- **Mora:** cada cuota vencida suma `round(capital * tasa/100 * factor * dias_mora / base, 2)` a la cuenta 510430
  (De mora). `credito.factor_mora` = 1.1 y `credito.base_dias` = 360 por defecto, en `parametros_cooperativa`;
  **los debe validar el contador** con la norma vigente del BCE/JPRMF.
- **Cancelacion anticipada sin penalizacion:** cuotas vencidas completas con su mora; la cuota en curso solo el
  interes corrido sobre el capital aun no vencido (sin pasar el interes de la cuota); las futuras, solo capital.
- `pagos_credito` guarda `mora` y `tipo` (CUOTAS/CANCELACION); el total es capital + interes + mora (CHECK).
- La anulacion reversa tambien la mora y devuelve cada cuota a su **estado anterior** (`estado_antes_pago`):
  una cuota VENCIDA por el proceso de cartera vuelve a VENCIDA, no a PENDIENTE (defecto corregido).
- El cobro vive en `cobro.js` y el ciclo de otorgamiento en `servicio.js` (regla 4: 500 lineas por archivo).

Pendiente de M3: scoring. Abono en §6, rubros en §7 (la simulacion ya muestra rubros por cuota y el costo total).

## 6. Abono extraordinario a capital (1-oct-2026, migracion 0028, `src/modules/creditos/abono.js`)

| Endpoint | Rol | Efecto |
|---|---|---|
| `POST /api/creditos/:codigo/abonos/simulacion` | Cobro | Tabla resultante sin escribir nada: nueva cuota, cuotas restantes, ahorro de interes |
| `POST /api/creditos/:codigo/abonos` | Cobro | `monto`, `modalidad` (REDUCIR_CUOTA por defecto o REDUCIR_PLAZO), `origen` CAJA o CUENTA |

- Solo con el credito **al dia**: si hay una cuota vencida, primero se paga (409).
- La **cuota en curso no cambia** (su interes se calculo sobre el saldo con que empezo el periodo); se
  recalculan las siguientes con `recalcularTrasAbono` (centavos enteros, el capital suma exacto el saldo).
  REDUCIR_CUOTA: mismas fechas y numero de cuotas, cuota francesa nueva. REDUCIR_PLAZO: misma cuota; las
  ultimas quedan `EXTINGUIDA` con capital 0 (la fila se conserva: puede estar referida por un proceso de
  cartera) y `creditos.fecha_vencimiento` se adelanta.
- El abono debe ser **menor** que el capital de las cuotas siguientes; si lo cubre todo, es una cancelacion
  anticipada (§5).
- **Asiento:** Debe el origen; Haber la diferencia de capital de **cada subcuenta** (las fechas no cambian, asi
  que cada cuota conserva su banda). En REDUCIR_PLAZO alguna cuota puede subir de capital: esa subcuenta va al
  Debe. La prueba comprueba que el mayor de cada subcuenta 1401..1428 es igual al capital pendiente de sus cuotas.
- Documento: `pagos_credito` tipo `ABONO` con `modalidad` y `cuotas_abono` (foto antes/despues de cada cuota).
  **Anulacion** por el mismo endpoint de pagos: asiento inverso del original y la tabla vuelve a "antes", solo si
  sigue exactamente igual a "despues" (ni pagos ni procesos de cartera en medio).
- El proceso de cartera ya no se reversa si el **capital** de una cuota cambio despues de aplicarlo (antes solo
  miraba cuenta y estado): un abono en medio lo habria descuadrado.
- **Contador:** confirmar que el interes de la cuota en curso no se recalcula (el abono rige desde la siguiente).

## 7. Rubros por cuota (1-oct-2026, migracion 0030, `src/modules/creditos/rubros.js`)

- **Configuracion por cooperativa** (`rubros_cuota_config`): codigo, nombre, `base` y `valor`, cuenta contable.
  `FIJO` (valor por cuota), `PORCENTAJE_MONTO` (% del monto desembolsado, en cada cuota), `PORCENTAJE_SALDO`
  (% del saldo de capital con que empieza la cuota; p. ej. desgravamen). Sin rubros configurados, todo funciona
  igual que antes. La base nace sin rubros (regla 11): cada cooperativa carga los suyos.
- **Desembolso:** cada cuota recibe sus rubros en `rubros_creditos` con la base y el valor de ese dia (un cambio
  posterior de la configuracion no toca creditos ya otorgados); `total` = capital + interes + rubros. Importes en
  numeric (SQL). `GET /api/creditos/:codigo` muestra `rubros` por cuota.
- **Cobro:** los rubros pendientes de las cuotas cobradas van al Haber de **su** cuenta; `pagos_credito.rubros` y el
  total los incluyen (CHECK). En la **cancelacion anticipada** la cuota en curso paga sus rubros y las futuras
  quedan `ANULADO` (con el pago que las dejo sin efecto).
- **Abono a capital:** los rubros `PORCENTAJE_SALDO` de las cuotas que cambian se recalculan con el saldo nuevo
  (foto antes/despues en `cuotas_abono`); los de cuotas extinguidas quedan `ANULADO`.
- **Anulacion:** todo rubro con el `pago_id` anulado vuelve a `PENDIENTE` y, si era un abono, a su monto anterior.
- Las columnas fijas `seguro_desgravamen`, `contribucion_solca` y `gastos_administrativos` de la tabla quedan en 0,
  en desuso.
- **Contador:** confirmar las cuentas tipicas (desgravamen a 259090 por pagar a la aseguradora, SOLCA a 250490,
  gastos a ingreso 5690) y que en la cancelacion las cuotas futuras no pagan rubros.
