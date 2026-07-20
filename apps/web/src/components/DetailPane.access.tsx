// Sharing section (Sdílení). Shows the effective access-control state for
// a node -- unrestricted, inherited from an ancestor's group ACL, or the
// node's own explicit group/user allow-list -- and, for managers, lets
// them edit that list. Access is a separate endpoint (GET/PUT
// /nodes/:id/access) from the rest of NodeDetail, so this component
// self-fetches on mount and whenever nodeId changes, the same way
// DetailPane.tsx self-fetches sync status for the Files tab.

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Lock, Plus, Search, User, Users, X } from "lucide-react";
import type {
  NodeAccessEntry,
  NodeAccessEntryInput,
  AccountUser,
  DirectoryGroup,
} from "../types";
import {
  fetchAccountUsers,
  fetchNodeAccess,
  putNodeAccess,
  searchGroups,
  GoogleModeOnlyError,
} from "../api";

// Local shape used for both the informational (read-only) entries coming
// back from GET and the in-progress draft being edited. display_name is
// only ever set for "user" entries -- kept optional/null for "group" to
// mirror the server's NodeAccessEntry exactly.
type DraftEntry = {
  kind: "group" | "user";
  principal: string;
  display_email: string | null;
  display_name: string | null;
};

function entryToDraft(e: NodeAccessEntry): DraftEntry {
  return {
    kind: e.kind,
    principal: e.principal,
    display_email: e.display_email,
    display_name: e.display_name,
  };
}

function draftToInput(d: DraftEntry): NodeAccessEntryInput {
  if (d.kind === "group") {
    return {
      kind: "group",
      principal: d.principal,
      display_email: d.display_email ?? d.principal,
    };
  }
  return { kind: "user", principal: d.principal };
}

// Identity key for entry dedup and stable chip keys.
function entryKey(d: DraftEntry): string {
  return `${d.kind}:${d.principal}`;
}

type AccessMode = "private" | "request";

function modeLabel(m: AccessMode | null): string {
  return m === "request" ? "Na vyžádání" : "Soukromé";
}

// The unified sharing selector's three modes -- one dimension stored in
// `nodes.visibility` (spec: docs/archive/specs/2026-07-05-unified-sharing-tab-design.md).
// "group" is the *detail* mode: it requires >= 1 node_access row (enforced
// server-side, PUT 400s on an empty entries + visibility:"group" body).
type VisibilityMode = "team" | "private" | "group";

