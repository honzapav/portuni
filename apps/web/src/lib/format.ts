// Every value that stands alone in the UI (a table cell, a chip, the date
// picker) is formatted here, in the UI language (spec: Formatting). Values
// inside a sentence use i18next's formatters instead. Each function takes
// the locale and caches its Intl instance per locale and options, so a list
// of a thousand rows builds one formatter, not a thousand. Pure, so the
// root test suite covers it.

import { DEFAULT_LOCALE, toSupportedLocale } from "../../../server/shared/i18n/config";

// The Intl locale for a UI locale: "pseudo" (dev) and anything unknown
// format as English.
function intlLocale(locale: string): string {
  return toSupportedLocale(locale) ?? DEFAULT_LOCALE;
}

function cached<T>(cache: Map<string, T>, key: string, build: () => T): T {
  let value = cache.get(key);
  if (value === undefined) {
    value = build();
    cache.set(key, value);
  }
  return value;
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const lng = intlLocale(locale);
  return cached(dateTimeFormats, `${lng}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(lng, options));
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const lng = intlLocale(locale);
  return cached(numberFormats, `${lng}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(lng, options));
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
function relativeFormat(locale: string): Intl.RelativeTimeFormat {
  const lng = intlLocale(locale);
  return cached(relativeFormats, lng, () => new Intl.RelativeTimeFormat(lng, { numeric: "auto" }));
}

const collators = new Map<string, Intl.Collator>();
function collator(locale: string): Intl.Collator {
  const lng = intlLocale(locale);
  return cached(collators, lng, () => new Intl.Collator(lng));
}

const SERVER_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

// The one parser for a server timestamp. The server returns
// "YYYY-MM-DD HH:MM:SS" in UTC without a zone marker on every driver;
// Date would read that as local time, so it is normalised to UTC first.
// Full ISO strings (with "T" and a zone) pass through. null for anything
// unparseable.
export function parseServerTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = SERVER_TIMESTAMP.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type DateInput = string | number | Date;

function toDate(value: DateInput): Date | null {
  if (typeof value === "string") return parseServerTimestamp(value);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE, hour: "2-digit", minute: "2-digit" };

// A date alone. An unparseable string is shown as it came.
export function formatDate(locale: string, value: DateInput, options: Intl.DateTimeFormatOptions = DATE): string {
  const date = toDate(value);
  if (!date) return String(value);
  return dateTimeFormat(locale, options).format(date);
}

// A date with hours and minutes. An unparseable string is shown as it came.
export function formatDateTime(locale: string, value: DateInput): string {
  return formatDate(locale, value, DATE_TIME);
}

// "2 minutes ago" / "in 5 minutes" / "před 2 minutami". Under a minute it
// reads "now": callers refresh on a minute tick, so anything finer is noise.
export function formatRelative(locale: string, fromMs: number, nowMs: number): string {
  const deltaS = Math.round((fromMs - nowMs) / 1000);
  const s = Math.abs(deltaS);
  const sign = deltaS < 0 ? -1 : 1;
  const rtf = relativeFormat(locale);
  if (s < 60) return rtf.format(0, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return rtf.format(sign * m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(sign * h, "hour");
  return rtf.format(sign * Math.floor(h / 24), "day");
}

export function formatNumber(locale: string, n: number, options: Intl.NumberFormatOptions = {}): string {
  return numberFormat(locale, options).format(n);
}

// A compact token count: 950, 12.3 k (12,3 k in Czech), 200 k.
export function formatTokens(locale: string, n: number): string {
  if (n < 1000) return formatNumber(locale, n);
  const k = n / 1000;
  return `${formatNumber(locale, k, { maximumFractionDigits: k >= 100 ? 0 : 1 })} k`;
}

// Sorting of names shown to the user, by the UI language's rules ("ch"
// comes after "h" in Czech). Use as `.sort((a, b) => compareText(locale, a, b))`.
export function compareText(locale: string, a: string, b: string): number {
  return collator(locale).compare(a, b);
}

// The first day of the week, 1 = Monday ... 7 = Sunday, from
// Intl.Locale#getWeekInfo where the runtime has it (older engines expose a
// `weekInfo` accessor, some neither). Fallback: Monday for Czech, Sunday
// for English.
export function weekInfo(locale: string): { firstDay: number } {
  const lng = intlLocale(locale);
  const intl = new Intl.Locale(lng) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const info = typeof intl.getWeekInfo === "function" ? intl.getWeekInfo() : intl.weekInfo;
  if (info && Number.isInteger(info.firstDay)) return { firstDay: info.firstDay };
  return { firstDay: lng === "cs" ? 1 : 7 };
}

// "September 2026" / "září 2026": the date picker's heading.
export function formatMonthYear(locale: string, year: number, month: number): string {
  return dateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, month, 1));
}

// Short weekday names in display order, starting at weekInfo's first day.
export function weekdayNames(locale: string): string[] {
  const first = weekInfo(locale).firstDay;
  const format = dateTimeFormat(locale, { weekday: "short" });
  // 2024-01-01 is a Monday (ISO day 1).
  return Array.from({ length: 7 }, (_, i) => {
    const isoDay = ((first - 1 + i) % 7) + 1;
    return format.format(new Date(2024, 0, isoDay));
  });
}
