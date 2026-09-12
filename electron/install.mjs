// Reading the player's own Warcraft III folder, from the desktop app's Node side.
//
// **Why this is not an HTTP route.** The dev server has one (tools/vite-plugin-dev-install.ts)
// and its header states the rule it lives by: `apply: "serve"`, so the asset route is not code
// that got switched off in a build, it is code that was never emitted. The shipped app must keep
// that rule, and it serves its page on a LAN-facing port — so an install route there would be
// addressable from another machine. Instead the app answers a CUSTOM SCHEME
// (`ow3-install://`), which is not a server at all: it exists only inside this app's session and
// nothing outside the process can reach it. The bytes never touch a socket.
//
// **Why the walk lives HERE and the dev plugin imports it.** Two enumerations of an install are
// two answers to "which files are the CASC config" that agree until the day they do not — and
// the one that would drift is the one only the other path exercises. The SHIPPED file is the
// home and the dev-only one borrows it, never the other way round: `tools/` is not packaged.
//
// The manifest's shape is the renderer's `InstallManifest` (src/assets/remoteInstall.ts), and
// paths in it speak WC3's `\` separator so they can be used as `InstallFiles` keys verbatim.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const MPQ = /\.mpq$/i;
const MAP = /\.(w3m|w3x)$/i;
const IDX = /^[0-9a-f]{10}\.idx$/i;
const DATA_FILE = /^data\.\d{3}$/i;
const CONFIG_HASH = /^[0-9a-f]{32}$/i;
const BUILD_INFO = ".build.info";

/**
 * The page is served over http from the app's own port, so a fetch of `ow3-install://` is
 * CROSS-ORIGIN and Chromium blocks it without these — which shows up as "Failed to fetch" in the
 * renderer and NOTHING at all in the main process, the whole failure looking exactly like a
 * handler that was never registered. Cost an hour once.
 *
 * `*` is not a hole here: the scheme is registered on THIS app's session, so it exists only
 * inside this process. Another machine loading the page over the LAN runs in its own browser,
 * where `ow3-install://` resolves to nothing at all — which is the property that lets the
 * desktop app read an install while serving a LAN-facing page, and the reason the install is
 * not on that port in the first place.
 *
 * `Range` has to be allowed BY NAME: it is not a CORS-safelisted request header, and a ranged
 * read of `data.NNN` is how every boot works.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-length, content-range, accept-ranges",
};

/** Reject anything that escapes the install root — `..`, absolute paths, symlink games. */
export function safeJoin(root, rel) {
  const full = resolve(root, rel.replace(/\\/g, sep));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function collectMaps(dir, prefix, into) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}\\${entry.name}`;
    if (entry.isDirectory()) await collectMaps(join(dir, entry.name), rel, into);
    else if (MAP.test(entry.name)) into.push(rel);
  }
}

/** The CASC pieces a mount needs (src/vfs/casc.ts), as install-relative paths. Null for an
 *  MPQ-era folder, which is how the renderer tells the two storages apart. */
async function collectCasc(root) {
  if (!existsSync(join(root, BUILD_INFO)) || !existsSync(join(root, "Data"))) return null;
  const out = { buildInfo: BUILD_INFO, config: [], idx: [], data: {} };
  const walk = async (dir, prefix, depth) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}\\${entry.name}`;
      if (entry.isDirectory()) {
        // config/ is a two-level hash fan-out, data/ and indices/ are flat — three levels of
        // recursion covers both without walking anything deeper.
        if (depth < 3) await walk(join(dir, entry.name), rel, depth + 1);
      } else if (IDX.test(entry.name)) out.idx.push(rel);
      else if (DATA_FILE.test(entry.name)) out.data[Number(entry.name.slice(5))] = rel;
      else if (CONFIG_HASH.test(entry.name)) out.config.push(rel);
    }
  };
  await walk(join(root, "Data"), "Data", 0);
  return out;
}

