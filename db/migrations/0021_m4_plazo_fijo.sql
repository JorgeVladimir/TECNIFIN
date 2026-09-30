-- 0021_m4_plazo_fijo.sql -- M4 depositos a plazo fijo
-- El deposito recuerda sus asientos (apertura y liquidacion/cancelacion) y la cuenta de
-- ahorros de la que salio el dinero, para que liquidar, cancelar o renovar devuelva todo
-- al mismo lugar. El sistema anterior no descontaba el saldo del socio al abrir un DPF y
-- liquidaba contra codigos contables con puntos que ya no existen.

ALTER TABLE tecnifin.depositos_plazo
  ADD COLUMN asiento_apertura_id bigint NULL,
  ADD COLUMN asiento_liquidacion_id bigint NULL,
  ADD CONSTRAINT fk_depositos_plazo_asiento_apertura FOREIGN KEY (cooperativa_id, asiento_apertura_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  ADD CONSTRAINT fk_depositos_plazo_asiento_liquidacion FOREIGN KEY (cooperativa_id, asiento_liquidacion_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  -- Un deposito cerrado (liquidado, cancelado o renovado) tiene fecha, responsable y asiento.
  ADD CONSTRAINT ck_depositos_plazo_cierre CHECK (
    estado IN ('ACTIVO', 'VENCIDO')
    OR (fecha_liquidacion IS NOT NULL AND usuario_liquidacion_id IS NOT NULL));

CREATE INDEX ix_depositos_plazo_asiento_apertura ON tecnifin.depositos_plazo (cooperativa_id, asiento_apertura_id);
CREATE INDEX ix_depositos_plazo_asiento_liquidacion ON tecnifin.depositos_plazo (cooperativa_id, asiento_liquidacion_id);
