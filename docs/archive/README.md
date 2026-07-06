# Archiv – hotové specifikace a plány

Tyhle dokumenty popisují features, které **už jsou postavené a v `main`**.
Byly to design specs (psané *před* stavbou) a implementační plány (checklisty
*během* stavby). Jakmile feature dojela, přestaly být referencí a začaly
špinit kontext – proto jsou tady, mimo cestu, ale dohledatelné.

**Zdroj pravdy je kód** (a `docs-site/` pro MCP tool reference), ne tyhle
soubory. Ber je jako historii „proč to takhle vzniklo", ne jako popis
aktuálního chování. Detaily klidně driftly od reality.

## Co je v `specs/` a `plans/`

`specs/` = design dokumenty, `plans/` = implementační checklisty. Dvojice se
stejným datem/tématem patří k sobě (spec + jeho plán). Vše ověřeno vůči kódu
2026-07-06 jako **shipped**.

Hlavní témata: multi-session workspace, markdown/HTML editor, Google OAuth +
groups auth, deterministický file-state (mirror watcher), node sharing / ACL +
unified sharing tab, sync settings (Drive OAuth), release-please, teammate
mirrors + agent-mode MCP front door, desktop multi-workspace, scope
single-source-of-truth, cluster A–D UX batch.

## Top-level historické dokumenty (kořen archivu)

| soubor | co to bylo |
|---|---|
| `implementation-plan.md` | Phase 1–3 build tracker (stav k 2026-04-09) |
| `artifacts-hosting.md` | spec pro artifact hosting – nikdy nepostaveno, gated |
| `audit-2026-06-09.md` | jednorázový audit projektu, findings vyřešeny |
| `auth-refactor-plan.md` | desktop auth refactor – dokončen, pravidla v CLAUDE.md |
| `node-launch-flow-plan.md` | desktop node-launch UX – dokončeno |
| `sandbox-spike-2026-06-10.md` | Seatbelt sandbox spike – proběhl, kód shipnut |
| `central-file-content-phase-b.md` | central-mode file content spec – shipnuto (`file-content-remote.ts`) |
| `multi-instance.md` | multi-vault supervisor návrh – superseded desktop multi-workspace |

## Co zůstalo živé (mimo archiv)

`docs/superpowers/plans/2026-07-03-share-portuni-runbook.md` je živý ops
runbook. Nosné reference zůstávají v `docs/` a `docs/architecture/`
(`data-modes`, `scope-disk-projection`, `env-vars`, `release-process`,
`file-sync`, `conceptual-map`, `graph-node`, `portuni-as-workspace`, plus
`specs.md` a `lessons-learned.md` s bannery).
