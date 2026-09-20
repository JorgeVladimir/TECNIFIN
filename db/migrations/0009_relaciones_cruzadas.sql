-- 0009_relaciones_cruzadas.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/09_relaciones_cruzadas.sql y el punto 5 de
-- 18_fix_formato_codigo_contable.sql.
-- Son las claves foraneas entre tablas de dominios distintos que no podian declararse
-- antes porque la tabla referenciada todavia no existia. Todas compuestas con el tenant.

-- 1. El movimiento de la cuenta y la transaccion de caja / el asiento que lo produjeron.
ALTER TABLE tecnifin.movimientos_cuenta
  ADD CONSTRAINT fk_movimientos_cuenta_transaccion FOREIGN KEY (cooperativa_id, transaccion_caja_id)
    REFERENCES tecnifin.transacciones_caja (cooperativa_id, transaccion_id);
ALTER TABLE tecnifin.movimientos_cuenta
  ADD CONSTRAINT fk_movimientos_cuenta_asiento FOREIGN KEY (cooperativa_id, asiento_contable_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id);
CREATE INDEX ix_movimientos_cuenta_transaccion ON tecnifin.movimientos_cuenta
  (cooperativa_id, transaccion_caja_id);
CREATE INDEX ix_movimientos_cuenta_asiento ON tecnifin.movimientos_cuenta
  (cooperativa_id, asiento_contable_id);

-- 2. La transaccion de caja y su asiento.
ALTER TABLE tecnifin.transacciones_caja
  ADD CONSTRAINT fk_transacciones_caja_asiento FOREIGN KEY (cooperativa_id, asiento_contable_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id);
CREATE INDEX ix_transacciones_caja_asiento ON tecnifin.transacciones_caja
  (cooperativa_id, asiento_contable_id);

-- 3. Los codigos contables que productos y plazo fijo usan tienen que existir en el
--    plan de cuentas de ESA cooperativa. Es el hueco que 18_fix cerro en el viejo: sin
--    esta FK cualquier texto podia pasar por "cuenta contable". Compuesta, porque el
--    mismo codigo se repite entre cooperativas y solo el par es unico.
ALTER TABLE tecnifin.productos_financieros
  ADD CONSTRAINT fk_productos_financieros_cuenta_activa FOREIGN KEY (cooperativa_id, cuenta_activa)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
ALTER TABLE tecnifin.productos_financieros
  ADD CONSTRAINT fk_productos_financieros_cuenta_inactiva FOREIGN KEY (cooperativa_id, cuenta_inactiva)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
ALTER TABLE tecnifin.productos_financieros
  ADD CONSTRAINT fk_productos_financieros_cuenta_gasto FOREIGN KEY (cooperativa_id, cuenta_gasto)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
ALTER TABLE tecnifin.productos_financieros
  ADD CONSTRAINT fk_productos_financieros_cuenta_provision FOREIGN KEY (cooperativa_id, cuenta_provision)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
ALTER TABLE tecnifin.productos_financieros
  ADD CONSTRAINT fk_productos_financieros_cuenta_confirmar
    FOREIGN KEY (cooperativa_id, cuenta_depositos_confirmar)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
CREATE INDEX ix_productos_financieros_cuenta_activa ON tecnifin.productos_financieros
  (cooperativa_id, cuenta_activa);
CREATE INDEX ix_productos_financieros_cuenta_inactiva ON tecnifin.productos_financieros
  (cooperativa_id, cuenta_inactiva);
CREATE INDEX ix_productos_financieros_cuenta_gasto ON tecnifin.productos_financieros
  (cooperativa_id, cuenta_gasto);
CREATE INDEX ix_productos_financieros_cuenta_provision ON tecnifin.productos_financieros
  (cooperativa_id, cuenta_provision);
CREATE INDEX ix_productos_financieros_cuenta_confirmar ON tecnifin.productos_financieros
  (cooperativa_id, cuenta_depositos_confirmar);

ALTER TABLE tecnifin.tasas_plazo_fijo
  ADD CONSTRAINT fk_tasas_plazo_fijo_cuenta FOREIGN KEY (cooperativa_id, cuenta_contable_dpf)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
CREATE INDEX ix_tasas_plazo_fijo_cuenta ON tecnifin.tasas_plazo_fijo
  (cooperativa_id, cuenta_contable_dpf);

ALTER TABLE tecnifin.depositos_plazo
  ADD CONSTRAINT fk_depositos_plazo_cuenta_contable FOREIGN KEY (cooperativa_id, cuenta_contable_dpf)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo);
CREATE INDEX ix_depositos_plazo_cuenta_contable ON tecnifin.depositos_plazo
  (cooperativa_id, cuenta_contable_dpf);
