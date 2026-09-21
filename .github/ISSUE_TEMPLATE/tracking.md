---
name: Tracking issue dávky (RALPH)
about: Pořadí a pravidla pro jednu dávku agentní smyčky
title: "Tracking: <název dávky> (RALPH)"
labels: ralph-tracking
---

Pořadí pro smyčku. Postupuj podle číslovaného pořadí níže; issue ber, až když je její předchůdce zavřený a případná podmínka u ní splněná. Smyčka nevidí závislosti na PR, jen tenhle seznam – proto jsou podmínky na merge napsané tady.

## 1. <skupina>

1. **#NNN** — `type(scope)`: jedna věta. Podmínky (po čem, co musí být zamergované).

## Pravidla

- **Central mód je primární režim.** Každá změna serveru, routy, MCP nástroje nebo session runtime funguje v local workspace i v central módu (`docs/architecture/data-modes.md`). Každá změna chování řekne v PR, čeho z `apps/server/api/agent-router.ts`, `is_local_only_path` (`apps/desktop/src/lib.rs`) + `apps/server/shared/local-only-routes.json`, `CentralClient` (`apps/server/domain/sync/central/client.ts`) a `apps/server/mcp/agent-tools.ts` se dotkla – nebo proč se jí nic z toho netýká. Chybějící půlka je otevřená issue pojmenovaná v titulu PR, nikdy „známá mezera" v dokumentaci.
- **Nová funkce se píše jednou** jako doménový kód běžící na central serveru i v sidecaru; kde zařízení nemá grafovou DB, vede seam přes `CentralClient`, ne druhá implementace. Další dvojice typu `engine`/`engine-central` nesmí vzniknout.
- **Před každou migrací si přečti `docs/lessons-learned.md` §7.** Migrace v obou dialektech: položka v `MIGRATIONS` (libsql) **a** rozšířený `PG_BASELINE_DDL`; žádný `pg-002`, dokud neproběhl cutover. Rebuild tabulky je jeden `executeMultiple`; index na sloupec, který přidává migrace, nikdy do DDL replaye.
- **Číslované body issue jsou seznam hotového.** Když něco z nich neuděláš, issue zůstává otevřená a v komentáři pojmenuješ, který bod chybí. Uzavření issue = pojmenovaná příčina opravená; když issue jmenuje místo v kódu, oprava se ho dotkne, nebo PR vysvětlí, proč ne.
- **Gate** je `scripts/agent-gate.sh` a musí být zelený včetně `npm run test:pglite`. **Tělo PR obsahuje souhrnné řádky** z `npm test`, `npm run test:pglite`, `npm --prefix apps/web run build` a `npm --prefix sites/docs run build`, plus důkazy, které si daná issue vyžádá (názvy nových testů, výstupy grepů, čísla měření). „Zelená na obou driverech" znamená výpis obou běhů.
- **Žádné čekání přes `setTimeout` v testech** – fake timery nebo injektované časovače.
- Dokumentaci k chování měň ve stejné větvi jako kód (`sites/docs/`, `docs/architecture/`, `CLAUDE.md`).
- Batch PR: jedna větev, jeden PR, titul podle Conventional Commits se scope podle obsahu dávky. Nemerguj. Serverové změny se po mergi nasazují samy (`deploy-server.yml`).

## Už hotové, nepředělávej

- #NNN — …
