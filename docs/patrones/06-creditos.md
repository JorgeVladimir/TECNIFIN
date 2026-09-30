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
| Seguro 0,08 %, SOLCA por cuota y 1,50 de gastos por cuota fijos en el codigo | Pendiente: rubros por cuota como datos (siguiente parte) |
| Solo bloqueaba al `CREDIT_OFFICER`; cualquier otro rol aprobaba y desembolsaba | Lista blanca y separacion de funciones |

## 4. Siguiente parte de M3

Pago de cuota (por caja o debito a la cuenta, con interes a la cuenta del segmento 5104xx y capital descargado de
`cuenta_capital`), anulacion de pago, rubros por cuota como datos, cancelacion anticipada, scoring. Despues M6
(cartera SEPS: vencimiento, no devenga, reclasificacion y provisiones) reutiliza `calculo.js`.
