// The natives common.j declares that had no implementation (issue #313), called the way a map
// calls them — through Blizzard.j's own wrappers where the game has one — against stub hooks
// that record what arrived. What the WORLD then does with each is tools/sim-native-gaps-test.cjs;
// this pins the wiring: the right argument in the right slot, the conversions a BJ makes on the
// way (the propulsion window's degrees/radians asymmetry), the events that are raised by a
// write, and the natives that answer nothing ON PURPOSE because the game's own never did.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-native-gaps-test.cjs
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
const log = (...a) => void calls.push(a);
const take = () => calls.splice(0);
let nextUnit = 1;
const created = [];
const alliances = new Map();
const tech = new Map();
const propWindow = new Map();
const hooks = {
  createUnit: (p, typeId, x, y) => (created.push([p, typeId, x, y]), nextUnit++),
  createItem: (typeId, x, y) => (log('createItem', typeId, x, y), 500),
  itemInfo: (id) => ({ id, typeId: 'rat6', charges: 0, x: 0, y: 0 }),
  unitTypeByName: (name) => (name === 'farm' ? 'hhou' : name === 'footman' ? 'hfoo' : ''),
  setUnitAnimationByIndex: (id, i) => log('animIndex', id, i),
  setUnitAnimationWithRarity: (id, name, rare) => log('animRarity', id, name, rare),
  shareUnitVision: (id, p, share) => log('shareVision', id, p, share),
  suspendDecay: (id, s) => log('suspendDecay', id, s),
  setConstructionProgress: (id, pct) => log('construct', id, pct),
  setUpgradeProgress: (id, pct) => log('upgrade', id, pct),
  setUnitIgnoreAlarm: (id, flag) => (log('ignoreAlarm', id, flag), true),
  unitIgnoresAlarm: () => true,
  setUnitRescuable: (id, p, flag) => log('rescuable', id, p, flag),
  setUnitPropWindow: (id, rad) => void propWindow.set(id, rad),
  getUnitPropWindow: (id) => propWindow.get(id),
  unitTypePropWindow: (typeId) => (typeId === 'hfoo' ? 60 : undefined),
  issueBuildOrder: (peon, typeId, x, y) => (log('build', peon, typeId, x, y), typeId === 'hhou'),
  issueUnitOrder: (id, oid, order, kind, x, y, target) => (log('order', id, order, kind, x, y, target), true),
  unitsOwnedBy: (p) => (p === 3 ? [1, 2] : []),
  setUnitOwner: (id, p, color) => log('owner', id, p, color),
  addToAllStock: (ware, kind, count, max) => log('addAll', ware, kind, count, max),
  removeFromAllStock: (ware) => log('removeAll', ware),
  setTerrainPathable: (x, y, type, flag) => log('pathable', x, y, type, flag),
  abilityArt: (id, type, index) => (id === 'AHhb' && type === 1 && index === 0 ? 'Abilities\\Spells\\Human\\HolyBolt\\HolyBoltSpecialArt.mdl' : ''),
  abilitySound: (id, type) => (id === 'AHbz' ? (type === 1 ? 'BlizzardLoop' : 'BlizzardWave') : ''),
  addSpecialEffect: (path, x, y) => (log('effect', path, x, y), 9),
  abilityFace: (id, face, field, rank) => (face === 'research' && field === 'tip' ? 'Learn Holy Light' : field === 'x' ? (face === 'activated' ? 2 : 1) : `${face}/${field}/${rank}`),
  setAbilityFace: (id, face, field, rank, value) => log('setFace', id, face, field, rank, value),
  itemText: (id, field) => `${field}#${id}`,
  setItemText: (id, field, text) => log('itemText', id, field, text),
  playerTechCount: (p, t) => tech.get(`${p}:${t}`) ?? 0,
  setPlayerTechResearched: (p, t, level) => void tech.set(`${p}:${t}`, level),
  getPlayerAlliance: (a, b, type) => alliances.get(`${a}:${b}:${type}`) ?? false,
  setPlayerAlliance: (a, b, type, value) => void alliances.set(`${a}:${b}:${type}`, value),
  setPlayerTaxRate: (src, other, res, rate) => log('tax', src, other, res, rate),
  playerScore: (p, which) => (which === 1 ? 17 : undefined),
  enableSelection: (kind, state, ui) => log('select', kind, state, ui),
  forceUiKey: (key) => log('key', key),
  cheat: (code) => log('cheat', code),
  doNotSaveReplay: () => log('noReplay'),
  setDoodadAnimation: (area, id, nearest, anim, random) => log('doodad', area, id, nearest, anim, random),
  chooseRandomNPBuilding: () => 'ntav',
  setAltMinimapIcon: (path) => log('altIcon', path),
  setUnitAltIcon: (id, flag) => log('usesAltIcon', id, flag),
  displayLoadDialog: () => log('loadDialog'),
  disableRestartMission: (flag) => log('restartOff', flag),
  setPlayerOnScoreScreen: (p, flag) => log('scoreRow', p, flag),
  setReservedHeroButtons: (n) => log('reserved', n),
};

