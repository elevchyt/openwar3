// Trigger INTROSPECTION (docs/map-compatibility.md pass 5): `GetTriggerEventId`, the eval/exec
// counters, and removing one action or condition by its handle.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-trigger-introspection-test.cjs
//
// Driven through the real interpreter and its real pumps against the install's own common.j,
// because every assertion here is about a CONSTANT a map compares against — and the constants
// must be the ones common.j defines, not numbers this file or the engine retyped.
//
// The case that matters most is the first: maps register ONE trigger on SEVERAL events and
// branch on `GetTriggerEventId()` (EVENT_UNIT_DEATH and EVENT_UNIT_DAMAGED on the same trigger
// is the commonest pair in the later-format corpus). So the id belongs to the REGISTRATION that
// matched, and a test that registered one event per trigger would pass an implementation that
// got this wrong.
//
// Reads only the developer's own local install (gitignored; zero shipped assets).

const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src');
if (!existsSync(join(BUILD, 'jass', 'headless.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'jass', 'headless.js'));

const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j.");
  process.exit(2);
}
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const common = decode(readFileSync(join(SCRIPTS, 'common.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};

// Sim ids 1 and 2; the script's CreateUnit is bound to them, so the pumps' snapshots resolve
// to the very handles the registrations were made with.
let nextSim = 1;
const hooks = { createUnit: () => nextSim++ };
const snap = (id) => ({ id, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 });

const SRC = `
globals
    unit u = null
    trigger multi = null
    trigger perPlayer = null
    trigger widget = null
    trigger clock = null
    trigger chat = null
    trigger counted = null
    trigger doubled = null
    trigger selfRemoving = null
    timer tm = null
    integer deaths = 0
    integer damages = 0
    integer unknown = 0
    integer playerDeaths = 0
    integer unitDeathOnPlayerTrigger = 0
    integer widgetDeaths = 0
    integer timerFires = 0
    integer chats = 0
    integer runs = 0
    integer doubledRuns = 0
    integer afterSelf = 0
    integer selfRuns = 0
    boolean pass = false
    triggeraction first = null
    triggeraction selfAction = null
    triggercondition gate = null
endglobals

function OnMulti takes nothing returns nothing
    if GetTriggerEventId() == EVENT_UNIT_DEATH then
        set deaths = deaths + 1
    elseif GetTriggerEventId() == EVENT_UNIT_DAMAGED then
        set damages = damages + 1
    else
        set unknown = unknown + 1
    endif
endfunction
function OnPlayer takes nothing returns nothing
    if GetTriggerEventId() == EVENT_PLAYER_UNIT_DEATH then
        set playerDeaths = playerDeaths + 1
    endif
    // A DIFFERENT constant, even though it is also "a unit died": the two families are
    // numbered apart in common.j and a map that mixes them up must see them as unequal.
    if GetTriggerEventId() == EVENT_UNIT_DEATH then
        set unitDeathOnPlayerTrigger = unitDeathOnPlayerTrigger + 1
    endif
endfunction
function OnWidget takes nothing returns nothing
    if GetTriggerEventId() == EVENT_WIDGET_DEATH then
        set widgetDeaths = widgetDeaths + 1
    endif
endfunction
function OnClock takes nothing returns nothing
    if GetTriggerEventId() == EVENT_GAME_TIMER_EXPIRED then
        set timerFires = timerFires + 1
    endif
endfunction
function OnChat takes nothing returns nothing
    if GetTriggerEventId() == EVENT_PLAYER_CHAT then
        set chats = chats + 1
    endif
endfunction
function Gate takes nothing returns boolean
    return pass
endfunction
function Count takes nothing returns nothing
    set runs = runs + 1
endfunction
function Twice takes nothing returns nothing
    set doubledRuns = doubledRuns + 1
endfunction
function RemoveMe takes nothing returns nothing
    set selfRuns = selfRuns + 1
    call TriggerRemoveAction(selfRemoving, selfAction)
endfunction
function After takes nothing returns nothing
    set afterSelf = afterSelf + 1
endfunction

function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)

    set multi = CreateTrigger()
    call TriggerRegisterUnitEvent(multi, u, EVENT_UNIT_DEATH)
    call TriggerRegisterUnitEvent(multi, u, EVENT_UNIT_DAMAGED)
    call TriggerAddAction(multi, function OnMulti)

    set perPlayer = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(perPlayer, Player(0), EVENT_PLAYER_UNIT_DEATH, null)
    call TriggerAddAction(perPlayer, function OnPlayer)

    set widget = CreateTrigger()
    call TriggerRegisterDeathEvent(widget, u)
    call TriggerAddAction(widget, function OnWidget)

    set tm = CreateTimer()
    set clock = CreateTrigger()
    call TriggerRegisterTimerExpireEvent(clock, tm)
    call TriggerAddAction(clock, function OnClock)
    call TimerStart(tm, 1.0, false, null)

    set chat = CreateTrigger()
    call TriggerRegisterPlayerChatEvent(chat, Player(0), "-go", true)
    call TriggerAddAction(chat, function OnChat)

    set counted = CreateTrigger()
    set gate = TriggerAddCondition(counted, Condition(function Gate))
    call TriggerAddAction(counted, function Count)

    set doubled = CreateTrigger()
    set first = TriggerAddAction(doubled, function Twice)
    call TriggerAddAction(doubled, function Twice)

    set selfRemoving = CreateTrigger()
    set selfAction = TriggerAddAction(selfRemoving, function RemoveMe)
    call TriggerAddAction(selfRemoving, function After)
endfunction

function ExecutedHasNoEvent takes nothing returns boolean
    return GetTriggerEventId() == null
endfunction
function EvalCount takes nothing returns integer
    return GetTriggerEvalCount(counted)
endfunction
function ExecCount takes nothing returns integer
    return GetTriggerExecCount(counted)
endfunction
function Offer takes nothing returns nothing
    call ConditionalTriggerExecute(counted)
endfunction
function OpenGate takes nothing returns nothing
    set pass = true
endfunction
function Reset takes nothing returns nothing
    call ResetTrigger(counted)
endfunction
function DropGate takes nothing returns nothing
    call TriggerRemoveCondition(counted, gate)
    set pass = false
endfunction
function RemoveFirst takes nothing returns nothing
    call TriggerRemoveAction(doubled, first)
endfunction
function RunDoubled takes nothing returns nothing
    call TriggerExecute(doubled)
endfunction
function RunSelfRemoving takes nothing returns nothing
    call TriggerExecute(selfRemoving)
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, SRC], { hooks });
interp.callFunction('Make', []);
[console.info, console.warn] = quiet;
const g = (name) => interp.rt.globals.get(name);
const I = (name) => g(name).n;
const call = (fn) => interp.callFunction(fn, []);

console.log('--- one trigger, two events: the id is the REGISTRATION\'s ---');
interp.pumpDamageEvents([{ target: snap(1), source: null, amount: 10 }]);
interp.pumpDamageEvents([{ target: snap(1), source: null, amount: 10 }]);
interp.pumpUnitDeaths([{ victim: snap(1), killer: null }]);
check('two damage events read EVENT_UNIT_DAMAGED', I('damages'), 2);
check('the death on the same trigger reads EVENT_UNIT_DEATH', I('deaths'), 1);
check('…and nothing fell through to neither', I('unknown'), 0);

console.log('\n--- the families are numbered apart, and stay apart ---');
check('a player-unit registration reads EVENT_PLAYER_UNIT_DEATH', I('playerDeaths'), 1);
check('…and is NOT equal to EVENT_UNIT_DEATH', I('unitDeathOnPlayerTrigger'), 0);
check('TriggerRegisterDeathEvent is a WIDGET death', I('widgetDeaths'), 1);

console.log('\n--- registrars that ARE the event, named by common.j itself ---');
interp.advanceTime(1.5);
check('a timer trigger reads EVENT_GAME_TIMER_EXPIRED', I('timerFires'), 1);
interp.firePlayerChat(0, '-go');
check('a chat trigger reads EVENT_PLAYER_CHAT', I('chats'), 1);
check('a trigger nobody fired has no event', call('ExecutedHasNoEvent').b, true);

console.log('\n--- eval and exec are two counts, not one ---');
call('Offer');
call('Offer');
check('two offers were two evaluations', call('EvalCount').n, 2);
check('…and, the gate shut, no executions', call('ExecCount').n, 0);
call('OpenGate');
call('Offer');
check('an offer that passes is a third evaluation', call('EvalCount').n, 3);
check('…and the first execution', call('ExecCount').n, 1);
check('…and the action really ran', I('runs'), 1);
call('Reset');
check('ResetTrigger zeroes the evaluations', call('EvalCount').n, 0);
check('…and the executions', call('ExecCount').n, 0);
call('Offer');
check('…and leaves the actions where they were', I('runs'), 2);

console.log('\n--- removal is by HANDLE ---');
call('DropGate');
call('Offer');
check('a removed condition no longer gates', I('runs'), 3);
call('RunDoubled');
check('the same function added twice runs twice', I('doubledRuns'), 2);
call('RemoveFirst');
call('RunDoubled');
check('removing ONE handle leaves the other copy', I('doubledRuns'), 3);

console.log('\n--- an action may remove itself mid-run ---');
call('RunSelfRemoving');
check('the action after it still runs that pass', I('afterSelf'), 1);
call('RunSelfRemoving');
check('…and it runs again the next', I('afterSelf'), 2);
check('the action that removed itself ran exactly once', I('selfRuns'), 1);

console.log(failures ? `\n${failures} failure(s).` : '\nAll trigger-introspection checks passed.');
process.exit(failures ? 1 : 0);
