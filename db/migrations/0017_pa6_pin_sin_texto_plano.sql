-- 0017_pa6_pin_sin_texto_plano.sql -- PA6 (seguridad), decision provisional del 30-sep-2026
-- socios.pin y usuarios.pin venian del sistema anterior como NVARCHAR(4) legible. Alli el PIN
-- del socio era su clave de banca en linea y el de usuario un respaldo antiguo de la contrasena
-- (el perfil llegaba a devolverlo al cliente). En TECNIFIN:
--   * el PIN del socio vive SOLO derivado en activacion_banca_linea.pin_hash (dominio hash_secreto);
--   * el usuario interno entra con password_hash, que es obligatorio.
-- Ninguna de las dos columnas tiene uso ni datos (la base nace en blanco), asi que se eliminan.
-- Es reversible: si el Jefe de Proyecto decide otro tratamiento, una migracion posterior las
-- vuelve a crear con el formato que se apruebe. Pendiente de su confirmacion expresa (cl. 6.3).

ALTER TABLE tecnifin.socios DROP COLUMN pin;
ALTER TABLE tecnifin.usuarios DROP COLUMN pin;
