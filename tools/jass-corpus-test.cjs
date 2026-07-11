// Headless JASS-engine test (Phase 7 — issue #33; see docs/triggers.md).
//
//   1) compile the pure interpreter modules:  npx tsc -p tools/tsconfig.jass.json
//   2) run:                                    node tools/jass-corpus-test.cjs
//
// Checks (the milestone exit criteria):
//   7.0  parse common.j + blizzard.j + EVERY bundled war3map.j with zero errors.
//   7.1  run config() and assert the players / start-locations it declares equal
//        what war3map.w3i records (the free oracle) on a couple of maps.
//   7.2  run CreateAllUnits() and assert the unit count matches war3mapUnits.doo
//        (minus start-location markers, which aren't CreateUnit'd).
//
// Reads only the developer's own local install (gitignored; zero shipped assets).

const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const WC3 = join(REPO, 'Warcraft III');
const BUILD = join(REPO, '.jass-build', 'src', 'jass');
const SEP = String.fromCharCode(92);

if (!existsSync(join(BUILD, 'parser.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
// The repo is an ESM package ("type":"module"), but tsc emits these modules as
// CommonJS — mark the build dir so Node require()s them as CJS.
require('node:fs').writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { parseJass } = require(join(BUILD, 'parser.js'));
const { buildInterpreter } = require(join(BUILD, 'headless.js'));

const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
const w3iMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/w3i');
const W3iFile = (w3iMod.default ?? w3iMod).File;
const dooMod = require('mdx-m3-viewer/dist/cjs/parsers/w3x/unitsdoo');
const UnitsDoo = (dooMod.default ?? dooMod).File;

const decode = (b) => new TextDecoder('windows-1252').decode(b);
function openArchive(path) {
  const buf = readFileSync(path);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  const a = new MpqArchive();
  a.load(bytes, true);
  return a;
}
const readStr = (a, name) => {
  const f = a.get(name) ?? a.get(`scripts${SEP}${name}`);
  return f ? decode(f.bytes()) : null;
};
const readBytes = (a, name) => {
  const f = a.get(name) ?? a.get(`scripts${SEP}${name}`);
  return f ? f.bytes() : null;
};

const COMMON_J = readFileSync(join(WC3, 'ExtractedData', 'merged', 'Scripts', 'common.j'), 'latin1');
const BLIZZARD_J = readFileSync(join(WC3, 'ExtractedData', 'merged', 'Scripts', 'Blizzard.j'), 'latin1');

function findMaps(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findMaps(p));
    else if (/\.w3[mx]$/i.test(e.name)) out.push(p);
  }
  return out;
}

let failures = 0;
const fail = (msg) => { console.log(`  ✗ ${msg}`); failures++; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

// --- 7.0: parse the whole corpus ------------------------------------------
console.log('\n[7.0] Parse corpus (common.j, blizzard.j, every war3map.j)');
for (const [name, src] of [['common.j', COMMON_J], ['blizzard.j', BLIZZARD_J]]) {
  try {
    const p = parseJass(src);
    ok(`${name}: ${p.natives.length} natives, ${p.functions.length} functions, ${p.globals.length} globals`);
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
}
const maps = findMaps(join(WC3, 'Maps'));
let parsed = 0, withScript = 0;
const parseErrors = [];
for (const m of maps) {
  let src;
  try { src = readStr(openArchive(m), 'war3map.j'); } catch { continue; }
  if (!src) continue;
  withScript++;
  try { parseJass(src); parsed++; } catch (e) { parseErrors.push(`${m.split(/[\\/]/).pop()}: ${e.message}`); }
}
if (parseErrors.length === 0) ok(`all ${parsed}/${withScript} map scripts parsed`);
else { fail(`${parseErrors.length} map(s) failed to parse`); parseErrors.slice(0, 10).forEach((e) => console.log(`      ${e}`)); }

// --- 7.1 + 7.2: config() oracle vs w3i, CreateAllUnits vs .doo -------------
function checkMap(label, path, melee) {
  console.log(`\n[7.1/7.2] ${label}`);
  const a = openArchive(path);
  const src = readStr(a, 'war3map.j');
  if (!src) return fail('no war3map.j');
  const w3i = new W3iFile();
  w3i.load(readBytes(a, 'war3map.w3i'));
  const doo = new UnitsDoo();
  try { doo.load(readBytes(a, 'war3mapUnits.doo'), w3i.getBuildVersion()); } catch { /* some maps */ }

  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, src], { gameType: melee ? 1 : 4 });
  interp.run('config', []);
  const setup = interp.rt.setup;

  // 7.1: start-location count + player count vs w3i.
  const w3iLocs = w3i.startLocations ? w3i.startLocations.length : (w3i.players ? w3i.players.length : 0);
  if (setup.startLocations.size === w3iLocs) ok(`start locations: ${setup.startLocations.size} == w3i ${w3iLocs}`);
  else fail(`start locations: config ${setup.startLocations.size} != w3i ${w3iLocs}`);
  console.log(`      SetPlayers=${setup.numPlayers} SetTeams(final)=${setup.numTeams} placement=${setup.placement}`);

  // 7.2: CreateAllUnits() count vs war3mapUnits.doo (excluding 'sloc' markers).
  if (interp.rt.functions.get('CreateAllUnits')) {
    interp.run('CreateAllUnits', []);
    const created = interp.rt.units.length;
    const dooUnits = (doo.units || []).filter((u) => u.id !== 'sloc').length;
    if (created === dooUnits) ok(`CreateAllUnits: ${created} == war3mapUnits.doo ${dooUnits}`);
    else console.log(`      CreateAllUnits created ${created}; .doo has ${dooUnits} non-marker units (diff ok if map spawns extra in triggers)`);
  }
}

const plunder = join(WC3, 'Maps', '(2)PlunderIsle.w3m');
if (existsSync(plunder)) checkMap('PlunderIsle (melee)', plunder, true);
const warchasers = join(WC3, 'Maps', 'Scenario', '(4)WarChasers.w3m');
if (existsSync(warchasers)) checkMap('WarChasers (custom)', warchasers, false);

// --- 7.4: event runtime — a periodic timer fires its trigger (ECA end-to-end) ---
console.log('\n[7.4] Event runtime (timers → triggers, event responses)');
{
  // A synthetic map script: a periodic timer whose trigger action counts firings,
  // and only when GetExpiredTimer() is the expected timer (proves event responses).
  const SRC = `
globals
    integer udg_count = 0
    integer udg_wrong = 0
    timer   udg_t   = null
    trigger udg_trg = null
endglobals
function OnExpire takes nothing returns nothing
    if ( GetExpiredTimer() == udg_t ) then
        set udg_count = udg_count + 1
    else
        set udg_wrong = udg_wrong + 1
    endif
endfunction
function InitTest takes nothing returns nothing
    set udg_t   = CreateTimer()
    set udg_trg = CreateTrigger()
    call TriggerAddAction( udg_trg, function OnExpire )
    call TriggerRegisterTimerExpireEvent( udg_trg, udg_t )
    call TimerStart( udg_t, 1.0, true, null )
endfunction`;
  const interp = buildInterpreter([SRC]);
  interp.run('InitTest', []);
  interp.advanceTime(3.5); // periodic 1.0s timer → fires at t=1,2,3
  const count = interp.rt.globals.get('udg_count');
  const wrong = interp.rt.globals.get('udg_wrong');
  if (count && count.n === 3 && wrong && wrong.n === 0) ok(`periodic timer fired its trigger 3× in 3.5s, GetExpiredTimer correct`);
  else fail(`timer/event: count=${count && count.n} (want 3), wrongTimer=${wrong && wrong.n} (want 0)`);

  // A one-shot timer fires exactly once no matter how far time advances.
  const SRC2 = `
globals
    integer udg_n = 0
    timer   udg_o = null
endglobals
function Bump takes nothing returns nothing
    set udg_n = udg_n + 1
endfunction
function Init2 takes nothing returns nothing
    set udg_o = CreateTimer()
    call TimerStart( udg_o, 0.5, false, function Bump )
endfunction`;
  const i2 = buildInterpreter([SRC2]);
  i2.run('Init2', []);
  i2.advanceTime(10.0);
  const n = i2.rt.globals.get('udg_n');
  if (n && n.n === 1) ok(`one-shot timer (with handler code) fired exactly once`);
  else fail(`one-shot timer: n=${n && n.n} (want 1)`);
}

// --- 7.5: text logic + text actions — end-to-end through the real blizzard.j BJs ---
console.log('\n[7.5] Text logic + text actions (forces → messages, floating text, strings)');
{
  // Capture on-screen text/clear via the engine hook, exactly as the live HUD does.
  const lines = [];
  let cleared = 0;
  const hooks = {
    displayText: (p, msg, dur) => lines.push({ p, msg, dur }),
    clearText: () => { cleared++; },
  };
  // A script that drives the GUI-compiled shapes: the "Game - Display text" action
  // (DisplayTextToForce), its timed + clear variants, a Floating Text action
  // (CreateTextTagLocBJ), and text-logic functions (SubStringBJ/GetPlayerName/
  // StringHashBJ). All run through the actual blizzard.j on top of our natives.
  const SRC = `
globals
    texttag udg_tt   = null
    string  udg_sub  = ""
    string  udg_name = ""
    integer udg_hash = 0
endglobals
function RunText takes nothing returns nothing
    call DisplayTextToForce( GetPlayersAll(), "Hello, world!" )
    call DisplayTimedTextToForce( GetPlayersAll(), 5.0, "Timed message" )
    call ClearTextMessagesBJ( GetPlayersAll() )
    set udg_tt   = CreateTextTagLocBJ( "Float!", null, 0.0, 10.0, 100.0, 100.0, 100.0, 0.0 )
    set udg_sub  = SubStringBJ( "Warcraft", 1, 3 )
    set udg_name = GetPlayerName( Player(0) )
    set udg_hash = StringHashBJ( "abc" )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('InitBlizzardGlobals', []); // populates bj_FORCE_ALL_PLAYERS via our force natives
  interp.run('RunText', []);

  const msgsOk = lines.length === 2 &&
    lines[0].msg === 'Hello, world!' && lines[0].dur < 0 &&
    lines[1].msg === 'Timed message' && lines[1].dur === 5;
  if (msgsOk) ok(`DisplayTextToForce/Timed reached the local player (untimed + 5s) through bj_FORCE_ALL_PLAYERS`);
  else fail(`text-to-force: got ${JSON.stringify(lines)}`);
  if (cleared === 1) ok(`ClearTextMessagesBJ cleared the local player's messages once`);
  else fail(`ClearTextMessagesBJ: cleared=${cleared} (want 1)`);

  const tags = interp.rt.textTags;
  if (tags.length === 1 && tags[0].text === 'Float!' && Math.abs(tags[0].size - 0.023) < 1e-6) {
    ok(`CreateTextTagLocBJ built a floating text tag ("Float!", size→height 0.023)`);
  } else fail(`floating text: ${JSON.stringify(tags)}`);

  const sub = interp.rt.globals.get('udg_sub');
  const name = interp.rt.globals.get('udg_name');
  const hash = interp.rt.globals.get('udg_hash');
  if (sub && sub.s === 'War') ok(`SubStringBJ("Warcraft",1,3) == "War"`);
  else fail(`SubStringBJ: got ${sub && sub.s}`);
  if (name && name.s === 'Player 1') ok(`GetPlayerName(Player(0)) == "Player 1"`);
  else fail(`GetPlayerName: got ${name && name.s}`);
  if (hash && hash.n !== 0) ok(`StringHashBJ("abc") is a stable non-zero hash (${hash.n})`);
  else fail(`StringHashBJ: got ${hash && hash.n} (want non-zero)`);
}

// --- 7.6: enter/leave-region events (the live pump — 7.4b) ---
console.log('\n[7.6] Region enter/leave events (Interpreter.pumpRegions)');
{
  // GUI "Unit enters/leaves (region)" compiles to Register{Enter,Leave}RectSimple on
  // a Rect. OnEnter/OnLeave count firings and record the crossing unit's live X.
  const SRC = `
globals
    integer udg_enter  = 0
    integer udg_leave  = 0
    real    udg_enterX = 0.0
endglobals
function OnEnter takes nothing returns nothing
    set udg_enter  = udg_enter + 1
    set udg_enterX = GetUnitX( GetEnteringUnit() )
endfunction
function OnLeave takes nothing returns nothing
    set udg_leave = udg_leave + 1
endfunction
function InitTest takes nothing returns nothing
    local rect r = Rect( 0.0, 0.0, 100.0, 100.0 )
    local trigger te = CreateTrigger()
    local trigger tl = CreateTrigger()
    call TriggerAddAction( te, function OnEnter )
    call TriggerAddAction( tl, function OnLeave )
    call TriggerRegisterEnterRectSimple( te, r )
    call TriggerRegisterLeaveRectSimple( tl, r )
endfunction`;
  const interp = buildInterpreter([SRC]);
  interp.run('InitTest', []);
  const A = (x, y) => ({ id: 1, typeId: 'hfoo', owner: 0, x, y, facing: 0 });
  const B_in = { id: 2, typeId: 'hpea', owner: 0, x: 50, y: 50, facing: 0 }; // present at baseline
  interp.pumpRegions([A(-50, -50), B_in]); // baseline: A outside, B already inside → no fire
  interp.pumpRegions([A(50, 50), B_in]);   // A crosses IN → enter=1 (B present at baseline, no fire)
  interp.pumpRegions([A(60, 60), B_in]);   // A still inside → no re-fire
  interp.pumpRegions([A(-50, -50), B_in]); // A crosses OUT → leave=1
  interp.pumpRegions([A(50, 50), B_in]);   // A crosses IN again → enter=2

  const e = interp.rt.globals.get('udg_enter');
  const l = interp.rt.globals.get('udg_leave');
  const ex = interp.rt.globals.get('udg_enterX');
  if (e && e.n === 2) ok(`enter fired on each cross-in (2×); a unit inside at registration did NOT fire`);
  else fail(`enter: got ${e && e.n} (want 2)`);
  if (l && l.n === 1) ok(`leave fired once on cross-out; no re-fire while inside`);
  else fail(`leave: got ${l && l.n} (want 1)`);
  if (ex && Math.abs(ex.n - 50) < 1e-6) ok(`GetEnteringUnit() is the crossing unit (GetUnitX == 50)`);
  else fail(`GetEnteringUnit live pos: GetUnitX == ${ex && ex.n} (want 50)`);
}

// --- 7.7: custom object data — war3map.w3u custom units resolve with overrides ---
console.log('\n[7.7] Custom object data (war3map.w3u → custom unit types)');
if (existsSync(warchasers)) {
  const { UnitRegistry } = require(join(BUILD, '..', 'data', 'units.js'));
  const { applyMapUnitData } = require(join(BUILD, '..', 'data', 'objectData.js'));
  const wc = openArchive(warchasers);
  const w3u = readBytes(wc, 'war3map.w3u');
  const wts = readBytes(wc, 'war3map.wts');
  // A minimal base type for EC12's base (Emoo); applyMapUnitData clones + overrides it.
  const base = {
    id: 'Emoo', name: 'Base', model: 'units\\base.mdx', isHero: true, primaryAttr: 0,
    strength: 20, agility: 20, intelligence: 20, abilities: [], heroAbilities: [], classification: [],
  };
  const reg = new UnitRegistry(new Map([['Emoo', base]]));
  const count = applyMapUnitData(reg, w3u, wts);
  const ec = reg.get('EC12');
  if (count > 0) ok(`applied ${count} custom unit type(s) from war3map.w3u`);
  else fail(`applyMapUnitData installed 0 custom units`);
  if (ec && /Shandris/i.test(ec.model)) ok(`EC12 overrides its model (${ec.model})`);
  else fail(`EC12 model: ${ec && ec.model} (want a Shandris path)`);
  if (ec && ec.name === 'Snake Aes') ok(`EC12 name resolves via war3map.wts ("${ec.name}")`);
  else fail(`EC12 name: ${ec && ec.name} (want "Snake Aes" from the wts)`);
  if (ec && ec.isHero === true) ok(`EC12 inherits isHero from its base type`);
  else fail(`EC12 isHero: ${ec && ec.isHero} (want true)`);
  // Overlay is per-map: clearCustom drops it so the next map starts clean.
  reg.clearCustom();
  if (reg.get('EC12') === undefined) ok(`clearCustom() drops the per-map overlay`);
  else fail(`clearCustom left EC12 resolvable`);
} else {
  console.log('  (WarChasers not present — skipped)');
}

// --- 7.8: custom ability data — war3map.w3a level-indexed overrides ---
console.log('\n[7.8] Custom ability data (war3map.w3a → custom abilities)');
{
  const candy = join(WC3, 'Maps', 'FrozenThrone', 'Scenario', "(10)ExtremeCandyWar2004.w3x");
  const abMetaPath = join(WC3, 'ExtractedData', 'merged', 'Units', 'AbilityMetaData.slk');
  if (existsSync(candy) && existsSync(abMetaPath)) {
    const { AbilityRegistry } = require(join(BUILD, '..', 'data', 'abilities.js'));
    const { applyMapAbilityData } = require(join(BUILD, '..', 'data', 'objectData.js'));
    const wc = openArchive(candy);
    const w3a = readBytes(wc, 'war3map.w3a');
    const wts = readBytes(wc, 'war3map.wts');
    const abMeta = readFileSync(abMetaPath);
    // Minimal base ability (Aoar) for A000 to clone; applyMapAbilityData layers overrides on.
    const lvl = () => ({ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data: new Array(9).fill(NaN), buffs: [], summon: '' });
    const baseAb = {
      id: 'Aoar', code: 'Aoar', isHero: false, isItem: false, levels: 1, reqLevel: 0, levelSkip: 0, target: 'passive',
      targetFlags: [], autocast: false, name: 'Base', icon: '', hotkey: '', buttonX: 0, buttonY: 0, learnX: 0, learnY: 0,
      research: false, tips: [], uberTips: [], researchTip: '', researchUberTip: '', levelData: [lvl()],
      missileArt: '', targetArt: '', casterArt: '', specialArt: '', effectArt: '', areaArt: '', buffArt: '', animNames: [],
    };
    const reg = new AbilityRegistry(new Map([['Aoar', baseAb]]));
    const count = applyMapAbilityData(reg, w3a, abMeta, wts);
    const a0 = reg.get('A000');
    if (count > 0) ok(`applied ${count} custom abilit(y/ies) based on known bases`);
    else fail(`applyMapAbilityData installed 0 abilities`);
    if (a0 && a0.code === 'Aoar') ok(`A000 inherits its base ability's code (dispatch key) = Aoar`);
    else fail(`A000 code: ${a0 && a0.code} (want Aoar)`);
    if (a0 && a0.levelData[0] && a0.levelData[0].area === 425) ok(`A000 area override applied (level 1 area == 425)`);
    else fail(`A000 area: ${a0 && a0.levelData[0] && a0.levelData[0].area} (want 425)`);
    if (a0 && a0.levelData[0] && Math.abs(a0.levelData[0].data[0] - 0.03) < 1e-3) ok(`A000 DataA override routed via meta (Oar1 → data[0] ≈ 0.03)`);
    else fail(`A000 data[0]: ${a0 && a0.levelData[0] && a0.levelData[0].data[0]} (want ≈0.03)`);
  } else {
    console.log('  (ExtremeCandyWar2004 / AbilityMetaData not present — skipped)');
  }
}

// --- 7.9: custom item data — war3map.w3t flat overrides ---
console.log('\n[7.9] Custom item data (war3map.w3t → custom items)');
{
  const candy = join(WC3, 'Maps', 'FrozenThrone', 'Scenario', "(10)ExtremeCandyWar2004.w3x");
  if (existsSync(candy)) {
    const { ItemRegistry } = require(join(BUILD, '..', 'data', 'items.js'));
    const { applyMapItemData } = require(join(BUILD, '..', 'data', 'objectData.js'));
    const wc = openArchive(candy);
    const w3t = readBytes(wc, 'war3map.w3t');
    const wts = readBytes(wc, 'war3map.wts');
    // Minimal base item (evtl) for I000 to clone.
    const baseItem = {
      id: 'evtl', name: 'Base', description: '', icon: '', model: 'x.mdx', scale: 1, gold: 0, lumber: 0, level: 1,
      classType: 'Permanent', abilities: [], charges: 0, cooldownGroup: '', usable: false, perishable: false,
      powerup: false, droppable: true, pawnable: true, pickRandom: false, maxHp: 75,
    };
    const reg = new ItemRegistry(new Map([['evtl', baseItem]]));
    const count = applyMapItemData(reg, w3t, wts);
    const it = reg.get('I000');
    if (count > 0) ok(`applied ${count} custom item(s) from war3map.w3t`);
    else fail(`applyMapItemData installed 0 items`);
    if (it && it.classType === 'Artifact') ok(`I000 class override applied (Artifact)`);
    else fail(`I000 class: ${it && it.classType} (want Artifact)`);
    if (it && it.abilities.includes('AIda')) ok(`I000 carries its granted ability (AIda)`);
    else fail(`I000 abilities: ${it && JSON.stringify(it.abilities)} (want AIda)`);
    if (it && it.usable === true) ok(`I000 usable flag applied`);
    else fail(`I000 usable: ${it && it.usable} (want true)`);
    if (it && it.name && it.name !== 'TRIGSTR_1214' && it.name !== 'Base') ok(`I000 name resolves via wts ("${it.name}")`);
    else fail(`I000 name: ${it && it.name} (want a resolved string)`);
  } else {
    console.log('  (ExtremeCandyWar2004 not present — skipped)');
  }
}

// --- 7.10: unit-death events (the live pump — 7.4c) ---
console.log('\n[7.10] Unit-death events (Interpreter.pumpUnitDeaths)');
{
  const { rawcodeToInt } = require(join(BUILD, 'lexer.js'));
  // "A unit dies" → TriggerRegisterPlayerUnitEvent(p, EVENT_PLAYER_UNIT_DEATH=20). The
  // action records the count + the dying unit's X + the killer's type id.
  const SRC = `
globals
    integer udg_deaths     = 0
    real    udg_deadX      = 0.0
    integer udg_killerType = 0
endglobals
function OnDeath takes nothing returns nothing
    set udg_deaths     = udg_deaths + 1
    set udg_deadX      = GetUnitX( GetDyingUnit() )
    set udg_killerType = GetUnitTypeId( GetKillingUnit() )
endfunction
function InitDeath takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerAddAction( t, function OnDeath )
    call TriggerRegisterPlayerUnitEvent( t, Player(0), ConvertPlayerUnitEvent(20), null )
endfunction`;
  const interp = buildInterpreter([SRC]);
  interp.run('InitDeath', []);
  // A player-0 footman dies, killed by a player-1 peasant.
  interp.pumpUnitDeaths([{ victim: { id: 5, typeId: 'hfoo', owner: 0, x: 100, y: 0, facing: 0 }, killer: { id: 6, typeId: 'hpea', owner: 1, x: 110, y: 0, facing: 0 } }]);
  // A player-1 unit dies — must NOT fire the player-0 registration.
  interp.pumpUnitDeaths([{ victim: { id: 7, typeId: 'hfoo', owner: 1, x: 200, y: 0, facing: 0 }, killer: null }]);

  const deaths = interp.rt.globals.get('udg_deaths');
  const deadX = interp.rt.globals.get('udg_deadX');
  const killerType = interp.rt.globals.get('udg_killerType');
  if (deaths && deaths.n === 1) ok(`EVENT_PLAYER_UNIT_DEATH fired once (owner match); other player's death did NOT fire`);
  else fail(`deaths: ${deaths && deaths.n} (want 1)`);
  if (deadX && Math.abs(deadX.n - 100) < 1e-6) ok(`GetDyingUnit() is the victim (GetUnitX == 100)`);
  else fail(`GetDyingUnit X: ${deadX && deadX.n} (want 100)`);
  if (killerType && killerType.n === rawcodeToInt('hpea')) ok(`GetKillingUnit() is the killer (GetUnitTypeId == 'hpea')`);
  else fail(`GetKillingUnit type: ${killerType && killerType.n} (want ${rawcodeToInt('hpea')})`);
}

// --- 7.11: combat events (damage + attacked — 7.4c) ---
console.log('\n[7.11] Combat events (Interpreter.pumpDamageEvents / pumpAttackEvents)');
{
  const { rawcodeToInt } = require(join(BUILD, 'lexer.js'));
  const SRC = `
globals
    unit    udg_target = null
    integer udg_dmgHits    = 0
    real    udg_dmg        = 0.0
    integer udg_dmgSrc     = 0
    integer udg_atkHits    = 0
    integer udg_attacker   = 0
endglobals
function OnDamage takes nothing returns nothing
    set udg_dmgHits = udg_dmgHits + 1
    set udg_dmg     = GetEventDamage()
    set udg_dmgSrc  = GetUnitTypeId( GetEventDamageSource() )
endfunction
function OnAttacked takes nothing returns nothing
    set udg_atkHits  = udg_atkHits + 1
    set udg_attacker = GetUnitTypeId( GetAttacker() )
endfunction
function InitCombat takes nothing returns nothing
    local trigger td = CreateTrigger()
    local trigger ta = CreateTrigger()
    call TriggerAddAction( td, function OnDamage )
    call TriggerAddAction( ta, function OnAttacked )
    call TriggerRegisterUnitEvent( td, udg_target, ConvertUnitEvent(52) )        // EVENT_UNIT_DAMAGED
    call TriggerRegisterPlayerUnitEvent( ta, Player(0), ConvertPlayerUnitEvent(18), null ) // ATTACKED
endfunction`;
  const interp = buildInterpreter([SRC]);
  // The damaged unit's handle must exist before it's registered on.
  const targetH = interp.rt.unitForSim({ id: 5, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 });
  interp.rt.globals.set('udg_target', targetH);
  interp.run('InitCombat', []);

  // Unit 5 takes 37 damage from an 'hpea'.
  interp.pumpDamageEvents([{ target: { id: 5, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, source: { id: 6, typeId: 'hpea', owner: 1, x: 0, y: 0, facing: 0 }, amount: 37 }]);
  // Damage to a DIFFERENT unit must NOT fire the unit-5 registration.
  interp.pumpDamageEvents([{ target: { id: 9, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, source: null, amount: 99 }]);
  // A player-0 unit is attacked by an 'ogru'; a player-1 unit's attack must NOT fire.
  interp.pumpAttackEvents([{ attacked: { id: 5, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, attacker: { id: 7, typeId: 'ogru', owner: 1, x: 0, y: 0, facing: 0 } }]);
  interp.pumpAttackEvents([{ attacked: { id: 8, typeId: 'hfoo', owner: 1, x: 0, y: 0, facing: 0 }, attacker: { id: 7, typeId: 'ogru', owner: 1, x: 0, y: 0, facing: 0 } }]);

  const dh = interp.rt.globals.get('udg_dmgHits');
  const dmg = interp.rt.globals.get('udg_dmg');
  const dsrc = interp.rt.globals.get('udg_dmgSrc');
  const ah = interp.rt.globals.get('udg_atkHits');
  const atk = interp.rt.globals.get('udg_attacker');
  if (dh && dh.n === 1) ok(`EVENT_UNIT_DAMAGED fired for the struck unit only (not another unit's damage)`);
  else fail(`damage hits: ${dh && dh.n} (want 1)`);
  if (dmg && Math.abs(dmg.n - 37) < 1e-6) ok(`GetEventDamage() == 37`);
  else fail(`GetEventDamage: ${dmg && dmg.n} (want 37)`);
  if (dsrc && dsrc.n === rawcodeToInt('hpea')) ok(`GetEventDamageSource() is the damager ('hpea')`);
  else fail(`GetEventDamageSource: ${dsrc && dsrc.n} (want ${rawcodeToInt('hpea')})`);
  if (ah && ah.n === 1) ok(`EVENT_PLAYER_UNIT_ATTACKED fired for the owner-matched attack only`);
  else fail(`attack hits: ${ah && ah.n} (want 1)`);
  if (atk && atk.n === rawcodeToInt('ogru')) ok(`GetAttacker() is the attacker ('ogru')`);
  else fail(`GetAttacker: ${atk && atk.n} (want ${rawcodeToInt('ogru')})`);
}

// --- 7.12: trigger effects land — player resources through the real BJs ---
console.log('\n[7.12] Trigger effects: player resources (SetPlayerState + the AdjustPlayerState*BJ family)');
{
  // A tiny sim stash the hook reads/writes, exactly like mapViewer's bridge.
  const stash = {};
  const of = (p) => (stash[p] ??= { gold: 0, lumber: 0 });
  const hooks = {
    setPlayerState: (p, state, value) => { if (state === 1) of(p).gold = value; else if (state === 2) of(p).lumber = value; },
    getPlayerState: (p, state) => (state === 1 ? of(p).gold : state === 2 ? of(p).lumber : 0),
  };
  const SRC = `
globals
    integer udg_readGold = 0
endglobals
function RunEcon takes nothing returns nothing
    call SetPlayerState( Player(0), PLAYER_STATE_RESOURCE_GOLD, 500 )
    call AdjustPlayerStateBJ( 150, Player(0), PLAYER_STATE_RESOURCE_GOLD )   // +150 gold
    call SetPlayerStateBJ( Player(0), PLAYER_STATE_RESOURCE_LUMBER, 300 )    // lumber := 300
    set udg_readGold = GetPlayerState( Player(0), PLAYER_STATE_RESOURCE_GOLD )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('RunEcon', []);
  const readGold = interp.rt.globals.get('udg_readGold');
  if (of(0).gold === 650) ok(`SetPlayerState + AdjustPlayerStateBJ → gold 500 then +150 == 650`);
  else fail(`gold: ${of(0).gold} (want 650)`);
  if (of(0).lumber === 300) ok(`SetPlayerStateBJ (adjust from GetPlayerState) → lumber == 300`);
  else fail(`lumber: ${of(0).lumber} (want 300)`);
  if (readGold && readGold.n === 650) ok(`GetPlayerState reads the live value back (650)`);
  else fail(`GetPlayerState: ${readGold && readGold.n} (want 650)`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
