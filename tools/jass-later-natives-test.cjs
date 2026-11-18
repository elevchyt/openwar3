// The natives a 1.31 / Reforged / 3.0 map calls (src/jass/natives/later.ts), declared by our own
// prelude (src/compat/preludeLater.ts) and called here the way such a map calls them, against
// stub hooks that record what arrived.
//
// Three promises are pinned, one per kind the module states:
//   BEHAVIOUR — the native reaches the engine with the right arguments, or computes its answer;
//   STORED    — a setter's value comes back out of its getter;
//   ABSENT    — a system this engine does not have answers as an engine without it would.
// …and one about the prelude itself: every declaration in it has an implementation, so a later
// map never logs "not implemented" for a native we chose to declare.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-later-natives-test.cjs
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
const { LATER_PRELUDE } = require(join(BUILD, 'compat', 'preludeLater.js'));
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
const life = new Map([[1, 100]]);
const cooldowns = new Map();
let nextUnit = 1;
const hooks = {
  createUnit: () => nextUnit++,
  getUnitState: (id, which) => (which === 0 ? life.get(id) ?? 0 : 400),
  setUnitState: (id, which, v) => void (which === 0 && life.set(id, v)),
  pauseUnit: (id, flag) => log('pause', id, flag),
  getUnitAbilityLevel: () => 1,
  unitAbilityRankData: () => ({ cost: 75, cooldown: 20 }),
  unitAbilityCooldownLeft: (id, a) => cooldowns.get(a) ?? 0,
  startUnitAbilityCooldown: (id, a, s) => void cooldowns.set(a, s),
  endUnitAbilityCooldown: (id, a) => void cooldowns.delete(a),
  queueUnitOrder: (id, oid, order, kind, x, y, t) => (log('queue', id, order, kind, x, y, t), true),
  unitOrderCount: () => 3,
  clearUnitOrders: (id, onlyQueued) => log('clear', id, onlyQueued),
  unitAnimationDuration: (id, anim) => (anim === 'attack' ? 1.25 : anim === 2 ? 0.5 : 0),
  interruptAttack: (id) => log('interrupt', id),
  clientSize: () => ({ width: 1600, height: 900 }),
  clientActive: () => true,
  doodadCount: () => 2,
  doodadInfo: (i) => (i === 1 ? { x: 10, y: 20, z: 30, scale: 1.5, yaw: 0.5, id: 'D00A', variation: 0 } : undefined),
  setSingleDoodadAnimation: (i, anim, random) => log('doodadAnim', i, anim, random),
  findDestructable: () => 0,
  enableSelection: (kind, state, ui) => log('select', kind, state, ui),
  displayChatMessage: (p, recipient, text) => log('chat', p, recipient, text),
  isTerrainPathable: (x) => x > 0, // TRUE = NOT pathable, the classic native's polarity
  playerTypedUnitCount: (p, name) => (name === 'townhall' ? 2 : 0),
  createItem: (typeId) => (log('item', typeId), 9),
  itemInfo: (id) => ({ id, typeId: 'rat6', charges: 0, x: 0, y: 0 }),
  unitInventorySize: () => 6,
};

