-- 0018_m2_caja.sql -- M2 caja y ventanilla
-- Comprobante numerado por cooperativa (desde 1, sin huecos, igual que socios y cuentas),
-- concepto de la operacion, anulacion trazable (quien, cuando, por que) y el cuadre del
-- cierre de caja (saldo esperado frente al contado).
-- Las columnas NOT NULL con DEFAULT tecnifin.siguiente_numero() solo son seguras sobre tablas
-- vacias: la funcion exige tenant fijado. La base nace en blanco y la demo se reconstruye
-- desde cero, asi que aqui no hay filas previas.

ALTER TABLE tecnifin.transacciones_caja
  ADD COLUMN numero_comprobante bigint NOT NULL DEFAULT tecnifin.siguiente_numero('comprobante_caja'),
  ADD COLUMN concepto varchar(200) NULL,
  ADD COLUMN motivo_anulacion varchar(300) NULL,
  ADD COLUMN fecha_anulacion timestamptz(0) NULL,
  ADD COLUMN usuario_anulacion_id bigint NULL,
  ADD CONSTRAINT uq_transacciones_caja_comprobante UNIQUE (cooperativa_id, numero_comprobante),
  ADD CONSTRAINT fk_transacciones_caja_usuario_anulacion FOREIGN KEY (cooperativa_id, usuario_anulacion_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  ADD CONSTRAINT ck_transacciones_caja_comprobante CHECK (numero_comprobante > 0),
  -- Una anulacion sin motivo, fecha o responsable no existe: o estan los tres o ninguno.
  ADD CONSTRAINT ck_transacciones_caja_anulacion CHECK (
    (anulado AND motivo_anulacion IS NOT NULL AND fecha_anulacion IS NOT NULL AND usuario_anulacion_id IS NOT NULL)
    OR (NOT anulado AND motivo_anulacion IS NULL AND fecha_anulacion IS NULL AND usuario_anulacion_id IS NULL));

CREATE INDEX ix_transacciones_caja_usuario_anulacion ON tecnifin.transacciones_caja
  (cooperativa_id, usuario_anulacion_id) WHERE usuario_anulacion_id IS NOT NULL;

ALTER TABLE tecnifin.control_caja
  ADD COLUMN saldo_esperado tecnifin.dinero NULL,
  ADD CONSTRAINT ck_control_caja_esperado CHECK (estado = 'CERRADO' OR saldo_esperado IS NULL);

COMMENT ON COLUMN tecnifin.control_caja.saldo_esperado IS
  'Al cerrar: apertura + depositos - retiros no anulados. La diferencia con saldo_cierre es el faltante o sobrante.';
