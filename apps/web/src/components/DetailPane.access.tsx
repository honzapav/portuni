// Sharing section (Sdílení). Shows the effective access-control state for
// a node -- unrestricted, inherited from an ancestor's group ACL, or the
// node's own explicit group/user allow-list -- and, for managers, lets
// them edit that list. Access is a separate endpoint (GET/PUT
// /nodes/:id/access) from the rest of NodeDetail, so this component
// self-fetches on mount and whenever nodeId changes, the same way
// DetailPane.tsx self-fetches sync status for the Files tab.

import { useEffect, useRef, useState } from "react";
import { Plus, Search, User, Users, X } from "lucide-react";
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
  // The effective entries as last fetched from the server -- this node's
  // own list when !inherited, the ancestor's list when inherited.
  const [entries, setEntries] = useState<DraftEntry[]>([]);
  // Editable draft. Mirrors `entries` when the node has its own ACL;
  // starts empty when inherited or unrestricted (adding to it creates a
  // NEW override on this node, it never edits the ancestor's rows).
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [addingOpen, setAddingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setAddingOpen(false);
    setSaveError(null);
    fetchNodeAccess(nodeId)
      .then((res) => {
        if (cancelled) return;
        setRestricted(res.restricted);
        setInherited(res.inherited);
        setSourceName(res.source_node_name);
        const eff = res.entries.map(entryToDraft);
        setEntries(eff);
        setDraft(res.inherited ? [] : eff);
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

  const persist = async (next: DraftEntry[]) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await putNodeAccess(nodeId, next.map(draftToInput));
      setRestricted(res.restricted);
      setInherited(res.inherited);
      setSourceName(res.source_node_name);
      const eff = res.entries.map(entryToDraft);
      setEntries(eff);
      setDraft(res.inherited ? [] : eff);
      setAddingOpen(false);
      await onMutate();
    } catch (e) {
      console.error(e);
      setSaveError("Uložení se nepovedlo. Zkus to znovu.");
    } finally {
      setSaving(false);
    }
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

  // Read-only informational chips: this node's own explicit list (when a
  // non-manager views it), or the ancestor's inherited list (shown to
  // everyone, manager or not -- managers get an additional editable draft
  // row below to build their own override).
  const showReadOnlyChips =
    restricted && (inherited || !canManage) && entries.length > 0;

  // Dirty check: compare the draft's entry set against what's actually
  // persisted as this node's OWN acl (empty when inherited, since the
  // node has no rows of its own yet).
  const ownKey = inherited ? "" : draftSetKey(entries);
  const dirty = draftSetKey(draft) !== ownKey;

  return (
    <div className="space-y-2.5">
      {!restricted && (
        <p className="text-[14px] text-[var(--color-text-muted)]">
          Vidí všichni přihlášení
        </p>
      )}

      {inherited && (
        <p className="text-[13px] text-[var(--color-text-dim)]">
          Dědí z{" "}
          <span className="font-medium text-[var(--color-text-muted)]">
            {sourceName ?? "nadřazeného uzlu"}
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
              onClick={() => void persist(draft)}
              disabled={saving || !dirty}
              className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[13px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
            >
              {saving ? "Ukládám..." : "Uložit"}
            </button>
            {restricted && !inherited && (
              <button
                type="button"
                onClick={() => void persist([])}
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
