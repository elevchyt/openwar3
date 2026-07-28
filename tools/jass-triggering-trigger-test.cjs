// `GetTriggeringTrigger()` inside a trigger the SCRIPT ran — the World Editor's run-once idiom.
//
// A trigger executed by `TriggerExecute` / `ConditionalTriggerExecute` / `TriggerEvaluate` is
// "the triggering trigger" for the duration, exactly as an evented one is. That is not a nicety:
// it is what lets generated code refer to itself without a global, and the editor emits the same
// matched pair at the top of nearly every one-shot trigger it writes —
//
//     function Trig_X_Conditions takes nothing returns boolean
//         if ( not ( IsTriggerEnabled(GetTriggeringTrigger()) == true ) ) then
//             return false
//         endif
//         return true
//     endfunction
//     function Trig_X_Actions takes nothing returns nothing
//         call DisableTrigger( GetTriggeringTrigger() )
//         …
//
// With no response on the stack the condition asks `IsTriggerEnabled(null)`, which is false, and
// the trigger simply never runs. Rise of the Naga creates all four of its quests through exactly
// that pair, which is how this was found: an empty quest log on chapter one.
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
    trigger gg_trg_Create = null
    trigger gg_trg_Init   = null
    integer runs          = 0
    boolean sawSelf       = false
endglobals

function Trig_Create_Conditions takes nothing returns boolean
    if ( not ( IsTriggerEnabled(GetTriggeringTrigger()) == true ) ) then
        return false
    endif
    return true
endfunction

function Trig_Create_Actions takes nothing returns nothing
    call DisableTrigger( GetTriggeringTrigger() )
    set sawSelf = ( GetTriggeringTrigger() == gg_trg_Create )
    set runs = runs + 1
endfunction

function Trig_Init_Actions takes nothing returns nothing
    // The nesting a real map uses: an init trigger running the create triggers one by one.
    call ConditionalTriggerExecute( gg_trg_Create )
endfunction

function Setup takes nothing returns nothing
    set gg_trg_Create = CreateTrigger()
    call TriggerAddCondition( gg_trg_Create, Condition( function Trig_Create_Conditions ) )
    call TriggerAddAction( gg_trg_Create, function Trig_Create_Actions )
    set gg_trg_Init = CreateTrigger()
    call TriggerAddAction( gg_trg_Init, function Trig_Init_Actions )
endfunction

function RunInit takes nothing returns nothing
    call ConditionalTriggerExecute( gg_trg_Init )
endfunction

function Evaluated takes nothing returns boolean
    return TriggerEvaluate( gg_trg_Create )
endfunction
`;

const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
interp.callFunction("InitBlizzard", []);
const num = (name) => interp.rt.globals.get(name)?.n;
const bool = (name) => interp.rt.globals.get(name)?.b;

console.log("the editor's run-once pair, nested one trigger deep");
interp.callFunction("Setup", []);
interp.callFunction("RunInit", []);
check("the create trigger ran", num("runs"), 1);
check("…and GetTriggeringTrigger was ITSELF, not the init trigger that ran it", bool("sawSelf"), true);

console.log("\n…and it really is run-once");
interp.callFunction("RunInit", []);
check("a second pass is refused — DisableTrigger reached the right trigger", num("runs"), 1);
check("TriggerEvaluate sees the same response, so it reports the disabled trigger's own state",
  interp.callFunction("Evaluated", [])?.b, false);

console.log(failed ? `\n${failed} FAILED` : "\nall GetTriggeringTrigger checks passed");
process.exit(failed ? 1 : 0);
