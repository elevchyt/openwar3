// Natives that were registered but did nothing, or only part of their job (issue #376):
// IsPlayerObserver, Get/SetIntegerGameState, GetSpellAbility, GetOrderTargetDestructable /
// GetSpellTargetDestructable on a TREE, and the events nothing raised — the hero-revive four,
// ACQUIRED_TARGET / TARGET_IN_RANGE and DETECTED (Interpreter.pumpUnitNews; the sim half is
// tools/sim-unit-news-test.cjs) — and the rest: trackables raising their HIT and TRACK events,
// IssueInstant*Order's item, SetItemDropID, SetUnitCreepGuard, SetUnitLookAt / ResetUnitLookAt /
// SetUnitBlendTime reaching the engine. (The handicap's half is the sim's — see
// tools/sim-script-natives-test.cjs.)
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-native-stubs-test.cjs
//
// Needs no game data: the few common.j constants it uses are declared here with common.j's own
// numbers, and the engine is a stand-in.

const { existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src', 'jass');
if (!existsSync(join(BUILD, 'headless.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'headless.js'));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

// The stand-in engine: unit 21 is a caster with 'AHtb'; tree 900 was planted from record 4242.
const snap = (id) => ({ id, typeId: 'Hmkg', owner: 1, x: 0, y: 0, facing: 0 });
const calls = [];
const hooks = {
  unitHasAbility: (id, a) => id === 21 && a === 'AHtb',
  unitDropItemPoint: (u, i, x, y) => (calls.push(['dropPoint', u, i, x, y]), true),
  unitDropItemTarget: (u, i, t) => (calls.push(['dropTarget', u, i, t]), true),
  issueUnitOrder: (u, id, order, kind, x, y) => (calls.push(['order', u, order, kind, x, y]), true),
  lockGuardPosition: (u, flag) => void calls.push(['lock', u, flag]),
  setUnitLookAt: (u, bone, t, ox, oy, oz) => void calls.push(['look', u, bone, t, ox, oy, oz]),
  resetUnitLookAt: (u) => void calls.push(['reset', u]),
  setUnitBlendTime: (u, s) => void calls.push(['blend', u, s]),
  addSpecialEffect: () => 77,
  destructableOfTree: (treeId) => (treeId === 900 ? 4242 : 0),
  destructableInfo: (id) => (id === 4242 ? { id, typeId: 'LTlt', x: 64, y: 128, life: 50, maxLife: 50 } : null),
};

const SRC = `
globals
    constant igamestate GAME_STATE_DIVINE_INTERVENTION = ConvertIGameState(0)
    constant igamestate GAME_STATE_DISCONNECTED = ConvertIGameState(1)
    constant playerunitevent EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER = ConvertPlayerUnitEvent(40)
    constant playerunitevent EVENT_PLAYER_UNIT_SPELL_EFFECT = ConvertPlayerUnitEvent(274)
    integer spellHandleOk = 0
    integer orderTreeType = 0
    integer spellTreeType = 0
    real orderTreeX = 0.0
    boolean sameHandle = false
    constant playerunitevent EVENT_PLAYER_HERO_REVIVABLE = ConvertPlayerUnitEvent(43)
    constant playerunitevent EVENT_PLAYER_HERO_REVIVE_FINISH = ConvertPlayerUnitEvent(46)
    constant playerunitevent EVENT_PLAYER_UNIT_DETECTED = ConvertPlayerUnitEvent(22)
    constant unitevent EVENT_UNIT_ACQUIRED_TARGET = ConvertUnitEvent(60)
    constant unitevent EVENT_UNIT_TARGET_IN_RANGE = ConvertUnitEvent(61)
    unit watched = null
    string heard = ""
endglobals
function Revivable takes nothing returns nothing
    set heard = heard + "revivable:" + I2S(GetUnitUserData(GetRevivableUnit())) + ";"
endfunction
function Revived takes nothing returns nothing
    set heard = heard + "revived:" + I2S(GetUnitUserData(GetRevivingUnit())) + ";"
endfunction
function Acquired takes nothing returns nothing
    set heard = heard + "acquired:" + I2S(GetUnitUserData(GetEventTargetUnit())) + ";"
endfunction
function InRange takes nothing returns nothing
    set heard = heard + "inrange:" + I2S(GetUnitUserData(GetEventTargetUnit())) + ";"
endfunction
function Detected takes nothing returns nothing
    set heard = heard + "detected:" + I2S(GetUnitUserData(GetDetectedUnit())) + " by " + I2S(GetPlayerId(GetEventDetectingPlayer())) + ";"
endfunction
globals
    integer hits = 0
    integer tracks = 0
    trackable tk = null
    boolean sameTk = false
endglobals
function OnHit takes nothing returns nothing
    set hits = hits + 1
    set sameTk = GetTriggeringTrackable() == tk
endfunction
function OnTrack takes nothing returns nothing
    set tracks = tracks + 1
endfunction
function MakeTrackables takes nothing returns nothing
    local trigger t = CreateTrigger()
    set tk = CreateTrackable("units\\human\\Footman\\Footman.mdl", 100.0, 200.0, 270.0)
    call TriggerRegisterTrackableHitEvent(t, tk)
    call TriggerAddAction(t, function OnHit)
    set t = CreateTrigger()
    call TriggerRegisterTrackableTrackEvent(t, tk)
    call TriggerAddAction(t, function OnTrack)
    call CreateTrackable("", 0.0, 0.0, 0.0)
endfunction
function TrackableId takes nothing returns integer
    return GetHandleId(tk)
endfunction
function Instant takes unit u, unit t, item it returns nothing
    call IssueInstantPointOrder(u, "dropitem", 300.0, 400.0, it)
    call IssueInstantTargetOrder(u, "dropitem", t, it)
    call IssueInstantPointOrder(u, "move", 10.0, 20.0, it)
endfunction
function Engine takes unit u, unit t, item it returns nothing
    call SetItemDropID(it, 'nkob')
    call SetUnitCreepGuard(u, true)
    call SetUnitLookAt(u, "bone_head", t, 0.0, 0.0, 90.0)
    call ResetUnitLookAt(u)
    call SetUnitBlendTime(u, 0.0)
endfunction
function Label takes unit u, integer n returns nothing
    call SetUnitUserData(u, n)
endfunction
function SetupNews takes unit w returns nothing
    local trigger t = CreateTrigger()
    set watched = w
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_HERO_REVIVABLE, null)
    call TriggerAddAction(t, function Revivable)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_HERO_REVIVE_FINISH, null)
    call TriggerAddAction(t, function Revived)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, w, EVENT_UNIT_ACQUIRED_TARGET)
    call TriggerAddAction(t, function Acquired)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, w, EVENT_UNIT_TARGET_IN_RANGE)
    call TriggerAddAction(t, function InRange)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_UNIT_DETECTED, null)
    call TriggerAddAction(t, function Detected)
endfunction
function Observer takes integer i returns boolean
    return IsPlayerObserver(Player(i))
endfunction
function GameState takes nothing returns integer
    local integer before = GetIntegerGameState(GAME_STATE_DISCONNECTED)
    call SetIntegerGameState(GAME_STATE_DIVINE_INTERVENTION, 7)
    return before * 100 + GetIntegerGameState(GAME_STATE_DIVINE_INTERVENTION) * 10 + GetIntegerGameState(GAME_STATE_DISCONNECTED)
endfunction
function OnSpell takes nothing returns nothing
    if GetSpellAbility() != null and GetSpellAbility() == BlzGetUnitAbility(GetSpellAbilityUnit(), GetSpellAbilityId()) then
        set spellHandleOk = spellHandleOk + 1
    endif
    if GetSpellTargetDestructable() != null then
        set spellTreeType = GetDestructableTypeId(GetSpellTargetDestructable())
    endif
endfunction
function OnOrder takes nothing returns nothing
    local destructable d = GetOrderTargetDestructable()
    if d != null then
        set orderTreeType = GetDestructableTypeId(d)
        set orderTreeX = GetDestructableX(d)
        set sameHandle = d == GetOrderTargetDestructable()
    endif
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_UNIT_SPELL_EFFECT, null)
    call TriggerAddAction(t, function OnSpell)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER, null)
    call TriggerAddAction(t, function OnOrder)
endfunction
`;
const interp = buildInterpreter([SRC], { hooks });
const rt = interp.rt;
const g = (n) => { const v = rt.globals.get(n); return v.k === 'bool' ? v.b : v.n; };
interp.callFunction('Setup', []);

console.log('IsPlayerObserver');
rt.watchers.add(5);
check('a watcher is an observer', interp.callFunction('Observer', [{ k: 'int', n: 5 }]).b, true);
check('a seated player is not', interp.callFunction('Observer', [{ k: 'int', n: 1 }]).b, false);

console.log('\ninteger game states');
check('DISCONNECTED starts 0; DIVINE_INTERVENTION reads back what was set', interp.callFunction('GameState', []).n, 70);

console.log('\nGetSpellAbility');
interp.pumpSpellEvents([{ caster: snap(21), abilityId: 'AHtb', phase: 'effect', target: null, x: 0, y: 0 }]);
check('is the caster\'s own instance of the spell (BlzGetUnitAbility\'s handle)', g('spellHandleOk'), 1);
interp.pumpSpellEvents([{ caster: snap(22), abilityId: 'AHtb', phase: 'effect', target: null, x: 0, y: 0 }]);
check('…and null for a caster without it', g('spellHandleOk'), 1);

console.log('\na tree as the target destructable');
const LTlt = ['L', 'T', 'l', 't'].reduce((n, ch) => n * 256 + ch.charCodeAt(0), 0);
interp.pumpOrderEvents([{ unit: snap(21), orderId: 851971, kind: 'target', x: 64, y: 128, target: null, item: null, tree: 900 }]);
check('GetOrderTargetDestructable is the record the tree was planted from', [g('orderTreeType'), g('orderTreeX')], [LTlt, 64]);
check('…the same handle each time it is asked', g('sameHandle'), true);
interp.pumpSpellEvents([{ caster: snap(21), abilityId: 'Aeat', phase: 'effect', target: null, x: 64, y: 128, tree: 900 }]);
check('GetSpellTargetDestructable likewise', g('spellTreeType'), LTlt);

console.log('\nthe hero-revive, acquire and detect events');
{
  const label = (id, n) => { const u = rt.unitForSim(snap(id)); interp.callFunction('Label', [u, { k: 'int', n }]); return u; };
  const watched = label(31, 31);
  label(32, 32);
  label(33, 33);
  interp.callFunction('SetupNews', [watched]);
  interp.pumpUnitNews([
    { kind: 'revivable', unit: snap(32), other: null, player: 1 },
    { kind: 'reviveFinish', unit: snap(32), other: null, player: 1 },
    { kind: 'acquired', unit: snap(31), other: snap(33), player: 1 },
    { kind: 'acquired', unit: snap(33), other: snap(31), player: 1 }, // not the watched unit
    { kind: 'inRange', unit: snap(31), other: snap(33), player: 1 },
    { kind: 'detected', unit: snap(33), other: null, player: 4 },
  ]);
  check('each event reaches its registration with its own responses', rt.globals.get('heard').s,
    'revivable:32;revived:32;acquired:33;inrange:33;detected:33 by 4;');
}

console.log('\ntrackables, instant orders and the picture natives');
{
  interp.callFunction('MakeTrackables', []);
  const table = [...rt.nativeTable('trackable')];
  const tk = interp.callFunction('TrackableId', []).n;
  check('a modelled trackable is listed for the engine; an invisible one is not', table, [[tk, 77]]);
  interp.fireTrackable(0, tk, false);
  interp.fireTrackable(0, tk, true);
  interp.fireTrackable(0, tk, true);
  check('TRACK and HIT reach their own registrations', [rt.globals.get('tracks').n, rt.globals.get('hits').n], [1, 2]);
  check('…with GetTriggeringTrackable the trackable', rt.globals.get('sameTk').b, true);
  const u = rt.unitForSim(snap(21));
  const t = rt.unitForSim(snap(22));
  const it = rt.itemForSim({ id: 501, typeId: 'ratc', charges: 0, x: 0, y: 0 });
  interp.callFunction('Instant', [u, t, it]);
  check('dropitem with an item: put down at the point, then handed to the target, then an ordinary order',
    calls.splice(0), [['dropPoint', 21, 501, 300, 400], ['dropTarget', 21, 501, 22], ['order', 21, 'move', 'point', 10, 20]]);
  interp.callFunction('Engine', [u, t, it]);
  check('SetItemDropID is kept on the item', rt.handles.get(it.h).dropId, 'nkob');
  check('SetUnitCreepGuard / SetUnitLookAt / ResetUnitLookAt / SetUnitBlendTime reach the engine', calls.splice(0),
    [['lock', 21, true], ['look', 21, 'bone_head', 22, 0, 0, 90], ['reset', 21], ['blend', 21, 0]]);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll native-stub checks passed.');
process.exit(failures ? 1 : 0);
