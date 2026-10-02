-- 0028_m3_abono_capital.sql -- M3 abono extraordinario a capital
-- El socio entrega dinero que no corresponde a una cuota: baja el capital y la tabla se
-- recalcula desde la cuota siguiente a la que esta en curso (la cuota en curso no cambia:
-- su interes ya se calculo sobre el saldo con que empezo el periodo).
--  * pagos_credito.tipo ABONO: el documento del abono (capital = monto, sin interes ni mora).
--  * pagos_credito.modalidad: REDUCIR_CUOTA (mismo plazo, cuota menor) o REDUCIR_PLAZO
--    (misma cuota, se extinguen las ultimas).
--  * pagos_credito.cuotas_abono: cada cuota tocada con sus valores antes y despues. La
--    anulacion devuelve la tabla exactamente a "antes" y solo si sigue igual a "despues".
--  * tabla_amortizacion.estado EXTINGUIDA: cuota que deja de existir por REDUCIR_PLAZO. La fila
--    se conserva (puede estar referida por un proceso de cartera) con capital e interes en 0.

ALTER TABLE tecnifin.pagos_credito
  ADD COLUMN modalidad varchar(20) NULL,
  ADD COLUMN cuotas_abono jsonb NULL,
  DROP CONSTRAINT ck_pagos_credito_tipo,
  ADD CONSTRAINT ck_pagos_credito_tipo CHECK (tipo IN ('CUOTAS', 'CANCELACION', 'ABONO')),
  ADD CONSTRAINT ck_pagos_credito_abono CHECK (
    (tipo = 'ABONO' AND modalidad IN ('REDUCIR_CUOTA', 'REDUCIR_PLAZO') AND cuotas_abono IS NOT NULL
       AND interes = 0 AND mora = 0)
    OR (tipo <> 'ABONO' AND modalidad IS NULL AND cuotas_abono IS NULL));

ALTER TABLE tecnifin.tabla_amortizacion
  DROP CONSTRAINT ck_tabla_amortizacion_estado,
  ADD CONSTRAINT ck_tabla_amortizacion_estado
    CHECK (estado IN ('PENDIENTE', 'PAGADA', 'VENCIDA', 'CASTIGADA', 'EXTINGUIDA'));
