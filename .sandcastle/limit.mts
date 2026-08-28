// Detekce usage/rate limitu ve výstupu Claude Code a výpočet čekání do resetu.
// Přesný tvar hlášky se mezi verzemi CLI liší, proto víc vzorů + fallback
// (volající při null čeká fixních 30 minut a zkouší znovu).

const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /limit reached/i,
  /limit will reset/i,
  /session limit/i,
  // Reálná hláška CLI: "You've hit your session limit · resets 11:30pm (UTC)" – bez „at"
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2}|\s*(?:am|pm))/i,
  /overloaded/i,
  /\b429\b/,
];

export function isLimitError(text: string): boolean {
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

const MAX_WAIT_MS = 6 * 3_600_000;
const BUFFER_MS = 5 * 60_000;

export function parseResetWaitMs(text: string, now: Date = new Date()): number | null {
  // Formát "usage limit reached|<unix timestamp>"
  const tsMatch = text.match(/limit reached\|(\d{9,12})/i);
  if (tsMatch) {
    const target = Number(tsMatch[1]) * 1000;
    const wait = target - now.getTime();
    if (wait > 0) return Math.min(wait + BUFFER_MS, MAX_WAIT_MS);
  }

  // Formát "resets at 14:00" / "reset at 4pm" / "resets at 4:30pm"
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  const target = new Date(now);
  // Hláška typu "resets 11:30pm (UTC)" udává čas v UTC, ne v lokální zóně –
  // bez tohohle větvení by se target počítal v lokálním čase a čekání by
  // mohlo skončit hodiny před/po skutečném resetu.
  if (/\(utc\)/i.test(text)) {
    target.setUTCHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  } else {
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  }
  return Math.min(target.getTime() - now.getTime() + BUFFER_MS, MAX_WAIT_MS);
}
