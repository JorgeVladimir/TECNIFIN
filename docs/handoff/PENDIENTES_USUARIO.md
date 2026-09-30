# Lo que solo pueden decidir Jorge o Christian (ninguna herramienta decide esto)

## Jorge
1. Sucursales: ¿alguna cooperativa objetivo tiene más de una oficina con caja propia? Decidir **antes del módulo de caja**. (Supuesto actual: no.)
2. Decimales de las tasas: ¿2 o 4? (Supuesto actual: `numeric(9,4)`.) Si son 4, ¿las amortizaciones ya emitidas se recalculan o se congelan?
3. Formato de los códigos `CRED-`/`SOL-`/`DPF-`: ¿lo exige algún documento impreso o reporte a la SEPS? (Supuesto: se conserva.)
4. `tasas_credito.plazo_minimo/maximo`: ¿meses o días? (Supuesto: meses.)
5. Nombres del Catálogo Único truncados a ~30 caracteres: ¿los reportes necesitan el nombre completo?
6. ~~Contrato v3~~ Resuelto en el contrato consolidado v2 (29-sep): Christian 497 × 10, Fase 3 = migración e integración sobre la demo, pagos al final de cada mes. Falta que la hoja de flujo de caja (Anexo D.5) cuadre (marzo a 350, Christian 497).
7. Dominio y hosting **postergados** hasta la inscripción de la sociedad (nombre reservado en Supercias: GUTT, 24-sep). Hacer `git push` de este repo y de GUTT_SYSTEM.

## ALTO 1 — decisión provisional tomada, pendiente de aprobación expresa de Christian
- **Jorge, 22-sep-2026: opción 1**, conservar GUC + controles compensatorios durante desarrollo; higiene, JWT y detección/alerta implementados. La detección de entrada/salida no observa un cambio y restauración dentro del mismo SQL. [Adenda ADR-0002](../adr/0002-aislamiento-de-datos.md#adenda-22-sep-2026--alto-1-confianza-en-la-fijación-del-tenant).
- El rol `tecnifin_app` todavía puede cambiar de tenant con SQL arbitrario: riesgo reproducido, **no corregido**. Christian debe aceptar expresamente por acta el riesgo y la cobertura de controles, o exigir contexto autenticado/credenciales aisladas antes de producción (cláusula 6.3; no se aprueba por silencio). ADR-0002 sigue en propuesta; pruebas verdes no equivalen a aprobación.

## Christian (revisión expresa, cláusula 6.3; enviar borrador el 2-oct)
1. RPO/RTO y restauración de una cooperativa sin afectar a las otras. **Bloquea ADR-0002.**
2. Volumen y retención por cooperativa (decide si hay particionado).
3. ¿Algún cliente exigirá base o servidor dedicado?
4. Cifrado en reposo y de respaldos, y dónde viven las claves.
5. ¿Quién más se conecta a la base y con qué rol?
6. Acceso de soporte de TECNIFIN dentro de la cooperativa de un cliente (usuario nominal o rol de plataforma).
7. Vida del token JWT, refresh e invalidación.
8. **PA6 (seguridad):** decisión provisional de Jorge (30-sep, migración 0017): se eliminaron `socios.pin` y
   `usuarios.pin`; el PIN del socio vive solo derivado en `activacion_banca_linea.pin_hash`. Reversible (base en
   blanco). **Christian debe confirmarlo o pedir otro tratamiento** (cláusula 6.3).
9. PA10-PA13 (cartera): bandas de mora detectadas por el nombre de la cuenta, tipo de crédito sin FK al tarifario, rangos de provisión solapables, detalle de corrida editable.

## Contador (nuevo, 1-oct)
1. DPF: validar la retención (hoy 2 %) y la base de días del interés (hoy 365). Son parámetros por cooperativa (dpf.retencion_pct, dpf.base_dias).
3. Créditos: interés de mora = tasa pactada × 1,1 sobre el capital vencido, base 360 (parámetros credito.factor_mora y credito.base_dias). Confirmar con la norma vigente.
2. Créditos: confirmar cuentas de los descuentos al desembolso (comisión 529010, fondo 330105, SOLCA 250490; la 25049005 del sistema anterior no existe en el catálogo).
