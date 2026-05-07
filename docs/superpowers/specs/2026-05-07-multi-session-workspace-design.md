# Multi-session workspace – design

> Status: design spec, ready for implementation plan. Authored 2026-05-07.
> Captures the brainstorm from session `23f5ace2-…` so a fresh executor can
> proceed without re-deriving the conversation.

## Branch

`feat/multi-session-terminal` (push, čeká na první commit + PR #16).

## Cíl

Workspace view s multi-session terminály jako primární pracovní prostředí.
Network graph zůstává pro orientaci, ne pro denní práci. Uživatel má
jeden nebo víc Claude/shell sessions naživu paralelně, přepíná mezi nimi
bez ztráty kontextu, vidí kdo právě píše.

## Top-level navigace (přestavba)

Současný sidebar má položky `Graph` a `Aktéři` jako rovnocenné. Po
přestavbě:

- **Graph** – síťový pohled (jen orientace, vysvětlování).
- **Práce** (`workspace`) – nový hlavní pracovní view.
- **Nastavení** – s pod-sekcemi:
  - **Obecné** (současná Settings page).
  - **Aktéři** (přesunout sem ze top-level).

## Layout view "Práce"

```
┌──────────────┬───────────────────────────┬──────────────┐
│ Workspace    │ Terminal area             │ Detail pane  │
│ nodes list   │                           │ (selected    │
│              │ ┌Tab1●┐ ┌Tab2○┐ ┌Tab3○┐ +│  node)       │
│ ● Node A (3) │ └─────┘ └─────┘ └─────┘   │              │
│ ○ Node B (1) │ ┌────────────────────────┐│              │
│ ○ Node C (2) │ │                        ││              │
│              │ │  active terminal       ││              │
│ + Přidat node│ │                        ││              │
└──────────────┴───────────────────────────┴──────────────┘
```

- **Levý sloupec** – vertikální list nodů, na kterých se právě pracuje.
  Jeden řádek = jeden node + počet sessions + activity indicator.
- **Střed** – záložky sessions pro vybraný node + aktivní terminal.
  Víc terminálů per node povoleno.
- **Pravý** – detail vybraného nodu (volitelně skrytelný).

## Activity indicator (zelená/oranžová)

- **Zelená** – agent pracuje (output v posledních ~1.5 s).
- **Oranžová** – idle, čeká na uživatele.
- Per-session indikátor v záložce.
- Agregovaný per-node v levém sloupci (zelený, pokud kterákoliv session
  zelená).
- Detekce: tracker `lastOutputAt` per session, refreshovaný debounce na
  `pty-data` event.

## Data model

```ts
type TerminalSession = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: NodeType;
  cwd: string;
  command: string;
  createdAt: number;
  lastOutputAt: number;
};

// V App.tsx
sessions: TerminalSession[];
selectedWorkspaceNodeId: string | null;
activeSessionIdByNode: Record<string, string>;
```

Stav žije v `App.tsx` (single source of truth, předává se dolů přes
props nebo Context). PTY backend stav (sessions Map v `pty.rs`) zůstává
beze změny – frontend je jen tenká vrstva nad Rust state.

## Empty state

Workspace bez sessions ukáže node picker (vyhledávač + nedávné nody).
Klik na node → vytvoří session, přepne se na něj.

## Vstupy do workspace

- **Z workspace** (empty state) – vybrat node → spustit terminál.
- **Z DetailPane** "Otevřít terminál" → vytvoří session + switch na
  workspace.
- **Z GraphView** (klik nebo context menu na nodu) → totéž.

## Performance

- Všechny `TerminalPane` mounted permanently (`display: none` když ne
  aktivní).
- PTY backend i xterm scrollback běží stále → agent na pozadí pracuje
  bez ztrát.
- Hidden `TerminalPane` skip `pty_resize` (hidden = `offsetParent === null`).
- ~5 MB RAM per session, 10+ sessions je v pohodě.

## Closing safety

- Žádný omylný close – pouze X v záložce sessionu + `confirm()` dialog.
- Žádný close button na úrovni node celkově (musíš zavřít každou
  session zvlášť).
- Cmd+Q app stále zabíjí všechny PTY (existující exit hooks v
  `src-tauri/src/lib.rs`).

## Implementační kroky

1. Sidebar reorg (odstranit "Aktéři" z top-level, přidat "Práce").
2. Settings sub-router (Obecné / Aktéři).
3. Globální `sessions` state v `App.tsx`.
4. `WorkspaceView` 3-sloupcový layout.
5. `WorkspaceNodeList` (levý sloupec).
6. `TerminalTabs` (záložky + new-session button).
7. Activity indicator (`lastOutputAt` tracking).
8. Empty state s node pickerem.
9. `TerminalPane` refactor (`sessionId` from parent, no unmount on switch).
10. DetailPane "Otevřít terminál" routes to workspace.
11. GraphView klik/context "Spustit terminál".
12. StatusFooter session counter → workspace.
13. Close confirm dialog.
14. Performance – skip resize when hidden.

## Otevřená rozhodnutí

- Levý sloupec: ukáže jen nody s aktivními sessions, nebo i "pinned"
  nody bez session?
- Detail panel volitelně collapsible (mám dost screen estate?)
- Persistence sessions napříč restartem appky → odložit na později.

## Souvislosti

- Phase 3.4 v `docs/node-launch-flow-plan.md` se v původní formě nahrazuje
  tímto designem (rozšíření z "tabs across the bottom" na full workspace
  view jako primární UX).
- Rendering vrstva (xterm.js + DOM renderer + Unicode11) zůstává beze
  změny – PR #14 to vyřešil.
- Backend (PTY map v `src-tauri/src/pty.rs`) už podporuje paralelní
  sessions; webview to zatím využívá jen sériově.
