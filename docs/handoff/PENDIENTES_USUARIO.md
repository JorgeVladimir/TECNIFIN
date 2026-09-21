# Lo que solo pueden decidir Jorge o Christian (ninguna herramienta decide esto)

## Jorge
1. Sucursales: ¿alguna cooperativa objetivo tiene más de una oficina con caja propia? Decidir **antes del módulo de caja**. (Supuesto actual: no.)
2. Decimales de las tasas: ¿2 o 4? (Supuesto actual: `numeric(9,4)`.) Si son 4, ¿las amortizaciones ya emitidas se recalculan o se congelan?
3. Formato de los códigos `CRED-`/`SOL-`/`DPF-`: ¿lo exige algún documento impreso o reporte a la SEPS? (Supuesto: se conserva.)
4. `tasas_credito.plazo_minimo/maximo`: ¿meses o días? (Supuesto: meses.)
5. Nombres del Catálogo Único truncados a ~30 caracteres: ¿los reportes necesitan el nombre completo?
6. Contrato v3: cláusula 10.5 (pagos a Christian) y Fase 3 (ya no es «migración de datos reales»; requiere acta).
7. Contratar dominio `tecnifin.com` y hosting (tope USD 150). Hacer `git push` de este repo y de GUTT_SYSTEM.

## Christian (revisión expresa, cláusula 6.3; enviar borrador el 2-oct)
1. RPO/RTO y restauración de una cooperativa sin afectar a las otras. **Bloquea ADR-0002.**
2. Volumen y retención por cooperativa (decide si hay particionado).
3. ¿Algún cliente exigirá base o servidor dedicado?
4. Cifrado en reposo y de respaldos, y dónde viven las claves.
5. ¿Quién más se conecta a la base y con qué rol?
6. Acceso de soporte de TECNIFIN dentro de la cooperativa de un cliente (usuario nominal o rol de plataforma).
7. Vida del token JWT, refresh e invalidación.
8. **PA6 (seguridad, la más urgente):** `socios.pin` y `usuarios.pin` en claro; decidir antes de M1/M2.
9. PA10-PA13 (cartera): bandas de mora detectadas por el nombre de la cuenta, tipo de crédito sin FK al tarifario, rangos de provisión solapables, detalle de corrida editable.
