import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Dev-only: give each match somewhere to write its performance log (`src/dev/perfLog.ts`).
 *
 * **Why a plugin and not a file the page writes itself.** A browser cannot append to a file in
 * the project, and everything it *can* write to (localStorage, IndexedDB, a download) is a
 * place you cannot grep, diff, or hand to a script. The whole point of the log is to be a
 * plain file next to the code, so the writer has to be the dev server. Like `devInstall` it
 * carries `apply: "serve"`, so the route is not in a build at all — a published OpenWar3 has
 * no endpoint that writes to disk, because there is no endpoint.
 *
 * **Opt-in, per dev-server run.** Recording is off unless the server was started with the flag:
 *
 *     pnpm dev:log                   # sample every 1 s, deep snapshot every 15 s
 *     pnpm dev:log 2                 # …sample every 2 s instead
 *     pnpm dev:log 1,30              # …and snapshot every 30 s
 *     pnpm dev                       # …and this records nothing at all
 *
 * The flag gates BOTH halves, through `perfLogDefines()`: with it absent the endpoints are not
 * mounted and the client's own `PERF_MS` is 0, so the recorder never opens a session and never
 * takes a timestamp. That matters because the alternative — always recording, and deciding
 * later — puts a measurement in every frame of a session nobody asked to measure.
 *
 * Three endpoints, all POST, all JSON (`sendBeacon` sends `text/plain`, so the content type
 * is never checked — the body is what matters):
 *
 *   POST /perf/begin   { …header }        → { id, file }   opens `.logs/<stamp>_<map>.ndjson`
 *   POST /perf/append  { id, lines: [] }  → { ok }         appends, one JSON object per line
 *   POST /perf/end     { id }             → { report }     writes the readable digest beside it
 *
 * Records are appended AS THEY ARRIVE rather than held and written at the end: the session
 * worth reading is usually the one that ended in a tab crash, and a log that only exists for
 * clean exits would miss exactly those. `/perf/end` is therefore a nicety — it writes the
 * digest — and never the thing that makes the data durable. A session that died without it
 * still has its full `.ndjson`, and `pnpm perf:report` renders the digest after the fact.
 */

const DIR = ".logs";
/** Aggregated `sample` records: one per this many seconds. */
const DEFAULT_SAMPLE_S = 1;
/** Deep `snapshot` records — the census that is too expensive to take every second. */
const DEFAULT_SNAPSHOT_S = 15;
/** Sessions kept on disk. Old ones are pruned oldest-first so the folder cannot grow forever. */
const KEEP = 40;
/** A session shorter than this wrote nothing worth keeping — a mis-click into a match and
 *  straight back out. Pruned on close so the folder stays readable. */
const MIN_LINES = 4;

/**
 * Read the recording flag: `OPENWAR3_PERF`, set by `pnpm dev:log` (tools/dev-log.mjs).
 *
 * It arrives as an env var rather than a command-line option because Vite's CLI is CAC with
 * unknown-option checking on — `vite --log` is a hard error, not an argument a config could
 * read. The value is the sampling spec: "1", "2", or "1,30" (sample seconds, snapshot
 * seconds).
 */
export function perfFlag(): { on: boolean; sampleMs: number; snapshotMs: number } {
  const env = process.env.OPENWAR3_PERF;
  const on = !!env && env !== "0" && env !== "false";
  const spec = env && env !== "1" ? env : "";
  const [sample, snapshot] = spec.split(",").map((n) => Number(n.trim()));
  return {
    on,
    sampleMs: Math.max(0.1, sample > 0 ? sample : DEFAULT_SAMPLE_S) * 1000,
    snapshotMs: Math.max(1, snapshot > 0 ? snapshot : DEFAULT_SNAPSHOT_S) * 1000,
  };
}

/**
 * The client's half of the flag, as Vite `define`s.
 *
 * These are spread into the config's own `define` rather than produced by the plugin's
 * `config()` hook, because the plugin is `apply: "serve"` and a BUILD would then leave
 * `__OW3_PERF_MS__` an undefined free identifier — a ReferenceError on the first frame of a
 * shipped game. Defining it unconditionally (as 0, since a build has no flag) means the
 * recorder folds away to a constant instead of to a crash.
 */