const SRC = `
globals
    unit u = null
    unit placed = null
    item it = null
    integer fired = 0
    player who = null
    region rg = null
    trigger waiter = null
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
    set it = CreateItem('rat6', 0.0, 0.0)
endfunction
function Anims takes nothing returns nothing
    call SetUnitAnimationByIndex(u, 7)
    call SetUnitAnimationWithRarity(u, "stand", RARITY_RARE)
    call SetUnitAnimationWithRarity(u, "stand", RARITY_FREQUENT)
endfunction
function World takes nothing returns nothing
    call UnitShareVisionBJ(true, u, Player(4))
    call UnitSuspendDecayBJ(true, u)
    call UnitSetConstructionProgress(u, 50)
    call UnitSetUpgradeProgress(u, 75)
    call MakeUnitRescuableToForceBJ(u, true, GetPlayersAll())
    call UnitSetUsesAltIconBJ(true, u)
    call SetAltMinimapIcon("UI\\\\Minimap\\\\minimap-gold.blp")
endfunction
function Alarms takes nothing returns boolean
    call UnitGenerateAlarms(u, false)
    return DoesUnitGenerateAlarms(u)
endfunction
function PropDefault takes nothing returns real
    return GetUnitDefaultPropWindowBJ(u)
endfunction
function PropBefore takes nothing returns real
    return GetUnitPropWindowBJ(u)
endfunction
function PropSet takes nothing returns real
    call SetUnitPropWindowBJ(u, 90.0)
    return GetUnitPropWindowBJ(u)
endfunction
function Build takes nothing returns boolean
    return IssueBuildOrderByIdLocBJ(u, 'hhou', Location(128.0, 256.0))
endfunction
function BuildByName takes nothing returns boolean
    return IssueBuildOrder(u, "farm", 64.0, 32.0)
endfunction
function BuildUnknown takes nothing returns boolean
    return IssueBuildOrder(u, "nosuchthing", 64.0, 32.0)
endfunction
function Instant takes nothing returns boolean
    return IssueInstantPointOrder(u, "move", 300.0, 400.0, u)
endfunction
function ByName takes nothing returns boolean
    return CreateUnitByName(Player(1), "footman", 10.0, 20.0, 0.0) != null and CreateUnitByName(Player(1), "nosuchthing", 0.0, 0.0, 0.0) == null
endfunction
function HandOver takes nothing returns nothing
    call SetPlayerUnitsOwner(Player(3), 5)
endfunction
function Pools takes nothing returns boolean
    local unitpool up = CreateUnitPool()
    local itempool ip = CreateItemPool()
    call UnitPoolAddUnitType(up, 'hfoo', 1.0)
    call UnitPoolAddUnitType(up, 'hpea', 0.0)
    call ItemPoolAddItemType(ip, 'rat6', 2.0)
    call ItemPoolAddItemType(ip, 'rde1', 5.0)
    call ItemPoolRemoveItemType(ip, 'rde1')
    set placed = PlaceRandomUnit(up, Player(2), 11.0, 22.0, 90.0)
    return PlaceRandomItem(ip, 33.0, 44.0) != null and PlaceRandomUnit(CreateUnitPool(), Player(2), 0.0, 0.0, 0.0) == null
endfunction
function Stock takes nothing returns nothing
    call AddUnitToAllStock('Hpal', 1, 1)
    call AddItemToAllStock('stwp', 2, 3)
    call RemoveUnitFromAllStock('Hpal')
    call RemoveItemFromAllStock('stwp')
endfunction
function Terrain takes nothing returns nothing
    call SetTerrainPathableBJ(Location(96.0, 64.0), PATHING_TYPE_WALKABILITY, false)
endfunction
function Names takes nothing returns string
    return I2S(AbilityId("thunderbolt")) + "|" + AbilityId2String('AHtb') + "|" + GetAbilityEffect("thunderbolt", EFFECT_TYPE_TARGET, 0)
endfunction
function Art takes nothing returns string
    return GetAbilityEffectBJ('AHhb', EFFECT_TYPE_TARGET, 0) + "|" + GetAbilitySoundBJ('AHbz', SOUND_TYPE_EFFECT_LOOPED) + "|" + GetAbilityEffectBJ('AHhb', EFFECT_TYPE_CASTER, 0)
endfunction
function SpellFx takes nothing returns boolean
    return AddSpellEffectById('AHhb', EFFECT_TYPE_TARGET, 5.0, 6.0) != null and AddSpellEffectById('AHhb', EFFECT_TYPE_CASTER, 5.0, 6.0) == null and AddSpellEffect("thunderbolt", EFFECT_TYPE_TARGET, 0.0, 0.0) == null
endfunction
function Faces takes nothing returns string
    call BlzSetAbilityActivatedTooltip('AHhb', "Turn off", 1)
    call BlzSetAbilityPosX('AHhb', 3)
    return BlzGetAbilityResearchTooltip('AHhb', 1) + "|" + I2S(BlzGetAbilityPosX('AHhb')) + "|" + I2S(BlzGetAbilityActivatedPosX('AHhb'))
endfunction
function ItemWords takes nothing returns string
    call BlzSetItemTooltip(it, "Purchase")
    call BlzSetItemName(it, "nothing")
    return BlzGetItemDescription(it) + "|" + BlzGetItemIconPath(it)
endfunction
function Dec takes nothing returns integer
    call SetPlayerTechResearched(Player(0), 'Rhme', 3)
    call BlzDecPlayerTechResearched(Player(0), 'Rhme', 2)
    call BlzDecPlayerTechResearched(Player(0), 'Rhme', -5)
    return GetPlayerTechCount(Player(0), 'Rhme', true)
endfunction
function AnimName takes nothing returns string
    return BlzGetAnimName(ANIM_TYPE_STAND) + "," + BlzGetAnimName(ANIM_TYPE_SPELL)
endfunction
function OnAlliance takes nothing returns nothing
    set fired = fired + 1
    set who = GetTriggerPlayer()
endfunction
function WatchAlliance takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterPlayerAllianceChange(t, Player(1), ALLIANCE_PASSIVE)
    call TriggerAddAction(t, function OnAlliance)
endfunction
function Ally takes boolean value returns integer
    call SetPlayerAlliance(Player(1), Player(2), ALLIANCE_PASSIVE, value)
    return fired
endfunction
function AllyOther takes nothing returns integer
    call SetPlayerAlliance(Player(1), Player(2), ALLIANCE_SHARED_VISION, true)
    call SetPlayerAlliance(Player(2), Player(1), ALLIANCE_PASSIVE, true)
    return fired
endfunction
function Tax takes nothing returns integer
    call SetPlayerTaxRateBJ(25, PLAYER_STATE_RESOURCE_GOLD, Player(0), Player(1))
    return GetPlayerTaxRateBJ(PLAYER_STATE_RESOURCE_GOLD, Player(0), Player(1)) * 100 + GetPlayerTaxRateBJ(PLAYER_STATE_RESOURCE_LUMBER, Player(0), Player(1))
endfunction
function Score takes nothing returns integer
    return GetPlayerScore(Player(0), PLAYER_SCORE_UNITS_KILLED) * 100 + GetPlayerScore(Player(0), PLAYER_SCORE_TOTAL)
endfunction
function Ui takes nothing returns nothing
    call EnableSelect(false, true)
    call EnableDragSelect(false, false)
    call ForceUIKey("b7")
    call ForceUIKey("!")
    call ForceUICancel()
    call Cheat("whosyourdaddy")
    call DoNotSaveReplay()
    call SetDoodadAnimationBJ("death", 'D00A', 512.0, Location(1.0, 2.0))
endfunction
function Screen takes nothing returns nothing
    call DisplayLoadDialog()
    call DisableRestartMission(true)
    call SetPlayerOnScoreScreenBJ(false, Player(3))
    call SetReservedLocalHeroButtons(2)
    call SetReservedLocalHeroButtons(-4)
endfunction
function Region takes nothing returns string
    local string s = ""
    set rg = CreateRegion()
    call RegionAddRect(rg, Rect(0.0, 0.0, 128.0, 128.0))
    if IsPointInRegion(rg, 40.0, 40.0) then
        set s = s + "in"
    endif
    call RegionClearCell(rg, 40.0, 40.0)
    if not IsPointInRegion(rg, 40.0, 40.0) then
        set s = s + ",cleared"
    endif
    if IsPointInRegion(rg, 70.0, 40.0) then
        set s = s + ",neighbour kept"
    endif
    return s
endfunction
function Stored takes nothing returns string
    local string s = ""
    call SetCreatureDensity(MAP_DENSITY_HEAVY)
    call SetGameTypeSupported(GAME_TYPE_FFA, true)
    call SetGameTypeSupported(GAME_TYPE_ONE_ON_ONE, true)
    call SetGameTypeSupported(GAME_TYPE_ONE_ON_ONE, false)
    call ShowCustomCampaignButton(true, 2)
    call SetStartLocPrio(0, 1, 3, MAP_LOC_PRIO_HIGH)
    if GetCreatureDensity() == MAP_DENSITY_HEAVY then
        set s = s + "density"
    endif
    if IsGameTypeSupported(GAME_TYPE_FFA) and not IsGameTypeSupported(GAME_TYPE_ONE_ON_ONE) then
        set s = s + ",gametype"
    endif
    if IsCustomCampaignButtonVisibile(2) and not IsCustomCampaignButtonVisibile(1) then
        set s = s + ",button"
    endif
    if GetStartLocPrioSlot(0, 1) == 3 and GetStartLocPrio(0, 1) == MAP_LOC_PRIO_HIGH then
        set s = s + ",prio"
    endif
    return s
endfunction
function Waits takes nothing returns boolean
    set waiter = CreateTrigger()
    call TriggerWaitOnSleeps(waiter, true)
    return IsTriggerWaitOnSleeps(waiter) and not IsTriggerWaitOnSleeps(CreateTrigger())
endfunction
function NpBuilding takes nothing returns integer
    return ChooseRandomNPBuildingBJ()
endfunction
function Internals takes nothing returns integer
    call AutomationTestStart("x")
    call TriggerSyncStart()
    call PreloadGenEnd("x.txt")
    call CachePlayerHeroData(Player(0))
    return RequestExtraIntegerData(1, Player(0), "", "", false, 0, 0, 0) + GetTournamentFinishNowRule() + GetTournamentScore(Player(0))
endfunction
`;

