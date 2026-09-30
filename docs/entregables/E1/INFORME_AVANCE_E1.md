# Entregable 1 · Informe de avance para revisión

- **Proyecto:** TECNIFIN (plataforma multi-cooperativa en PostgreSQL) · sociedad en constitución, nombre reservado **GUTT**
- **Presentado a:** Christian Cuenca, Jefe de Proyecto · copia a Víctor Cuenca (Gerente) y Franklin Lechón
- **Presenta:** Jorge Tuquinga (Desarrollo)
- **Fecha de revisión:** 15-oct-2026 · **Confirmación del Jefe de Proyecto (hito H1):** 31-oct-2026
- **Base contractual:** contrato consolidado del 23-sep-2026, versión 2 (29-sep): cláusulas 7.6, 8.1–8.3, 8.4.1 (mes 1) y Anexo A.1
- **Carácter:** entregable de **revisión**, no de aceptación. Nada de lo aquí presentado se da por aceptado sin acta (cláusula 8.2: no hay aceptación por silencio).

---

## 1. Qué se entrega

| ID (cl. 7.6) | Entregable | Estado | Evidencia |
|---|---|---|---|
| ARQ-01 | Documento de arquitectura multi-tenant | Borrador 0.1 para revisión | `docs/arquitectura/ARQ-01-arquitectura-multi-tenant.md` |
| ARQ-02 | ADR críticas: tenant, aislamiento y modelo de datos | 3 ADR en estado «propuesta» | `docs/adr/0001`, `0002`, `0003` |
| DAT-01 | Modelo de datos multi-tenant y scripts versionados | Construido, pendiente de acta | 15 migraciones en `db/migrations/`; diccionario `DAT-01-diccionario.md` |
| APP-01 | Núcleo multi-tenant: tenant, IAM, auditoría y configuración | Construido (adelantado: vencía el 30-nov) | `src/`, patrón `docs/patrones/03-*.md` |
| — | Sitio web de la compañía, sin dominio | Ver sección 6 | — |

## 2. Cifras verificables (se reproducen con un comando)

| Indicador | Valor | Cómo comprobarlo |
|---|---|---|
| Migraciones versionadas, aplicadas en orden y con huella SHA-256 | 15 | `npm run migrate` |
| Tablas del modelo | 41 | `node tools/diccionario.mjs` |
| Tablas con datos de una cooperativa | 40, **todas** con seguridad por filas habilitada y forzada | idem |
| Políticas de seguridad por filas | 44 | idem |
| Pruebas automatizadas | **71 de 71 en verde** | `npm run verificar` |
| Plan de cuentas (Catálogo Único SEPS) sembrado por cooperativa | 994 cuentas por cooperativa, independientes | `tests/semillas.integration.test.mjs` |

## 3. Qué garantiza el modelo (y cómo se prueba)

1. **Aislamiento entre cooperativas por el motor de base de datos**, no por disciplina del programador: una
   cooperativa no puede leer, modificar ni referenciar datos de otra. Prueba automatizada con dos cooperativas
   (`tests/aislamiento.integration.test.mjs`, 15 casos).
2. **La aplicación no puede saltarse la seguridad**: el rol con el que se conecta no es dueño de las tablas.
3. **Base de producción en blanco**: una base recién migrada tiene cero filas de negocio; los datos de ejemplo
   viven solo en la base de demostración (`tecnifin_demo`).
4. **Numeración por cooperativa desde 1** (socios, cuentas, créditos).
5. **Dinero con dos decimales y partida doble exigida por la base**: un asiento descuadrado no se guarda.
6. **Plan de cuentas propio de cada cooperativa**: editar el de una no toca el de otra.
7. **Cartera SEPS**: bandas de antigüedad leídas del plan de cuentas; morosidad sumada por la familia 1401–1428
   (no por la cuenta 14, que es neta de provisiones).
8. **Acceso (APP-01)**: login por cooperativa con JWT firmado; el tenant sale del token verificado y nunca de la
   petición; roles por lista blanca; clave temporal obligatoria de cambiar; auditoría de cada acción y de cada
   intento denegado; alerta si el contexto del tenant cambia a mitad de una operación.

