// Sharing section (Sdílení). Shows the effective access-control state for
// a node -- unrestricted, inherited from an ancestor's group ACL, or the
// node's own explicit group/user allow-list -- and, for managers, lets
// them edit that list. Access is a separate endpoint (GET/PUT
// /nodes/:id/access) from the rest of NodeDetail, so this component
// self-fetches on mount and whenever nodeId changes, the same way
// DetailPane.tsx self-fetches sync status for the Files tab.

import { displayError } from "../errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Lock, Pencil, Plus, Search, User, Users, X } from "lucide-react";
import type {
  NodeAccessEntry,
  NodeAccessEntryInput,
  NodeAccessResponse,
  AccessRequest,
  AccountUser,
  DirectoryGroup,
  GraphPayload,
} from "../types";
import {
  fetchAccountUsers,
  fetchNodeAccess,
  fetchNodeAccessRequests,
  putNodeAccess,
  searchGroups,
  GoogleModeOnlyError,
} from "../api";
import { AccessRequestList } from "./AccessRequests";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isNodeType } from "../lib/node-type-labels";
import type { NodeType } from "../../../server/shared/popp";

type NodeT = TFunction<"node">;

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

// The "Skupina · ..." inherited summary line, one whole message per mode
// (no mode word is interpolated or capitalised at runtime). A null mode
// reads as "private", the server's default.
const MODE_SUMMARY: Record<AccessMode, (t: NodeT) => string> = {
  private: (t) => t(($) => $.access.mode.private.summary, { ns: "node" }),
  request: (t) => t(($) => $.access.mode.request.summary, { ns: "node" }),
};

// The read-only "Režim: <value>...</value>" line, one message per mode.
const MODE_READONLY: Record<AccessMode, (t: NodeT) => React.ReactNode> = {
  private: (t) => (
    <Trans
      t={t}
      ns="node"
      i18nKey={($) => $.access.mode.private.readonly}
      components={{ value: <span className="font-medium text-[var(--color-text-muted)]" /> }}
    />
  ),
  request: (t) => (
    <Trans
      t={t}
      ns="node"
      i18nKey={($) => $.access.mode.request.readonly}
      components={{ value: <span className="font-medium text-[var(--color-text-muted)]" /> }}
    />
  ),
};

// "Přebírá sdílení z <typu> <jméno>": one message per node type, since the
// type word is inflected differently in each language.
const INHERITED_HEADING: Record<NodeType, (t: NodeT, sourceName: string) => string> = {
  organization: (t, sourceName) => t(($) => $.access.inherited.heading.organization, { sourceName, ns: "node" }),
  project: (t, sourceName) => t(($) => $.access.inherited.heading.project, { sourceName, ns: "node" }),
  process: (t, sourceName) => t(($) => $.access.inherited.heading.process, { sourceName, ns: "node" }),
  area: (t, sourceName) => t(($) => $.access.inherited.heading.area, { sourceName, ns: "node" }),
  principle: (t, sourceName) => t(($) => $.access.inherited.heading.principle, { sourceName, ns: "node" }),
};

// The unified sharing selector's three modes -- one dimension stored in
// `nodes.visibility` (spec: docs/archive/specs/2026-07-05-unified-sharing-tab-design.md).
// "group" is the *detail* mode: it requires >= 1 node_access row (enforced
// server-side, PUT 400s on an empty entries + visibility:"group" body).
type VisibilityMode = "team" | "private" | "group";

