# Patron 10 — reportes regulatorios SEPS (M7)

`src/modules/reportes/servicio.js`. Todos salen del mismo libro (M5) y del mismo motor de cartera (M6,
`clasificar`), a una fecha de corte, en centavos enteros; los porcentajes se calculan con BigInt
(`porcentaje`, `porFraccion`), redondeo a la mitad y signo correcto. Roles: `MANAGER`, `ADMIN`, `SUPER_USER`.

| Sistema anterior (`POST /api/reports/generate.php`, `type`) | TECNIFIN |
|---|---|
| `sp_esf_seps` | `GET /api/reportes/esf?fecha=` — por rubro de 2 digitos, resultado del ejercicio en patrimonio, `cuadrado` |
| `sp_indicadores_perlas` | `GET /api/reportes/perlas?fecha=` — liquidez, morosidad ampliada (vencimientos reales), participacion y cobertura de cartera, ROA, ROE, absorcion del margen, solvencia regulatoria, patrimonio/activo; alertas de conciliacion |
| `sp_sepsb11` | `GET /api/reportes/b11?fecha=` — cartera por cuenta SEPS, segmento, estado y banda, con calificacion y provision por operacion |
| `sp_uaf_matriz` | `GET /api/reportes/uaf?periodo=AAAA-MM` — operaciones de caja no anuladas sobre el umbral individual y socios con acumulado mensual sobre el umbral |
| `sp_r_situa_gene` | `GET /api/reportes/situacion-general` |
| `sp_r_bal_compro` | `GET /api/contabilidad/balance?hasta=` (M5) |
| `GET /api/reportes/solvencia` | `GET /api/reportes/solvencia?fecha=` — activos ponderados por riesgo por categoria, patrimonio tecnico (primario, secundario computable, deducciones) e indice contra el minimo |

## Reglas

- **Una sola definicion:** la morosidad del B11 y de PERLAS sale de `clasificar` (la misma que usa el proceso de
  cartera); PERLAS publica alertas si la cartera contable o la improductiva contable no coinciden con la real.
- **Cartera bruta = 1401..1428**; `{14}` es neta (incluye 1499) y solo se usa cuando el denominador tambien lo es.
- **Solvencia** (Res. 127-2015-F): ponderacion por el prefijo mas largo de `ponderaciones_riesgo`; componentes de
  `parametros_patrimonio_tecnico` con tope sobre APR; resultado no cerrado a secundario (utilidad) o deduccion
  (perdida); secundario limitado al primario; minimo de `parametros_regulatorios.SOLVENCIA_MINIMA`.
- **UAF:** efectivo = operacion de caja (`transacciones_caja`) no anulada; umbrales por cooperativa en
  `parametros_cooperativa` (`uaf.umbral_individual` 5000, `uaf.umbral_mensual` 10000 por defecto).

## Diferencias con el sistema anterior

| Sistema anterior | TECNIFIN |
|---|---|
| Sin fecha de corte en ESF, PERLAS y balance | Todos a una fecha de corte |
| Situacion general sumaba creditos APROBADOS (no desembolsados) como cartera y usaba el monto, no el saldo | Solo VIGENTES y su saldo |
| UAF por asientos de la cuenta 110105 | Por operaciones de caja con socio, anuladas excluidas |
| Tolerancia de conciliacion (1 USD o 0,1 %) porque el plan de pagos no cerraba al centavo | La tabla cierra al centavo: la conciliacion es exacta |
| Coma flotante (`parseFloat`, `Math.round`) | Centavos enteros y BigInt |

## Pendiente

Formato de archivo de carga de cada estructura segun el manual SEPS vigente (hoy se entrega JSON), estado de
resultados como reporte propio y series historicas por corte.
