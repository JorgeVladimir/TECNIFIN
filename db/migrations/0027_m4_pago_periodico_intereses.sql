-- 0027_m4_pago_periodico_intereses.sql -- M4
-- Depositos a plazo con modalidad MENSUAL o TRIMESTRAL: cada periodo vencido acredita el
-- interes neto a la cuenta de ahorros. El interes de cada periodo es la diferencia entre el
-- interes acumulado al final y al inicio del periodo (cada uno redondeado al centavo), asi la
-- suma de los pagos mas la liquidacion final es exactamente el interes del plazo completo.

CREATE TABLE tecnifin.pagos_interes_dpf (
  pago_id         bigint          GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer         NOT NULL,
  deposito_id     bigint          NOT NULL,
  periodo         integer         NOT NULL,
  -- Dias desde la apertura que quedan cubiertos con este pago (acumulado).
  dias_hasta      integer         NOT NULL,
  fecha_corte     date            NOT NULL,
  interes         tecnifin.dinero NOT NULL,
  retencion       tecnifin.dinero NOT NULL,
  interes_neto    tecnifin.dinero NOT NULL,
  asiento_id      bigint          NOT NULL,
  usuario_id      bigint          NOT NULL,
  fecha_registro  timestamptz(0)  NOT NULL DEFAULT now(),
  CONSTRAINT pk_pagos_interes_dpf PRIMARY KEY (cooperativa_id, pago_id),
  CONSTRAINT uq_pagos_interes_dpf_periodo UNIQUE (cooperativa_id, deposito_id, periodo),
  CONSTRAINT fk_pagos_interes_dpf_deposito FOREIGN KEY (cooperativa_id, deposito_id)
    REFERENCES tecnifin.depositos_plazo (cooperativa_id, deposito_id),
  CONSTRAINT fk_pagos_interes_dpf_asiento FOREIGN KEY (cooperativa_id, asiento_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  CONSTRAINT fk_pagos_interes_dpf_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_pagos_interes_dpf_periodo CHECK (periodo > 0 AND dias_hasta > 0),
  CONSTRAINT ck_pagos_interes_dpf_montos CHECK (
    retencion >= 0 AND retencion <= interes AND interes_neto = interes - retencion)
);

CREATE INDEX ix_pagos_interes_dpf_asiento ON tecnifin.pagos_interes_dpf (cooperativa_id, asiento_id);
CREATE INDEX ix_pagos_interes_dpf_usuario ON tecnifin.pagos_interes_dpf (cooperativa_id, usuario_id);

SELECT tecnifin.aplicar_rls('tecnifin.pagos_interes_dpf');
