// App-facing JASS loader (Phase 7 — issue #33; see docs/triggers.md).
//
// Reads the two Blizzard base libraries from the user's own install
// (`Scripts\common.j` + `Scripts\blizzard.j`, patch-wins via the layered VFS) and
// the map's compiled `war3map.j`, then boots the interpreter and runs config().
// This is the seam between our engine and the JASS runtime; the interpreter itself
// (src/jass/interpreter.ts + natives/) never imports the renderer or vfs, so it
// stays engine-agnostic. Everything here is best-effort: a missing library or a
// script error must never crash the match (CLAUDE.md "safe default").

import type { DataSource } from "../vfs/types";
import type { MpqDataSource } from "../vfs/mpq";
import { buildInterpreter } from "./headless";
import type { Interpreter } from "./interpreter";
import type { EngineHooks, MapSetup } from "./runtime";

const decode = (b: Uint8Array): string => new TextDecoder("windows-1252").decode(b);

function readScript(vfs: DataSource | MpqDataSource, ...paths: string[]): string | null {
  for (const p of paths) {
    const b = vfs.rawBytes(p);
    if (b) return decode(b);
  }
  return null;
}

export interface MapScriptEngine {
  interp: Interpreter;
  setup: MapSetup;
}

/** Load common.j + blizzard.j (from the install) and war3map.j (from the map),
 *  boot the interpreter, and run config(). Returns null if the map has no compiled
 *  script (nothing to run). `melee` selects the game type so blizzard.j's generic
 *  slot init behaves the way it would for that mode. */
export function loadMapScript(
  install: DataSource,
  map: MpqDataSource,
  opts: { melee?: boolean; hooks?: EngineHooks } = {},
): MapScriptEngine | null {
  const mapJ = readScript(map, "war3map.j", "scripts\\war3map.j");
  if (!mapJ) return null;
  const common = readScript(install, "Scripts\\common.j", "scripts\\common.j");
  const blizzard = readScript(install, "Scripts\\blizzard.j", "Scripts\\Blizzard.j", "scripts\\blizzard.j");
  // common.j/blizzard.j should always be present in a real install; if not, run the
  // map script alone (natives still resolve to safe defaults, so config() partially
  // works — better than nothing).
  const sources = [common, blizzard, mapJ].filter((s): s is string => s !== null);
  const interp = buildInterpreter(sources, { gameType: opts.melee ? 1 : 4, hooks: opts.hooks });
  interp.run("config", []);
  return { interp, setup: interp.rt.setup };
}
