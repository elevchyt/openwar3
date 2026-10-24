// A boolean compared with `null` (src/jass/values.ts — jassEquals).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-null-compare-test.cjs
//
// In the game's VM `false` and `null` are both a raw 0, so `false == null` is TRUE — and map
// optimizers lean on it: `IsUnitType(u, t) != null` is how they spell `!= false`.
// BleachVsOnepiece13 routes all 568 of its unit-type checks through one such wrapper,
//
//     function MG takes unit NG,unittype OG returns boolean
//     return(IsUnitType(NG,OG)!=null)
//     endfunction
//
// and the install's own DotA 6.77b AI and Angel Arena filter heroes the same way. Read as
// "only null equals null", every unit was every type. On BvO that meant: a hero is hired, it
// enters the spawn rect, the "a HERO enters" trigger makes a dummy at its feet to cast
// Rejuvenation — and the dummy, now "a hero" as well, enters the rect and makes another. The
// screen filled with dummies within a second of the hire and the match had to be killed.
//
// The second half reproduces that trigger's shape through the real interpreter and the real
// enter-rect pump, so the loop itself is what is pinned rather than only the operator.
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

// --- the operator ---------------------------------------------------------------------------
{
  const src = `
globals
    unit nobody = null
    boolean flag = false
endglobals
function FalseEqNull takes nothing returns boolean
    return false == null
endfunction
function NullEqFalse takes nothing returns boolean
    return null == false
endfunction
function FalseNeNull takes nothing returns boolean
    return false != null
endfunction
function TrueEqNull takes nothing returns boolean
    return true == null
endfunction
function TrueNeNull takes nothing returns boolean
    return true != null
endfunction
function FalseVarNeNull takes nothing returns boolean
    return flag != null
endfunction
function NullUnitEqNull takes nothing returns boolean
    return nobody == null
endfunction
function NullEqNull takes nothing returns boolean
    return null == null
endfunction
`;
  const interp = buildInterpreter([common, src]);
  const run = (fn) => interp.run(fn, []).b;
  check('false == null', run('FalseEqNull'), true);
  check('null == false', run('NullEqFalse'), true);
  check('false != null', run('FalseNeNull'), false);
  check('true == null', run('TrueEqNull'), false);
  check('true != null', run('TrueNeNull'), true);
  check('a false boolean VARIABLE != null', run('FalseVarNeNull'), false);
  check('a null unit == null (unchanged)', run('NullUnitEqNull'), true);
  check('null == null (unchanged)', run('NullEqNull'), true);
}

// --- BvO's spawn rect -----------------------------------------------------------------------
// `MG` verbatim; `Cond`/`Act` are `g44`/`ge4` cut down to the branch that fires in the lobby.
{
  const HERO = 'H003';
  const DUMMY = 'u002';
  const world = []; // what the pump sees — the hero, and every dummy the trigger makes
  let nextId = 100;
  const hooks = {
    createUnit: (player, typeId, x, y, facing) => {
      const id = nextId++;
      world.push({ id, typeId, owner: player, x, y, facing });
      return id;
    },
    isUnitType: (id, type, typeId) => type === 0 /* UNIT_TYPE_HERO */ && typeId === HERO,
    isUnitIllusion: () => false,
  };
  const src = `
globals
    trigger t = null
    integer spawned = 0
endglobals
function MG takes unit NG,unittype OG returns boolean
return(IsUnitType(NG,OG)!=null)
endfunction
function Cond takes nothing returns boolean
    return MG(GetEnteringUnit(), UNIT_TYPE_HERO) or IsUnitIllusion(GetEnteringUnit())
endfunction
function Act takes nothing returns nothing
    local unit u = GetEnteringUnit()
    call CreateUnit(GetOwningPlayer(u), '${DUMMY}', GetUnitX(u), GetUnitY(u), 270.0)
    set spawned = spawned + 1
endfunction
function InitT takes nothing returns nothing
    set t = CreateTrigger()
    call TriggerRegisterEnterRectSimple(t, Rect(-500.0, -500.0, 500.0, 500.0))
    call TriggerAddCondition(t, Condition(function Cond))
    call TriggerAddAction(t, function Act)
endfunction
function DummyIsHero takes nothing returns boolean
    return MG(CreateUnit(Player(0), '${DUMMY}', 900.0, 900.0, 0.0), UNIT_TYPE_HERO)
endfunction
`;
  const interp = buildInterpreter([common, src], {
    hooks: {
      ...hooks,
      getUnitX: (id) => world.find((u) => u.id === id)?.x,
      getUnitY: (id) => world.find((u) => u.id === id)?.y,
    },
  });
  interp.run('InitT', []);
  interp.pumpRegions(world); // baseline tick: nothing in the world yet
  // The tavern sells the hero; it lands inside the rect.
  world.push({ id: 1, typeId: HERO, owner: 0, x: 0, y: 0, facing: 0 });
  for (let tick = 0; tick < 10; tick++) interp.pumpRegions(world);
  const spawned = interp.rt.globals.get('spawned')?.n ?? -1;
  check('the hero entering the rect makes exactly one dummy (no dummy re-fires it)', spawned, 1);
  check('units in the world after ten ticks (hero + one dummy)', world.filter((u) => u.x === 0).length, 2);
  check('MG(dummy, UNIT_TYPE_HERO) is false', interp.run('DummyIsHero', []).b, false);
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
