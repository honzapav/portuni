# Connectivity: failures are visible, named and expected

When central or Drive is unreachable, the app says so, says since when,
disables what cannot work with the reason on the control, and keeps
everything local working. Nothing is queued silently and nothing fails
silently.

Vision: `docs/vision/portuni-as-workspace.md` (Otevřené otázky 1).
Today: the sidecar logs `central unreachable` and skips sweeps
(`desktop.ts`), `use-sync-pending.ts` backs off on failures, the sync
overview returns empty on error (`engine-central.ts`), `StatusFooter`
knows only whether the local MCP server answers. There is no shared
notion of "we are offline" and each surface fails in its own way.

## Rules

1. **One connectivity state per workspace window**, computed in the
   sidecar and pushed to the window; every component reads it, none
   probes on its own.
2. **Local keeps working.** Editor, file tree, mirror watcher, local
   file state, reading the last known graph, local tasks on this
   machine's sidecar (local mode, or central mode with a cached graph
   read) do not depend on central being reachable.
3. **A disabled control says why.** Anything that needs central or
   Drive is disabled with a tooltip naming the dependency
   ("Vyžaduje spojení s centralem") while the state is `offline`; it is
   never left enabled to fail on click.
4. **No silent queue.** A write that cannot reach central is refused
   with the state's message, not stored for later. Exceptions are the
   ones that already exist by design: the mirror watcher's local
   registration (it is local state) and a host's buffered run events
   (`2026-09-12-remote-hosts-and-task-queue-design.md`, bounded and
   visible).
5. **Recovery is automatic and announced.** Probing continues with
   backoff; on recovery the banner turns into a short "Spojení obnoveno"
   and every surface refreshes itself.

## Model

`ConnectivityState` (`shared/api-types.ts`), per workspace:

```ts
{
  central: { status: "online" | "degraded" | "offline"; since: string; last_ok: string | null; reason: string | null };
  drive:   { status: "online" | "offline" | "not_configured"; since: string; reason: string | null };
  host:    { status: "online" | "unreachable" | "none" }   // this machine's sidecar as a host, central mode only
}
```

`degraded` = central answers but slowly or with 5xx on some routes in
the last minute (three failures in sixty seconds); `offline` = the probe
fails (connection refused, timeout, DNS) or every request in the last
minute failed. Drive is observed from central's own reports
(`sync-info` errors, `remote_error` classifications) and from the
sync run outcomes.

Computed by `domain/connectivity.ts` in the sidecar from what already
happens (every `CentralClient` call reports success or failure into it;
a probe `GET /health` runs only while nothing else has spoken in 30 s,
backoff 5 s → 60 s while offline). Emitted to the window as
`connectivity` (per-window, same shape as `backend-ready`) on every
change; `GET /connectivity` returns the current state for a fresh mount.
Local mode: `central.status = "online"` by definition, `drive =
not_configured`.

## Behaviour by surface

| surface | online | offline |
|---|---|---|
| top banner | none | "Central nedostupný od 14:02 · poslední spojení 13:58 · <reason>"; `degraded`: "Central odpovídá pomalu" |
| StatusFooter | MCP + session count | adds the central dot and since-when |
| graph views (sidebar, node detail, edges) | live | last fetched data, badge "naposledy 13:58"; create/update/delete disabled with reason |
| editor | live | fully live (local file); save writes locally, sync state shows `push` when it comes back |
| Soubory tab | live | list from local state; Synchronizovat / Obnovit / Smazat disabled with reason; per-file classes still computed locally |
| sync overview, SyncBar | live | "Nelze zjistit stav vzdálených souborů" instead of an empty list |
| Nový úkol | live | local mode: live; central mode: disabled ("Úkoly se zadávají přes central") |
| chat (`sessions_connect`) | live | reconnecting with the state's message in the composer; messages cannot be sent |
| Relace, Přehled | live | last fetched, badge; actions disabled |
| MCP tools (agent) | live | graph tools return `503 CENTRAL_UNREACHABLE` with `since` and `reason` in the error (already the auto-seed behaviour in `transport.ts`); read tools that have a local answer (`read_file` on a mirror, `list_files` local) still work |
| Drive `offline`, central online | – | file actions that need Drive disabled ("Drive nedostupný"); graph and tasks unaffected |

Every disabled control uses one component (`Blocked` wrapper) that
takes the dependency name and renders the tooltip from the state, so the
wording is in one place.

## Testing

- `domain/connectivity.ts`: state machine from a scripted sequence of
  request outcomes and probes (online → degraded → offline → online),
  since/last_ok bookkeeping, probe backoff, no probe while traffic flows.
- API: `GET /connectivity`; MCP graph tool returns `CENTRAL_UNREACHABLE`
  with the state's fields.
- Web: `Blocked` renders the reason; typecheck + build.
- Human: pull the network on a central-mode workspace, edit a file,
  watch the banner, restore, watch the refresh.

## Phases

1. `domain/connectivity.ts`, `GET /connectivity`, window event, banner,
   StatusFooter.
2. `Blocked` wrapper applied to every control in the table; last-fetched
   badges.
3. MCP error shape; docs page "Working offline".

## Known gaps, accepted

- No offline queue for graph writes; a person who edits a node
  description offline loses nothing (the control is disabled) but also
  cannot do it. Deliberate.
- Drive status is inferred from central's reports, so it lags a sync
  run behind reality.
