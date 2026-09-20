-- 0007_contabilidad.sql -- DAT-01 / hito H1
-- Traduce db/gutt_system/07_contabilidad.sql mas 18_fix_formato_codigo_contable.sql y
-- 21_fix_plancuentas_catalogo_real.sql (clases 6 y 7 del Catalogo Unico y es_agrupador).
-- Cambios de fondo frente al origen:
--   - AsientosContables.Fecha era DATETIME2: pasa a date. Es la FECHA CONTABLE; en
--     timestamptz un cambio de zona del servidor mueve un asiento de periodo, que es un
--     descuadre regulatorio silencioso (ADR-0003, fecha y hora).
--   - PlanCuentas.CuentaPadreId usaba FK simple: pasa a FK compuesta con el tenant, que
--     es el reemplazo nativo de las funciones escalares en CHECK de 12_fix.
--   - DetalleAsiento y PlanCuentas reciben el tenant; detalle_asiento.socio_id sigue
--     siendo NULL-able (asientos agregados de cierre no pertenecen a un socio) con
--     indice parcial, y NUNCA se pone 0: eso rompe la FK.
--   - El cuadre de partida doble lo hace cumplir el motor, con un trigger de restriccion
--     diferido: el asiento puede construirse linea por linea y se verifica al COMMIT.
-- Nota: el catalogo real (plan de cuentas SEPS) NO se carga aqui. Es de la semana 3.

CREATE TABLE tecnifin.plan_cuentas (
  cuenta_contable_id integer      GENERATED ALWAYS AS IDENTITY,
  cooperativa_id     integer      NOT NULL,
  codigo             tecnifin.codigo_contable NOT NULL,
  nombre             varchar(150) NOT NULL,
  tipo_cuenta        varchar(20)  NOT NULL,
  cuenta_padre_id    integer      NULL,
  -- 'A' en bcaccco: cuenta de agrupacion. No se puede contabilizar contra ella.
  es_agrupador       boolean      NOT NULL DEFAULT false,
  moneda             varchar(3)   NOT NULL DEFAULT 'USD',
  activa             boolean      NOT NULL DEFAULT true,
  CONSTRAINT pk_plan_cuentas PRIMARY KEY (cooperativa_id, cuenta_contable_id),
  CONSTRAINT uq_plan_cuentas_cooperativa_codigo UNIQUE (cooperativa_id, codigo),
  CONSTRAINT fk_plan_cuentas_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT fk_plan_cuentas_padre FOREIGN KEY (cooperativa_id, cuenta_padre_id)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, cuenta_contable_id),
  CONSTRAINT ck_plan_cuentas_tipo CHECK (tipo_cuenta IN
    ('ACTIVO','PASIVO','PATRIMONIO','INGRESO','GASTO','CONTINGENTE','ORDEN')),
  CONSTRAINT ck_plan_cuentas_no_autopadre CHECK (cuenta_padre_id IS DISTINCT FROM cuenta_contable_id)
);
CREATE INDEX ix_plan_cuentas_padre ON tecnifin.plan_cuentas (cooperativa_id, cuenta_padre_id);
-- Las formulas regulatorias seleccionan por PREFIJO numerico (cartera 1401..1428),
-- nunca por parecido de nombre. varchar_pattern_ops hace que LIKE '14%' use el indice.
CREATE INDEX ix_plan_cuentas_codigo_prefijo ON tecnifin.plan_cuentas
  (cooperativa_id, codigo varchar_pattern_ops);
SELECT tecnifin.aplicar_rls('tecnifin.plan_cuentas');

CREATE TABLE tecnifin.periodos_contables (
  periodo_id     integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  cooperativa_id integer NOT NULL,
  anio           integer NOT NULL,
  mes            integer NOT NULL,
  cerrado        boolean NOT NULL DEFAULT false,
  CONSTRAINT pk_periodos_contables PRIMARY KEY (cooperativa_id, periodo_id),
  CONSTRAINT uq_periodos_contables_cooperativa_anio_mes UNIQUE (cooperativa_id, anio, mes),
  CONSTRAINT fk_periodos_contables_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_periodos_contables_mes CHECK (mes BETWEEN 1 AND 12),
  CONSTRAINT ck_periodos_contables_anio CHECK (anio BETWEEN 1990 AND 2200)
);
SELECT tecnifin.aplicar_rls('tecnifin.periodos_contables');

CREATE TABLE tecnifin.asientos_contables (
  asiento_id          bigint       GENERATED ALWAYS AS IDENTITY,
  cooperativa_id      integer      NOT NULL,
  periodo_contable_id integer      NOT NULL,
  fecha               date         NOT NULL DEFAULT current_date,
  tipo_documento      varchar(30)  NULL,
  concepto            varchar(300) NOT NULL,
  anulado             boolean      NOT NULL DEFAULT false,
  usuario_id          bigint       NOT NULL,
  -- Referencia polimorfica de vuelta al registro que origino el asiento.
  origen_modulo       varchar(20)  NULL,
  origen_id           varchar(50)  NULL,
  fecha_registro      timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_asientos_contables PRIMARY KEY (cooperativa_id, asiento_id),
  CONSTRAINT fk_asientos_contables_periodo FOREIGN KEY (cooperativa_id, periodo_contable_id)
    REFERENCES tecnifin.periodos_contables (cooperativa_id, periodo_id),
  CONSTRAINT fk_asientos_contables_usuario FOREIGN KEY (cooperativa_id, usuario_id)
    REFERENCES tecnifin.usuarios (cooperativa_id, usuario_id),
  CONSTRAINT ck_asientos_contables_origen CHECK (origen_modulo IS NULL OR origen_modulo IN
    ('CREDITOS','CAJA','PLAZO_FIJO','TRANSFERENCIAS','MANUAL'))
);
CREATE INDEX ix_asientos_contables_periodo ON tecnifin.asientos_contables (cooperativa_id, periodo_contable_id);
CREATE INDEX ix_asientos_contables_usuario ON tecnifin.asientos_contables (cooperativa_id, usuario_id);
CREATE INDEX ix_asientos_contables_origen ON tecnifin.asientos_contables (cooperativa_id, origen_modulo, origen_id);
CREATE INDEX ix_asientos_contables_fecha ON tecnifin.asientos_contables (cooperativa_id, fecha);
SELECT tecnifin.aplicar_rls('tecnifin.asientos_contables');