export function AccessSection({
  nodeId,
  canManage,
  onMutate,
}: {
  nodeId: string;
  canManage: boolean;
  onMutate: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [inherited, setInherited] = useState(false);
  const [sourceName, setSourceName] = useState<string | null>(null);
  // The node's OWN visibility mode, as last fetched/saved -- drives the
  // top-level Tým/Soukromé/Skupina selector together with `restricted`
  // (see `effectiveMode` below: an inherited-restricted node shows as
  // "group" even though its own column still reads "team").
  const [visibility, setVisibility] = useState<VisibilityMode>("team");
  // True while a manager is peeking at the group editor on a node that
  // isn't (yet) restricted -- clicking "Skupina" only opens this local
  // view, it never persists by itself (an empty group would 400 server
  // side). Reset whenever the node changes or a mutation actually lands.
  const [editingGroup, setEditingGroup] = useState(false);
  // Armed when an action would drop this node's own (non-inherited) grants
  // -- switching the selector away from "Skupina", or removing the last
  // recipient (an empty group is not a persistable state). Holds the target
  // mode until "Potvrdit". window.confirm is a silent no-op in the Tauri
  // macOS webview (see WorkspacesSection.tsx / SyncSection.tsx), hence the
  // inline two-step pattern instead.
  const [confirm, setConfirm] = useState<{
    target: VisibilityMode;
    kind: "switch" | "last-entry";
  } | null>(null);
  // Restriction mode of the authoritative node (self when !inherited, the
  // ancestor's when inherited). Null when unrestricted.
  const [mode, setMode] = useState<AccessMode | null>(null);
  // The effective entries as last fetched from the server -- this node's
  // own list when !inherited, the ancestor's list when inherited.
  const [entries, setEntries] = useState<DraftEntry[]>([]);
  // Editable draft. Mirrors `entries` when the node has its own ACL;
  // starts empty when inherited or unrestricted (adding to it creates a
  // NEW override on this node, it never edits the ancestor's rows).
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  // Mode of the draft being edited -- what gets sent as `mode` on save.
  const [draftMode, setDraftMode] = useState<AccessMode>("private");
  // True after "Upravit kopii": the manager is building a local override
  // seeded from the inherited entries/mode, even though the node's own
  // persisted state (per the last fetch/save) is still "inherited". Only
  // affects which panel renders (informational vs. editable) -- the dirty
  // check below always compares against the raw persisted `inherited`.
  const [overriding, setOverriding] = useState(false);
  const [addingOpen, setAddingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Transient "Uloženo" readout after a successful autosave -- the save
  // button is gone, so this is the only feedback that a change landed.
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<number | null>(null);
  const flashSaved = useCallback(() => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    setJustSaved(true);
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      setJustSaved(false);
    }, 2000);
  }, []);
  useEffect(
    () => () => {
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setAddingOpen(false);
    setSaveError(null);
    setOverriding(false);
    setEditingGroup(false);
    setConfirm(null);
    setJustSaved(false);
    fetchNodeAccess(nodeId)
      .then((res) => {
        if (cancelled) return;
        setRestricted(res.restricted);
        setInherited(res.inherited);
        setSourceName(res.source_node_name);
        setMode(res.mode);
        setVisibility(res.visibility);
        const eff = res.entries.map(entryToDraft);
        setEntries(eff);
        setDraft(res.inherited ? [] : eff);
        setDraftMode(res.inherited ? "private" : (res.mode ?? "private"));
      })
      .catch(() => {
        if (!cancelled) setLoadError("Nepodařilo se načíst sdílení");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  // `nextVisibility` is the authoritative arg of the unified sharing
  // control: "team"/"private" force entries empty server-side, "group"
  // requires >= 1 entry. Autosave discipline: nothing is applied
  // optimistically -- local state is overwritten from the PUT response on
  // success only, so on failure the UI keeps showing what is actually
  // persisted (plus the error) instead of a state the server never took.
  const persist = async (
    next: DraftEntry[],
    nextMode: AccessMode,
    nextVisibility: VisibilityMode,
  ) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await putNodeAccess(
        nodeId,
        next.map(draftToInput),
        nextMode,
        nextVisibility,
      );
      setRestricted(res.restricted);
      setInherited(res.inherited);
      setSourceName(res.source_node_name);
      setMode(res.mode);
      setVisibility(res.visibility);
      const eff = res.entries.map(entryToDraft);
      setEntries(eff);
      setDraft(res.inherited ? [] : eff);
      setDraftMode(res.inherited ? "private" : (res.mode ?? "private"));
      setOverriding(false);
      setAddingOpen(false);
      setEditingGroup(false);
      setConfirm(null);
      flashSaved();
      await onMutate();
    } catch (e) {
      console.error(e);
      setSaveError("Uložení se nepovedlo. Zkus to znovu.");
    } finally {
      setSaving(false);
    }
  };

  // Seeds the draft with the ancestor's entries + mode so a manager can
  // narrow an inherited ACL without re-adding every principal by hand.
  // Deliberately NOT persisted on click: saving an identical copy would
  // already detach the node from the ancestor's future ACL changes, so the
  // copy becomes a real override only with the first actual edit (which
  // autosaves it).
  const startOverride = () => {
    setDraft(entries.map((e) => ({ ...e })));
    setDraftMode(mode ?? "private");
    setOverriding(true);
  };

  // Autosave: every committed edit persists immediately, matching the rest
  // of the detail pane (lifecycle, owner, organization all save on change).
  // The only local-only moments are an empty "Skupina" draft (the server
  // rightly 400s an empty group) and an untouched "Upravit kopii" seed.
  const addEntry = (entry: DraftEntry) => {
    setAddingOpen(false);
    if (draft.some((d) => entryKey(d) === entryKey(entry))) return;
    void persist([...draft, entry], draftMode, "group");
  };

  const removeEntry = (index: number) => {
    const next = draft.filter((_, i) => i !== index);
    if (next.length > 0) {
      void persist(next, draftMode, "group");
      return;
    }
    // Removing the last recipient: with own persisted grants this is a
    // destructive switch to "Soukromé" -- same two-step confirm as the
    // selector. With nothing persisted yet (peek/copy) it only clears the
    // local seed.
    if (restricted && !inherited) {
      setConfirm({ target: "private", kind: "last-entry" });
      return;
    }
    setDraft([]);
  };

  const changeDraftMode = (m: AccessMode) => {
    if (draft.length === 0) {
      setDraftMode(m);
      return;
    }
    void persist(draft, m, "group");
  };

  if (loading) {
    return (
      <p className="text-[14px] text-[var(--color-text-dim)]">Načítám...</p>
    );
  }

  if (loadError) {
    return (
      <p className="text-[14px]" style={{ color: "var(--color-danger)" }}>
        {loadError}
      </p>
    );
  }

  // Local editing-mode switch: while "overriding" the panel shows the
  // editable draft (seeded from the inherited list) instead of the plain
  // informational "Dědí z" view, even though the node's persisted state is
  // still inherited until the draft is saved.
  const effectiveInherited = inherited && !overriding;

  // Read-only informational chips: this node's own explicit list (when a
  // non-manager views it), or the ancestor's inherited list (shown to
  // everyone, manager or not -- managers get an additional editable draft
  // row below to build their own override).
  const showReadOnlyChips =
    restricted && (effectiveInherited || !canManage) && entries.length > 0;

  // The selector's displayed value: a node effectively governed by a group
  // ACL -- whether the rows are its own or inherited from an ancestor --
  // shows as "Skupina" even though `visibility` (the node's own column)
  // may still read "team"/"private" (the common case for a default child
  // of a group-restricted parent). `editingGroup` layers a local-only peek
  // on top so a manager can open the group editor on an otherwise
  // unrestricted node without persisting anything yet.
  const effectiveMode: VisibilityMode = restricted ? "group" : visibility;
  const displayedMode: VisibilityMode = editingGroup ? "group" : effectiveMode;

  const selectMode = (target: VisibilityMode) => {
    if (saving || target === displayedMode) return;
    if (target === "group") {
      setEditingGroup(true);
      setConfirm(null);
      return;
    }
    // Switching away from "Skupina" to Tým/Soukromé. Only this node's OWN,
    // non-inherited grants are at risk of being cleared -- an inherited-only
    // restriction isn't touched by this node's own visibility column, and
    // an unsaved "editingGroup" peek has nothing persisted to lose.
    if (displayedMode === "group") {
      const ownGrantsExist = restricted && !inherited && entries.length > 0;
      if (ownGrantsExist) {
        setConfirm({ target, kind: "switch" });
        return;
      }
    }
    void persist([], "private", target);
  };

  const confirmSwitch = () => {
    const target = confirm?.target;
    setConfirm(null);
    if (target) void persist([], "private", target);
  };

  return (
    <div className="space-y-3">
      <VisibilitySelector
        value={displayedMode}
        onChange={selectMode}
        disabled={!canManage || saving}
        disabledOptions={
          effectiveInherited
            ? {
                team: "Node dědí omezení z nadřazeného uzlu – nelze ho zpřístupnit všem, jen zúžit nebo upravit kopii.",
              }
            : undefined
        }
      />

      {displayedMode === "team" && (
        <p className="text-[14px] text-[var(--color-text-muted)]">
          Vidí všichni přihlášení.
        </p>
      )}

      {displayedMode === "private" && (
        <p className="text-[14px] text-[var(--color-text-muted)]">
          Vidí jen tvůrce a správci.
        </p>
      )}

      {displayedMode === "group" && (
      <div className="space-y-2.5">
      {effectiveInherited && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] text-[var(--color-text-dim)]">
            Dědí z{" "}
            <span className="font-medium text-[var(--color-text-muted)]">
              {sourceName ?? "nadřazeného uzlu"}
            </span>
            {" — "}
            <span className="font-medium text-[var(--color-text-muted)]">
              {modeLabel(mode)}
            </span>
          </p>
          {canManage && (
            <button
              type="button"
              onClick={startOverride}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
            >
              <Copy size={10} />
              Upravit kopii
            </button>
          )}
        </div>
      )}

      {restricted && !inherited && !canManage && (
        <p className="text-[13px] text-[var(--color-text-dim)]">
          Režim:{" "}
          <span className="font-medium text-[var(--color-text-muted)]">
            {modeLabel(mode)}
          </span>
        </p>
      )}

      {showReadOnlyChips && (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <Chip key={entryKey(e)} entry={e} />
          ))}
        </div>
      )}

      {canManage && (
        <>
          {overriding && inherited && (
            <p className="text-[12px] text-[var(--color-text-dim)]">
              Upravuješ kopii zděděného sdílení – uloží se s první změnou.
            </p>
          )}
          <ModeToggle value={draftMode} onChange={changeDraftMode} disabled={saving} />
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.map((e, i) => (
              <Chip key={entryKey(e)} entry={e} onRemove={() => removeEntry(i)} />
            ))}
            {addingOpen ? (
              <EntryPicker
                existing={draft.map((d) => d.principal)}
                onPick={addEntry}
                onClose={() => setAddingOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddingOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
              >
                <Plus size={10} />
                Přidat skupinu nebo uživatele…
              </button>
            )}
          </div>
          {draft.length === 0 && (
            <p className="text-[12px] text-[var(--color-text-dim)]">
              Zatím neuloženo – sdílení pro skupinu se uloží s prvním
              příjemcem. Bez příjemců node uvidí jen správci.
            </p>
          )}
        </>
      )}
      </div>
      )}

      {confirm && (
        <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            {confirm.kind === "last-entry"
              ? "Odebráním posledního příjemce se sdílení zruší a node bude Soukromý."
              : `Přepnutím odebereš ${entries.length} sdílení.`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirmSwitch}
              disabled={saving}
              className="rounded-md border border-[color:var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-bg-hover)] disabled:opacity-50"
            >
              {saving ? "…" : "Potvrdit"}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              disabled={saving}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
          </div>
        </div>
      )}

      {saving && (
        <p className="text-[12px] text-[var(--color-text-dim)]">Ukládám…</p>
      )}
      {!saving && justSaved && !saveError && (
        <p className="text-[12px] text-[var(--color-text-dim)]">Uloženo</p>
      )}
      {saveError && (
        <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>
          {saveError}
        </p>
      )}
    </div>
  );
}

