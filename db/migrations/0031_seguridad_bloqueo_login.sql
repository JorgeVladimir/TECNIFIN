-- 0031_seguridad_bloqueo_login.sql -- endurecimiento (Fase 5 adelantada): bloqueo por intentos
-- Cada clave equivocada de un usuario existente suma un intento. Al llegar a
-- auth.max_intentos (5 por defecto) la cuenta queda bloqueada auth.bloqueo_minutos (15) y se
-- emite una alerta. El login exitoso o un restablecimiento de clave limpian el contador.
-- La respuesta al cliente es la misma de cualquier credencial invalida: no revela si la
-- cuenta existe ni si esta bloqueada.
ALTER TABLE tecnifin.usuarios
  ADD COLUMN intentos_fallidos integer NOT NULL DEFAULT 0,
  ADD COLUMN bloqueado_hasta timestamptz(0) NULL,
  ADD CONSTRAINT ck_usuarios_intentos CHECK (intentos_fallidos >= 0);
