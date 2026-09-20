-- 0001_plataforma.sql -- DAT-01 / hito H1
-- Raiz del modelo multi-tenant: esquema, cooperativas (el tenant), parametros de
-- plataforma, usuarios y el mecanismo unico de numeracion por cooperativa.
-- Traduce db/gutt_system/01_cooperativas_usuarios.sql (ADR-0001, ADR-0002, ADR-0003).
--
-- Cambios de fondo frente al origen SQL Server:
--   - Usuarios.UsuarioId NVARCHAR(20) era PK GLOBAL: dos cooperativas no podian tener
--     ambas un usuario 'admin'. Pasa a PK subrogada bigint + unico (cooperativa_id, login).
--   - Seq_NumeroSocio era una SECUENCIA GLOBAL: filtraba entre tenants cuantos socios
--     lleva el conjunto. Se reemplaza por secuencias_tenant + siguiente_numero().
--   - El nombre visible de la plataforma es un DATO (parametros_plataforma), no una
--     constante regada por el codigo (regla 9).

CREATE SCHEMA IF NOT EXISTS tecnifin;

-- Los nombres de los dos roles son parte de la decision (ADR-0003, § Decision 1), no
-- configuracion: las politicas y los permisos los nombran. Si no existen, o si quien
-- migra no es el dueno previsto, es mejor detenerse aqui que dejar un esquema a medias.
DO $roles$
BEGIN
  IF current_user <> 'tecnifin_admin' THEN
    RAISE EXCEPTION 'Las migraciones las ejecuta tecnifin_admin, no %. Ver TECNIFIN_PG_ADMIN_USER en .env', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tecnifin_app') THEN
    RAISE EXCEPTION 'Falta el rol tecnifin_app. Crear la base con npm run db:init antes de migrar.';
  END IF;
  IF (SELECT bool_or(rolbypassrls OR rolsuper) FROM pg_roles WHERE rolname IN ('tecnifin_app', 'tecnifin_admin')) THEN
    RAISE EXCEPTION 'tecnifin_app o tecnifin_admin tiene BYPASSRLS o SUPERUSER: el aislamiento seria decorativo.';
  END IF;
END;
$roles$;

