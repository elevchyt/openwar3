import { join, resolve } from "node:path";
import type { Plugin } from "vite";
// The same store the desktop shell writes through — the size cap, the roll-over and the
// three-day sweep live in ONE place (electron/logStore.mjs).
import { createLogStore } from "../electron/logStore.mjs";

/**
 * Dev: the MATCH LOG's writer (src/game/matchLog.ts, docs/match-log.md) — the repo's own
 * `.logs/`, the folder the opt-in perf recorder already writes to (tools/vite-plugin-perf-log.ts).
 *
 * Unlike that recorder this one is ALWAYS on under `pnpm dev`: a match log costs a line a second
 * rather than a measurement a frame, and the point of it is to have the record of a match nobody
 * planned to record. A build has no endpoint (`apply: "serve"`); a shipped game writes through the
 * desktop shell instead (electron/main.mjs, `ow3native.matchLog`).
 *
 *   POST /matchlog/begin   { map }        → { id }   opens `.logs/<stamp>_<map>.log`
 *   POST /matchlog/append  { id, text }   → { ok }   appends whole lines
 *   POST /matchlog/end     { id }         → { file }
 */
export function matchLog(): Plugin {
  return {
    name: "openwar3-match-log",
    apply: "serve",
    configureServer(server) {
      const root = resolve(server.config.root ?? process.cwd());
      const store = createLogStore(join(root, ".logs"), {
        warn: (msg: string) => server.config.logger.warn(`[match-log] ${msg}`),
      });
      store.sweep();
      server.middlewares.use("/matchlog", (req, res, next) => {
        if (req.method !== "POST") return next();
        const path = (req.url ?? "/").split("?")[0];
        let body = "";
        req.on("data", (c: Buffer) => {
          body += c.toString("utf8");
          if (body.length > 2 * 1024 * 1024) req.destroy();
        });
        req.on("end", () => {
          const send = (code: number, out: unknown): void => {
            res.statusCode = code;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(out));
          };
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(body) as Record<string, unknown>;
          } catch {
            return send(400, { error: "bad body" });
          }
          if (path === "/begin") {
            const opened = store.begin(String(msg.map ?? ""));
            if (opened) server.config.logger.info(`[match-log] ${opened.file.slice(root.length + 1)}`);
            return send(200, { id: opened?.id ?? null });
          }
          if (path === "/append") return send(200, { ok: store.append(String(msg.id), String(msg.text ?? "")) });
          if (path === "/end") return send(200, { file: store.end(String(msg.id)) });
          return next();
        });
      });
    },
  };
}
