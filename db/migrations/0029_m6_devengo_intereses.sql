-- 0029_m6_devengo_intereses.sql -- M6 devengo de intereses de cartera
-- A una fecha de corte, el interes de cada cuota se reconoce en proporcion a los dias corridos
-- de su periodo. Si el credito devenga, va a intereses por cobrar (1603xx) contra ingreso
-- (5104xx); si esta en no devenga (tiene alguna cuota vencida), a intereses en suspenso en
-- cuentas de orden (7109xx contra 7209xx). Al cobrar la cuota, lo devengado sale de 1603 y lo
-- que estaba en suspenso se baja de orden.
--  * tabla_amortizacion.interes_devengado (ya existia, NULL) pasa a NOT NULL DEFAULT 0.
--  * tabla_amortizacion.interes_suspenso: lo reconocido en cuentas de orden.
--  * devengo_intereses / devengo_cuota: cada corrida aplicada y lo que movio en cada cuota, para
--    reversarla exacta (como reclasificacion_cartera / reclasificacion_cuota).

UPDATE tecnifin.tabla_amortizacion SET interes_devengado = 0 WHERE interes_devengado IS NULL;
ALTER TABLE tecnifin.tabla_amortizacion
  ALTER COLUMN interes_devengado SET DEFAULT 0,
  ALTER COLUMN interes_devengado SET NOT NULL,
  ADD COLUMN interes_suspenso tecnifin.dinero NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_tabla_amortizacion_devengo CHECK (
    interes_devengado >= 0 AND interes_suspenso >= 0 AND interes_devengado + interes_suspenso <= interes);

CREATE TABLE tecnifin.devengo_intereses (
  proceso_id      bigint          GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer         NOT NULL,
  fecha_corte     date            NOT NULL,
  estado          varchar(20)     NOT NULL DEFAULT 'APLICADO',
  devengado       tecnifin.dinero NOT NULL,
  suspenso        tecnifin.dinero NOT NULL,
  asiento_id      bigint          NULL,
  usuario_id      bigint          NOT NULL,
  fecha_ejecucion timestamptz(0)  NOT NULL DEFAULT now(),
  asiento_reverso_id bigint       NULL,
  motivo_reverso  varchar(500)    NULL,
  CONSTRAINT pk_devengo_intereses PRIMARY KEY (cooperativa_id, proceso_id),
  CONSTRAINT fk_devengo_intereses_asiento FOREIGN KEY (cooperativa_id, asiento_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  CONSTRAINT fk_devengo_intereses_asiento_reverso FOREIGN KEY (cooperativa_id, asiento_reverso_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  CONSTRAINT fk_devengo_intereses_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_devengo_intereses_estado CHECK (estado IN ('APLICADO', 'REVERSADO')),
  CONSTRAINT ck_devengo_intereses_asiento CHECK (
    (devengado + suspenso = 0) = (asiento_id IS NULL)),
  CONSTRAINT ck_devengo_intereses_reverso CHECK (
    (estado = 'REVERSADO') = (motivo_reverso IS NOT NULL))
);
CREATE INDEX ix_devengo_intereses_asiento ON tecnifin.devengo_intereses (cooperativa_id, asiento_id);
CREATE INDEX ix_devengo_intereses_asiento_reverso ON tecnifin.devengo_intereses (cooperativa_id, asiento_reverso_id)
  WHERE asiento_reverso_id IS NOT NULL;
CREATE INDEX ix_devengo_intereses_usuario ON tecnifin.devengo_intereses (cooperativa_id, usuario_id);
CREATE INDEX ix_devengo_intereses_corte ON tecnifin.devengo_intereses (cooperativa_id, estado, fecha_corte);
SELECT tecnifin.aplicar_rls('tecnifin.devengo_intereses');

CREATE TABLE tecnifin.devengo_cuota (
  movimiento_id   bigint          GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer         NOT NULL,
  proceso_id      bigint          NOT NULL,
  amortizacion_id bigint          NOT NULL,
  devengado       tecnifin.dinero NOT NULL,
  suspenso        tecnifin.dinero NOT NULL,
  CONSTRAINT pk_devengo_cuota PRIMARY KEY (cooperativa_id, movimiento_id),
  CONSTRAINT uq_devengo_cuota UNIQUE (cooperativa_id, proceso_id, amortizacion_id),
  CONSTRAINT fk_devengo_cuota_proceso FOREIGN KEY (cooperativa_id, proceso_id)
    REFERENCES tecnifin.devengo_intereses (cooperativa_id, proceso_id),
  CONSTRAINT fk_devengo_cuota_amortizacion FOREIGN KEY (cooperativa_id, amortizacion_id)
    REFERENCES tecnifin.tabla_amortizacion (cooperativa_id, amortizacion_id),
  CONSTRAINT ck_devengo_cuota_valor CHECK (devengado >= 0 AND suspenso >= 0 AND devengado + suspenso > 0)
);
CREATE INDEX ix_devengo_cuota_amortizacion ON tecnifin.devengo_cuota (cooperativa_id, amortizacion_id);
SELECT tecnifin.aplicar_rls('tecnifin.devengo_cuota');
