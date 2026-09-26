// The web's i18next instance (spec: Library and configuration, Locale
// resolution). English `common` is bundled into the main chunk; every other
// namespace and language is a dynamic import() loaded on demand. bootI18n()
// runs in main.tsx before createRoot, so no text renders before the boot
// language's `common` and `errors` are in.

import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";
import {
  BOOT_NAMESPACES,
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  type Namespace,
  type UiLocale,
} from "../../server/shared/i18n/config";
import { createI18n } from "../../server/shared/i18n/create";
import enCommon from "../../server/shared/i18n/locales/en/common.json";
import {
  accountLocaleSwitch,
  readCachedLocale,
  resolveBootLocale,
  setRequestLanguageSource,
  writeCachedLocale,
} from "./lib/locale";

// Every catalog file the web may load, one chunk each. `server` and
// `desktop` never reach the web; en/common is bundled above.
const CATALOG_DIR = "../../server/shared/i18n/locales";
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>([
  "../../server/shared/i18n/locales/*/*.json",
  "!../../server/shared/i18n/locales/*/server.json",
  "!../../server/shared/i18n/locales/*/desktop.json",
  "!../../server/shared/i18n/locales/en/common.json",
]);

// The pseudo-locale is the English catalog run through the pseudo
// postProcessor.
function catalogLanguage(lng: string): string {
  return lng === PSEUDO_LOCALE ? DEFAULT_LOCALE : lng;
}

async function loadCatalog(lng: string, ns: string): Promise<Record<string, unknown>> {
  const dir = catalogLanguage(lng);
  if (dir === DEFAULT_LOCALE && ns === "common") return enCommon;
  const load = catalogs[`${CATALOG_DIR}/${dir}/${ns}.json`];
  if (!load) throw new Error(`no catalog for ${lng}/${ns}`);
  return (await load()).default;
}

export const PSEUDO_ENABLED = import.meta.env.DEV;

const bootLocale: UiLocale = resolveBootLocale({
  cached: readCachedLocale(window.localStorage),
  navigatorLanguages: navigator.languages,
  allowPseudo: PSEUDO_ENABLED,
});

const created = createI18n({
  lng: bootLocale,
  resources: { en: { common: enCommon } },
  modules: [resourcesToBackend(loadCatalog), initReactI18next],
  escapeValue: false,
  initAsync: true,
  pseudo: PSEUDO_ENABLED,
  extra: {
    partialBundledLanguages: true,
    react: { useSuspense: false, bindI18nStore: "added" },
  },
});

export const i18n = created.i18n;

setRequestLanguageSource(() => i18n.language);

function setHtmlLang(locale: string): void {
  document.documentElement.lang = locale === PSEUDO_LOCALE ? DEFAULT_LOCALE : locale;
}

// Switches this window's UI language: the window cache, i18next (no
// reload) and <html lang>. Writing the account (PATCH /me) is the
// caller's business; this never touches it.
export async function applyUiLocale(locale: UiLocale): Promise<void> {
  writeCachedLocale(window.localStorage, locale);
  if (i18n.language !== locale) await i18n.changeLanguage(locale);
  setHtmlLang(locale);
}

// After /me answers: the account's language wins over the boot guess.
export async function syncAccountLocale(account: string | null | undefined): Promise<void> {
  const target = accountLocaleSwitch({
    account,
    cached: readCachedLocale(window.localStorage),
    current: i18n.language,
    allowPseudo: PSEUDO_ENABLED,
  });
  if (target) await applyUiLocale(target);
}

// Waits for init, loads the boot language's boot namespaces (and English as
// the fallback) and sets <html lang>. main.tsx awaits this before
// createRoot.
export async function bootI18n(): Promise<UiLocale> {
  await created.ready;
  await i18n.loadNamespaces([...BOOT_NAMESPACES]);
  setHtmlLang(bootLocale);
  // The desktop shell follows the UI language (native menu, sign-in pages).
  if ("__TAURI_INTERNALS__" in window) {
    void import("./lib/desktop-locale")
      .then((m) => m.startDesktopLocaleSync(i18n))
      .catch((e: unknown) => console.error("[i18n] desktop locale sync failed to load:", e));
  }
  return bootLocale;
}

// A lazy component whose chunk and namespaces load together, so it never
// renders a frame with its keys missing:
//   const GraphView = lazyWithNamespaces(() => import("./components/GraphView"), ["graph"]);
// biome-ignore lint/suspicious/noExplicitAny: the same constraint React.lazy puts on T
export function lazyWithNamespaces<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  namespaces: readonly Namespace[],
): LazyExoticComponent<T> {
  return lazy<T>(async () => {
    const [module] = await Promise.all([load(), i18n.loadNamespaces([...namespaces])]);
    return module;
  });
}

// Dev: an edited catalog file is pushed by the portuni-i18n-hmr Vite plugin
// (vite.config.ts) and swapped in place, without a page reload.
if (import.meta.hot) {
  import.meta.hot.on(
    "portuni:i18n-update",
    (update: { lng: string; ns: string; resources: Record<string, unknown> }) => {
      const targets = [update.lng];
      if (update.lng === DEFAULT_LOCALE) targets.push(PSEUDO_LOCALE);
      for (const lng of targets) {
        if (!i18n.hasResourceBundle(lng, update.ns)) continue;
        i18n.removeResourceBundle(lng, update.ns);
        i18n.addResourceBundle(lng, update.ns, update.resources);
      }
    },
  );
}
