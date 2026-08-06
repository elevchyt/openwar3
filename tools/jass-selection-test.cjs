// Selection events — `EVENT_PLAYER_UNIT_SELECTED` / `_DESELECTED` (common.j 24/25, and the
// unit-scoped 57/58), which nothing raised at all before.
//
// Two things separate this family from every other player-unit event, and both are what a hero
// picker is built on:
//
//  1. The registration's player is the one who **SELECTED**, not the unit's owner. Extreme Candy
//     War 2004 registers `TriggerRegisterPlayerSelectionEventBJ` for players 0–4 and 6–10, and
//     its costumes stand on slots **5 and 11** — slots nobody plays. The trigger then checks
//     `GetOwningPlayer(GetTriggerUnit())` itself. Match on the owner the way the other events do
//     and it never fires for anyone.
//  2. A unit is picked on the **second** selection of the same costume, because a double-click
//     REBUILDS the selection (a deselect and a fresh select of a unit already held). That is the
//     engine's half — see RtsController.drainSelectionEvents — and the script half is here: the
//     first event records the choice, the second matches it and hands over the hero.
//
// The map's own shape, boiled down to what the interpreter can be handed directly.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const WC3 = join(REPO, "Warcraft III");
const COMMON_J = readFileSync(join(WC3, "ExtractedData", "merged", "Scripts", "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(WC3, "ExtractedData", "merged", "Scripts", "Blizzard.j"), "latin1");

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// The picker, in the map's own idiom: click once to choose, twice to take it. `Has_Picked` is
// per player (blizzard.j's GetConvertedPlayerId — 1-based), so the array index also proves
// GetTriggerPlayer is the SELECTOR.
const SRC = `
globals
    trigger gg_trg_Pick   = null
    trigger gg_trg_Drop   = null
    unit array Select_Hero
    boolean array Has_Picked
    integer picks         = 0
    integer previews      = 0
    integer drops         = 0
    integer lastPickSlot  = 0
endglobals

function Trig_Pick_Conditions takes nothing returns boolean
    if ( not ( Has_Picked[GetConvertedPlayerId(GetTriggerPlayer())] == false ) ) then
        return false
    endif
    if ( not ( GetOwningPlayer(GetTriggerUnit()) == Player(5) ) ) then
        return false
    endif
    return true
endfunction

function Trig_Pick_Actions takes nothing returns nothing
    if ( GetUnitTypeId(GetTriggerUnit()) == GetUnitTypeId(Select_Hero[GetConvertedPlayerId(GetTriggerPlayer())]) ) then
        set Has_Picked[GetConvertedPlayerId(GetTriggerPlayer())] = true
        set lastPickSlot = GetConvertedPlayerId(GetTriggerPlayer())
        set picks = picks + 1
    else
        set Select_Hero[GetConvertedPlayerId(GetTriggerPlayer())] = GetTriggerUnit()
        set previews = previews + 1
    endif
endfunction

function Trig_Drop_Actions takes nothing returns nothing
    set drops = drops + 1
endfunction

function Setup takes nothing returns nothing
    set gg_trg_Pick = CreateTrigger()
    call TriggerRegisterPlayerSelectionEventBJ( gg_trg_Pick, Player(0), true )
    call TriggerRegisterPlayerSelectionEventBJ( gg_trg_Pick, Player(1), true )
    call TriggerAddCondition( gg_trg_Pick, Condition( function Trig_Pick_Conditions ) )
    call TriggerAddAction( gg_trg_Pick, function Trig_Pick_Actions )

    set gg_trg_Drop = CreateTrigger()
    call TriggerRegisterPlayerSelectionEventBJ( gg_trg_Drop, Player(0), false )
    call TriggerAddAction( gg_trg_Drop, function Trig_Drop_Actions )
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
interp.callFunction("InitBlizzard", []);
const num = (name) => interp.rt.globals.get(name)?.n;

// The costume: owned by slot 5, which nobody is playing. `owner` here is what the bridge hands
// the pump (jassOwnerOf), i.e. the slot as the SCRIPT sees it.
const costume = { id: 41, typeId: "Otch", owner: 5, x: 0, y: 0, facing: 0 };
const other = { id: 42, typeId: "Hpal", owner: 5, x: 0, y: 0, facing: 0 };
const select = (unit, player, selected) => interp.pumpSelectionEvents([{ unit, player, selected }]);

interp.callFunction("Setup", []);

console.log("a costume on a slot nobody plays");
select(costume, 0, true);
check("the first selection previews it", num("previews"), 1);
check("…and does not hand it over", num("picks"), 0);

console.log("\nthe double-click — a deselect and a fresh select of the same unit");
select(costume, 0, false);
select(costume, 0, true);
check("the deselect fired its own trigger", num("drops"), 1);
check("the second selection takes the hero", num("picks"), 1);
check("…for the player who CLICKED, not the unit's owner (GetConvertedPlayerId → slot 0 + 1)", num("lastPickSlot"), 1);

console.log("\nthe rest of the rules");
select(costume, 0, true);
check("a player who has picked cannot pick again", num("picks"), 1);
select(other, 1, true);
select(other, 1, true);
check("a second player runs the same two-step on his own costume", num("picks"), 2);
check("…and it is filed under HIS slot", num("lastPickSlot"), 2);
select(costume, 4, true);
check("a player the trigger never registered raises nothing", num("previews"), 2);

console.log(failed ? `\n${failed} FAILED` : "\nall selection-event checks passed");
process.exit(failed ? 1 : 0);
