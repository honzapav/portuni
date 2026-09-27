// Key types for every i18next instance (web and server). Generated once by
// `i18next-cli types` and kept by hand from then on; resources.d.ts next to
// it is regenerated from the English catalog (`npm run i18n:types`).
// Selector form only: t(($) => $.composer.send).
import type Resources from "./resources.js";

declare module "i18next" {
  interface CustomTypeOptions {
    enableSelector: "optimize";
    defaultNS: "common";
    resources: Resources;
  }
}
