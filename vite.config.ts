import { defineConfig } from "vite";

// Static build, engine code only — no assets are ever bundled or hosted (see plan §0, §8).
export default defineConfig({
  server: { port: 5173 },
  build: { target: "es2022", outDir: "dist" },
});
