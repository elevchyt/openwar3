// A one-shot timer that has RUN OUT reads zero, and its handler may re-arm it.
//
// Two facts about an expiring timer, both of which the interpreter got wrong in the same loop:
//
//   1. `TimerGetRemaining` on a spent one-shot is 0 — not the overshoot of the step it expired
//      in. The game clock advances in sim steps (1/60 s here), so the timer always crosses zero
//      by a fraction of a step, and that fraction is our granularity, not time it has left.
//      DotA v6.77b AI starts the GAME on `if TimerGetRemaining(PL4)==0`, polled every 0.25 s by
//      its countdown trigger: with −0.0067 left over the countdown never ended, so there was no
//      game clock, no creep wave and no lane push, ever.
//   2. The handler of a one-shot can START IT AGAIN (`TimerStart(GetExpiredTimer(), …)`) — a
//      standard idiom — and that restart must stick. The timer was switched off AFTER its
//      handler had run, which stopped the very timer the handler had just started.
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

const SRC = `
globals
    timer countdown       = null
    boolean started       = false
    integer polls         = 0
    timer again           = null
    integer fired         = 0
    real seenInHandler    = -1.
endglobals

// DotA's countdown, reduced: a one-shot runs out, a 0.25 s poll waits for it to read zero.
function Poll takes nothing returns boolean
    set polls = polls + 1
    if TimerGetRemaining(countdown) == 0 then
        set started = true
        call DisableTrigger(GetTriggeringTrigger())
    endif
    return false
endfunction

function StartCountdown takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterTimerEvent(t, 0.25, true)
    call TriggerAddCondition(t, Condition(function Poll))
    set countdown = CreateTimer()
    call TimerStart(countdown, 1.0, false, null)
endfunction

// A one-shot that restarts itself from inside its own handler, twice.
function Again takes nothing returns nothing
    set fired = fired + 1
    set seenInHandler = TimerGetRemaining(GetExpiredTimer())
    if fired < 3 then
        call TimerStart(GetExpiredTimer(), 0.5, false, function Again)
    endif
endfunction

function StartAgain takes nothing returns nothing
    set again = CreateTimer()
    call TimerStart(again, 0.5, false, function Again)
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
interp.callFunction("InitBlizzard", []);
const g = (name) => interp.rt.globals.get(name);
const step = 1 / 60; // the sim step the match pumps the script with
const run = (seconds) => { for (let t = 0; t < seconds; t += step) interp.advanceTime(step); };

console.log("a spent one-shot reads zero");
interp.callFunction("StartCountdown", []);
run(0.9);
check("still counting down at 0.9 s", g("started")?.b, false);
run(0.5);
const countdown = interp.rt.data(g("countdown"));
check("TimerGetRemaining is exactly 0 once it has run out", countdown?.remaining, 0);
check("…so the poll that waits for 0 sees it (DotA's game start)", g("started")?.b, true);
check("…and TimerGetElapsed stops at the timeout rather than past it", countdown?.elapsedTotal, 1);

console.log("\na handler may re-arm its own one-shot");
interp.callFunction("StartAgain", []);
run(2);
check("it fired three times — each restart in the handler stuck", g("fired")?.n, 3);
check("…and inside the handler the spent timer read zero", g("seenInHandler")?.r ?? g("seenInHandler")?.n, 0);
check("after the last firing it is stopped", interp.rt.data(g("again"))?.running, false);

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\ntimer expiry: all checks passed");
