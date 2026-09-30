# Patron 07 — depositos a plazo fijo (M4)

## 1. Endpoints

| Endpoint | Rol | Efecto |
|---|---|---|
| `GET /api/dpf/tramos` | `TELLER`, `MANAGER`, `ADMIN`, `SUPER_USER` | Tramos vigentes (dias, tasa, montos) |
| `POST /api/dpf/simulacion` | Igual | Interes, retencion, neto y vencimiento |
| `POST /api/dpf` | Igual | Apertura: **debita** la cuenta de ahorros del socio; codigo `DPF-AAAAMM-0001` |
| `GET /api/dpf/:codigo` | Igual | Deposito con proyecciones y liquidacion |
| `POST /api/dpf/:codigo/liquidar` | Igual | Solo vencido: acredita capital + interes neto a la cuenta de origen |
| `POST /api/dpf/:codigo/cancelar` | `MANAGER`, `ADMIN`, `SUPER_USER`, con motivo | Antes del vencimiento: interes de los dias transcurridos menos la penalizacion del tramo |
| `POST /api/dpf/:codigo/renovar` | Operacion | Solo vencido: liquida (interes neto a la cuenta) y abre otro por el mismo capital con el tramo vigente, `numero_renovacion + 1` |

## 2. Reglas

1. **Interes en numeric:** `round(capital * tasa/100 * dias / base * (1 - penalizacion/100), 2)`; retencion
   `round(interes * pct/100, 2)`; neto = interes - retencion.
2. **Parametros por cooperativa** (`parametros_cooperativa`) con el valor del sistema anterior por defecto:
   `dpf.retencion_pct` = 2, `dpf.base_dias` = 365, `dpf.cuenta_gasto_interes` = 410130,
   `dpf.cuenta_retencion` = 250405. **La retencion y la base de dias las debe validar el contador** con la norma
   tributaria y SEPS vigentes.
3. El pasivo va a la cuenta del tramo (`tasas_plazo_fijo.cuenta_contable_dpf`, 2103xx por plazo).
4. **Asientos:** apertura D ahorros (producto) / H 2103xx. Liquidacion, cancelacion y renovacion:
   D 2103xx capital + D 410130 interes / H ahorros capital + neto + H 250405 retencion.
5. **La penalizacion reduce el interes pagado**, no es una linea aparte.
6. Todo cierre (liquidado, cancelado, renovado) guarda fecha, responsable y asiento (CHECK de 0021).

## 3. Lo que se corrige del sistema anterior

| Sistema anterior | TECNIFIN |
|---|---|
| La apertura contabilizaba contra 21013505 pero **no restaba el saldo** del socio: el dinero quedaba en dos lugares | Debito real con `FOR UPDATE` y saldo suficiente |
| Liquidacion y cancelacion contra `4.1.03.05`, `2.1.01.05`, `2.5.03.05`, `5.4.90.90` (codigos con puntos, ya migrados) | Codigos del Catalogo Unico por parametro |
| No acreditaba al socio al liquidar | Acredita a la cuenta de origen con movimiento |
| La cancelacion agregaba la penalizacion como linea de haber: **el asiento descuadraba por el monto de la penalizacion** | La penalizacion reduce el interes; la base rechaza cualquier descuadre |
| Retencion 2 % y base 365 escritas en el codigo | Parametros por cooperativa |

## 4. Pago periodico de intereses (0027)

`modalidadPago` en la apertura: `AL_VENCIMIENTO` (defecto), `MENSUAL` (cada 30 dias) o `TRIMESTRAL` (cada 90); el
plazo debe ser mayor al periodo. `POST /api/dpf/intereses/pagos` (supervisor) paga todos los periodos vencidos a hoy
de los depositos ACTIVOS con pago periodico; un periodo pagado no se repite (`pagos_interes_dpf`, UNIQUE deposito +
periodo). Codigo en `src/modules/plazo_fijo/intereses.js`.

1. **Interes del periodo = acumulado(fin) - acumulado(inicio)**, cada acumulado redondeado al centavo; igual la
   retencion. La suma de los pagos mas la liquidacion es exactamente el interes del plazo completo.
2. Asiento por periodo (`INTERES_DPF`): D 410130 / H ahorros neto + H 250405 retencion. El capital sigue en 2103xx.
3. El ultimo tramo lo paga la liquidacion: interes total del plazo menos lo ya pagado.
4. **Cancelacion con pagos previos:** el interes penalizado de los dias transcurridos menos lo pagado; si da negativo
   se liquida 0 y **lo pagado no se descuenta del capital**. Decision a validar con el contador (alternativa: descontar
   el exceso del capital devuelto).
5. Periodos de 30/90 dias (misma convencion del calculo), no meses calendario: tambien a validar con el contador.

## 5. Pendiente

Renovacion automatica por proceso diario,
provision/devengo mensual del interes por pagar (cuando se haga el cierre contable mensual), apertura en efectivo
por caja.
