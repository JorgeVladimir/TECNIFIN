-- 0015_app01_autenticacion.sql -- APP-01
-- Configuracion operativa por cooperativa y resolucion preautenticada del codigo
-- publico usado en el login. El cooperativa_id interno nunca entra desde HTTP.

CREATE TABLE tecnifin.parametros_cooperativa (
  cooperativa_id     integer        NOT NULL,
  clave              varchar(100)   NOT NULL,
  valor              text           NOT NULL,
  descripcion        varchar(300)   NULL,
  fecha_actualizacion timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_parametros_cooperativa PRIMARY KEY (cooperativa_id, clave),
  CONSTRAINT fk_parametros_cooperativa_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_parametros_cooperativa_clave CHECK (
    clave ~ '^[a-z0-9][a-z0-9._-]{2,99}$'
  )
);

COMMENT ON TABLE tecnifin.parametros_cooperativa IS
  'Configuracion operativa por tenant. APP-01 no fija valores definitivos para vida, refresh ni invalidacion JWT.';

SELECT tecnifin.aplicar_rls('tecnifin.parametros_cooperativa');

CREATE TRIGGER tg_parametros_cooperativa_fecha_actualizacion
BEFORE UPDATE ON tecnifin.parametros_cooperativa
FOR EACH ROW EXECUTE FUNCTION tecnifin.fn_fecha_actualizacion();

-- Antes de autenticar aun no existe JWT. El cliente entrega el codigo publico de la
-- cooperativa, nunca el id interno. Esta politica solo permite resolver UNA cooperativa
-- activa cuyo codigo coincide con el contexto preautenticado; no abre datos de negocio.
CREATE POLICY pol_cooperativas_login_codigo ON tecnifin.cooperativas
FOR SELECT TO tecnifin_app
USING (
  activa
  AND codigo = nullif(current_setting('app.cooperativa_codigo', true), '')
);

