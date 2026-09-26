// Which language the web boots in, before /me has answered (spec: Locale
// resolution). Order: this window's cache -> the OS language
// (navigator.languages, first supported primary subtag) -> English. The
// account's users.locale overrides it once /me is back. Pure, so the root
// test suite covers it.

import {
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  type Locale,
  type UiLocale,
  firstSupportedLocale,
  isLocale,
  toSupportedLocale,
} from "../../../server/shared/i18n/config";
import { scopedKey, type StorageLike } from "./workspace-storage";

// localStorage key of the window cache: "portuni:<ws_id>:locale". Per
// window, because each workspace window can belong to another account.
export const LOCALE_STORAGE_KEY = "locale";

export interface BootLocaleInput {
  cached: string | null;
  navigatorLanguages: readonly string[] | null | undefined;
  // Dev builds only: "pseudo" in the cache is honoured.
  allowPseudo: boolean;
}

export function resolveBootLocale(input: BootLocaleInput): UiLocale {
  if (input.allowPseudo && input.cached === PSEUDO_LOCALE) return PSEUDO_LOCALE;
  return (
    toSupportedLocale(input.cached) ??
    firstSupportedLocale(input.navigatorLanguages) ??
    DEFAULT_LOCALE
  );
}

export function readCachedLocale(storage: Pick<StorageLike, "getItem">): string | null {
  try {
    return storage.getItem(scopedKey(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeCachedLocale(storage: Pick<StorageLike, "setItem">, locale: UiLocale): void {
  try {
    storage.setItem(scopedKey(LOCALE_STORAGE_KEY), locale);
  } catch {
    // Storage full or blocked: the language still applies to this window.
  }
}

export interface AccountLocaleInput {
  // users.locale from GET /me; null when the account never chose one.
  account: string | null | undefined;
  // This window's cache and the language i18next currently runs in.
  cached: string | null;
  current: string;
  // Dev builds only: a cached pseudo is a local override the account
  // (which only ever holds en/cs) does not replace.
  allowPseudo: boolean;
}

// The language to switch to once /me has answered, or null to keep the
// resolved one (spec: Locale resolution). A null or unknown account value
// keeps the resolved language and is never written back to the account.
export function accountLocaleSwitch(input: AccountLocaleInput): Locale | null {
  if (!isLocale(input.account)) return null;
  if (input.allowPseudo && input.cached === PSEUDO_LOCALE) return null;
  if (input.account === input.cached && input.account === input.current) return null;
  return input.account;
}

// The locale a session request carries (POST /sessions, a message, Předat,
// Pokračovat v nové session): the UI language when it is a catalog
// language, else English (the dev pseudo-locale included).
export function toRequestLocale(language: string | null | undefined): Locale {
  return isLocale(language) ? language : DEFAULT_LOCALE;
}

// Where requestLocale() reads the UI language from. i18n.ts points it at
// its i18next instance; api.ts and sessions-client.ts read it through
// requestLocale() so they stay importable from the root test suite
// without loading i18next.
let languageSource: () => string | null | undefined = () => null;

export function setRequestLanguageSource(source: () => string | null | undefined): void {
  languageSource = source;
}

export function requestLocale(): Locale {
  return toRequestLocale(languageSource());
}
