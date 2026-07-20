import { defineConfig } from "vite";
import { devInstall } from "./tools/vite-plugin-dev-install";

// Static build, engine code only — no assets are ever bundled or hosted (see plan §0, §8).
//
// `devInstall` serves the developer's own Warcraft III folder to a `?dev` boot so the game can
// be driven without a human at the folder picker. It carries `apply: "serve"`, so Vite never
// loads it for `pnpm build` — the asset route is not disabled in production, it is absent from
// it. See the plugin's own header for why that distinction is the one that matters.
export default defineConfig({
  plugins: [devInstall()],
  server: { port: 5173 },
  build: { target: "es2022", outDir: "dist" },
});
