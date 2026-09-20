// The `Is…` predicates a custom map gates on (src/jass/natives/predicates.ts —
// docs/map-compatibility.md pass 4).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-predicates-test.cjs
//
// These are worth a test out of proportion to their size because they are all CONDITIONS. An
// unimplemented native returns a typed default and the typed default of a boolean is FALSE, so
// an unanswered predicate does not degrade a map's behaviour — it inverts it. The same is true
// of one wired to the wrong hook: five different vision questions answered by one would be
// silently plausible everywhere and wrong in exactly the places a map cares about.
//
// So the stubs here answer each hook DIFFERENTLY, and the test asserts which one was reached.
// The polarity of `IsTerrainPathable` gets the same treatment, because its name says the
// opposite of what it returns and the install is the authority for that (see below).
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
// Unit 1 is ours (player 0), a human, an illusion, and every vision question about it answers a
// DIFFERENT way — so a native wired to the wrong hook cannot pass by accident.
const rangeCalls = [];
const terrainCalls = [];
const hooks = {
  createUnit: (player, typeId) => (typeId === 'hfoo' ? 1 : 2),
  getUnitX: (id) => (id === 1 ? 100 : 5000),
  getUnitY: (id) => (id === 1 ? 200 : 5000),
  isUnitIllusion: (id) => id === 1,
  unitRace: (id) => (id === 1 ? 'human' : 'orc'),
  isUnitIdType: (typeId, type) => typeId === 'Hamg' && type === 0,
  selectedUnits: (player) => (player === 0 ? [1] : []),
  isUnitInRange: (id, other, d) => { rangeCalls.push(['unit', id, other, d]); return d >= 300; },
  isUnitInRangeXY: (id, x, y, d) => { rangeCalls.push(['xy', id, x, y, d]); return d >= 300; },
  isTerrainPathable: (x, y, t) => { terrainCalls.push([x, y, t]); return t === 3; },
  worldBounds: () => ({ minx: -4096, miny: -3072, maxx: 4096, maxy: 3072 }),
  // The five vision questions, each answering for a different unit id.
  isUnitVisibleTo: (id) => id === 1,
  isUnitFoggedTo: (id) => id === 2,
  isUnitMaskedTo: () => false,
  isUnitInvisibleTo: (id) => id === 2,
  isUnitDetectedTo: (id) => id === 1,
  isPointVisibleTo: (p, x) => x === 100,
  isPointFoggedTo: (p, x) => x === 900,
  isPointMaskedTo: (p, x) => x === 4000,
};

