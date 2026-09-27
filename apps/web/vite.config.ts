import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The backend always requires PORTUNI_AUTH_TOKEN in env mode (#521), so the
// same token must reach it from the frontend. We inject it into the dev
// proxy server-side so the secret never lands in the client bundle. Run
// vite under varlock (or `PORTUNI_AUTH_TOKEN=... vite dev`) for this to
// pick up the value; without it every proxied request is a 401.
const AUTH_TOKEN = (process.env.PORTUNI_AUTH_TOKEN ?? "").trim();

// One warning line when the dev server starts without the token (dev only;
// `vite build` never proxies and does not need it).
const warnMissingAuthToken: Plugin = {
  name: "portuni-warn-missing-auth-token",
  apply: "serve",
  configureServer(server) {
    if (!AUTH_TOKEN) {
      server.config.logger.warn(
        "[portuni] PORTUNI_AUTH_TOKEN is not set: /api requests will get 401. Run the dev server under varlock (varlock run -- npm --prefix apps/web run dev).",
      );
    }
  },
};
// Catalog HMR (dev only). A catalog JSON file is imported by the i18n module
// (statically for en/common, through import.meta.glob for the rest), and a
// JSON module does not accept hot updates, so Vite's default answer to an
// edited catalog is a full page reload. Instead, push the new content on a
// custom event; src/i18n.ts swaps the resource bundle in place and
// react-i18next re-renders (bindI18nStore: "added").
const CATALOG_FILE = /\/apps\/server\/shared\/i18n\/locales\/([a-z]+)\/([a-z]+)\.json$/;
const catalogHotReload: Plugin = {
  name: "portuni-i18n-hmr",
  apply: "serve",
  handleHotUpdate({ file, server }) {
    const match = CATALOG_FILE.exec(file.replaceAll("\\", "/"));
    if (!match) return;
    let resources: unknown;
    try {
      resources = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      // A half-saved file: keep the page, report once, wait for the next save.
      server.config.logger.warn(`[portuni] catalog ${file} is not valid JSON: ${String(err)}`);
      return [];
    }
    server.ws.send({
      type: "custom",
      event: "portuni:i18n-update",
      data: { lng: match[1], ns: match[2], resources },
    });
    return [];
  },
};

// Dev-mode stand-in for the desktop Tauri host's api_request proxy (#213):
// proves a request came through this dev proxy, not a spawned agent
// terminal holding the same PORTUNI_AUTH_TOKEN. In the packaged app the
// Rust host generates this fresh per launch and never exposes it to a
// spawned shell; here it is a developer-configured shared value (varlock),
// matching AUTH_TOKEN's own dev-mode pattern. Only meaningful if the
// backend also has PORTUNI_WEBVIEW_PROXY_SECRET set to the hardened
// posture -- unset on both sides (the default) keeps env mode's legacy
// unscoped REST writes; see apps/server/api/write-gate.ts.
const WEBVIEW_PROXY_SECRET = (process.env.PORTUNI_WEBVIEW_PROXY_SECRET ?? "").trim();

export default defineConfig({
  plugins: [react(), tailwindcss(), warnMissingAuthToken, catalogHotReload],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Use terser, not the default esbuild minifier. esbuild miscompiles
    // xterm 6.0.0's `requestMode` (DECRQM handler): it drops the unused
    // `let r` binding but leaves a dangling `i = {}` assignment to an
    // UNDECLARED variable, throwing "ReferenceError: Can't find variable:
    // i" in strict-mode ESM the moment a full-screen TUI agent (e.g.
    // Mistral Vibe) sends a request-mode escape sequence. terser handles
    // the dead-store correctly. See the terminal blank-screen post-mortem.
    minify: "terser",
  },
  server: {
    port: 4010,
    strictPort: true,
    allowedHosts: ["portuni.test", "api.portuni.test", "localhost"],
    proxy: {
      "/api": {
        target: "http://localhost:4011",
        // The session live channel (#341, GET /sessions/ws) is a plain
        // WebSocket upgrade under this same /api prefix. Browsers cannot
        // set an Authorization header on a WS handshake at all, so the
        // desktop app's "Rust host holds the bearer" story has no direct
        // browser equivalent -- ws: true here plus the proxyReqWs handler
        // below is the dev-mode stand-in, injecting the token into the
        // proxied UPGRADE request server-side exactly like proxyReq
        // already does for ordinary REST calls. http-proxy fires a
        // separate "proxyReqWs" event for upgrades, not "proxyReq".
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (AUTH_TOKEN) {
              proxyReq.setHeader("Authorization", `Bearer ${AUTH_TOKEN}`);
            }
            // Drop any client-supplied marker before deciding whether to
            // set our own, so client JS can never forward one through
            // unmodified (mirrors the Rust proxy's own filtering).
            proxyReq.removeHeader("X-Portuni-Webview-Proxy");
            if (WEBVIEW_PROXY_SECRET) {
              proxyReq.setHeader("X-Portuni-Webview-Proxy", WEBVIEW_PROXY_SECRET);
            }
          });
          proxy.on("proxyReqWs", (proxyReq) => {
            if (AUTH_TOKEN) {
              proxyReq.setHeader("Authorization", `Bearer ${AUTH_TOKEN}`);
            }
            proxyReq.removeHeader("X-Portuni-Webview-Proxy");
            if (WEBVIEW_PROXY_SECRET) {
              proxyReq.setHeader("X-Portuni-Webview-Proxy", WEBVIEW_PROXY_SECRET);
            }
          });
        },
      },
    },
  },
});
