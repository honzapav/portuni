// Pure event-list helpers. No React/DOM, so the node-test runner can cover
// them headlessly (same rationale as lib/sessions.ts).
import type { DetailEvent } from "../types";

export type EventDateGroup = { date: string; events: DetailEvent[] };

// Group events under their date (created_at's YYYY-MM-DD), preserving the
// incoming order. The backend returns events created_at DESC, so all
// same-day events are already consecutive: groups and the events within
// them stay newest-first. (ukol 3: "Udalosti se musi radit pod termin".)
export function groupEventsByDate(events: DetailEvent[]): EventDateGroup[] {
  const groups: EventDateGroup[] = [];
  for (const evt of events) {
    const date = evt.created_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.events.push(evt);
    } else {
      groups.push({ date, events: [evt] });
    }
  }
  return groups;
}
