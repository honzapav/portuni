// createI18n(): the one place an i18next instance is configured, for the web
// (async, lazy namespaces, React escapes) and for the server (sync, every
// language bundled, i18next escapes). Everything the two must agree on --
// languages, separators, fallbacks, empty/null handling, the pseudo-locale --
// is fixed here; the caller only picks what differs by runtime.

import i18next, {
  type i18n as I18nInstance,
  type InitOptions,
  type Module,
  type Resource,
} from "i18next";
import { DEFAULT_LOCALE, DEFAULT_NS, LOCALES, PSEUDO_LOCALE } from "./config.js";
import { pseudoPostProcessor } from "./pseudo.js";

export interface CreateI18nOptions {
  // Language to start in. The server passes none and never changes it: its
  // call sites take getFixedT(locale, ns).
  lng?: string;
  // Bundled resources (server: all of them; web: en/common only).
  resources: Resource;
  // Extra i18next modules: the web's resources-to-backend and
  // initReactI18next. The server passes none.
  modules?: Module[];
  // true: interpolated values are HTML-escaped (server-rendered pages);
  // false: React escapes (web).
  escapeValue: boolean;
  // false: init() completes synchronously (server, tests).
  initAsync: boolean;
  // Only a web dev build turns this on; it adds "pseudo" as a language.
  pseudo?: boolean;
  // Extra init options on top of the shared ones (the web's react block and
  // partialBundledLanguages).
  extra?: Partial<InitOptions>;
}

export function createI18n(options: CreateI18nOptions): {
  i18n: I18nInstance;
  ready: Promise<unknown>;
} {
  const i18n = i18next.createInstance();
  for (const module of options.modules ?? []) i18n.use(module);
  if (options.pseudo) i18n.use(pseudoPostProcessor);

  const supportedLngs: string[] = [...LOCALES];
  if (options.pseudo) supportedLngs.push(PSEUDO_LOCALE);

  const ready = i18n.init({
    lng: options.lng ?? DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs,
    nonExplicitSupportedLngs: false,
    load: "languageOnly",
    ns: [DEFAULT_NS],
    defaultNS: DEFAULT_NS,
    fallbackNS: false,
    resources: options.resources,
    initAsync: options.initAsync,
    keySeparator: ".",
    nsSeparator: ":",
    returnEmptyString: false,
    returnNull: false,
    interpolation: { escapeValue: options.escapeValue },
    postProcess: options.pseudo ? ["pseudo"] : false,
    ...options.extra,
  });

  return { i18n, ready };
}
