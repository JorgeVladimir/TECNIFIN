-- 0005_plazo_fijo.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/05_plazo_fijo.sql.
-- Cambios de fondo frente al origen:
--   - DepositoID era PK de texto generada por un procedimiento (usp_GenerarIDDepositoPlazo)
--     apoyado en SecuenciaDPF, una tabla (Anio, Mes) SIN CooperativaId: el correlativo era
--     compartido entre cooperativas. Ahora el codigo 'DPF-AAAAMM-NNNN' se arma sobre
--     tecnifin.siguiente_numero('dpf_AAAAMM'), el unico generador de correlativos del
--     modelo (regla 13). Por eso NO existe una tabla secuencia_dpf: seria una segunda
--     implementacion del mismo mecanismo.
--   - Las tasas pasan de DECIMAL(5,2) a numeric(9,4); los codigos contables punteados
--     ('2.1.03.05') se normalizan a digitos sin puntos (18_fix_formato_codigo_contable.sql).
--   - UsuarioAperturaID / UsuarioLiquidacionID / UsuarioConfigID nacen con FK real hacia
--     usuarios, que es lo que 14_fix_fk_usuario_faltantes.sql tuvo que agregar a posteriori.

CREATE TABLE tecnifin.tasas_plazo_fijo (
  tasa_id                 integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id          integer       NOT NULL,
  codigo_rango            varchar(10)   NOT NULL,
  descripcion_rango       varchar(60)   NOT NULL,
  dias_desde              integer       NOT NULL,
  dias_hasta              integer       NOT NULL,
  tasa_nominal_anual      numeric(9,4)  NOT NULL,
  tasa_maxima_bce         numeric(9,4)  NOT NULL,
  monto_minimo            numeric(18,2) NOT NULL DEFAULT 200.00,
  monto_maximo            numeric(18,2) NULL,
  cuenta_contable_dpf     tecnifin.codigo_contable NOT NULL,
  porcentaje_penalizacion numeric(9,4)  NOT NULL DEFAULT 50.0000,
  activo                  boolean       NOT NULL DEFAULT true,
  fecha_vigencia          date          NOT NULL DEFAULT current_date,
  usuario_config_id       bigint        NULL,
  CONSTRAINT pk_tasas_plazo_fijo PRIMARY KEY (cooperativa_id, tasa_id),
  CONSTRAINT uq_tasas_plazo_fijo_cooperativa_rango UNIQUE (cooperativa_id, codigo_rango),
  CONSTRAINT fk_tasas_plazo_fijo_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT fk_tasas_plazo_fijo_usuario_config FOREIGN KEY (cooperativa_id, usuario_config_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_tasas_plazo_fijo_dias CHECK (dias_desde >= 1 AND dias_hasta >= dias_desde)
);
CREATE INDEX ix_tasas_plazo_fijo_usuario_config ON tecnifin.tasas_plazo_fijo (cooperativa_id, usuario_config_id);
SELECT tecnifin.aplicar_rls('tecnifin.tasas_plazo_fijo');

CREATE TABLE tecnifin.depositos_plazo (
  deposito_id              bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id           integer        NOT NULL,
  codigo                   varchar(20)    NOT NULL,
  socio_id                 bigint         NOT NULL,
  identificacion           varchar(20)    NOT NULL,
  nombre_socio             varchar(200)   NOT NULL,
  num_certificado          varchar(20)    NOT NULL,
  tasa_id                  integer        NOT NULL,
  tasa_nominal_anual       numeric(9,4)   NOT NULL,
  plazo_dias               integer        NOT NULL,
  monto_capital            numeric(18,2)  NOT NULL,
  interes_proyectado       numeric(18,2)  NOT NULL,
  retencion_proyectada     numeric(18,2)  NOT NULL,
  interes_neto_proyectado  numeric(18,2)  NOT NULL,
  -- Fechas de negocio: el plazo se cuenta en dias, no en instantes.
  fecha_apertura           date           NOT NULL DEFAULT current_date,
  fecha_vencimiento        date           NOT NULL,
  estado                   varchar(20)    NOT NULL DEFAULT 'ACTIVO',
  tipo_renovacion          varchar(20)    NOT NULL DEFAULT 'NO_RENOVAR',
  modalidad_pago           varchar(20)    NOT NULL DEFAULT 'AL_VENCIMIENTO',
  cuenta_ahorros_id        bigint         NULL,
  cuenta_contable_dpf      tecnifin.codigo_contable NOT NULL,
  fecha_liquidacion        date           NULL,
  interes_liquidado        numeric(18,2)  NULL,
  retencion_aplicada       numeric(18,2)  NULL,
  interes_neto_liquidado   numeric(18,2)  NULL,
  penalizacion_aplicada    numeric(18,2)  NULL,
  motivos_cancelacion      varchar(400)   NULL,
  numero_renovacion        integer        NOT NULL DEFAULT 0,
  deposito_origen_id       bigint         NULL,
  usuario_apertura_id      bigint         NOT NULL,
  usuario_liquidacion_id   bigint         NULL,
  observaciones            varchar(500)   NULL,
  fecha_creacion           timestamptz(0) NOT NULL DEFAULT now(),
  fecha_modificacion       timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_depositos_plazo PRIMARY KEY (cooperativa_id, deposito_id),
  CONSTRAINT uq_depositos_plazo_cooperativa_codigo UNIQUE (cooperativa_id, codigo),
  CONSTRAINT uq_depositos_plazo_cooperativa_certificado UNIQUE (cooperativa_id, num_certificado),
  CONSTRAINT fk_depositos_plazo_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id),
  CONSTRAINT fk_depositos_plazo_tasa FOREIGN KEY (cooperativa_id, tasa_id)
    REFERENCES tecnifin.tasas_plazo_fijo (cooperativa_id, tasa_id),
  CONSTRAINT fk_depositos_plazo_cuenta_ahorros FOREIGN KEY (cooperativa_id, cuenta_ahorros_id)
    REFERENCES tecnifin.cuentas (cooperativa_id, cuenta_id),
  CONSTRAINT fk_depositos_plazo_origen FOREIGN KEY (cooperativa_id, deposito_origen_id)
    REFERENCES tecnifin.depositos_plazo (cooperativa_id, deposito_id),
  CONSTRAINT fk_depositos_plazo_usuario_apertura FOREIGN KEY (cooperativa_id, usuario_apertura_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT fk_depositos_plazo_usuario_liquidacion FOREIGN KEY (cooperativa_id, usuario_liquidacion_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_depositos_plazo_estado CHECK (estado IN ('ACTIVO','VENCIDO','LIQUIDADO','CANCELADO','RENOVADO')),
  CONSTRAINT ck_depositos_plazo_renovacion CHECK (tipo_renovacion IN ('NO_RENOVAR','AUTOMATICO','MANUAL')),
  CONSTRAINT ck_depositos_plazo_modalidad CHECK (modalidad_pago IN ('AL_VENCIMIENTO','MENSUAL','TRIMESTRAL')),
  CONSTRAINT ck_depositos_plazo_dias CHECK (plazo_dias > 0),
  CONSTRAINT ck_depositos_plazo_capital CHECK (monto_capital > 0),
  CONSTRAINT ck_depositos_plazo_vencimiento CHECK (fecha_vencimiento > fecha_apertura)
);
CREATE INDEX ix_depositos_plazo_socio ON tecnifin.depositos_plazo (cooperativa_id, socio_id);
CREATE INDEX ix_depositos_plazo_tasa ON tecnifin.depositos_plazo (cooperativa_id, tasa_id);
CREATE INDEX ix_depositos_plazo_cuenta_ahorros ON tecnifin.depositos_plazo (cooperativa_id, cuenta_ahorros_id);
CREATE INDEX ix_depositos_plazo_origen ON tecnifin.depositos_plazo (cooperativa_id, deposito_origen_id);
CREATE INDEX ix_depositos_plazo_usuario_apertura ON tecnifin.depositos_plazo (cooperativa_id, usuario_apertura_id);
CREATE INDEX ix_depositos_plazo_usuario_liquidacion ON tecnifin.depositos_plazo (cooperativa_id, usuario_liquidacion_id);
CREATE INDEX ix_depositos_plazo_estado_vencimiento ON tecnifin.depositos_plazo
  (cooperativa_id, estado, fecha_vencimiento);
SELECT tecnifin.aplicar_rls('tecnifin.depositos_plazo');

COMMENT ON COLUMN tecnifin.depositos_plazo.codigo IS
  'Codigo visible del certificado (DPF-AAAAMM-NNNN). Se arma con tecnifin.siguiente_numero(''dpf_AAAAMM'').';
