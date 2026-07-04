import type { MpqDataSource } from "../vfs/mpq";

// Reading a map's triggers (plan Phase 7 — this is the first step).
//
// Warcraft III compiles every map's triggers — whether authored in the World
// Editor's GUI or hand-written JASS — into ONE script the engine actually runs:
//   • war3map.j    — JASS (our target, 1.27a)
//   • war3map.lua  — Lua  (Reforged 1.31+)
// The GUI trigger tree also persists as war3map.wtg (structure/variables) +
// war3map.wct (custom text), but those exist only to re-open the map in the
// editor — the game never reads them; it runs the compiled script. So to
// "understand a map's triggers" we read the compiled script, not the .wtg/.wct.
//
// A map's script always exposes two entry points the engine calls:
//   config() — SetPlayers/SetTeams/DefineStartLocation/player-slot setup
//   main()   — camera/day-night/sound, then CreateAllUnits(), InitBlizzard(),
//              InitGlobals(), InitCustomTriggers(), RunInitializationTriggers()
// For a MELEE map the World Editor emits a "Melee Initialization" trigger whose
// actions call the standard Blizzard melee library (MeleeStartingUnits, etc.);
// a custom map runs its own trigger logic instead. We don't execute the script
// yet — this module just reads it and detects the melee-init calls so callers
// can tell melee from custom (see src/world/mapKind.ts) and so a future JASS/Lua
// interpreter has the source in hand.

export type ScriptLanguage = "jass" | "lua" | "none";

/** The standard "Melee Initialization" library functions the editor emits into
 *  war3map.j for a melee map (from Blizzard's blizzard.j melee library; called
 *  out of the map's init trigger via RunInitializationTriggers). Verified
 *  present in all 148 bundled 1.27a stock melee maps and absent from Scenario
 *  maps — see the classifyMap verification note. */
export const MELEE_INIT_FUNCS = [
  "MeleeStartingVisibility",
  "MeleeStartingHeroLimit",
  "MeleeGrantHeroItems",
  "MeleeStartingResources",
  "MeleeClearExcessUnits",
  "MeleeStartingUnits",
  "MeleeStartingAI",
  "MeleeInitVictoryDefeat",
] as const;

export interface MapScript {
  /** Which compiled script the engine would run (`"none"` if the map ships neither). */
  language: ScriptLanguage;
  /** Raw war3map.j / war3map.lua text (`""` if absent). The seam for Phase 7. */
  source: string;
  /** war3map.wtg present — i.e. the triggers were authored in the GUI editor. */
  hasGuiTriggers: boolean;
  /** Which of the standard Melee* init calls appear in the script (diagnostics). */
  meleeFuncs: string[];
}

/** Read a map's compiled trigger script and scan it for the standard melee-init
 *  calls. Handles both the 1.27a layout (war3map.j at the archive root) and the
 *  Reforged layout (scripts\war3map.lua / scripts\war3map.j). */
export function readMapScript(mpq: MpqDataSource): MapScript {
  const jass = mpq.rawBytes("war3map.j") ?? mpq.rawBytes("scripts\\war3map.j");
  const lua = mpq.rawBytes("war3map.lua") ?? mpq.rawBytes("scripts\\war3map.lua");
  const bytes = jass ?? lua;
  const language: ScriptLanguage = jass ? "jass" : lua ? "lua" : "none";
  // JASS/Lua source is ASCII with the odd Latin-1 byte in string literals;
  // windows-1252 decodes it without throwing (matches slkText elsewhere).
  const source = bytes ? new TextDecoder("windows-1252").decode(bytes) : "";
  const meleeFuncs = MELEE_INIT_FUNCS.filter((fn) => source.includes(fn));
  return {
    language,
    source,
    hasGuiTriggers: mpq.exists("war3map.wtg"),
    meleeFuncs,
  };
}
