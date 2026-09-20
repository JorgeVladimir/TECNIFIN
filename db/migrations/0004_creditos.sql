-- 0004_creditos.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/04_creditos.sql mas 19_fix_solicitudescredito_decision.sql
-- (quien aprobo y cuando: es trazabilidad exigida por la SEPS y no puede vivir solo
-- en el log de auditoria).
-- Cambios de fondo frente al origen:
--   - SolicitudID / CreditoID eran PK de TEXTO generadas por la aplicacion y unicas de
--     forma GLOBAL: su generacion era una carrera entre cooperativas. Pasan a PK
--     subrogada bigint; el codigo visible ('CRED-0001') se conserva como codigo de
--     negocio con unico (cooperativa_id, codigo) -- supuesto (c) pendiente de Jorge.
--   - TablaAmortizacion, RubrosCreditos y CalificacionCartera no tenian CooperativaId.
--   - FechaPago / FechaVencimiento eran NVARCHAR(50): pasan a date. El vencimiento real
--     del sistema viejo se calcula con DATEADD(MONTH, cuota, FechaDesembolso).
--   - Las tasas pasan de DECIMAL(5,2) a numeric(9,4) (supuesto (b) pendiente de Jorge:
--     es superset, no altera ningun valor ya existente, pero habilita 4 decimales).

CREATE TABLE tecnifin.solicitudes_credito (
  solicitud_id                bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id              integer        NOT NULL,
  codigo                      varchar(50)    NOT NULL,
  socio_id                    bigint         NOT NULL,
  identificacion              varchar(20)    NOT NULL,
  monto                       numeric(18,2)  NOT NULL,
  saldo                       numeric(18,2)  NOT NULL,
  tasa                        numeric(9,4)   NOT NULL,
  plazo                       integer        NOT NULL,
  tipo                        varchar(100)   NOT NULL,
  estado                      varchar(30)    NOT NULL DEFAULT 'SOLICITADO',
  fecha_solicitud             timestamptz(0) NOT NULL DEFAULT now(),
  fecha_vencimiento           date           NULL,
  observaciones               varchar(500)   NULL,
  plan_pagos                  text           NULL,
  garantia_info               text           NULL,
  origen                      varchar(50)    NULL,
  tipo_prenda                 varchar(100)   NULL,
  avaluo_prendario            numeric(18,2)  NULL,
  observacion_tecnica_prenda  varchar(500)   NULL,
  valor_cobertura             numeric(18,2)  NULL,
  tipo_aprobacion             varchar(50)    NULL,
  acta_sesion                 varchar(100)   NULL,
  scoring_score               integer        NULL,
  descuentos_desembolso       text           NULL,
  usuario_decision_id         bigint         NULL,
  fecha_decision              timestamptz(0) NULL,
  CONSTRAINT pk_solicitudes_credito PRIMARY KEY (cooperativa_id, solicitud_id),
  CONSTRAINT uq_solicitudes_credito_cooperativa_codigo UNIQUE (cooperativa_id, codigo),
  CONSTRAINT fk_solicitudes_credito_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id),
  CONSTRAINT fk_solicitudes_credito_usuario_decision FOREIGN KEY (cooperativa_id, usuario_decision_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_solicitudes_credito_estado CHECK (estado IN
    ('SOLICITADO','EN_ANALISIS','APROBADO','RECHAZADO','DESEMBOLSADO','ANULADO')),
  CONSTRAINT ck_solicitudes_credito_monto CHECK (monto > 0),
  CONSTRAINT ck_solicitudes_credito_plazo CHECK (plazo > 0),
  CONSTRAINT ck_solicitudes_credito_tasa CHECK (tasa >= 0),
  -- Estado final sin rastro de quien decidio es el hueco que 19_fix cerro en el viejo.
  CONSTRAINT ck_solicitudes_credito_decision CHECK (
    estado NOT IN ('APROBADO','RECHAZADO') OR (usuario_decision_id IS NOT NULL AND fecha_decision IS NOT NULL))
);
CREATE INDEX ix_solicitudes_credito_socio ON tecnifin.solicitudes_credito (cooperativa_id, socio_id);
CREATE INDEX ix_solicitudes_credito_usuario_decision ON tecnifin.solicitudes_credito (cooperativa_id, usuario_decision_id);
CREATE INDEX ix_solicitudes_credito_estado ON tecnifin.solicitudes_credito (cooperativa_id, estado);
SELECT tecnifin.aplicar_rls('tecnifin.solicitudes_credito');

