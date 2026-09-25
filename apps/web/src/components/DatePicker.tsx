import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, formatMonthYear, weekInfo, weekdayNames } from "../lib/format";
import { useLocale } from "../lib/use-locale";

const TRIGGER_DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };

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
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const selected = parseIso(value);
  const [viewYear, setViewYear] = useState(selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected.getMonth());

  useEffect(() => {
    if (!open) {
      setViewYear(selected.getFullYear());
      setViewMonth(selected.getMonth());
    }
  }, [open, value]);

  const today = new Date();
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  // Days shown before the 1st: from the locale's first day of the week
  // (1 = Monday ... 7 = Sunday; Date#getDay has Sunday = 0).
  const leading = (firstOfMonth.getDay() - (weekInfo(locale).firstDay % 7) + 7) % 7;
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={`font-mono ${className ?? ""}`}>
          {formatDate(locale, parseIso(value), TRIGGER_DATE)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[230px] gap-0 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => stepMonth(-1)}
            className="text-muted-foreground"
            aria-label="Předchozí měsíc"
          >
            <ChevronLeft />
          </Button>
          <div className="font-mono text-[12px] uppercase tracking-wider text-[var(--color-text-muted)]">
            {formatMonthYear(locale, viewYear, viewMonth)}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => stepMonth(1)}
            className="text-muted-foreground"
            aria-label="Další měsíc"
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {weekdayNames(locale).map((w) => (
            <div
              key={w}
              className="py-0.5 text-center font-mono text-[10.5px] uppercase tracking-wider text-[var(--color-text-dim)]"
            >
              {w}
            </div>
          ))}
          {cells.map(({ date, inMonth }) => {
            const iso = formatIso(date);
            const isSelected = isoEq(date, selected);
            const isToday = isoEq(date, today);
            const tone = isSelected
              ? "bg-[var(--color-accent-dim)] text-[var(--color-bg)] hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-bg)]"
              : isToday
                ? "border-[var(--color-accent-dim)] text-[var(--color-accent)]"
                : inMonth
                  ? "text-[var(--color-text)]"
                  : "text-muted-foreground";
            return (
              <Button
                variant="ghost"
                size="icon-xs"
                key={iso}
                onClick={() => {
                  onChange(iso);
                  setOpen(false);
                }}
                className={`w-full font-mono ${tone}`}
              >
                {date.getDate()}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
