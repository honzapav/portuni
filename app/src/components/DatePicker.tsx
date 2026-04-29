import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const MONTHS_CS = [
  "leden", "únor", "březen", "duben", "květen", "červen",
  "červenec", "srpen", "září", "říjen", "listopad", "prosinec",
];
const WEEKDAYS_CS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatCzech(s: string): string {
  const d = parseIso(s);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
}

function isoEq(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function DatePicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseIso(value);
  const [viewYear, setViewYear] = useState(selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected.getMonth());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setViewYear(selected.getFullYear());
      setViewMonth(selected.getMonth());
    }
  }, [open, value]);

  const today = new Date();
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const leading = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = leading; i > 0; i--) {
    cells.push({ date: new Date(viewYear, viewMonth, 1 - i), inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(viewYear, viewMonth, d), inMonth: true });
  }
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), inMonth: false });
  }

  const stepMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[12.5px] text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
      >
        {formatCzech(value)}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-30 mt-1 w-[230px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg">
          <div className="mb-1.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => stepMonth(-1)}
              className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              aria-label="Předchozí měsíc"
            >
              <ChevronLeft size={12} />
            </button>
            <div className="font-mono text-[12px] uppercase tracking-wider text-[var(--color-text-muted)]">
              {MONTHS_CS[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={() => stepMonth(1)}
              className="rounded p-1 text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              aria-label="Další měsíc"
            >
              <ChevronRight size={12} />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {WEEKDAYS_CS.map((w) => (
              <div
                key={w}
                className="py-0.5 text-center font-mono text-[10.5px] uppercase tracking-wider text-[var(--color-text-dim)]"
              >
                {w}
              </div>
            ))}
            {cells.map(({ date, inMonth }, i) => {
              const isSelected = isoEq(date, selected);
              const isToday = isoEq(date, today);
              const base = "h-6 rounded text-[12px] font-mono transition-colors";
              const tone = isSelected
                ? "bg-[var(--color-accent-dim)] text-[var(--color-bg)]"
                : isToday
                  ? "border border-[var(--color-accent-dim)] text-[var(--color-accent)]"
                  : inMonth
                    ? "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                    : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)]";
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => {
                    onChange(formatIso(date));
                    setOpen(false);
                  }}
                  className={`${base} ${tone}`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