CREATE TABLE tecnifin.creditos (
  credito_id                 bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id             integer       NOT NULL,
  codigo                     varchar(50)   NOT NULL,
  solicitud_id               bigint        NOT NULL,
  socio_id                   bigint        NOT NULL,
  monto                      numeric(18,2) NOT NULL,
  saldo                      numeric(18,2) NOT NULL,
  tasa                       numeric(9,4)  NOT NULL,
  plazo                      integer       NOT NULL,
  tipo                       varchar(100)  NOT NULL,
  estado                     varchar(30)   NOT NULL,
  -- date, no timestamptz: la tabla de amortizacion se calcula a partir de esta fecha
  -- y un cambio de zona horaria del servidor moveria las cuotas de dia.
  fecha_desembolso           date          NOT NULL DEFAULT current_date,
  fecha_vencimiento          date          NULL,
  tipo_aprobacion            varchar(50)   NULL,
  acta_sesion                varchar(100)  NULL,
  tipo_prenda                varchar(100)  NULL,
  avaluo_prendario           numeric(18,2) NULL,
  observacion_tecnica_prenda varchar(500)  NULL,
  valor_cobertura            numeric(18,2) NULL,
  CONSTRAINT pk_creditos PRIMARY KEY (cooperativa_id, credito_id),
  CONSTRAINT uq_creditos_cooperativa_codigo UNIQUE (cooperativa_id, codigo),
  CONSTRAINT uq_creditos_solicitud UNIQUE (cooperativa_id, solicitud_id),
  CONSTRAINT fk_creditos_solicitud FOREIGN KEY (cooperativa_id, solicitud_id)
    REFERENCES tecnifin.solicitudes_credito (cooperativa_id, solicitud_id),
  CONSTRAINT fk_creditos_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id),
  CONSTRAINT ck_creditos_estado CHECK (estado IN ('VIGENTE','CANCELADO','CASTIGADO','REFINANCIADO','REESTRUCTURADO')),
  CONSTRAINT ck_creditos_monto CHECK (monto > 0),
  CONSTRAINT ck_creditos_saldo CHECK (saldo >= 0)
);
CREATE INDEX ix_creditos_socio ON tecnifin.creditos (cooperativa_id, socio_id);
CREATE INDEX ix_creditos_estado ON tecnifin.creditos (cooperativa_id, estado);
SELECT tecnifin.aplicar_rls('tecnifin.creditos');

