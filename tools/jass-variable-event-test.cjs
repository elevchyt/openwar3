// Three natives Test of Balance logged as missing (docs/map-compatibility.md), through the real
// interpreter against the install's own common.j and Blizzard.j:
//
//   * TriggerRegisterVariableEvent — "Value Of Real Variable" (UI\TriggerStrings.txt): raised by
//     the WRITE, synchronously, only for "non-array variables of type 'Real'", and not by an
//     assignment that leaves the value where it was ("you set variable with value 1 to 1 again
//     which doesn't trigger the event" — hiveworkshop 201641). Bribe's Damage Engine, Unit Event
//     and every GUI "custom event" are built on it.
//   * ConvertMouseButtonType — the install's own common.j initialises MOUSE_BUTTON_TYPE_* with it,
//     so its absence was a "not implemented" line on EVERY map. Checked generally: every
//     `native Convert*` common.j declares must be registered.
//   * AddUnitAnimationProperties — reaches its presentation hook through the GUI's BJ.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-variable-event-test.cjs
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
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j and Blizzard.j.");
  process.exit(2);
}
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const common = decode(readFileSync(join(SCRIPTS, 'common.j')));
const blizzard = decode(readFileSync(join(SCRIPTS, 'Blizzard.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};

const tags = [];
let next = 1;
const hooks = {
  createUnit: () => next++,
  addUnitAnimationProperties: (id, props, add) => tags.push([id, props, add]),
};

const SRC = `
globals
    real udg_DamageEvent = 0.00
    real udg_Level = 0.00
    real udg_Outer = 0.00
    integer udg_Count = 0
    integer udg_NotReal = 0
    real array udg_RealArray
    integer fired = 0
    integer firedGt = 0
    integer seenBeforeNextLine = -1
    boolean rightEventId = false
    string order = ""
    unit pillar = null
endglobals
function OnDamage takes nothing returns nothing
    set fired = fired + 1
    set rightEventId = GetTriggerEventId() == EVENT_GAME_VARIABLE_LIMIT
endfunction
function OnLevel takes nothing returns nothing
    set firedGt = firedGt + 1
endfunction
function OnInt takes nothing returns nothing
    set fired = fired + 100
endfunction
function OnOuterA takes nothing returns nothing
    set order = order + "A"
    set udg_DamageEvent = 0.00
    set udg_DamageEvent = 1.00
    set order = order + "a"
endfunction
function OnOuterB takes nothing returns nothing
    set order = order + "B"
endfunction
function OnInner takes nothing returns nothing
    set order = order + "i"
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterVariableEvent(t, "udg_DamageEvent", EQUAL, 1.00)
    call TriggerAddAction(t, function OnDamage)
    set t = CreateTrigger()
    call TriggerRegisterVariableEvent(t, "udg_Level", GREATER_THAN, 5.00)
    call TriggerAddAction(t, function OnLevel)
    set t = CreateTrigger()
    call TriggerRegisterVariableEvent(t, "udg_NotReal", EQUAL, 1.00)
    call TriggerRegisterVariableEvent(t, "udg_RealArray", EQUAL, 1.00)
    call TriggerRegisterVariableEvent(t, "udg_NoSuchVariable", EQUAL, 1.00)
    call TriggerAddAction(t, function OnInt)
endfunction
function SetupNested takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterVariableEvent(t, "udg_Outer", EQUAL, 1.00)
    call TriggerAddAction(t, function OnOuterA)
    set t = CreateTrigger()
    call TriggerRegisterVariableEvent(t, "udg_Outer", EQUAL, 1.00)
    call TriggerAddAction(t, function OnOuterB)
    set t = CreateTrigger()
    call TriggerRegisterVariableEvent(t, "udg_DamageEvent", EQUAL, 1.00)
    call TriggerAddAction(t, function OnInner)
endfunction
function Hit takes nothing returns nothing
    set udg_DamageEvent = 0
    set udg_DamageEvent = 1
    set seenBeforeNextLine = fired
endfunction
function SetOne takes nothing returns nothing
    set udg_DamageEvent = 1.00
endfunction
function SetLevel takes real v returns nothing
    set udg_Level = v
endfunction
function PokeNonReal takes nothing returns nothing
    set udg_NotReal = 1
    set udg_RealArray[0] = 1.00
endfunction
function Outer takes nothing returns nothing
    set udg_Outer = 0.00
    set udg_Outer = 1.00
endfunction
function Fired takes nothing returns integer
    return fired
endfunction
function FiredGt takes nothing returns integer
    return firedGt
endfunction
function Seen takes nothing returns integer
    return seenBeforeNextLine
endfunction
function RightId takes nothing returns boolean
    return rightEventId
endfunction
function Order takes nothing returns string
    return order
endfunction
function MouseButtonsDistinct takes nothing returns boolean
    return MOUSE_BUTTON_TYPE_LEFT != null and MOUSE_BUTTON_TYPE_LEFT != MOUSE_BUTTON_TYPE_RIGHT and MOUSE_BUTTON_TYPE_LEFT == ConvertMouseButtonType(1)
endfunction
function Tag takes nothing returns nothing
    set pillar = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
    call AddUnitAnimationPropertiesBJ(true, "alternate", pillar)
    call AddUnitAnimationPropertiesBJ(false, "alternate", pillar)
    call AddUnitAnimationProperties(pillar, "work", true)
    call AddUnitAnimationProperties(null, "work", true)
endfunction
`;

const quiet = [console.info, console.warn];
const warned = [];
console.info = (...a) => warned.push(a.join(' '));
console.warn = (...a) => warned.push(a.join(' '));
const interp = buildInterpreter([common, blizzard, SRC], { hooks });
[console.info, console.warn] = quiet;
const call = (fn, args = []) => interp.callFunction(fn, args);
const R = (n) => ({ k: 'real', n });

console.log('--- TriggerRegisterVariableEvent ---');
call('Setup');
check('nothing fires at registration', call('Fired').n, 0);
call('Hit'); // `set udg_DamageEvent = 0` then `= 1` — INT literals into a REAL global, as the editor writes them
check('a write that meets the condition fires', call('Fired').n, 1);
check('…SYNCHRONOUSLY: the actions ran before the next line of the writer', call('Seen').n, 1);
check('…and GetTriggerEventId is EVENT_GAME_VARIABLE_LIMIT', call('RightId').b, true);
call('SetOne');
check('writing the value it already holds does NOT fire again', call('Fired').n, 1);
call('Hit');
check('…the reset-to-0 idiom fires it again', call('Fired').n, 2);
call('SetLevel', [R(3)]);
check('a write that does not meet the condition does not fire', call('FiredGt').n, 0);
call('SetLevel', [R(6)]);
check('GREATER_THAN fires on the write that crosses it', call('FiredGt').n, 1);
call('PokeNonReal');
check('an integer, an array and an unknown name register nothing', call('Fired').n, 2);
call('SetupNested');
call('Outer');
check('a variable event raised inside another runs to completion first, then the outer dispatch goes on', call('Order').s, 'Aia' + 'B');

console.log('\n--- ConvertMouseButtonType ---');
check("common.j's own MOUSE_BUTTON_TYPE_ constants are real, distinct and interned", call('MouseButtonsDistinct').b, true);
check('…and initialising them logged nothing', warned.filter((w) => /ConvertMouseButtonType/.test(w)).length, 0);
const converts = [...new Set([...common.matchAll(/native\s+(Convert\w+)/g)].map((m) => m[1]))];
const missing = converts.filter((n) => !interp.rt.natives.has(n));
check(`every one of common.j's ${converts.length} Convert* natives is registered`, missing.join(',') || 'none', 'none');

console.log('\n--- AddUnitAnimationProperties ---');
call('Tag');
check('the BJ and the native reach the hook, in order, with the add flag', JSON.stringify(tags), JSON.stringify([[1, 'alternate', true], [1, 'alternate', false], [1, 'work', true]]));

console.log(failures ? `\n${failures} failure(s).` : '\nAll variable-event / convert / animation-tag checks passed.');
process.exit(failures ? 1 : 0);
