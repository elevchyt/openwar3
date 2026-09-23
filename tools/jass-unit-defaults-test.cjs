// The `GetUnitDefault…` natives and `GetUnitAcquireRange` (src/jass/natives/world.ts): that each
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

// Two stand-in rows — a walker and a flyer — distinct in every column so a crossed wire shows.
const ROWS = {
  hfoo: { moveSpeed: 270, turnRate: 0.6, flyHeight: 0, acquireRange: 500 },
  hgry: { moveSpeed: 350, turnRate: 0.5, flyHeight: 250, acquireRange: 600 },
};
let next = 1;
const alive = new Set();
const hooks = {
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
endglobals
function Make takes nothing returns nothing
    set foot = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
    set gryph = CreateUnit(Player(0), 'hgry', 0.0, 0.0, 0.0)
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

console.log('\n--- a unit that has died ---');
alive.clear(); // gone from the sim, as GetDyingUnit's unit is by the time its trigger runs
check('the default still answers, off the handle\'s type', call('Speed').n, 270);

console.log(failures ? `\n${failures} failure(s).` : '\nAll unit-default checks passed.');
process.exit(failures ? 1 : 0);