-- Extensiones de busqueda de personas (ADR-0003, comparacion de texto). Viven en public,
-- el lugar estandar; public no recibe CREATE para el rol de la aplicacion (ver 0010).
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- unaccent() es STABLE (depende del diccionario) y por eso no puede ir en un indice.
-- La forma de dos argumentos fija el diccionario y vuelve el resultado reproducible.
CREATE FUNCTION tecnifin.sin_acentos(p_texto text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$fn$ SELECT public.unaccent('public.unaccent', p_texto) $fn$;

COMMENT ON FUNCTION tecnifin.sin_acentos(text) IS
  'Envoltura inmutable de unaccent para indices funcionales de busqueda de personas.';

-- Formato canonico del codigo contable, en UN solo lugar: digitos concatenados, sin
-- puntos. El punteado ('2.1.03.05') es formato de presentacion y no entra a la base
-- (ADR-0003, regla transversal 5). Todas las columnas de codigo contable usan el dominio.
CREATE DOMAIN tecnifin.codigo_contable AS varchar(15)
  CONSTRAINT ck_codigo_contable CHECK (VALUE ~ '^[0-9]+$');

-- ---------------------------------------------------------------------------
-- El tenant y como llega a la sesion
-- ---------------------------------------------------------------------------

-- Lee el tenant fijado por withTenant() con SET LOCAL. Devuelve NULL si nadie lo fijo:
-- de ahi sale el "falla cerrada" de las politicas RLS (NULL = ninguna fila calza).
CREATE FUNCTION tecnifin.cooperativa_actual() RETURNS integer
  LANGUAGE sql STABLE PARALLEL SAFE AS
$fn$ SELECT nullif(current_setting('app.cooperativa_id', true), '')::integer $fn$;

COMMENT ON FUNCTION tecnifin.cooperativa_actual() IS
  'Cooperativa de la transaccion actual, o NULL si no se uso withTenant(). Las politicas RLS la comparan.';

-- Aplica el mismo tratamiento a toda tabla de negocio: una sola implementacion (regla 13)
-- y una sola redaccion de politica. Ademas pone cooperativa_id por defecto, para que el
-- codigo de negocio no tenga que repetir el tenant en cada INSERT: si se olvida, la fila
-- sale con el tenant correcto, y fuera de withTenant sale NULL y la viola el NOT NULL.
-- Rechaza la tabla sin cooperativa_id NOT NULL, que es el olvido que ADR-0002 identifica
-- como fuga silenciosa.
CREATE FUNCTION tecnifin.aplicar_rls(p_tabla regclass, p_solo_agregar boolean DEFAULT false)
  RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  v_nombre text := p_tabla::text;
  v_corto  text := (SELECT relname FROM pg_class WHERE oid = p_tabla);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = p_tabla AND attname = 'cooperativa_id' AND attnotnull AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'La tabla % no tiene cooperativa_id NOT NULL: no puede llevar RLS por tenant', v_nombre;
  END IF;
  EXECUTE format('ALTER TABLE %s ALTER COLUMN cooperativa_id SET DEFAULT tecnifin.cooperativa_actual()', v_nombre);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_nombre);
  -- FORCE no es opcional: sin el, el dueno de la tabla ignora RLS (ADR-0002, punto 2).
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_nombre);
  -- El (SELECT ...) no es decorativo: convierte la lectura del tenant en un InitPlan que
  -- se evalua UNA vez por sentencia. Sin el, la funcion se reevalua por cada fila que el
  -- filtro examina. La semantica no cambia: sin tenant sigue siendo NULL y sin filas.
  EXECUTE format(
    'CREATE POLICY %I ON %s USING (cooperativa_id = (SELECT tecnifin.cooperativa_actual()))'
    || ' WITH CHECK (cooperativa_id = (SELECT tecnifin.cooperativa_actual()))',
    'pol_' || v_corto || '_tenant', v_nombre);
  IF p_solo_agregar THEN
    -- Append-only exigido por el motor, no por el REVOKE: alcanza tambien al dueno.
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW'
      || ' EXECUTE FUNCTION tecnifin.fn_solo_agregar()',
      'tg_' || v_corto || '_solo_agregar', v_nombre);
  END IF;
END;
$fn$;

CREATE FUNCTION tecnifin.fn_solo_agregar() RETURNS trigger LANGUAGE plpgsql AS
$fn$
BEGIN
  RAISE EXCEPTION 'La tabla % es de solo agregar: no admite % ', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

-- Tablas de PLATAFORMA: las que no pertenecen a una cooperativa (o cuya PK es el tenant).
-- Llevan RLS y FORCE igual que las demas -- no hay excepciones a FORCE -- con dos
-- politicas: una de administracion para el dueno, que es lo que permite dar de alta la
-- cooperativa 11 sin saltarse el motor, y una de lectura para el resto. El comentario que
-- deja esta funcion es lo UNICO que exime a una tabla de llevar cooperativa_id, asi que
-- nadie puede eximirse sin pasar por aqui.
CREATE FUNCTION tecnifin.aplicar_rls_plataforma(p_tabla regclass, p_lectura text)
  RETURNS void LANGUAGE plpgsql AS
$fn$
DECLARE
  v_nombre text := p_tabla::text;
  v_corto  text := (SELECT relname FROM pg_class WHERE oid = p_tabla);
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_nombre);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_nombre);
  EXECUTE format('CREATE POLICY %I ON %s TO tecnifin_admin USING (true) WITH CHECK (true)',
    'pol_' || v_corto || '_plataforma', v_nombre);
  EXECUTE format('CREATE POLICY %I ON %s FOR SELECT USING (%s)',
    'pol_' || v_corto || '_lectura', v_nombre, p_lectura);
  EXECUTE format('COMMENT ON TABLE %s IS %L', v_nombre,
    'plataforma: no pertenece a una cooperativa; administrada por tecnifin_admin');
