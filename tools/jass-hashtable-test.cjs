// Hashtables (natives/hashtable.ts) — the store every modern map keeps its state in.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-hashtable-test.cjs
//
// Asserts the three facts the implementation is built on, because each is invisible until a
// map depends on it: the key is a PAIR, each type is its own NAMESPACE (a real and an integer
// at the same pair are two values), and every typed handle saver shares ONE slot.

const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src', 'jass');
if (!existsSync(join(BUILD, 'headless.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
require('node:fs').writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'headless.js'));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};

const SRC = `
globals
    hashtable ht = null
    integer gi = 0
    real gr = 0.0
    boolean gb = false
    string gs = ""
    unit gu = null
endglobals

function Setup takes nothing returns nothing
    set ht = InitHashtable()
endfunction

// The key is a PAIR: (1,2) and (2,1) are different slots.
function PairKeys takes nothing returns integer
    call SaveInteger(ht, 1, 2, 11)
    call SaveInteger(ht, 2, 1, 22)
    return LoadInteger(ht, 1, 2) * 100 + LoadInteger(ht, 2, 1)
endfunction

// Each TYPE is its own namespace: an integer and a real at the same pair coexist.
function Namespaces takes nothing returns real
    call SaveInteger(ht, 7, 7, 5)
    call SaveReal(ht, 7, 7, 1.5)
    call SaveBoolean(ht, 7, 7, true)
    call SaveStr(ht, 7, 7, "x")
    return LoadInteger(ht, 7, 7) + LoadReal(ht, 7, 7)
endfunction

function HaveIsPerType takes nothing returns boolean
    call SaveInteger(ht, 9, 9, 1)
    return HaveSavedInteger(ht, 9, 9) and not HaveSavedReal(ht, 9, 9)
endfunction

// A miss is 0 / "" / false / null — never an error.
function MissIsDefault takes nothing returns integer
    return LoadInteger(ht, 999, 999)
endfunction

function MissStrIsEmpty takes nothing returns boolean
    return LoadStr(ht, 999, 999) == ""
endfunction

// Every typed handle saver shares ONE slot: save through one name, load through another.
function OneHandleSlot takes nothing returns boolean
    local timer t = CreateTimer()
    call SaveTimerHandle(ht, 3, 4, t)
    return LoadAgentHandle(ht, 3, 4) == t and HaveSavedHandle(ht, 3, 4)
endfunction

function RemoveOne takes nothing returns boolean
    call SaveInteger(ht, 5, 6, 42)
    call SaveReal(ht, 5, 6, 1.0)
    call RemoveSavedInteger(ht, 5, 6)
    return (not HaveSavedInteger(ht, 5, 6)) and HaveSavedReal(ht, 5, 6)
endfunction

// FlushChild empties ONE parent key; FlushParent empties the table.
function FlushChild takes nothing returns boolean
    call SaveInteger(ht, 100, 1, 1)
    call SaveInteger(ht, 101, 1, 1)
    call FlushChildHashtable(ht, 100)
    return (not HaveSavedInteger(ht, 100, 1)) and HaveSavedInteger(ht, 101, 1)
endfunction

function FlushParent takes nothing returns boolean
    call SaveInteger(ht, 200, 1, 1)
    call FlushParentHashtable(ht)
    return not HaveSavedInteger(ht, 200, 1)
endfunction

// Two tables are two stores.
function TwoTables takes nothing returns integer
    local hashtable other = InitHashtable()
    call SaveInteger(ht, 1, 1, 10)
    call SaveInteger(other, 1, 1, 20)
    return LoadInteger(ht, 1, 1) * 100 + LoadInteger(other, 1, 1)
endfunction
`;

const interp = buildInterpreter([SRC], {});
interp.callFunction('Setup', []);
const call = (fn) => interp.callFunction(fn, []).n ?? interp.callFunction(fn, []).s;
const callBool = (fn) => !!interp.callFunction(fn, []).b;

check('the key is a pair', call('PairKeys'), 1122);
check('int and real coexist at one pair', call('Namespaces'), 6.5);
check('HaveSaved is per type', callBool('HaveIsPerType'), true);
check('a miss reads 0', call('MissIsDefault'), 0);
check('a missing string reads ""', callBool('MissStrIsEmpty'), true);
check('every typed handle saver is one slot', callBool('OneHandleSlot'), true);
check('RemoveSavedInteger leaves the real', callBool('RemoveOne'), true);
check('FlushChildHashtable clears one parent', callBool('FlushChild'), true);
check('FlushParentHashtable clears the table', callBool('FlushParent'), true);
check('two tables are two stores', call('TwoTables'), 1020);

console.log(failures ? `\n${failures} failure(s).` : '\nAll hashtable checks passed.');
process.exit(failures ? 1 : 0);
