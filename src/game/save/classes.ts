// SAVED GAMES (issue #159) — every class whose instances can be part of a match's state, named
// for the codec (graph.ts `registerSaveClass`), with the fields of each that are NOT state.
//
// Why a list: a minified build renames `constructor.name`, so a class is written under the word
// it is registered with here. A class missing from this list still saves — under `?Name`, which
// `encodeGraph`'s stats report — and the save tests fail on any such name, so the list cannot
// quietly fall behind the code.
//
// A TRANSIENT field is one the loaded match already has the right value for, because it is not
// part of the match: a static table the script was parsed into, a hook into the renderer, a
// cache that refills itself. It is written as a marker and the loaded object keeps its own.

import { registerSaveClass } from "./graph";
import { Frame, Interpreter, type SavedThreads } from "../../jass/interpreter";
import { HandleTable, JassArray, Mulberry32, Runtime } from "../../jass/runtime";
import { SimWorld } from "../../sim/world";
import { Mulberry32Stream, ParkMillerStream } from "../../sim/streams";
import { PathingGrid } from "../../sim/pathing";
import { TechState } from "../../sim/tech";
import { MatchStats } from "../../sim/matchStats";
import { BlightGrid } from "../../sim/blight";
import { AllianceTable } from "../../sim/alliances";
import { SightStamps, VisionMap } from "../../sim/vision";
import { Viewpoint, VisionSet } from "../viewpoint";
import { GhostMemory } from "../ghosts";
import { Authority } from "../authority";
import { ApmMeter } from "../apm";
import { PlacedIndex } from "../placement";
import { CreepCamps } from "../minimapView";
import { CreepCaster, CreepView } from "../../ai/creeps";
import { AiCaster } from "../../ai/casting";
import { AiPlayer } from "../../ai/aiPlayer";
import { MeleeAi } from "../../ai/index";
import { GuardPosts, ScriptAi, ScriptCaptain, ScriptSeat } from "../../ai/scriptAi";
import { ComputerPlusAi } from "../../ai/plus/index";
import { PlusItems } from "../../ai/plus/items";
import { PlusCaster } from "../../ai/plus/casting";
import { EnemyMemory } from "../../ai/plus/counter";
import { CandyWarAi } from "../../ai/plus/candy/index";
import { WarChasersAi } from "../../ai/plus/warchasers/index";
import { GrandPrixAi } from "../../ai/plus/grandprix/index";

let done = false;

