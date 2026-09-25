// The 1.31 ability-field API's JASS half (src/jass/natives/abilityFields.ts, the constants in
// src/compat/blzFields.ts, the BJ wrappers in src/compat/prelude.ts) through the real interpreter
// against the install's own common.j and Blizzard.j, with our compat prelude between them — the
// load order a later-format map gets.
//
//   * every ability-field constant carries a REAL `Units\AbilityMetaData.slk` id, and the one a
//     map names is the one the engine is asked about (`ABILITY_ILF_ATTACK_BONUS` → 'Iatt');
//   * a level is the MAP's count: 0 is rank 1 on a 1.31+ map, 1 is rank 1 on an older one;
//   * the instance handles are interned and null where there is no instance;
//   * the GUI's `Blz…FieldBJ` actions exist and reach the natives;
//   * ParseTags hands untagged text back unchanged; SetUnitExploded, BlzStartUnitAbilityCooldown
//     and the 1.32 cinematic volume groups reach the engine.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-ability-fields-test.cjs
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
const { ABILITY_FIELDS } = require(join(BUILD, 'compat', 'blzFields.js'));

const MERGED = join(REPO, 'Warcraft III', 'ExtractedData', 'merged');
if (!existsSync(join(MERGED, 'Scripts', 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j, Blizzard.j and AbilityMetaData.");
  process.exit(2);
}
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const common = decode(readFileSync(join(MERGED, 'Scripts', 'common.j')));
const blizzard = decode(readFileSync(join(MERGED, 'Scripts', 'Blizzard.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};
const J = (x) => JSON.stringify(x);

console.log('--- the constants ---');
{
  const metaIds = new Set(readFileSync(join(MERGED, 'Units', 'AbilityMetaData.csv'), 'latin1').split(/\r?\n/).slice(1).map((l) => l.split(',')[0]));
  const missing = ABILITY_FIELDS.filter((f) => !metaIds.has(f.id)).map((f) => `${f.name}=${f.id}`);
  check(`every one of the ${ABILITY_FIELDS.length} ability-field constants is a real AbilityMetaData id`, missing.join(',') || 'all', 'all');
  const suffixed = ABILITY_FIELDS.filter((f) => /_[A-Z0-9]{4}$/.test(f.name) && !/_(BONUS|ABILITY|COOLDOWN|EXTENDED|HIT|NORMAL)$/.test(f.name));
  const wrong = suffixed.filter((f) => f.name.slice(-4).toLowerCase() !== f.id.toLowerCase()).map((f) => f.name);
  check('where the name carries an id suffix, it IS the id', wrong.join(',') || 'all', 'all');
}

const calls = [];
let next = 1;
const units = new Map(); // simId → abilities
const hooks = {
  createUnit: () => { const id = next++; units.set(id, ['A0PD', 'AInv']); return id; },
  createItem: () => next++,
  unitHasAbility: (id, a) => (units.get(id) ?? []).includes(a),
  unitAbilityAt: (id, i) => (units.get(id) ?? [])[i],
  itemAbilityIds: () => ['AIat', 'AIde'],
  abilityField: (ref, id, level) => { calls.push(['get', ref.kind, ref.abilId, id, level]); return id === 'aite' ? true : id === 'aub1' ? 'tip' : 7; },
  setAbilityField: (ref, id, level, value) => { calls.push(['set', ref.kind, ref.abilId, id, level, value]); return true; },
  startUnitAbilityCooldown: (id, a, s) => calls.push(['cd', a, s]),
  unitAbilityRankData: (id, a, rank) => ({ cost: 10 + rank, cooldown: 20 + rank }),
  setUnitExploded: (id, on) => calls.push(['explode', on]),
  setVolumeGroup: (g, v) => calls.push(['vg', g, v]),
};

const SRC = `
globals
    unit u = null
    item it = null
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'n02S', 0.0, 0.0, 0.0)
    set it = CreateItem('rat9', 0.0, 0.0)
endfunction
function StackItem takes integer charges returns nothing
    // Test of Balance line 13193, verbatim in shape.
    call BlzSetAbilityIntegerLevelFieldBJ(BlzGetItemAbilityByIndex(it, 0), ABILITY_ILF_ATTACK_BONUS, 0, 9 * charges)
endfunction
function PillarHeal takes integer lvl returns nothing
    call BlzSetAbilityRealLevelFieldBJ(BlzGetUnitAbility(u, 'A0PD'), ABILITY_RLF_HIT_POINTS_GAINED_REJ1, lvl, 260.0)
    call BlzSetAbilityStringLevelFieldBJ(BlzGetUnitAbility(u, 'A0PD'), ABILITY_SLF_TOOLTIP_NORMAL_EXTENDED, lvl, "Restores 260")
endfunction
function IsItemAbility takes nothing returns boolean
    return BlzGetAbilityBooleanField(BlzGetUnitAbility(u, 'A0PD'), ABILITY_BF_ITEM_ABILITY)
endfunction
function Missing takes nothing returns boolean
    return BlzGetUnitAbility(u, 'AHbz') == null
endfunction
function Same takes nothing returns boolean
    return BlzGetUnitAbility(u, 'A0PD') == BlzGetUnitAbility(u, 'A0PD') and BlzGetUnitAbilityByIndex(u, 0) == BlzGetUnitAbility(u, 'A0PD')
endfunction
function ItemSecond takes nothing returns integer
    return BlzGetAbilityId(BlzGetItemAbilityByIndex(it, 1))
endfunction
function ItemPastEnd takes nothing returns boolean
    return BlzGetItemAbilityByIndex(it, 2) == null
endfunction
function Cooldown takes nothing returns real
    return BlzGetUnitAbilityCooldown(u, 'A0PD', 0)
endfunction
function StartCd takes nothing returns nothing
    call BlzStartUnitAbilityCooldown(u, 'A0PD', 4.0)
endfunction
function Tags takes nothing returns string
    return ParseTags(R2S(2.5))
endfunction
function UnitFieldBJ takes nothing returns nothing
    call BlzSetUnitRealFieldBJ(u, UNIT_RF_TURN_RATE, 1.0)
endfunction
function Explode takes nothing returns nothing
    call SetUnitExploded(u, true)
endfunction
function Cinematic takes nothing returns nothing
    call VolumeGroupSetVolume(SOUND_VOLUMEGROUP_CINEMATIC_MUSIC, 0.0)
endfunction
`;

const quiet = [console.info, console.warn];
const build = (base) => {
  console.info = () => {};
  console.warn = () => {};
  const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks, blzIndexBase: base });
  interp.callFunction('Make', []);
  [console.info, console.warn] = quiet;
  return interp;
};
const I = (n) => ({ k: 'int', n });

console.log('\n--- a 1.31+ map (levels 0-based) ---');
{
  const interp = build(0);
  const call = (fn, args = []) => interp.callFunction(fn, args);
  calls.length = 0;
  call('StackItem', [I(3)]);
  check("an item's stacking bonus: ABILITY_ILF_ATTACK_BONUS is 'Iatt', level 0 is rank 1", J(calls[0]), J(['set', 'item', 'AIat', 'Iatt', 1, 27]));
  calls.length = 0;
  call('PillarHeal', [I(2)]);
  check("the pillar's heal: 'Rej1' on THIS unit's A0PD, level 2 is rank 3", J(calls[0]), J(['set', 'unit', 'A0PD', 'Rej1', 3, 260]));
  check("…and its tooltip: 'aub1', a string", J(calls[1]), J(['set', 'unit', 'A0PD', 'aub1', 3, 'Restores 260']));
  check('ABILITY_BF_ITEM_ABILITY asks for aite', call('IsItemAbility').b, true);
  check('a unit without the ability has no instance (null)', call('Missing').b, true);
  check('the handle is interned, by id and by index alike', call('Same').b, true);
  check("an item's second ability, by index", call('ItemSecond').n, 'AIde'.split('').reduce((v, ch) => v * 256 + ch.charCodeAt(0), 0));
  check('past the end is null', call('ItemPastEnd').b, true);
  check("BlzGetUnitAbilityCooldown reads the unit's instance, level 0 = rank 0", call('Cooldown').n, 20);
  calls.length = 0;
  call('StartCd');
  check('BlzStartUnitAbilityCooldown reaches the engine', J(calls[0]), J(['cd', 'A0PD', 4]));
  check('ParseTags hands untagged text back unchanged', call('Tags').s, '2.500');
  call('UnitFieldBJ');
  check('the GUI field actions (BlzSetUnitRealFieldBJ) exist', 'ran', 'ran');
  calls.length = 0;
  call('Explode');
  check('SetUnitExploded reaches the engine', J(calls[0]), J(['explode', true]));
  calls.length = 0;
  call('Cinematic');
  check('the 1.32 cinematic volume groups are numbered past the eight 1.30.4 has', J(calls[0]), J(['vg', 10, 0]));
}

console.log('\n--- an older map (levels 1-based) ---');
{
  const interp = build(1);
  calls.length = 0;
  interp.callFunction('PillarHeal', [I(1)]);
  check('level 1 is rank 1', J(calls[0]), J(['set', 'unit', 'A0PD', 'Rej1', 1, 260]));
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll ability-field checks passed.');
process.exit(failures ? 1 : 0);