const SRC = `
globals
    unit a = null
    unit b = null
    force f = null
    region r = null
    location p = null
endglobals
function Make takes nothing returns nothing
    set a = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
    set b = CreateUnit(Player(1), 'ogru', 0.0, 0.0, 0.0)
    set f = CreateForce()
    call ForceAddPlayer(f, Player(0))
    set r = CreateRegion()
    call RegionAddRect(r, Rect(0.0, 0.0, 250.0, 250.0))
    call RegionAddRect(r, Rect(500.0, 500.0, 600.0, 600.0))
    set p = Location(100.0, 200.0)
endfunction
function SameUnit takes nothing returns boolean
    return IsUnit(a, a)
endfunction
function DifferentUnit takes nothing returns boolean
    return IsUnit(a, b)
endfunction
function OwnedByUs takes nothing returns boolean
    return IsUnitOwnedByPlayer(a, Player(0))
endfunction
function OwnedByThem takes nothing returns boolean
    return IsUnitOwnedByPlayer(a, Player(1))
endfunction
function InOurForce takes nothing returns boolean
    return IsUnitInForce(a, f)
endfunction
function TheirsInOurForce takes nothing returns boolean
    return IsUnitInForce(b, f)
endfunction
function IsHuman takes nothing returns boolean
    return IsUnitRace(a, RACE_HUMAN)
endfunction
function IsOrc takes nothing returns boolean
    return IsUnitRace(a, RACE_ORC)
endfunction
function HeroId takes nothing returns boolean
    return IsHeroUnitId('Hamg')
endfunction
function FootmanId takes nothing returns boolean
    return IsHeroUnitId('hfoo')
endfunction
function Illusion takes nothing returns boolean
    return IsUnitIllusion(a)
endfunction
function NotIllusion takes nothing returns boolean
    return IsUnitIllusion(b)
endfunction
function Selected takes nothing returns boolean
    return IsUnitSelected(a, Player(0))
endfunction
function NotSelected takes nothing returns boolean
    return IsUnitSelected(a, Player(1))
endfunction
function InRangeNear takes nothing returns boolean
    return IsUnitInRange(a, b, 500.0)
endfunction
function InRangeFar takes nothing returns boolean
    return IsUnitInRange(a, b, 10.0)
endfunction
function InRangeXY takes nothing returns boolean
    return IsUnitInRangeXY(a, 700.0, 800.0, 500.0)
endfunction
function InRangeLoc takes nothing returns boolean
    return IsUnitInRangeLoc(a, p, 500.0)
endfunction
function Visible takes nothing returns boolean
    return IsUnitVisible(a, Player(0))
endfunction
function VisibleB takes nothing returns boolean
    return IsUnitVisible(b, Player(0))
endfunction
function Fogged takes nothing returns boolean
    return IsUnitFogged(b, Player(0))
endfunction
function Masked takes nothing returns boolean
    return IsUnitMasked(a, Player(0))
endfunction
function Invisible takes nothing returns boolean
    return IsUnitInvisible(b, Player(0))
endfunction
function Detected takes nothing returns boolean
    return IsUnitDetected(a, Player(0))
endfunction
function LocVisible takes nothing returns boolean
    return IsLocationVisibleToPlayer(p, Player(0))
endfunction
function LocFogged takes nothing returns boolean
    return IsLocationFoggedToPlayer(p, Player(0))
endfunction
function PointInFirstRect takes nothing returns boolean
    return IsPointInRegion(r, 50.0, 50.0)
endfunction
function PointInSecondRect takes nothing returns boolean
    return IsPointInRegion(r, 550.0, 550.0)
endfunction
function PointBetweenRects takes nothing returns boolean
    return IsPointInRegion(r, 400.0, 400.0)
endfunction
function UnitInRegion takes nothing returns boolean
    return IsUnitInRegion(r, a)
endfunction
function OtherUnitInRegion takes nothing returns boolean
    return IsUnitInRegion(r, b)
endfunction
// The polarity case. The stub says BUILDABILITY is blocked and walkability is not.
function BuildBlocked takes nothing returns boolean
    return IsTerrainPathable(64.0, 64.0, PATHING_TYPE_BUILDABILITY)
endfunction
function WalkBlocked takes nothing returns boolean
    return IsTerrainPathable(64.0, 64.0, PATHING_TYPE_WALKABILITY)
endfunction
// A pathing type our grid carries no bit for is reported pathable, not blocked.
function BlightBlocked takes nothing returns boolean
    return IsTerrainPathable(64.0, 64.0, PATHING_TYPE_BLIGHTPATHING)
endfunction
function WorldMinX takes nothing returns real
    return GetRectMinX(GetWorldBounds())
endfunction
function WorldMaxY takes nothing returns real
    return GetRectMaxY(GetWorldBounds())
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
const B = (fn) => call(fn).b;

console.log('--- identity, ownership, membership ---');
check('a unit is itself', B('SameUnit'), true);
check('…and is not the other one', B('DifferentUnit'), false);
check('ours is owned by us', B('OwnedByUs'), true);
check('…and not by them', B('OwnedByThem'), false);
check('a force member is in the force', B('InOurForce'), true);
check('…and a non-member is not', B('TheirsInOurForce'), false);

console.log('\n--- classification ---');
check('RACE_HUMAN matches a human', B('IsHuman'), true);
check('…and RACE_ORC does not', B('IsOrc'), false);
check('a hero type id is a hero', B('HeroId'), true);
check('…and a Footman is not', B('FootmanId'), false);
check('an illusion is one', B('Illusion'), true);
check('…and the original is not', B('NotIllusion'), false);
check('a selected unit is selected', B('Selected'), true);
check('…for that player only', B('NotSelected'), false);

console.log('\n--- range: the distance reaches the engine unchanged ---');
rangeCalls.length = 0;
check('a generous range is in range', B('InRangeNear'), true);
check('…and a tight one is not', B('InRangeFar'), false);
check('the unit form asks the unit hook', rangeCalls[0][0], 'unit');
check('…with the distance as written', rangeCalls[0][3], 500);
check('…and the far one likewise', rangeCalls[1][3], 10);
rangeCalls.length = 0;
B('InRangeXY');
check('the XY form asks the point hook', rangeCalls[0][0], 'xy');
check('…with the point as written', `${rangeCalls[0][2]},${rangeCalls[0][3]}`, '700,800');
rangeCalls.length = 0;
B('InRangeLoc');
check('a location is unpacked into the same hook', `${rangeCalls[0][2]},${rangeCalls[0][3]}`, '100,200');

console.log('\n--- the five vision questions are five, not one ---');
check('IsUnitVisible', B('Visible'), true);
check('…and is false for the other unit', B('VisibleB'), false);
check('IsUnitFogged is its own question', B('Fogged'), true);
check('IsUnitMasked is its own question', B('Masked'), false);
check('IsUnitInvisible is its own question', B('Invisible'), true);
check('IsUnitDetected is its own question', B('Detected'), true);
check('a location can be visible', B('LocVisible'), true);
check('…and fogged is asked separately', B('LocFogged'), false);

console.log('\n--- a region is a UNION of its rects ---');
check('inside the first rect', B('PointInFirstRect'), true);
check('inside the second rect', B('PointInSecondRect'), true);
check('between them is outside', B('PointBetweenRects'), false);
check('a unit standing in one is in the region', B('UnitInRegion'), true);
check('…and one far away is not', B('OtherUnitInRegion'), false);

console.log('\n--- IsTerrainPathable returns TRUE when pathing is OFF ---');
// `UI\TriggerStrings.txt` is the authority, in the install's own words:
//   IsTerrainPathableBJ="Terrain Pathing Is Off"
//   IsTerrainPathableBJHint="Terrain pathing is off if it is not pathable to the given
//   pathing type.  For example, 'Buildability' is off if the pathing cell is unbuildable."
terrainCalls.length = 0;
check('unbuildable ground answers TRUE', B('BuildBlocked'), true);
check('walkable ground answers FALSE', B('WalkBlocked'), false);
check('the pathing type reaches the engine', terrainCalls[0][2], 3);
check('…and so does the point', `${terrainCalls[0][0]},${terrainCalls[0][1]}`, '64,64');
check('a type we have no bit for is reported pathable', B('BlightBlocked'), false);
check('…and it never reached the engine', terrainCalls.length, 2);

console.log('\n--- GetWorldBounds is a real rect ---');
check('its min x', call('WorldMinX').n, -4096);
check('its max y', call('WorldMaxY').n, 3072);

console.log(failures ? `\n${failures} failure(s).` : '\nAll predicate checks passed.');
process.exit(failures ? 1 : 0);