export function perfLogDefines(): Record<string, string> {
  const f = perfFlag();
  return {
    __OW3_PERF_MS__: JSON.stringify(f.on ? f.sampleMs : 0),
    __OW3_PERF_SNAPSHOT_MS__: JSON.stringify(f.on ? f.snapshotMs : 0),
  };
}

interface Session {
  file: string;
  lines: number;
}

function stamp(): string {
  // Local time, sortable, and filename-safe: 2026-08-28_14-03-22.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function slug(s: unknown): string {
  const out = String(s ?? "")
    .replace(/\.[wW]3[xmn]$/, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return out || "match";
}

function readBody(req: NodeJS.ReadableStream, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise((ok, fail) => {
    let out = "";
    req.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.length > limit) fail(new Error("body too large"));
    });
    req.on("end", () => ok(out));
    req.on("error", fail);
  });
}

/** Keep the newest KEEP sessions; a session is its `.ndjson` plus its `.txt` digest. */
function prune(dir: string): void {
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of logs.slice(KEEP)) {
    unlinkSync(join(dir, f));
    const txt = join(dir, f.replace(/\.ndjson$/, ".txt"));
    if (existsSync(txt)) unlinkSync(txt);
  }
}

export function perfLog(): Plugin {
  const sessions = new Map<string, Session>();
  let seq = 0;

  return {
    name: "openwar3-perf-log",
    apply: "serve", // never present in a build — see the note above
    configureServer(server) {
      const flag = perfFlag();
      if (!flag.on) {
        server.config.logger.info(`  \x1b[2mperf logging off — start with \x1b[0m\x1b[36mpnpm dev:log\x1b[0m\x1b[2m to record matches to ${DIR}/\x1b[0m`);
        return;
      }
      const root = resolve(server.config.root ?? process.cwd());
      const dir = join(root, DIR);
      server.config.logger.info(
        `  \x1b[2mperf logging on — ${DIR}/, sampling every ${flag.sampleMs / 1000}s, snapshot every ${flag.snapshotMs / 1000}s\x1b[0m`,
      );

      server.middlewares.use("/perf", (req, res, next) => {
        if (req.method !== "POST") return next();
        const path = (req.url ?? "/").split("?")[0];
        const send = (code: number, body: unknown): void => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };

        void (async () => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(await readBody(req)) as Record<string, unknown>;
          } catch {
            return send(400, { error: "bad body" });
          }

          if (path === "/begin") {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const id = `s${++seq}-${Date.now().toString(36)}`;
            const name = `${stamp()}_${slug(msg.map)}.ndjson`;
            const file = join(dir, name);
            writeFileSync(file, JSON.stringify({ t: "session", ms: 0, id, ...msg }) + "\n");
            sessions.set(id, { file, lines: 1 });
            prune(dir);
            server.config.logger.info(`[perf] recording ${DIR}/${name}`);
            return send(200, { id, file: `${DIR}/${name}` });
          }

          if (path === "/append") {
            const s = sessions.get(String(msg.id));
            const lines = Array.isArray(msg.lines) ? msg.lines : [];
            if (!s) return send(404, { error: "no such session" });
            if (lines.length) {
              appendFileSync(s.file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
              s.lines += lines.length;
            }
            return send(200, { ok: true });
          }

          if (path === "/end") {
            const s = sessions.get(String(msg.id));
            if (!s) return send(404, { error: "no such session" });
            sessions.delete(String(msg.id));
            // A match nobody actually played is noise in the folder, not data.
            if (s.lines < MIN_LINES) {
              if (existsSync(s.file)) unlinkSync(s.file);
              return send(200, { report: null });
            }
            const out = s.file.replace(/\.ndjson$/, ".txt");
            try {
              const { renderReport } = (await import("./perf-report.mjs")) as {
                renderReport(text: string): string;
              };
              writeFileSync(out, renderReport(readFileSync(s.file, "utf8")));
              server.config.logger.info(`[perf] ${DIR}/${out.slice(dir.length + 1)}`);
              return send(200, { report: `${DIR}/${out.slice(dir.length + 1)}` });
            } catch (err) {
              // The raw log is the durable artefact; a digest that failed to render is a
              // formatting bug, not a lost session. Say so and leave the .ndjson alone.
              server.config.logger.warn(`[perf] report failed: ${String(err)}`);
              return send(200, { report: null });
            }
          }

          return next();
        })();
      });
    },
  };
}
