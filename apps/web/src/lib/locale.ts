// Which language the web boots in, before /me has answered (spec: Locale
// resolution). Order: this window's cache -> the OS language
// (navigator.languages, first supported primary subtag) -> English. The
// account's users.locale overrides it once /me is back. Pure, so the root
// test suite covers it.

import {
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  type UiLocale,
  firstSupportedLocale,
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
