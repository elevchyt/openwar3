// JASS language semantics the interpreter has to get exactly right (src/jass/interpreter.ts,
// values.ts, lexer.ts, parser.ts) — each one a case where JavaScript's own arithmetic, string
// or boolean rule differs from the game's VM, and a map that depends on it is quietly wrong
// rather than broken.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-semantics-test.cjs
//
// Needs no game data: every program is written here.

const { existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src', 'jass');
if (!existsSync(join(BUILD, 'headless.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'headless.js'));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};
/** A JassValue as the plain value a check compares: a number, a string, a boolean, or "null". */
const plain = (v) => (v.k === 'int' || v.k === 'real' ? v.n : v.k === 'string' ? v.s : v.k === 'bool' ? v.b : v.k);
const boot = (src, opts = {}) => {
  const interp = buildInterpreter([src], opts);
  return { interp, call: (fn, args = []) => plain(interp.callFunction(fn, args)), raw: (fn) => interp.callFunction(fn, []) };
};

// --- #372: integer * integer wraps at 32 bits --------------------------------------------------
{
  console.log('--- integer multiplication wraps at 32 bits (#372) ---');
  const { call } = boot(`
function Lcg takes nothing returns integer
    return 1103515245 * 2147483647
endfunction
function Big takes nothing returns integer
    local integer a = 2147483647
    return a * a
endfunction
function Neg takes nothing returns integer
    return -2147483647 * 65537
endfunction
function Small takes nothing returns integer
    return 1234 * -5678
endfunction
function RealStaysReal takes nothing returns real
    return 2147483647 * 2.0
endfunction
`);
  check('1103515245 * 2147483647', call('Lcg'), Math.imul(1103515245, 2147483647));
  check('the exact 32-bit wrap', call('Lcg'), 1043968403);
  check('(2^31-1)^2 wraps to 1', call('Big'), 1);
  check('a negative product wraps', call('Neg'), Math.imul(-2147483647, 65537));
  check('a small product is unchanged', call('Small'), -7006652);
  check('a real operand does not wrap', call('RealStaysReal'), 4294967294);
}

// --- #371: And / Or / Not are real combinators -------------------------------------------------
{
  console.log('--- And / Or / Not combine their boolexprs (#371) ---');
  const { call } = boot(`
globals
    integer asked = 0
endglobals
function T takes nothing returns boolean
    set asked = asked + 1
    return true
endfunction
function F takes nothing returns boolean
    set asked = asked + 10
    return false
endfunction
function Eval takes boolexpr be returns boolean
    local trigger t = CreateTrigger()
    call TriggerAddCondition(t, be)
    return TriggerEvaluate(t)
endfunction
function NotF takes nothing returns boolean
    return Eval(Not(Condition(function F)))
endfunction
function NotT takes nothing returns boolean
    return Eval(Not(Condition(function T)))
endfunction
function AndTF takes nothing returns boolean
    return Eval(And(Condition(function T), Condition(function F)))
endfunction
function AndTT takes nothing returns boolean
    return Eval(And(Condition(function T), Condition(function T)))
endfunction
function OrFT takes nothing returns boolean
    return Eval(Or(Condition(function F), Condition(function T)))
endfunction
function OrFF takes nothing returns boolean
    return Eval(Or(Condition(function F), Condition(function F)))
endfunction
function Nested takes nothing returns boolean
    return Eval(Not(And(Condition(function T), Not(Condition(function F)))))
endfunction
function AndStops takes nothing returns integer
    set asked = 0
    call Eval(And(Condition(function F), Condition(function T)))
    return asked
endfunction
function OrStops takes nothing returns integer
    set asked = 0
    call Eval(Or(Condition(function T), Condition(function F)))
    return asked
endfunction
function ForceFilter takes nothing returns integer
    local force f = CreateForce()
    local integer n = 0
    local integer i = 0
    call ForceEnumPlayers(f, And(Condition(function T), Not(Condition(function T))))
    loop
        exitwhen i > 11
        if IsPlayerInForce(Player(i), f) then
            set n = n + 1
        endif
        set i = i + 1
    endloop
    return n
endfunction
`);
  check('Not(false) is true', call('NotF'), true);
  check('Not(true) is false', call('NotT'), false);
  check('And(true, false) is false', call('AndTF'), false);
  check('And(true, true) is true', call('AndTT'), true);
  check('Or(false, true) is true', call('OrFT'), true);
  check('Or(false, false) is false', call('OrFF'), false);
  check('Not(And(T, Not(F))) is false', call('Nested'), false);
  check('And stops at a false left side', call('AndStops'), 10);
  check('Or stops at a true left side', call('OrStops'), 1);
  check('an enumeration filter asks both halves', call('ForceFilter'), 0);
}

// --- #370: every trigger condition is evaluated -------------------------------------------------
{
  console.log('--- a trigger evaluates EVERY condition (#370) ---');
  const { call } = boot(`
globals
    integer ran = 0
    integer acted = 0
endglobals
function C1 takes nothing returns boolean
    set ran = ran + 1
    return false
endfunction
function C2 takes nothing returns boolean
    set ran = ran + 10
    return false
endfunction
function C3 takes nothing returns boolean
    set ran = ran + 100
    return true
endfunction
function Nothing takes nothing returns nothing
    set ran = ran + 1000
endfunction
function Act takes nothing returns nothing
    set acted = acted + 1
endfunction
function Evaluate takes nothing returns integer
    local trigger t = CreateTrigger()
    set ran = 0
    call TriggerAddCondition(t, Filter(function C1))
    call TriggerAddCondition(t, Filter(function C2))
    call TriggerAddCondition(t, Filter(function C3))
    if TriggerEvaluate(t) then
        return -1
    endif
    return ran
endfunction
function AllTrue takes nothing returns boolean
    local trigger t = CreateTrigger()
    call TriggerAddCondition(t, Condition(function C3))
    call TriggerAddCondition(t, Condition(function C3))
    return TriggerEvaluate(t)
endfunction
function NothingIsFalse takes nothing returns boolean
    local trigger t = CreateTrigger()
    call TriggerAddCondition(t, Condition(function Nothing))
    return TriggerEvaluate(t)
endfunction
`);
  check('TriggerEvaluate runs all three and is false', call('Evaluate'), 111);
  check('two true conditions pass', call('AllTrue'), true);
  check('a returns-nothing condition is false (both sites agree)', call('NothingIsFalse'), false);
  const { interp } = boot(`
globals
    integer ran = 0
    integer acted = 0
endglobals
function C1 takes nothing returns boolean
    set ran = ran + 1
    return false
endfunction
function C3 takes nothing returns boolean
    set ran = ran + 100
    return true
endfunction
function Act takes nothing returns nothing
    set acted = acted + 1
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerAddCondition(t, Filter(function C1))
    call TriggerAddCondition(t, Filter(function C3))
    call TriggerAddAction(t, function Act)
    call TriggerRegisterTimerEvent(t, 0.01, false)
endfunction
function Result takes nothing returns integer
    return ran * 10 + acted
endfunction
`);
  interp.callFunction('Setup', []);
  for (let i = 0; i < 10; i++) interp.advanceTime(0.05);
  check('a fired trigger runs both conditions and no action', interp.callFunction('Result', []).n, 1010);
}

// --- #374: real == is tolerant, != exact; an unset string is null -----------------------------
{
  console.log('--- real == has a tolerance, != does not; strings default to null (#374) ---');
  const { call } = boot(`
globals
    string gs
    string array sa
    real gr = 1.0
endglobals
function Sum takes nothing returns boolean
    return 0.1 + 0.2 == 0.3
endfunction
function Near takes nothing returns boolean
    return 1.0001 == 1.0
endfunction
function NearNe takes nothing returns boolean
    return 1.0001 != 1.0
endfunction
function Far takes nothing returns boolean
    return 1.01 == 1.0
endfunction
function IntReal takes nothing returns boolean
    return 1 == 1.0005
endfunction
function IntInt takes nothing returns boolean
    return 1 == 2
endfunction
function ExactNe takes nothing returns boolean
    return gr != 1.0
endfunction
function GlobalNull takes nothing returns boolean
    return gs == null
endfunction
function SlotNull takes nothing returns boolean
    return sa[7] == null
endfunction
function LocalNull takes nothing returns boolean
    local string s
    return s == null
endfunction
function EmptyIsNotNull takes nothing returns boolean
    return "" == null
endfunction
function NullConcat takes nothing returns string
    local string s
    return s + "a" + sa[2]
endfunction
function NullLength takes nothing returns integer
    return StringLength(gs)
endfunction
function NullPlusNull takes nothing returns string
    local string a
    local string b
    return a + b
endfunction
function StoredMiss takes nothing returns boolean
    return GetStoredString(InitGameCache("x.w3v"), "m", "k") == null
endfunction
`);
  check('0.1 + 0.2 == 0.3', call('Sum'), true);
  check('1.0001 == 1.0', call('Near'), true);
  check('1.0001 != 1.0 (exact)', call('NearNe'), true);
  check('1.01 == 1.0 is false', call('Far'), false);
  check('an integer against a near real', call('IntReal'), true);
  check('two integers stay exact', call('IntInt'), false);
  check('equal reals are not !=', call('ExactNe'), false);
  check('an unset string global is null', call('GlobalNull'), true);
  check('an unset string array slot is null', call('SlotNull'), true);
  check('an unset string local is null', call('LocalNull'), true);
  check('"" is still not null', call('EmptyIsNotNull'), false);
  check('a null string concatenates as ""', call('NullConcat'), 'a');
  check('StringLength(null) is 0', call('NullLength'), 0);
  check('null + null is a string', call('NullPlusNull'), '');
  check('GetStoredString on a miss is null', call('StoredMiss'), true);
}

// --- #373: StringHash is the game's (lookup2 over the folded string) --------------------------
{
  console.log('--- StringHash is the game\'s hash, case- and slash-insensitive (#373) ---');
  const { call } = boot(`
function H takes string s returns integer
    return StringHash(s)
endfunction
function Cache takes nothing returns integer
    local gamecache gc = InitGameCache("semantics.w3v")
    call StoreInteger(gc, "Human02", "Arthas", 7)
    call StoreInteger(gc, "a/b", "k", 3)
    return GetStoredInteger(gc, "HUMAN02", "arthas") * 10 + GetStoredInteger(gc, "A\\\\B", "K")
endfunction
function CacheFlush takes nothing returns boolean
    local gamecache gc = InitGameCache("semantics.w3v")
    call StoreString(gc, "M", "Key", "v")
    call FlushStoredString(gc, "m", "KEY")
    return not HaveStoredString(gc, "M", "Key")
endfunction
`);
  const h = (s) => call('H', [{ k: 'string', s }]);
  check('StringHash("A") is the published -1587459251', h('A'), -1587459251);
  check('case does not matter', h('Hello') === h('hello') && h('-AR') === h('-ar'), true);
  check('"/" hashes as "\\"', h('a/b') === h('A\\B'), true);
  check('different strings differ', h('hello') !== h('world'), true);
  // One length past each of lookup2's twelve-byte blocks and through every tail case.
  const lens = new Set(Array.from({ length: 26 }, (_v, n) => h('x'.repeat(n))));
  check('every length 0..25 hashes distinctly', lens.size, 26);
  check('a 30-byte string', h('abcdefghijklmnopqrstuvwxyz0123') === h('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'), true);
  check('game-cache labels are case- and slash-insensitive', call('Cache'), 73);
  check('a flush finds the label in any case', call('CacheFlush'), true);
}

// --- #369: an integer written into a real IS a real ---------------------------------------------
{
  console.log('--- integer -> real at every typed write (#369) ---');
  const { call, raw } = boot(`
globals
    real gr = 7
    real gs = 0.0
    real array ra
    integer gi = 7
endglobals
function Half takes real x returns real
    return x / 2
endfunction
function HalfOf5 takes nothing returns real
    return Half(5)
endfunction
function GlobalInit takes nothing returns real
    return gr / 2
endfunction
function GlobalSet takes nothing returns real
    set gs = 3
    return gs / 2
endfunction
function ArraySlot takes nothing returns real
    set ra[1] = 3
    return ra[1] / 2
endfunction
function Five takes nothing returns real
    return 5
endfunction
function ReturnIsReal takes nothing returns real
    return Five() / 2
endfunction
function LocalInit takes nothing returns real
    local real r = 9
    return r / 2
endfunction
function LocalSet takes nothing returns real
    local real r
    set r = 11
    return r / 2
endfunction
function NoWrap takes nothing returns real
    local real r = 2147483647
    return r + 1
endfunction
function IntStaysInt takes nothing returns integer
    return gi / 2
endfunction
function IntLocal takes nothing returns integer
    local integer i = 7
    return i / 2
endfunction
`);
  check('Half(5) is 2.5', call('HalfOf5'), 2.5);
  check('real gr = 7, then / 2', call('GlobalInit'), 3.5);
  check('set gs = 3, then / 2', call('GlobalSet'), 1.5);
  check('set ra[1] = 3, then / 2', call('ArraySlot'), 1.5);
  check('a returns-real function returning 5, then / 2', call('ReturnIsReal'), 2.5);
  check('local real r = 9, then / 2', call('LocalInit'), 4.5);
  check('set r = 11 on a real local, then / 2', call('LocalSet'), 5.5);
  check('a real holding 2147483647 does not wrap on + 1', call('NoWrap'), 2147483648);
  check('Five() is a real', raw('Five').k, 'real');
  check('an integer global still truncates', call('IntStaysInt'), 3);
  check('an integer local still truncates', call('IntLocal'), 3);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll JASS semantics checks passed.');
process.exit(failures ? 1 : 0);