const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks });
const run = (fn, args = []) => interp.callFunction(fn, args);
interp.callFunction('InitBlizzard', []); // GetPlayersAll, the bj_ globals
run('Make');
take();

console.log('\nthe picture');
run('Anims');
check('SetUnitAnimationByIndex / …WithRarity reach the model with the index and the rarity', take(),
  [['animIndex', 1, 7], ['animRarity', 1, 'stand', true], ['animRarity', 1, 'stand', false]]);

console.log('\nthe world, through Blizzard.j');
run('World');
{
  const got = take();
  check('UnitShareVisionBJ(share, unit, player) lands as (unit, player, share)', got.find((c) => c[0] === 'shareVision'), ['shareVision', 1, 4, true]);
  check('UnitSuspendDecayBJ', got.find((c) => c[0] === 'suspendDecay'), ['suspendDecay', 1, true]);
  check('construction and upgrade progress', got.filter((c) => c[0] === 'construct' || c[0] === 'upgrade'), [['construct', 1, 50], ['upgrade', 1, 75]]);
  check('MakeUnitRescuableToForceBJ sets it once per player in the force', got.filter((c) => c[0] === 'rescuable').length >= 12, true);
  check('the special minimap icon: the flag and the art', got.filter((c) => c[0] === 'usesAltIcon' || c[0] === 'altIcon'),
    [['usesAltIcon', 1, true], ['altIcon', 'UI\\Minimap\\minimap-gold.blp']]);
}
check('UnitGenerateAlarms(u, false) IS UnitIgnoreAlarm(u, true), and DoesUnitGenerateAlarms negates the read', [run('Alarms').b, take()], [false, [['ignoreAlarm', 1, true]]]);

