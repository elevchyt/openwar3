// The 1.31 object-FIELD accessors (src/compat/blzFields.ts, natives/blzFields.ts).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-blz-fields-test.cjs
//
// Two things have to hold and neither is visible from either side alone: the PRELUDE's
// constants and the NATIVE's table must agree on every index (they are generated from one
// array, so this pins that they still are), and a field must come back as the TYPE ROW's value
// rather than as a default. The primary attribute is checked by name, because its values are
// the one thing here that a map compares against as literals.
//
// Reads only the developer's own local install (gitignored; zero shipped assets).

const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src');
if (!existsSync(join(BUILD, 'compat', 'blzFields.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'jass', 'headless.js'));
const { COMPAT_PRELUDE } = require(join(BUILD, 'compat', 'prelude.js'));
const { UNIT_INTEGER_FIELDS, UNIT_REAL_FIELDS, UNIT_BOOLEAN_FIELDS, fieldConstantsJass } = require(join(BUILD, 'compat', 'blzFields.js'));

const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j.");
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

// A stand-in registry row: one hero with values nothing else would produce, so a default is
// unmistakable. The keys are the compatibility layer's own (src/compat/blzFields.ts).
const ROW = {
  primaryAttribute: 2, // as the bridge converts it: 2 = intelligence
  level: 7,
  strengthPerLevel: 2.5,
  agilityPerLevel: 1.25,
  intelligencePerLevel: 3.75,
  scalingValue: 1.15,
  acquisitionRange: 640,
  goldBountyBase: 33,
  isHero: true,
  isBuilding: false,
};
const hooks = {
  createUnit: () => 1,
  unitTypeField: (unitId, field) => (unitId === 1 ? ROW[field] : undefined),
};

const SRC = `
globals
    unit u = null
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'Hblm', 0.0, 0.0, 0.0)
endfunction
function PrimaryAttr takes nothing returns integer
    return BlzGetUnitIntegerField(u, UNIT_IF_PRIMARY_ATTRIBUTE)
endfunction
function Level takes nothing returns integer
    return BlzGetUnitIntegerField(u, UNIT_IF_LEVEL)
endfunction
function Bounty takes nothing returns integer
    return BlzGetUnitIntegerField(u, UNIT_IF_GOLD_BOUNTY_AWARDED_BASE)
endfunction
function StrPerLevel takes nothing returns real
    return BlzGetUnitRealField(u, UNIT_RF_STRENGTH_PER_LEVEL)
endfunction
function IntPerLevel takes nothing returns real
    return BlzGetUnitRealField(u, UNIT_RF_INTELLIGENCE_PER_LEVEL)
endfunction
function Scale takes nothing returns real
    return BlzGetUnitRealField(u, UNIT_RF_SCALING_VALUE)
endfunction
function Acquire takes nothing returns real
    return BlzGetUnitRealField(u, UNIT_RF_ACQUISITION_RANGE)
endfunction
function IsHero takes nothing returns boolean
    return BlzGetUnitBooleanField(u, UNIT_BF_IS_A_HERO_UNIT)
endfunction
function IsBuilding takes nothing returns boolean
    return BlzGetUnitBooleanField(u, UNIT_BF_IS_A_BUILDING)
endfunction
// A field we DECLARE and have no value for answers its typed default, never a wrong number.
function Unanswered takes nothing returns real
    return BlzGetUnitRealField(u, UNIT_RF_OCCLUSION_HEIGHT)
endfunction
// …and two different constants are two different handles.
function FieldsDiffer takes nothing returns boolean
    return UNIT_IF_LEVEL != UNIT_IF_PRIMARY_ATTRIBUTE
endfunction
// A per-unit WRITE is refused and says so, rather than reporting a success nobody made.
function WriteRefused takes nothing returns boolean
    return BlzSetUnitRealField(u, UNIT_RF_STRENGTH_PER_LEVEL, 9.0) == false
endfunction
`;

const notes = [];
const realInfo = console.info;
console.info = (...a) => notes.push(a.join(' '));
const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks });
interp.callFunction('Make', []);
console.info = realInfo;

const call = (fn) => interp.callFunction(fn, []);

console.log('--- the constants reach the table ---');
check('the primary attribute comes back as the row says', call('PrimaryAttr').n, 2);
check('an integer field reads the row', call('Level').n, 7);
check('…and another one', call('Bounty').n, 33);
check('a real field reads the row', call('StrPerLevel').n, 2.5);
check('…and is not the neighbouring constant', call('IntPerLevel').n, 3.75);
check('a scale', call('Scale').n, 1.15);
check('a range', call('Acquire').n, 640);
check('a boolean field', call('IsHero').b, true);
check('…and a false one', call('IsBuilding').b, false);
check('two constants are two handles', call('FieldsDiffer').b, true);

console.log('\n--- what we do not have, we do not invent ---');
check('an unanswered field is the typed default', call('Unanswered').n, 0);
check('a per-unit write is refused', call('WriteRefused').b, true);

console.log('\n--- the prelude and the table cannot drift ---');
const jass = fieldConstantsJass();
for (const [family, list] of [['UNIT_IF', UNIT_INTEGER_FIELDS], ['UNIT_RF', UNIT_REAL_FIELDS], ['UNIT_BF', UNIT_BOOLEAN_FIELDS]]) {
  for (const [i, f] of list.entries()) {
    if (!jass.includes(`${f.name} = Convert`) || !jass.includes(`(${i})`)) {
      console.log(`FAIL  ${f.name} is not declared at index ${i}`);
      failures++;
    }
  }
}
check('every constant is generated once', jass.split('\n').filter((l) => l.includes('constant')).length,
  UNIT_INTEGER_FIELDS.length + UNIT_REAL_FIELDS.length + UNIT_BOOLEAN_FIELDS.length + require(join(BUILD, 'compat', 'blzFields.js')).UNIT_STRING_FIELDS.length);

console.log(failures ? `\n${failures} failure(s).` : '\nAll field-accessor checks passed.');
process.exit(failures ? 1 : 0);
