-- 0003_cuentas_productos.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/03_cuentas_productos.sql.
-- Cambios de fondo frente al origen:
--   - Cuentas.NumeroCuenta era UNIQUE GLOBAL: la numeracion de una cooperativa podia
--     chocar con la de otra y el error revelaba que la otra existe. Pasa a correlativo
--     por cooperativa desde 1 (decision de Jorge, 2026-09-20) con unico por tenant.
--   - Cuentas y MovimientosCuenta no tenian CooperativaId: lo reciben.
--   - Los codigos contables de ProductosFinancieros quedan varchar(15) de solo digitos,
--     formato canonico sin puntos (18_fix_formato_codigo_contable.sql). La FK real contra
--     plan_cuentas se declara en 0009, cuando el catalogo ya existe.

CREATE TABLE tecnifin.productos_financieros (
  producto_id                integer      GENERATED ALWAYS AS IDENTITY,
  cooperativa_id             integer      NOT NULL,
  codigo_producto            integer      NOT NULL,
  nombre                     varchar(100) NOT NULL,
  tipo_deposito              varchar(100) NOT NULL,
  es_certificado             boolean      NOT NULL DEFAULT false,
  cuenta_activa              tecnifin.codigo_contable NOT NULL,
  cuenta_inactiva            tecnifin.codigo_contable NOT NULL,
  cuenta_gasto               tecnifin.codigo_contable NULL,
  cuenta_provision           tecnifin.codigo_contable NULL,
  cuenta_depositos_confirmar tecnifin.codigo_contable NULL,
  num_ctas_4_dig             integer      NOT NULL DEFAULT 28,
  permite_depositos          boolean      NOT NULL DEFAULT true,
  permite_retiros            boolean      NOT NULL DEFAULT true,
  permite_debitos            boolean      NOT NULL DEFAULT true,
  permite_creditos           boolean      NOT NULL DEFAULT true,
  permite_transferencias     boolean      NOT NULL DEFAULT true,
  tasa                       varchar(50)  NOT NULL DEFAULT 'TASA NOMINAL',
  forma_pago                 varchar(100) NOT NULL DEFAULT 'MOVIMIENTO HISTORICO PONDERADO BASE',
  meses_acreditacion         varchar(100) NOT NULL DEFAULT 'Diciembre',
  CONSTRAINT pk_productos_financieros PRIMARY KEY (cooperativa_id, producto_id),
  CONSTRAINT uq_productos_financieros_cooperativa_codigo UNIQUE (cooperativa_id, codigo_producto),
  CONSTRAINT fk_productos_financieros_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id)
);
SELECT tecnifin.aplicar_rls('tecnifin.productos_financieros');

CREATE TABLE tecnifin.cuentas (
  cuenta_id              bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id         integer       NOT NULL,
  socio_id               bigint        NOT NULL,
  numero_cuenta          bigint        NOT NULL DEFAULT tecnifin.siguiente_numero('cuenta'),
  numero_cuenta_anterior varchar(20)   NULL,
  producto_id            integer       NOT NULL,
  saldo                  numeric(18,2) NOT NULL DEFAULT 0.00,
  fecha_apertura         date          NOT NULL DEFAULT current_date,
  estado                 varchar(20)   NOT NULL DEFAULT 'ACTIVA',
  CONSTRAINT pk_cuentas PRIMARY KEY (cooperativa_id, cuenta_id),
  CONSTRAINT uq_cuentas_cooperativa_numero UNIQUE (cooperativa_id, numero_cuenta),
  CONSTRAINT fk_cuentas_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id),
  CONSTRAINT fk_cuentas_producto FOREIGN KEY (cooperativa_id, producto_id)
    REFERENCES tecnifin.productos_financieros (cooperativa_id, producto_id),
  CONSTRAINT ck_cuentas_estado CHECK (estado IN ('ACTIVA','INACTIVA','BLOQUEADA','CERRADA')),
  CONSTRAINT ck_cuentas_numero CHECK (numero_cuenta > 0)
);
CREATE INDEX ix_cuentas_socio ON tecnifin.cuentas (cooperativa_id, socio_id);
CREATE INDEX ix_cuentas_producto ON tecnifin.cuentas (cooperativa_id, producto_id);
SELECT tecnifin.aplicar_rls('tecnifin.cuentas');

COMMENT ON COLUMN tecnifin.cuentas.numero_cuenta_anterior IS
  'Numero de cuenta en el sistema de origen. Dato de migracion (MIG-01); el numero vigente es numero_cuenta.';

CREATE TABLE tecnifin.movimientos_cuenta (
  movimiento_id       bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id      integer        NOT NULL,
  cuenta_id           bigint         NOT NULL,
  tipo                varchar(30)    NOT NULL,
  monto               numeric(18,2)  NOT NULL,
  saldo_resultante    numeric(18,2)  NOT NULL,
  concepto            varchar(200)   NULL,
  fecha               timestamptz(0) NOT NULL DEFAULT now(),
  usuario_id          bigint         NOT NULL,
  -- Las FK a transacciones_caja y asientos_contables se agregan en 0009: esas tablas
  -- todavia no existen en este punto (igual que en 09_relaciones_cruzadas.sql).
  transaccion_caja_id bigint         NULL,
  asiento_contable_id bigint         NULL,
  CONSTRAINT pk_movimientos_cuenta PRIMARY KEY (cooperativa_id, movimiento_id),
  CONSTRAINT fk_movimientos_cuenta_cuenta FOREIGN KEY (cooperativa_id, cuenta_id)
    REFERENCES tecnifin.cuentas (cooperativa_id, cuenta_id),
  CONSTRAINT fk_movimientos_cuenta_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_movimientos_cuenta_tipo CHECK (tipo IN
    ('DEPOSITO','RETIRO','TRANSFERENCIA_ENTRADA','TRANSFERENCIA_SALIDA','AJUSTE')),
  CONSTRAINT ck_movimientos_cuenta_monto CHECK (monto > 0)
);
-- cooperativa_id al frente en las tablas grandes: es el predicado que RLS agrega a
-- cada consulta (ADR-0002, vecino ruidoso).
CREATE INDEX ix_movimientos_cuenta_cuenta_fecha ON tecnifin.movimientos_cuenta
  (cooperativa_id, cuenta_id, fecha DESC);
CREATE INDEX ix_movimientos_cuenta_usuario ON tecnifin.movimientos_cuenta (cooperativa_id, usuario_id);
SELECT tecnifin.aplicar_rls('tecnifin.movimientos_cuenta');
