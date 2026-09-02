import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// When the backend has PORTUNI_AUTH_TOKEN set, the same token must reach
// it from the frontend. We inject it into the dev proxy server-side so
// the secret never lands in the client bundle. Run vite under varlock
// (or `PORTUNI_AUTH_TOKEN=... vite dev`) for this to pick up the value.
const AUTH_TOKEN = (process.env.PORTUNI_AUTH_TOKEN ?? "").trim();
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
  plugins: [react(), tailwindcss()],
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
        },
      },
    },
  },
});
