// `TriggerRegisterPlayerStateEvent` — EVENT_PLAYER_STATE_LIMIT, a tower defence's wave clock.
//
// A round-based map does not count its creeps. It asks the ENGINE how much food the monster
// player is using, and calls the round over when that reaches zero. Azure Tower Defense's entire
// round loop is one registration:
//
//     call TriggerRegisterPlayerStateEvent( gg_trg_Monster_Spawning, Player(10),
//                                           PLAYER_STATE_RESOURCE_FOOD_USED, EQUAL, 0.00 )
//
// and its action ends with `TriggerExecute( gg_trg_Spawn_1 )`. Nothing else ever runs that
// trigger after the one-shot 60s opening timer — so with the native missing the registration
// was dropped on the floor and the map stopped dead the moment wave 1 was cleared. It reads
// exactly like a hang: the round-2 countdown never appears, because the trigger that starts
// the countdown is the trigger that never fires.
//
// Two properties are what make it usable, and both are checked below:
//
//   • it is POLLED (nothing in the sim announces "food used changed"), and
//   • it fires on the RISING EDGE, seeded at registration.
//
// The seed is not a detail. "Food used == 0" is true at map init and true for the whole gap
// between waves, so a level-triggered version fires at map start — before anything has spawned —
// and then again every tick of the countdown it just started.
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

// The map's own shape, trimmed to the loop: a re-entrancy flag, a round counter, and the
// registration. `Spawner` is Azure's own guard — the tell that Blizzard's designers expected an
// EDGE and not a level, since the comparison stays true for the whole gap between waves.
const SRC = `
globals
    trigger gg_trg_Round = null
    integer udg_Round    = 0
    boolean udg_Spawner  = true
    integer sawPlayer    = -1
endglobals

function Trig_Round_Actions takes nothing returns nothing
    if ( udg_Spawner == false ) then
        return
    endif
    set udg_Spawner = false
    set udg_Round = ( udg_Round + 1 )
    set sawPlayer = GetPlayerId(GetTriggerPlayer())
    // the real map waits 30s here, then sets Spawner back to true and spawns the wave
    set udg_Spawner = true
endfunction

function Setup takes nothing returns nothing
    set gg_trg_Round = CreateTrigger()
    call TriggerRegisterPlayerStateEvent( gg_trg_Round, Player(10), PLAYER_STATE_RESOURCE_FOOD_USED, EQUAL, 0.00 )
    call TriggerAddAction( gg_trg_Round, function Trig_Round_Actions )
endfunction
`;

// The one piece of live state the poll reads — the same hook GetPlayerState uses, so the script
// and the poll cannot disagree about the number (jassHooks: 4 = food cap, 5 = food used).
const food = new Map([[10, 0]]);
const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], {
  hooks: { getPlayerState: (p, state) => (state === 5 ? food.get(p) ?? 0 : 0) },
});
interp.callFunction("InitBlizzard", []);
const num = (name) => interp.rt.globals.get(name)?.n;
const setFood = (n) => food.set(10, n);
const tick = () => interp.pumpPlayerStates();

console.log("the registration is seeded, so a comparison that already holds is not news");
interp.callFunction("Setup", []); // food used is 0 right now — the condition holds at birth
check("registering it did not fire it", num("udg_Round"), 0);
tick();
check("…and neither does a tick with nothing having changed", num("udg_Round"), 0);

console.log("\nwave 1: creeps spawn, then die");
setFood(24); // Spawn_1 created the wave
tick();
check("a wave in the field does not start the next round", num("udg_Round"), 0);
setFood(8);
tick();
check("…nor does killing SOME of it", num("udg_Round"), 0);
setFood(0); // the last creep dies
tick();
check("the last creep dying starts round 1", num("udg_Round"), 1);
check("…with GetTriggerPlayer set to the monster player", num("sawPlayer"), 10);

console.log("\n…and it is an EDGE, not a level");
tick();
tick();
check("the countdown's own ticks do not re-run the round trigger", num("udg_Round"), 1);

console.log("\nwave 2 does the same thing again");
setFood(30);
tick();
setFood(0);
tick();
check("the loop keeps going — this is the part that was hanging", num("udg_Round"), 2);

console.log("\na state the script never registered is not polled into existence");
{
  // GOLD is state 1; the hook above answers 0 for it, which would satisfy `EQUAL 0` every tick
  // if the registration's playerstate were ignored.
  const gold = buildInterpreter([COMMON_J, BLIZZARD_J, `
globals
    trigger t     = null
    integer fires = 0
endglobals
function A takes nothing returns nothing
    set fires = fires + 1
endfunction
function Setup2 takes nothing returns nothing
    set t = CreateTrigger()
    call TriggerRegisterPlayerStateEvent( t, Player(10), PLAYER_STATE_RESOURCE_GOLD, GREATER_THAN, 500.00 )
    call TriggerAddAction( t, function A )
endfunction
`], { hooks: { getPlayerState: (p, state) => (state === 5 ? food.get(p) ?? 0 : 0) } });
  gold.callFunction("InitBlizzard", []);
  gold.callFunction("Setup2", []);
  gold.pumpPlayerStates();
  gold.pumpPlayerStates();
  check("a gold threshold that never crosses stays quiet", gold.rt.globals.get("fires")?.n, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall player-state event checks passed");
process.exit(failed ? 1 : 0);
