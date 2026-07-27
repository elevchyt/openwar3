// EVENT_PLAYER_END_CINEMATIC — ESC during a cinematic, and what the map does with it.
//
// The engine's whole job here is to RAISE the event for the local player; what "skip" means is
// the map's. So the thing that has to stay true is the match rule, and the campaign's own idiom
// is what makes it easy to get wrong. NightElfX01 (Rise of the Naga), verbatim:
//
//     set gg_trg_Intro_Skipped = CreateTrigger(  )
//     call DisableTrigger( gg_trg_Intro_Skipped )
//     call TriggerRegisterPlayerEventEndCinematic( gg_trg_Intro_Skipped, Player(0) )
//     call TriggerAddAction( gg_trg_Intro_Skipped, function Trig_Intro_Skipped_Actions )
//
// — created DISABLED, enabled by the intro trigger the moment its own comment says "CINEMATIC
// BEGINS - Cinematic Can Now Be Skipped", and disabled again by the cleanup. Its action's first
// line is `DisableTrigger( GetTriggeringTrigger() )`, so a second ESC during the fade-out cannot
// run the skip twice. A raiser that ignored `enabled` would therefore skip a cinematic that had
// not started, or run the whole teardown twice on a double tap.
//
// `TriggerRegisterPlayerEventEndCinematic` is blizzard.j's one-liner over
// `TriggerRegisterPlayerEvent(trig, whichPlayer, EVENT_PLAYER_END_CINEMATIC)` — declared here
// exactly as blizzard.j declares it, so what is under test is the path the campaign takes.
//
// Headless: none of this needs a browser, and all of it needs to stay true.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// common.j's own indices (ConvertPlayerEvent): END_CINEMATIC is 17, LEAVE is 15.
const END_CINEMATIC = 17;
const PLAYER_LEAVE = 15;

const SRC = `
globals
    constant playerevent EVENT_PLAYER_LEAVE         = ConvertPlayerEvent(15)
    constant playerevent EVENT_PLAYER_END_CINEMATIC = ConvertPlayerEvent(17)
    trigger skipTrig = null
    integer hits     = 0
    integer who      = -1
endglobals

// blizzard.j, line for line.
function TriggerRegisterPlayerEventEndCinematic takes trigger trig, player whichPlayer returns event
    return TriggerRegisterPlayerEvent(trig, whichPlayer, EVENT_PLAYER_END_CINEMATIC)
endfunction

// The campaign's action opens by disabling itself — one skip per cinematic.
function OnSkip takes nothing returns nothing
    call DisableTrigger( GetTriggeringTrigger() )
    set hits = hits + 1
    set who  = GetPlayerId(GetTriggerPlayer())
endfunction

function Setup takes nothing returns nothing
    set skipTrig = CreateTrigger()
    call DisableTrigger( skipTrig )
    call TriggerRegisterPlayerEventEndCinematic( skipTrig, Player(0) )
    call TriggerAddAction( skipTrig, function OnSkip )
endfunction

function Enable takes nothing returns nothing
    call EnableTrigger( skipTrig )
endfunction

function Reset takes nothing returns nothing
    set hits = 0
    set who  = -1
endfunction
`;

const interp = buildInterpreter([SRC]);
const g = (name) => interp.rt.globals.get(name);
const esc = (player, event = END_CINEMATIC) => interp.firePlayerEvent(player, event);
const reset = () => interp.callFunction("Reset", []);

interp.callFunction("Setup", []);

console.log("a skip trigger that the map has not enabled yet");
{
  reset();
  esc(0);
  check("ESC before the cinematic begins does nothing (the trigger is created DISABLED)", g("hits")?.n, 0);
}

console.log("\nonce the map enables it — the cinematic is skippable");
{
  interp.callFunction("Enable", []);
  reset();
  esc(0);
  check("ESC fires the map's skip trigger", g("hits")?.n, 1);
  check("GetTriggerPlayer is who pressed it", g("who")?.n, 0);

  esc(0);
  check("a second ESC does nothing — the action disabled its own trigger", g("hits")?.n, 1);
}

console.log("\nthe registration names ONE player and ONE event");
{
  interp.callFunction("Enable", []);
  reset();
  esc(1);
  check("another player's ESC does not fire a registration made for Player(0)", g("hits")?.n, 0);

  esc(0, PLAYER_LEAVE);
  check("a different playerevent on the right player does not fire it either", g("hits")?.n, 0);

  esc(0);
  check("…and the real one still does", g("hits")?.n, 1);
}

console.log("\nnothing registered at all");
{
  reset();
  esc(3);
  check("ESC with no registration is silently dropped, as in the game", g("hits")?.n, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall end-cinematic checks passed");
process.exit(failed ? 1 : 0);
