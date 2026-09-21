---
name: Úkol pro smyčku (ready-for-agent)
about: Issue, kterou má zpracovat agentní smyčka nebo člověk podle stejných pravidel
title: "type(scope): "
labels: ready-for-agent
---

## Co

Jedna až tři věty. Číslované body níže jsou seznam hotového: co v nich není, agent nedělá; co v nich je a neudělá se, issue zůstává otevřená a komentář pojmenuje, který bod chybí.

1.
2.

## Příčina (u oprav)

Kde v kódu problém vzniká (soubor, funkce). Oprava se toho místa dotkne, nebo PR vysvětlí, proč ne.

## Workspace: osobní / týmový – co musí fungovat kde

Týmový workspace je primární provozní režim; osobní workspace je totéž v krabici pro jednoho člověka (`docs/architecture/data-modes.md`). Vyplň všechny řádky. „Známá mezera v týmovém workspace" není výsledek; chybějící půlka je nová issue pojmenovaná v titulu PR.

| | Osobní workspace | Týmový workspace (central server + sync agent) |
|---|---|---|
| Co se má stát | | |
| Kde to běží (osobní: sidecar s grafovou DB / týmový: sync agent bez grafové DB, central server) | | |
| Které z těchto míst se mění: `apps/server/api/agent-router.ts`, `is_local_only_path` (`apps/desktop/src/lib.rs`) + `apps/server/shared/device-local-routes.json`, `CentralClient` (`apps/server/domain/sync/central/client.ts`), `apps/server/mcp/agent-tools.ts` | | |
| Test proti fake central serveru (`test/agent-router*.test.ts`, `test/agent-tools.test.ts`) | | |

Pokud je funkce záměrně jen na central serveru (Drive, remote watcher, tým, hosty, rutiny), napiš to sem výslovně místo tabulky.

## Migrace a schéma (pokud se mění)

- [ ] Přečteno `docs/lessons-learned.md` §7.
- [ ] Nová položka v `MIGRATIONS` (libsql) **a** rozšířený `PG_BASELINE_DDL` (`apps/server/infra/schema.pg.ts`); žádný `pg-002`, dokud neproběhl cutover (`docs/architecture/database-and-dialects.md`).
- [ ] Rebuild tabulky je jeden `executeMultiple`; index na sloupec, který přidává migrace, nikdy do DDL replaye.

## Hotovo, když

Ověřitelné tvrzení. Pokud issue žádá měření nebo pokrytí, čísla jsou v PR.

## Ověření

- `npm run qa`, `npm run test:pglite`, `npm --prefix apps/web run build`, `npm --prefix sites/docs run build`; souhrnné řádky patří do těla PR.
- Co jde ověřit jen na macOS (Keychain, podepsaný build, vizuální layout, reálný Drive): napiš sem, agent to popíše v komentáři a nechá issue otevřenou.
- Dokumentace (`sites/docs/`, `docs/architecture/`, `CLAUDE.md`) ve stejné větvi.
