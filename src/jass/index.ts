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
import type { EngineHooks, LobbySlot, MapSetup } from "./runtime";
import { COMPAT_PRELUDE } from "../compat/prelude";
import { createLuaMapScript, type LuaMapScript } from "../compat/lua/index";

const decode = (b: Uint8Array): string => new TextDecoder("windows-1252").decode(b);
// war3map.wts is UTF-8 (with a BOM); decode it as such so authored text isn't mojibake.
const decodeUtf8 = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b);

function readScript(vfs: DataSource | MpqDataSource, ...paths: string[]): string | null {
  for (const p of paths) {
    const b = vfs.rawBytes(p);
    if (b) return decode(b);
  }
  return null;
}

function readUtf8(vfs: DataSource | MpqDataSource, ...paths: string[]): string | null {
  for (const p of paths) {
    const b = vfs.rawBytes(p);
    if (b) return decodeUtf8(b);
  }
  return null;
}

export interface MapScriptEngine {
  interp: Interpreter;
  setup: MapSetup;
  /** The Lua front end, when the map's script is `war3map.lua` (src/compat/lua/). Held so the
   *  match can drop it with everything else it owns; nothing else in the engine asks. */
  lua?: LuaMapScript;
}

/** The seed the map's Lua `math.random` starts from. A match is LOCKSTEP, so this has to be
 *  the same number on every machine and must not come from the clock — it is a constant for
 *  the same reason the sim's own RNG is seeded from the match, not from `Date.now()`. */
const LUA_SEED = 1;

/** Load common.j + blizzard.j (from the install) and war3map.j (from the map),
 *  boot the interpreter, and run config(). Returns null if the map has no compiled
 *  script (nothing to run). `melee` selects the game type so blizzard.j's generic
 *  slot init behaves the way it would for that mode.
 *
 *  `runMain` additionally runs the map's `main()` after `config()` — which walks
 *  blizzard.j's InitBlizzard (setting up the force presets), then
 *  InitCustomTriggers/RunInitializationTriggers, firing the map's "Map Initialization"
 *  triggers. On a CUSTOM map that surfaces the welcome text / quests; on a MELEE map it
 *  fires the "Melee Initialization" trigger — the eight `Melee*` calls that ARE the melee
 *  game (7.3: starting units, resources, hero limits, creep clearing, victory/defeat).
 *
 *  `lobby` is the handoff the map script cannot make for itself: config() declares what
 *  the MAP allows, the lobby decides who is actually PLAYING, as which race, on which
 *  team. It's applied between config() and main(), because the melee library reads it
 *  (GetPlayerSlotState / GetPlayerRace) the moment main() fires the init trigger.
 *
 *  main()'s CreateAllUnits only RECORDS its unit rows — the map's pre-placed units are
 *  already on the map, adopted from war3mapUnits.doo (see Runtime.recordOnlySpawnFns), so
 *  nothing is double-placed. Every other CreateUnit — the melee roster, a trigger's spawn
 *  — goes through the `createUnit` hook for real. */