console.log('\nthe propulsion window — degrees in the BJ, radians in the native, degrees for the default');
check('GetUnitDefaultPropWindowBJ is the type\'s 60, unconverted', run('PropDefault').n, 60);
check('with nothing set, GetUnitPropWindowBJ is that same 60', Math.round(run('PropBefore').n), 60);
check('SetUnitPropWindowBJ(90) reads back as 90', Math.round(run('PropSet').n), 90);
// (Blizzard.j's own bj_DEGTORAD is 3.14159/180, hence the tolerance.)
check('…and what the engine was handed is RADIANS', Math.abs(propWindow.get(1) - Math.PI / 2) < 1e-4, true);

console.log('\norders');
check('IssueBuildOrderByIdLocBJ', [run('Build').b, take()], [true, [['build', 1, 'hhou', 128, 256]]]);
check('IssueBuildOrder takes the type by its internal NAME', [run('BuildByName').b, take()], [true, [['build', 1, 'hhou', 64, 32]]]);
check('…and an unknown name orders nothing', [run('BuildUnknown').b, take()], [false, []]);
check('an instant point order is issued as the point order it is', [run('Instant').b, take()], [true, [['order', 1, 'move', 'point', 300, 400, 0]]]);
created.length = 0;
check('CreateUnitByName makes the named type, and nothing for a name no type has', [run('ByName').b, created], [true, [[1, 'hfoo', 10, 20]]]);
run('HandOver');
check('SetPlayerUnitsOwner hands every unit over (its 2nd argument is an INTEGER)', take(), [['owner', 1, 5, true], ['owner', 2, 5, true]]);

