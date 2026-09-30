-- 0026_m6_recuperacion_castigos.sql -- M6
-- Lo castigado y lo recuperado de cada credito, para que una recuperacion nunca supere el
-- saldo castigado y el control de cuentas de orden baje exactamente lo cobrado.

ALTER TABLE tecnifin.creditos
  ADD COLUMN monto_castigado tecnifin.dinero NOT NULL DEFAULT 0,
  ADD COLUMN monto_recuperado tecnifin.dinero NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_creditos_recuperacion CHECK (monto_recuperado >= 0 AND monto_recuperado <= monto_castigado),
  ADD CONSTRAINT ck_creditos_castigo CHECK (estado = 'CASTIGADO' OR (monto_castigado = 0 AND monto_recuperado = 0));
