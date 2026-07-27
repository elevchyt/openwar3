// The cinematic's two engine-side controls: ESC (EVENT_PLAYER_END_CINEMATIC) and the wait
// that paces a conversation (TriggerWaitForSound). Neither is glamorous and both are load-
// bearing — a campaign cinematic is a queue of transmissions separated by waits, so a wait
// that does not wait collapses the whole conversation into one tick.
//
// PART ONE — EVENT_PLAYER_END_CINEMATIC: ESC during a cinematic, and what the map does with it.
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

// ---------------------------------------------------------------------------------------
// PART TWO — TriggerWaitForSound: the wait that paces a conversation.
//
// blizzard.j's WaitForSoundBJ is a one-liner over it, and every campaign cinematic leans on
// it to let a line finish before the next speaker starts. NightElfX01's intro:
//
//     call TransmissionFromUnitWithNameBJ( …, udg_Huntress02, …, gg_snd_S01WatcherOne03, … )
//     call WaitForSoundBJ( gg_snd_S01WatcherOne03, 0.00 )
//     call TransmissionFromUnitWithNameBJ( …, udg_Maiev, … )
//
// Unimplemented, it returned instantly and Maiev's line arrived in the SAME MILLISECOND as
// the Watcher's — which is how the wrong bust ended up under the right name. So what is
// pinned here is that it SUSPENDS, and for how long.
// ---------------------------------------------------------------------------------------

const SOUND_SRC = `
globals
    sound   line  = null
    integer stage = 0
endglobals

// blizzard.j, line for line.
function WaitForSoundBJ takes sound soundHandle, real offset returns nothing
    call TriggerWaitForSound( soundHandle, offset )
endfunction

// The World Editor bakes the file's real length into the script; 1332 ms is the Watcher's
// actual first line (S01WatcherOne03) out of NightElfX01.
function MakeLine takes nothing returns nothing
    set line = CreateSound("Sound\\\\Dialogue\\\\NightElf01x\\\\S01WatcherOne03.mp3", false, false, false, 10, 10, "")
    call SetSoundDuration( line, 1332 )
    set stage = 0
endfunction

// A sound the editor gave no duration — nothing to wait for.
function MakeSilentLine takes nothing returns nothing
    set line = CreateSound("Sound\\\\Dialogue\\\\Nothing.mp3", false, false, false, 10, 10, "")
    set stage = 0
endfunction

function SpeakThenWait takes nothing returns nothing
    call StartSound( line )
    set stage = 1
    call WaitForSoundBJ( line, 0.00 )
    set stage = 2
endfunction

// bj_TIMETYPE_SUB routes here: stop short of the end by \`offset\` seconds.
function SpeakThenWaitShort takes nothing returns nothing
    call StartSound( line )
    set stage = 1
    call WaitForSoundBJ( line, 0.50 )
    set stage = 2
endfunction

// The wait is issued LATE — the line is already part-spoken.
function WaitOnly takes nothing returns nothing
    set stage = 1
    call WaitForSoundBJ( line, 0.00 )
    set stage = 2
endfunction

// Nobody ever played it.
function WaitNeverStarted takes nothing returns nothing
    set stage = 1
    call WaitForSoundBJ( line, 0.00 )
    set stage = 2
endfunction
`;

const si = buildInterpreter([SOUND_SRC]);
const sg = (name) => si.rt.globals.get(name)?.n;
// `adoptWaits` is how a headless caller gets a real trigger THREAD out of a plain call — the
// same adoption the campaign's queued triggers rely on.
const run = (fn) => si.callFunction(fn, [], true);
const tick = (dt) => si.advanceTime(dt);

console.log("\nTriggerWaitForSound parks the thread for the rest of the line");
{
  run("MakeLine");
  run("SpeakThenWait");
  check("the thread stops AT the wait", sg("stage"), 1);
  tick(1.0);
  check("still parked 1.0 s into a 1.332 s line", sg("stage"), 1);
  tick(0.4);
  check("and resumes once the line has played out", sg("stage"), 2);
}

console.log("\nthe offset stops short of the end (blizzard.j's bj_TIMETYPE_SUB)");
{
  run("MakeLine");
  run("SpeakThenWaitShort");
  tick(0.8);
  check("0.8 s in, a 1.332 s line less 0.5 s is not up yet", sg("stage"), 1);
  tick(0.1);
  check("…and at 0.9 s it is", sg("stage"), 2);
}

// A wait of zero is still a WAIT: it parks the thread until the next tick, exactly as
// `TriggerSleepAction(0)` does (and as WC3 does — there is no wait that costs no time). So
// "nothing to wait for" is checked as "resumes on the very next tick", not "never parked".
console.log("\nthe wait is measured from when the line STARTED, not from the call");
{
  run("MakeLine");
  run("SpeakThenWait");
  tick(1.0); // a second of the line has already played
  check("the first wait is still parked", sg("stage"), 1);
  tick(0.4);
  run("WaitOnly"); // a second thread waits on the same, now-finished, line
  tick(0.01);
  check("a line that has already played out holds nobody up", sg("stage"), 2);
}

console.log("\nnothing to wait for");
{
  run("MakeSilentLine");
  run("SpeakThenWait");
  tick(0.01);
  check("a sound with no baked duration holds nobody up", sg("stage"), 2);

  run("MakeLine");
  run("WaitNeverStarted");
  tick(0.01);
  check("nor does one that was never started", sg("stage"), 2);

  run("MakeLine");
  run("WaitNeverStarted");
  check("…though it is still a wait: the thread does yield first", sg("stage"), 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall cinematic checks passed");
process.exit(failed ? 1 : 0);
