// Event card + AddEventForm. Split from DetailPane.tsx to keep the file
// under 4000 lines. These are standalone components — they receive the
// node id and a refresh callback as props and don't share state with
// the rest of DetailPane.

import { displayError } from "../errors";
import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { DetailEvent } from "../types";
import { EVENT_TYPES } from "../types";
import { archiveEvent, createEvent, updateEvent } from "../api";
import { DatePicker } from "./DatePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
  const [date, setDate] = useState(evt.created_at.slice(0, 10));
  const [saving, setSaving] = useState(false);
  // A failed mutation used to be swallowed (try/finally without catch):
  // the button snapped back to idle and the edit silently was not saved.
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string> = {};
      if (content.trim() !== evt.content) patch.content = content.trim();
      if (type !== evt.type) patch.type = type;
      if (date !== evt.created_at.slice(0, 10)) {
        patch.created_at = date + evt.created_at.slice(10);
      }
      if (Object.keys(patch).length > 0) {
        await updateEvent(evt.id, patch);
        await onMutate();
      }
      setEditing(false);
    } catch (e) {
      setError(`Uložení selhalo: ${displayError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    setSaving(true);
    setError(null);
    try {
      await archiveEvent(evt.id);
      await onMutate();
    } catch (e) {
      setError(`Archivace selhala: ${displayError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const resolve = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateEvent(evt.id, { status: "resolved" });
      await onMutate();
    } catch (e) {
      setError(`Označení selhalo: ${displayError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const errorLine = error && (
    <div className="mt-1.5 text-[12px]" style={{ color: "var(--color-danger)" }}>
      {error}
    </div>
  );

  if (editing) {
    return (
      <div className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-surface)] px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger size="sm" className="font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DatePicker value={date} onChange={setDate} />
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              setContent(evt.content);
              setType(evt.type);
              setDate(evt.created_at.slice(0, 10));
            }}
            className="text-muted-foreground"
          >
            Zrušit
          </Button>
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          className="leading-relaxed"
        />
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" onClick={save} disabled={saving || !content.trim()}>
            {saving ? "Ukládám..." : "Uložit"}
          </Button>
        </div>
        {errorLine}
      </div>
    );
  }

  const resolved = evt.status === "resolved";

  return (
    <div
      className={`group rounded-md border px-3 py-2 ${
        resolved
          ? "border-[var(--color-border)]/60 bg-[var(--color-surface)]/40"
          : "border-[var(--color-border)] bg-[var(--color-surface)]"
      }`}
    >
      <div className="mb-0.5 flex items-center gap-2">
        <span
          className={`font-mono text-[12px] uppercase tracking-wider ${
            resolved ? "text-[var(--color-text-dim)]" : "text-[var(--color-accent)]"
          }`}
        >
          {evt.type}
        </span>
        {resolved && (
          <Badge variant="secondary" className="bg-[var(--color-surface-2)] text-[var(--color-text-dim)]">
            <Check />
            vyřešeno
          </Badge>
        )}
        {evt.status !== "active" && !resolved && (
          <Badge variant="secondary" className="bg-[var(--color-surface-2)] text-[var(--color-text-dim)]">
            {evt.status}
          </Badge>
        )}
        <span className="flex-1" />
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {evt.status === "active" && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={resolve}
              disabled={busy || saving}
              title="Označit jako vyřešené"
              className="text-muted-foreground hover:text-[var(--color-accent)]"
            >
              <Check />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setEditing(true)}
            disabled={busy || saving}
            title="Upravit"
            className="text-muted-foreground"
          >
            <Pencil />
          </Button>
          <Button
            variant="destructive"
            size="icon-xs"
            onClick={archive}
            disabled={busy || saving}
            title="Archivovat"
          >
            <Trash2 />
          </Button>
        </span>
      </div>
      <div
        className={`text-[13.5px] leading-relaxed ${
          resolved ? "text-[var(--color-text-dim)]" : "text-[var(--color-text-muted)]"
        }`}
      >
        {evt.content}
      </div>
      {errorLine}
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
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="mt-3">
        <Plus />
        Přidat událost
      </Button>
    );
  }

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createEvent({ node_id: nodeId, type, content: content.trim() });
      await onMutate();
      setOpen(false);
      setContent("");
      setType("note");
    } catch (e) {
      setError(`Událost se nepodařilo přidat: ${displayError(e)}`);
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
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            setOpen(false);
            setContent("");
          }}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <Select value={type} onValueChange={setType}>
        <SelectTrigger className="mb-2 w-full font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EVENT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{t}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Co se stalo?"
        rows={3}
        className="leading-relaxed"
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={submit} disabled={!content.trim() || submitting || disabled}>
          {submitting ? "Přidávám..." : "Přidat událost"}
        </Button>
      </div>
      {error && (
        <div className="mt-1.5 text-[12px]" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
