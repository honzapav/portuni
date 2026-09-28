// Pure event-list helpers. No React/DOM, so the node-test runner can cover
// them headlessly (same rationale as lib/sessions.ts).
import type { DetailEvent } from "../types";
import { parseServerTimestamp } from "./format";

// `date` is the user's local day as YYYY-MM-DD (the group key and the
// DatePicker's value); `day` is that day's local midnight, for formatDate.
export type EventDateGroup = { date: string; day: Date; events: DetailEvent[] };

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// The local day (YYYY-MM-DD) a server timestamp falls on. The server's
// "YYYY-MM-DD HH:MM:SS" is UTC, so its first ten characters are the UTC day,
// not the user's (#529). An unparseable value falls back to its prefix.
export function localDayOf(createdAt: string): string {
  const d = parseServerTimestamp(createdAt);
  if (!d) return createdAt.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMidnight(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// The event's timestamp moved onto another local day, keeping its local
// time of day, back in the server's UTC "YYYY-MM-DD HH:MM:SS" form.
export function moveToLocalDay(createdAt: string, day: string): string {
  const src = parseServerTimestamp(createdAt);
  const [y, m, d] = day.split("-").map(Number);
  const next = src
    ? new Date(y, m - 1, d, src.getHours(), src.getMinutes(), src.getSeconds())
    : new Date(y, m - 1, d);
  return next.toISOString().slice(0, 19).replace("T", " ");
}

// Group events under their local date, preserving the incoming order. The
// backend returns events created_at DESC, so all same-day events are
// already consecutive: groups and the events within them stay newest-first.
// (ukol 3: "Udalosti se musi radit pod termin".)
export function groupEventsByDate(events: DetailEvent[]): EventDateGroup[] {
  const groups: EventDateGroup[] = [];
  for (const evt of events) {
    const date = localDayOf(evt.created_at);
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.events.push(evt);
    } else {
      groups.push({ date, day: localMidnight(date), events: [evt] });
    }
  }
  return groups;
}