// Top-level segmented control for the unified sharing mode (spec:
// docs/archive/specs/2026-07-05-unified-sharing-tab-design.md). Reflects
// `displayedMode` from AccessSection -- an inherited or own group ACL both
// show as "Skupina", team/private nodes show their own column value.
function VisibilitySelector({
  value,
  onChange,
  disabled,
  disabledOptions,
}: {
  value: VisibilityMode;
  onChange: (mode: VisibilityMode) => void;
  disabled?: boolean;
  // Individually-disabled options (with a reason as the title). Used to
  // grey out "Všichni" on an inherited-restricted node, where loosening
  // below the ancestor's restriction is impossible.
  disabledOptions?: Partial<Record<VisibilityMode, string>>;
}) {
  const options: { value: VisibilityMode; label: string; Icon: typeof Users }[] = [
    { value: "team", label: "Všichni", Icon: Users },
    { value: "private", label: "Soukromé", Icon: Lock },
    { value: "group", label: "Skupina", Icon: Users },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
      {options.map((opt, i) => {
        const active = value === opt.value;
        const optReason = disabledOptions?.[opt.value];
        const optDisabled = disabled || optReason !== undefined;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            disabled={optDisabled}
            title={optReason}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50 ${
              i > 0 ? "border-l border-[var(--color-border)]" : ""
            } ${
              active
                ? "bg-[var(--color-accent-dim)]/20 font-medium text-[var(--color-accent)]"
                : "bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            }`}
          >
            <opt.Icon size={13} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Segmented control for the draft's restriction mode -- "Soukromé" (default,
// non-member sees nothing) vs. "Na vyžádání" (non-member sees a locked chip
// on visible neighbours, spec §"Zamčené položky v Propojení"). Only shown to
// managers editing this node's own ACL (see canManage block above).
function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: AccessMode;
  onChange: (mode: AccessMode) => void;
  disabled?: boolean;
}) {
  const options: { value: AccessMode; label: string }[] = [
    { value: "private", label: "Soukromé" },
    { value: "request", label: "Na vyžádání" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
      {options.map((opt, i) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            className={`px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50 ${
              i > 0 ? "border-l border-[var(--color-border)]" : ""
            } ${
              active
                ? "bg-[var(--color-accent-dim)]/20 font-medium text-[var(--color-accent)]"
                : "bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Chip({
  entry,
  onRemove,
}: {
  entry: DraftEntry;
  onRemove?: () => void;
}) {
  const label =
    entry.kind === "group"
      ? entry.display_email ?? entry.principal
      : entry.display_name ?? entry.display_email ?? entry.principal;
  const Icon = entry.kind === "group" ? Users : User;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-text)]">
      <Icon size={10} className="shrink-0 text-[var(--color-text-dim)]" />
      <span className="max-w-[180px] truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Odebrat"
          className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[var(--color-text-dim)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
        >
          <X size={9} />
        </button>
      )}
    </span>
  );
}

function filterUsers(list: AccountUser[], query: string): AccountUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
  );
}

// Inline popover: search-as-you-type combobox that suggests groups
// (server-side, debounced 300ms -- the Google Workspace directory can be
// large) and users (fetched once, filtered locally). In env auth mode
// GET /auth/groups responds 501 google_mode_only; the picker then quietly
// stops offering groups instead of showing an error banner.
function EntryPicker({
  existing,
  onPick,
  onClose,
}: {
  existing: string[];
  onPick: (entry: DraftEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<DirectoryGroup[]>([]);
  const [groupsAvailable, setGroupsAvailable] = useState(true);
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const allUsersRef = useRef<AccountUser[] | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Full user list fetched once; filtered locally on every keystroke.
  useEffect(() => {
    let cancelled = false;
    fetchAccountUsers()
      .then((list) => {
        if (cancelled) return;
        allUsersRef.current = list;
        setUsers(filterUsers(list, ""));
      })
      .catch(() => {
        /* users list stays empty; group search may still work */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced group search + local user re-filter on every query change.
  useEffect(() => {
    let cancelled = false;
    if (allUsersRef.current) setUsers(filterUsers(allUsersRef.current, query));
    if (!groupsAvailable) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      searchGroups(query)
        .then((res) => {
          if (cancelled) return;
          setGroups(res);
          setSearchError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof GoogleModeOnlyError) {
            setGroupsAvailable(false);
            setGroups([]);
            return;
          }
          setSearchError(String(e));
        });
    }, 300);
    return () => {
      cancelled = true;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, groupsAvailable]);

  const groupCandidates = groups.filter((g) => !existing.includes(g.id));
  const userCandidates = users.filter((u) => !existing.includes(u.id));

  return (
    <div ref={containerRef} className="relative inline-block">
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-accent-dim)] px-2 py-0.5 text-[12px] text-[var(--color-accent)]">
        <Plus size={10} />
        Přidat skupinu nebo uživatele…
      </span>
      <div className="absolute left-0 top-full z-50 mt-1 w-[260px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
          <Search size={12} className="shrink-0 text-[var(--color-text-dim)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Hledat…"
            className="flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-dim)]"
          />
        </div>
        <div className="scroll-thin max-h-[240px] overflow-y-auto py-1">
          {groupCandidates.length === 0 && userCandidates.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-[var(--color-text-dim)]">
              Nic neodpovídá.
            </div>
          ) : (
            <>
              {groupCandidates.map((g) => (
                <button
                  key={`group-${g.id}`}
                  type="button"
                  onClick={() =>
                    onPick({
                      kind: "group",
                      principal: g.id,
                      display_email: g.email,
                      display_name: null,
                    })
                  }
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-surface)]"
                >
                  <Users size={11} className="shrink-0 text-[var(--color-text-dim)]" />
                  <span className="flex-1 truncate text-[var(--color-text)]">{g.name}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--color-text-dim)]">
                    {g.email}
                  </span>
                </button>
              ))}
              {userCandidates.map((u) => (
                <button
                  key={`user-${u.id}`}
                  type="button"
                  onClick={() =>
                    onPick({
                      kind: "user",
                      principal: u.id,
                      display_email: u.email,
                      display_name: u.name,
                    })
                  }
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-surface)]"
                >
                  <User size={11} className="shrink-0 text-[var(--color-text-dim)]" />
                  <span className="flex-1 truncate text-[var(--color-text)]">{u.name}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--color-text-dim)]">
                    {u.email}
                  </span>
                </button>
              ))}
            </>
          )}
          {searchError && (
            <div className="px-3 py-2 text-[12.5px]" style={{ color: "var(--color-danger)" }}>
              {searchError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
