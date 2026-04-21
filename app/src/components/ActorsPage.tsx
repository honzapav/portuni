import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, X, Users, Search } from "lucide-react";
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
    const ok = window.confirm(
      `Opravdu smazat aktéra „${actor.name}“?\n\nTato akce je nevratná. Budou smazána i všechna přiřazení k úlohám.`,
    );
    if (!ok) return;
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
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)]"
          >
            <Plus size={13} />
            Přidat aktéra
          </button>
        </div>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Hledat aktéry..."
              className="w-[240px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1.5 pl-8 pr-3 text-[13.5px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] focus:outline-none"
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
          <div
            className="mx-6 mt-4 rounded-md border px-3 py-2 text-[11.5px]"
            style={{
              color: "var(--color-danger)",
              borderColor: "var(--color-danger-border)",
              background: "var(--color-danger-bg)",
            }}
          >
            {error}
          </div>
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
                    <button
                      onClick={() => openEdit(a)}
                      className="text-left font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                    >
                      {a.name}
                    </button>
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
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        title="Smazat"
                        onClick={() => handleDelete(a)}
                        danger
                      >
                        <Trash2 size={12} />
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
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13.5px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
    <span
      className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
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
    <button
      onClick={onClick}
      title={title}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors ${
        danger
          ? "text-[var(--color-text-muted)] hover:border-[var(--color-danger-border)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)]"
          : "text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="flex-1 text-[14px] font-semibold tracking-tight text-[var(--color-text)]">
            {isEdit ? "Upravit aktéra" : "Nový aktér"}
          </h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
            title="Zavřít"
          >
            <X size={13} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4">
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

            <Field label="Jméno" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] focus:outline-none"
                placeholder={
                  type === "person" ? "Jan Novák" : "Denní report z CRM"
                }
              />
            </Field>

            <Field label="Placeholder">
              <label
                className={`inline-flex items-center gap-2 text-[13.5px] ${
                  type === "automation"
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer"
                } text-[var(--color-text-muted)]`}
              >
                <input
                  type="checkbox"
                  checked={isPlaceholder}
                  onChange={(e) => setIsPlaceholder(e.target.checked)}
                  disabled={type === "automation"}
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                Zástupná osoba (bude nahrazena reálnou)
              </label>
              {type === "automation" && (
                <FieldHint>Automatizace nemůže být placeholder.</FieldHint>
              )}
            </Field>

            {type === "person" && !isPlaceholder && (
              <Field label="Uživatelský účet">
                <select
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  disabled={users === null && !usersError}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] text-[var(--color-text)] focus:border-[var(--color-accent-dim)] focus:outline-none disabled:opacity-60"
                >
                  <option value="">— Nepropojeno —</option>
                  {users?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                  {userId && !users?.some((u) => u.id === userId) && (
                    <option value={userId}>{userId} (neznámý)</option>
                  )}
                </select>
                {usersError ? (
                  <FieldHint>Nepodařilo se načíst uživatele: {usersError}</FieldHint>
                ) : users === null ? (
                  <FieldHint>Načítám uživatele…</FieldHint>
                ) : users.length === 0 ? (
                  <FieldHint>Žádní registrovaní uživatelé k dispozici.</FieldHint>
                ) : null}
              </Field>
            )}

            <Field label="Poznámky">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[14px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-dim)] focus:border-[var(--color-accent-dim)] focus:outline-none"
                placeholder="Interní poznámky..."
              />
            </Field>
          </div>

          {formError && (
            <div
              className="mt-4 rounded-md border px-3 py-2 text-[11.5px]"
              style={{
                color: "var(--color-danger)",
                borderColor: "var(--color-danger-border)",
                background: "var(--color-danger-bg)",
              }}
            >
              {formError}
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)] disabled:opacity-50"
            >
              {saving ? "Ukládám..." : isEdit ? "Uložit změny" : "Vytvořit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[13.5px] font-semibold uppercase tracking-widest text-[var(--color-text-dim)]">
        {label}
        {required && <span className="ml-1 text-[var(--color-danger)]">*</span>}
      </label>
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
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`flex-1 rounded-md border px-3 py-1.5 text-[13.5px] transition-colors ${
        checked
          ? "border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      {label}
    </button>
  );
}
