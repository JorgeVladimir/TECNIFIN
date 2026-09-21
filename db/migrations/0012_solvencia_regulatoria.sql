-- 0012_solvencia_regulatoria.sql -- DAT-02 / hito H1
-- Solvencia regulatoria REAL (patrimonio tecnico constituido / activos ponderados por
-- riesgo), no la aproximacion Patrimonio / Activo.
-- Traduce db/sqlserver/31_ponderaciones_riesgo_solvencia.sql del sistema anterior.
--
-- Todo es parametrico en tabla y nunca constante en codigo (regla 5): cuando la SEPS
-- mueve una ponderacion o un limite se edita el dato y no se recompila nada. Cada fila
-- lleva su base normativa para que una revision pueda auditar de donde sale.
--
-- Cambios de fondo frente al origen:
--   - Las tres tablas eran mono-cooperativa. Aqui llevan cooperativa_id, RLS y FORCE.
--     No es burocracia: dos COAC pueden estar en periodos de transicion distintos de la
--     misma norma, y el limite de solvencia de una no puede mover el de la otra.
--   - ParametrosRegulatorios tenia PK Clave (global). Ahora es (cooperativa_id, clave),
--     como parametros_plataforma pero dentro del tenant.
--
-- Resolucion de la ponderacion: gana el PREFIJO MAS LARGO que calce con el codigo
-- contable. Por eso 149915 (provision de vivienda) puede ponderar 40% mientras el resto
-- de 1499 pondera 100%. La consulta ordena por length(prefijo_cuenta) DESC y toma la
-- primera; no hay una tabla de excepciones aparte.

-- ---------------------------------------------------------------------------
-- ponderaciones_riesgo: peso de cada familia de activo dentro de los APR
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.ponderaciones_riesgo (
  ponderacion_id  integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  -- Prefijo de codigo contable, no necesariamente una cuenta existente: '14' pondera
  -- toda la cartera. Por eso lleva el dominio (digitos, sin puntos) pero no FK.
  prefijo_cuenta  tecnifin.codigo_contable NOT NULL,
  -- FRACCION: 0.2000 es 20%.
  ponderacion     numeric(9,4)  NOT NULL,
  categoria       varchar(60)   NOT NULL,
  descripcion     varchar(200)  NULL,
  base_normativa  varchar(200)  NULL,
  activo          boolean       NOT NULL DEFAULT true,
  CONSTRAINT pk_ponderaciones_riesgo PRIMARY KEY (cooperativa_id, ponderacion_id),
  CONSTRAINT uq_ponderaciones_riesgo_prefijo UNIQUE (cooperativa_id, prefijo_cuenta),
  CONSTRAINT fk_ponderaciones_riesgo_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_ponderaciones_riesgo_valor CHECK (ponderacion >= 0 AND ponderacion <= 1)
);
-- Sin indice por longitud de prefijo a proposito: el calce es codigo LIKE prefijo || '%',
-- que se evalua fila a fila, y son unas decenas de filas por cooperativa. Un indice ahi
-- no evitaria el barrido y se pagaria en cada escritura.
SELECT tecnifin.aplicar_rls('tecnifin.ponderaciones_riesgo');

COMMENT ON COLUMN tecnifin.ponderaciones_riesgo.prefijo_cuenta IS
  'Prefijo del codigo contable. Gana el mas largo que calce: 149915 antes que 1499 y que 14.';

-- ---------------------------------------------------------------------------
-- parametros_patrimonio_tecnico: composicion del PTC
-- ---------------------------------------------------------------------------
-- saldo_como dice con que signo se lee la cuenta y evita el error clasico de sumar dos
-- veces una perdida:
--   ACREEDOR = haber - debe (capital, reservas, provision general de cartera)
--   DEUDOR   = debe - haber (perdidas acumuladas, plusvalia mercantil)
-- Las DEDUCCION se leen siempre DEUDOR y se RESTAN; por eso 3602 y 3604 no estan
-- incluidas en ningun prefijo del PRIMARIO.
CREATE TABLE tecnifin.parametros_patrimonio_tecnico (
  parametro_id    integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  componente      varchar(20)   NOT NULL,
  prefijo_cuenta  tecnifin.codigo_contable NOT NULL,
  -- FRACCION: 0.5000 significa que la cuenta computa al 50%.
  factor          numeric(9,4)  NOT NULL DEFAULT 1,
  saldo_como      varchar(10)   NOT NULL DEFAULT 'ACREEDOR',
  -- Tope como fraccion de los APR; NULL = sin tope. La provision general de cartera
  -- (149930) computa como secundario solo hasta el 1.25% de los APR.
  limite_pct_apr  numeric(9,4)  NULL,
  descripcion     varchar(200)  NULL,
  base_normativa  varchar(200)  NULL,
  activo          boolean       NOT NULL DEFAULT true,
  CONSTRAINT pk_parametros_patrimonio_tecnico PRIMARY KEY (cooperativa_id, parametro_id),
  CONSTRAINT uq_parametros_patrimonio_tecnico_componente_prefijo
    UNIQUE (cooperativa_id, componente, prefijo_cuenta),
  CONSTRAINT fk_parametros_patrimonio_tecnico_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_parametros_patrimonio_tecnico_componente CHECK (componente IN
    ('PRIMARIO','SECUNDARIO','DEDUCCION')),
  CONSTRAINT ck_parametros_patrimonio_tecnico_saldo CHECK (saldo_como IN ('ACREEDOR','DEUDOR')),
  CONSTRAINT ck_parametros_patrimonio_tecnico_factor CHECK (factor >= 0 AND factor <= 1),
  CONSTRAINT ck_parametros_patrimonio_tecnico_limite CHECK (
    limite_pct_apr IS NULL OR (limite_pct_apr > 0 AND limite_pct_apr <= 1)),
  -- Una deduccion se lee siempre con saldo deudor; al reves se sumaria la perdida.
  CONSTRAINT ck_parametros_patrimonio_tecnico_deduccion CHECK (
    componente <> 'DEDUCCION' OR saldo_como = 'DEUDOR')
);
SELECT tecnifin.aplicar_rls('tecnifin.parametros_patrimonio_tecnico');

-- ---------------------------------------------------------------------------
-- parametros_regulatorios: limites en clave/valor
-- ---------------------------------------------------------------------------
-- La clave natural ES el par (cooperativa_id, clave), igual que en denominaciones: no
-- hay un id subrogado que aporte algo. Es la segunda y ultima excepcion a la PK
-- (cooperativa_id, <id>) de ADR-0003.
CREATE TABLE tecnifin.parametros_regulatorios (
  cooperativa_id  integer       NOT NULL,
  clave           varchar(60)   NOT NULL,
  valor           numeric(18,6) NOT NULL,
  unidad          varchar(20)   NULL,
  descripcion     varchar(300)  NULL,
  base_normativa  varchar(200)  NULL,
  CONSTRAINT pk_parametros_regulatorios PRIMARY KEY (cooperativa_id, clave),
  CONSTRAINT fk_parametros_regulatorios_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_parametros_regulatorios_clave CHECK (clave ~ '^[A-Z][A-Z0-9_]{2,59}$')
);
SELECT tecnifin.aplicar_rls('tecnifin.parametros_regulatorios');

COMMENT ON TABLE tecnifin.parametros_regulatorios IS
  'Limites regulatorios por cooperativa (solvencia minima, topes, umbrales). Se edita el dato, no el codigo.';
