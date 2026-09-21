# TECNIFIN — instrucciones para agentes (Claude Code, Codex y quien venga)

**TECNIFIN S.A.S.** (alterna GUTT COMPANY S.A.S.) es una empresa de desarrollo de software. Este repo es su **primer producto**: una plataforma
core bancario multi-tenant para cooperativas de ahorro y crédito reguladas por la SEPS (Ecuador), sobre PostgreSQL. Otros productos vendrán:
lo que se escriba aquí como estándar (reglas, roles, traspaso) debe servir para cualquier proyecto de la empresa.

## Cómo empezar (siempre, en este orden)

1. Lee `CLAUDE.md`: reglas 1-14, comandos y trampas de Windows. **Se siguen tal cual.** Varias las comprueba `npm test`.
2. Lee `docs/handoff/ESTADO.md` (modo, fase, último commit verde) y `docs/handoff/COLA.md` (siguiente trabajo).
3. Lee el encargo que te dieron (`docs/handoff/encargos/<tarea>.md`). Si no hay encargo, toma la primera unidad de `COLA.md`.
4. Lee tu rol en `docs/roles/` (`arquitecto`, `ejecutor`, `revisor` o `mecanico`) y, si existe, el patrón del módulo en `docs/patrones/`.
5. `npm run estado` para ver el estado real en 20 líneas. No releas archivos grandes: `Grep` primero, `Read` con rango.

## Comandos

```
npm run estado      # 20 lineas: modo, commits, migraciones pendientes, arbol sucio
npm run verificar   # migraciones + pruebas, resumen corto. Debe quedar en verde antes de cerrar una unidad
npm test            # todas las pruebas (unitarias, higiene, aislamiento, demo)
npm run migrate     # estado del esquema (sale con 1 si hay pendientes)
npm run migrate:apply
npm run demo:crear  # recrea la base de demostracion tecnifin_demo
```

## Unidades de trabajo (para que un corte de sesión o de límite no deje nada a medias)

- Una unidad = algo que termina en **verde** (`npm run verificar`): una migración, un endpoint con su prueba, un documento.
- Al cerrar cada unidad: pruebas en verde, commit local con mensaje claro y una línea en `docs/handoff/ESTADO.md`.
- Trabajo largo: rama `wip/<tarea>`. Nunca dejes 10 archivos sin commit y sin verificar.
- **Informe final de máximo 25 líneas:** qué cerraste, qué falta, resultado de `npm run verificar`, decisiones que tomaste, dudas para Jorge/Christian.

## Lo que nunca se hace

- Tocar `C:\GUTT_SYSTEM` (sistema anterior, solo lectura) ni sus bases de datos.
- Hacer `git push`, publicar, enviar correos, contratar o gastar: eso lo confirma Jorge. Commits locales sí.
- Imprimir o versionar secretos (`.env` es local). Usar datos o nombres de una cooperativa real: la base nace en blanco; solo existe la demo.
- Decidir lo que está en `docs/handoff/PENDIENTES_USUARIO.md` o en un ADR en estado «propuesta» (los aprueban Jorge/Christian por acta).
- Aprobar tu propio trabajo en aislamiento, dinero, cartera o contabilidad: lo revisa otra herramienta o persona.

## Modelos (Codex)

Se elige con el perfil, no en el prompt: `-p arquitecto` (Astra), `ejecutor-dinero` (Sol), `ejecutor` (Terra), `mecanico` (Luna), `revision`.
Se empieza por el más barato que dé abasto y se escala solo si falla dos veces o la tarea es crítica. Matriz completa:
`C:\GUTT_SYSTEM\DOCS_SISTEMA_FINANCIERO\estrategia_claude_codex.md` §4.1.
