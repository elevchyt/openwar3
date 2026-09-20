// Widget life + trigger-dealt damage (src/jass/natives/widgets.ts — docs/map-compatibility.md
// pass 2).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-widget-damage-test.cjs
//
// Driven through the real interpreter against the install's own common.j, because the thing
// worth pinning is a mapping between two vocabularies that nothing else checks:
//
//   * a WIDGET is a unit or a destructible and one native has to route to two different
//     places, using only what the handle says it is; and
//   * `ATTACK_TYPE_NORMAL` is the damage table's **Spells** row while `ATTACK_TYPE_MELEE` is
//     its **Normal** row — crossed over, on the authority of the install's own
//     `UI\TriggerData.txt`, which names each constant with the string the World Editor prints
//     beside it. Read the obvious way round, every trigger's damage in a custom map is graded
//     by the wrong column for every blow.
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
const { COMPAT_PRELUDE } = require(join(BUILD, 'compat', 'prelude.js'));

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

// --- the engine stand-in --------------------------------------------------------------------
// Two units, and a destructible the engine reports life for. Every call is recorded so the test
// can assert what the NATIVE decided rather than what the sim would have done with it.
const life = new Map([[1, 500], [2, 300]]);
const damages = [];
let destructibleLife = 900;
let destructibleSet = null;
const hooks = {
  createUnit: (player, typeId) => (typeId === 'hfoo' ? 1 : 2),
  getUnitState: (id, state) => (state === 0 ? life.get(id) ?? 0 : 0),
  setUnitState: (id, state, value) => { if (state === 0) life.set(id, value); },
  getUnitX: (id) => id * 100,
  getUnitY: (id) => id * 10,
  destructableInfo: () => ({ life: destructibleLife }),
  setDestructableLife: (mapId, value) => { destructibleSet = [mapId, value]; destructibleLife = value; },
  findDestructable: () => 77, // the .doo record CreateDestructable adopts
  damageTarget: (sourceId, targetId, amount, opts) => {
    damages.push({ sourceId, targetId, amount, ...opts });
    return amount > 0 ? amount : 0;
  },
};

const SRC = `
globals
    unit a = null
    unit b = null
    destructable d = null
endglobals
function Make takes nothing returns nothing
    set a = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
    set b = CreateUnit(Player(1), 'hkni', 0.0, 0.0, 0.0)
    set d = CreateDestructable('LTlt', 512.0, 256.0, 0.0, 1.0, 0)
endfunction
function LifeOfA takes nothing returns real
    return GetWidgetLife(a)
endfunction
function LifeOfB takes nothing returns real
    return GetWidgetLife(b)
endfunction
function LifeOfD takes nothing returns real
    return GetWidgetLife(d)
endfunction
function HurtA takes nothing returns nothing
    call SetWidgetLife(a, 123.0)
endfunction
function HurtD takes nothing returns nothing
    call SetWidgetLife(d, 40.0)
endfunction
function XOfB takes nothing returns real
    return GetWidgetX(b)
endfunction
function YOfB takes nothing returns real
    return GetWidgetY(b)
endfunction
// The crossed pair, both spellings, so a swap shows up as two failures and not one.
function DamageNormal takes nothing returns boolean
    return UnitDamageTarget(a, b, 100.0, true, false, ATTACK_TYPE_NORMAL, DAMAGE_TYPE_NORMAL, WEAPON_TYPE_WHOKNOWS)
endfunction
function DamageMelee takes nothing returns boolean
    return UnitDamageTarget(a, b, 100.0, true, false, ATTACK_TYPE_MELEE, DAMAGE_TYPE_NORMAL, WEAPON_TYPE_WHOKNOWS)
endfunction
function DamageMagic takes nothing returns boolean
    return UnitDamageTarget(a, b, 50.0, false, true, ATTACK_TYPE_MAGIC, DAMAGE_TYPE_MAGIC, WEAPON_TYPE_WHOKNOWS)
endfunction
function DamageUniversal takes nothing returns boolean
    return UnitDamageTarget(a, b, 75.0, false, false, ATTACK_TYPE_HERO, DAMAGE_TYPE_UNIVERSAL, WEAPON_TYPE_WHOKNOWS)
endfunction
function DamagePierce takes nothing returns boolean
    return UnitDamageTarget(a, b, 10.0, true, true, ATTACK_TYPE_PIERCE, DAMAGE_TYPE_NORMAL, WEAPON_TYPE_WHOKNOWS)
endfunction
function DamageNobody takes nothing returns boolean
    return UnitDamageTarget(a, null, 100.0, true, false, ATTACK_TYPE_MELEE, DAMAGE_TYPE_NORMAL, WEAPON_TYPE_WHOKNOWS)
endfunction
`;

const notes = [];
const realInfo = console.info;
const realWarn = console.warn;
console.info = (...x) => notes.push(x.join(' '));
console.warn = (...x) => notes.push(x.join(' '));
const interp = buildInterpreter([common, COMPAT_PRELUDE, SRC], { hooks });
interp.callFunction('Make', []);
console.info = realInfo;
console.warn = realWarn;

const call = (fn) => interp.callFunction(fn, []);

console.log('--- one native, three kinds of widget ---');
check('a unit answers its own life', call('LifeOfA').n, 500);
check('…and so does the other one', call('LifeOfB').n, 300);
check('a destructible answers the engine', call('LifeOfD').n, 900);
call('HurtA');
check('SetWidgetLife writes the unit', life.get(1), 123);
check('…and leaves the other alone', life.get(2), 300);
call('HurtD');
check('SetWidgetLife writes the destructible', destructibleSet && destructibleSet[1], 40);
check('…through its MAP id, not its handle', destructibleSet && destructibleSet[0], 77);

console.log('\n--- where a widget is ---');
check('GetWidgetX asks the unit hook', call('XOfB').n, 200);
check('GetWidgetY likewise', call('YOfB').n, 20);

console.log('\n--- the attack-type table, whose first two rows are crossed ---');
damages.length = 0;
call('DamageNormal');
check('ATTACK_TYPE_NORMAL is the SPELLS column', damages[0].attackType, 'spells');
call('DamageMelee');
check('ATTACK_TYPE_MELEE is the NORMAL column', damages[1].attackType, 'normal');
call('DamagePierce');
check('…and the rest line up', damages[2].attackType, 'pierce');

console.log('\n--- the flags that change the arithmetic ---');
check('an attack is flagged as one', damages[1].attack, true);
check('…and carries ranged', damages[2].ranged, true);
damages.length = 0;
call('DamageMagic');
check('DAMAGE_TYPE_MAGIC is magic', damages[0].magic, true);
check('…and is not universal', damages[0].universal, false);
check('…and a spell is not an attack', damages[0].attack, false);
call('DamageUniversal');
check('DAMAGE_TYPE_UNIVERSAL is universal', damages[1].universal, true);
check('…and is not magic', damages[1].magic, false);
check('the amount crosses intact', damages[1].amount, 75);

console.log('\n--- and it refuses what it cannot aim ---');
damages.length = 0;
check('damage at nobody is false', call('DamageNobody').b, false);
check('…and reached the engine not at all', damages.length, 0);

console.log(failures ? `\n${failures} failure(s).` : '\nAll widget / trigger-damage checks passed.');
process.exit(failures ? 1 : 0);
