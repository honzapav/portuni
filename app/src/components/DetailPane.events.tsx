// Event card + AddEventForm. Split from DetailPane.tsx to keep the file
// under 4000 lines. These are standalone components — they receive the
// node id and a refresh callback as props and don't share state with
// the rest of DetailPane.

import { useState } from "react";
import { Check, Clock, Pencil, Plus, Trash2, X } from "lucide-react";
import type { DetailEvent } from "../types";
import { EVENT_TYPES } from "../types";
import { archiveEvent, createEvent, updateEvent } from "../api";

export function EventCard({
  event: evt,
  onMutate,
  busy,
}: {
  event: DetailEvent;
  onMutate: () => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(evt.content);
  const [type, setType] = useState(evt.type);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      if (content.trim() !== evt.content) patch.content = content.trim();
      if (type !== evt.type) patch.type = type;
      if (Object.keys(patch).length > 0) {
        await updateEvent(evt.id, patch);
        await onMutate();
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    setSaving(true);
    try {
      await archiveEvent(evt.id);
      await onMutate();
    } finally {
      setSaving(false);
    }
  };

  const resolve = async () => {
    setSaving(true);
    try {
      await updateEvent(evt.id, { status: "resolved" });
      await onMutate();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-surface)] px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[12.5px] text-[var(--color-text)]"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="flex-1" />
          <button
            onClick={() => {
              setEditing(false);
              setContent(evt.content);
              setType(evt.type);
            }}
            className="text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            Zrušit
          </button>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
        />
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={save}
            disabled={saving || !content.trim()}
            className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1 text-[13px] text-[var(--color-accent)] hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
          >
            {saving ? "Ukládám..." : "Uložit"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="mb-0.5 flex items-center gap-2">
        <span className="font-mono text-[12px] uppercase tracking-wider text-[var(--color-accent)]">
          {evt.type}
        </span>
        {evt.status !== "active" && (
          <span className="rounded-sm bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)]">
            {evt.status}
          </span>
        )}
        <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-dim)]">
          <Clock size={9} />
          {evt.created_at.slice(0, 10)}
        </span>
        <span className="flex-1" />
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {evt.status === "active" && (
            <button
              onClick={resolve}
              disabled={busy || saving}
              title="Označit jako vyřešené"
              className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)]"
            >
              <Check size={11} />
            </button>
          )}
          <button
            onClick={() => setEditing(true)}
            disabled={busy || saving}
            title="Upravit"
            className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={archive}
            disabled={busy || saving}
            title="Archivovat"
            className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={11} />
          </button>
        </span>
      </div>
      <div className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
        {evt.content}
      </div>
    </div>
  );
}

export function AddEventForm({
  nodeId,
  onMutate,
  disabled,
}: {
  nodeId: string;
  onMutate: () => Promise<void>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>("note");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[13.5px] text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
      >
        <Plus size={12} />
        Přidat událost
      </button>
    );
  }

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      await createEvent({ node_id: nodeId, type, content: content.trim() });
      await onMutate();
      setOpen(false);
      setContent("");
      setType("note");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[12px] uppercase tracking-widest text-[var(--color-text-dim)]">
          Nová událost
        </div>
        <button
          onClick={() => {
            setOpen(false);
            setContent("");
          }}
          className="text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <X size={12} />
        </button>
      </div>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="mb-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[13.5px] text-[var(--color-text)]"
      >
        {EVENT_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Co se stalo?"
        rows={3}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] outline-none focus:border-[var(--color-accent-dim)]"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={submit}
          disabled={!content.trim() || submitting || disabled}
          className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-dim)]/15 px-3 py-1.5 text-[13.5px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]/25 disabled:opacity-50"
        >
          {submitting ? "Přidávám..." : "Přidat událost"}
        </button>
      </div>
    </div>
  );
}
