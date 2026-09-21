-- 0013_tasas_credito_canal_socio.sql -- DAT-02 / hito H1
-- Las tres tablas del sistema anterior que quedaban sin destino: el tarifario de credito,
-- la activacion del canal en linea del socio y la excepcion de documento de identidad.
-- Traduce db/sqlserver/10_tasas_credito.sql, 09_activacion_banca_linea.sql y
-- 18_cedula_excepcion_seps.sql.

-- ---------------------------------------------------------------------------
-- tasas_credito: tarifario por linea de credito
-- ---------------------------------------------------------------------------
-- Por que NO va dentro de productos_financieros: esa tabla es el catalogo de productos
-- de CAPTACION (tipo_deposito, cuenta_activa/inactiva, permisos de deposito y retiro,
-- meses de acreditacion). Un tarifario de COLOCACION comparte con ella el nombre
-- "producto" y nada mas: de sus 20 columnas no aplicaria ninguna, y las 9 de aqui no
-- aplicarian a un producto de ahorro. Fundirlas dejaria las dos mitades en NULL y un
-- CHECK condicional por tipo. Son dos catalogos, y asi se quedan.
CREATE TABLE tecnifin.tasas_credito (
  tasa_credito_id integer       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id  integer       NOT NULL,
  linea_credito   varchar(100)  NOT NULL,
  -- Mismo dominio que parametros_provision_cartera.segmento (0011): el vocabulario se
  -- define una vez. Si el tarifario y la provision usaran listas distintas, la
  -- calificacion no encontraria sus parametros y la provision saldria en cero sin fallar.
  clase_credito   tecnifin.segmento_credito NOT NULL,
  monto_minimo    numeric(18,2) NOT NULL,
  monto_maximo    numeric(18,2) NOT NULL,
  -- En MESES, igual que creditos.plazo y que el motor de amortizacion, que avanza
  -- las cuotas con DATEADD(MONTH, ...). El origen no documentaba la unidad.
  plazo_minimo    integer       NOT NULL,
  plazo_maximo    integer       NOT NULL,
  -- PORCENTAJE, no fraccion: 14.00 es 14%. Al reves que porcentaje_provision y que
  -- ponderacion, que son fracciones. La diferencia viene del origen; esta escrita en
  -- los CHECK para que ninguna de las dos pueda recibir el valor de la otra.
  tasa_inicial    numeric(9,4)  NOT NULL,
  tasa_final      numeric(9,4)  NOT NULL,
  tasa_aplicable  numeric(9,4)  NOT NULL,
  activo          boolean       NOT NULL DEFAULT true,
  fecha_vigencia  date          NOT NULL DEFAULT current_date,
  CONSTRAINT pk_tasas_credito PRIMARY KEY (cooperativa_id, tasa_credito_id),
  -- En el origen LineaCredito era UNIQUE GLOBAL: dos cooperativas no podian tener ambas
  -- una linea "CONSUMO ORDINARIO". Aqui el unico es por cooperativa.
  CONSTRAINT uq_tasas_credito_linea UNIQUE (cooperativa_id, linea_credito),
  CONSTRAINT fk_tasas_credito_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_tasas_credito_montos CHECK (monto_minimo > 0 AND monto_maximo >= monto_minimo),
  CONSTRAINT ck_tasas_credito_plazos CHECK (plazo_minimo >= 1 AND plazo_maximo >= plazo_minimo),
  CONSTRAINT ck_tasas_credito_tasas CHECK (
    tasa_inicial >= 0 AND tasa_final >= tasa_inicial AND tasa_final <= 100
    AND tasa_aplicable BETWEEN tasa_inicial AND tasa_final)
);
SELECT tecnifin.aplicar_rls('tecnifin.tasas_credito');

COMMENT ON COLUMN tecnifin.tasas_credito.tasa_aplicable IS
  'Porcentaje anual efectivamente pactado (14.0000 = 14%). Debe caer entre tasa_inicial y tasa_final.';

-- ---------------------------------------------------------------------------
-- activacion_banca_linea: activacion del canal movil del socio
-- ---------------------------------------------------------------------------
-- El PIN NO se guarda en claro. En el origen era PIN NVARCHAR(4) legible en la tabla, y
-- tambien el codigo de verificacion: cualquiera con lectura sobre la base podia entrar
-- como el socio.
--
-- Un CHECK de longitud minima seria una heuristica disfrazada de invariante: una clave en
-- claro de veinte caracteres pasaria. Lo que el motor puede exigir de verdad es el FORMATO
-- que emite el sistema -- etiqueta de algoritmo, separador y cuerpo --, que ningun secreto
-- tecleado por una persona tiene. La etiqueta ademas deja rotar el algoritmo sin migrar
-- las filas viejas, porque cada fila dice con que se genero.
CREATE DOMAIN tecnifin.hash_secreto AS varchar(200)
  CONSTRAINT ck_hash_secreto CHECK (VALUE ~ '^[a-z0-9]{2,20}\$[!-~]{16,}$');