END;
$fn$;

-- Invariantes del esquema, en UN solo lugar. Las comprueba tools/migrate.mjs despues de
-- CADA migracion, dentro de la misma transaccion: una tabla nueva que olvide aplicar_rls
-- no llega a existir. La prueba de aislamiento llama a esta misma funcion.
CREATE FUNCTION tecnifin.verificar_invariantes()
  RETURNS TABLE (objeto text, problema text) LANGUAGE sql STABLE AS
$fn$
  SELECT c.relname::text, 'sin cooperativa_id NOT NULL (y no esta marcada como tabla de plataforma)'
    FROM pg_class c
   WHERE c.relnamespace = 'tecnifin'::regnamespace AND c.relkind = 'r'
     AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'plataforma:%'
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'cooperativa_id'
                        AND a.attnotnull AND NOT a.attisdropped)
  UNION ALL
  SELECT c.relname::text, 'RLS sin habilitar, sin FORCE o sin politica'
    FROM pg_class c
   WHERE c.relnamespace = 'tecnifin'::regnamespace AND c.relkind = 'r'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
  UNION ALL
  -- Toda FK nace indexada (ADR-0003, regla 8). 13_fix_indices_fk_faltantes.sql tuvo que
  -- encontrar 27 columnas FK sin indice a posteriori; aqui no se puede aplicar una
  -- migracion que deje una sola sin soporte.
  SELECT (k.conrelid::regclass::text || '.' || k.conname), 'clave foranea sin indice de soporte'
    FROM pg_constraint k
   WHERE k.contype = 'f' AND k.connamespace = 'tecnifin'::regnamespace
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = k.conrelid
          AND i.indnkeyatts >= array_length(k.conkey, 1)
          AND (string_to_array(i.indkey::text, ' ')::smallint[])[1:array_length(k.conkey, 1)] @> k.conkey
          AND (string_to_array(i.indkey::text, ' ')::smallint[])[1:array_length(k.conkey, 1)] <@ k.conkey)
  UNION ALL
  -- Un SECURITY DEFINER mal puesto anula el RLS entero (ADR-0003, regla 9).
  SELECT p.proname::text, 'funcion SECURITY DEFINER'
    FROM pg_proc p
   WHERE p.pronamespace = 'tecnifin'::regnamespace AND p.prosecdef
$fn$;

COMMENT ON FUNCTION tecnifin.verificar_invariantes() IS
  'Filas = problemas. Vacio = esquema sano. La llama migrate.mjs tras cada migracion y la prueba de aislamiento.';

-- ---------------------------------------------------------------------------
-- cooperativas: la raiz. Su PK ES el tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.cooperativas (
  cooperativa_id   integer       GENERATED ALWAYS AS IDENTITY,
  codigo           varchar(20)   NOT NULL,
  razon_social     varchar(200)  NOT NULL,
  ruc              varchar(13)   NOT NULL,
  codigo_seps      varchar(20)   NULL,
  nombre_comercial varchar(100)  NOT NULL,
  color_primario   varchar(9)    NOT NULL DEFAULT '#002B67',
  color_acento     varchar(9)    NOT NULL DEFAULT '#03CED4',
  logo_url         varchar(300)  NULL,
  activa           boolean       NOT NULL DEFAULT true,
  fecha_alta       timestamptz(0) NOT NULL DEFAULT now(),
  CONSTRAINT pk_cooperativas PRIMARY KEY (cooperativa_id),
  CONSTRAINT uq_cooperativas_ruc UNIQUE (ruc),
  CONSTRAINT uq_cooperativas_codigo UNIQUE (codigo),
  CONSTRAINT ck_cooperativas_ruc CHECK (ruc ~ '^[0-9]{13}$'),
  CONSTRAINT ck_cooperativas_codigo CHECK (codigo ~ '^[A-Z0-9_-]{2,20}$')
);