/** Everything in a folder that an install is made of. Throws if it is not one. */
export async function enumerateInstall(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const archives = entries.filter((e) => e.isFile() && MPQ.test(e.name)).map((e) => e.name);
  const maps = [];
  const mapsDir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === "maps");
  if (mapsDir) await collectMaps(join(root, mapsDir.name), mapsDir.name, maps);
  const casc = await collectCasc(root);
  // The player's own hotkeys/tooltips, a loose file in the folder (issue #142) — named here
  // rather than assumed, because most folders have none. See src/data/customKeys.ts.
  const customKeys = entries.some((e) => e.isFile() && e.name.toLowerCase() === "customkeys.txt")
    ? "CustomKeys.txt"
    : null;
  return { archives, maps, casc, customKeys };
}

/** The build OpenWar3 plays. MUST equal `REQUIRED_VERSION` in src/vfs/version.ts, which states
 *  WHY there is a version rule at all and says it to the player; this side only has to agree, so
 *  that a folder the game would refuse is never remembered in the first place. `pnpm app:test`
 *  compares the two. */
export const REQUIRED_VERSION = "1.30.4";

/** What `.build.info` says this folder is — "1.30.4.11274" — or null if it says nothing. The
 *  file is a `|`-separated table with a header row; the row to read is the ACTIVE branch. */
export function installVersion(root) {
  try {
    const lines = readFileSync(join(root, BUILD_INFO), "utf8").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return null;
    const columns = lines[0].split("|").map((c) => c.split("!")[0].trim());
    const rows = lines.slice(1).map((l) => {
      const cells = l.split("|");
      return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
    });
    return (rows.find((r) => r.Active === "1") ?? rows[0]).Version || null;
  } catch {
    return null; // absent, unreadable, or not that file
  }
}

/**
 * Is this folder the Warcraft III OpenWar3 plays?
 *
 * Asked of what the player picked, so the answer arrives at the moment of choosing rather than as
 * a mount failing three steps later — and, more importantly, so a folder the game would refuse is
 * never SAVED as the remembered one. The game checks again every launch (src/vfs/version.ts);
 * this is the same rule asked earlier, not a second one.
 *
 * A pre-1.30 (MPQ) folder has no `.build.info` at all and so cannot pass, which is correct: it is
 * older than the build we play by construction.
 */
export function looksLikeInstall(root) {
  if (!root || !existsSync(root)) return false;
  if (!existsSync(join(root, "Data"))) return false;
  const version = installVersion(root);
  return !!version && version.split(".").slice(0, 3).join(".") === REQUIRED_VERSION;
}

/**
 * Answer one `ow3-install://` request against `root`.
 *
 * Two routes, the same two the dev server has, so one renderer path reads both:
 *   /manifest.json          → what the folder holds
 *   /file?path=<encoded>    → the bytes, honouring `Range`
 *
 * `Range` is not a nicety on 1.30.4: the content store is a pair of `data.NNN` files totalling
 * 1.7 GB and the mount reads scattered slices of them. Reading those whole would make every
 * boot unusable.
 *
 * Takes a `Request` and returns a `Response`, which is exactly `protocol.handle`'s contract and
 * also plain web types — so this is testable without an Electron window (tools/electron-server-test).
 */
export async function serveInstall(root, request) {
  const url = new URL(request.url);
  const notFound = () => new Response("not found", { status: 404, headers: CORS });

  if (url.pathname === "/manifest.json") {
    if (!root) return notFound();
    const manifest = await enumerateInstall(root);
    return Response.json(manifest, { headers: CORS });
  }

  if (url.pathname === "/file") {
    const rel = url.searchParams.get("path");
    const full = root && rel && safeJoin(root, rel);
    if (!full || !existsSync(full) || !statSync(full).isFile()) return notFound();
    const size = statSync(full).size;
    const headers = { ...CORS, "accept-ranges": "bytes", "content-type": "application/octet-stream" };

    // `bytes=<start>-<end>`, end inclusive, as the fetch Range header spells it.
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...CORS, "content-range": `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(createReadStream(full, { start, end })), {
        status: 206,
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
      });
    }
    return new Response(Readable.toWeb(createReadStream(full)), {
      status: 200,
      headers: { ...headers, "content-length": String(size) },
    });
  }

  return notFound();
}
