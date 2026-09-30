-- 0024_m6_provision_exige_asiento.sql -- M6
-- Complemento de 0023: una provision contabilizada distinta de cero sin asiento que la
-- respalde es incoherente en cualquier estado. (Un proceso aplicado sin ajuste de provision,
-- solo con reclasificacion, si puede tener asiento con provision cero.)

ALTER TABLE tecnifin.reclasificacion_cartera
  ADD CONSTRAINT ck_reclasificacion_cartera_provision_asiento CHECK (
    provision_contabilizada = 0 OR asiento_id IS NOT NULL);
