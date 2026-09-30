# DAT-01 · Diccionario de datos del modelo multi-tenant

Generado del catálogo de PostgreSQL con `node tools/diccionario.mjs` el 2026-09-30.
No se edita a mano: si el esquema cambia, se vuelve a generar.

## Resumen

| Indicador | Valor |
|---|---|
| Migraciones versionadas aplicadas | 15 |
| Tablas en el esquema `tecnifin` | 41 |
| Tablas con `cooperativa_id` (datos de una cooperativa) | 40 |
| De ellas con seguridad por filas habilitada **y forzada** | 40 |
| Políticas de seguridad por filas | 44 |
| Tablas de plataforma (sin `cooperativa_id`) | 1 |

## Índice

| Tabla | Tenant | RLS forzada | Políticas | Descripción |
|---|---|---|---|---|
| [activacion_banca_linea](#activacion_banca_linea) | sí | sí | 1 |  |
| [asientos_contables](#asientos_contables) | sí | sí | 1 |  |
| [auditoria_procesos](#auditoria_procesos) | sí | sí | 1 |  |
| [auditoria_usuarios](#auditoria_usuarios) | sí | sí | 1 |  |
| [calificacion_cartera](#calificacion_cartera) | sí | sí | 1 |  |
| [control_caja](#control_caja) | sí | sí | 1 |  |
| [cooperativas](#cooperativas) | sí | sí | 3 | plataforma: no pertenece a una cooperativa; administrada por tecnifin_admin |
| [creditos](#creditos) | sí | sí | 1 |  |
| [cuentas](#cuentas) | sí | sí | 1 |  |
| [denominaciones](#denominaciones) | sí | sí | 1 |  |
| [depositos_plazo](#depositos_plazo) | sí | sí | 1 |  |
| [detalle_asiento](#detalle_asiento) | sí | sí | 1 |  |
| [detalle_efectivo_transaccion](#detalle_efectivo_transaccion) | sí | sí | 1 |  |
| [movimientos_cuenta](#movimientos_cuenta) | sí | sí | 1 |  |
| [parametros_cooperativa](#parametros_cooperativa) | sí | sí | 1 | Configuracion operativa por tenant. APP-01 no fija valores definitivos para vida, refresh ni invalidacion JWT. |
| [parametros_patrimonio_tecnico](#parametros_patrimonio_tecnico) | sí | sí | 1 |  |
| [parametros_plataforma](#parametros_plataforma) | plataforma | sí | 2 | plataforma: no pertenece a una cooperativa; administrada por tecnifin_admin |
| [parametros_provision_cartera](#parametros_provision_cartera) | sí | sí | 1 |  |
| [parametros_regulatorios](#parametros_regulatorios) | sí | sí | 1 | Limites regulatorios por cooperativa (solvencia minima, topes, umbrales). Se edita el dato, no el codigo. |
| [periodos_contables](#periodos_contables) | sí | sí | 1 |  |
| [plan_cuentas](#plan_cuentas) | sí | sí | 1 |  |
| [ponderaciones_riesgo](#ponderaciones_riesgo) | sí | sí | 1 |  |
| [productos_financieros](#productos_financieros) | sí | sí | 1 |  |
| [reclasificacion_cartera](#reclasificacion_cartera) | sí | sí | 1 | Corridas del proceso mensual de cartera. SIMULADO es el estado por defecto: aplicar es explicito. |
| [reclasificacion_cartera_detalle](#reclasificacion_cartera_detalle) | sí | sí | 1 |  |
| [rubros_creditos](#rubros_creditos) | sí | sí | 1 |  |
| [secuencias_tenant](#secuencias_tenant) | sí | sí | 1 | Contadores por cooperativa (socio, cuenta, credito, solicitud, dpf_AAAAMM...). Reemplaza Seq_NumeroSocio y SecuenciaDPF. |
| [socio_carga](#socio_carga) | sí | sí | 1 |  |
| [socio_conyuge](#socio_conyuge) | sí | sí | 1 |  |
| [socio_croquis_trabajo](#socio_croquis_trabajo) | sí | sí | 1 |  |
| [socio_direccion](#socio_direccion) | sí | sí | 1 |  |
| [socio_documento_excepcion](#socio_documento_excepcion) | sí | sí | 1 |  |
| [socio_referencia](#socio_referencia) | sí | sí | 1 |  |
| [socio_ubicacion_mapa](#socio_ubicacion_mapa) | sí | sí | 1 |  |
| [socios](#socios) | sí | sí | 1 |  |
| [solicitudes_credito](#solicitudes_credito) | sí | sí | 1 |  |
| [tabla_amortizacion](#tabla_amortizacion) | sí | sí | 1 |  |
| [tasas_credito](#tasas_credito) | sí | sí | 1 |  |
| [tasas_plazo_fijo](#tasas_plazo_fijo) | sí | sí | 1 |  |
| [transacciones_caja](#transacciones_caja) | sí | sí | 1 |  |
| [usuarios](#usuarios) | sí | sí | 1 |  |

## activacion_banca_linea

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| activacion_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| pin_hash | hash_secreto | sí |  | Hash del PIN del canal en linea. Nunca el PIN. El CHECK impide guardarlo en claro por descuido. |
| codigo_verificacion_hash | hash_secreto |  |  |  |
| codigo_verificacion_expira | timestamp(0) with time zone |  |  |  |
| fecha_registro | timestamp(0) with time zone | sí | now() |  |
| acepto_datos_personales | boolean | sí | false |  |
| fecha_aceptacion_datos | timestamp(0) with time zone |  |  |  |
| activo | boolean | sí | false |  |

**Restricciones**

- Verificación `ck_activacion_banca_linea_activo`: `CHECK (((activo = false) OR (acepto_datos_personales = true)))`
- Verificación `ck_activacion_banca_linea_codigo_expira`: `CHECK (((codigo_verificacion_hash IS NULL) = (codigo_verificacion_expira IS NULL)))`
- Verificación `ck_activacion_banca_linea_consentimiento`: `CHECK (((acepto_datos_personales = false) OR (fecha_aceptacion_datos IS NOT NULL)))`
- Clave foránea `fk_activacion_banca_linea_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_activacion_banca_linea`: `PRIMARY KEY (cooperativa_id, activacion_id)`

## asientos_contables

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| asiento_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| periodo_contable_id | integer | sí |  |  |
| fecha | date | sí | CURRENT_DATE |  |
| tipo_documento | character varying(30) |  |  |  |
| concepto | character varying(300) | sí |  |  |
| anulado | boolean | sí | false |  |
| usuario_id | bigint | sí |  |  |
| origen_modulo | character varying(20) |  |  |  |
| origen_id | character varying(50) |  |  |  |
| fecha_registro | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_asientos_contables_origen`: `CHECK (((origen_modulo IS NULL) OR ((origen_modulo)::text = ANY ((ARRAY['CREDITOS'::character varying, 'CAJA'::character varying, 'PLAZO_FIJO'::character varying, 'TRANSFERENCIAS'::character varying, 'MANUAL'::character varying])::text[]))))`
- Clave foránea `fk_asientos_contables_periodo`: `FOREIGN KEY (cooperativa_id, periodo_contable_id) REFERENCES periodos_contables(cooperativa_id, periodo_id)`
- Clave foránea `fk_asientos_contables_usuario`: `FOREIGN KEY (cooperativa_id, usuario_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_asientos_contables`: `PRIMARY KEY (cooperativa_id, asiento_id)`

## auditoria_procesos

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| auditoria_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| proceso | character varying(50) | sí |  |  |
| accion | character varying(50) | sí |  |  |
| entidad_tipo | character varying(50) | sí |  |  |
| entidad_id | character varying(50) |  |  |  |
| usuario_login | character varying(20) | sí |  |  |
| campo_afectado | character varying(100) |  |  |  |
| valor_anterior | text |  |  |  |
| valor_nuevo | text |  |  |  |
| detalle | character varying(500) |  |  |  |
| ip_origen | character varying(45) |  |  |  |
| fecha_registro | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_auditoria_procesos_proceso`: `CHECK (((proceso)::text = ANY ((ARRAY['CREDITOS'::character varying, 'CAJA'::character varying, 'AHORROS'::character varying, 'PLAZO_FIJO'::character varying, 'CONTABILIDAD'::character varying, 'SOCIOS'::character varying, 'SEGURIDAD'::character varying, 'REPORTES_SEPS'::character varying])::text[])))`
- Clave foránea `fk_auditoria_procesos_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_auditoria_procesos`: `PRIMARY KEY (cooperativa_id, auditoria_id)`

## auditoria_usuarios

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| auditoria_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| usuario_login | character varying(20) | sí |  |  |
| concepto | character varying(100) | sí |  |  |
| detalle | character varying(500) | sí |  |  |
| fecha_registro | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Clave foránea `fk_auditoria_usuarios_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_auditoria_usuarios`: `PRIMARY KEY (cooperativa_id, auditoria_id)`

## calificacion_cartera

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| calificacion_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| credito_id | bigint | sí |  |  |
| fecha_corte | date | sí |  |  |
| saldo_capital | dinero | sí |  |  |
| dias_mora | integer | sí | 0 |  |
| categoria | calificacion_riesgo | sí |  |  |
| porcentaje_provision | numeric(9,4) | sí | 0 |  |
| valor_provision | dinero | sí | 0 |  |

**Restricciones**

- Verificación `ck_calificacion_cartera_dias`: `CHECK ((dias_mora >= 0))`
- Clave foránea `fk_calificacion_cartera_credito`: `FOREIGN KEY (cooperativa_id, credito_id) REFERENCES creditos(cooperativa_id, credito_id)`
- Clave primaria `pk_calificacion_cartera`: `PRIMARY KEY (cooperativa_id, calificacion_id)`
- Única `uq_calificacion_cartera_credito_corte`: `UNIQUE (cooperativa_id, credito_id, fecha_corte)`

## control_caja

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| control_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| usuario_id | bigint | sí |  |  |
| fecha | date | sí |  |  |
| hora_apertura | timestamp(0) with time zone | sí | now() |  |
| hora_cierre | timestamp(0) with time zone |  |  |  |
| saldo_apertura | dinero | sí |  |  |
| saldo_cierre | dinero |  |  |  |
| estado | character varying(20) | sí | 'ABIERTO'::character varying |  |

**Restricciones**

- Verificación `ck_control_caja_cierre`: `CHECK (((((estado)::text = 'ABIERTO'::text) AND (hora_cierre IS NULL) AND (saldo_cierre IS NULL)) OR (((estado)::text = 'CERRADO'::text) AND (hora_cierre IS NOT NULL) AND (saldo_cierre IS NOT NULL))))`
- Verificación `ck_control_caja_estado`: `CHECK (((estado)::text = ANY ((ARRAY['ABIERTO'::character varying, 'CERRADO'::character varying])::text[])))`
- Clave foránea `fk_control_caja_usuario`: `FOREIGN KEY (cooperativa_id, usuario_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_control_caja`: `PRIMARY KEY (cooperativa_id, control_id)`
- Única `uq_control_caja_usuario_fecha`: `UNIQUE (cooperativa_id, usuario_id, fecha)`

## cooperativas

plataforma: no pertenece a una cooperativa; administrada por tecnifin_admin

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cooperativa_id | integer | sí |  |  |
| codigo | character varying(20) | sí |  |  |
| razon_social | character varying(200) | sí |  |  |
| ruc | character varying(13) | sí |  |  |
| codigo_seps | character varying(20) |  |  |  |
| nombre_comercial | character varying(100) | sí |  |  |
| color_primario | character varying(9) | sí | '#002B67'::character varying |  |
| color_acento | character varying(9) | sí | '#03CED4'::character varying |  |
| logo_url | character varying(300) |  |  |  |
| activa | boolean | sí | true |  |
| fecha_alta | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_cooperativas_codigo`: `CHECK (((codigo)::text ~ '^[A-Z0-9_-]{2,20}$'::text))`
- Verificación `ck_cooperativas_ruc`: `CHECK (((ruc)::text ~ '^[0-9]{13}$'::text))`
- Clave primaria `pk_cooperativas`: `PRIMARY KEY (cooperativa_id)`
- Única `uq_cooperativas_codigo`: `UNIQUE (codigo)`
- Única `uq_cooperativas_ruc`: `UNIQUE (ruc)`

## creditos

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| credito_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo | character varying(50) | sí |  |  |
| solicitud_id | bigint | sí |  |  |
| socio_id | bigint | sí |  |  |
| monto | dinero | sí |  |  |
| saldo | dinero | sí |  |  |
| tasa | numeric(9,4) | sí |  |  |
| plazo | integer | sí |  |  |
| tipo | character varying(100) | sí |  |  |
| estado | character varying(30) | sí |  |  |
| fecha_desembolso | date | sí | CURRENT_DATE |  |
| fecha_vencimiento | date |  |  |  |
| tipo_aprobacion | character varying(50) |  |  |  |
| acta_sesion | character varying(100) |  |  |  |
| tipo_prenda | character varying(100) |  |  |  |
| avaluo_prendario | dinero |  |  |  |
| observacion_tecnica_prenda | character varying(500) |  |  |  |
| valor_cobertura | dinero |  |  |  |

**Restricciones**

- Verificación `ck_creditos_estado`: `CHECK (((estado)::text = ANY ((ARRAY['VIGENTE'::character varying, 'CANCELADO'::character varying, 'CASTIGADO'::character varying, 'REFINANCIADO'::character varying, 'REESTRUCTURADO'::character varying])::text[])))`
- Verificación `ck_creditos_monto`: `CHECK (((monto)::numeric > (0)::numeric))`
- Verificación `ck_creditos_saldo`: `CHECK (((saldo)::numeric >= (0)::numeric))`
- Clave foránea `fk_creditos_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id)`
- Clave foránea `fk_creditos_solicitud`: `FOREIGN KEY (cooperativa_id, solicitud_id) REFERENCES solicitudes_credito(cooperativa_id, solicitud_id)`
- Clave primaria `pk_creditos`: `PRIMARY KEY (cooperativa_id, credito_id)`
- Única `uq_creditos_cooperativa_codigo`: `UNIQUE (cooperativa_id, codigo)`
- Única `uq_creditos_solicitud`: `UNIQUE (cooperativa_id, solicitud_id)`

## cuentas

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cuenta_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| numero_cuenta | bigint | sí | siguiente_numero('cuenta'::character varying) |  |
| numero_cuenta_anterior | character varying(20) |  |  | Numero de cuenta en el sistema de origen. Dato de migracion (MIG-01); el numero vigente es numero_cuenta. |
| producto_id | integer | sí |  |  |
| saldo | dinero | sí | 0.00 |  |
| fecha_apertura | date | sí | CURRENT_DATE |  |
| estado | character varying(20) | sí | 'ACTIVA'::character varying |  |

**Restricciones**

- Verificación `ck_cuentas_estado`: `CHECK (((estado)::text = ANY ((ARRAY['ACTIVA'::character varying, 'INACTIVA'::character varying, 'BLOQUEADA'::character varying, 'CERRADA'::character varying])::text[])))`
- Verificación `ck_cuentas_numero`: `CHECK ((numero_cuenta > 0))`
- Clave foránea `fk_cuentas_producto`: `FOREIGN KEY (cooperativa_id, producto_id) REFERENCES productos_financieros(cooperativa_id, producto_id)`
- Clave foránea `fk_cuentas_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id)`
- Clave primaria `pk_cuentas`: `PRIMARY KEY (cooperativa_id, cuenta_id)`
- Única `uq_cuentas_cooperativa_numero`: `UNIQUE (cooperativa_id, numero_cuenta)`

## denominaciones

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo_denominacion | character varying(10) | sí |  |  |
| valor | dinero | sí |  |  |
| tipo | character varying(10) | sí |  |  |
| descripcion | character varying(50) | sí |  |  |
| activa | boolean | sí | true |  |

**Restricciones**

- Verificación `ck_denominaciones_tipo`: `CHECK (((tipo)::text = ANY ((ARRAY['BILLETE'::character varying, 'MONEDA'::character varying])::text[])))`
- Verificación `ck_denominaciones_valor`: `CHECK (((valor)::numeric > (0)::numeric))`
- Clave foránea `fk_denominaciones_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_denominaciones`: `PRIMARY KEY (cooperativa_id, codigo_denominacion)`

## depositos_plazo

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| deposito_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo | character varying(20) | sí |  | Codigo visible del certificado (DPF-AAAAMM-NNNN). Se arma con tecnifin.siguiente_numero('dpf_AAAAMM'). |
| socio_id | bigint | sí |  |  |
| identificacion | character varying(20) | sí |  |  |
| nombre_socio | character varying(200) | sí |  |  |
| num_certificado | character varying(20) | sí |  |  |
| tasa_id | integer | sí |  |  |
| tasa_nominal_anual | numeric(9,4) | sí |  |  |
| plazo_dias | integer | sí |  |  |
| monto_capital | dinero | sí |  |  |
| interes_proyectado | dinero | sí |  |  |
| retencion_proyectada | dinero | sí |  |  |
| interes_neto_proyectado | dinero | sí |  |  |
| fecha_apertura | date | sí | CURRENT_DATE |  |
| fecha_vencimiento | date | sí |  |  |
| estado | character varying(20) | sí | 'ACTIVO'::character varying |  |
| tipo_renovacion | character varying(20) | sí | 'NO_RENOVAR'::character varying |  |
| modalidad_pago | character varying(20) | sí | 'AL_VENCIMIENTO'::character varying |  |
| cuenta_ahorros_id | bigint |  |  |  |
| cuenta_contable_dpf | codigo_contable | sí |  |  |
| fecha_liquidacion | date |  |  |  |
| interes_liquidado | dinero |  |  |  |
| retencion_aplicada | dinero |  |  |  |
| interes_neto_liquidado | dinero |  |  |  |
| penalizacion_aplicada | dinero |  |  |  |
| motivos_cancelacion | character varying(400) |  |  |  |
| numero_renovacion | integer | sí | 0 |  |
| deposito_origen_id | bigint |  |  |  |
| usuario_apertura_id | bigint | sí |  |  |
| usuario_liquidacion_id | bigint |  |  |  |
| observaciones | character varying(500) |  |  |  |
| fecha_creacion | timestamp(0) with time zone | sí | now() |  |
| fecha_modificacion | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_depositos_plazo_capital`: `CHECK (((monto_capital)::numeric > (0)::numeric))`
- Verificación `ck_depositos_plazo_dias`: `CHECK ((plazo_dias > 0))`
- Verificación `ck_depositos_plazo_estado`: `CHECK (((estado)::text = ANY ((ARRAY['ACTIVO'::character varying, 'VENCIDO'::character varying, 'LIQUIDADO'::character varying, 'CANCELADO'::character varying, 'RENOVADO'::character varying])::text[])))`
- Verificación `ck_depositos_plazo_modalidad`: `CHECK (((modalidad_pago)::text = ANY ((ARRAY['AL_VENCIMIENTO'::character varying, 'MENSUAL'::character varying, 'TRIMESTRAL'::character varying])::text[])))`
- Verificación `ck_depositos_plazo_renovacion`: `CHECK (((tipo_renovacion)::text = ANY ((ARRAY['NO_RENOVAR'::character varying, 'AUTOMATICO'::character varying, 'MANUAL'::character varying])::text[])))`
- Verificación `ck_depositos_plazo_vencimiento`: `CHECK ((fecha_vencimiento > fecha_apertura))`
- Clave foránea `fk_depositos_plazo_cuenta_ahorros`: `FOREIGN KEY (cooperativa_id, cuenta_ahorros_id) REFERENCES cuentas(cooperativa_id, cuenta_id)`
- Clave foránea `fk_depositos_plazo_cuenta_contable`: `FOREIGN KEY (cooperativa_id, cuenta_contable_dpf) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_depositos_plazo_origen`: `FOREIGN KEY (cooperativa_id, deposito_origen_id) REFERENCES depositos_plazo(cooperativa_id, deposito_id)`
- Clave foránea `fk_depositos_plazo_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id)`
- Clave foránea `fk_depositos_plazo_tasa`: `FOREIGN KEY (cooperativa_id, tasa_id) REFERENCES tasas_plazo_fijo(cooperativa_id, tasa_id)`
- Clave foránea `fk_depositos_plazo_usuario_apertura`: `FOREIGN KEY (cooperativa_id, usuario_apertura_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave foránea `fk_depositos_plazo_usuario_liquidacion`: `FOREIGN KEY (cooperativa_id, usuario_liquidacion_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_depositos_plazo`: `PRIMARY KEY (cooperativa_id, deposito_id)`
- Única `uq_depositos_plazo_cooperativa_certificado`: `UNIQUE (cooperativa_id, num_certificado)`
- Única `uq_depositos_plazo_cooperativa_codigo`: `UNIQUE (cooperativa_id, codigo)`

## detalle_asiento

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| detalle_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| asiento_id | bigint | sí |  |  |
| cuenta_contable_id | integer | sí |  |  |
| tipo_asiento | character(1) | sí |  |  |
| valor | dinero | sí |  |  |
| socio_id | bigint |  |  |  |

**Restricciones**

- Verificación `ck_detalle_asiento_tipo`: `CHECK ((tipo_asiento = ANY (ARRAY['D'::bpchar, 'H'::bpchar])))`
- Verificación `ck_detalle_asiento_valor`: `CHECK (((valor)::numeric > (0)::numeric))`
- Clave foránea `fk_detalle_asiento_asiento`: `FOREIGN KEY (cooperativa_id, asiento_id) REFERENCES asientos_contables(cooperativa_id, asiento_id) ON DELETE CASCADE`
- Clave foránea `fk_detalle_asiento_cuenta`: `FOREIGN KEY (cooperativa_id, cuenta_contable_id) REFERENCES plan_cuentas(cooperativa_id, cuenta_contable_id)`
- Clave foránea `fk_detalle_asiento_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id)`
- Clave primaria `pk_detalle_asiento`: `PRIMARY KEY (cooperativa_id, detalle_id)`

## detalle_efectivo_transaccion

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| detalle_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| transaccion_id | bigint | sí |  |  |
| codigo_denominacion | character varying(10) | sí |  |  |
| cantidad | integer | sí |  |  |
| total | dinero | sí |  |  |

**Restricciones**

- Verificación `ck_detalle_efectivo_cantidad`: `CHECK ((cantidad > 0))`
- Clave foránea `fk_detalle_efectivo_denominacion`: `FOREIGN KEY (cooperativa_id, codigo_denominacion) REFERENCES denominaciones(cooperativa_id, codigo_denominacion)`
- Clave foránea `fk_detalle_efectivo_transaccion`: `FOREIGN KEY (cooperativa_id, transaccion_id) REFERENCES transacciones_caja(cooperativa_id, transaccion_id) ON DELETE CASCADE`
- Clave primaria `pk_detalle_efectivo_transaccion`: `PRIMARY KEY (cooperativa_id, detalle_id)`
- Única `uq_detalle_efectivo_transaccion_denominacion`: `UNIQUE (cooperativa_id, transaccion_id, codigo_denominacion)`

## movimientos_cuenta

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| movimiento_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| cuenta_id | bigint | sí |  |  |
| tipo | character varying(30) | sí |  |  |
| monto | dinero | sí |  |  |
| saldo_resultante | dinero | sí |  |  |
| concepto | character varying(200) |  |  |  |
| fecha | timestamp(0) with time zone | sí | now() |  |
| usuario_id | bigint | sí |  |  |
| transaccion_caja_id | bigint |  |  |  |
| asiento_contable_id | bigint |  |  |  |

**Restricciones**

- Verificación `ck_movimientos_cuenta_monto`: `CHECK (((monto)::numeric > (0)::numeric))`
- Verificación `ck_movimientos_cuenta_tipo`: `CHECK (((tipo)::text = ANY ((ARRAY['DEPOSITO'::character varying, 'RETIRO'::character varying, 'TRANSFERENCIA_ENTRADA'::character varying, 'TRANSFERENCIA_SALIDA'::character varying, 'AJUSTE'::character varying])::text[])))`
- Clave foránea `fk_movimientos_cuenta_asiento`: `FOREIGN KEY (cooperativa_id, asiento_contable_id) REFERENCES asientos_contables(cooperativa_id, asiento_id)`
- Clave foránea `fk_movimientos_cuenta_cuenta`: `FOREIGN KEY (cooperativa_id, cuenta_id) REFERENCES cuentas(cooperativa_id, cuenta_id)`
- Clave foránea `fk_movimientos_cuenta_transaccion`: `FOREIGN KEY (cooperativa_id, transaccion_caja_id) REFERENCES transacciones_caja(cooperativa_id, transaccion_id)`
- Clave foránea `fk_movimientos_cuenta_usuario`: `FOREIGN KEY (cooperativa_id, usuario_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_movimientos_cuenta`: `PRIMARY KEY (cooperativa_id, movimiento_id)`

## parametros_cooperativa

Configuracion operativa por tenant. APP-01 no fija valores definitivos para vida, refresh ni invalidacion JWT.

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| clave | character varying(100) | sí |  |  |
| valor | text | sí |  |  |
| descripcion | character varying(300) |  |  |  |
| fecha_actualizacion | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_parametros_cooperativa_clave`: `CHECK (((clave)::text ~ '^[a-z0-9][a-z0-9._-]{2,99}$'::text))`
- Clave foránea `fk_parametros_cooperativa_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_parametros_cooperativa`: `PRIMARY KEY (cooperativa_id, clave)`

## parametros_patrimonio_tecnico

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| parametro_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| componente | character varying(20) | sí |  |  |
| prefijo_cuenta | codigo_contable | sí |  |  |
| factor | numeric(9,4) | sí | 1 |  |
| saldo_como | character varying(10) | sí | 'ACREEDOR'::character varying |  |
| limite_pct_apr | numeric(9,4) |  |  |  |
| descripcion | character varying(200) |  |  |  |
| base_normativa | character varying(200) |  |  |  |
| activo | boolean | sí | true |  |

**Restricciones**

- Verificación `ck_parametros_patrimonio_tecnico_componente`: `CHECK (((componente)::text = ANY ((ARRAY['PRIMARIO'::character varying, 'SECUNDARIO'::character varying, 'DEDUCCION'::character varying])::text[])))`
- Verificación `ck_parametros_patrimonio_tecnico_deduccion`: `CHECK ((((componente)::text <> 'DEDUCCION'::text) OR ((saldo_como)::text = 'DEUDOR'::text)))`
- Verificación `ck_parametros_patrimonio_tecnico_factor`: `CHECK (((factor >= (0)::numeric) AND (factor <= (1)::numeric)))`
- Verificación `ck_parametros_patrimonio_tecnico_limite`: `CHECK (((limite_pct_apr IS NULL) OR ((limite_pct_apr > (0)::numeric) AND (limite_pct_apr <= (1)::numeric))))`
- Verificación `ck_parametros_patrimonio_tecnico_saldo`: `CHECK (((saldo_como)::text = ANY ((ARRAY['ACREEDOR'::character varying, 'DEUDOR'::character varying])::text[])))`
- Clave foránea `fk_parametros_patrimonio_tecnico_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_parametros_patrimonio_tecnico`: `PRIMARY KEY (cooperativa_id, parametro_id)`
- Única `uq_parametros_patrimonio_tecnico_componente_prefijo`: `UNIQUE (cooperativa_id, componente, prefijo_cuenta)`

## parametros_plataforma

plataforma: no pertenece a una cooperativa; administrada por tecnifin_admin

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| clave | character varying(100) | sí |  |  |
| valor | text | sí |  |  |
| descripcion | character varying(300) |  |  |  |

**Restricciones**

- Clave primaria `pk_parametros_plataforma`: `PRIMARY KEY (clave)`

## parametros_provision_cartera

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| parametro_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| segmento | segmento_credito | sí |  |  |
| calificacion | calificacion_riesgo | sí |  |  |
| dias_mora_desde | integer | sí |  |  |
| dias_mora_hasta | integer |  |  |  |
| porcentaje_provision | numeric(9,4) | sí |  | Fraccion: 0.0100 = 1%. Minimo de la Resolucion 128-2015-F; cada cooperativa puede subirlo. |
| cuenta_provision | codigo_contable | sí |  |  |
| base_normativa | character varying(200) |  |  |  |
| activo | boolean | sí | true |  |

**Restricciones**

- Verificación `ck_parametros_provision_cartera_dias`: `CHECK (((dias_mora_desde >= 0) AND ((dias_mora_hasta IS NULL) OR (dias_mora_hasta >= dias_mora_desde))))`
- Verificación `ck_parametros_provision_cartera_porcentaje`: `CHECK (((porcentaje_provision >= (0)::numeric) AND (porcentaje_provision <= (1)::numeric)))`
- Clave foránea `fk_parametros_provision_cartera_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave foránea `fk_parametros_provision_cartera_cuenta`: `FOREIGN KEY (cooperativa_id, cuenta_provision) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave primaria `pk_parametros_provision_cartera`: `PRIMARY KEY (cooperativa_id, parametro_id)`
- Única `uq_parametros_provision_cartera_segmento_calificacion`: `UNIQUE (cooperativa_id, segmento, calificacion)`

## parametros_regulatorios

Limites regulatorios por cooperativa (solvencia minima, topes, umbrales). Se edita el dato, no el codigo.

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| clave | character varying(60) | sí |  |  |
| valor | numeric(18,6) | sí |  |  |
| unidad | character varying(20) |  |  |  |
| descripcion | character varying(300) |  |  |  |
| base_normativa | character varying(200) |  |  |  |

**Restricciones**

- Verificación `ck_parametros_regulatorios_clave`: `CHECK (((clave)::text ~ '^[A-Z][A-Z0-9_]{2,59}$'::text))`
- Clave foránea `fk_parametros_regulatorios_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_parametros_regulatorios`: `PRIMARY KEY (cooperativa_id, clave)`

## periodos_contables

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| periodo_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| anio | integer | sí |  |  |
| mes | integer | sí |  |  |
| cerrado | boolean | sí | false |  |

**Restricciones**

- Verificación `ck_periodos_contables_anio`: `CHECK (((anio >= 1990) AND (anio <= 2200)))`
- Verificación `ck_periodos_contables_mes`: `CHECK (((mes >= 1) AND (mes <= 12)))`
- Clave foránea `fk_periodos_contables_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_periodos_contables`: `PRIMARY KEY (cooperativa_id, periodo_id)`
- Única `uq_periodos_contables_cooperativa_anio_mes`: `UNIQUE (cooperativa_id, anio, mes)`

## plan_cuentas

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cuenta_contable_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo | codigo_contable | sí |  |  |
| nombre | character varying(150) | sí |  |  |
| tipo_cuenta | character varying(20) | sí |  |  |
| cuenta_padre_id | integer |  |  |  |
| es_agrupador | boolean | sí | false |  |
| moneda | character varying(3) | sí | 'USD'::character varying |  |
| activa | boolean | sí | true |  |

**Restricciones**

- Verificación `ck_plan_cuentas_no_autopadre`: `CHECK ((cuenta_padre_id IS DISTINCT FROM cuenta_contable_id))`
- Verificación `ck_plan_cuentas_tipo`: `CHECK (((tipo_cuenta)::text = ANY ((ARRAY['ACTIVO'::character varying, 'PASIVO'::character varying, 'PATRIMONIO'::character varying, 'INGRESO'::character varying, 'GASTO'::character varying, 'CONTINGENTE'::character varying, 'ORDEN'::character varying])::text[])))`
- Clave foránea `fk_plan_cuentas_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave foránea `fk_plan_cuentas_padre`: `FOREIGN KEY (cooperativa_id, cuenta_padre_id) REFERENCES plan_cuentas(cooperativa_id, cuenta_contable_id)`
- Clave primaria `pk_plan_cuentas`: `PRIMARY KEY (cooperativa_id, cuenta_contable_id)`
- Única `uq_plan_cuentas_cooperativa_codigo`: `UNIQUE (cooperativa_id, codigo)`

## ponderaciones_riesgo

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| ponderacion_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| prefijo_cuenta | codigo_contable | sí |  | Prefijo del codigo contable. Gana el mas largo que calce: 149915 antes que 1499 y que 14. |
| ponderacion | numeric(9,4) | sí |  |  |
| categoria | character varying(60) | sí |  |  |
| descripcion | character varying(200) |  |  |  |
| base_normativa | character varying(200) |  |  |  |
| activo | boolean | sí | true |  |

**Restricciones**

- Verificación `ck_ponderaciones_riesgo_valor`: `CHECK (((ponderacion >= (0)::numeric) AND (ponderacion <= (1)::numeric)))`
- Clave foránea `fk_ponderaciones_riesgo_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_ponderaciones_riesgo`: `PRIMARY KEY (cooperativa_id, ponderacion_id)`
- Única `uq_ponderaciones_riesgo_prefijo`: `UNIQUE (cooperativa_id, prefijo_cuenta)`

## productos_financieros

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| producto_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo_producto | integer | sí |  |  |
| nombre | character varying(100) | sí |  |  |
| tipo_deposito | character varying(100) | sí |  |  |
| es_certificado | boolean | sí | false |  |
| cuenta_activa | codigo_contable | sí |  |  |
| cuenta_inactiva | codigo_contable | sí |  |  |
| cuenta_gasto | codigo_contable |  |  |  |
| cuenta_provision | codigo_contable |  |  |  |
| cuenta_depositos_confirmar | codigo_contable |  |  |  |
| num_ctas_4_dig | integer | sí | 28 |  |
| permite_depositos | boolean | sí | true |  |
| permite_retiros | boolean | sí | true |  |
| permite_debitos | boolean | sí | true |  |
| permite_creditos | boolean | sí | true |  |
| permite_transferencias | boolean | sí | true |  |
| tasa | character varying(50) | sí | 'TASA NOMINAL'::character varying |  |
| forma_pago | character varying(100) | sí | 'MOVIMIENTO HISTORICO PONDERADO BASE'::character varying |  |
| meses_acreditacion | character varying(100) | sí | 'Diciembre'::character varying |  |

**Restricciones**

- Clave foránea `fk_productos_financieros_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave foránea `fk_productos_financieros_cuenta_activa`: `FOREIGN KEY (cooperativa_id, cuenta_activa) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_productos_financieros_cuenta_confirmar`: `FOREIGN KEY (cooperativa_id, cuenta_depositos_confirmar) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_productos_financieros_cuenta_gasto`: `FOREIGN KEY (cooperativa_id, cuenta_gasto) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_productos_financieros_cuenta_inactiva`: `FOREIGN KEY (cooperativa_id, cuenta_inactiva) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_productos_financieros_cuenta_provision`: `FOREIGN KEY (cooperativa_id, cuenta_provision) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave primaria `pk_productos_financieros`: `PRIMARY KEY (cooperativa_id, producto_id)`
- Única `uq_productos_financieros_cooperativa_codigo`: `UNIQUE (cooperativa_id, codigo_producto)`

## reclasificacion_cartera

Corridas del proceso mensual de cartera. SIMULADO es el estado por defecto: aplicar es explicito.

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| proceso_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| fecha_corte | date | sí |  |  |
| estado | character varying(20) | sí | 'SIMULADO'::character varying |  |
| usuario_id | bigint | sí |  |  |
| fecha_ejecucion | timestamp(0) with time zone | sí | now() |  |
| operaciones_evaluadas | integer | sí | 0 |  |
| monto_reclasificado | dinero | sí | 0 |  |
| cartera_bruta | dinero | sí | 0 |  |
| cartera_improductiva | dinero | sí | 0 |  |
| provision_requerida | dinero | sí | 0 |  |
| provision_constituida | dinero | sí | 0 |  |
| provision_contabilizada | dinero | sí | 0 |  |
| asiento_id | bigint |  |  |  |
| reversa_de_proceso_id | bigint |  |  |  |
| observaciones | character varying(500) |  |  |  |

**Restricciones**

- Verificación `ck_reclasificacion_cartera_contabilizacion`: `CHECK ((((asiento_id IS NULL) = ((provision_contabilizada)::numeric = (0)::numeric)) AND (((estado)::text <> 'APLICADO'::text) OR ((asiento_id IS NOT NULL) AND ((provision_contabilizada)::numeric > (0)::numeric)))))`
- Verificación `ck_reclasificacion_cartera_estado`: `CHECK (((estado)::text = ANY ((ARRAY['SIMULADO'::character varying, 'APLICADO'::character varying, 'REVERSADO'::character varying])::text[])))`
- Verificación `ck_reclasificacion_cartera_no_autoreversa`: `CHECK ((reversa_de_proceso_id IS DISTINCT FROM proceso_id))`
- Verificación `ck_reclasificacion_cartera_reversa`: `CHECK (((reversa_de_proceso_id IS NULL) OR ((estado)::text = 'REVERSADO'::text)))`
- Verificación `ck_reclasificacion_cartera_simulado`: `CHECK ((((estado)::text <> 'SIMULADO'::text) OR ((asiento_id IS NULL) AND ((provision_contabilizada)::numeric = (0)::numeric))))`
- Clave foránea `fk_reclasificacion_cartera_asiento`: `FOREIGN KEY (cooperativa_id, asiento_id) REFERENCES asientos_contables(cooperativa_id, asiento_id)`
- Clave foránea `fk_reclasificacion_cartera_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave foránea `fk_reclasificacion_cartera_reversa`: `FOREIGN KEY (cooperativa_id, reversa_de_proceso_id) REFERENCES reclasificacion_cartera(cooperativa_id, proceso_id)`
- Clave foránea `fk_reclasificacion_cartera_usuario`: `FOREIGN KEY (cooperativa_id, usuario_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_reclasificacion_cartera`: `PRIMARY KEY (cooperativa_id, proceso_id)`

## reclasificacion_cartera_detalle

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| detalle_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| proceso_id | bigint | sí |  |  |
| tipo | character varying(20) | sí |  |  |
| segmento | segmento_credito |  |  |  |
| cuenta_origen | codigo_contable |  |  |  |
| cuenta_destino | codigo_contable |  |  |  |
| estado_destino | character varying(30) |  |  |  |
| banda_destino | character varying(40) |  |  |  |
| calificacion | calificacion_riesgo |  |  |  |
| operaciones | integer | sí | 0 |  |
| monto | dinero | sí |  |  |

**Restricciones**

- Verificación `ck_reclasificacion_cartera_detalle_cuentas`: `CHECK (((cuenta_origen IS NOT NULL) OR (cuenta_destino IS NOT NULL)))`
- Verificación `ck_reclasificacion_cartera_detalle_tipo`: `CHECK (((tipo)::text = ANY ((ARRAY['RECLASIFICACION'::character varying, 'PROVISION'::character varying])::text[])))`
- Clave foránea `fk_reclasificacion_cartera_detalle_destino`: `FOREIGN KEY (cooperativa_id, cuenta_destino) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_reclasificacion_cartera_detalle_origen`: `FOREIGN KEY (cooperativa_id, cuenta_origen) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_reclasificacion_cartera_detalle_proceso`: `FOREIGN KEY (cooperativa_id, proceso_id) REFERENCES reclasificacion_cartera(cooperativa_id, proceso_id) ON DELETE CASCADE`
- Clave primaria `pk_reclasificacion_cartera_detalle`: `PRIMARY KEY (cooperativa_id, detalle_id)`

## rubros_creditos

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| rubro_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| amortizacion_id | bigint | sí |  |  |
| nombre_rubro | character varying(50) | sí |  |  |
| monto | dinero | sí |  |  |
| estado | character varying(20) | sí | 'PENDIENTE'::character varying |  |

**Restricciones**

- Verificación `ck_rubros_creditos_estado`: `CHECK (((estado)::text = ANY ((ARRAY['PENDIENTE'::character varying, 'PAGADO'::character varying, 'ANULADO'::character varying])::text[])))`
- Clave foránea `fk_rubros_creditos_amortizacion`: `FOREIGN KEY (cooperativa_id, amortizacion_id) REFERENCES tabla_amortizacion(cooperativa_id, amortizacion_id) ON DELETE CASCADE`
- Clave primaria `pk_rubros_creditos`: `PRIMARY KEY (cooperativa_id, rubro_id)`

## secuencias_tenant

Contadores por cooperativa (socio, cuenta, credito, solicitud, dpf_AAAAMM...). Reemplaza Seq_NumeroSocio y SecuenciaDPF.

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| nombre | character varying(40) | sí |  |  |
| valor | bigint | sí | 0 |  |

**Restricciones**

- Verificación `ck_secuencias_tenant_nombre`: `CHECK (((nombre)::text ~ '^[a-z][a-z0-9_]{0,39}$'::text))`
- Verificación `ck_secuencias_tenant_valor`: `CHECK ((valor >= 1))`
- Clave foránea `fk_secuencias_tenant_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_secuencias_tenant`: `PRIMARY KEY (cooperativa_id, nombre)`

## socio_carga

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| carga_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| nombre | character varying(150) | sí |  |  |
| parentesco | character varying(50) |  |  |  |
| edad | integer |  |  |  |

**Restricciones**

- Verificación `ck_socio_carga_edad`: `CHECK (((edad IS NULL) OR ((edad >= 0) AND (edad <= 120))))`
- Clave foránea `fk_socio_carga_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_carga`: `PRIMARY KEY (cooperativa_id, carga_id)`

## socio_conyuge

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| socio_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| cedula_conyuge | character varying(20) |  |  |  |
| nombre_conyuge | character varying(150) |  |  |  |
| telefono_conyuge | character varying(20) |  |  |  |

**Restricciones**

- Clave foránea `fk_socio_conyuge_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_conyuge`: `PRIMARY KEY (cooperativa_id, socio_id)`

## socio_croquis_trabajo

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| croquis_trabajo_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| imagen_croquis | bytea |  |  |  |
| descripcion | character varying(500) |  |  |  |
| fecha_captura | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Clave foránea `fk_socio_croquis_trabajo_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_croquis_trabajo`: `PRIMARY KEY (cooperativa_id, croquis_trabajo_id)`

## socio_direccion

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| socio_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| pais_nacimiento | character varying(50) |  |  |  |
| provincia_nacimiento | character varying(50) |  |  |  |
| canton_nacimiento | character varying(50) |  |  |  |
| parroquia_nacimiento | character varying(50) |  |  |  |
| pais_residencia | character varying(50) |  |  |  |
| provincia_residencia | character varying(50) |  |  |  |
| canton_residencia | character varying(50) |  |  |  |
| parroquia_residencia | character varying(50) |  |  |  |
| direccion_domicilio | character varying(200) |  |  |  |
| lugar_trabajo | character varying(200) |  |  |  |
| provincia_trabajo | character varying(50) |  |  |  |
| canton_trabajo | character varying(50) |  |  |  |
| parroquia_trabajo | character varying(50) |  |  |  |
| tipo_vivienda | character varying(100) |  |  |  |
| valor_vivienda | dinero |  |  |  |

**Restricciones**

- Clave foránea `fk_socio_direccion_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_direccion`: `PRIMARY KEY (cooperativa_id, socio_id)`

## socio_documento_excepcion

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| documento_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| identificacion | character varying(20) | sí |  |  |
| imagen_frontal | bytea |  |  |  |
| imagen_posterior | bytea |  |  |  |
| tipo_mime | character varying(50) |  |  |  |
| motivo | character varying(300) |  |  |  |
| fecha_registro | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_socio_documento_excepcion_imagen`: `CHECK (((imagen_frontal IS NOT NULL) OR (imagen_posterior IS NOT NULL)))`
- Verificación `ck_socio_documento_excepcion_mime`: `CHECK (((tipo_mime IS NULL) OR ((tipo_mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'image/webp'::character varying, 'application/pdf'::character varying])::text[]))))`
- Clave foránea `fk_socio_documento_excepcion_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_documento_excepcion`: `PRIMARY KEY (cooperativa_id, documento_id)`

## socio_referencia

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| referencia_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| nombre | character varying(150) | sí |  |  |
| telefono | character varying(20) |  |  |  |
| relacion | character varying(50) |  |  |  |

**Restricciones**

- Clave foránea `fk_socio_referencia_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_referencia`: `PRIMARY KEY (cooperativa_id, referencia_id)`

## socio_ubicacion_mapa

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| ubicacion_mapa_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| socio_id | bigint | sí |  |  |
| imagen_mapa | bytea |  |  |  |
| coordenada_lat | character varying(50) |  |  |  |
| coordenada_lng | character varying(50) |  |  |  |
| direccion_capturada | character varying(200) |  |  |  |
| fecha_captura | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Clave foránea `fk_socio_ubicacion_mapa_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id) ON DELETE CASCADE`
- Clave primaria `pk_socio_ubicacion_mapa`: `PRIMARY KEY (cooperativa_id, ubicacion_mapa_id)`

## socios

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| socio_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| numero_socio | bigint | sí | siguiente_numero('socio'::character varying) |  |
| numero_socio_anterior | character varying(20) |  |  | Numero que el socio tenia en el sistema de origen. Dato de migracion (MIG-01); el numero vigente es numero_socio. |
| tipo_persona | character varying(20) | sí |  |  |
| tipo_identificacion | character varying(20) | sí |  |  |
| identificacion | character varying(20) | sí |  |  |
| primer_nombre | character varying(50) | sí |  |  |
| segundo_nombre | character varying(50) |  |  |  |
| primer_apellido | character varying(50) | sí |  |  |
| segundo_apellido | character varying(50) |  |  |  |
| solo_un_nombre | boolean | sí | false |  |
| solo_un_apellido | boolean | sí | false |  |
| email | character varying(100) |  |  |  |
| telefono | character varying(20) |  |  |  |
| telefonos | character varying(200) |  |  |  |
| fecha_nacimiento | date |  |  |  |
| estado_civil | character varying(20) |  |  |  |
| pin | character varying(4) | sí |  |  |
| etnia | character varying(20) |  |  |  |
| genero | character varying(20) |  |  |  |
| autoidentificacion | character varying(100) |  |  |  |
| nivel_instruccion | character varying(50) |  |  |  |
| profesion | character varying(100) |  |  |  |
| discapacidad | boolean | sí | false |  |
| peps | boolean | sí | false |  |
| consentimiento_datos | boolean | sí | false |  |
| patrimonio_ingresos | text |  |  |  |
| fecha_registro | timestamp(0) with time zone | sí | now() |  |
| usuario_registro_id | bigint |  |  |  |
| estado | character varying(20) | sí | 'ACTIVO'::character varying |  |

**Restricciones**

- Verificación `ck_socios_estado`: `CHECK (((estado)::text = ANY ((ARRAY['ACTIVO'::character varying, 'INACTIVO'::character varying, 'BLOQUEADO'::character varying, 'FALLECIDO'::character varying])::text[])))`
- Verificación `ck_socios_numero`: `CHECK ((numero_socio > 0))`
- Verificación `ck_socios_tipo_persona`: `CHECK (((tipo_persona)::text = ANY ((ARRAY['SOCIO'::character varying, 'CLIENTE'::character varying, 'CLIENTE_EXTERNO'::character varying])::text[])))`
- Clave foránea `fk_socios_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave foránea `fk_socios_usuario_registro`: `FOREIGN KEY (cooperativa_id, usuario_registro_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_socios`: `PRIMARY KEY (cooperativa_id, socio_id)`
- Única `uq_socios_cooperativa_identificacion`: `UNIQUE (cooperativa_id, identificacion)`
- Única `uq_socios_cooperativa_numero`: `UNIQUE (cooperativa_id, numero_socio)`

## solicitudes_credito

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| solicitud_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo | character varying(50) | sí |  |  |
| socio_id | bigint | sí |  |  |
| identificacion | character varying(20) | sí |  |  |
| monto | dinero | sí |  |  |
| saldo | dinero | sí |  |  |
| tasa | numeric(9,4) | sí |  |  |
| plazo | integer | sí |  |  |
| tipo | character varying(100) | sí |  |  |
| estado | character varying(30) | sí | 'SOLICITADO'::character varying |  |
| fecha_solicitud | timestamp(0) with time zone | sí | now() |  |
| fecha_vencimiento | date |  |  |  |
| observaciones | character varying(500) |  |  |  |
| plan_pagos | text |  |  |  |
| garantia_info | text |  |  |  |
| origen | character varying(50) |  |  |  |
| tipo_prenda | character varying(100) |  |  |  |
| avaluo_prendario | dinero |  |  |  |
| observacion_tecnica_prenda | character varying(500) |  |  |  |
| valor_cobertura | dinero |  |  |  |
| tipo_aprobacion | character varying(50) |  |  |  |
| acta_sesion | character varying(100) |  |  |  |
| scoring_score | integer |  |  |  |
| descuentos_desembolso | text |  |  |  |
| usuario_decision_id | bigint |  |  |  |
| fecha_decision | timestamp(0) with time zone |  |  |  |

**Restricciones**

- Verificación `ck_solicitudes_credito_decision`: `CHECK ((((estado)::text <> ALL ((ARRAY['APROBADO'::character varying, 'RECHAZADO'::character varying])::text[])) OR ((usuario_decision_id IS NOT NULL) AND (fecha_decision IS NOT NULL))))`
- Verificación `ck_solicitudes_credito_estado`: `CHECK (((estado)::text = ANY ((ARRAY['SOLICITADO'::character varying, 'EN_ANALISIS'::character varying, 'APROBADO'::character varying, 'RECHAZADO'::character varying, 'DESEMBOLSADO'::character varying, 'ANULADO'::character varying])::text[])))`
- Verificación `ck_solicitudes_credito_monto`: `CHECK (((monto)::numeric > (0)::numeric))`
- Verificación `ck_solicitudes_credito_plazo`: `CHECK ((plazo > 0))`
- Verificación `ck_solicitudes_credito_tasa`: `CHECK ((tasa >= (0)::numeric))`
- Clave foránea `fk_solicitudes_credito_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id)`
- Clave foránea `fk_solicitudes_credito_usuario_decision`: `FOREIGN KEY (cooperativa_id, usuario_decision_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_solicitudes_credito`: `PRIMARY KEY (cooperativa_id, solicitud_id)`
- Única `uq_solicitudes_credito_cooperativa_codigo`: `UNIQUE (cooperativa_id, codigo)`

## tabla_amortizacion

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| amortizacion_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| credito_id | bigint | sí |  |  |
| numero_cuota | integer | sí |  |  |
| fecha_pago | date | sí |  |  |
| capital | dinero | sí |  |  |
| interes | dinero | sí |  |  |
| interes_devengado | dinero |  |  |  |
| interes_pagado | dinero |  |  |  |
| seguro_desgravamen | dinero | sí | 0.00 |  |
| contribucion_solca | dinero | sí | 0.00 |  |
| gastos_administrativos | dinero | sí | 0.00 |  |
| total | dinero | sí |  |  |
| estado | character varying(20) | sí | 'PENDIENTE'::character varying |  |

**Restricciones**

- Verificación `ck_tabla_amortizacion_cuota`: `CHECK ((numero_cuota > 0))`
- Verificación `ck_tabla_amortizacion_estado`: `CHECK (((estado)::text = ANY ((ARRAY['PENDIENTE'::character varying, 'PAGADA'::character varying, 'VENCIDA'::character varying, 'CASTIGADA'::character varying])::text[])))`
- Clave foránea `fk_tabla_amortizacion_credito`: `FOREIGN KEY (cooperativa_id, credito_id) REFERENCES creditos(cooperativa_id, credito_id) ON DELETE CASCADE`
- Clave primaria `pk_tabla_amortizacion`: `PRIMARY KEY (cooperativa_id, amortizacion_id)`
- Única `uq_tabla_amortizacion_credito_cuota`: `UNIQUE (cooperativa_id, credito_id, numero_cuota)`

## tasas_credito

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| tasa_credito_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| linea_credito | character varying(100) | sí |  |  |
| clase_credito | segmento_credito | sí |  |  |
| monto_minimo | dinero | sí |  |  |
| monto_maximo | dinero | sí |  |  |
| plazo_minimo | integer | sí |  |  |
| plazo_maximo | integer | sí |  |  |
| tasa_inicial | numeric(9,4) | sí |  |  |
| tasa_final | numeric(9,4) | sí |  |  |
| tasa_aplicable | numeric(9,4) | sí |  | Porcentaje anual efectivamente pactado (14.0000 = 14%). Debe caer entre tasa_inicial y tasa_final. |
| activo | boolean | sí | true |  |
| fecha_vigencia | date | sí | CURRENT_DATE |  |

**Restricciones**

- Verificación `ck_tasas_credito_montos`: `CHECK ((((monto_minimo)::numeric > (0)::numeric) AND ((monto_maximo)::numeric >= (monto_minimo)::numeric)))`
- Verificación `ck_tasas_credito_plazos`: `CHECK (((plazo_minimo >= 1) AND (plazo_maximo >= plazo_minimo)))`
- Verificación `ck_tasas_credito_tasas`: `CHECK (((tasa_inicial >= (0)::numeric) AND (tasa_final >= tasa_inicial) AND (tasa_final <= (100)::numeric) AND ((tasa_aplicable >= tasa_inicial) AND (tasa_aplicable <= tasa_final))))`
- Clave foránea `fk_tasas_credito_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_tasas_credito`: `PRIMARY KEY (cooperativa_id, tasa_credito_id)`
- Única `uq_tasas_credito_linea`: `UNIQUE (cooperativa_id, linea_credito)`

## tasas_plazo_fijo

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| tasa_id | integer | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| codigo_rango | character varying(10) | sí |  |  |
| descripcion_rango | character varying(60) | sí |  |  |
| dias_desde | integer | sí |  |  |
| dias_hasta | integer | sí |  |  |
| tasa_nominal_anual | numeric(9,4) | sí |  |  |
| tasa_maxima_bce | numeric(9,4) | sí |  |  |
| monto_minimo | dinero | sí | 200.00 |  |
| monto_maximo | dinero |  |  |  |
| cuenta_contable_dpf | codigo_contable | sí |  |  |
| porcentaje_penalizacion | numeric(9,4) | sí | 50.0000 |  |
| activo | boolean | sí | true |  |
| fecha_vigencia | date | sí | CURRENT_DATE |  |
| usuario_config_id | bigint |  |  |  |

**Restricciones**

- Verificación `ck_tasas_plazo_fijo_dias`: `CHECK (((dias_desde >= 1) AND (dias_hasta >= dias_desde)))`
- Clave foránea `fk_tasas_plazo_fijo_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave foránea `fk_tasas_plazo_fijo_cuenta`: `FOREIGN KEY (cooperativa_id, cuenta_contable_dpf) REFERENCES plan_cuentas(cooperativa_id, codigo)`
- Clave foránea `fk_tasas_plazo_fijo_usuario_config`: `FOREIGN KEY (cooperativa_id, usuario_config_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_tasas_plazo_fijo`: `PRIMARY KEY (cooperativa_id, tasa_id)`
- Única `uq_tasas_plazo_fijo_cooperativa_rango`: `UNIQUE (cooperativa_id, codigo_rango)`

## transacciones_caja

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| transaccion_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| control_caja_id | bigint | sí |  |  |
| socio_id | bigint | sí |  |  |
| cuenta_id | bigint |  |  |  |
| credito_id | bigint |  |  |  |
| deposito_plazo_id | bigint |  |  |  |
| tipo_operacion | character varying(50) | sí |  |  |
| monto | dinero | sí |  |  |
| anulado | boolean | sí | false |  |
| fecha_hora | timestamp(0) with time zone | sí | now() |  |
| usuario_id | bigint | sí |  |  |
| asiento_contable_id | bigint |  |  |  |

**Restricciones**

- Verificación `ck_transacciones_caja_monto`: `CHECK (((monto)::numeric > (0)::numeric))`
- Clave foránea `fk_transacciones_caja_asiento`: `FOREIGN KEY (cooperativa_id, asiento_contable_id) REFERENCES asientos_contables(cooperativa_id, asiento_id)`
- Clave foránea `fk_transacciones_caja_control`: `FOREIGN KEY (cooperativa_id, control_caja_id) REFERENCES control_caja(cooperativa_id, control_id)`
- Clave foránea `fk_transacciones_caja_credito`: `FOREIGN KEY (cooperativa_id, credito_id) REFERENCES creditos(cooperativa_id, credito_id)`
- Clave foránea `fk_transacciones_caja_cuenta`: `FOREIGN KEY (cooperativa_id, cuenta_id) REFERENCES cuentas(cooperativa_id, cuenta_id)`
- Clave foránea `fk_transacciones_caja_deposito`: `FOREIGN KEY (cooperativa_id, deposito_plazo_id) REFERENCES depositos_plazo(cooperativa_id, deposito_id)`
- Clave foránea `fk_transacciones_caja_socio`: `FOREIGN KEY (cooperativa_id, socio_id) REFERENCES socios(cooperativa_id, socio_id)`
- Clave foránea `fk_transacciones_caja_usuario`: `FOREIGN KEY (cooperativa_id, usuario_id) REFERENCES usuarios(cooperativa_id, usuario_id)`
- Clave primaria `pk_transacciones_caja`: `PRIMARY KEY (cooperativa_id, transaccion_id)`

## usuarios

| Columna | Tipo | Obligatoria | Por defecto | Nota |
|---|---|---|---|---|
| usuario_id | bigint | sí |  |  |
| cooperativa_id | integer | sí | cooperativa_actual() |  |
| login | character varying(20) | sí |  | Equivale a Usuarios.UsuarioId del sistema viejo, que era PK global. Aqui es unico solo dentro de la cooperativa. |
| nombre_completo | character varying(150) | sí |  |  |
| pin | character varying(4) |  |  |  |
| password_hash | character varying(200) | sí |  |  |
| rol | character varying(30) | sí |  |  |
| activo | boolean | sí | true |  |
| impresora_predeterminada | character varying(100) |  |  |  |
| fecha_registro | date |  |  |  |
| requiere_cambio_pin | boolean | sí | false |  |
| fecha_creacion | timestamp(0) with time zone | sí | now() |  |
| fecha_actualizacion | timestamp(0) with time zone | sí | now() |  |

**Restricciones**

- Verificación `ck_usuarios_login`: `CHECK ((((login)::text = lower((login)::text)) AND ((login)::text ~ '^[a-z0-9._-]{3,20}$'::text)))`
- Verificación `ck_usuarios_rol`: `CHECK (((rol)::text = ANY ((ARRAY['SUPER_USER'::character varying, 'ADMIN'::character varying, 'MANAGER'::character varying, 'CREDIT_OFFICER'::character varying, 'TELLER'::character varying, 'MEMBER'::character varying])::text[])))`
- Clave foránea `fk_usuarios_cooperativa`: `FOREIGN KEY (cooperativa_id) REFERENCES cooperativas(cooperativa_id)`
- Clave primaria `pk_usuarios`: `PRIMARY KEY (cooperativa_id, usuario_id)`
- Única `uq_usuarios_cooperativa_login`: `UNIQUE (cooperativa_id, login)`
