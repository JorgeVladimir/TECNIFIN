# TECNIFIN S.A.S.

Plataforma core bancario **multi-tenant** para cooperativas de ahorro y crédito reguladas por la SEPS (Ecuador),
sobre PostgreSQL. Denominación principal: **TECNIFIN S.A.S.** · alterna: **GUTT COMPANY S.A.S.**

Proyecto nuevo, separado del sistema vigente (GUTT_SYSTEM). El plan, los agentes y las skills que lo orquestan
viven en `C:\GUTT_SYSTEM`; aquí solo está el producto.

```
npm install
copy .env.example .env        # completar TECNIFIN_PG_*
npm run db:init               # crea rol y base locales
npm run migrate               # estado de migraciones (sale con 1 si hay pendientes)
npm run migrate:apply         # aplica lo pendiente
npm test
```

Reglas del proyecto: ver `CLAUDE.md`. Decisiones de arquitectura: `docs/adr/`.