COMMENT ON DOMAIN tecnifin.hash_secreto IS
  'Secreto derivado, nunca el secreto: <algoritmo>$<cuerpo>. Lo produce hashearClave() de src/platform/credenciales.js.';

CREATE TABLE tecnifin.activacion_banca_linea (
  activacion_id             bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id            integer       NOT NULL,
  socio_id                  bigint        NOT NULL,
  pin_hash                  tecnifin.hash_secreto NOT NULL,
  codigo_verificacion_hash  tecnifin.hash_secreto NULL,
  codigo_verificacion_expira timestamptz(0) NULL,
  fecha_registro            timestamptz(0) NOT NULL DEFAULT now(),
  acepto_datos_personales   boolean       NOT NULL DEFAULT false,
  fecha_aceptacion_datos    timestamptz(0) NULL,
  activo                    boolean       NOT NULL DEFAULT false,
  CONSTRAINT pk_activacion_banca_linea PRIMARY KEY (cooperativa_id, activacion_id),
  CONSTRAINT fk_activacion_banca_linea_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE,
  -- Que sean hashes y no secretos lo exige el dominio tecnifin.hash_secreto, arriba.
  -- Un codigo vivo tiene fecha de caducidad: sin ella el codigo de un dia sirve para siempre.
  CONSTRAINT ck_activacion_banca_linea_codigo_expira CHECK (
    (codigo_verificacion_hash IS NULL) = (codigo_verificacion_expira IS NULL)),
  -- El consentimiento de datos personales sin fecha no es consentimiento (Ley Organica
  -- de Proteccion de Datos Personales: hay que poder probar CUANDO se dio).
  CONSTRAINT ck_activacion_banca_linea_consentimiento CHECK (
    acepto_datos_personales = false OR fecha_aceptacion_datos IS NOT NULL),
  -- Y no se activa el canal sin ese consentimiento.
  CONSTRAINT ck_activacion_banca_linea_activo CHECK (
    activo = false OR acepto_datos_personales = true)
);
CREATE INDEX ix_activacion_banca_linea_socio ON tecnifin.activacion_banca_linea
  (cooperativa_id, socio_id);
-- Un socio tiene a lo sumo UNA activacion vigente; el historico de intentos previos
-- queda, pero no puede haber dos canales activos para la misma persona.
CREATE UNIQUE INDEX ux_activacion_banca_linea_socio_activo ON tecnifin.activacion_banca_linea
  (cooperativa_id, socio_id) WHERE activo;
SELECT tecnifin.aplicar_rls('tecnifin.activacion_banca_linea');

COMMENT ON COLUMN tecnifin.activacion_banca_linea.pin_hash IS
  'Hash del PIN del canal en linea. Nunca el PIN. El CHECK impide guardarlo en claro por descuido.';

-- ---------------------------------------------------------------------------
-- socio_documento_excepcion: respaldo del documento cuando no hay cedula legible
-- ---------------------------------------------------------------------------
-- El origen guardaba RUTAS a archivos en disco (NVARCHAR(250)): un respaldo de la base
-- no incluia las imagenes y una ruta rota no se notaba hasta la revision de la SEPS.
-- Por decision de Jorge (2026-09-20) las imagenes van DENTRO de la base, como en
-- socio_ubicacion_mapa y socio_croquis_trabajo.
CREATE TABLE tecnifin.socio_documento_excepcion (
  documento_id      bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id    integer       NOT NULL,
  socio_id          bigint        NOT NULL,
  identificacion    varchar(20)   NOT NULL,
  imagen_frontal    bytea         NULL,
  imagen_posterior  bytea         NULL,
  tipo_mime         varchar(50)   NULL,
  motivo            varchar(300)  NULL,
  fecha_registro    timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_socio_documento_excepcion PRIMARY KEY (cooperativa_id, documento_id),
  CONSTRAINT fk_socio_documento_excepcion_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id) ON DELETE CASCADE,
  -- Una excepcion sin ninguna imagen no respalda nada.
  CONSTRAINT ck_socio_documento_excepcion_imagen CHECK (
    imagen_frontal IS NOT NULL OR imagen_posterior IS NOT NULL),
  CONSTRAINT ck_socio_documento_excepcion_mime CHECK (
    tipo_mime IS NULL OR tipo_mime IN ('image/jpeg','image/png','image/webp','application/pdf'))
);
CREATE INDEX ix_socio_documento_excepcion_socio ON tecnifin.socio_documento_excepcion
  (cooperativa_id, socio_id);
SELECT tecnifin.aplicar_rls('tecnifin.socio_documento_excepcion');
