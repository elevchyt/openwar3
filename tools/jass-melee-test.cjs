// The melee library's two EVENT-driven actions, proven against the real Blizzard.j.
//
// Six of the eight `Melee*` calls in a melee map's init trigger do their work the moment they
// run (the clock, the purse, the hero caps, the creep clear, the roster, the AI) and are covered
// by the §7.3 headless oracle. The other two arm TRIGGERS and only pay off later:
//
//   MeleeGrantHeroItems  — the first hero a player TRAINS or HIRES carries a Scroll of Town
//                          Portal ('stwp'). Both halves are event registrations:
//                          EVENT_PLAYER_UNIT_TRAIN_FINISH on all 12 slots, and
//                          EVENT_PLAYER_UNIT_SELL on Player(PLAYER_NEUTRAL_PASSIVE) for the
//                          Tavern. Both carry `filterMeleeTrainedUnitIsHeroBJ`, whose whole
//                          body is `IsUnitType(GetFilterUnit(), UNIT_TYPE_HERO)` — so this is
//                          also the test that pins WHICH unit a registration's filter is asked
//                          about. Ask it about the training BUILDING and the filter is never
//                          true: no melee hero ever gets its scroll, which is exactly the bug
//                          this file exists to keep fixed.
//   MeleeStartingAI      — a computer slot is seated by `StartMeleeAI(p, "orc.ai")`, from the
//                          MAP's script. A map that omits the action, and every custom map,
//                          gets no melee AI at all.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync, writeFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const WC3 = join(REPO, "Warcraft III");
const SCRIPT = (name) => readFileSync(join(WC3, "ExtractedData", "merged", "Scripts", name), "latin1");
const COMMON_J = SCRIPT("common.j");
const BLIZZARD_J = SCRIPT("Blizzard.j");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// A hero is a hero because the bridge says so — UNIT_TYPE_HERO is ConvertUnitType(0), and the
// hook is handed the unit's TYPE alongside its sim id (see natives/world.ts IsUnitType).
const HEROES = new Set(["Hamg", "Hmkg", "Obla", "Nfir"]);
const granted = []; // "<unit id>:<item rawcode>" per UnitAddItemById that landed
const startedAI = []; // "<player>:<script>" per StartMeleeAI
const hooks = {
  isUnitType: (_id, unitType, typeId) => unitType === 0 && HEROES.has(typeId),
  createItem: (typeId) => {
    granted.push({ typeId });
    return 900 + granted.length;
  },
  unitAddItem: (unitId) => {
    granted[granted.length - 1].unitId = unitId;
    return true;
  },
  getUnitX: () => 0,
  getUnitY: () => 0,
  startMeleeAI: (player, script) => void startedAI.push(`${player}:${script}`),
};
const scrolls = () => granted.map((g) => `${g.unitId}:${g.typeId}`);

// The map's side of it: one function per melee action, exactly as the World Editor emits them.
const SRC = `
function ProbeTwinkCap takes nothing returns integer
    return bj_MELEE_MAX_TWINKED_HEROES
endfunction
function Trig_Melee_Initialization_Actions takes nothing returns nothing
    call MeleeGrantHeroItems(  )
    call MeleeStartingAI(  )
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { gameType: 1, hooks });
interp.callFunction("InitBlizzard", []);
const rt = interp.rt;

// Two slots playing: 0 human (a person), 1 orc (a computer). MeleeStartingAI keeps the computer.
rt.applyLobby(
  [
    { index: 0, raceIndex: 1, controller: 0, team: 0, startLocation: -1 }, // MAP_CONTROL_USER
    { index: 1, raceIndex: 2, controller: 1, team: 1, startLocation: -1 }, // MAP_CONTROL_COMPUTER
  ],
  0,
);
interp.callFunction("Trig_Melee_Initialization_Actions", []);

// --- MeleeStartingAI ------------------------------------------------------------------------
// Only the computer, and by the .ai file its RACE names — `elf.ai`, not `nightelf.ai`, is the
// one that catches a table written from the race names instead of Blizzard's.
check("MeleeStartingAI seats only the computer slot, by its race's script", startedAI, ["1:orc.ai"]);

// --- MeleeGrantHeroItems --------------------------------------------------------------------
// TFT hands ONE hero the scroll (bj_MELEE_MAX_TWINKED_HEROES_V1 = 1); Reign of Chaos handed three.
check("TFT twinks one hero per player", interp.callFunction("ProbeTwinkCap", []).n, 1);

const at = (id, typeId, owner) => ({ id, typeId, owner, x: 0, y: 0, facing: 0 });
const barracks = at(3, "hbar", 0);
const altar = at(4, "halt", 0);

// A trained HERO — the registration's filter is asked about the unit that walked out, not about
// the altar it walked out of.
interp.pumpTrainEvents([{ building: altar, unitTypeId: "Hamg", trained: at(7, "Hamg", 0), phase: "finish" }]);
check("the first hero trained gets a Scroll of Town Portal", scrolls(), ["7:stwp"]);

// …and nothing else does. A footman is not a hero; a second hero is past the cap.
interp.pumpTrainEvents([{ building: barracks, unitTypeId: "hfoo", trained: at(8, "hfoo", 0), phase: "finish" }]);
check("a trained footman gets nothing", scrolls(), ["7:stwp"]);
interp.pumpTrainEvents([{ building: altar, unitTypeId: "Hmkg", trained: at(9, "Hmkg", 0), phase: "finish" }]);
check("the player's second hero gets nothing", scrolls(), ["7:stwp"]);

// A TRAIN_START has no trained unit yet (only a type), so it must not reach the action at all.
interp.pumpTrainEvents([{ building: altar, unitTypeId: "Hamg", trained: null, phase: "start" }]);
check("a train START grants nothing", scrolls(), ["7:stwp"]);

// The other half: a hero HIRED at a Tavern. EVENT_PLAYER_UNIT_SELL is filed under the SHOP's
// owner — Neutral Passive — and the filter is asked about GetSoldUnit.
const tavern = at(20, "ntav", 15); // PLAYER_NEUTRAL_PASSIVE
interp.pumpSellUnitEvents([{ shop: tavern, sold: at(21, "Nfir", 1) }]);
check("a hero hired at a Tavern gets player 1's scroll", scrolls(), ["7:stwp", "21:stwp"]);
interp.pumpSellUnitEvents([{ shop: tavern, sold: at(22, "Hmkg", 1) }]);
check("player 1's second hire gets nothing", scrolls(), ["7:stwp", "21:stwp"]);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall melee-library checks passed");
process.exit(failed ? 1 : 0);