-- El alta y la baja de cooperativas son operaciones de plataforma; la aplicacion solo lee
-- la suya. cooperativa_id es interno (no sale en URLs ni en documentos impresos); para lo
-- visible esta codigo.
SELECT tecnifin.aplicar_rls_plataforma('tecnifin.cooperativas',
  'cooperativa_id = (SELECT tecnifin.cooperativa_actual())');

-- ---------------------------------------------------------------------------
-- parametros_plataforma: lo que es de TECNIFIN y no de una cooperativa.
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.parametros_plataforma (
  clave       varchar(100) NOT NULL,
  valor       text         NOT NULL,
  descripcion varchar(300) NULL,
  CONSTRAINT pk_parametros_plataforma PRIMARY KEY (clave)
);

SELECT tecnifin.aplicar_rls_plataforma('tecnifin.parametros_plataforma', 'true');

-- El nombre visible de la plataforma es un dato, no una constante (regla 9).
INSERT INTO tecnifin.parametros_plataforma (clave, valor, descripcion) VALUES
  ('plataforma.nombre_visible', 'TECNIFIN', 'Nombre de la plataforma tal como se muestra en pantalla'),
  ('plataforma.razon_social',   'TECNIFIN S.A.S.', 'Denominacion principal; alterna: GUTT COMPANY S.A.S.'),
  ('plataforma.moneda',         'USD', 'Moneda de curso legal de la plataforma');

-- ---------------------------------------------------------------------------
-- usuarios
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.usuarios (
  usuario_id               bigint        GENERATED ALWAYS AS IDENTITY,
  cooperativa_id           integer       NOT NULL,
  login                    varchar(20)   NOT NULL,
  nombre_completo          varchar(150)  NOT NULL,
  pin                      varchar(4)    NULL,
  password_hash            varchar(200)  NOT NULL,
  rol                      varchar(30)   NOT NULL,
  activo                   boolean       NOT NULL DEFAULT true,
  impresora_predeterminada varchar(100)  NULL,
  fecha_registro           date          NULL,
  requiere_cambio_pin      boolean       NOT NULL DEFAULT false,
  fecha_creacion           timestamptz(0) NOT NULL DEFAULT now(),
  fecha_actualizacion      timestamptz(0) NOT NULL DEFAULT now(),
  -- PK compuesta con el tenant, no PK simple mas un UNIQUE aparte: es el destino de las
  -- FK compuestas de los hijos y, de paso, el indice queda agrupado por cooperativa, que
  -- es como lo recorre RLS. Un indice menos por tabla (ADR-0003, decision 8 de DAT-01).
  CONSTRAINT pk_usuarios PRIMARY KEY (cooperativa_id, usuario_id),
  CONSTRAINT uq_usuarios_cooperativa_login UNIQUE (cooperativa_id, login),
  CONSTRAINT fk_usuarios_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_usuarios_rol CHECK (rol IN ('SUPER_USER','ADMIN','MANAGER','CREDIT_OFFICER','TELLER','MEMBER')),
  -- El login se guarda canonizado en minusculas: SQL Server comparaba sin distinguir
  -- mayusculas por collation y PostgreSQL si distingue (ADR-0003, comparacion de texto).
  CONSTRAINT ck_usuarios_login CHECK (login = lower(login) AND login ~ '^[a-z0-9._-]{3,20}$')
);

COMMENT ON COLUMN tecnifin.usuarios.login IS
  'Equivale a Usuarios.UsuarioId del sistema viejo, que era PK global. Aqui es unico solo dentro de la cooperativa.';

SELECT tecnifin.aplicar_rls('tecnifin.usuarios');

-- Una columna "fecha_actualizacion" que nadie mantiene miente: con DEFAULT now() y sin
-- trigger se queda para siempre igual a fecha_creacion. La mantiene el motor.
CREATE FUNCTION tecnifin.fn_fecha_actualizacion() RETURNS trigger LANGUAGE plpgsql AS
$fn$
BEGIN
  NEW.fecha_actualizacion := now();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER tg_usuarios_fecha_actualizacion BEFORE UPDATE ON tecnifin.usuarios
  FOR EACH ROW EXECUTE FUNCTION tecnifin.fn_fecha_actualizacion();

