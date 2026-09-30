-- 0019_m3_creditos.sql -- M3 creditos
-- Lo que el flujo solicitud -> decision -> desembolso necesita y DAT-01 no traia:
--  * segmento SEPS de la operacion (define la familia contable 1401..1404 y la cuenta de interes);
--  * quien registro la solicitud (quien la registra no la aprueba: separacion de funciones);
--  * la linea de credito de la que salieron tasa, montos y plazos;
--  * en que cuenta contable quedo el capital de cada cuota (la banda por plazo remanente);
--    el pago y la reclasificacion mensual la necesitan para descargar la cuenta correcta;
--  * descuentos al desembolso configurables por cooperativa (el sistema anterior los tenia
--    escritos en el codigo: 1 % comision, 0,5 % fondo, 0,5 % SOLCA).
-- Columnas nuevas NULL: la demo inserta creditos historicos sin ellas.

ALTER TABLE tecnifin.solicitudes_credito
  ADD COLUMN segmento tecnifin.segmento_credito NULL,
  ADD COLUMN tasa_credito_id integer NULL,
  ADD COLUMN destino varchar(200) NULL,
  ADD COLUMN usuario_registro_id bigint NULL,
  ADD CONSTRAINT fk_solicitudes_credito_tasa FOREIGN KEY (cooperativa_id, tasa_credito_id)
    REFERENCES tecnifin.tasas_credito (cooperativa_id, tasa_credito_id),
  ADD CONSTRAINT fk_solicitudes_credito_usuario_registro FOREIGN KEY (cooperativa_id, usuario_registro_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  ADD CONSTRAINT ck_solicitudes_credito_separacion CHECK (
    usuario_decision_id IS NULL OR usuario_registro_id IS NULL OR usuario_decision_id <> usuario_registro_id);

CREATE INDEX ix_solicitudes_credito_tasa ON tecnifin.solicitudes_credito (cooperativa_id, tasa_credito_id);
CREATE INDEX ix_solicitudes_credito_usuario_registro ON tecnifin.solicitudes_credito (cooperativa_id, usuario_registro_id);

ALTER TABLE tecnifin.creditos
  ADD COLUMN segmento tecnifin.segmento_credito NULL,
  ADD COLUMN cuenta_acreditacion_id bigint NULL,
  ADD COLUMN asiento_desembolso_id bigint NULL,
  ADD CONSTRAINT fk_creditos_cuenta_acreditacion FOREIGN KEY (cooperativa_id, cuenta_acreditacion_id)
    REFERENCES tecnifin.cuentas (cooperativa_id, cuenta_id),
  ADD CONSTRAINT fk_creditos_asiento_desembolso FOREIGN KEY (cooperativa_id, asiento_desembolso_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id);

CREATE INDEX ix_creditos_cuenta_acreditacion ON tecnifin.creditos (cooperativa_id, cuenta_acreditacion_id);
CREATE INDEX ix_creditos_asiento_desembolso ON tecnifin.creditos (cooperativa_id, asiento_desembolso_id);

ALTER TABLE tecnifin.tabla_amortizacion
  ADD COLUMN cuenta_capital tecnifin.codigo_contable NULL;

COMMENT ON COLUMN tecnifin.tabla_amortizacion.cuenta_capital IS
  'Subcuenta de cartera (familia del segmento, banda por dias al vencimiento) donde esta contabilizado el capital de la cuota.';

CREATE TABLE tecnifin.descuentos_credito (
  descuento_id    integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  codigo          varchar(30)   NOT NULL,
  nombre          varchar(100)  NOT NULL,
  porcentaje      numeric(9,4)  NOT NULL,
  cuenta_contable tecnifin.codigo_contable NOT NULL,
  activo          boolean       NOT NULL DEFAULT true,
  CONSTRAINT pk_descuentos_credito PRIMARY KEY (cooperativa_id, descuento_id),
  CONSTRAINT uq_descuentos_credito_codigo UNIQUE (cooperativa_id, codigo),
  CONSTRAINT fk_descuentos_credito_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_descuentos_credito_porcentaje CHECK (porcentaje > 0 AND porcentaje < 100),
  CONSTRAINT ck_descuentos_credito_codigo CHECK (codigo ~ '^[A-Z][A-Z0-9_]{1,29}$')
);

COMMENT ON TABLE tecnifin.descuentos_credito IS
  'Descuentos sobre el monto al desembolsar (comision, fondo, contribuciones). Cada cooperativa define los suyos y su cuenta.';

SELECT tecnifin.aplicar_rls('tecnifin.descuentos_credito');