export function AccessSection({
  nodeId,
  canManage,
  onMutate,
  graph,
}: {
  nodeId: string;
  canManage: boolean;
  onMutate: () => Promise<void>;
  // Used only to look up the type of the inherited-from node (for "Přebírá
  // sdílení z organizace X" phrasing) without a second network round trip --
  // the graph is already loaded for the rest of the app.
  graph: GraphPayload | null;
}) {
  const { t } = useTranslation("node");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [inherited, setInherited] = useState(false);
  const [sourceNodeId, setSourceNodeId] = useState<string | null>(null);
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
    kind: "switch" | "last-entry" | "clear-override";
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
  // Inline validation for the peek-and-save override card (see `isPeek`
  // below) -- saving with zero recipients must be refused client-side, not
  // surfaced as the server's 400 for an empty "group" body.
  const [overrideSaveError, setOverrideSaveError] = useState<string | null>(null);
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

  // Pending access requests on this node (manager-only fetch; GET
  // /nodes/:id/access/requests is manage-gated, so it is skipped entirely
  // for a view-only caller instead of surfacing a 403).
  const [pendingRequests, setPendingRequests] = useState<AccessRequest[]>([]);

  // Applies a fresh access view from GET/PUT to the persisted-state slots.
  // Deliberately does NOT touch the local editing flags (overriding,
  // editingGroup, confirm) -- callers reset those themselves where a
  // reset is wanted (node change, successful save).
  const applyView = useCallback((res: NodeAccessResponse) => {
    setRestricted(res.restricted);
    setInherited(res.inherited);
    setSourceNodeId(res.source_node_id);
    setSourceName(res.source_node_name);
    setMode(res.mode);
    setVisibility(res.visibility);
    const eff = res.entries.map(entryToDraft);
    setEntries(eff);
    setDraft(res.inherited ? [] : eff);
    setDraftMode(res.inherited ? "private" : (res.mode ?? "private"));
  }, []);

  const loadRequests = useCallback(async () => {
    if (!canManage) {
      setPendingRequests([]);
      return;
    }
    try {
      setPendingRequests(await fetchNodeAccessRequests(nodeId));
    } catch {
      /* the sharing view is still usable without the queue */
    }
  }, [nodeId, canManage]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setAddingOpen(false);
    setSaveError(null);
    setOverriding(false);
    setOverrideSaveError(null);
    setEditingGroup(false);
    setConfirm(null);
    setJustSaved(false);
    fetchNodeAccess(nodeId)
      .then((res) => {
        if (cancelled) return;
        applyView(res);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t(($) => $.access.load_error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, applyView, t]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  // After an approve the grant lives on the (possibly ancestor) source
  // node, so the whole access view is refetched rather than patched
  // locally; a deny only shrinks the queue.
  const onRequestResolved = async (_request: AccessRequest, decision: "approve" | "deny") => {
    await loadRequests();
    if (decision !== "approve") return;
    try {
      applyView(await fetchNodeAccess(nodeId));
      await onMutate();
    } catch {
      /* stale view until the next node change; the grant itself landed */
    }
  };

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
      applyView(res);
      setOverriding(false);
      setOverrideSaveError(null);
      setAddingOpen(false);
      setEditingGroup(false);
      setConfirm(null);
      flashSaved();
      await onMutate();
    } catch (e) {
      console.error(e);
      setSaveError(t(($) => $.access.save_error));
    } finally {
      setSaving(false);
    }
  };

  // Seeds the draft with the ancestor's entries + mode so a manager can
  // build a node-level override without re-adding every principal by hand.
  // Deliberately NOT persisted on click (isPeek below keeps every further
  // edit local too): the override becomes real only when the manager hits
  // "Uložit" in the card, so "Zrušit" can discard it with no request sent.
  const startOverride = () => {
    setDraft(entries.map((e) => ({ ...e })));
    setDraftMode(mode ?? "private");
    setOverriding(true);
    setOverrideSaveError(null);
  };

  // True while building a not-yet-persisted override on top of an inherited
  // ACL: every edit stays local until "Uložit" (see `saveOverride`), unlike
  // the rest of the pane's autosave-on-every-edit discipline (which still
  // applies once the node has its own persisted list, or is being freshly
  // switched to "Skupina" from an unrestricted state).
  const isPeek = overriding && inherited;

  const addEntry = (entry: DraftEntry) => {
    setAddingOpen(false);
    if (draft.some((d) => entryKey(d) === entryKey(entry))) return;
    const next = [...draft, entry];
    if (isPeek) {
      setDraft(next);
      setOverrideSaveError(null);
      return;
    }
    void persist(next, draftMode, "group");
  };

  const removeEntry = (index: number) => {
    const next = draft.filter((_, i) => i !== index);
    if (isPeek) {
      setDraft(next);
      return;
    }
    if (next.length > 0) {
      void persist(next, draftMode, "group");
      return;
    }
    // Removing the last recipient: with own persisted grants this is a
    // destructive switch to "Soukromé" -- same two-step confirm as the
    // selector. With nothing persisted yet (a fresh, never-restricted node)
    // it only clears the local seed.
    if (restricted && !inherited) {
      setConfirm({ target: "private", kind: "last-entry" });
      return;
    }
    setDraft([]);
  };

  const changeDraftMode = (m: AccessMode) => {
    if (isPeek || draft.length === 0) {
      setDraftMode(m);
      return;
    }
    void persist(draft, m, "group");
  };

  // Explicit save for the peek-and-save override card -- refused locally
  // when empty so the server's "group visibility requires at least one
  // access entry" 400 is never reached from the UI.
  const saveOverride = () => {
    if (draft.length === 0) {
      setOverrideSaveError(t(($) => $.access.own.empty_error));
      return;
    }
    setOverrideSaveError(null);
    void persist(draft, draftMode, "group");
  };

  const cancelOverride = () => {
    setOverriding(false);
    setOverrideSaveError(null);
  };

  // Drops this node's own ACL so it starts inheriting from its nearest
  // restricted ancestor again (or becomes fully unrestricted, if none is
  // restricted) -- visibility "team" with no entries, same derivation the
  // top-level selector already uses when switching away from "Skupina".
  const clearOverride = () => {
    setConfirm({ target: "team", kind: "clear-override" });
  };

  if (loading) {
    return (
      <p className="text-[14px] text-[var(--color-text-dim)]">{t(($) => $.access.loading)}</p>
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

  // The selector's displayed value: a node effectively governed by a group
  // ACL -- whether the rows are its own or inherited from an ancestor --
  // shows as "Skupina" even though `visibility` (the node's own column)
  // may still read "team"/"private" (the common case for a default child
  // of a group-restricted parent). `editingGroup` layers a client-side peek
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
                team: t(($) => $.access.visibility.team.disabled_inherited),
              }
            : undefined
        }
      />
      <p className="text-[11.5px] text-[var(--color-text-dim)]">
        {t(($) => $.access.visibility.legend)}
      </p>

      {displayedMode === "team" && (
        <p className="text-[14px] text-[var(--color-text-muted)]">
          {t(($) => $.access.visibility.team.description)}
        </p>
      )}

      {displayedMode === "private" && (
        <p className="text-[14px] text-[var(--color-text-muted)]">
          {t(($) => $.access.visibility.private.description)}
        </p>
      )}

      {displayedMode === "group" && (
      <div className="space-y-2.5">
      {effectiveInherited ? (
        <InheritedSummary
          sourceName={sourceName}
          sourceType={
            sourceNodeId
              ? graph?.nodes.find((n) => n.id === sourceNodeId)?.type
              : undefined
          }
          mode={mode}
          entries={entries}
          canManage={canManage}
          onStartOverride={startOverride}
        />
      ) : (
        <>
          {restricted && !canManage && (
            <p className="text-[13px] text-[var(--color-text-dim)]">
              {MODE_READONLY[mode ?? "private"](t)}
            </p>
          )}

          {!canManage && entries.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {entries.map((e) => (
                <Chip key={entryKey(e)} entry={e} />
              ))}
            </div>
          )}

          {canManage && (
            <OwnAccessCard
              isPeek={isPeek}
              showClearButton={restricted && !inherited && !isPeek}
              draft={draft}
              draftMode={draftMode}
              addingOpen={addingOpen}
              saving={saving}
              overrideSaveError={overrideSaveError}
              onChangeMode={changeDraftMode}
              onAddOpen={() => setAddingOpen(true)}
              onAddClose={() => setAddingOpen(false)}
              onPick={addEntry}
              onRemove={removeEntry}
              onSave={saveOverride}
              onCancel={cancelOverride}
              onClearOverride={clearOverride}
            />
          )}
        </>
      )}
      </div>
      )}

      {confirm && (
        <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <p className="text-[12.5px] text-[var(--color-text-muted)]">
            {confirm.kind === "last-entry"
              ? t(($) => $.access.confirm.last_entry)
              : confirm.kind === "clear-override"
                ? t(($) => $.access.confirm.clear_override)
                : t(($) => $.access.confirm.switch, { count: entries.length })}
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" onClick={confirmSwitch} disabled={saving}>
              {saving ? "…" : t(($) => $.access.confirm.confirm)}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirm(null)} disabled={saving}>
              {t(($) => $.access.confirm.cancel)}
            </Button>
          </div>
        </div>
      )}

      {canManage && pendingRequests.length > 0 && (
        <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
          <p className="text-[12.5px] font-medium text-[var(--color-text-muted)]">
            {t(($) => $.access.requests.heading, { count: pendingRequests.length })}
          </p>
          <AccessRequestList
            requests={pendingRequests}
            onResolved={(request, decision) => void onRequestResolved(request, decision)}
          />
        </div>
      )}

      {saving && (
        <p className="text-[12px] text-[var(--color-text-dim)]">{t(($) => $.access.status.saving)}</p>
      )}
      {!saving && justSaved && !saveError && (
        <p className="text-[12px] text-[var(--color-text-dim)]">{t(($) => $.access.status.saved)}</p>
      )}
      {saveError && (
        <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>
          {saveError}
        </p>
      )}
    </div>
  );
}

