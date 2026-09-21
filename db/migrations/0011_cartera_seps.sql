-- 0011_cartera_seps.sql -- DAT-02 / hito H1
-- Proceso mensual de reclasificacion de cartera y sus parametros de provision.
-- Traduce db/sqlserver/30_reclasificacion_cartera.sql del sistema anterior.
--
-- Que resuelve el proceso: la clasificacion contable de un credito quedaba congelada en
-- la cuenta con la que se desemboso, asi que una cartera 100% en mora seguia reportando
-- morosidad contable 0%. El proceso mueve los saldos entre familias y bandas del
-- Catalogo Unico y constituye la provision que corresponde a cada calificacion.
--
-- Cambios de fondo frente al origen:
--   - Las tres tablas eran mono-cooperativa. Aqui llevan cooperativa_id, RLS y FORCE:
--     los parametros de provision son de cada COAC (puede constituir POR ENCIMA del
--     minimo de la Resolucion 128-2015-F, y suele hacerlo), y las corridas del proceso
--     no se ven entre cooperativas.
--   - UsuarioId era NVARCHAR(50) sin FK y la aplicacion escribia 'sistema' cuando no
--     habia actor. Aqui es una FK real y NOT NULL: una corrida que mueve el balance
--     regulatorio siempre tiene un responsable con nombre.
--   - La cabecera gana asiento_id: el origen guardaba solo el MONTO provisionado
--     (AsientoProvisionado) y no el asiento, de modo que la reversa no podia enlazarse
--     con lo que habia asentado. Con la FK, deshacer una corrida no obliga a buscar el
--     asiento por fecha y concepto.
--   - CuentaOrigen / CuentaDestino eran texto libre: ahora son FK compuestas contra el
--     plan de cuentas de la propia cooperativa. Una corrida no puede citar una cuenta
--     que no existe.
--
-- Trampas heredadas que este DDL respeta (C:\GUTT_SYSTEM\CLAUDE.md):
--   - Codigos contables sin puntos: lo garantiza el dominio tecnifin.codigo_contable.
--   - Las BANDAS de antiguedad NO viven aqui: se leen de plan_cuentas por familia,
--     porque no son simetricas y cambian por familia (1402 corta en 181-360/>360;
--     1422 en 181-270/>270; 1423 y 1427 tienen SEIS bandas). Ninguna tabla de bandas.
--   - La cartera es la familia 1401..1428, no {14}: {14} es cartera NETA e incluye 1499.

-- ---------------------------------------------------------------------------
-- Dos vocabularios que tienen que ser el MISMO en todas las tablas
-- ---------------------------------------------------------------------------
-- El segmento y la calificacion aparecen en cinco columnas de cuatro tablas. Copiar la
-- lista en cinco CHECK deja la coherencia en manos de quien edite: si el tarifario dijera
-- MICROCREDITO y la provision MICROEMPRESA, la calificacion no encontraria sus parametros
-- y la provision saldria EN CERO sin que nada fallara. Con un dominio la lista se escribe
-- una vez, igual que tecnifin.codigo_contable, y ampliarla es un ALTER DOMAIN.
CREATE DOMAIN tecnifin.segmento_credito AS varchar(20)
  CONSTRAINT ck_segmento_credito CHECK (VALUE IN ('COMERCIAL','CONSUMO','VIVIENDA','MICROEMPRESA'));

-- No se llama calificacion_cartera: ese nombre ya es el de la tabla de DAT-01 y en
-- PostgreSQL tablas y dominios comparten el espacio de nombres del esquema.
CREATE DOMAIN tecnifin.calificacion_riesgo AS varchar(2)
  CONSTRAINT ck_calificacion_riesgo CHECK (VALUE IN ('A1','A2','A3','B1','B2','C1','C2','D','E'));

-- La tabla de DAT-01 pasa a usar el dominio y suelta su CHECK propio: tres copias de la
-- lista habrian sido tres sitios donde diverge.
ALTER TABLE tecnifin.calificacion_cartera
  DROP CONSTRAINT ck_calificacion_cartera_categoria,
  ALTER COLUMN categoria TYPE tecnifin.calificacion_riesgo;

