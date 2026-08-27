import { defineConfig } from "vite";
import { devInstall } from "./tools/vite-plugin-dev-install";
import { perfLog, perfLogDefines } from "./tools/vite-plugin-perf-log";

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
// Its `define`s, though, are declared HERE and unconditionally, OUTSIDE the serve-only plugin:
// a build has no flag, and the client's `__OW3_PERF_MS__` must fold to the constant 0 rather
// than survive as an undefined free identifier. See src/dev/perfLog.ts.
export default defineConfig({
  plugins: [devInstall(), perfLog()],
  define: perfLogDefines(),
  server: { port: 5173 },
  build: { target: "es2022", outDir: "dist" },
});