const SRC = `
globals
    unit u = null
    integer keys = 0
    integer lastMeta = -1
    boolean lastDown = false
    oskeytype lastKey = null
    string synced = ""
endglobals
function Make takes nothing returns nothing
    set u = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
endfunction
function Bits takes nothing returns string
    return I2S(BlzBitOr(12, 3)) + "," + I2S(BlzBitAnd(12, 10)) + "," + I2S(BlzBitXor(12, 10)) + "," + I2S(MathRound(2.5)) + "," + I2S(MathRound(-1.4))
endfunction
function Color takes nothing returns integer
    return BlzConvertColor(255, 1, 2, 3)
endfunction
function Alive takes nothing returns boolean
    return BlzUnitIsAlive(u) and not BlzUnitIsAlive(null)
endfunction
function Heal takes nothing returns real
    return BlzUnitHeal(u, u, 500.0, false, false)
endfunction
function PauseTwice takes nothing returns nothing
    call BlzPauseUnitEx(u, true)
    call BlzPauseUnitEx(u, true)
    call BlzPauseUnitEx(u, false)
    call BlzPauseUnitEx(u, false)
endfunction
function Cooldown takes nothing returns string
    local string s = ""
    call BlzSetUnitAbilityCooldownRemaining(u, 'AHhb', 5.0)
    set s = R2S(BlzGetUnitAbilityCooldownPercent(u, 'AHhb'))
    call BlzAdjustUnitAbilityCooldownPercent(u, 'AHhb', 25.0)
    set s = s + "|" + R2S(BlzGetUnitAbilityCooldownRemaining(u, 'AHhb'))
    call BlzSetUnitAbilityCooldownPercent(u, 'AHhb', 0.0)
    return s + "|" + R2S(BlzGetUnitAbilityCooldownRemaining(u, 'AHhb'))
endfunction
function Orders takes nothing returns integer
    call BlzQueuePointOrderById(u, 851986, 100.0, 200.0)
    call BlzQueueImmediateOrderById(u, 851993)
    call BlzUnitClearOrders(u, true)
    call BlzUnitForceStopOrder(u, true)
    call BlzResetUnitAttack(u, 0)
    return BlzGetUnitOrderCount(u)
endfunction
function Anim takes nothing returns real
    return BlzGetUnitAnimationDuration(u, "attack") + BlzGetUnitAnimationDurationByIndex(u, 2)
endfunction
function OnKey takes nothing returns nothing
    set keys = keys + 1
    set lastKey = BlzGetTriggerPlayerKey()
    set lastMeta = BlzGetTriggerPlayerMetaKey()
    set lastDown = BlzGetTriggerPlayerIsKeyDown()
endfunction
function WatchKeys takes nothing returns nothing
    local trigger t = CreateTrigger()
    call BlzTriggerRegisterPlayerKeyEvent(t, Player(0), OSKEY_A, METAKEY_NONE, true)
    call BlzTriggerRegisterPlayerKeyEvent(t, Player(0), OSKEY_F2, METAKEY_SHIFT + METAKEY_CTRL, false)
    call TriggerAddAction(t, function OnKey)
endfunction
function KeyState takes nothing returns string
    local string s = I2S(keys) + "," + I2S(lastMeta)
    if lastDown then
        set s = s + ",down"
    endif
    if lastKey == OSKEY_A then
        set s = s + ",A"
    endif
    if lastKey == OSKEY_F2 then
        set s = s + ",F2"
    endif
    return s
endfunction
function OnSync takes nothing returns nothing
    set synced = synced + BlzGetTriggerSyncPrefix() + "=" + BlzGetTriggerSyncData() + ";"
endfunction
function Sync takes nothing returns string
    local trigger t = CreateTrigger()
    call BlzTriggerRegisterPlayerSyncEvent(t, Player(0), "cam", false)
    call TriggerAddAction(t, function OnSync)
    call BlzSendSyncData("cam", "1200")
    call BlzSendSyncData("other", "x")
    return synced
endfunction
function Window takes nothing returns string
    return I2S(BlzGetLocalClientWidth()) + "x" + I2S(BlzGetLocalClientHeight()) + " " + R2S(BlzPixelToFrameX(800)) + " " + R2S(BlzPixelToFrameY(450)) + " " + I2S(BlzFrameToPixelX(0.0)) + " " + I2S(BlzFrameToPixelY(0.6))
endfunction
function Pathable takes nothing returns boolean
    return BlzIsTerrainPathableEx(-5.0, 0.0, PATHING_TYPE_WALKABILITY) and not BlzIsTerrainPathableEx(5.0, 0.0, PATHING_TYPE_WALKABILITY)
endfunction
function Doodads takes nothing returns string
    call BlzSetSingleDoodadAnimation(1, "death", false)
    return I2S(BlzGetNumDoodads()) + " " + R2S(BlzGetDoodadX(1)) + " " + R2S(BlzGetDoodadScaleY(1)) + " " + I2S(BlzGetDoodadId(1) - 'D00A') + " " + R2S(BlzGetDoodadX(7))
endfunction
function Dest takes nothing returns boolean
    local destructable a = BlzCreateDestructableZWithSkinPitchRollColor('LTlt', 1.0, 2.0, 3.0, 90.0, 0.1, 0.2, 1.5, 4, 'LTlt', PLAYER_COLOR_RED)
    local destructable b = BlzCreateDeadDestructableWithColor('LTlt', 1.0, 2.0, 90.0, 1.5, 4, PLAYER_COLOR_RED)
    return a != null and b != null and GetDestructableTypeId(a) == 'LTlt'
endfunction
function Misc takes nothing returns string
    call BlzEnableSelections(false, false)
    call BlzDisplayChatMessage(Player(2), 1, "hello")
    return I2S(BlzGetPlayerTownHallCount(Player(0))) + "," + I2S(BlzGetUnitSkin(u) - 'hfoo') + "," + I2S(GetItemTypeId(BlzCreateItemWithSkin('rat6', 0.0, 0.0, 'rat6')) - 'rat6')
endfunction
function Stored takes nothing returns string
    local string s = ""
    local camerasetup cs = CreateCameraSetup()
    call BlzSetHUDScale(120)
    call BlzCameraSetupSetLabel(cs, "intro")
    call SetPlayerHandicapDamage(Player(1), 0.5)
    call DisallowHeroGlowOnUnit(u)
    call BlzEnableTargetIndicator(false)
    if BlzGetHUDScale() == 120.0 and BlzCameraSetupGetLabel(cs) == "intro" then
        set s = s + "hud+label"
    endif
    if GetPlayerHandicapDamage(Player(1)) == 0.5 and GetPlayerHandicapReviveTime(Player(1)) == 1.0 then
        set s = s + ",handicap"
    endif
    if not HeroGlowIsAllowedOnUnit(u) and not BlzIsTargetIndicatorEnabled() and not BlzIsSelectionEnabled() then
        set s = s + ",flags"
    endif
    return s
endfunction
function Handles takes nothing returns boolean
    local minimapicon m = CreateMinimapIcon(0.0, 0.0, 255, 255, 255, "x.mdl", FOG_OF_WAR_VISIBLE)
    local commandbuttoneffect e = CreateCommandButtonEffect('AHhb', "holybolt")
    call SetMinimapIconVisible(m, false)
    call DestroyMinimapIcon(m)
    call DestroyCommandButtonEffect(e)
    return m != null and e != null
endfunction
function Absent takes nothing returns string
    local string s = ""
    local item it = CreateItem('rat6', 0.0, 0.0)
    if not IsItemEquipped(it) and not BlzIsItemInBag(it) and not UnitEquipItem(u, it) and UnitItemInBagSlot(u, 0) == null then
        set s = s + "none equipped"
    endif
    if UnitHasLoadoutSlotEmpty(u, EQUIPMENT_LOADOUT_SLOT_HEAD) and UnitExtendedInventorySize(u) == 6 and GetItemEquipmentType(it) == EQUIPMENT_TYPE_NONE then
        set s = s + ",empty loadout"
    endif
    if not BlzTriggerIsRunning(CreateTrigger()) and not BlzIsKeyPressed(OSKEY_A) and not BlzSetItemIntegerField(it, null, 1) then
        set s = s + ",no answer"
    endif
    call BlzSetHDWaterColor(1, 2, 3)
    call BlzSetTerrainFogStyle(FOG_STYLE_EXP2)
    call BlzShowUnitTeamGlow(u, false)
    return s
endfunction
`;

