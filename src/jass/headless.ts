// Engine-free entry for headless tests + tooling (Phase 7 — issue #33).
//
// Builds a Runtime + Interpreter from raw JASS SOURCE STRINGS (common.j,
// blizzard.j, war3map.j) with no vfs/renderer dependency, so the corpus parse test
// and the config()/CreateAllUnits() oracles (tools/jass-corpus-test.cjs) can run in
// plain Node. The app-facing loader that reads the MPQs lives in src/jass/index.ts.

import { Interpreter } from "./interpreter";
import { parseJass } from "./parser";
import { registerNatives } from "./natives/index";
import { Runtime, type EngineHooks } from "./runtime";
import { parseWts } from "./wts";

export interface HeadlessOptions {
  /** common.j ConvertGameType index: 1 = melee, 4 = use-map-settings (default). */
  gameType?: number;
  hooks?: EngineHooks;
  seed?: number;
  /** Raw war3map.wts text — the map's trigger-string table (resolves TRIGSTR_nnn). */
  wts?: string;
}

/** Parse + load the given sources (in order), register natives, and initialise
 *  globals — ready to run config()/main()/any function. */
export function buildInterpreter(sources: string[], opts: HeadlessOptions = {}): Interpreter {
  const rt = new Runtime(opts.seed);
  rt.gameType = opts.gameType ?? 4;
  rt.hooks = opts.hooks ?? null;
  if (opts.wts) for (const [id, text] of parseWts(opts.wts)) rt.trigStrings.set(id, text);
  registerNatives(rt);
  const interp = new Interpreter(rt);
  for (const src of sources) interp.load(parseJass(src));
  interp.initGlobals();
  return interp;
}

export { parseJass } from "./parser";
export { Runtime } from "./runtime";
export type { MapSetup } from "./runtime";