Cumple los criterios técnicos de aceptación del **Anexo E** del contrato (tabla con RLS forzada, prueba de dos
cooperativas, rol sin privilegios de dueño, montos con dos decimales y partida doble, plan de cuentas por
cooperativa, base de producción sin datos).

## 4. Cronología (commits del repositorio `TECNIFIN`)

| Fecha | Commit | Avance |
|---|---|---|
| 20-sep | `25da897` | Fase 0: proyecto con reglas anti-error comprobadas por pruebas |
| 20-sep | `953ee54` | Borradores ADR-0001/0002/0003 y ARQ-01 |
| 20-sep | `1f69386` | DAT-01: modelo multi-tenant |
| 20-sep | `bde7942` | Base en blanco y decisiones de datos |
| 20-sep | `97adaef` | DAT-02: cartera SEPS, solvencia, banca en línea, semillas por cooperativa, base demo |
| 21-sep | `adaab61` | Correcciones de la revisión cruzada (3 ALTO / 4 MEDIO detectados; ALTO 2-3 y MEDIO 4-7 cerrados) |
| 22-sep | `d793318` | ALTO 1: controles de fijación del tenant (riesgo residual documentado) |
| 22-sep | `5955514` | APP-01: autenticación, usuarios, auditoría y configuración por cooperativa |
| 29-sep | `e9a0442` | APP-01: resto de endpoints de plataforma |

## 5. Lo que requiere decisión expresa del Jefe de Proyecto (cláusula 6.3)

Estas decisiones **no se aprueban por silencio** y condicionan la confirmación del 31-oct:

| # | Tema | Documento | Por qué importa |
|---|---|---|---|
| 1 | **ADR-0002, aislamiento** — riesgo residual «ALTO 1»: SQL arbitrario del rol de aplicación podría cambiar de cooperativa dentro de una sola sentencia sin ser detectado. Decisión provisional de Jorge: conservar el mecanismo con controles compensatorios en desarrollo. | ADR-0002, adenda 22-sep | Aceptar el riesgo por acta, o exigir credenciales aisladas por cooperativa antes de producción |
| 2 | RPO/RTO y restauración de una cooperativa sin afectar a las otras | ADR-0002 · Anexo E | Bloquea la aprobación de ADR-0002 |
| 3 | **PA6**: PIN de socios y usuarios guardado sin cifrar | `PENDIENTES_USUARIO.md` | Debe resolverse antes del módulo de socios (M1) |
| 4 | Vida de la sesión (JWT), renovación e invalidación | Patrón 03 §4 | Hoy, restablecer una clave no anula sesiones abiertas hasta que vencen |
| 5 | Cifrado en reposo y de respaldos, custodia de claves | ARQ-01 | Anexo F, SEC-05 |
| 6 | Volumen y retención por cooperativa; ¿algún cliente exigirá base dedicada? | ARQ-01 | Define particionado o despliegue |

## 6. Sitio web

El sitio de la compañía se presenta **sin dominio**: el dominio y el hosting se contratan una vez inscrita la
sociedad (cláusula 12.5, acuerdo del 29-sep). Por la cláusula 10.6, el sitio forma parte del trabajo adicional de
igualación de Franklin Lechón (USD 4.100), por lo que su construcción y evidencia se coordinan con él. El bosquejo
de estructura y contenido (4 páginas: Inicio, Producto, Nosotros, Contacto) está en la pestaña «Página Web» del
tablero de avances.

## 7. Cómo revisar (para el Jefe de Proyecto)

1. Leer ARQ-01 y los tres ADR; anotar observaciones en la tabla de la sección 8.
2. Revisar el diccionario `DAT-01-diccionario.md` (índice al inicio: toda tabla con datos de cooperativa debe
   decir «RLS forzada: sí»).
3. Opcional, en el equipo de desarrollo: `npm run verificar` (migraciones al día y 71 pruebas en verde).
4. Registrar las observaciones antes del **22-oct** para subsanarlas dentro del plazo de la cláusula 8.3 y
   confirmar el **31-oct**.

## 8. Observaciones del comité (a completar en la revisión)

| # | Documento / tema | Observación | Tipo (menor / material) | Responsable | Plazo | Estado |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

**Firma de recepción para revisión:** ______________________ Christian Cuenca, Jefe de Proyecto · Fecha: ________
