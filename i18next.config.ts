// i18next-cli: extraction, lint, status and key types for the shared catalog
// in apps/server/shared/i18n (spec:
// docs/superpowers/specs/2026-09-25-localization-design.md, "Tooling and the
// gate"). `npm run i18n:check` runs the gate's part of it.
import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en", "cs"],
  extract: {
    input: [
      "apps/web/src/**/*.{ts,tsx}",
      "apps/server/**/*.ts",
      // The foundation's sample keys (#528) are read by the catalog tests
      // until the namespaces get real texts.
      "test/i18n-*.test.ts",
    ],
    ignore: ["apps/server/shared/i18n/types/**", "**/*.d.ts"],
    output: "apps/server/shared/i18n/locales/{{language}}/{{namespace}}.json",
    primaryLanguage: "en",
    defaultNS: "common",
    keySeparator: ".",
    nsSeparator: ":",
    contextSeparator: "_",
    pluralSeparator: "_",
    functions: ["t", "*.t"],
    transComponents: ["Trans"],
    useTranslationNames: [
      "useTranslation",
      { name: "getFixedT", nsArg: 1, keyPrefixArg: 2 },
    ],
    // The desktop shell reads its namespace from Rust (embedded JSON); no
    // TypeScript source uses those keys.
    preservePatterns: ["desktop:*"],
    extractFromComments: false,
    sort: true,
    indentation: 2,
  },
  lint: {
    checkConcatenation: "error",
  },
  types: {
    input: ["apps/server/shared/i18n/locales/en/*.json"],
    output: "apps/server/shared/i18n/types/i18next.d.ts",
    resourcesFile: "apps/server/shared/i18n/types/resources.d.ts",
    enableSelector: "optimize",
  },
});