// Purely informational view of an inherited group ACL -- no draft form, no
// mode toggle, one action. Shown to every viewer; the "Nastavit vlastní
// sdílení" action is manager-only (see AccessSection's `canManage` gate).
function InheritedSummary({
  sourceName,
  sourceType,
  mode,
  entries,
  canManage,
  onStartOverride,
}: {
  sourceName: string | null;
  sourceType: string | undefined;
  mode: AccessMode | null;
  entries: DraftEntry[];
  canManage: boolean;
  onStartOverride: () => void;
}) {
  const { t } = useTranslation("node");
  const heading =
    sourceName === null
      ? t(($) => $.access.inherited.heading.parent)
      : sourceType && isNodeType(sourceType)
        ? INHERITED_HEADING[sourceType](t, sourceName)
        : t(($) => $.access.inherited.heading.untyped, { sourceName });
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-[var(--color-text)]">{heading}</p>
      <p className="text-[12.5px] text-[var(--color-text-dim)]">
        {MODE_SUMMARY[mode ?? "private"](t)}
      </p>
      {entries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <Chip key={entryKey(e)} entry={e} />
          ))}
        </div>
      )}
      {canManage && (
        <Button variant="outline" size="sm" onClick={onStartOverride} className="text-muted-foreground">
          <Pencil />
          {t(($) => $.access.inherited.set_own)}
        </Button>
      )}
    </div>
  );
}

