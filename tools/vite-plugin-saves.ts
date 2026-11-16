import { join, resolve } from "node:path";
import type { Plugin } from "vite";
// The same store the desktop shell writes through (electron/saveStore.mjs).
import { createSaveStore } from "../electron/saveStore.mjs";

/**
 * Dev: the SAVED GAMES folder (issue #159, src/game/save/saveFile.ts) — the repo's own `.saves/`
 * (gitignored). A build has no endpoint (`apply: "serve"`); a shipped game keeps its saves
 * through the desktop shell (electron/main.mjs, `ow3native.saves`).
 *
 *   POST /saves/write?name=N   <bytes>   → { name }   writes N.o3s
 *   GET  /saves/list                     → [{ name, size, mtime }]
 *   GET  /saves/file?name=N              → <bytes>
 *   GET  /saves/exists?name=N            → { ok }
 *   POST /saves/delete?name=N            → { ok }     deletes N
 */
export function saves(): Plugin {
  return {
    name: "openwar3-saves",
    apply: "serve",
    configureServer(server) {
      const root = resolve(server.config.root ?? process.cwd());
      const store = createSaveStore(join(root, ".saves"), {
        warn: (msg: string) => server.config.logger.warn(`[saves] ${msg}`),
      });
      server.middlewares.use("/saves", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const name = url.searchParams.get("name") ?? "";
        const json = (code: number, out: unknown): void => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out));
        };
        if (req.method === "GET" && url.pathname === "/list") return json(200, store.list());
        if (req.method === "GET" && url.pathname === "/exists") return json(200, { ok: store.exists(name) });
        if (req.method === "GET" && url.pathname === "/file") {
          const bytes = store.read(name);
          if (!bytes) return json(404, { error: "no such save" });
          res.setHeader("content-type", "application/octet-stream");
          return res.end(bytes);
        }
        if (req.method === "POST" && url.pathname === "/delete") return json(200, { ok: store.remove(name) });
        if (req.method === "POST" && url.pathname === "/write") {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 256 * 1024 * 1024) req.destroy();
            else chunks.push(c);
          });
          req.on("end", () => {
            const written = store.write(name, Buffer.concat(chunks));
            server.config.logger.info(`[saves] .saves/${written} (${size} bytes)`);
            json(written ? 200 : 400, { name: written });
          });
          return;
        }
        return next();
      });
    },
  };
}
