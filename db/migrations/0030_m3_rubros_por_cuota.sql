-- 0030_m3_rubros_por_cuota.sql -- M3 rubros por cuota como datos
-- El sistema anterior tenia en el codigo seguro 0,08 %, SOLCA por cuota y 1,50 de gastos por
-- cuota. Aqui cada cooperativa define sus rubros y la cuenta a la que van:
--   FIJO              valor por cuota
--   PORCENTAJE_MONTO  valor % del monto desembolsado, en cada cuota
--   PORCENTAJE_SALDO  valor % del saldo de capital al inicio de la cuota (p. ej. desgravamen)
-- Al desembolsar se calculan por cuota en rubros_creditos (con la base y el valor de ese dia: un
-- cambio posterior de la configuracion no altera creditos ya otorgados) y se cobran con la cuota.
--  * rubros_creditos.pago_id: el pago que lo cobro (PAGADO) o lo dejo sin efecto (ANULADO:
--    cuotas futuras en una cancelacion anticipada o extinguidas por un abono). La anulacion del
--    pago lo devuelve a PENDIENTE.
--  * pagos_credito.rubros: lo cobrado por rubros; el total pasa a capital + interes + mora + rubros.
--  * Las columnas fijas seguro_desgravamen / contribucion_solca / gastos_administrativos de
--    tabla_amortizacion quedan en 0 y en desuso: el detalle vive en rubros_creditos.

CREATE TABLE tecnifin.rubros_cuota_config (
  rubro_config_id integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  codigo          varchar(30)   NOT NULL,
  nombre          varchar(50)   NOT NULL,
  base            varchar(20)   NOT NULL,
  valor           numeric(12,6) NOT NULL,
  cuenta_contable tecnifin.codigo_contable NOT NULL,
  activo          boolean       NOT NULL DEFAULT true,
  CONSTRAINT pk_rubros_cuota_config PRIMARY KEY (cooperativa_id, rubro_config_id),
  CONSTRAINT uq_rubros_cuota_config_codigo UNIQUE (cooperativa_id, codigo),
  CONSTRAINT fk_rubros_cuota_config_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_rubros_cuota_config_base CHECK (base IN ('FIJO', 'PORCENTAJE_MONTO', 'PORCENTAJE_SALDO')),
  CONSTRAINT ck_rubros_cuota_config_valor CHECK (valor > 0 AND (base = 'FIJO' OR valor < 100)),
  CONSTRAINT ck_rubros_cuota_config_codigo CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,29}$')
);
COMMENT ON TABLE tecnifin.rubros_cuota_config IS
  'Rubros que se cobran con cada cuota (seguro, gastos, contribuciones). Cada cooperativa define los suyos y su cuenta.';
SELECT tecnifin.aplicar_rls('tecnifin.rubros_cuota_config');

ALTER TABLE tecnifin.rubros_creditos
  ADD COLUMN codigo varchar(30) NULL,
  ADD COLUMN base varchar(20) NULL,
  ADD COLUMN valor numeric(12,6) NULL,
  ADD COLUMN cuenta_contable tecnifin.codigo_contable NULL,
  ADD COLUMN pago_id bigint NULL,
  ADD CONSTRAINT fk_rubros_creditos_pago FOREIGN KEY (cooperativa_id, pago_id)
    REFERENCES tecnifin.pagos_credito (cooperativa_id, pago_id),
  ADD CONSTRAINT ck_rubros_creditos_monto CHECK (monto >= 0),
  ADD CONSTRAINT ck_rubros_creditos_pago CHECK ((estado = 'PENDIENTE') = (pago_id IS NULL));
CREATE INDEX ix_rubros_creditos_pago ON tecnifin.rubros_creditos (cooperativa_id, pago_id) WHERE pago_id IS NOT NULL;

ALTER TABLE tecnifin.pagos_credito
  ADD COLUMN rubros tecnifin.dinero NOT NULL DEFAULT 0,
  DROP CONSTRAINT ck_pagos_credito_total,
  ADD CONSTRAINT ck_pagos_credito_total CHECK (
    total = capital + interes + mora + rubros AND total > 0 AND mora >= 0 AND rubros >= 0),
  DROP CONSTRAINT ck_pagos_credito_abono,
  ADD CONSTRAINT ck_pagos_credito_abono CHECK (
    (tipo = 'ABONO' AND modalidad IN ('REDUCIR_CUOTA', 'REDUCIR_PLAZO') AND cuotas_abono IS NOT NULL
       AND interes = 0 AND mora = 0 AND rubros = 0)
    OR (tipo <> 'ABONO' AND modalidad IS NULL AND cuotas_abono IS NULL));
