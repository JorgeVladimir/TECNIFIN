# Patron 09 — contabilidad (M5)

Un solo libro (`asientos_contables` + `detalle_asiento`) que escriben caja, creditos, plazo fijo, cartera y el
asiento manual; M5 solo lo lee (y agrega el asiento manual y el cierre). Roles: `MANAGER`, `ADMIN`, `SUPER_USER`.

| Endpoint | Efecto |
|---|---|
| `GET /api/contabilidad/libro-diario?desde&hasta&pagina` | Asientos del mas reciente al mas antiguo, 50 por pagina, con sus lineas, documento, modulo y usuario |
| `GET /api/contabilidad/balance?hasta=` | Balance de comprobacion a la fecha: cada cuenta del plan con movimiento propio o de sus hijas (los agrupadores suman por prefijo), debe, haber y saldo **segun la naturaleza** (activo y gasto D-H; pasivo, patrimonio e ingreso H-D); total debe = total haber |
| `GET /api/contabilidad/mayor/:codigo?desde&hasta` | Mayor de la cuenta y sus hijas: saldo inicial (antes de `desde`) y saldo acumulado por linea, en centavos enteros |
| `POST /api/contabilidad/asientos` | Asiento manual (`origen_modulo = MANUAL`): 2 a 100 lineas, cuadre verificado antes de escribir (la base tambien lo exige), sin cuentas de agrupacion, auditado |
| `POST /api/contabilidad/periodos/:anio/:mes/cerrar` | Cierra un mes ya terminado; despues ningun modulo contabiliza en el (`periodoDelDia`) |

Frente al sistema anterior: el libro diario tenia un tope de 500 filas sin paginar; el balance agrupaba por cuenta
sin jerarquia, sin fecha de corte y sin saldo segun naturaleza; no habia mayor por cuenta ni cierre de periodo.

Pendiente: reapertura controlada de periodos, estados financieros (ESF y resultados) que salen de este balance
en M7, y el cierre anual (utilidad del ejercicio a patrimonio).
