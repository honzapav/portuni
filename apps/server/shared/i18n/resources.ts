// Every catalog file, bundled. Server only: the web bundles en/common and
// loads the rest on demand (apps/web/src/i18n.ts), so it never imports this.

import type { Resource } from "i18next";
import csChat from "./locales/cs/chat.json" with { type: "json" };
import csCommon from "./locales/cs/common.json" with { type: "json" };
import csDesktop from "./locales/cs/desktop.json" with { type: "json" };
import csErrors from "./locales/cs/errors.json" with { type: "json" };
import csFiles from "./locales/cs/files.json" with { type: "json" };
import csGraph from "./locales/cs/graph.json" with { type: "json" };
import csNode from "./locales/cs/node.json" with { type: "json" };
import csServer from "./locales/cs/server.json" with { type: "json" };
import csSettings from "./locales/cs/settings.json" with { type: "json" };
import enChat from "./locales/en/chat.json" with { type: "json" };
import enCommon from "./locales/en/common.json" with { type: "json" };
import enDesktop from "./locales/en/desktop.json" with { type: "json" };
import enErrors from "./locales/en/errors.json" with { type: "json" };
import enFiles from "./locales/en/files.json" with { type: "json" };
import enGraph from "./locales/en/graph.json" with { type: "json" };
import enNode from "./locales/en/node.json" with { type: "json" };
import enServer from "./locales/en/server.json" with { type: "json" };
import enSettings from "./locales/en/settings.json" with { type: "json" };
import type { Locale, Namespace } from "./config.js";

export const RESOURCES = {
  en: {
    common: enCommon,
    node: enNode,
    files: enFiles,
    chat: enChat,
    graph: enGraph,
    settings: enSettings,
    errors: enErrors,
    server: enServer,
    desktop: enDesktop,
  },
  cs: {
    common: csCommon,
    node: csNode,
    files: csFiles,
    chat: csChat,
    graph: csGraph,
    settings: csSettings,
    errors: csErrors,
    server: csServer,
    desktop: csDesktop,
  },
} satisfies Record<Locale, Record<Namespace, unknown>> & Resource;
