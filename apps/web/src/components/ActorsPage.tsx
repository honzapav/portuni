import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Users, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchActors,
  fetchUsers,
  createActor,
  updateActor,
  archiveActor,
  type Actor,
  type User,
} from "../api";

type Props = Record<string, never>;

type TypeFilter = "all" | "person" | "automation";
type PlaceholderFilter = "all" | "real" | "placeholder";

// Radix Select refuses an empty-string item value, so "no linked user"
// travels as this sentinel and is mapped back to "" at the call site.
const NO_USER = "__none__";

export default function ActorsPage(_props: Props) {
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [placeholderFilter, setPlaceholderFilter] =
    useState<PlaceholderFilter>("all");
  const [query, setQuery] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Actor | null>(null);

  const loadActors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchActors();
      setActors(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadActors();
  }, [loadActors]);

  const filtered = useMemo(() => {
    if (!actors) return [];
    const q = query.trim().toLowerCase();
    return actors.filter((a) => {
      if (typeFilter !== "all" && a.type !== typeFilter) return false;
      if (placeholderFilter === "real" && a.is_placeholder) return false;
      if (placeholderFilter === "placeholder" && !a.is_placeholder) return false;
      if (q) {
        const hay = `${a.name} ${a.notes ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [actors, typeFilter, placeholderFilter, query]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (actor: Actor) => {
    setEditing(actor);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  const handleDelete = async (actor: Actor) => {
    // window.confirm() is a no-op in the Tauri webview (see d229d84).
    // Archive is reversible at the DB level.
    try {
      await archiveActor(actor.id);
      await loadActors();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-[var(--color-border)] px-6 py-5">
        <div className="flex items-center gap-3">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-md"
            style={{ background: "var(--color-accent-soft)" }}
          >
            <Users size={16} className="text-[var(--color-accent)]" />
          </div>
          <h1 className="flex-1 text-[22px] font-semibold leading-tight tracking-tight text-[var(--color-text)]">
            Aktéři
          </h1>
          <Button onClick={openCreate}>
            <Plus />
            Přidat aktéra
          </Button>
        </div>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Hledat aktéry..."
              aria-label="Hledat aktéry"
              className="w-[240px] pl-8"
            />
          </div>

          <FilterSelect
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as TypeFilter)}
            options={[
              { value: "all", label: "Vše" },
              { value: "person", label: "Lidé" },
              { value: "automation", label: "Automatizace" },
            ]}
          />

          <FilterSelect
            value={placeholderFilter}
            onChange={(v) => setPlaceholderFilter(v as PlaceholderFilter)}
            options={[
              { value: "all", label: "Vše" },
              { value: "real", label: "Reálné" },
              { value: "placeholder", label: "Placeholders" },
            ]}
          />

          <span className="ml-auto text-[14px] text-[var(--color-text-dim)]">
            {filtered.length} / {actors?.length ?? 0}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {error && (
          <Alert variant="destructive" className="mx-6 mt-4 w-auto">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !actors && (
          <div className="flex h-40 items-center justify-center text-[13.5px] text-[var(--color-text-dim)]">
            Načítám aktéry...
          </div>
        )}

        {!loading && actors && filtered.length === 0 && (
          <div className="flex h-40 items-center justify-center text-[13.5px] text-[var(--color-text-dim)]">
            {actors.length === 0
              ? "Zatím žádní aktéři. Přidejte prvního."
              : "Žádní aktéři neodpovídají filtrům."}
          </div>
        )}

        {actors && filtered.length > 0 && (
          <table className="w-full border-separate border-spacing-0 text-[13.5px]">
            <thead className="sticky top-0 z-10 bg-[var(--color-bg)]">
              <tr className="text-left text-[10px] uppercase tracking-widest text-[var(--color-text-dim)]">
                <Th>Jméno</Th>
                <Th>Typ</Th>
                <Th>Stav</Th>
                <Th>Poznámky</Th>
                <Th className="w-[96px] text-right">Akce</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr
                  key={a.id}
                  className="group border-b border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface)]"
                >
                  <Td>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => openEdit(a)}
                      className="-ml-2.5 text-left font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                    >
                      {a.name}
                    </Button>
                  </Td>
                  <Td>
                    <TypeBadge type={a.type} />
                  </Td>
                  <Td>
                    <StatusBadge actor={a} />
                  </Td>
                  <Td>
                    <span className="text-[var(--color-text-muted)]">
                      {truncate(a.notes ?? "", 80) || (
                        <span className="text-[var(--color-text-dim)]">—</span>
                      )}
                    </span>
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <IconButton
                        title="Upravit"
                        onClick={() => openEdit(a)}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        title="Smazat"
                        onClick={() => handleDelete(a)}
                        danger
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <ActorModal
          actor={editing}
          onClose={closeModal}
          onSaved={async () => {
            await loadActors();
            closeModal();
          }}
        />
      )}
    </div>
  );
}

// -- Helper components ------------------------------------------------------

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 font-semibold ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-4 py-2 align-middle ${className ?? ""}`}>{children}</td>
  );
}

function TypeBadge({ type }: { type: "person" | "automation" }) {
  const label = type === "person" ? "Osoba" : "Automatizace";
  const color =
    type === "person" ? "var(--color-accent)" : "var(--color-node-process)";
  return (
    <Badge
      variant="outline"
      className="gap-1.5 font-mono uppercase tracking-widest"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </Badge>
  );
}

function StatusBadge({ actor }: { actor: Actor }) {
  let label: string;
  let color: string;
  if (actor.type === "automation") {
    label = "Automatizace";
    color = "var(--color-node-process)";
  } else if (actor.is_placeholder) {
    label = "Placeholder";
    color = "var(--color-text-dim)";
  } else if (actor.user_id) {
    label = "Registrovaný uživatel";
    color = "var(--color-accent)";
  } else {
    label = "Reálná osoba";
    color = "var(--color-text-muted)";
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[14px]"
      style={{ color }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function IconButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <Button
      variant={danger ? "destructive" : "ghost"}
      size="icon-xs"
      onClick={onClick}
      title={title}
      className={danger ? undefined : "text-muted-foreground"}
    >
      {children}
    </Button>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

// -- Modal ------------------------------------------------------------------

type ActorModalProps = {
  actor: Actor | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

function ActorModal({
  actor,
  onClose,
  onSaved,
}: ActorModalProps) {
  const isEdit = actor !== null;

  const [type, setType] = useState<"person" | "automation">(
    actor?.type ?? "person",
  );
  const [name, setName] = useState(actor?.name ?? "");
  const [isPlaceholder, setIsPlaceholder] = useState(
    actor ? Boolean(actor.is_placeholder) : false,
  );
  const [userId, setUserId] = useState(actor?.user_id ?? "");
  const [notes, setNotes] = useState(actor?.notes ?? "");
  const [users, setUsers] = useState<User[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Enforce: automation cannot be placeholder, cannot have user_id.
  useEffect(() => {
    if (type === "automation") {
      if (isPlaceholder) setIsPlaceholder(false);
      if (userId) setUserId("");
    }
  }, [type, isPlaceholder, userId]);

  // Load users for the user_id dropdown when a real person is being edited.
  useEffect(() => {
    let cancelled = false;
    fetchUsers()
      .then((list) => {
        if (!cancelled) setUsers(list);
      })
      .catch((e) => {
        if (!cancelled) setUsersError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Jméno je povinné.");
      return;
    }

    setSaving(true);
    try {
      if (isEdit && actor) {
        await updateActor(actor.id, {
          name: trimmedName,
          is_placeholder: type === "person" ? isPlaceholder : false,
          user_id:
            type === "person" && !isPlaceholder && userId.trim()
              ? userId.trim()
              : null,
          notes: notes.trim() || null,
        });
      } else {
        await createActor({
          type,
          name: trimmedName,
          is_placeholder: type === "person" ? isPlaceholder : undefined,
          user_id:
            type === "person" && !isPlaceholder && userId.trim()
              ? userId.trim()
              : undefined,
          notes: notes.trim() || undefined,
        });
      }
      await onSaved();
    } catch (err) {
      setFormError(String(err));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Upravit aktéra" : "Nový aktér"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="space-y-4">
            <Field label="Typ" required>
              <div className="flex gap-2">
                <TypeRadio
                  label="Osoba"
                  checked={type === "person"}
                  onChange={() => setType("person")}
                  disabled={isEdit}
                />
                <TypeRadio
                  label="Automatizace"
                  checked={type === "automation"}
                  onChange={() => setType("automation")}
                  disabled={isEdit}
                />
              </div>
              {isEdit && (
                <FieldHint>Typ nelze po vytvoření změnit.</FieldHint>
              )}
            </Field>

            <Field label="Jméno" required htmlFor="actor-name">
              <Input
                id="actor-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder={
                  type === "person" ? "Jan Novák" : "Denní report z CRM"
                }
              />
            </Field>

            <Field label="Placeholder">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="actor-placeholder"
                  checked={isPlaceholder}
                  onCheckedChange={(checked) => setIsPlaceholder(checked === true)}
                  disabled={type === "automation"}
                />
                <Label
                  htmlFor="actor-placeholder"
                  className={`font-normal text-[13.5px] text-[var(--color-text-muted)] ${
                    type === "automation"
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer"
                  }`}
                >
                  Zástupná osoba (bude nahrazena reálnou)
                </Label>
              </div>
              {type === "automation" && (
                <FieldHint>Automatizace nemůže být placeholder.</FieldHint>
              )}
            </Field>

            {type === "person" && !isPlaceholder && (
              <Field label="Uživatelský účet">
                <Select
                  value={userId || NO_USER}
                  onValueChange={(v) => setUserId(v === NO_USER ? "" : v)}
                  disabled={users === null && !usersError}
                >
                  <SelectTrigger className="w-full" aria-label="Uživatelský účet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_USER}>— Nepropojeno —</SelectItem>
                    {users?.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </SelectItem>
                    ))}
                    {userId && !users?.some((u) => u.id === userId) && (
                      <SelectItem value={userId}>{userId} (neznámý)</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {usersError ? (
                  <FieldHint>Nepodařilo se načíst uživatele: {usersError}</FieldHint>
                ) : users === null ? (
                  <FieldHint>Načítám uživatele…</FieldHint>
                ) : users.length === 0 ? (
                  <FieldHint>Žádní registrovaní uživatelé k dispozici.</FieldHint>
                ) : null}
              </Field>
            )}

            <Field label="Poznámky" htmlFor="actor-notes">
              <Textarea
                id="actor-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="resize-y leading-relaxed"
                placeholder="Interní poznámky..."
              />
            </Field>
          </div>

          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Zrušit
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Ukládám..." : isEdit ? "Uložit změny" : "Vytvořit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label
        htmlFor={htmlFor}
        className="mb-1 gap-0 text-[13.5px] font-semibold uppercase tracking-widest text-[var(--color-text-dim)]"
      >
        {label}
        {required && <span className="ml-1 text-[var(--color-danger)]">*</span>}
      </Label>
      {children}
    </div>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 text-[13.5px] text-[var(--color-text-dim)]">
      {children}
    </div>
  );
}

function TypeRadio({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={checked}
      onClick={onChange}
      disabled={disabled}
      className="flex-1 aria-pressed:bg-muted aria-pressed:text-foreground dark:aria-pressed:bg-muted"
    >
      {label}
    </Button>
  );
}
