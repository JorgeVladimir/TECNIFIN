-- 0022_m6_cartera_proceso.sql -- M6 proceso mensual de cartera
-- Cada cuota que el proceso mueve de subcuenta (por vencer -> no devenga -> vencida, o de
-- banda) deja aqui su cuenta y estado anteriores. Con eso la reversion es exacta, cuota por
-- cuota, en lugar de redistribuir saldos con una tolerancia como hacia el motor anterior.

CREATE TABLE tecnifin.reclasificacion_cuota (
  movimiento_id   bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  proceso_id      bigint        NOT NULL,
  amortizacion_id bigint        NOT NULL,
  cuenta_anterior tecnifin.codigo_contable NOT NULL,
  cuenta_nueva    tecnifin.codigo_contable NOT NULL,
  estado_anterior varchar(20)   NOT NULL,
  estado_nuevo    varchar(20)   NOT NULL,
  capital         tecnifin.dinero NOT NULL,
  CONSTRAINT pk_reclasificacion_cuota PRIMARY KEY (cooperativa_id, movimiento_id),
  CONSTRAINT uq_reclasificacion_cuota UNIQUE (cooperativa_id, proceso_id, amortizacion_id),
  CONSTRAINT fk_reclasificacion_cuota_proceso FOREIGN KEY (cooperativa_id, proceso_id)
    REFERENCES tecnifin.reclasificacion_cartera (cooperativa_id, proceso_id),
  CONSTRAINT fk_reclasificacion_cuota_amortizacion FOREIGN KEY (cooperativa_id, amortizacion_id)
    REFERENCES tecnifin.tabla_amortizacion (cooperativa_id, amortizacion_id),
  CONSTRAINT ck_reclasificacion_cuota_cambio CHECK (
    cuenta_anterior <> cuenta_nueva OR estado_anterior <> estado_nuevo)
);

CREATE INDEX ix_reclasificacion_cuota_amortizacion ON tecnifin.reclasificacion_cuota (cooperativa_id, amortizacion_id);

SELECT tecnifin.aplicar_rls('tecnifin.reclasificacion_cuota');
