-- 0025_m3_mora_y_cancelacion.sql -- M3
-- Interes de mora en el cobro de cuotas vencidas y cancelacion anticipada del credito.
--  * pagos_credito.mora: el recargo por mora cobrado (a 510430 "De mora"); el total del pago
--    pasa a ser capital + interes + mora.
--  * pagos_credito.tipo: CUOTAS (n cuotas completas) o CANCELACION (todo el saldo, con interes
--    solo hasta hoy: en Ecuador no se penaliza la precancelacion).
--  * tabla_amortizacion.estado_antes_pago: la anulacion de un pago devuelve la cuota a su
--    estado real (PENDIENTE o VENCIDA segun el proceso de cartera), no siempre a PENDIENTE.

ALTER TABLE tecnifin.pagos_credito
  ADD COLUMN mora tecnifin.dinero NOT NULL DEFAULT 0,
  ADD COLUMN tipo varchar(20) NOT NULL DEFAULT 'CUOTAS',
  DROP CONSTRAINT ck_pagos_credito_total,
  ADD CONSTRAINT ck_pagos_credito_total CHECK (total = capital + interes + mora AND total > 0 AND mora >= 0),
  ADD CONSTRAINT ck_pagos_credito_tipo CHECK (tipo IN ('CUOTAS', 'CANCELACION'));

ALTER TABLE tecnifin.tabla_amortizacion
  ADD COLUMN estado_antes_pago varchar(20) NULL,
  ADD COLUMN mora_pagada tecnifin.dinero NULL;