export function loadMapScript(
  install: DataSource,
  map: MpqDataSource,
  opts: {
    melee?: boolean;
    hooks?: EngineHooks;
    /** Which of `hooks`' entries WRITE THE WORLD (docs/multiplayer.md item 7b). The interpreter
     *  refuses these while re-running a `GetLocalPlayer`-gated block for a recipient other than
     *  this machine. Passed in rather than derived: the interpreter is engine-agnostic and must
     *  not learn which natives touch a sim, and the caller already has the answer as the key set
     *  of the table it just composed — computed, so it cannot drift from the table. */
    worldWritingHooks?: Iterable<string>;
    /** Which of `hooks`' entries write THE VIEW IN FRONT OF THIS MACHINE'S PLAYER — the camera,
     *  the cinematic filter, the letterbox, a ping. Refused in the same re-run, and for a
     *  sharper reason: that pass is being evaluated as somebody who is not sitting here. Same
     *  computed-key-set discipline as `worldWritingHooks`. */
    localViewHooks?: Iterable<string>;
    runMain?: boolean;
    lobby?: { slots: ReadonlyArray<LobbySlot>; localPlayer: number };
    /** The playercolor index the four NEUTRAL players answer `GetPlayerColor` with — the
     *  black swatch, whose index is the install's (render/teamColor.ts `neutralTeamColor`).
     *  Passed in rather than read here: the interpreter never opens the art. */
    neutralColor?: number;
    /** Runtime.blzIndexBase, off the map's own format (MapFormatProfile.blzIndexBase). */
    blzIndexBase?: number;
    /** Called with the booted engine BEFORE config()/main() run, so the host can publish
     *  it (e.g. a hook that needs the interpreter's seeded RNG — ChooseRandomItem, 7.18)
     *  while the script is still initialising. Waiting for the return value is too late:
     *  main() has already run by then. */
    onBoot?: (engine: MapScriptEngine) => void;
  } = {},
): MapScriptEngine | null {
  const mapJ = readScript(map, "war3map.j", "scripts\\war3map.j");
  // A map saved by a 1.31+ editor may ship LUA instead (docs/map-compatibility.md): same API,
  // different language. The JASS libraries are loaded either way — a Lua map's BJ calls and
  // common.j constants resolve into them (src/compat/lua/host.ts).
  const mapLua = mapJ ? null : readScript(map, "war3map.lua", "scripts\\war3map.lua");
  if (!mapJ && !mapLua) return null;
  const common = readScript(install, "Scripts\\common.j", "scripts\\common.j");
  const blizzard = readScript(install, "Scripts\\blizzard.j", "Scripts\\Blizzard.j", "scripts\\blizzard.j");
  // common.j/blizzard.j should always be present in a real install; if not, run the
  // map script alone (natives still resolve to safe defaults, so config() partially
  // works — better than nothing).
  const wts = readUtf8(map, "war3map.wts", "scripts\\war3map.wts") ?? undefined;
  // The compatibility prelude goes BETWEEN them (src/compat/prelude.ts): it declares only what
  // a 1.31+ map refers to and this install's common.j has never heard of, so a 2003 map never
  // touches a line of it, and blizzard.j — which is the install's — still loads last of the two.
  const sources = [common, COMPAT_PRELUDE, blizzard, mapJ].filter((s): s is string => s !== null);
  const interp = buildInterpreter(sources, {
    gameType: opts.melee ? 1 : 4, hooks: opts.hooks,
    worldWritingHooks: opts.worldWritingHooks, localViewHooks: opts.localViewHooks, wts,
    neutralColor: opts.neutralColor,
    blzIndexBase: opts.blzIndexBase,
  });
  const engine: MapScriptEngine = { interp, setup: interp.rt.setup };
  // The Lua chunk runs LAST, after the JASS libraries are in the runtime, because that is what
  // its globals resolve into — and it publishes its own `config`/`main` as host functions, so
  // the two lines below do not care which language the map was written in. A chunk that will
  // not compile is fatal to the SCRIPT and not to the match: the map opens with no triggers,
  // which is the same shape as a JASS map whose main() threw.
  if (mapLua) {
    try {
      const lua = createLuaMapScript(interp, LUA_SEED);
      lua.load(mapLua, "war3map.lua");
      engine.lua = lua;
      console.info(`[lua] war3map.lua loaded — ${lua.functionCount()} map function(s) published`);
    } catch (err) {
      console.warn("[lua] war3map.lua failed to load (the map will run with no triggers):", err);
    }
  }
  opts.onBoot?.(engine);
  interp.run("config", []);
  if (opts.lobby) interp.rt.applyLobby(opts.lobby.slots, opts.lobby.localPlayer);
  if (opts.runMain) {
    // Best-effort: a script error in main() must never abort the match.
    try {
      interp.run("main", []);
    } catch (err) {
      console.warn("[jass] map main() failed (non-fatal):", err);
    }
  }
  return engine;
}