-- ---------------------------------------------------------------------------
-- parametros_provision_cartera: calificacion y provision por segmento y mora
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.parametros_provision_cartera (
  parametro_id         integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id       integer       NOT NULL,
  segmento             tecnifin.segmento_credito    NOT NULL,
  calificacion         tecnifin.calificacion_riesgo NOT NULL,
  dias_mora_desde      integer       NOT NULL,
  -- NULL = sin tope superior (la categoria E no lo tiene).
  dias_mora_hasta      integer       NULL,
  -- FRACCION, no porcentaje: 0.0100 es 1%. Distinto de tasas_credito, donde 14.00 es
  -- 14%. La diferencia esta en el origen y confundirlas mueve la provision por 100.
  porcentaje_provision numeric(9,4)  NOT NULL,
  cuenta_provision     tecnifin.codigo_contable NOT NULL,
  base_normativa       varchar(200)  NULL,
  activo               boolean       NOT NULL DEFAULT true,
  CONSTRAINT pk_parametros_provision_cartera PRIMARY KEY (cooperativa_id, parametro_id),
  CONSTRAINT uq_parametros_provision_cartera_segmento_calificacion
    UNIQUE (cooperativa_id, segmento, calificacion),
  CONSTRAINT fk_parametros_provision_cartera_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  -- La cuenta de provision tiene que existir en el plan de ESA cooperativa: sin esta FK
  -- el proceso generaria asientos contra una cuenta inventada (el origen lo permitia y
  -- por eso 30_*.sql terminaba con una consulta de verificacion manual).
  CONSTRAINT fk_parametros_provision_cartera_cuenta FOREIGN KEY (cooperativa_id, cuenta_provision)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo),
  CONSTRAINT ck_parametros_provision_cartera_dias CHECK (
    dias_mora_desde >= 0 AND (dias_mora_hasta IS NULL OR dias_mora_hasta >= dias_mora_desde)),
  CONSTRAINT ck_parametros_provision_cartera_porcentaje CHECK (
    porcentaje_provision >= 0 AND porcentaje_provision <= 1)
);
CREATE INDEX ix_parametros_provision_cartera_cuenta ON tecnifin.parametros_provision_cartera
  (cooperativa_id, cuenta_provision);
SELECT tecnifin.aplicar_rls('tecnifin.parametros_provision_cartera');

COMMENT ON COLUMN tecnifin.parametros_provision_cartera.porcentaje_provision IS
  'Fraccion: 0.0100 = 1%. Minimo de la Resolucion 128-2015-F; cada cooperativa puede subirlo.';

-- ---------------------------------------------------------------------------
-- reclasificacion_cartera: una fila por corrida del proceso
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.reclasificacion_cartera (
  proceso_id             bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id         integer       NOT NULL,
  fecha_corte            date          NOT NULL,
  -- Simular es lo predeterminado; aplicar es un acto explicito y deja asiento.
  estado                 varchar(20)   NOT NULL DEFAULT 'SIMULADO',
  usuario_id             bigint        NOT NULL,
  fecha_ejecucion        timestamptz(0) NOT NULL DEFAULT now(),
  operaciones_evaluadas  integer       NOT NULL DEFAULT 0,
  monto_reclasificado    numeric(18,2) NOT NULL DEFAULT 0,
  cartera_bruta          numeric(18,2) NOT NULL DEFAULT 0,
  cartera_improductiva   numeric(18,2) NOT NULL DEFAULT 0,
  provision_requerida    numeric(18,2) NOT NULL DEFAULT 0,
  provision_constituida  numeric(18,2) NOT NULL DEFAULT 0,
  provision_contabilizada numeric(18,2) NOT NULL DEFAULT 0,
  -- El asiento que genero la corrida (NULL en una simulacion y en una corrida sin
  -- movimiento). Es lo que el origen no guardaba.
  asiento_id             bigint        NULL,
  -- Presente solo en la fila de reversa; apunta a la corrida que deshace.
  reversa_de_proceso_id  bigint        NULL,
  observaciones          varchar(500)  NULL,
  CONSTRAINT pk_reclasificacion_cartera PRIMARY KEY (cooperativa_id, proceso_id),
  CONSTRAINT fk_reclasificacion_cartera_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT fk_reclasificacion_cartera_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT fk_reclasificacion_cartera_asiento FOREIGN KEY (cooperativa_id, asiento_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id),
  CONSTRAINT fk_reclasificacion_cartera_reversa FOREIGN KEY (cooperativa_id, reversa_de_proceso_id)
    REFERENCES tecnifin.reclasificacion_cartera (cooperativa_id, proceso_id),
  CONSTRAINT ck_reclasificacion_cartera_estado CHECK (estado IN ('SIMULADO','APLICADO','REVERSADO')),
  -- Una simulacion no asienta: si tiene asiento, es porque se aplico.
  CONSTRAINT ck_reclasificacion_cartera_simulado CHECK (estado <> 'SIMULADO' OR asiento_id IS NULL),
  CONSTRAINT ck_reclasificacion_cartera_reversa CHECK (
    reversa_de_proceso_id IS NULL OR estado = 'REVERSADO'),
  CONSTRAINT ck_reclasificacion_cartera_no_autoreversa CHECK (
    reversa_de_proceso_id IS DISTINCT FROM proceso_id)
);
CREATE INDEX ix_reclasificacion_cartera_corte ON tecnifin.reclasificacion_cartera
  (cooperativa_id, fecha_corte, estado);