-- ---------------------------------------------------------------------------
-- Numeracion por cooperativa (decision de Jorge, 2026-09-20)
-- Correlativos desde 1 en cada cooperativa. Nada de secuencias globales: una
-- secuencia compartida filtra entre tenants cuantos registros lleva el conjunto.
-- ---------------------------------------------------------------------------
CREATE TABLE tecnifin.secuencias_tenant (
  cooperativa_id integer     NOT NULL,
  nombre         varchar(40) NOT NULL,
  valor          bigint      NOT NULL DEFAULT 0,
  CONSTRAINT pk_secuencias_tenant PRIMARY KEY (cooperativa_id, nombre),
  CONSTRAINT fk_secuencias_tenant_cooperativa FOREIGN KEY (cooperativa_id)
    REFERENCES tecnifin.cooperativas (cooperativa_id),
  CONSTRAINT ck_secuencias_tenant_nombre CHECK (nombre ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT ck_secuencias_tenant_valor CHECK (valor >= 1)
);

COMMENT ON TABLE tecnifin.secuencias_tenant IS
  'Contadores por cooperativa (socio, cuenta, credito, solicitud, dpf_AAAAMM...). Reemplaza Seq_NumeroSocio y SecuenciaDPF.';

SELECT tecnifin.aplicar_rls('tecnifin.secuencias_tenant');

-- El contador solo avanza de uno en uno, y lo hace cumplir el motor: sin esto, un
-- UPDATE suelto podria retroceder el valor y reabrir numeros ya emitidos.
CREATE FUNCTION tecnifin.fn_secuencia_monotona() RETURNS trigger LANGUAGE plpgsql AS
$fn$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.valor <> 1 THEN
    RAISE EXCEPTION 'El contador % de la cooperativa % tiene que empezar en 1', NEW.nombre, NEW.cooperativa_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.valor <> OLD.valor + 1 THEN
    RAISE EXCEPTION 'El contador % solo avanza de uno en uno (de % a %)', NEW.nombre, OLD.valor, NEW.valor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER tg_secuencias_tenant_monotona
  BEFORE INSERT OR UPDATE ON tecnifin.secuencias_tenant
  FOR EACH ROW EXECUTE FUNCTION tecnifin.fn_secuencia_monotona();

-- Incremento atomico y sin huecos: el INSERT ... ON CONFLICT DO UPDATE toma el bloqueo
-- de fila y lo conserva hasta el COMMIT, asi que dos altas simultaneas se serializan.
-- Si la transaccion aborta, el contador vuelve atras con ella (a diferencia de una
-- SEQUENCE de PostgreSQL, que deja hueco). Sin huecos es requisito de auditoria SEPS.
CREATE FUNCTION tecnifin.siguiente_numero(p_nombre varchar) RETURNS bigint
  LANGUAGE plpgsql AS
$fn$
DECLARE
  v_cooperativa integer := tecnifin.cooperativa_actual();
  v_valor       bigint;
BEGIN
  IF v_cooperativa IS NULL THEN
    RAISE EXCEPTION 'No hay cooperativa fijada en la sesion: toda escritura pasa por withTenant()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO tecnifin.secuencias_tenant AS s (cooperativa_id, nombre, valor)
  VALUES (v_cooperativa, p_nombre, 1)
  ON CONFLICT (cooperativa_id, nombre) DO UPDATE SET valor = s.valor + 1
  RETURNING s.valor INTO v_valor;
  RETURN v_valor;
END;
$fn$;

COMMENT ON FUNCTION tecnifin.siguiente_numero(varchar) IS
  'Siguiente correlativo de la cooperativa actual, desde 1, atomico y sin huecos. Unico generador de numeros de negocio.';
