// The natives Test of Balance and Balanced Hero Survival reach only THROUGH blizzard.j, called
// the way the maps call them — through the BJ — against stub hooks that record what arrived.
// What each one then DOES is tools/sim-script-natives-test.cjs; this pins the wiring: that
// every argument reaches the engine in the right slot, and that a BJ which decides something
// on the way (SetHeroLevelBJ going down, GetPlayerHandicapXPBJ's ×100) decides it right.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-script-natives-test.cjs
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
const { rawcodeToInt } = require(join(BUILD, 'jass', 'lexer.js'));
const { learnOrderStrings } = require(join(BUILD, 'jass', 'orders.js'));

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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

const calls = [];
const rates = new Map();
const hooks = {
  createUnit: () => 1,
  getUnitLevel: () => 7,
  setHeroLevel: (id, level) => calls.push(['setHeroLevel', id, level]),
  stripHeroLevel: (id, n) => (calls.push(['strip', id, n]), true),
  xpHandicap: (p) => rates.get(p) ?? 1,
  setXpHandicap: (p, r) => rates.set(p, r),
  pauseTimedLife: (id, flag) => calls.push(['pauseTimedLife', id, flag]),
  setUnitClassification: (id, t, on) => (calls.push(['class', id, t, on]), t >= 9 && t <= 20),
  removeBuffs: (id, q) => calls.push(['removeBuffs', id, q]),
  countBuffs: (id, q) => (calls.push(['countBuffs', id, q]), 2),
  damagePoint: (src, delay, radius, x, y, amount, opts) => (calls.push(['damagePoint', src, delay, radius, x, y, amount, opts]), true),
  damageTarget: (src, tgt, amount, opts) => (calls.push(['damageTarget', src, tgt, amount, opts]), amount),
  createCorpse: (typeId, x, y, owner) => typeId !== 'htow',
  chooseRandomCreep: (level) => (level === 3 ? 'nkob' : ''),
  unitTypeByName: (name) => (name === 'footman' ? 'hfoo' : ''),
  unitTypeName: (id) => (id === 'hfoo' ? 'footman' : undefined),
  terrainCliffLevel: (x, y) => (x > 0 ? 3 : 2),
  pauseCompAi: (p, pause) => calls.push(['pauseCompAi', p, pause]),
};

const SRC = `
globals
    unit u = null
    unit corpse = null
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'Hpal', 0.0, 0.0, 0.0)
endfunction
function LevelDown takes nothing returns nothing
    call SetHeroLevelBJ(u, 3, false)
endfunction
function HandicapPct takes nothing returns real
    return GetPlayerHandicapXPBJ(Player(1))
endfunction
function HalveHandicap takes nothing returns nothing
    call SetPlayerHandicapXPBJ(Player(1), GetPlayerHandicapXPBJ(Player(1)) / 2.00)
endfunction
function Pause takes nothing returns nothing
    call UnitPauseTimedLifeBJ(true, u)
endfunction
function Types takes nothing returns boolean
    call UnitRemoveTypeBJ(UNIT_TYPE_MECHANICAL, u)
    return UnitAddTypeBJ(UNIT_TYPE_GROUND, u)
endfunction
function StripNegative takes nothing returns nothing
    call UnitRemoveBuffsBJ(bj_REMOVEBUFFS_NEGATIVE, u)
endfunction
function StripNonTLife takes nothing returns nothing
    call UnitRemoveBuffsBJ(bj_REMOVEBUFFS_NONTLIFE, u)
endfunction
function CountMagicNeg takes nothing returns integer
    return UnitCountBuffsExBJ(bj_BUFF_POLARITY_NEGATIVE, bj_BUFF_RESIST_MAGIC, u, false, true)
endfunction
function Blast takes nothing returns boolean
    return UnitDamagePointLoc(u, 0.5, 250.0, Location(64.0, 32.0), 100.0, ATTACK_TYPE_CHAOS, DAMAGE_TYPE_UNIVERSAL)
endfunction
function Hit takes nothing returns nothing
    call UnitDamageTarget(u, u, 40.0, true, false, ATTACK_TYPE_HERO, DAMAGE_TYPE_FIRE, WEAPON_TYPE_METAL_HEAVY_SLICE)
endfunction
function Body takes nothing returns boolean
    set corpse = CreateCorpseLocBJ('hfoo', Player(2), Location(10.0, 20.0))
    return corpse != null
endfunction
function NoBody takes nothing returns boolean
    return CreateCorpseLocBJ('htow', Player(2), Location(10.0, 20.0)) == null
endfunction
function Creep takes integer level returns integer
    return ChooseRandomCreepBJ(level)
endfunction
function FootmanId takes nothing returns integer
    return String2UnitIdBJ("footman")
endfunction
function TrainOrder takes nothing returns integer
    return String2OrderIdBJ("footman")
endfunction
function OrderIds takes nothing returns string
    return I2S(OrderId("footman")) + "," + I2S(OrderId("attack")) + "," + I2S(OrderId("nonsense"))
endfunction
function EngineOrder takes nothing returns boolean
    return OrderId("acolyteharvest") != 0
endfunction
function HolyBolt takes nothing returns boolean
    return OrderId("holybolt") != 0 and OrderId("holybolt") == OrderId("HolyBolt")
endfunction
function FootmanName takes nothing returns string
    return UnitId2StringBJ('hfoo')
endfunction
function Cliffs takes nothing returns boolean
    return GetTerrainCliffLevelBJ(Location(100.0, 0.0)) != GetTerrainCliffLevelBJ(Location(-100.0, 0.0))
endfunction
function ConstIds takes nothing returns string
    return I2S(GetHandleId(ATTACK_TYPE_HERO)) + "," + I2S(GetHandleId(DAMAGE_TYPE_NORMAL)) + "," + I2S(GetHandleId(WEAPON_TYPE_METAL_HEAVY_SLICE))
endfunction
function PlayerIdIsOwn takes nothing returns boolean
    return GetHandleId(Player(3)) != 3 and GetHandleId(Player(3)) == GetHandleId(Player(3))
endfunction
function PauseAi takes nothing returns nothing
    call PauseCompAI(Player(4), true)
endfunction
`;