// This node's own group ACL, editable by a manager -- either a
// not-yet-persisted override being built on top of an inherited ACL
// (`isPeek`, explicit Uložit/Zrušit) or the node's already-persisted own
// list / a fresh "Skupina" being switched on from scratch (autosave on
// every edit, matching the rest of the detail pane).
function OwnAccessCard({
  isPeek,
  showClearButton,
  draft,
  draftMode,
  addingOpen,
  saving,
  overrideSaveError,
  onChangeMode,
  onAddOpen,
  onAddClose,
  onPick,
  onRemove,
  onSave,
  onCancel,
  onClearOverride,
}: {
  isPeek: boolean;
  showClearButton: boolean;
  draft: DraftEntry[];
  draftMode: AccessMode;
  addingOpen: boolean;
  saving: boolean;
  overrideSaveError: string | null;
  onChangeMode: (mode: AccessMode) => void;
  onAddOpen: () => void;
  onAddClose: () => void;
  onPick: (entry: DraftEntry) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onClearOverride: () => void;
}) {
  const { t } = useTranslation("node");
  return (
    <div className="space-y-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <p className="text-[13px] font-medium text-[var(--color-text)]">
        {t(($) => $.access.own.heading)}
      </p>
      {isPeek && (
        <p className="text-[12px] text-[var(--color-text-dim)]">
          {t(($) => $.access.own.peek_hint)}
        </p>
      )}
      <ModeToggle value={draftMode} onChange={onChangeMode} disabled={saving} />
      <div className="flex flex-wrap items-center gap-1.5">
        {draft.map((e, i) => (
          <Chip key={entryKey(e)} entry={e} onRemove={() => onRemove(i)} />
        ))}
        {addingOpen ? (
          <EntryPicker
            existing={draft.map((d) => d.principal)}
            onPick={onPick}
            onClose={onAddClose}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={onAddOpen} className="text-muted-foreground">
            <Plus />
            {t(($) => $.access.own.add)}
          </Button>
        )}
      </div>
      {!isPeek && draft.length === 0 && (
        <p className="text-[12px] text-[var(--color-text-dim)]">
          {t(($) => $.access.own.unsaved_hint)}
        </p>
      )}
      {overrideSaveError && (
        <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>
          {overrideSaveError}
        </p>
      )}
      {isPeek ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? "…" : t(($) => $.access.own.save)}
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            {t(($) => $.access.own.cancel)}
          </Button>
        </div>
      ) : (
        showClearButton && (
          <Button
            variant="link"
            size="sm"
            onClick={onClearOverride}
            disabled={saving}
            className="text-muted-foreground decoration-dotted"
          >
            {t(($) => $.access.own.clear)}
          </Button>
        )
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
  const { t } = useTranslation("node");
  const options: { value: VisibilityMode; label: string; Icon: typeof Users }[] = [
    { value: "team", label: t(($) => $.access.visibility.team.label), Icon: Users },
    { value: "private", label: t(($) => $.access.visibility.private.label), Icon: Lock },
    { value: "group", label: t(($) => $.access.visibility.group.label), Icon: Users },
  ];
  const pressed = "aria-pressed:bg-muted aria-pressed:text-foreground dark:aria-pressed:bg-muted";
  return (
    <ButtonGroup aria-label={t(($) => $.access.visibility.aria_label)}>
      {options.map((opt) => {
        const active = value === opt.value;
        const optReason = disabledOptions?.[opt.value];
        const optDisabled = disabled || optReason !== undefined;
        return (
          <Button
            key={opt.value}
            variant="outline"
            size="sm"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            disabled={optDisabled}
            title={optReason}
            className={`${pressed} ${active ? "font-medium" : "text-muted-foreground"}`}
          >
            <opt.Icon />
            {opt.label}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}

// Segmented control for the draft's restriction mode -- "Skryté pro ostatní"
// (default, non-member sees nothing) vs. "Na vyžádání" (non-member sees a
// locked chip on visible neighbours, spec §"Zamčené položky v Propojení").
// Only shown to managers editing this node's own ACL (see canManage block
// above).
function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: AccessMode;
  onChange: (mode: AccessMode) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("node");
  const options: { value: AccessMode; label: string }[] = [
    { value: "private", label: t(($) => $.access.mode.private.label) },
    { value: "request", label: t(($) => $.access.mode.request.label) },
  ];
  const pressed = "aria-pressed:bg-muted aria-pressed:text-foreground dark:aria-pressed:bg-muted";
  return (
    <div className="space-y-1">
      <ButtonGroup aria-label={t(($) => $.access.mode.aria_label)}>
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <Button
              key={opt.value}
              variant="outline"
              size="sm"
              aria-pressed={active}
              onClick={() => onChange(opt.value)}
              disabled={disabled}
              className={`${pressed} ${active ? "font-medium" : "text-muted-foreground"}`}
            >
              {opt.label}
            </Button>
          );
        })}
      </ButtonGroup>
      <p className="text-[11px] text-[var(--color-text-dim)]">
        {value === "request"
          ? t(($) => $.access.mode.request.description)
          : t(($) => $.access.mode.private.description)}
      </p>
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
  const { t } = useTranslation("node");
  const label =
    entry.kind === "group"
      ? entry.display_email ?? entry.principal
      : entry.display_name ?? entry.display_email ?? entry.principal;
  const Icon = entry.kind === "group" ? Users : User;
  return (
    <Badge
      variant="outline"
      className={`border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] ${onRemove ? "h-6 overflow-visible pr-0.5" : ""}`}
    >
      <Icon className="shrink-0 text-[var(--color-text-dim)]" />
      <span className="max-w-[180px] truncate">{label}</span>
      {onRemove && (
        <Button
          variant="destructive"
          size="icon-xs"
          onClick={onRemove}
          title={t(($) => $.access.chip.remove)}
          className="ml-0.5 shrink-0 rounded-full"
        >
          <X />
        </Button>
      )}
    </Badge>
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
  const { t } = useTranslation("node");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<DirectoryGroup[]>([]);
  const [groupsAvailable, setGroupsAvailable] = useState(true);
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const allUsersRef = useRef<AccountUser[] | null>(null);

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
          setSearchError(displayError(e));
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

  // Always open while mounted: OwnAccessCard mounts this picker in place of
  // the "+ Přidat" button and unmounts it via onClose, which Radix fires on
  // click-outside, Escape and a click on the trigger alike.
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="border-[var(--color-accent-dim)] text-[var(--color-accent)]"
        >
          <Plus />
          {t(($) => $.access.own.add)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
          <Search className="size-3 shrink-0 text-[var(--color-text-dim)]" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder={t(($) => $.access.picker.search_placeholder)}
            className="flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <div className="scroll-thin max-h-[240px] overflow-y-auto py-1">
          {groupCandidates.length === 0 && userCandidates.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-[var(--color-text-dim)]">
              {t(($) => $.access.picker.no_match)}
            </div>
          ) : (
            <>
              {groupCandidates.map((g) => (
                <Button
                  key={`group-${g.id}`}
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onPick({
                      kind: "group",
                      principal: g.id,
                      display_email: g.email,
                      display_name: null,
                    })
                  }
                  className="w-full justify-start gap-2 rounded-none font-normal"
                >
                  <Users className="shrink-0 text-[var(--color-text-dim)]" />
                  <span className="min-w-0 flex-1 truncate text-left text-[var(--color-text)]">{g.name}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--color-text-dim)]">
                    {g.email}
                  </span>
                </Button>
              ))}
              {userCandidates.map((u) => (
                <Button
                  key={`user-${u.id}`}
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onPick({
                      kind: "user",
                      principal: u.id,
                      display_email: u.email,
                      display_name: u.name,
                    })
                  }
                  className="w-full justify-start gap-2 rounded-none font-normal"
                >
                  <User className="shrink-0 text-[var(--color-text-dim)]" />
                  <span className="min-w-0 flex-1 truncate text-left text-[var(--color-text)]">{u.name}</span>
                  <span className="shrink-0 text-[10.5px] text-[var(--color-text-dim)]">
                    {u.email}
                  </span>
                </Button>
              ))}
            </>
          )}
          {searchError && (
            <div className="px-3 py-2 text-[12.5px]" style={{ color: "var(--color-danger)" }}>
              {searchError}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
