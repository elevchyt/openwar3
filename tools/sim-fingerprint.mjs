// The SIM FINGERPRINT (issue #158, docs/replays.md "Versions") — one hash over every source file
// that can change how a match PLAYS OUT, taken at build time and stamped into each replay.
//
// A replay is the match's inputs, re-simulated, so it plays back exactly only on a build that
// simulates the same way. The release number is too coarse a test of that: most releases touch
// the menus, the HUD, the renderer or the audio and leave the simulation alone, and a replay from
// one of those plays perfectly on the next. So two builds with the SAME fingerprint play each
// other's replays natively, and only a different one sends the viewer to the recording version's
// own bundle (electron/replayBundles.mjs).
//
// WHAT IS IN IT is deliberately wide. The issue names `src/sim`, `src/data`, `src/jass`,
// `src/patches`, the downgrade and the authority; but the controller (`src/game/rts.ts`) spawns
// units and seats players, the scene (`src/render/mapViewer.ts`) pumps the map script and orders
// the step, a map's own AI script and the creep caster run on playback (`src/ai`), and the map
// parsers decide what the world is built from (`src/compat`, `src/world`, `src/vfs`). A hash
// that left one of those out would call two builds the same when a match on them differs — a
// replay that quietly goes wrong, which is the one failure this exists to prevent. Being wide
// only costs a download that was not strictly needed.
//
// A comment edit changes it too. That is accepted: stripping comments would mean parsing
// TypeScript here, and the cost is, again, only a download.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Folders (every `.ts`/`.json` under them) and single files, relative to the repo root. */
export const FINGERPRINT_PATHS = [
  "src/sim", "src/data", "src/jass", "src/patches", "src/ai", "src/game", "src/compat", "src/world", "src/vfs",
  "src/render/mapViewer.ts",
];

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(ts|json)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
}

/** The fingerprint of the tree at `root`: 16 hex digits. */
export function simFingerprint(root) {
  const files = [];
  for (const p of FINGERPRINT_PATHS) {
    const path = join(root, p);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  const hash = createHash("sha256");
  for (const file of files) {
    // The NAME is hashed with the bytes (a file moved is a different tree), spelled with `/` on
    // every platform, and line endings are folded so a Windows checkout agrees with a Linux one.
    hash.update(relative(root, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
