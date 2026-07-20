import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Plugin } from "vite";

/**
 * Dev-only: serve the developer's own Warcraft III install over HTTP so a browser can boot
 * the game without a human at the folder picker (docs/multiplayer.md Phase D item 1).
 *
 * **Why a plugin and not an env var.** CLAUDE.md's hard constraint is that OpenWar3 ships and
 * hosts zero Blizzard content. `apply: "serve"` means Vite never even loads this module for
 * `pnpm build` — the route is not code that got switched off, it is code that was never
 * emitted. An env var would leave the middleware in the production code path and make the
 * constraint a property of the CI configuration rather than of the artifact, and an
 * accidentally-shipped asset route is not recoverable by a follow-up commit.
 *
 * The install is read from `OPENWAR3_INSTALL`, defaulting to `Warcraft III/` beside the repo
 * (which is where it already sits, and where `pnpm data:extract` looks). Two endpoints:
 *
 *   GET /wc3/manifest.json          → { archives: string[], maps: string[] }
 *   GET /wc3/file?path=<encoded>    → the bytes of one of those paths
 *
 * Paths speak WC3's `\` separator, matching the keys `InstallFiles` uses (assets/opfs.ts), so
 * what the manifest hands back can be used as a map key verbatim.
 */

const MPQ = /\.mpq$/i;
const MAP = /\.(w3m|w3x)$/i;

/** Reject anything that escapes the install root — `..`, absolute paths, symlink games. */
function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel.replace(/\\/g, sep));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function collectMaps(dir: string, prefix: string, into: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}\\${entry.name}`;
    if (entry.isDirectory()) await collectMaps(join(dir, entry.name), rel, into);
    else if (MAP.test(entry.name)) into.push(rel);
  }
}

export function devInstall(): Plugin {
  return {
    name: "openwar3-dev-install",
    apply: "serve", // never present in a build — see the note above
    configureServer(server) {
      const root = resolve(process.env.OPENWAR3_INSTALL ?? "Warcraft III");
      const ok = existsSync(root);
      if (!ok) {
        server.config.logger.warn(
          `[dev-install] no install at ${root} — ?dev boot is unavailable. ` +
            `Set OPENWAR3_INSTALL to your Warcraft III folder.`,
        );
      }

      server.middlewares.use("/wc3", (req, res, next) => {
        if (!ok) return next();
        const url = new URL(req.url ?? "/", "http://x");

        if (url.pathname === "/manifest.json") {
          void (async () => {
            const entries = await readdir(root, { withFileTypes: true });
            const archives = entries.filter((e) => e.isFile() && MPQ.test(e.name)).map((e) => e.name);
            const maps: string[] = [];
            const mapsDir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === "maps");
            if (mapsDir) await collectMaps(join(root, mapsDir.name), mapsDir.name, maps);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ archives, maps }));
          })();
          return;
        }

        if (url.pathname === "/file") {
          const rel = url.searchParams.get("path");
          const full = rel && safeJoin(root, rel);
          if (!full || !existsSync(full) || !statSync(full).isFile()) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader("content-type", "application/octet-stream");
          res.setHeader("content-length", String(statSync(full).size));
          createReadStream(full).pipe(res);
          return;
        }

        next();
      });
    },
  };
}
