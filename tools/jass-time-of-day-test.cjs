// `TriggerRegisterGameStateEvent(t, GAME_STATE_TIME_OF_DAY, op, hour)` — EVENT_GAME_STATE_LIMIT,
// "Game - The in-game time of day becomes Equal to 6.00". A scenario keys its day on it: a
// hero picker that gives everyone still undecided a random hero at dawn, a curse that strikes
// at dusk. The registration used to be accepted and never raised.
//
// The clock is CONTINUOUS, so EQUAL is a crossing — the event fires on the tick the clock passes
// the value (midnight wrap included), once, and not while the clock merely sits near it. The
// other comparisons fire on their rising edge like the other thresholds, and a clock the script
// SET by more than an hour crosses nothing on its way.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const SCRIPTS = requireInstallScripts("common.j", "Blizzard.j");
const COMMON_J = readFileSync(join(SCRIPTS, "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(SCRIPTS, "Blizzard.j"), "latin1");

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const SRC = `
globals
    integer dawn = 0
    integer dusk = 0
    integer night = 0
    integer gone = 0
endglobals
function OnDawn takes nothing returns nothing
    set dawn = dawn + 1
endfunction
function OnDusk takes nothing returns nothing
    set dusk = dusk + 1
endfunction
function OnNight takes nothing returns nothing
    set night = night + 1
endfunction
function OnGone takes nothing returns nothing
    set gone = gone + 1
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterGameStateEvent( t, GAME_STATE_TIME_OF_DAY, EQUAL, 6.00 )
    call TriggerAddAction( t, function OnDawn )
    set t = CreateTrigger()
    call TriggerRegisterGameStateEvent( t, GAME_STATE_TIME_OF_DAY, EQUAL, 0.00 )
    call TriggerAddAction( t, function OnDusk )
    set t = CreateTrigger()
    call TriggerRegisterGameStateEvent( t, GAME_STATE_TIME_OF_DAY, GREATER_THAN_OR_EQUAL, 18.00 )
    call TriggerAddAction( t, function OnNight )
    // An INTEGER game state is not the clock: compared against the hour, 'disconnected < 100'
    // would hold from the first pump.
    set t = CreateTrigger()
    call TriggerRegisterGameStateEvent( t, GAME_STATE_DISCONNECTED, LESS_THAN, 100.00 )
    call TriggerAddAction( t, function OnGone )
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks: {} });
const g = (n) => interp.rt.globals.get(n)?.n;
interp.callFunction("Setup", []);
const tick = (from, to) => interp.pumpGameStates(from, to);

console.log("EQUAL is a crossing of the clock");
tick(5.9, 5.95);
check("not yet at 5.95", g("dawn"), 0);
tick(5.95, 6.02);
check("the tick that passes 6.00 raises it", g("dawn"), 1);
tick(6.02, 6.09);
check("…once: the next tick does not", g("dawn"), 1);
tick(23.97, 0.03);
check("midnight is crossed on the wrap", g("dusk"), 1);

console.log("\na clock the script SET crosses nothing");
tick(2.0, 7.0);
check("a jump from 2:00 to 7:00 is not dawn", g("dawn"), 1);
tick(7.0, 6.0);
check("…but landing exactly on 6:00 is", g("dawn"), 2);

console.log("\na clock STOPPED on the value has arrived once, not every pump");
tick(5.5, 6.0);
check("arriving on 6:00 is dawn", g("dawn"), 3);
for (let i = 0; i < 60; i++) tick(6.0, 6.0);
check("…and sixty pumps of a suspended 6:00 are not sixty more", g("dawn"), 3);

console.log("\nonly the TIME OF DAY is a clock");
tick(1.0, 1.01);
tick(1.01, 1.02);
check("a GAME_STATE_DISCONNECTED registration is not compared against the hour", g("gone"), 0);

console.log("\nthe other comparisons fire on their rising edge");
tick(17.9, 17.95);
check("before 18:00 nothing", g("night"), 0);
tick(17.95, 18.01);
check("crossing into >= 18 fires", g("night"), 1);
tick(18.01, 18.05);
check("…and staying there does not again", g("night"), 1);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall time-of-day checks passed");
process.exit(failed ? 1 : 0);