export function registerSaveClasses(): void {
  if (done) return;
  done = true;
  // --- the JASS VM ---------------------------------------------------------------------------------
  registerSaveClass("jass.Runtime", Runtime, [
    // The SCRIPT: parsed from the map's own file, which the loaded match parses again.
    "functions", "natives", "nativeReturns", "hostFunctions", "trigStrings", "recordOnlySpawnFns",
    // The engine bridge, and its muzzled twin — the renderer's and the sim's, not the script's.
    "engineHooks", "muzzled", "worldWritingHooks", "localViewHooks",
  ]);
  registerSaveClass("jass.HandleTable", HandleTable);
  registerSaveClass("jass.JassArray", JassArray);
  registerSaveClass("jass.Mulberry32", Mulberry32);
  registerSaveClass("jass.Frame", Frame);
  // The VM itself: its threads are written as their TRACES (interpreter.ts `TraceRec`) where the
  // generators are, and rebuilt on load once the runtime they name is back.
  registerSaveClass<Interpreter>("jass.Interpreter", Interpreter, ["globalDecls", "ctx", "waitCache"], {
    save: (vm) => ({ threads: vm.captureThreads() }),
    load: (vm) => vm.restoreThreads((vm as unknown as { threads: SavedThreads }).threads),
  });

  // --- the world -----------------------------------------------------------------------------------
  // `jobScratch` is a path search's working set (pathfind.ts PathScratch) — scratch; a search in
  // flight is landed before a save is taken (SimWorld.settleForSave), so there is none to keep.
  registerSaveClass("sim.SimWorld", SimWorld, ["jobScratch", "arrowBlow", "auraCells", "auraLoose", "auraScratch"]);
  registerSaveClass("sim.PathingGrid", PathingGrid);
  registerSaveClass("sim.TechState", TechState);
  registerSaveClass("sim.MatchStats", MatchStats);
  registerSaveClass("sim.BlightGrid", BlightGrid);
  registerSaveClass("sim.AllianceTable", AllianceTable);
  // The sight footprints are a CACHE of the terrain (docs: "Fog rebuild" in CLAUDE.md) — exact
  // either way, so the loaded match keeps its own, empty one and fills it again.
  registerSaveClass("sim.VisionMap", VisionMap, ["stamps"]);
  registerSaveClass("sim.SightStamps", SightStamps);
  registerSaveClass("sim.ParkMillerStream", ParkMillerStream);
  registerSaveClass("sim.Mulberry32Stream", Mulberry32Stream);

  // --- the controller's books ----------------------------------------------------------------------
  // A TEAM's viewpoint (the creeps') is made lazily, on the first question about it, so a loaded
  // match may need one its own start never made — written from its prototype, with none of the
  // wiring a constructor gives. The two load hooks give it back: the seat lookup's default (a
  // team viewpoint answers no seat) and the set's shared sight-footprint cache.
  registerSaveClass<Viewpoint>("game.Viewpoint", Viewpoint, ["seatedTeam"], {
    load: (vp) => {
      const w = vp as unknown as { seatedTeam?: unknown };
      if (typeof w.seatedTeam !== "function") w.seatedTeam = () => undefined;
    },
  });
  // …and the set's own footprint cache (the same SightStamps, shared by every viewpoint).
  registerSaveClass<VisionSet>("game.VisionSet", VisionSet, ["stamps"], {
    load: (set) => {
      const s = set as unknown as { stamps: SightStamps; byPlayer: Map<number, Viewpoint>; byTeam: Map<number, Viewpoint> };
      for (const vp of [...s.byPlayer.values(), ...s.byTeam.values()]) vp.setSightStamps(s.stamps);
    },
  });
  registerSaveClass("game.GhostMemory", GhostMemory);
  registerSaveClass("game.Authority", Authority);
  registerSaveClass("game.ApmMeter", ApmMeter);
  registerSaveClass("game.PlacedIndex", PlacedIndex);
  registerSaveClass("game.CreepCamps", CreepCamps);

  // --- the computers -------------------------------------------------------------------------------
  registerSaveClass("ai.CreepCaster", CreepCaster);
  registerSaveClass("ai.CreepView", CreepView);
  registerSaveClass("ai.AiCaster", AiCaster);
  registerSaveClass("ai.AiPlayer", AiPlayer);
  registerSaveClass("ai.MeleeAi", MeleeAi);
  registerSaveClass("ai.ScriptAi", ScriptAi);
  registerSaveClass("ai.ScriptSeat", ScriptSeat);
  registerSaveClass("ai.ScriptCaptain", ScriptCaptain);
  registerSaveClass("ai.GuardPosts", GuardPosts);
  registerSaveClass("ai.ComputerPlusAi", ComputerPlusAi);
  registerSaveClass("ai.PlusItems", PlusItems);
  // `ctx` is the caster's per-PASS context, handed in afresh at the top of every pass.
  registerSaveClass("ai.PlusCaster", PlusCaster, ["ctx"]);
  registerSaveClass("ai.EnemyMemory", EnemyMemory);
  registerSaveClass("ai.CandyWarAi", CandyWarAi);
  registerSaveClass("ai.WarChasersAi", WarChasersAi);
  // The racing line and each seat's speed limit down it are CACHES of map data, found again on
  // the first look after a load; `port` is the scene's closures onto the script, handed in afresh.
  registerSaveClass("ai.GrandPrixAi", GrandPrixAi, ["route", "routeTried", "plans", "port"]);
}
