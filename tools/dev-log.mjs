/**
 * `pnpm dev:log` — the dev server with match recording on (docs/perf-logging.md).
 *
 *   pnpm dev:log              # sample every 1 s, deep snapshot every 15 s
 *   pnpm dev:log 2            # …sample every 2 s instead
 *   pnpm dev:log 1,30         # …sample every 1 s, snapshot every 30 s
 *   pnpm dev:log --port 5174  # anything else is passed straight through to Vite
 *
 * **Why a wrapper and not `"dev:log": "OPENWAR3_PERF=1 vite"`.** That form is a shell-ism:
 * `VAR=value cmd` is not a command on Windows, and this project is developed on one. Four
 * lines of Node set the variable the same way everywhere, and let the sampling periods be
 * ordinary arguments rather than a second env var to spell out.
 *
 * `pnpm dev` stays exactly what it was: no recording, no endpoints, nothing measured.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// A bare `1` / `2,30` is the sampling spec; everything else is Vite's (see the plugin's
// `perfFlag`, which parses the same string out of OPENWAR3_PERF).
const args = process.argv.slice(2);
const spec = /^[\d.]+(,[\d.]+)?$/.test(args[0] ?? "") ? args.shift() : "1";

const child = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), ...args], {
  stdio: "inherit",
  env: { ...process.env, OPENWAR3_PERF: spec },
});
// The terminal's Ctrl-C reaches the whole group, so the child dies with us; this is only so
// the exit CODE is Vite's own and a script calling us sees what actually happened.
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
