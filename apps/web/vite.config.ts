import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// When the backend has PORTUNI_AUTH_TOKEN set, the same token must reach
// it from the frontend. We inject it into the dev proxy server-side so
// the secret never lands in the client bundle. Run vite under varlock
// (or `PORTUNI_AUTH_TOKEN=... vite dev`) for this to pick up the value.
const AUTH_TOKEN = (process.env.PORTUNI_AUTH_TOKEN ?? "").trim();

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
          });
        },
      },
    },
  },
});
