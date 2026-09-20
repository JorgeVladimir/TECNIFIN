-- 0008_auditoria.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/08_auditoria.sql.
-- Cambios de fondo frente al origen:
--   - AuditoriaUsuarios no tenia CooperativaId: lo recibe.
--   - Ninguna de las dos lleva FK hacia usuarios, y es deliberado (mismo criterio que
--     14_fix_fk_usuario_faltantes.sql): un intento de acceso con un usuario que no
--     existe ES el dato que hay que registrar; con FK ese registro seria imposible.
--     Por eso se guarda el login como texto, no el usuario_id.
--   - Append-only: el rol de la aplicacion recibe INSERT y SELECT, nunca UPDATE ni
--     DELETE (ver 0010). Las vistas por proceso del sistema viejo no se portan: son
--     un SELECT con WHERE y no justifican ocho objetos de esquema.

CREATE TABLE tecnifin.auditoria_procesos (
  auditoria_id   bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id integer        NOT NULL,
  proceso        varchar(50)    NOT NULL,
  accion         varchar(50)    NOT NULL,
  entidad_tipo   varchar(50)    NOT NULL,
  entidad_id     varchar(50)    NULL,
  usuario_login  varchar(20)    NOT NULL,
  campo_afectado varchar(100)   NULL,
  valor_anterior text           NULL,
  valor_nuevo    text           NULL,
  detalle        varchar(500)   NULL,
  ip_origen      varchar(45)    NULL,
  fecha_registro timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_auditoria_procesos PRIMARY KEY (cooperativa_id, auditoria_id),
  CONSTRAINT fk_auditoria_procesos_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_auditoria_procesos_proceso CHECK (proceso IN
    ('CREDITOS','CAJA','AHORROS','PLAZO_FIJO','CONTABILIDAD','SOCIOS','SEGURIDAD','REPORTES_SEPS'))
);
CREATE INDEX ix_auditoria_procesos_proceso_fecha ON tecnifin.auditoria_procesos
  (cooperativa_id, proceso, fecha_registro DESC);
CREATE INDEX ix_auditoria_procesos_entidad ON tecnifin.auditoria_procesos
  (cooperativa_id, entidad_tipo, entidad_id);
SELECT tecnifin.aplicar_rls('tecnifin.auditoria_procesos', true);

CREATE TABLE tecnifin.auditoria_usuarios (
  auditoria_id   bigint         GENERATED ALWAYS AS IDENTITY,
  cooperativa_id integer        NOT NULL,
  usuario_login  varchar(20)    NOT NULL,
  concepto       varchar(100)   NOT NULL,
  detalle        varchar(500)   NOT NULL,
  fecha_registro timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_auditoria_usuarios PRIMARY KEY (cooperativa_id, auditoria_id),
  CONSTRAINT fk_auditoria_usuarios_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id)
);
CREATE INDEX ix_auditoria_usuarios_login_fecha ON tecnifin.auditoria_usuarios
  (cooperativa_id, usuario_login, fecha_registro DESC);
SELECT tecnifin.aplicar_rls('tecnifin.auditoria_usuarios', true);
