-- 0006_caja.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/06_caja.sql.
-- Cambios de fondo frente al origen:
--   - UC_ControlCaja_Usuario_Fecha UNIQUE (UsuarioId, Fecha) era correcto solo porque
--     UsuarioId era global. Al volverse el usuario propio de cada cooperativa, el unico
--     pasa a (cooperativa_id, usuario_id, fecha).
--   - TransaccionesCaja, Denominaciones y DetalleEfectivoTransaccion no tenian
--     CooperativaId: las tres lo reciben. Denominaciones deja de ser catalogo global:
--     cada cooperativa siembra y habilita las suyas al darse de alta, y asi la prueba
--     de catalogo de RLS no necesita excepciones en tablas de operacion.

CREATE TABLE tecnifin.control_caja (
  control_id     bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id integer        NOT NULL,
  usuario_id     bigint         NOT NULL,
  fecha          date           NOT NULL,
  hora_apertura  timestamptz(0) NOT NULL DEFAULT now(),
  hora_cierre    timestamptz(0) NULL,
  saldo_apertura numeric(18,2)  NOT NULL,
  saldo_cierre   numeric(18,2)  NULL,
  estado         varchar(20)    NOT NULL DEFAULT 'ABIERTO',
  CONSTRAINT pk_control_caja PRIMARY KEY (cooperativa_id, control_id),
  CONSTRAINT uq_control_caja_usuario_fecha UNIQUE (cooperativa_id, usuario_id, fecha),
  CONSTRAINT fk_control_caja_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_control_caja_estado CHECK (estado IN ('ABIERTO','CERRADO')),
  CONSTRAINT ck_control_caja_cierre CHECK (
    (estado = 'ABIERTO' AND hora_cierre IS NULL AND saldo_cierre IS NULL)
    OR (estado = 'CERRADO' AND hora_cierre IS NOT NULL AND saldo_cierre IS NOT NULL))
);
SELECT tecnifin.aplicar_rls('tecnifin.control_caja');

CREATE TABLE tecnifin.transacciones_caja (
  transaccion_id      bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id      integer        NOT NULL,
  control_caja_id     bigint         NOT NULL,
  socio_id            bigint         NOT NULL,
  -- Solo se llena el enlace que aplique segun tipo_operacion; los otros quedan NULL.
  cuenta_id           bigint         NULL,
  credito_id          bigint         NULL,
  deposito_plazo_id   bigint         NULL,
  tipo_operacion      varchar(50)    NOT NULL,
  monto               numeric(18,2)  NOT NULL,
  anulado             boolean        NOT NULL DEFAULT false,
  fecha_hora          timestamptz(0) NOT NULL DEFAULT now(),
  usuario_id          bigint         NOT NULL,
  -- La FK a asientos_contables se agrega en 0009 (esa tabla aun no existe aqui).
  asiento_contable_id bigint         NULL,
  CONSTRAINT pk_transacciones_caja PRIMARY KEY (cooperativa_id, transaccion_id),
  CONSTRAINT fk_transacciones_caja_control FOREIGN KEY (cooperativa_id, control_caja_id)
    REFERENCES tecnifin.control_caja (cooperativa_id, control_id),
  CONSTRAINT fk_transacciones_caja_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id),
  CONSTRAINT fk_transacciones_caja_cuenta FOREIGN KEY (cooperativa_id, cuenta_id)
    REFERENCES tecnifin.cuentas (cooperativa_id, cuenta_id),
  CONSTRAINT fk_transacciones_caja_credito FOREIGN KEY (cooperativa_id, credito_id)
    REFERENCES tecnifin.creditos (cooperativa_id, credito_id),
  CONSTRAINT fk_transacciones_caja_deposito FOREIGN KEY (cooperativa_id, deposito_plazo_id)
    REFERENCES tecnifin.depositos_plazo (cooperativa_id, deposito_id),
  CONSTRAINT fk_transacciones_caja_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_transacciones_caja_monto CHECK (monto > 0)
);
CREATE INDEX ix_transacciones_caja_control ON tecnifin.transacciones_caja (cooperativa_id, control_caja_id);
CREATE INDEX ix_transacciones_caja_socio ON tecnifin.transacciones_caja (cooperativa_id, socio_id);
CREATE INDEX ix_transacciones_caja_cuenta ON tecnifin.transacciones_caja (cooperativa_id, cuenta_id);
CREATE INDEX ix_transacciones_caja_credito ON tecnifin.transacciones_caja (cooperativa_id, credito_id);
CREATE INDEX ix_transacciones_caja_deposito ON tecnifin.transacciones_caja (cooperativa_id, deposito_plazo_id);
CREATE INDEX ix_transacciones_caja_usuario ON tecnifin.transacciones_caja (cooperativa_id, usuario_id);
CREATE INDEX ix_transacciones_caja_fecha ON tecnifin.transacciones_caja (cooperativa_id, fecha_hora DESC);
SELECT tecnifin.aplicar_rls('tecnifin.transacciones_caja');

-- Denominaciones del USD. El circulante es nacional, pero la tabla lleva tenant para
-- que cada cooperativa pueda deshabilitar una denominacion sin afectar a las demas y
-- para que ninguna tabla de operacion quede fuera de RLS (ADR-0003, decision de DAT-01).
CREATE TABLE tecnifin.denominaciones (
  cooperativa_id      integer       NOT NULL,
  codigo_denominacion varchar(10)   NOT NULL,
  valor               numeric(18,2) NOT NULL,
  tipo                varchar(10)   NOT NULL,
  descripcion         varchar(50)   NOT NULL,
  activa              boolean       NOT NULL DEFAULT true,
  CONSTRAINT pk_denominaciones PRIMARY KEY (cooperativa_id, codigo_denominacion),
  CONSTRAINT fk_denominaciones_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_denominaciones_tipo CHECK (tipo IN ('BILLETE','MONEDA')),
  CONSTRAINT ck_denominaciones_valor CHECK (valor > 0)
);
SELECT tecnifin.aplicar_rls('tecnifin.denominaciones');

CREATE TABLE tecnifin.detalle_efectivo_transaccion (
  detalle_id          bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id      integer       NOT NULL,
  transaccion_id      bigint        NOT NULL,
  codigo_denominacion varchar(10)   NOT NULL,
  cantidad            integer       NOT NULL,
  total               numeric(18,2) NOT NULL,
  CONSTRAINT pk_detalle_efectivo_transaccion PRIMARY KEY (cooperativa_id, detalle_id),
  CONSTRAINT uq_detalle_efectivo_transaccion_denominacion
    UNIQUE (cooperativa_id, transaccion_id, codigo_denominacion),
  CONSTRAINT fk_detalle_efectivo_transaccion FOREIGN KEY (cooperativa_id, transaccion_id)
    REFERENCES tecnifin.transacciones_caja (cooperativa_id, transaccion_id) ON DELETE CASCADE,
  CONSTRAINT fk_detalle_efectivo_denominacion FOREIGN KEY (cooperativa_id, codigo_denominacion)
    REFERENCES tecnifin.denominaciones (cooperativa_id, codigo_denominacion),
  CONSTRAINT ck_detalle_efectivo_cantidad CHECK (cantidad > 0)
);
CREATE INDEX ix_detalle_efectivo_denominacion ON tecnifin.detalle_efectivo_transaccion
  (cooperativa_id, codigo_denominacion);
SELECT tecnifin.aplicar_rls('tecnifin.detalle_efectivo_transaccion');
