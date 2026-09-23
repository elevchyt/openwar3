// The `BlzGetUnit…`/`BlzSetUnit…` natives' JASS half (src/jass/natives/unitStats.ts —
// docs/map-compatibility.md pass 3): that each native reaches the right stat, and above all that
// the WEAPON INDEX is translated by the map's own convention.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-unit-stats-test.cjs
//
// "In 1.30 or lower, the function is 1-indexed, but in 1.31 and newer, it is 0-indexed"
// (hiveworkshop 319334). Our own 1.30.4 counts from 1; a map saved by a 1.31+ editor counts from
// 0, and `Runtime.weaponIndexBase` says which (set at the map door off MapFormatProfile). The same
// script is run under BOTH bases here, because the failure this guards against is silent: read
// the wrong way round, a Reforged-era map's `…(u, x, 0)` names a weapon that does not exist and
// nothing happens — which is what three quarters of the corpus's calls would have done.
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

// A stand-in world: every stat answers something distinct, and every write is recorded with the
// SLOT it reached, so the test asserts what the native decided.
function world() {
  const writes = [];
  const reads = [];
  const hooks = {
    createUnit: () => 1,
    unitStat: (id, stat, slot) => {
      reads.push([stat, slot]);
      return { maxHp: 420.4, maxMana: 175, armor: 2.6, invulnerable: true, baseDamage: 12 + slot,
        attackCooldown: 1.35, diceNumber: 2, diceSides: 6 }[stat];
    },
    setUnitStat: (id, stat, value, slot) => { writes.push([stat, value, slot]); return true; },
  };
  return { hooks, writes, reads };
}

const SRC = `
globals
    unit u = null
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
endfunction
function MaxHp takes nothing returns integer
    return BlzGetUnitMaxHP(u)
endfunction
function Armor takes nothing returns real
    return BlzGetUnitArmor(u)
endfunction
function Invuln takes nothing returns boolean
    return BlzIsUnitInvulnerable(u)
endfunction
function SetTotals takes nothing returns nothing
    call BlzSetUnitMaxHP(u, 900)
    call BlzSetUnitMaxMana(u, 300)
    call BlzSetUnitArmor(u, 7.5)
endfunction
// The corpus's own idiom, weapon index 0 then 1.
function Buff0 takes nothing returns nothing
    call BlzSetUnitBaseDamage(u, BlzGetUnitBaseDamage(u, 0) + 15, 0)
endfunction
function Buff1 takes nothing returns nothing
    call BlzSetUnitBaseDamage(u, BlzGetUnitBaseDamage(u, 1) + 15, 1)
endfunction
function Speed takes nothing returns nothing
    call BlzSetUnitAttackCooldown(u, 0.8, 1)
endfunction
function Dice takes nothing returns nothing
    call BlzSetUnitDiceNumber(u, 3, 1)
    call BlzSetUnitDiceSides(u, 4, 1)
endfunction
`;

function boot(base) {
  const w = world();
  const quiet = [console.info, console.warn];
  console.info = () => {};
  console.warn = () => {};
  const interp = buildInterpreter([common, SRC], base === undefined ? { hooks: w.hooks } : { hooks: w.hooks, weaponIndexBase: base });
  interp.callFunction('Make', []);
  [console.info, console.warn] = quiet;
  return { ...w, call: (fn) => interp.callFunction(fn, []) };
}

console.log('--- the totals reach the right stat ---');
{
  const t = boot();
  check('BlzGetUnitMaxHP is an integer', t.call('MaxHp').n, 420);
  check('BlzGetUnitArmor keeps the fraction', t.call('Armor').n, 2.6);
  check('BlzIsUnitInvulnerable', t.call('Invuln').b, true);
  t.call('SetTotals');
  check('the three totals were written, in order', JSON.stringify(t.writes.map((w) => [w[0], w[1]])), JSON.stringify([['maxHp', 900], ['maxMana', 300], ['armor', 7.5]]));
}

console.log('\n--- with no map door, the runtime is 1.30.4: weapons count from 1 ---');
{
  const t = boot();
  t.call('Buff1');
  check('index 1 is slot 0 (weapon 1)', t.writes[0][2], 0);
  check('…and the read-modify-write read slot 0 too', t.reads[0][1], 0);
  check('…and wrote 12 + 15', t.writes[0][1], 27);
  t.writes.length = 0;
  t.call('Buff0');
  check('index 0 names slot −1 — a weapon that does not exist', t.writes[0][2], -1);
}

console.log('\n--- a map saved by a 1.31+ editor: weapons count from 0 ---');
{
  const t = boot(0);
  t.call('Buff0');
  check('index 0 is slot 0 (weapon 1)', t.writes[0][2], 0);
  t.writes.length = 0;
  t.call('Buff1');
  check('index 1 is slot 1 (weapon 2)', t.writes[0][2], 1);
  check('…and the read came from weapon 2 as well (12 + 1 + 15)', t.writes[0][1], 28);
  t.writes.length = 0;
  t.call('Speed');
  t.call('Dice');
  check('attack cooldown reaches weapon 2', JSON.stringify(t.writes[0]), JSON.stringify(['attackCooldown', 0.8, 1]));
  check('dice number reaches weapon 2', JSON.stringify(t.writes[1]), JSON.stringify(['diceNumber', 3, 1]));
  check('dice sides reaches weapon 2', JSON.stringify(t.writes[2]), JSON.stringify(['diceSides', 4, 1]));
}

console.log('\n--- a 1.30 map told the SAME thing lands one weapon over ---');
{
  const t = boot(1);
  t.call('Speed');
  check('under 1-based counting, index 1 is weapon 1', t.writes[0][2], 0);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll unit-stat native checks passed.');
process.exit(failures ? 1 : 0);