const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks });
const run = (fn, args = []) => interp.callFunction(fn, args);
run('Make');
take();

console.log('the prelude');
{
  const declared = [...LATER_PRELUDE.matchAll(/^\s*(?:constant\s+)?native\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  const missing = declared.filter((n) => !interp.rt.natives.has(n));
  check(`all ${declared.length} natives it declares are implemented`, missing, []);
  check('…and none of them is one 1.30.4 already declares', declared.filter((n) => new RegExp(`native\\s+${n}\\b`).test(common)), []);
  check('an oskeytype is its virtual-key code, and compares', [interp.rt.enumIndex(interp.rt.globals.get('OSKEY_A')), interp.rt.enumIndex(interp.rt.globals.get('OSKEY_F2'))], [65, 113]);
  check('the Forsaken race is not declared', interp.rt.globals.has('RACE_PREF_FORSAKEN'), false);
}

console.log('\nbehaviour');
check('bit arithmetic and rounding', run('Bits').s, '15,8,6,3,-1');
check('BlzConvertColor packs ARGB', run('Color').n, (255 << 24) | (1 << 16) | (2 << 8) | 3);
check('BlzUnitIsAlive', run('Alive').b, true);
check('BlzUnitHeal answers what was actually restored (100 → the 400 cap)', [run('Heal').n, life.get(1)], [300, 400]);
run('PauseTwice');
check('BlzPauseUnitEx is counted: two pauses want two unpauses', take(), [['pause', 1, true], ['pause', 1, true], ['pause', 1, true], ['pause', 1, false]]);
check('the cooldown, as seconds and as a share of the rank\'s 20', run('Cooldown').s, '25.000|10.000|0.000');
check('queued orders, clear, force-stop, reset attack', [run('Orders').n, take()], [3, [
  ['queue', 1, 'move', 'point', 100, 200, 0], ['queue', 1, 'holdposition', 'immediate', 0, 0, 0],
  ['clear', 1, true], ['clear', 1, false], ['interrupt', 1],
]]);
check('clip lengths by name and by index', run('Anim').n, 1.75);

console.log('\nthe keyboard');
run('WatchKeys');
check('the interpreter knows a key event is registered', interp.watchesKeys(), true);
interp.firePlayerKey(0, 65, 0, true);
check('A down, no modifier', run('KeyState').s, '1,0,down,A');
interp.firePlayerKey(0, 65, 1, true); // Shift+A — the meta set must match exactly
interp.firePlayerKey(0, 65, 0, false); // A up — registered for down
interp.firePlayerKey(1, 65, 0, true); // another player
check('Shift+A, A up and another player\'s A do not fire it', run('KeyState').s, '1,0,down,A');
interp.firePlayerKey(0, 113, 3, false);
check('Shift+Ctrl+F2 coming UP fires the second registration', run('KeyState').s, '2,3,F2');
check('sync data is delivered to the sender\'s own triggers, by prefix', run('Sync').s, 'cam=1200;');

console.log('\nthe window');
check('client size, and pixels ↔ the 0.8×0.6 frame space of a 4:3 box centred in 16:9', run('Window').s, '1600x900 0.400 0.300 200 0');
check('BlzIsTerrainPathableEx reads the way its name does', run('Pathable').b, true);
check('doodads by index', [run('Doodads').s, take()], ['2 10.000 1.500 0 0.000', [['doodadAnim', 1, 'death', false]]]);
check('the 28 destructable creators are the classic one with the extras dropped', run('Dest').b, true);
check('town halls, a unit\'s "skin" is its type, an item with a skin is an item', run('Misc').s, '2,0,0');
check('…and the two that reach the screen', take().filter((c) => c[0] === 'select' || c[0] === 'chat'), [['select', 'select', false, false], ['chat', 2, 1, 'hello']]);

console.log('\nstored, and absent');
check('a setter\'s value comes back out of its getter', run('Stored').s, 'hud+label,handicap,flags');
check('minimap icons and button effects are real handles', run('Handles').b, true);
check('the equipment system answers as an engine without one', run('Absent').s, 'none equipped,empty loadout,no answer');

console.log('\nwith no engine attached every one of them still runs');
{
  const bare = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks: {} });
  let threw = '';
  for (const fn of ['Make', 'Bits', 'Alive', 'Heal', 'PauseTwice', 'Cooldown', 'Orders', 'Anim', 'WatchKeys', 'Sync', 'Window', 'Pathable', 'Doodads', 'Dest', 'Misc', 'Stored', 'Handles', 'Absent']) {
    try { bare.callFunction(fn, []); } catch (err) { threw += `${fn}: ${err.message}; `; }
  }
  check('no throw', threw, '');
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll later-native checks passed.');
process.exit(failures ? 1 : 0);
