-- 0002_socios.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/02_socios.sql: nucleo delgado + 6 tablas hijas.
-- Las 6 hijas NO tenian CooperativaId en el origen (lo heredaban por FK): aqui lo
-- reciben, porque una politica RLS no puede filtrar por una columna que no esta en
-- la tabla (ADR-0002 punto 4). La consistencia entre el tenant propio y el del padre
-- la garantiza la FK compuesta (cooperativa_id, socio_id), que reemplaza a las
-- funciones escalares en CHECK de 12_fix_consistencia_cooperativa.sql.

CREATE TABLE tecnifin.socios (
  socio_id              bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id        integer       NOT NULL,
  -- Correlativo por cooperativa desde 1 (decision de Jorge, 2026-09-20). El numero que
  -- el socio tenia en el sistema anterior se conserva aparte, solo para la migracion.
  numero_socio          bigint        NOT NULL DEFAULT tecnifin.siguiente_numero('socio'),
  numero_socio_anterior varchar(20)   NULL,
  tipo_persona          varchar(20)   NOT NULL,
  tipo_identificacion   varchar(20)   NOT NULL,
  identificacion        varchar(20)   NOT NULL,
  primer_nombre         varchar(50)   NOT NULL,
  segundo_nombre        varchar(50)   NULL,
  primer_apellido       varchar(50)   NOT NULL,
  segundo_apellido      varchar(50)   NULL,
  solo_un_nombre        boolean       NOT NULL DEFAULT false,
  solo_un_apellido      boolean       NOT NULL DEFAULT false,
  email                 varchar(100)  NULL,
  telefono              varchar(20)   NULL,
  telefonos             varchar(200)  NULL,
  fecha_nacimiento      date          NULL,
  estado_civil          varchar(20)   NULL,
  pin                   varchar(4)    NOT NULL,
  etnia                 varchar(20)   NULL,
  genero                varchar(20)   NULL,
  autoidentificacion    varchar(100)  NULL,
  nivel_instruccion     varchar(50)   NULL,
  profesion             varchar(100)  NULL,
  discapacidad          boolean       NOT NULL DEFAULT false,
  -- Persona Expuesta Politicamente (UAFE/AML).
  peps                  boolean       NOT NULL DEFAULT false,
  consentimiento_datos  boolean       NOT NULL DEFAULT false,
  -- JSON heredado. Normalizarlo es trabajo de M1, no de H1 (ADR-0003).
  patrimonio_ingresos   text          NULL,
  fecha_registro        timestamptz(0) NOT NULL DEFAULT now(),
  usuario_registro_id   bigint        NULL,
  estado                varchar(20)   NOT NULL DEFAULT 'ACTIVO',
  CONSTRAINT pk_socios PRIMARY KEY (cooperativa_id, socio_id),
  CONSTRAINT uq_socios_cooperativa_identificacion UNIQUE (cooperativa_id, identificacion),
  CONSTRAINT uq_socios_cooperativa_numero UNIQUE (cooperativa_id, numero_socio),
  CONSTRAINT fk_socios_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT fk_socios_usuario_registro FOREIGN KEY (cooperativa_id, usuario_registro_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_socios_tipo_persona CHECK (tipo_persona IN ('SOCIO','CLIENTE','CLIENTE_EXTERNO')),
  CONSTRAINT ck_socios_estado CHECK (estado IN ('ACTIVO','INACTIVO','BLOQUEADO','FALLECIDO')),
  CONSTRAINT ck_socios_numero CHECK (numero_socio > 0)
);

COMMENT ON COLUMN tecnifin.socios.numero_socio_anterior IS
  'Numero que el socio tenia en el sistema de origen. Dato de migracion (MIG-01); el numero vigente es numero_socio.';

-- FK compuesta con columna nula: MATCH SIMPLE deja pasar la fila cuando
-- usuario_registro_id es NULL, que es el caso valido (socio cargado por migracion).
CREATE INDEX ix_socios_usuario_registro ON tecnifin.socios (cooperativa_id, usuario_registro_id);
-- Busqueda por apellido insensible a mayusculas y acentos: SQL Server lo daba gratis
-- por collation, PostgreSQL no (ADR-0003). Sin estos indices la consulta funciona pero barre.
CREATE INDEX ix_socios_apellidos_busqueda ON tecnifin.socios
  (cooperativa_id, lower(tecnifin.sin_acentos(primer_apellido)), lower(tecnifin.sin_acentos(primer_nombre)));
CREATE INDEX ix_socios_apellido_trigrama ON tecnifin.socios
  USING gin (lower(tecnifin.sin_acentos(primer_apellido || ' ' || coalesce(segundo_apellido, ''))) public.gin_trgm_ops);

SELECT tecnifin.aplicar_rls('tecnifin.socios');

-- ---------------------------------------------------------------------------
-- 1:1 con socios
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.socio_direccion (
  socio_id             bigint        NOT NULL,
  cooperativa_id       integer       NOT NULL,
  pais_nacimiento      varchar(50)   NULL,
  provincia_nacimiento varchar(50)   NULL,
  canton_nacimiento    varchar(50)   NULL,
  parroquia_nacimiento varchar(50)   NULL,
  pais_residencia      varchar(50)   NULL,
  provincia_residencia varchar(50)   NULL,
  canton_residencia    varchar(50)   NULL,
  parroquia_residencia varchar(50)   NULL,
  direccion_domicilio  varchar(200)  NULL,
  lugar_trabajo        varchar(200)  NULL,
  provincia_trabajo    varchar(50)   NULL,
  canton_trabajo       varchar(50)   NULL,
  parroquia_trabajo    varchar(50)   NULL,
  tipo_vivienda        varchar(100)  NULL,
  valor_vivienda       numeric(18,2) NULL,
  CONSTRAINT pk_socio_direccion PRIMARY KEY (cooperativa_id, socio_id),
  CONSTRAINT fk_socio_direccion_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE
);
SELECT tecnifin.aplicar_rls('tecnifin.socio_direccion');

CREATE TABLE tecnifin.socio_conyuge (
  socio_id         bigint       NOT NULL,
  cooperativa_id   integer      NOT NULL,
  cedula_conyuge   varchar(20)  NULL,
  nombre_conyuge   varchar(150) NULL,
  telefono_conyuge varchar(20)  NULL,
  CONSTRAINT pk_socio_conyuge PRIMARY KEY (cooperativa_id, socio_id),
  CONSTRAINT fk_socio_conyuge_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE
);
SELECT tecnifin.aplicar_rls('tecnifin.socio_conyuge');

-- ---------------------------------------------------------------------------
-- 1:N con socios (antes JSON en NVARCHAR(MAX))
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.socio_referencia (
  referencia_id  bigint       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id integer      NOT NULL,
  socio_id       bigint       NOT NULL,
  nombre         varchar(150) NOT NULL,
  telefono       varchar(20)  NULL,
  relacion       varchar(50)  NULL,
  CONSTRAINT pk_socio_referencia PRIMARY KEY (cooperativa_id, referencia_id),
  CONSTRAINT fk_socio_referencia_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE
);
CREATE INDEX ix_socio_referencia_socio ON tecnifin.socio_referencia (cooperativa_id, socio_id);
SELECT tecnifin.aplicar_rls('tecnifin.socio_referencia');

CREATE TABLE tecnifin.socio_carga (
  carga_id       bigint       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id integer      NOT NULL,
  socio_id       bigint       NOT NULL,
  nombre         varchar(150) NOT NULL,
  parentesco     varchar(50)  NULL,
  edad           integer      NULL,
  CONSTRAINT pk_socio_carga PRIMARY KEY (cooperativa_id, carga_id),
  CONSTRAINT fk_socio_carga_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE,
  CONSTRAINT ck_socio_carga_edad CHECK (edad IS NULL OR edad BETWEEN 0 AND 120)
);
CREATE INDEX ix_socio_carga_socio ON tecnifin.socio_carga (cooperativa_id, socio_id);
SELECT tecnifin.aplicar_rls('tecnifin.socio_carga');

-- ---------------------------------------------------------------------------
-- Binarios. PREGUNTA ABIERTA 3 de ADR-0003 (Christian): si se decide sacarlos a
-- almacenamiento de archivos, la migracion es aditiva (columna ruta + vaciar bytea).
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.socio_ubicacion_mapa (
  ubicacion_mapa_id   bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id      integer       NOT NULL,
  socio_id            bigint        NOT NULL,
  imagen_mapa         bytea         NULL,
  coordenada_lat      varchar(50)   NULL,
  coordenada_lng      varchar(50)   NULL,
  direccion_capturada varchar(200)  NULL,
  fecha_captura       timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_socio_ubicacion_mapa PRIMARY KEY (cooperativa_id, ubicacion_mapa_id),
  CONSTRAINT fk_socio_ubicacion_mapa_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE
);
CREATE INDEX ix_socio_ubicacion_mapa_socio ON tecnifin.socio_ubicacion_mapa (cooperativa_id, socio_id);
SELECT tecnifin.aplicar_rls('tecnifin.socio_ubicacion_mapa');

CREATE TABLE tecnifin.socio_croquis_trabajo (
  croquis_trabajo_id bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id     integer       NOT NULL,
  socio_id           bigint        NOT NULL,
  imagen_croquis     bytea         NULL,
  descripcion        varchar(500)  NULL,
  fecha_captura      timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_socio_croquis_trabajo PRIMARY KEY (cooperativa_id, croquis_trabajo_id),
  CONSTRAINT fk_socio_croquis_trabajo_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE
);
CREATE INDEX ix_socio_croquis_trabajo_socio ON tecnifin.socio_croquis_trabajo (cooperativa_id, socio_id);
SELECT tecnifin.aplicar_rls('tecnifin.socio_croquis_trabajo');
