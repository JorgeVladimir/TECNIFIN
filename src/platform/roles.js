// Grupos de roles de toda la aplicacion (regla 13): un solo lugar, con los mismos nombres que
// la leyenda de docs/api/CATALOGO.md. Cambiar un grupo aqui cambia todos los endpoints que lo usan.
const grupo = (...roles) => Object.freeze(new Set(roles));

export const TODOS_LOS_ROLES = grupo('SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER', 'TELLER', 'MEMBER');
export const ROLES_ADMIN = grupo('SUPER_USER', 'ADMIN');
export const ROLES_SUPERVISOR = grupo('SUPER_USER', 'ADMIN', 'MANAGER');
export const ROLES_ANALISIS = grupo('SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER');
export const ROLES_CAJA = grupo('SUPER_USER', 'ADMIN', 'MANAGER', 'TELLER');
export const ROLES_ATENCION = grupo('SUPER_USER', 'ADMIN', 'MANAGER', 'CREDIT_OFFICER', 'TELLER');
