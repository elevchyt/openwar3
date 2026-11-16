// The `GetUnitDefault…` natives, `GetUnitAcquireRange` and the food natives (`GetUnitFoodUsed`/
// `Made`, `GetFoodUsed`/`Made`, `SetUnitUseFood`) and the sleep natives (`UnitAddSleep`, `UnitCanSleep`,
// `UnitIsSleeping`, `UnitWakeUp`; src/jass/natives/world.ts): that each
// asks the unit's TYPE for its own column, and that it still answers for a unit that has DIED.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-unit-defaults-test.cjs
//
// 284 call sites between them — 268 of them Test of Faith's "can this thing move at all" filter,
// `GetUnitDefaultMoveSpeed(GetFilterUnit()) > 0`, and one of them on `GetDyingUnit()`, which the
// sim has already let go of by the time a death trigger runs. So the default is keyed on the
// handle's type id (the one GetUnitTypeId answers with), never on the live unit.
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

// Stand-in rows — a walker, a flyer and a farm — distinct in every column so a crossed wire shows.
const ROWS = {
  hfoo: { moveSpeed: 270, turnRate: 0.6, flyHeight: 0, acquireRange: 500, foodUsed: 2, foodMade: 0 },
  hgry: { moveSpeed: 350, turnRate: 0.5, flyHeight: 250, acquireRange: 600, foodUsed: 4, foodMade: 0 },
  hhou: { moveSpeed: 0, turnRate: 0, flyHeight: 0, acquireRange: 0, foodUsed: 0, foodMade: 6 },
};
let next = 1;
const alive = new Set();
const foodFree = new Set(); // SimUnit.foodFree, as the game's hook writes it
const canSleep = new Set(); // SimUnit.canSleep
const asleep = new Set(); // SimUnit.asleep
const hooks = {
  setUnitCanSleep: (id, can) => { if (can) canSleep.add(id); else { canSleep.delete(id); asleep.delete(id); } },
  getUnitCanSleep: (id) => (alive.has(id) ? canSleep.has(id) : undefined),
  getUnitSleeping: (id) => (alive.has(id) ? asleep.has(id) : undefined),
  wakeUnit: (id) => asleep.delete(id),
  setUnitUseFood: (id, use) => { if (use) foodFree.delete(id); else foodFree.add(id); },
  getUnitUsesFood: (id) => (alive.has(id) ? !foodFree.has(id) : undefined),
  createUnit: () => { const id = next++; alive.add(id); return id; },
  unitTypeDefault: (typeId, field) => ROWS[typeId]?.[field],
  getUnitAcquireRange: (id) => (alive.has(id) ? 1200 : undefined),
  // The live speed a script has slowed the unit to — the default must not read this.
  getUnitMoveSpeed: () => 90,
};

