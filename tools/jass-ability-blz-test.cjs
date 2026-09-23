// The `Blz…` ability natives' JASS half (src/jass/natives/abilityBlz.ts — docs/map-compatibility.md
// pass 9): that each reaches the right hook, and that an ability LEVEL is translated by the map's
// own convention.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-ability-blz-test.cjs
//
// 1.31 moved ability levels to 0-based in the same patch it moved weapons (hiveworkshop 316163),
// and the corpus proves the later-format maps use it: every one passes `GetUnitAbilityLevel(u, a)
// - 1` and writes the first rank's tooltip at level 0. So the same script is run under both bases
// here — read the wrong way round, `BlzSetAbilityTooltip(a, s, 0)` on a 1.30 map would write rank
// −1 and a Reforged map's rank-1 tooltip would land on rank 2.
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

function boot(base) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const hooks = {
    createUnit: () => 7,
    createItem: () => 55,
    unitDisableAbility: rec('disable'),
    unitHideAbility: rec('hide'),
    endUnitAbilityCooldown: rec('end'),
    unitAbilityCooldownLeft: (id, a) => (id === 7 && a === 'AHtb' ? 4.25 : 0),
    // rank r of every ability costs 100 + r and cools 10 + r — so a rank off by one shows.
    abilityRankData: (a, r) => (r >= 0 && r < 3 ? { cost: 100 + r, cooldown: 10 + r } : undefined),
    abilityText: (a, r, ext) => `${a}:${r}:${ext ? 'ext' : 'tip'}`,
    setAbilityText: rec('text'),
    abilityIcon: (a) => `icon-of-${a}`,
    setAbilityIcon: rec('icon'),
    setItemExtendedTooltip: rec('itemTip'),
  };
  const SRC = `
globals
    unit u = null
    item it = null
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'Hmkg', 0.0, 0.0, 0.0)
    set it = CreateItem('ratf', 0.0, 0.0)
endfunction
function Off takes nothing returns nothing
    call BlzUnitDisableAbility(u, 'AHtb', true, false)
    call BlzUnitDisableAbility(u, 'AHtb', false, true)
    call BlzUnitHideAbility(u, 'AHtc', true)
endfunction
function Left takes nothing returns real
    return BlzGetUnitAbilityCooldownRemaining(u, 'AHtb')
endfunction
function End takes nothing returns nothing
    call BlzEndUnitAbilityCooldown(u, 'AHtb')
endfunction
function Cost0 takes nothing returns integer
    return BlzGetAbilityManaCost('AHtb', 0)
endfunction
function Cost1 takes nothing returns integer
    return BlzGetAbilityManaCost('AHtb', 1)
endfunction
function UnitCd1 takes nothing returns real
    return BlzGetUnitAbilityCooldown(u, 'AHtb', 1)
endfunction
function Words takes nothing returns nothing
    call BlzSetAbilityTooltip('A000', "Select Fire", 0)
    call BlzSetAbilityExtendedTooltip('A000', "Burns things.", 1)
    call BlzSetAbilityIcon('A000', "ReplaceableTextures\\\\CommandButtons\\\\BTNFire.blp")
    call BlzSetItemExtendedTooltip(it, "Yours alone.")
endfunction
function Tip0 takes nothing returns string
    return BlzGetAbilityTooltip('A000', 0)
endfunction
function Icon takes nothing returns string
    return BlzGetAbilityIcon('A000')
endfunction
`;
  const quiet = [console.info, console.warn];
  console.info = () => {};
  console.warn = () => {};
  const interp = buildInterpreter([common, SRC], base === undefined ? { hooks } : { hooks, blzIndexBase: base });
  interp.callFunction('Make', []);
  [console.info, console.warn] = quiet;
  return { calls, call: (fn) => interp.callFunction(fn, []) };
}
const J = (x) => JSON.stringify(x);

console.log('--- one unit\'s ability: the counters and the clock ---');
{
  const t = boot(0);
  t.call('Off');
  check('a disable reaches the unit with its own id and flags', J(t.calls[0]), J(['disable', 7, 'AHtb', true, false]));
  check('…and an enable carries hideUI through', J(t.calls[1]), J(['disable', 7, 'AHtb', false, true]));
  check('BlzUnitHideAbility is its own hook', J(t.calls[2]), J(['hide', 7, 'AHtc', true]));
  check('cooldown remaining reads the unit\'s entry', t.call('Left').n, 4.25);
  t.calls.length = 0;
  t.call('End');
  check('BlzEndUnitAbilityCooldown ends that one', J(t.calls[0]), J(['end', 7, 'AHtb']));
}

console.log('\n--- a Reforged-era map: levels count from 0 ---');
{
  const t = boot(0);
  check('level 0 is rank 0', t.call('Cost0').n, 100);
  check('level 1 is rank 1', t.call('Cost1').n, 101);
  check('the unit-level reader answers the type', t.call('UnitCd1').n, 11);
  t.call('Words');
  check('a tooltip at level 0 is rank 0', J(t.calls[0]), J(['text', 'A000', 0, 'Select Fire', false]));
  check('an extended tooltip at level 1 is rank 1', J(t.calls[1]), J(['text', 'A000', 1, 'Burns things.', true]));
  check('the icon path crosses intact', t.calls[2][2], 'ReplaceableTextures\\CommandButtons\\BTNFire.blp');
  check('an item\'s tooltip is keyed on its ENTITY', J(t.calls[3]), J(['itemTip', 55, 'Yours alone.']));
  check('reading a tooltip back uses the same rank', t.call('Tip0').s, 'A000:0:tip');
  check('…and the icon', t.call('Icon').s, 'icon-of-A000');
}

console.log('\n--- a 1.30 map: levels count from 1 ---');
{
  const t = boot();
  check('level 1 is rank 0', t.call('Cost1').n, 100);
  check('level 0 names no rank at all', t.call('Cost0').n, 0);
  t.call('Words');
  check('a tooltip at level 0 is rank −1 — refused downstream', t.calls[0][2], -1);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll Blz ability native checks passed.');
process.exit(failures ? 1 : 0);