CREATE TABLE tecnifin.tabla_amortizacion (
  amortizacion_id        bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id         integer       NOT NULL,
  credito_id             bigint        NOT NULL,
  numero_cuota           integer       NOT NULL,
  fecha_pago             date          NOT NULL,
  capital                numeric(18,2) NOT NULL,
  interes                numeric(18,2) NOT NULL,
  interes_devengado      numeric(18,2) NULL,
  interes_pagado         numeric(18,2) NULL,
  seguro_desgravamen     numeric(18,2) NOT NULL DEFAULT 0.00,
  contribucion_solca     numeric(18,2) NOT NULL DEFAULT 0.00,
  gastos_administrativos numeric(18,2) NOT NULL DEFAULT 0.00,
  total                  numeric(18,2) NOT NULL,
  estado                 varchar(20)   NOT NULL DEFAULT 'PENDIENTE',
  CONSTRAINT pk_tabla_amortizacion PRIMARY KEY (cooperativa_id, amortizacion_id),
  CONSTRAINT uq_tabla_amortizacion_credito_cuota UNIQUE (cooperativa_id, credito_id, numero_cuota),
  CONSTRAINT fk_tabla_amortizacion_credito FOREIGN KEY (cooperativa_id, credito_id)
    REFERENCES tecnifin.creditos (cooperativa_id, credito_id) ON DELETE CASCADE,
  CONSTRAINT ck_tabla_amortizacion_estado CHECK (estado IN ('PENDIENTE','PAGADA','VENCIDA','CASTIGADA')),
  CONSTRAINT ck_tabla_amortizacion_cuota CHECK (numero_cuota > 0)
);
-- 13_fix_indices_fk_faltantes.sql encontro esta FK sin indice y la marco como el caso
-- urgente. Aqui nace indexada (ADR-0003, regla transversal 8).
CREATE INDEX ix_tabla_amortizacion_vencimiento ON tecnifin.tabla_amortizacion
  (cooperativa_id, estado, fecha_pago);
SELECT tecnifin.aplicar_rls('tecnifin.tabla_amortizacion');

CREATE TABLE tecnifin.rubros_creditos (
  rubro_id        bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  amortizacion_id bigint        NOT NULL,
  nombre_rubro    varchar(50)   NOT NULL,
  monto           numeric(18,2) NOT NULL,
  estado          varchar(20)   NOT NULL DEFAULT 'PENDIENTE',
  CONSTRAINT pk_rubros_creditos PRIMARY KEY (cooperativa_id, rubro_id),
  CONSTRAINT fk_rubros_creditos_amortizacion FOREIGN KEY (cooperativa_id, amortizacion_id)
    REFERENCES tecnifin.tabla_amortizacion (cooperativa_id, amortizacion_id) ON DELETE CASCADE,
  CONSTRAINT ck_rubros_creditos_estado CHECK (estado IN ('PENDIENTE','PAGADO','ANULADO'))
);
CREATE INDEX ix_rubros_creditos_amortizacion ON tecnifin.rubros_creditos (cooperativa_id, amortizacion_id);
SELECT tecnifin.aplicar_rls('tecnifin.rubros_creditos');

-- Calificacion de cartera y provisiones (requisito de la SEPS).
-- El porcentaje de provision es un dato parametrico, nunca una constante en codigo.
CREATE TABLE tecnifin.calificacion_cartera (
  calificacion_id      bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id       integer       NOT NULL,
  credito_id           bigint        NOT NULL,
  fecha_corte          date          NOT NULL,
  saldo_capital        numeric(18,2) NOT NULL,
  dias_mora            integer       NOT NULL DEFAULT 0,
  -- varchar y no char(2): con char, 'D' y 'D ' son el mismo valor y eso esconde datos sucios.
  categoria            varchar(2)    NOT NULL,
  porcentaje_provision numeric(9,4)  NOT NULL DEFAULT 0,
  valor_provision      numeric(18,2) NOT NULL DEFAULT 0,
  CONSTRAINT pk_calificacion_cartera PRIMARY KEY (cooperativa_id, calificacion_id),
  CONSTRAINT uq_calificacion_cartera_credito_corte UNIQUE (cooperativa_id, credito_id, fecha_corte),
  CONSTRAINT fk_calificacion_cartera_credito FOREIGN KEY (cooperativa_id, credito_id)
    REFERENCES tecnifin.creditos (cooperativa_id, credito_id),
  CONSTRAINT ck_calificacion_cartera_categoria CHECK (categoria IN ('A1','A2','A3','B1','B2','C1','C2','D','E')),
  CONSTRAINT ck_calificacion_cartera_dias CHECK (dias_mora >= 0)
);
CREATE INDEX ix_calificacion_cartera_corte ON tecnifin.calificacion_cartera (cooperativa_id, fecha_corte);
SELECT tecnifin.aplicar_rls('tecnifin.calificacion_cartera');
