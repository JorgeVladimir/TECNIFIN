-- 0010_rls_y_permisos.sql -- DAT-01 / hito H1
-- Reparte los permisos del rol de la aplicacion y deja constancia del estado final.
--
-- Separacion de roles (ADR-0002, punto 1):
--   tecnifin_admin  dueno del esquema, ejecuta las migraciones. La aplicacion NO lo usa.
--   tecnifin_app    solo DML, no es dueno de nada, sin BYPASSRLS, sin SUPERUSER.
-- Que el rol de la aplicacion no sea dueno es la mitad del aislamiento: la otra mitad es
-- FORCE ROW LEVEL SECURITY, que quita el atajo tambien al dueno.
--
-- Los invariantes del esquema (cooperativa_id, RLS, FORCE, politica, indice por FK, cero
-- SECURITY DEFINER) NO se comprueban aqui: viven en tecnifin.verificar_invariantes() y
-- tools/migrate.mjs los exige despues de CADA migracion, incluidas las que vengan
-- despues de esta. Comprobarlos solo en este archivo dejaria fuera a la migracion 0011.

GRANT USAGE ON SCHEMA tecnifin TO tecnifin_app;
-- public solo aloja las extensiones de busqueda; la aplicacion las usa pero no crea nada.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tecnifin_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tecnifin TO tecnifin_app;

-- Alta y baja de cooperativas, y los parametros de la plataforma, son operaciones de
-- plataforma: la aplicacion solo lee. (Sus politicas de escritura ya son solo para
-- tecnifin_admin; el REVOKE es la segunda barrera, para que el intento ni siquiera
-- llegue a evaluarse.)
REVOKE INSERT, UPDATE, DELETE ON tecnifin.cooperativas FROM tecnifin_app;
REVOKE INSERT, UPDATE, DELETE ON tecnifin.parametros_plataforma FROM tecnifin_app;
-- Auditoria append-only (ADR-0003, regla transversal 7). El trigger que instala
-- aplicar_rls(..., true) ya lo impide para todos los roles; esto lo corta antes.
REVOKE UPDATE, DELETE ON tecnifin.auditoria_procesos FROM tecnifin_app;
REVOKE UPDATE, DELETE ON tecnifin.auditoria_usuarios FROM tecnifin_app;
-- El contador nunca retrocede ni se borra: solo lo mueve tecnifin.siguiente_numero(),
-- y el trigger tg_secuencias_tenant_monotona exige que avance de uno en uno.
REVOKE DELETE ON tecnifin.secuencias_tenant FROM tecnifin_app;

-- Las tablas que agreguen las migraciones siguientes heredan estos permisos. Sin
-- FOR ROLE: aplica al rol que ejecuta la migracion, que es el dueno del esquema.
ALTER DEFAULT PRIVILEGES IN SCHEMA tecnifin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tecnifin_app;

-- Las funciones que hacen DDL o que definen el modelo solo las usa el dueno, desde una
-- migracion. PUBLIC no necesita ejecutarlas.
REVOKE ALL ON FUNCTION tecnifin.aplicar_rls(regclass, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION tecnifin.aplicar_rls_plataforma(regclass, text) FROM PUBLIC;
