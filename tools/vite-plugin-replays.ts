import { join, resolve } from "node:path";
import type { Plugin } from "vite";
// The same store the desktop shell writes through (electron/replayStore.mjs).
import { createReplayStore } from "../electron/replayStore.mjs";

/**
 * Dev: the REPLAY folder (issue #158, src/game/replay.ts) — the repo's own `.replays/`
 * (gitignored). A build has no endpoint (`apply: "serve"`); a shipped game keeps its replays
 * through the desktop shell (electron/main.mjs, `ow3native.replays`).
 *
 *   POST /replays/last?keep=N   <bytes>   → { name }   writes LastReplay.o3r (and Autosaved/N)
 *   POST /replays/keep?name=N             → { name }   copies LastReplay to N.o3r
 *   GET  /replays/list                    → [{ name, size, mtime }]
 *   GET  /replays/file?name=N             → <bytes>
 *   POST /replays/delete?name=N           → { ok }     deletes N
 */
export function replays(): Plugin {
  return {
    name: "openwar3-replays",
    apply: "serve",
    configureServer(server) {
      const root = resolve(server.config.root ?? process.cwd());
      const store = createReplayStore(join(root, ".replays"), {
        warn: (msg: string) => server.config.logger.warn(`[replays] ${msg}`),
      });
      server.middlewares.use("/replays", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const json = (code: number, out: unknown): void => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out));
        };
        if (req.method === "GET" && url.pathname === "/list") return json(200, store.list());
        if (req.method === "GET" && url.pathname === "/file") {
          const bytes = store.read(url.searchParams.get("name") ?? "");
          if (!bytes) return json(404, { error: "no such replay" });
          res.setHeader("content-type", "application/octet-stream");
          return res.end(bytes);
        }
        if (req.method === "POST" && url.pathname === "/delete") return json(200, { ok: store.remove(url.searchParams.get("name") ?? "") });
        if (req.method === "POST" && url.pathname === "/keep") return json(200, { name: store.keepLast(url.searchParams.get("name") ?? "") });
        if (req.method === "POST" && url.pathname === "/last") {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 64 * 1024 * 1024) req.destroy();
            else chunks.push(c);
          });
          req.on("end", () => {
            const name = store.saveLast(Buffer.concat(chunks), url.searchParams.get("keep") ?? undefined);
            server.config.logger.info(`[replays] .replays/${name} (${size} bytes)`);
            json(200, { name });
          });
          return;
        }
        return next();
      });
    },
  };
}
