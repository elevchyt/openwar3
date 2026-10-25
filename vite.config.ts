import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { devInstall } from "./tools/vite-plugin-dev-install";
import { driveProxy } from "./tools/vite-plugin-drive-proxy";
import { matchLog } from "./tools/vite-plugin-match-log";
import { perfLog, perfLogDefines } from "./tools/vite-plugin-perf-log";
import { relay } from "./tools/vite-plugin-relay";

// Static build, engine code only — no assets are ever bundled or hosted (see plan §0, §8).
//
// `devInstall` serves the developer's own Warcraft III folder to a `?dev` boot so the game can
// be driven without a human at the folder picker. It carries `apply: "serve"`, so Vite never
// loads it for `pnpm build` — the asset route is not disabled in production, it is absent from
// it. See the plugin's own header for why that distinction is the one that matters.
//
// `perfLog` is the other `apply: "serve"` plugin, and exists for the same reason in reverse: a
// browser cannot append to a file in the project, so a match's performance log needs the dev
// server to write it. It owns `.logs/` (gitignored) and is opt-in — `pnpm dev:log`.
//
// `matchLog` writes every match's plain-text record into the same `.logs/` — ALWAYS, not opt-in:
// it costs a line a game-second. A shipped game writes through the desktop shell instead
// (electron/logStore.mjs is the one writer both use; docs/match-log.md).
//
// `relay` is the third, and the reason LAN play is one process: it mounts the socket-free relay
// core on the dev server's own port at `/relay`, so `pnpm dev --host` is the whole of hosting a
// LAN game. `server/relay.mjs` stays the standalone artifact that deploys to a cloud box.
//
// `driveProxy` is the fourth: Drive refuses a page's own fetch (Sec-Fetch-Site), so the browser
// half of the load gate's "Download game files" reaches the developer's Drive through it.
//
// Its `define`s, though, are declared HERE and unconditionally, OUTSIDE the serve-only plugin:
// a build has no flag, and the client's `__OW3_PERF_MS__` must fold to the constant 0 rather
// than survive as an undefined free identifier. See src/dev/perfLog.ts.
// The version the game PRINTS, taken from the one thing that already decides it: package.json,
// which is also what electron-builder stamps the artifact with and what the updater compares
// against. A second copy in the source would be a second answer to "which version is this", and
// the day they differ the one on screen is the one nobody trusts.
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;

export default defineConfig({
  plugins: [devInstall(), driveProxy(), perfLog(), matchLog(), relay()],
  define: { ...perfLogDefines(), __OW3_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    // Cross-origin ISOLATION, so Voice Control's recogniser may use threads (SharedArrayBuffer):
    // single-threaded, Whisper took ~4.7 s to answer a two-second command. `credentialless` rather
    // than `require-corp`, so a cross-origin fetch that sends no CORP header still loads.
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" },
  },
  build: { target: "es2022", outDir: "dist" },
  // Voice Control's recogniser runs in a MODULE worker (src/voice/whisperWorker.ts) that code-
  // splits transformers.js; the default "iife" worker format cannot.
  worker: { format: "es" },
  // transformers.js and onnxruntime-web ship their own WebAssembly glue; pre-bundling them breaks
  // the relative paths that glue resolves at runtime.
  optimizeDeps: { exclude: ["@huggingface/transformers", "onnxruntime-web"] },
});
