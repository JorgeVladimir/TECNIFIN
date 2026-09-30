-- 0016_app01_recuperacion_clave.sql -- APP-01
-- Recuperacion de clave por correo. El sistema anterior guardaba el token en claro dentro
-- de Usuarios (ResetToken): quien leyera la tabla podia entrar como cualquiera. Aqui el
-- token vive solo en el correo del usuario; la base guarda su SHA-256, es de un solo uso,
-- vence y queda aislado por cooperativa como cualquier dato de negocio.

ALTER TABLE tecnifin.usuarios ADD COLUMN correo varchar(150) NULL;
ALTER TABLE tecnifin.usuarios ADD CONSTRAINT ck_usuarios_correo
  CHECK (correo IS NULL OR (correo = lower(correo) AND correo ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

COMMENT ON COLUMN tecnifin.usuarios.correo IS
  'Correo para recuperar la clave. Se guarda en minusculas. Sin correo no hay recuperacion por autoservicio.';

CREATE TABLE tecnifin.recuperaciones_clave (
  cooperativa_id   integer        NOT NULL,
  recuperacion_id  bigint         GENERATED ALWAYS AS IDENTITY,
  usuario_id       bigint         NOT NULL,
  token_hash       char(64)       NOT NULL,
  expira           timestamptz(0) NOT NULL,
  consumida        timestamptz(0) NULL,
  fecha_creacion   timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_recuperaciones_clave PRIMARY KEY (cooperativa_id, recuperacion_id),
  CONSTRAINT uq_recuperaciones_clave_token UNIQUE (cooperativa_id, token_hash),
  CONSTRAINT fk_recuperaciones_clave_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_recuperaciones_clave_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_recuperaciones_clave_vigencia CHECK (expira > fecha_creacion)
);

COMMENT ON TABLE tecnifin.recuperaciones_clave IS
  'Solicitudes de recuperacion de clave: solo el SHA-256 del token, un uso, con vencimiento.';

CREATE INDEX ix_recuperaciones_clave_usuario_fecha ON tecnifin.recuperaciones_clave
  (cooperativa_id, usuario_id, fecha_creacion DESC);

SELECT tecnifin.aplicar_rls('tecnifin.recuperaciones_clave');
