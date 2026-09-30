-- 0020_m3_pagos_credito.sql -- M3 pago de cuotas
-- Cada pago es un documento propio, numerado por cooperativa, que cubre un tramo de
-- cuotas consecutivas y guarda como se pago (efectivo en caja o debito a una cuenta),
-- su asiento y, si se anula, quien, cuando y por que. Sin esto no hay como revertir un
-- pago con exactitud: el sistema anterior solo tenia el registro contable.

CREATE TABLE tecnifin.pagos_credito (
  pago_id              bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id       integer        NOT NULL,
  numero_pago          bigint         NOT NULL DEFAULT tecnifin.siguiente_numero('pago_credito'),
  credito_id           bigint         NOT NULL,
  cuota_desde          integer        NOT NULL,
  cuota_hasta          integer        NOT NULL,
  capital              tecnifin.dinero NOT NULL,
  interes              tecnifin.dinero NOT NULL,
  total                tecnifin.dinero NOT NULL,
  origen               varchar(10)    NOT NULL,
  transaccion_caja_id  bigint         NULL,
  cuenta_id            bigint         NULL,
  asiento_id           bigint         NOT NULL,
  usuario_id           bigint         NOT NULL,
  fecha                timestamptz(0) NOT NULL DEFAULT now(),
  anulado              boolean        NOT NULL DEFAULT false,
  motivo_anulacion     varchar(300)   NULL,
  fecha_anulacion      timestamptz(0) NULL,
  usuario_anulacion_id bigint         NULL,
  CONSTRAINT pk_pagos_credito PRIMARY KEY (cooperativa_id, pago_id),
  CONSTRAINT uq_pagos_credito_numero UNIQUE (cooperativa_id, numero_pago),
  CONSTRAINT fk_pagos_credito_credito FOREIGN KEY (cooperativa_id, credito_id)
    REFERENCES tecnifin.creditos (cooperativa_id, credito_id),
  CONSTRAINT fk_pagos_credito_transaccion FOREIGN KEY (cooperativa_id, transaccion_caja_id)
    REFERENCES tecnifin.transacciones_caja (cooperativa_id, transaccion_id),
  CONSTRAINT fk_pagos_credito_cuenta FOREIGN KEY (cooperativa_id, cuenta_id)
    REFERENCES tecnifin.cuentas (cooperativa_id, cuenta_id),
  CONSTRAINT fk_pagos_credito_asiento FOREIGN KEY (cooperativa_id, asiento_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  CONSTRAINT fk_pagos_credito_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT fk_pagos_credito_usuario_anulacion FOREIGN KEY (cooperativa_id, usuario_anulacion_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_pagos_credito_numero CHECK (numero_pago > 0),
  CONSTRAINT ck_pagos_credito_tramo CHECK (cuota_desde > 0 AND cuota_hasta >= cuota_desde),
  CONSTRAINT ck_pagos_credito_total CHECK (total = capital + interes AND total > 0),
  CONSTRAINT ck_pagos_credito_origen CHECK (
    (origen = 'CAJA' AND transaccion_caja_id IS NOT NULL AND cuenta_id IS NULL)
    OR (origen = 'CUENTA' AND cuenta_id IS NOT NULL AND transaccion_caja_id IS NULL)),
  CONSTRAINT ck_pagos_credito_anulacion CHECK (
    (anulado AND motivo_anulacion IS NOT NULL AND fecha_anulacion IS NOT NULL AND usuario_anulacion_id IS NOT NULL)
    OR (NOT anulado AND motivo_anulacion IS NULL AND fecha_anulacion IS NULL AND usuario_anulacion_id IS NULL))
);

CREATE INDEX ix_pagos_credito_credito ON tecnifin.pagos_credito (cooperativa_id, credito_id);
CREATE INDEX ix_pagos_credito_transaccion ON tecnifin.pagos_credito (cooperativa_id, transaccion_caja_id);
CREATE INDEX ix_pagos_credito_cuenta ON tecnifin.pagos_credito (cooperativa_id, cuenta_id);
CREATE INDEX ix_pagos_credito_asiento ON tecnifin.pagos_credito (cooperativa_id, asiento_id);
CREATE INDEX ix_pagos_credito_usuario ON tecnifin.pagos_credito (cooperativa_id, usuario_id);
CREATE INDEX ix_pagos_credito_usuario_anulacion ON tecnifin.pagos_credito (cooperativa_id, usuario_anulacion_id)
  WHERE usuario_anulacion_id IS NOT NULL;

SELECT tecnifin.aplicar_rls('tecnifin.pagos_credito');

-- La cuota recuerda con que pago se cancelo: la anulacion la devuelve a PENDIENTE.
ALTER TABLE tecnifin.tabla_amortizacion
  ADD COLUMN pago_id bigint NULL,
  ADD CONSTRAINT fk_tabla_amortizacion_pago FOREIGN KEY (cooperativa_id, pago_id)
    REFERENCES tecnifin.pagos_credito (cooperativa_id, pago_id);
CREATE INDEX ix_tabla_amortizacion_pago ON tecnifin.tabla_amortizacion (cooperativa_id, pago_id)
  WHERE pago_id IS NOT NULL;