const SRC = `
globals
    unit foot = null
    unit gryph = null
    unit farm = null
endglobals
function Make takes nothing returns nothing
    set foot = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
    set gryph = CreateUnit(Player(0), 'hgry', 0.0, 0.0, 0.0)
    set farm = CreateUnit(Player(0), 'hhou', 0.0, 0.0, 0.0)
endfunction
function FootUsed takes nothing returns integer
    return GetUnitFoodUsed(foot)
endfunction
function GryphUsed takes nothing returns integer
    return GetUnitFoodUsed(gryph)
endfunction
function FarmMade takes nothing returns integer
    return GetUnitFoodMade(farm)
endfunction
function FarmUsed takes nothing returns integer
    return GetUnitFoodUsed(farm)
endfunction
function TypeUsed takes nothing returns integer
    return GetFoodUsed('hgry')
endfunction
function TypeMade takes nothing returns integer
    return GetFoodMade('hhou')
endfunction
function UnknownType takes nothing returns integer
    return GetFoodUsed('zzzz')
endfunction
function FootOff takes nothing returns nothing
    call SetUnitUseFood(foot, false)
endfunction
function FootOn takes nothing returns nothing
    call SetUnitUseFood(foot, true)
endfunction
function FarmOff takes nothing returns nothing
    call SetUnitUseFood(farm, false)
endfunction
function NullFood takes nothing returns integer
    return GetUnitFoodUsed(null) + GetUnitFoodMade(null)
endfunction
function CanSleep takes nothing returns boolean
    return UnitCanSleep(gryph)
endfunction
function Sleeping takes nothing returns boolean
    return UnitIsSleeping(gryph)
endfunction
function SleepOn takes nothing returns nothing
    call UnitAddSleep(gryph, true)
endfunction
function SleepOff takes nothing returns nothing
    call UnitAddSleep(gryph, false)
endfunction
function Wake takes nothing returns nothing
    call UnitWakeUp(gryph)
endfunction
function NullSleep takes nothing returns boolean
    call UnitWakeUp(null)
    call UnitAddSleep(null, true)
    return UnitIsSleeping(null) or UnitCanSleep(null)
endfunction
function Speed takes nothing returns real
    return GetUnitDefaultMoveSpeed(foot)
endfunction
function Live takes nothing returns real
    return GetUnitMoveSpeed(foot)
endfunction
function Turn takes nothing returns real
    return GetUnitDefaultTurnSpeed(foot)
endfunction
function Fly takes nothing returns real
    return GetUnitDefaultFlyHeight(gryph)
endfunction
function Acq takes nothing returns real
    return GetUnitDefaultAcquireRange(gryph)
endfunction
function LiveAcq takes nothing returns real
    return GetUnitAcquireRange(foot)
endfunction
function CanMove takes nothing returns boolean
    return GetUnitDefaultMoveSpeed(foot) > 0.00
endfunction
function NullSpeed takes nothing returns real
    return GetUnitDefaultMoveSpeed(null)
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, SRC], { hooks });
interp.callFunction('Make', []);
[console.info, console.warn] = quiet;
const call = (fn) => interp.callFunction(fn, []);

console.log('--- the type\'s own columns ---');
check('GetUnitDefaultMoveSpeed is the TYPE\'s speed', call('Speed').n, 270);
check('…not the live one a script slowed it to', call('Live').n, 90);
check('GetUnitDefaultTurnSpeed', call('Turn').n, 0.6);
check('GetUnitDefaultFlyHeight', call('Fly').n, 250);
check('GetUnitDefaultAcquireRange', call('Acq').n, 600);
check("Test of Faith's filter reads true for a walker", call('CanMove').b, true);
check('a null unit has no default', call('NullSpeed').n, 0);

console.log('\n--- the live acquisition range ---');
check('GetUnitAcquireRange reads the unit\'s own', call('LiveAcq').n, 1200);

console.log('\n--- food ---');
check('GetUnitFoodUsed is the type\'s `fused`', call('FootUsed').n, 2);
check('…a second type, its own', call('GryphUsed').n, 4);
check('GetUnitFoodMade is the type\'s `fmade`', call('FarmMade').n, 6);
check('a farm uses none', call('FarmUsed').n, 0);
check('GetFoodUsed by type id', call('TypeUsed').n, 4);
check('GetFoodMade by type id', call('TypeMade').n, 6);
check('an unknown type has no food', call('UnknownType').n, 0);
check('a null unit has no food', call('NullFood').n, 0);
call('FootOff');
check('SetUnitUseFood(false) frees the unit (SimUnit.foodFree)', foodFree.has(1), true);
check('…and it then uses 0', call('FootUsed').n, 0);
check('…while the type still costs 2', interp.callFunction('GetFoodUsed', [{ k: 'int', n: 0x68666f6f }]).n, 2);
call('FootOn');
check('SetUnitUseFood(true) takes it back', call('FootUsed').n, 2);
call('FarmOff');
check('supply USAGE only — a farm turned off still makes 6', call('FarmMade').n, 6);

console.log('\n--- nocturnal sleep ---');
check('UnitCanSleep reads canSleep (off)', call('CanSleep').b, false);
call('SleepOn');
check('UnitAddSleep(true) writes it', call('CanSleep').b, true);
asleep.add(2); // night falls on the creep (tickCreep)
check('UnitIsSleeping reads asleep', call('Sleeping').b, true);
call('Wake');
check('UnitWakeUp wakes it', call('Sleeping').b, false);
asleep.add(2);
call('SleepOff');
check('UnitAddSleep(false) takes it away', call('CanSleep').b, false);
check('…and the sleeper is up', call('Sleeping').b, false);
check('a null unit neither sleeps nor can', call('NullSleep').b, false);

console.log('\n--- a unit that has died ---');
alive.clear(); // gone from the sim, as GetDyingUnit's unit is by the time its trigger runs
check('the default still answers, off the handle\'s type', call('Speed').n, 270);
check('…and so does its food', call('GryphUsed').n, 4);

console.log(failures ? `\n${failures} failure(s).` : '\nAll unit-default checks passed.');
process.exit(failures ? 1 : 0);
