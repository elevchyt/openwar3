// The enter/leave-region pump re-tests only the units that MOVED (issue #387) — and the bar
// that has to clear is that it fires exactly what re-testing every unit fires, in the same order.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-region-pump-test.cjs
//
// Sixty walkers wander a field of regions for a thousand pumps: a plain rect watched both ways,
// a two-rect region with a cell cleared out of it (RegionClearCell), and a rect the script MOVES
// every so often (MoveRectTo) — the case where a unit standing still crosses an edge. Walkers
// leave the world and new ones arrive. The run is made twice, with `RegionDiff` on and off, and
// the two logs of crossings must be the same string.
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
const { RegionDiff } = require(join(BUILD, 'jass', 'interpreter.js'));

const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j.");
  process.exit(2);
}
const common = new TextDecoder('windows-1252').decode(readFileSync(join(SCRIPTS, 'common.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${ok ? got : `${got} (want ${want})`}`);
};

const SRC = `
globals
    string log = ""
    rect moving = null
endglobals
function Mark takes string what, unit u returns nothing
    set log = log + what + I2S(GetUnitTypeId(u)) + ";"
endfunction
function EnterA takes nothing returns nothing
    call Mark("A+", GetEnteringUnit())
endfunction
function LeaveA takes nothing returns nothing
    call Mark("A-", GetLeavingUnit())
endfunction
function EnterR takes nothing returns nothing
    call Mark("R+", GetEnteringUnit())
endfunction
function LeaveR takes nothing returns nothing
    call Mark("R-", GetLeavingUnit())
endfunction
function EnterM takes nothing returns nothing
    call Mark("M+", GetEnteringUnit())
endfunction
function LeaveM takes nothing returns nothing
    call Mark("M-", GetLeavingUnit())
endfunction
function Watch takes region r, code enter, code leave returns nothing
    local trigger te = CreateTrigger()
    local trigger tl = CreateTrigger()
    call TriggerAddAction(te, enter)
    call TriggerAddAction(tl, leave)
    call TriggerRegisterEnterRegion(te, r, null)
    call TriggerRegisterLeaveRegion(tl, r, null)
endfunction
function InitT takes nothing returns nothing
    local region a = CreateRegion()
    local region r = CreateRegion()
    local region m = CreateRegion()
    call RegionAddRect(a, Rect(-600.0, -600.0, -100.0, -100.0))
    call RegionAddRect(r, Rect(100.0, 100.0, 700.0, 400.0))
    call RegionAddRect(r, Rect(300.0, 300.0, 600.0, 800.0))
    call RegionClearCell(r, 450.0, 350.0)
    set moving = Rect(-300.0, 200.0, 0.0, 500.0)
    call RegionAddRect(m, moving)
    call Watch(a, function EnterA, function LeaveA)
    call Watch(r, function EnterR, function LeaveR)
    call Watch(m, function EnterM, function LeaveM)
endfunction
function Shift takes real x, real y returns nothing
    call MoveRectTo(moving, x, y)
endfunction
`;

/** Deterministic pseudo-random, so both arms see exactly the same walk. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function run(incremental) {
  RegionDiff.enabled = incremental;
  const r = rng(0x387);
  const world = [];
  let nextId = 1;
  const born = () => {
    const id = nextId++;
    // A type id per walker (h000…), so the log can say WHICH unit crossed.
    world.push({ id, typeId: 'h' + String(id).padStart(3, '0'), owner: 0, x: (r() - 0.5) * 1800, y: (r() - 0.5) * 1800, facing: 0 });
  };
  for (let i = 0; i < 60; i++) born();
  const interp = buildInterpreter([common, SRC], {
    hooks: {
      getUnitX: (id) => world.find((u) => u.id === id)?.x,
      getUnitY: (id) => world.find((u) => u.id === id)?.y,
    },
  });
  interp.run('InitT', []);
  for (let pump = 0; pump < 1000; pump++) {
    // Half the walkers stand still on any pump, which is what the incremental path skips.
    for (const u of world) {
      if (r() < 0.5) continue;
      u.x = Math.max(-900, Math.min(900, u.x + (r() - 0.5) * 120));
      u.y = Math.max(-900, Math.min(900, u.y + (r() - 0.5) * 120));
    }
    if (pump % 37 === 0) world.splice(Math.floor(r() * world.length), 1); // one leaves the world…
    if (pump % 41 === 0) born(); // …and one arrives
    if (pump % 53 === 0) interp.run('Shift', [{ k: 'real', n: (r() - 0.5) * 1200 }, { k: 'real', n: (r() - 0.5) * 1200 }]);
    interp.pumpRegions(world.map((u) => ({ ...u })));
  }
  return interp.rt.globals.get('log').s;
}

console.log('the region pump, incremental and whole');
const whole = run(false);
const quick = run(true);
check('crossings were fired', whole.split(';').length > 500, true);
check('the moving rect caught somebody', /M\+/.test(whole), true);
check('the incremental pump fires the same crossings in the same order', quick === whole, true);
if (quick !== whole) {
  let i = 0;
  while (i < quick.length && quick[i] === whole[i]) i++;
  console.log(`        first difference at ${i}:\n        whole ${whole.slice(Math.max(0, i - 40), i + 40)}\n        quick ${quick.slice(Math.max(0, i - 40), i + 40)}`);
}
RegionDiff.enabled = true;

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nregion pump: all checks passed');