CREATE INDEX ix_reclasificacion_cartera_usuario ON tecnifin.reclasificacion_cartera
  (cooperativa_id, usuario_id);
CREATE INDEX ix_reclasificacion_cartera_asiento ON tecnifin.reclasificacion_cartera
  (cooperativa_id, asiento_id);
-- Candado de idempotencia: una sola corrida APLICADA por fecha de corte y cooperativa.
-- Sin el, correr dos veces el proceso duplicaria los asientos de provision. Reversar
-- pone el original en REVERSADO, con lo que el corte vuelve a quedar libre.
CREATE UNIQUE INDEX ux_reclasificacion_cartera_corte_aplicado ON tecnifin.reclasificacion_cartera
  (cooperativa_id, fecha_corte) WHERE estado = 'APLICADO';
-- Y una corrida se reversa una sola vez.
CREATE UNIQUE INDEX ux_reclasificacion_cartera_reversa ON tecnifin.reclasificacion_cartera
  (cooperativa_id, reversa_de_proceso_id) WHERE reversa_de_proceso_id IS NOT NULL;
SELECT tecnifin.aplicar_rls('tecnifin.reclasificacion_cartera');

COMMENT ON TABLE tecnifin.reclasificacion_cartera IS
  'Corridas del proceso mensual de cartera. SIMULADO es el estado por defecto: aplicar es explicito.';

-- ---------------------------------------------------------------------------
-- reclasificacion_cartera_detalle: cuenta origen -> cuenta destino, por renglon
-- ---------------------------------------------------------------------------
-- La reversa reconstruye los movimientos DESDE ESTE DETALLE, no los recalcula: tiene
-- que deshacer exactamente lo que se asento, aunque los vencimientos hayan cambiado
-- desde entonces. Por eso el detalle es parte del dato, no un log.
CREATE TABLE tecnifin.reclasificacion_cartera_detalle (
  detalle_id      bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  proceso_id      bigint        NOT NULL,
  tipo            varchar(20)   NOT NULL,
  segmento        tecnifin.segmento_credito    NULL,
  cuenta_origen   tecnifin.codigo_contable NULL,
  cuenta_destino  tecnifin.codigo_contable NULL,
  estado_destino  varchar(30)   NULL,
  -- Texto de la banda tal como la nombra el plan de cuentas ('De 91 a 270 dias').
  banda_destino   varchar(40)   NULL,
  calificacion    tecnifin.calificacion_riesgo NULL,
  operaciones     integer       NOT NULL DEFAULT 0,
  -- Con signo: negativo es una salida de la cuenta. La reversa lo invierte.
  monto           numeric(18,2) NOT NULL,
  CONSTRAINT pk_reclasificacion_cartera_detalle PRIMARY KEY (cooperativa_id, detalle_id),
  CONSTRAINT fk_reclasificacion_cartera_detalle_proceso FOREIGN KEY (cooperativa_id, proceso_id)
    REFERENCES tecnifin.reclasificacion_cartera (cooperativa_id, proceso_id) ON DELETE CASCADE,
  CONSTRAINT fk_reclasificacion_cartera_detalle_origen FOREIGN KEY (cooperativa_id, cuenta_origen)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo),
  CONSTRAINT fk_reclasificacion_cartera_detalle_destino FOREIGN KEY (cooperativa_id, cuenta_destino)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, codigo),
  CONSTRAINT ck_reclasificacion_cartera_detalle_tipo CHECK (tipo IN ('RECLASIFICACION','PROVISION')),
  -- Un renglon sin ninguna cuenta no dice nada y no se podria reversar.
  CONSTRAINT ck_reclasificacion_cartera_detalle_cuentas CHECK (
    cuenta_origen IS NOT NULL OR cuenta_destino IS NOT NULL)
);
CREATE INDEX ix_reclasificacion_cartera_detalle_proceso ON tecnifin.reclasificacion_cartera_detalle
  (cooperativa_id, proceso_id, tipo);
CREATE INDEX ix_reclasificacion_cartera_detalle_origen ON tecnifin.reclasificacion_cartera_detalle
  (cooperativa_id, cuenta_origen);
CREATE INDEX ix_reclasificacion_cartera_detalle_destino ON tecnifin.reclasificacion_cartera_detalle
  (cooperativa_id, cuenta_destino);
SELECT tecnifin.aplicar_rls('tecnifin.reclasificacion_cartera_detalle');
