// The server's i18next instance: the central server, the sync agent and a
// personal workspace's server all run this same module. Every language is
// bundled and init completes synchronously; interpolated values are
// HTML-escaped because the server renders pages. The instance's language is
// never changed: a request's text comes from getFixedT(locale, ns), so two
// concurrent requests in different languages never see each other's.

import type { TFunction } from "i18next";
import { DEFAULT_LOCALE, type Locale, type Namespace } from "./config.js";
import { createI18n } from "./create.js";
import { RESOURCES } from "./resources.js";

const { i18n } = createI18n({
  lng: DEFAULT_LOCALE,
  resources: RESOURCES,
  escapeValue: true,
  initAsync: false,
});

export const serverI18n = i18n;

export function getFixedT<N extends Namespace>(locale: Locale, ns: N): TFunction<N> {
  return i18n.getFixedT(locale, ns);
}