console.log('\npools and stock');
created.length = 0;
check('a pool draws by weight: a zero-weight type is never drawn, a removed one is gone, an empty pool places nothing', run('Pools').b, true);
check('PlaceRandomUnit made the one type with any weight, for the player and at the point given', created, [[2, 'hfoo', 11, 22]]);
check('PlaceRandomItem made the item that was left in the pool', take().filter((c) => c[0] === 'createItem'), [['createItem', 'rat6', 33, 44]]);
run('Stock');
check('the four "all stock" natives', take(), [['addAll', 'Hpal', 'unit', 1, 1], ['addAll', 'stwp', 'item', 2, 3], ['removeAll', 'Hpal'], ['removeAll', 'stwp']]);

console.log('\nterrain');
run('Terrain');
check('SetTerrainPathableBJ(loc, WALKABILITY, false)', take(), [['pathable', 96, 64, 1, false]]);
check('RegionClearCell takes one 32-unit cell out and leaves its neighbour', run('Region').s, 'in,cleared,neighbour kept');

console.log('\nabilities and items');
check('ability NAMES were never implemented by the game: 0, "", ""', run('Names').s, '0||');
check('GetAbilityEffectBJ / GetAbilitySoundBJ read the field by object id', run('Art').s, 'Abilities\\Spells\\Human\\HolyBolt\\HolyBoltSpecialArt.mdl|BlizzardLoop|');
check('AddSpellEffectById is AddSpecialEffect with the path looked up; no art, or a name, makes nothing', [run('SpellFx').b, take()],
  [true, [['effect', 'Abilities\\Spells\\Human\\HolyBolt\\HolyBoltSpecialArt.mdl', 5, 6]]]);
