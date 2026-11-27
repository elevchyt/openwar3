import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";

/**
 * Dev: refuse a CROSS-SITE write to the dev server.
 *
 * The dev plugins answer requests that change things on this machine — `POST /wc3/customkeys`
 * and `/wc3/map` write into the install, `/saves/write` and `/saves/delete` the saves, the
 * replay, match-log and perf-log endpoints the repo's own folders. A plain `fetch(…, { method:
 * "POST", mode: "no-cors" })` from ANY web page open in the developer's browser is a "simple"
 * request that needs no preflight, so without this a page on the internet could overwrite
 * `CustomKeys.txt`, plant a map in the install or delete the saves on `localhost:5173`.
 *
 * The rule is the browser's own word for where a request came from: a request carrying an
 * `Origin` (every browser sends one on a POST) must be from THIS server's own host, and one the
 * browser marks `Sec-Fetch-Site: cross-site` is refused outright. A request with neither — a Node
 * test script, `curl` — is not a browser being tricked and is let through; a LAN tester on
 * `pnpm dev --host` posts from `http://<that ip>:5173` to the same host and is let through too.
 *
 * Registered FIRST in vite.config.ts, so it runs before every other plugin's middleware.
 * `apply: "serve"`: a build has no endpoints to protect.
 */
export function sameOriginWrites(): Plugin {
  return {
    name: "openwar3-same-origin-writes",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
        if (crossSite(req)) {
          res.statusCode = 403;
          res.end("Cross-site request refused.");
          return;
        }
        next();
      });
    },
  };
}

function crossSite(req: IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  // `Origin: null` is what a sandboxed frame or a `data:`/`file:` page sends — never our page.
  if (origin === "null") return true;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}
