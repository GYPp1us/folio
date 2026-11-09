import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
const build = randomBytes(12).toString("hex");
export default defineConfig({
  define: { __FOLIO_BUILD__: JSON.stringify(build) },
  plugins: [
    react(),
    {
      name: "folio-build-id",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build.json",
          source: JSON.stringify({ build }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3210" },
  },
  build: { outDir: "dist" },
});
