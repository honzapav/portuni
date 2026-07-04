// Sharing section (Sdílení). Shows the effective access-control state for
// a node -- unrestricted, inherited from an ancestor's group ACL, or the
// node's own explicit group/user allow-list -- and, for managers, lets
// them edit that list. Access is a separate endpoint (GET/PUT
// /nodes/:id/access) from the rest of NodeDetail, so this component
// self-fetches on mount and whenever nodeId changes, the same way
// DetailPane.tsx self-fetches sync status for the Files tab.

import { useEffect, useRef, useState } from "react";
import { Copy, Plus, Search, User, Users, X } from "lucide-react";
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

// Sort-independent identity key for a set-equality check between the
// draft and the node's own persisted entries (order doesn't matter).
function entryKey(d: DraftEntry): string {
  return `${d.kind}:${d.principal}`;
}

function draftSetKey(entries: DraftEntry[]): string {
  return entries.map(entryKey).sort().join("|");
}

type AccessMode = "private" | "request";

function modeLabel(m: AccessMode | null): string {
  return m === "request" ? "Na vyžádání" : "Soukromé";
}

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setAddingOpen(false);
    setSaveError(null);
    setOverriding(false);
    fetchNodeAccess(nodeId)
      .then((res) => {
        if (cancelled) return;
        setRestricted(res.restricted);
        setInherited(res.inherited);
        setSourceName(res.source_node_name);
        setMode(res.mode);
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

  const persist = async (next: DraftEntry[], nextMode: AccessMode) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await putNodeAccess(nodeId, next.map(draftToInput), nextMode);
      setRestricted(res.restricted);
      setInherited(res.inherited);
      setSourceName(res.source_node_name);
      setMode(res.mode);
      const eff = res.entries.map(entryToDraft);
      setEntries(eff);
      setDraft(res.inherited ? [] : eff);
      setDraftMode(res.inherited ? "private" : (res.mode ?? "private"));
      setOverriding(false);
      setAddingOpen(false);
      await onMutate();
    } catch (e) {
      console.error(e);
      setSaveError("Uložení se nepovedlo. Zkus to znovu.");
    } finally {
      setSaving(false);
    }
  };

  // Seeds the draft with the ancestor's entries + mode so a manager can
  // narrow an inherited ACL without re-adding every principal by hand. The
  // copy only becomes a real override on this node once "Uložit" persists
  // it -- until then this is purely a local editing-mode switch.
  const startOverride = () => {
    setDraft(entries.map((e) => ({ ...e })));
    setDraftMode(mode ?? "private");
    setOverriding(true);
  };

  const addEntry = (entry: DraftEntry) => {
    setDraft((prev) =>
      prev.some((d) => entryKey(d) === entryKey(entry)) ? prev : [...prev, entry],
    );
    setAddingOpen(false);
  };

  const removeEntry = (index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
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

  // Dirty check: compare the draft's entry set + mode against what's
  // actually persisted as this node's OWN acl (empty/"private" when
  // inherited, since the node has no rows of its own yet). Always uses the
  // raw (server-persisted) `inherited`/`mode`, not the local `overriding`
  // switch, so starting a copy immediately shows as dirty (ready to save).
  const ownKey = inherited ? "" : draftSetKey(entries);
  const ownMode: AccessMode = inherited ? "private" : (mode ?? "private");
  // Mode only has meaning once there's at least one entry (an empty draft
  // has nothing to apply it to, and the server ignores `mode` when entries
  // is empty) -- ignore it here so toggling mode with an empty draft
  // doesn't spuriously enable "Uložit".
  const dirty =
    draftSetKey(draft) !== ownKey || (draft.length > 0 && draftMode !== ownMode);

  return (
    <div className="space-y-2.5">
      {!restricted && (
        <p className="text-[14px] text-[var(--color-text-muted)]">
          Vidí všichni přihlášení
        </p>
      )}

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
          <ModeToggle value={draftMode} onChange={setDraftMode} disabled={saving} />
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
          <div className="flex gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void persist(draft, draftMode)}
              disabled={saving || !dirty}
              className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[13px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
            >
              {saving ? "Ukládám..." : "Uložit"}
            </button>
            {restricted && !inherited && (
              <button
                type="button"
                onClick={() => void persist([], "private")}
                disabled={saving}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                Zrušit omezení
              </button>
            )}
          </div>
          {saveError && (
            <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>
              {saveError}
            </p>
          )}
        </>
      )}
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
