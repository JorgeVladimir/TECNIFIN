-- 0023_m6_cartera_contabilizacion.sql -- M6
-- ck_reclasificacion_cartera_contabilizacion (0014) exigia que todo proceso APLICADO tuviera
-- provision contabilizada POSITIVA y que no hubiera asiento sin provision. El proceso real no
-- es asi: un mes puede reducir la provision (reversion, ajuste negativo), otro solo
-- reclasificar cuotas sin ajuste de provision, y la fila de reverso lleva asiento con
-- provision cero. Se reemplaza por la regla que si vale: una simulacion no contabiliza nada.

ALTER TABLE tecnifin.reclasificacion_cartera
  DROP CONSTRAINT ck_reclasificacion_cartera_contabilizacion,
  ADD CONSTRAINT ck_reclasificacion_cartera_contabilizacion CHECK (
    estado <> 'SIMULADO' OR (asiento_id IS NULL AND provision_contabilizada = 0));
