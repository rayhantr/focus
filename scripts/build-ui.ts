// Builds each UI page (Preact + Vite) into a single self-contained HTML file:
//   ui/<page>/{index.html, main.tsx} -> ui/dist/<page>/index.html
// server.ts embeds those files via `with { type: "text" }` imports.
//
// Usage:
//   deno run -A scripts/build-ui.ts            one-shot build of all pages
//   deno run -A scripts/build-ui.ts --watch    rebuild on change (all pages)

import { build, type InlineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const PAGES = ["panel", "taskbar", "menu", "lock", "settings"];
const watch = Deno.args.includes("--watch");

function configFor(page: string): InlineConfig {
  return {
    configFile: false,
    root: `ui/${page}`,
    base: "./",
    logLevel: watch ? "info" : "warn",
    esbuild: { jsx: "automatic", jsxImportSource: "preact" },
    plugins: [viteSingleFile()],
    build: {
      outDir: `../dist/${page}`, // relative to root -> ui/dist/<page>
      emptyOutDir: true,
      minify: true,
      watch: watch ? {} : null,
    },
  };
}

for (const page of PAGES) {
  await build(configFor(page));
  if (!watch) console.log(`built ui/dist/${page}/index.html`);
}

if (watch) {
  console.log("watching ui/ for changes… (Ctrl+C to stop)");
}
