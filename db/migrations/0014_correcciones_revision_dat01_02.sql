-- 0014_correcciones_revision_dat01_02.sql -- hallazgos mecanicos DAT-01 / DAT-02
--
-- Corrige cuatro invariantes del esquema sin modificar migraciones ya aplicadas:
-- dinero finito, partida doble diferida, tablas particionadas y trazabilidad de
-- las corridas de cartera aplicadas.

-- PostgreSQL admite NaN e infinitos en numeric. El dominio deja la regla en un
-- solo lugar y sustituye todos los numeric(18,2), que son dinero en TECNIFIN.
CREATE DOMAIN tecnifin.dinero AS numeric(18,2)
  CONSTRAINT ck_dinero_finito CHECK (
    VALUE NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  );

COMMENT ON DOMAIN tecnifin.dinero IS
  'Importe monetario finito con dos decimales; rechaza NaN e infinitos.';

DO $migration$
DECLARE
  v_columna record;
BEGIN
  FOR v_columna IN
    SELECT n.nspname AS esquema, c.relname AS tabla, a.attname AS columna
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'tecnifin'
       AND c.relkind IN ('r', 'p')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND format_type(a.atttypid, a.atttypmod) = 'numeric(18,2)'
     ORDER BY c.relname, a.attnum
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE tecnifin.dinero USING %I::tecnifin.dinero',
      v_columna.esquema, v_columna.tabla, v_columna.columna, v_columna.columna
    );
  END LOOP;
END;
$migration$;

-- El evento diferido conserva OLD/NEW aunque el llamador cambie el parametro de
-- sesion. Se valida siempre el tenant de la fila y no se conserva ninguna marca
-- de "ya revisado": cada cambio vuelve a calcular el saldo final del asiento.
CREATE OR REPLACE FUNCTION tecnifin.fn_detalle_asiento_cuadre() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
DECLARE
  v_cooperativas integer[];
  v_asientos     bigint[];
  v_indice       integer;
  v_tenant_previo text := current_setting('app.cooperativa_id', true);
  v_debe         tecnifin.dinero;
  v_haber        tecnifin.dinero;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_cooperativas := ARRAY[NEW.cooperativa_id];
    v_asientos := ARRAY[NEW.asiento_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_cooperativas := ARRAY[OLD.cooperativa_id];
    v_asientos := ARRAY[OLD.asiento_id];
  ELSE
    v_cooperativas := ARRAY[OLD.cooperativa_id, NEW.cooperativa_id];
    v_asientos := ARRAY[OLD.asiento_id, NEW.asiento_id];
  END IF;

  FOR v_indice IN array_lower(v_asientos, 1)..array_upper(v_asientos, 1) LOOP
    PERFORM set_config('app.cooperativa_id', v_cooperativas[v_indice]::text, true);
    SELECT coalesce(sum(valor) FILTER (WHERE tipo_asiento = 'D'), 0),
           coalesce(sum(valor) FILTER (WHERE tipo_asiento = 'H'), 0)
      INTO v_debe, v_haber
      FROM tecnifin.detalle_asiento
     WHERE cooperativa_id = v_cooperativas[v_indice]
       AND asiento_id = v_asientos[v_indice];

    IF v_debe <> v_haber THEN
      RAISE EXCEPTION 'Asiento % descuadrado: debe = %, haber = %',
        v_asientos[v_indice], v_debe, v_haber
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  PERFORM set_config('app.cooperativa_id', coalesce(v_tenant_previo, ''), true);
  RETURN NULL;
END;
$fn$;

-- Una aplicacion deja importe positivo y asiento; una simulacion no deja ninguno.
-- REVERSADO conserva la combinacion que ya tuviera y no se redefine aqui su flujo.
ALTER TABLE tecnifin.reclasificacion_cartera
  DROP CONSTRAINT ck_reclasificacion_cartera_simulado,
  ADD CONSTRAINT ck_reclasificacion_cartera_simulado CHECK (
    estado <> 'SIMULADO' OR (asiento_id IS NULL AND provision_contabilizada = 0)
  ),
  ADD CONSTRAINT ck_reclasificacion_cartera_contabilizacion CHECK (
    (asiento_id IS NULL) = (provision_contabilizada = 0)
    AND (estado <> 'APLICADO' OR (asiento_id IS NOT NULL AND provision_contabilizada > 0))
  );

-- Las raices particionadas son relkind=p. Ademas, numeric(18,2) queda reservado
-- al dominio dinero para que una migracion futura no reabra NaN/Infinity.
CREATE OR REPLACE FUNCTION tecnifin.verificar_invariantes()
  RETURNS TABLE (objeto text, problema text) LANGUAGE sql STABLE AS
$fn$
  SELECT c.relname::text, 'sin cooperativa_id NOT NULL (y no esta marcada como tabla de plataforma)'
    FROM pg_class c
   WHERE c.relnamespace = 'tecnifin'::regnamespace AND c.relkind IN ('r', 'p')
     AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'plataforma:%'
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'cooperativa_id'
                        AND a.attnotnull AND NOT a.attisdropped)
  UNION ALL
  SELECT c.relname::text, 'RLS sin habilitar, sin FORCE o sin politica'
    FROM pg_class c
   WHERE c.relnamespace = 'tecnifin'::regnamespace AND c.relkind IN ('r', 'p')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
  UNION ALL
  SELECT (c.relname || '.' || a.attname)::text, 'columna de dinero sin dominio tecnifin.dinero'
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'tecnifin'::regnamespace AND c.relkind IN ('r', 'p')
     AND a.attnum > 0 AND NOT a.attisdropped
     AND format_type(a.atttypid, a.atttypmod) = 'numeric(18,2)'
  UNION ALL
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
  SELECT p.proname::text, 'funcion SECURITY DEFINER'
    FROM pg_proc p
   WHERE p.pronamespace = 'tecnifin'::regnamespace AND p.prosecdef
$fn$;