CREATE TABLE tecnifin.detalle_asiento (
  detalle_id         bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id     integer       NOT NULL,
  asiento_id         bigint        NOT NULL,
  cuenta_contable_id integer       NOT NULL,
  tipo_asiento       char(1)       NOT NULL,
  valor              numeric(18,2) NOT NULL,
  -- NULL valido: los asientos agregados de cierre no pertenecen a ningun socio.
  -- Poner 0 rompe la FK -- error ya cometido en el sistema viejo.
  socio_id           bigint        NULL,
  CONSTRAINT pk_detalle_asiento PRIMARY KEY (cooperativa_id, detalle_id),
  CONSTRAINT fk_detalle_asiento_asiento FOREIGN KEY (cooperativa_id, asiento_id)
    REFERENCES tecnifin.asientos_contables (cooperativa_id, asiento_id) ON DELETE CASCADE,
  CONSTRAINT fk_detalle_asiento_cuenta FOREIGN KEY (cooperativa_id, cuenta_contable_id)
    REFERENCES tecnifin.plan_cuentas (cooperativa_id, cuenta_contable_id),
  CONSTRAINT fk_detalle_asiento_socio FOREIGN KEY (cooperativa_id, socio_id)
    REFERENCES tecnifin.socios (cooperativa_id, socio_id),
  CONSTRAINT ck_detalle_asiento_tipo CHECK (tipo_asiento IN ('D','H')),
  CONSTRAINT ck_detalle_asiento_valor CHECK (valor > 0)
);
CREATE INDEX ix_detalle_asiento_asiento ON tecnifin.detalle_asiento (cooperativa_id, asiento_id);
CREATE INDEX ix_detalle_asiento_cuenta ON tecnifin.detalle_asiento (cooperativa_id, cuenta_contable_id);
CREATE INDEX ix_detalle_asiento_socio ON tecnifin.detalle_asiento (cooperativa_id, socio_id)
  WHERE socio_id IS NOT NULL;
SELECT tecnifin.aplicar_rls('tecnifin.detalle_asiento');

-- ---------------------------------------------------------------------------
-- Partida doble: la hace cumplir el motor, no la aplicacion
-- ---------------------------------------------------------------------------
CREATE FUNCTION tecnifin.fn_detalle_asiento_cuadre() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
DECLARE
  v_asiento bigint;
  v_marca   text;
  v_debe    numeric(18,2);
  v_haber   numeric(18,2);
BEGIN
  -- Un trigger de restriccion tiene que ser FOR EACH ROW, asi que un asiento de N lineas
  -- dispara N veces. Sin la marca, cada disparo volveria a sumar las N lineas: O(N^2) en
  -- los asientos agregados de cierre, que son justamente los mas largos. La marca es
  -- local a la transaccion (set_config con is_local), asi que no sobrevive al COMMIT.
  FOREACH v_asiento IN ARRAY (CASE
      WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.asiento_id]
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.asiento_id]
      ELSE ARRAY[OLD.asiento_id, NEW.asiento_id] END)
  LOOP
    v_marca := 'tecnifin.cuadre_' || v_asiento;
    CONTINUE WHEN current_setting(v_marca, true) = '1';
    PERFORM set_config(v_marca, '1', true);
    SELECT coalesce(sum(valor) FILTER (WHERE tipo_asiento = 'D'), 0),
           coalesce(sum(valor) FILTER (WHERE tipo_asiento = 'H'), 0)
      INTO v_debe, v_haber
      FROM tecnifin.detalle_asiento
     WHERE asiento_id = v_asiento;
    IF v_debe <> v_haber THEN
      RAISE EXCEPTION 'Asiento % descuadrado: debe = %, haber = %', v_asiento, v_debe, v_haber
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;

-- Diferido: el asiento se arma linea por linea dentro de la transaccion y el cuadre se
-- comprueba una sola vez, al COMMIT. Un asiento descuadrado no llega a existir.
CREATE CONSTRAINT TRIGGER tg_detalle_asiento_cuadre
  AFTER INSERT OR UPDATE OR DELETE ON tecnifin.detalle_asiento
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tecnifin.fn_detalle_asiento_cuadre();

-- No se contabiliza contra una cuenta de agrupacion (21_fix_plancuentas_catalogo_real.sql).
CREATE FUNCTION tecnifin.fn_detalle_asiento_cuenta_movimiento() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF EXISTS (SELECT 1 FROM tecnifin.plan_cuentas pc
              WHERE pc.cuenta_contable_id = NEW.cuenta_contable_id AND pc.es_agrupador) THEN
    RAISE EXCEPTION 'No se puede contabilizar contra una cuenta de agrupacion (cuenta_contable_id = %)',
      NEW.cuenta_contable_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER tg_detalle_asiento_cuenta_movimiento
  BEFORE INSERT OR UPDATE OF cuenta_contable_id ON tecnifin.detalle_asiento
  FOR EACH ROW EXECUTE FUNCTION tecnifin.fn_detalle_asiento_cuenta_movimiento();
