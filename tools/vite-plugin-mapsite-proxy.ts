import { Readable } from "node:stream";
import type { Plugin } from "vite";
import { fetchMapSite, MAP_SITE_MAX_BYTES } from "../electron/mapSites.mjs";

/**
 * Dev-only: let the map browser's download panel (src/ui/mapSites.ts) reach EpicWar at
 * localhost, the way the desktop app's main process does (electron/mapSites.mjs, which holds the
 * allow-list both of them use — this is not an open proxy).
 *
 * `apply: "serve"`, like the Drive proxy: a hosted web build has no such route and its panel
 * falls back on opening the sites in a tab and importing the file.
 *
 *   GET /dev-mapsite?url=<allowed https URL>   → the body, redirects followed while allowed
 */
export function mapSiteProxy(): Plugin {
  return {
    name: "openwar3-mapsite-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev-mapsite", (req, res) => {
        const url = new URL(req.url ?? "/", "http://x").searchParams.get("url") ?? "";
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        void fetchMapSite(url, abort.signal)
          .then((up) => {
            const length = Number(up.headers.get("content-length") ?? 0);
            if (length > MAP_SITE_MAX_BYTES) { res.statusCode = 413; return res.end(); }
            res.statusCode = up.status;
            for (const h of ["content-type", "content-length"]) {
              const v = up.headers.get(h);
              if (v) res.setHeader(h, v);
            }
            // The page is cross-origin ISOLATED (COEP, for Voice Control's threads); a same-origin
            // response needs nothing more, but say so for the thumbnails' <img>.
            res.setHeader("cross-origin-resource-policy", "same-origin");
            if (!up.body) return res.end();
            Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
          })
          .catch((err: Error) => {
            if (!res.headersSent) res.statusCode = /Not a map-site/.test(err.message) ? 403 : 502;
            res.end(err.message);
          });
      });
    },
  };
}
