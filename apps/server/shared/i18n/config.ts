// The i18n constants every instance shares (web, central server, sync agent):
// the languages the catalog carries, the namespaces it is split into, and how
// a raw language tag (an account setting, a window cache, navigator.languages)
// resolves to one of them. Pure: no i18next import, so the web's boot and the
// root test suite read it without loading the library.

export const LOCALES = ["en", "cs"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Dev-only language: every message goes through the pseudo postProcessor
// (pseudo.ts) over the English catalog. Never offered by a production build.
export const PSEUDO_LOCALE = "pseudo";
export type UiLocale = Locale | typeof PSEUDO_LOCALE;

// Namespaces follow the web's lazy chunks (spec: Catalog). `common` and
// `errors` load at boot; `server` and `desktop` never reach the web.
export const NAMESPACES = [
  "common",
  "node",
  "files",
  "chat",
  "graph",
  "settings",
  "errors",
  "server",
  "desktop",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NS: Namespace = "common";
export const BOOT_NAMESPACES = ["common", "errors"] as const satisfies readonly Namespace[];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

// "cs-CZ" -> "cs", "EN_us" -> "en", "de" -> null. Matches on the primary
// subtag only; the catalog has no regional variants.
export function toSupportedLocale(tag: string | null | undefined): Locale | null {
  if (typeof tag !== "string") return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}

// The first supported language in an ordered preference list
// (navigator.languages, an Accept-Language header already split), else null.
export function firstSupportedLocale(tags: readonly string[] | null | undefined): Locale | null {
  for (const tag of tags ?? []) {
    const locale = toSupportedLocale(tag);
    if (locale) return locale;
  }
  return null;
}