const realInfo = console.info;
console.info = () => {};
const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks, blzIndexBase: 0 });
interp.callFunction('Make', []);
console.info = realInfo;
const call = (fn, args = []) => interp.callFunction(fn, args);
const last = () => calls[calls.length - 1];

console.log('--- SetHeroLevelBJ going DOWN is UnitStripHeroLevel ---');
calls.length = 0;
call('LevelDown');
check('a level-7 hero set to 3 is stripped of 4, not set', calls, [['strip', 1, 4]]);

console.log('\n--- the XP handicap ---');
check('GetPlayerHandicapXPBJ is the rate × 100, and the rate starts at 1', call('HandicapPct').n, 100);
call('HalveHandicap');
check("Test of Balance's halving lands", rates.get(1), 0.5);
check('…and reads back halved', call('HandicapPct').n, 50);

console.log('\n--- timed life, classifications ---');
call('Pause');
check('UnitPauseTimedLifeBJ(true, u)', last(), ['pauseTimedLife', 1, true]);
calls.length = 0;
check('UnitAddTypeBJ(GROUND) answers what the engine said (no)', call('Types').b, false);
check('…both reached it with the ConvertUnitType index', calls, [['class', 1, 15, false], ['class', 1, 4, true]]);

console.log('\n--- the buff filters ---');
const F = (o) => ({ positive: false, negative: false, magic: false, physical: false, timedLife: true, aura: true, autoDispel: false, ...o });
call('StripNegative');
check('bj_REMOVEBUFFS_NEGATIVE → UnitRemoveBuffs(u, false, true), read as jassbot spells it out', last(), ['removeBuffs', 1, F({ negative: true })]);
call('StripNonTLife');
check('bj_REMOVEBUFFS_NONTLIFE → the Ex form, both polarities, auras, no timed life', last(), ['removeBuffs', 1, F({ positive: true, negative: true, timedLife: false })]);
check('UnitCountBuffsExBJ returns the count', call('CountMagicNeg').n, 2);
check('…asked for negative MAGIC buffs, auras, no timed life', last(), ['countBuffs', 1, F({ negative: true, magic: true, timedLife: false })]);

