# Patron 08 — proceso mensual de cartera SEPS (M6)

`src/modules/cartera/servicio.js`. Reutiliza `bandasDesdePlan`/`cuentaPorBanda`/`FAMILIA_CARTERA` de
`src/modules/creditos/calculo.js`, asi que desembolso, pago y proceso usan la misma definicion de banda.

## 1. Endpoints

| Endpoint | Rol | Efecto |
|---|---|---|
| `GET /api/cartera/clasificacion?fecha=` | `CREDIT_OFFICER`, `MANAGER`, `ADMIN`, `SUPER_USER` | Clasificacion a la fecha (hoy por defecto): totales, morosidad, saldo por cuenta, calificacion y provision por operacion; no escribe |
| `POST /api/cartera/procesos` `{ fechaCorte, aplicar }` | Consulta simula; **aplicar solo `MANAGER`/`ADMIN`/`SUPER_USER`** | Simula por defecto (fila SIMULADO sin asiento); con `aplicar: true` contabiliza |
| `POST /api/cartera/procesos/:id/reversar` `{ motivo }` | Supervisor | Reversion exacta del ultimo proceso aplicado |

## 2. Clasificacion (por cuota, a la fecha de corte)

| Situacion de la cuota | Familia | Banda por |
|---|---|---|
| Vencida (dias de mora > 0) | VENCIDA (1421..1424) | dias de mora |
| No vencida de un credito con alguna cuota vencida | NO DEVENGA (1411..1414) | dias al vencimiento |
| Resto | POR VENCER (1401..1404) | dias al vencimiento |

Calificacion A1..E y porcentaje de `parametros_provision_cartera` (segmento, dias de mora maximos de la
operacion) aplicados al **saldo total** de la operacion; provision por operacion redondeada al centavo.
Morosidad = (no devenga + vencida) / cartera bruta, en puntos basicos (sin coma flotante).

## 3. Aplicar

1. **Control previo:** el saldo contable de 1401..1428 (todo el libro) debe coincidir al centavo, cuenta por
   cuenta, con el capital pendiente segun `tabla_amortizacion.cuenta_capital`. Si no, 409 y el detalle de las
   cuentas descuadradas: reclasificar taparia el problema.
2. **Un proceso a la vez por cooperativa** (`pg_advisory_xact_lock`) y ninguno con corte anterior o igual a uno
   ya aplicado.
3. **Asiento unico:** por cada par origen->destino, D destino / H origen; por cada cuenta de provision,
   ajuste = requerida - constituida (1499xx se lee Haber - Debe): positivo D gasto 4402xx / H 1499xx; negativo
   D 1499xx / H 560410 (reversion de provisiones).
4. Cada cuota movida deja su fila en `reclasificacion_cuota` (cuenta y estado anterior y nuevo) y actualiza
   `cuenta_capital` y `estado` (VENCIDA). Se registra `calificacion_cartera` por operacion y corte.

## 4. Reversar

Solo el ultimo proceso aplicado, y solo si ninguna cuota movida cambio despues (un pago posterior la descargo de
la cuenta nueva): 409 en ese caso. Asiento inverso linea por linea, cuotas a su cuenta y estado anteriores,
calificaciones del corte eliminadas, proceso original `REVERSADO` y fila de reverso enlazada.

## 5. Diferencias con el motor anterior (`services/carteraSeps.js`)

| Motor anterior | TECNIFIN |
|---|---|
| Redistribuia el saldo contable con un factor y una tolerancia (1 USD o 0,1 %) porque no sabia donde estaba cada cuota | Cada cuota sabe su cuenta: movimiento exacto, sin tolerancia |
| Leia cuotas del JSON `PlanPagos` y el vencimiento por `DATEADD` | `tabla_amortizacion` relacional con `fecha_pago` y `estado` |
| Sumas en coma flotante con `round2` | Centavos enteros |
| Reversion por asiento contrario sin volver las cuotas | Reversion cuota por cuota, verificada |

## 6. Correccion de una regla de DAT-02

`ck_reclasificacion_cartera_contabilizacion` (0014) exigia provision contabilizada **positiva** en todo proceso
aplicado; un mes con reversion de provision o solo con reclasificacion la violaba. Se reemplazo (0023, 0024) por:
una simulacion no contabiliza nada, y una provision contabilizada distinta de cero exige asiento.

## 7. Castigo (1-oct-2026)

`POST /api/cartera/castigos/:credito { motivo }` — supervisor, motivo de 10 a 500 caracteres. Solo un credito
VIGENTE con cuotas vencidas y cuya provision constituida del segmento (1499xx) cubra el saldo; si no, 409 (corra
el proceso de cartera). Asiento: D 1499xx / H cada cuota desde su `cuenta_capital`; control en cuentas de orden
D 710310 (cartera castigada) / H 7203xx del segmento. Credito `CASTIGADO`, cuotas `CASTIGADA`; deja de ser
cartera para la clasificacion y los reportes.

## 8. Recuperacion de castigados (0026)

POST /api/cartera/castigos/:credito/recuperacion { monto, origen: CAJA | CUENTA } (cobro: TELLER y supervisores). Lo cobrado va a 560405 (De activos castigados) y baja el control de orden (D 7203xx / H 710310) en el mismo monto; creditos.monto_castigado y monto_recuperado impiden recuperar mas de lo castigado (CHECK). En caja entra al cuadre como RECUPERACION_CASTIGO. servicio.js de cartera esta en 463 lineas: lo proximo que se agregue va a un archivo propio (regla 4).

## 9. Pendiente

Interes devengado y su
reversion al pasar a no devenga, refinanciados y reestructurados (1405..1408), proceso programado de fin de mes.
