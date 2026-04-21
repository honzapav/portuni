import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4010,
    strictPort: true,
    allowedHosts: ["portuni.test", "api.portuni.test", "localhost"],
    proxy: {
      "/api": {
        target: "http://localhost:4011",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