console.log('\n--- trigger damage ---');
check('UnitDamagePointLoc answers the engine', call('Blast').b, true);
check('…with every argument in its slot (WEAPON_TYPE_WHOKNOWS is no sound)', last(), ['damagePoint', 1, 0.5, 250, 64, 32, 100,
  { attack: true, ranged: false, attackType: 'chaos', magic: false, universal: true, damageType: 26, weaponSound: '' }]);
call('Hit');
check("UnitDamageTarget now hands on its damage and weapon types (a DAMAGING handler reads them)", last()[4],
  { attack: true, ranged: false, attackType: 'hero', magic: false, universal: false, damageType: 8, weaponSound: 'MetalHeavySlice' });

console.log('\n--- CreateCorpse ---');
check('a footman leaves a body, and the BJ hands back a unit', call('Body').b, true);
check('a building leaves none: null', call('NoBody').b, true);

console.log('\n--- the unit table by name, and at random ---');
check('ChooseRandomCreepBJ(3) is the type the engine drew', call('Creep', [{ k: 'int', n: 3 }]).n, rawcodeToInt('nkob'));
check('…and 0 when it drew none', call('Creep', [{ k: 'int', n: 9 }]).n, 0);
check('String2UnitIdBJ("footman")', call('FootmanId').n, rawcodeToInt('hfoo'));
check("UnitId2StringBJ('hfoo')", call('FootmanName').s, 'footman');

console.log('\n--- GetHandleId on a Convert constant is its index ---');
check("ATTACK_TYPE_HERO, DAMAGE_TYPE_NORMAL, WEAPON_TYPE_METAL_HEAVY_SLICE (the Damage Engine's literals)", call('ConstIds').s, '6,4,6');
check('…while a player keeps a handle id of its own', call('PlayerIdIsOwn').b, true);

console.log('\n--- OrderId answers for ORDERS only ---');
learnOrderStrings(['holybolt', 'attack', 'smart']);
check("a unit's name, an unknown word: 0, as in the game; a generic order keeps its real id", call('OrderIds').s, '0,851983,0');
check('an ability order (in the vocabulary) gets its stable id', call('HolyBolt').b, true);
check("an ENGINE order no data file names is still an order (DotA's acolyteharvest)", call('EngineOrder').b, true);
check('…so a unit\'s name is a TRAIN order: String2OrderIdBJ falls back on UnitId', call('TrainOrder').n, rawcodeToInt('hfoo'));

console.log('\n--- the rest ---');
check('GetTerrainCliffLevelBJ reads the terrain at each point', call('Cliffs').b, true);
call('PauseAi');
check('PauseCompAI(Player(4), true)', last(), ['pauseCompAi', 4, true]);

console.log('\n--- the 24-player table (a map saved by a 1.31+ editor) ---');
{
  const { setWidePlayerTable, isNeutralSlot } = require(join(BUILD, 'data', 'enums.js'));
  const WIDE = `
function Table takes nothing returns string
    return I2S(bj_MAX_PLAYERS) + "," + I2S(bj_MAX_PLAYER_SLOTS) + "," + I2S(PLAYER_NEUTRAL_AGGRESSIVE) + "," + I2S(PLAYER_NEUTRAL_PASSIVE) + "," + I2S(bj_PLAYER_NEUTRAL_VICTIM)
endfunction
function Thirteenth takes nothing returns integer
    return GetPlayerId(Player(12))
endfunction
`;
  const narrow = buildInterpreter([common, COMPAT_PRELUDE, blizzard, WIDE], { hooks: {} });
  check('on the 1.30.4 table: 12 players, 16 slots, neutrals 12/15/13', narrow.callFunction('Table', []).s, '12,16,12,15,13');
  setWidePlayerTable(true);
  const wide = buildInterpreter([common, COMPAT_PRELUDE, blizzard, WIDE], { hooks: {} });
  check('on the wide one: 24 players, 28 slots, neutrals 24/27/25', wide.callFunction('Table', []).s, '24,28,24,27,25');
  check('Player(12) is the thirteenth PLAYER', wide.callFunction('Thirteenth', []).n, 12);
  check('…and not a neutral slot; 24–27 are', [isNeutralSlot(12), isNeutralSlot(15), isNeutralSlot(24), isNeutralSlot(27)], [false, false, true, true]);
  setWidePlayerTable(false);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll script-native wiring checks passed.');
process.exit(failures ? 1 : 0);
