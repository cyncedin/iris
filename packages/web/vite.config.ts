// Dev: `npm run dev -w @iris/web` proxies /api to the running daemon and injects its token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function daemon(): { url: string; token: string } | null {
  const home = process.env.IRIS_HOME ?? path.join(os.homedir(), "Library", "Application Support", "Iris");
  const dir = process.env.IRIS_DEMO === "1" ? path.join(home, "demo") : home;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8"));
    return { url: info.url, token: fs.readFileSync(path.join(dir, "api-token"), "utf8").trim() };
  } catch {
    return null;
  }
}

const inject = (): Plugin => ({
  name: "iris-token",
  apply: "serve",
  transformIndexHtml(html) {
    const d = daemon();
    return html.replace("</head>", `<script>window.__IRIS__=${JSON.stringify({ token: d?.token ?? "", demo: process.env.IRIS_DEMO === "1" })}</script></head>`);
  },
});

const d = daemon();
export default defineConfig({
  plugins: [react(), inject()],
  server: { port: 5178, proxy: d ? { "/api": { target: d.url, changeOrigin: true } } : undefined },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1500 },
});