check('the three faces of a button', run('Faces').s, 'Learn Holy Light|1|2');
check('…and the setters put the VALUE second, the level last (a 1.30 map counts levels from 1)', take(), [['setFace', 'AHhb', 'activated', 'tip', 0, 'Turn off'], ['setFace', 'AHhb', 'normal', 'x', 0, 3]]);
check('one item\'s own words', run('ItemWords').s, 'description#500|icon#500');
check('BlzSetItemName does nothing, as in the game; BlzSetItemTooltip writes', take(), [['itemText', 500, 'tooltip', 'Purchase']]);
check('BlzDecPlayerTechResearched takes ranks back and never adds', run('Dec').n, 1);
check('BlzGetAnimName', run('AnimName').s, 'stand,spell');

console.log('\nevents raised by a write');
run('WatchAlliance');
check('a write that CHANGES the watched setting raises the event', run('Ally', [{ k: 'bool', b: true }]).n, 1);
check('…the same value again does not', run('Ally', [{ k: 'bool', b: true }]).n, 1);
check('…and neither does another setting, nor another player\'s', run('AllyOther').n, 1);
check('…changing it back does', run('Ally', [{ k: 'bool', b: false }]).n, 2);

console.log('\nplayers and the screen');
check('SetPlayerTaxRateBJ reorders into (source, other, resource, rate); the getter answers per resource', [run('Tax').n, take()], [2500, [['tax', 0, 1, 1, 25]]]);
check('GetPlayerScore: a column the host keeps, and 0 for one it does not', run('Score').n, 1700);
run('Ui');
check('selection, forced keys (letters and digits only, first character), cheat, replay, doodads', take(), [
  ['select', 'select', false, true], ['select', 'drag', false, false],
  ['key', 'B'], ['key', 'Escape'], ['cheat', 'whosyourdaddy'], ['noReplay'],
  ['doodad', { x: 1, y: 2, radius: 512 }, 'D00A', false, 'death', false],
]);
run('Screen');
check('the four that are the screen\'s: load dialog, Restart Mission, a score row (the BJ puts the flag first), reserved hero buttons (never negative)', take(),
  [['loadDialog'], ['restartOff', true], ['scoreRow', 3, false], ['reserved', 2], ['reserved', 0]]);
check('settings nothing else consumes are stored and read back', run('Stored').s, 'density,gametype,button,prio');
check('TriggerWaitOnSleeps is per trigger', run('Waits').b, true);
check('ChooseRandomNPBuildingBJ', run('NpBuilding').n, rawcodeToInt('ntav'));
check('the engine-internal natives answer their typed zero and raise nothing', run('Internals').n, 0);

console.log('\nwith no engine attached every one of them still runs');
{
  const bare = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks: {} });
  bare.callFunction('InitBlizzard', []);
  let threw = '';
  for (const fn of ['Make', 'Anims', 'World', 'Alarms', 'PropDefault', 'PropSet', 'Build', 'Instant', 'HandOver', 'Stock', 'Terrain', 'Names', 'Art', 'SpellFx', 'Faces', 'ItemWords', 'Dec', 'Tax', 'Score', 'Ui', 'Screen', 'Stored', 'NpBuilding', 'Internals']) {
    try { bare.callFunction(fn, []); } catch (err) { threw += `${fn}: ${err.message}; `; }
  }
  check('no throw', threw, '');
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll issue-313 native wiring checks passed.');
process.exit(failures ? 1 : 0);
