// Bundle the desktop shell into ONE CommonJS file for the 32-bit Linux build (docs/linux.md).
//
// That build runs on Electron 18 — the last to publish `linux-ia32` — which cannot load an ES
// module as its main script and whose Node is 16. So `electron/legacy/main.mjs` (the shell with
// its Electron-18 shims in front) is bundled to `electron/main-legacy.cjs`, next to `main.mjs` so
// every `import.meta.url`-relative path in it (`../dist`, `preload.cjs`) still lands where it
// did. Electron and the two runtime dependencies stay `require`s: electron-builder ships
// node_modules beside it, and both are CommonJS already.

import { build } from "vite";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const external = ["electron", "electron-updater", "ws", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

await build({
  root,
  configFile: false,
  publicDir: false, // or Vite copies `public/` into `electron/` beside the bundle
  logLevel: "warn",
  build: {
    ssr: join(root, "electron/legacy/main.mjs"),
    outDir: join(root, "electron"),
    emptyOutDir: false,
    target: "node16",
    minify: false,
    rollupOptions: {
      external,
      output: { format: "cjs", entryFileNames: "main-legacy.cjs" },
    },
  },
});
console.log("[build-legacy-main] electron/main-legacy.cjs");
