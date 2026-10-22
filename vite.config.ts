import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };
const date = new Date().toISOString().slice(0, 10);

export default defineConfig({
  // relative Pfade: läuft unter https://<name>.github.io/noten-scanner-app/ wie lokal
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version} (${date})`),
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
