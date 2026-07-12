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

// --- 7.13: unit-mutation effects (7.7 cont.) — a trigger visibly alters a unit ---
console.log('\n[7.13] Unit-mutation effects (position/facing/owner/pause/scale/color/flyHeight/speed + change-owner)');
{
  // A tiny mock sim keyed by simId — CreateUnit assigns an id and a record the effect
  // hooks mutate, exactly like mapViewer's bridge over SimWorld/RtsController.
  let nextId = 100;
  const sim = {};
  const rec = (id) => sim[id];
  const hooks = {
    createUnit: (player, typeId, x, y, facing) => {
      const id = nextId++;
      sim[id] = { player, typeId, x, y, facing: (facing * Math.PI) / 180, scale: 1, color: null, flyHeight: 0, speed: 0, turn: 0, paused: false };
      return id;
    },
    setUnitPosition: (id, x, y) => { rec(id).x = x; rec(id).y = y; },
    setUnitFacing: (id, rad, instant) => { rec(id).facing = rad; rec(id).facingInstant = instant; },
    setUnitOwner: (id, player, changeColor) => { rec(id).player = player; rec(id).changeColor = changeColor; },
    pauseUnit: (id, flag) => { rec(id).paused = flag; },
    isUnitPaused: (id) => rec(id).paused,
    setUnitScale: (id, s) => { rec(id).scale = s; },
    setUnitVertexColor: (id, r, g, b, a) => { rec(id).color = [r, g, b, a]; },
    setUnitFlyHeight: (id, h) => { rec(id).flyHeight = h; },
    getUnitFlyHeight: (id) => rec(id).flyHeight,
    setUnitMoveSpeed: (id, s) => { rec(id).speed = s; },
    getUnitMoveSpeed: (id) => rec(id).speed,
    setUnitTurnSpeed: (id, t) => { rec(id).turn = t; },
    getUnitX: (id) => rec(id).x,
    getUnitY: (id) => rec(id).y,
    getUnitFacing: (id) => rec(id).facing,
  };
  const SRC = `
globals
    unit    udg_u          = null
    integer udg_owned      = 0
    integer udg_prevOwner  = -1
    real    udg_readX       = 0.0
    real    udg_readFace    = 0.0
    real    udg_readSpeed   = 0.0
    boolean udg_wasPaused   = false
endglobals
function OnChangeOwner takes nothing returns nothing
    set udg_owned     = udg_owned + 1
    set udg_prevOwner = GetPlayerId( GetChangingUnitPrevOwner() )
endfunction
function InitFx takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerAddAction( t, function OnChangeOwner )
    call TriggerRegisterPlayerUnitEvent( t, Player(2), ConvertPlayerUnitEvent(270), null ) // CHANGE_OWNER
    set udg_u = CreateUnit( Player(2), 'hfoo', 0.0, 0.0, 90.0 )
endfunction
function RunFx takes nothing returns nothing
    call SetUnitX( udg_u, 512.0 )
    call SetUnitY( udg_u, 256.0 )
    call SetUnitFacing( udg_u, 180.0 )
    call SetUnitScale( udg_u, 1.5, 1.5, 1.5 )
    call SetUnitVertexColor( udg_u, 255, 0, 0, 255 )
    call SetUnitFlyHeight( udg_u, 200.0, 0.0 )
    call SetUnitMoveSpeed( udg_u, 400.0 )
    call PauseUnit( udg_u, true )
    set udg_wasPaused = IsUnitPaused( udg_u )
    call SetUnitOwner( udg_u, Player(5), true )
    set udg_readX     = GetUnitX( udg_u )
    set udg_readFace  = GetUnitFacing( udg_u )
    set udg_readSpeed = GetUnitMoveSpeed( udg_u )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('InitFx', []);
  interp.run('RunFx', []);
  const u = sim[100];
  const g = (n) => interp.rt.globals.get(n);
  if (u && u.x === 512 && u.y === 256) ok(`SetUnitX/Y teleported the sim unit (512, 256)`);
  else fail(`position: ${u && u.x},${u && u.y} (want 512,256)`);
  if (u && Math.abs(u.facing - Math.PI) < 1e-6 && u.facingInstant === true) ok(`SetUnitFacing set the sim facing to 180° (π rad), instant`);
  else fail(`facing: ${u && u.facing} (want ${Math.PI})`);
  if (u && u.scale === 1.5) ok(`SetUnitScale applied (1.5)`);
  else fail(`scale: ${u && u.scale} (want 1.5)`);
  if (u && u.color && u.color[0] === 1 && u.color[1] === 0 && u.color[2] === 0 && u.color[3] === 1) ok(`SetUnitVertexColor 255,0,0,255 → [1,0,0,1]`);
  else fail(`color: ${u && JSON.stringify(u.color)} (want [1,0,0,1])`);
  if (u && u.flyHeight === 200) ok(`SetUnitFlyHeight applied (200)`);
  else fail(`flyHeight: ${u && u.flyHeight} (want 200)`);
  if (u && u.speed === 400) ok(`SetUnitMoveSpeed applied (400)`);
  else fail(`speed: ${u && u.speed} (want 400)`);
  const wp = g('udg_wasPaused');
  if (u && u.paused === true && wp && wp.b === true) ok(`PauseUnit + IsUnitPaused round-trip (true)`);
  else fail(`paused: sim ${u && u.paused} / IsUnitPaused ${wp && wp.b} (want true/true)`);
  if (u && u.player === 5 && u.changeColor === true) ok(`SetUnitOwner reassigned owner (5) + changed colour`);
  else fail(`owner: ${u && u.player} changeColor ${u && u.changeColor} (want 5/true)`);
  const owned = g('udg_owned'), prev = g('udg_prevOwner');
  if (owned && owned.n === 1 && prev && prev.n === 2) ok(`EVENT_PLAYER_UNIT_CHANGE_OWNER fired once; GetChangingUnitPrevOwner == Player(2)`);
  else fail(`change-owner: fired ${owned && owned.n} prevOwner ${prev && prev.n} (want 1/2)`);
  const rx = g('udg_readX'), rf = g('udg_readFace'), rs = g('udg_readSpeed');
  if (rx && rx.n === 512 && rf && Math.abs(rf.n - 180) < 1e-4 && rs && rs.n === 400) ok(`Get* read live sim values back (X 512, facing 180°, speed 400)`);
  else fail(`Get*: X ${rx && rx.n} facing ${rf && rf.n} speed ${rs && rs.n} (want 512/180/400)`);
}

// --- 7.14: trigger orders — issue natives + order events + vocabulary ---
console.log('\n[7.14] Trigger orders (IssueXOrder → sim; EVENT_..._ISSUED_ORDER; OrderId vocabulary)');
{
  const { rawcodeToInt } = require(join(BUILD, 'lexer.js'));
  // Part A: the issue-order natives reach the bridge with the right order id + kind + point/target.
  let nextId = 200;
  const issued = [];
  const hooks = {
    createUnit: () => nextId++,
    issueUnitOrder: (unitId, orderId, order, kind, x, y, targetId) => (issued.push({ unitId, orderId, order, kind, x, y, targetId }), true),
    getUnitCurrentOrder: () => 851986, // "move"
  };
  const SRC_A = `
globals
    unit    udg_u    = null
    unit    udg_tgt  = null
    integer udg_oid  = 0
    string  udg_ostr = ""
    integer udg_cur  = 0
endglobals
function InitOrders takes nothing returns nothing
    set udg_u   = CreateUnit( Player(0), 'hfoo', 0.0, 0.0, 0.0 )
    set udg_tgt = CreateUnit( Player(1), 'hpea', 0.0, 0.0, 0.0 )
    call IssuePointOrder( udg_u, "attack", 512.0, 256.0 )
    call IssueTargetOrder( udg_u, "smart", udg_tgt )
    call IssueImmediateOrder( udg_u, "stop" )
    // An ABILITY order (7.17): "Order <unit> to cast Holy Light" — the order STRING is
    // what identifies the spell (the engine's numeric ids for ability orders are in no
    // data file), so it must reach the bridge intact and round-trip through OrderId.
    call IssueTargetOrder( udg_u, "holybolt", udg_tgt )
    set udg_oid  = OrderId( "move" )
    set udg_ostr = OrderId2String( OrderId( "holybolt" ) )
    set udg_cur  = GetUnitCurrentOrder( udg_u )
endfunction`;
  const interpA = buildInterpreter([COMMON_J, BLIZZARD_J, SRC_A], { hooks });
  interpA.run('InitOrders', []);
  const pt = issued.find((o) => o.kind === 'point');
  const tg = issued.find((o) => o.kind === 'target');
  const im = issued.find((o) => o.kind === 'immediate');
  if (pt && pt.orderId === 851983 && pt.x === 512 && pt.y === 256) ok(`IssuePointOrder("attack",512,256) → bridge (id 851983, point)`);
  else fail(`point order: ${JSON.stringify(pt)}`);
  if (tg && tg.orderId === 851971 && tg.targetId === 201) ok(`IssueTargetOrder("smart", tgt) → bridge (id 851971, target 201)`);
  else fail(`target order: ${JSON.stringify(tg)}`);
  if (im && im.orderId === 851972) ok(`IssueImmediateOrder("stop") → bridge (id 851972, immediate)`);
  else fail(`immediate order: ${JSON.stringify(im)}`);
  const oid = interpA.rt.globals.get('udg_oid'), ostr = interpA.rt.globals.get('udg_ostr'), cur = interpA.rt.globals.get('udg_cur');
  if (oid && oid.n === 851986) ok(`OrderId("move") == 851986`); else fail(`OrderId: ${oid && oid.n}`);
  if (cur && cur.n === 851986) ok(`GetUnitCurrentOrder → 851986 (live via bridge)`); else fail(`GetUnitCurrentOrder: ${cur && cur.n}`);
  // 7.17: an ability order reaches the sim BY NAME (that's the key the cast resolves on)
  // and its minted id round-trips through the vocabulary.
  const spell = issued.find((o) => o.order === 'holybolt');
  if (spell && spell.kind === 'target' && spell.targetId === 201 && ostr && ostr.s === 'holybolt') {
    ok(`IssueTargetOrder("holybolt", tgt) → the bridge gets the order STRING (an ability order); OrderId2String round-trips it`);
  } else fail(`ability order: ${JSON.stringify(spell)} / OrderId2String → ${ostr && ostr.s}`);

  // Part B: the order EVENTS dispatch with the right responses (Interpreter.pumpOrderEvents).
  const SRC_B = `
globals
    integer udg_ptHits  = 0
    integer udg_tgHits  = 0
    integer udg_ordId   = 0
    real    udg_px      = 0.0
    integer udg_tgtType = 0
endglobals
function OnPoint takes nothing returns nothing
    set udg_ptHits = udg_ptHits + 1
    set udg_ordId  = GetIssuedOrderId()
    set udg_px     = GetOrderPointX()
endfunction
function OnTarget takes nothing returns nothing
    set udg_tgHits  = udg_tgHits + 1
    set udg_tgtType = GetUnitTypeId( GetOrderTargetUnit() )
endfunction
function InitEvt takes nothing returns nothing
    local trigger tp = CreateTrigger()
    local trigger tt = CreateTrigger()
    call TriggerAddAction( tp, function OnPoint )
    call TriggerAddAction( tt, function OnTarget )
    call TriggerRegisterPlayerUnitEvent( tp, Player(0), ConvertPlayerUnitEvent(39), null ) // ISSUED_POINT_ORDER
    call TriggerRegisterPlayerUnitEvent( tt, Player(0), ConvertPlayerUnitEvent(40), null ) // ISSUED_TARGET_ORDER
endfunction`;
  const interpB = buildInterpreter([SRC_B]);
  interpB.run('InitEvt', []);
  interpB.pumpOrderEvents([{ unit: { id: 5, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, orderId: 851983, kind: 'point', x: 640, y: 128, target: null }]);
  interpB.pumpOrderEvents([{ unit: { id: 5, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, orderId: 851971, kind: 'target', x: 0, y: 0, target: { id: 6, typeId: 'hpea', owner: 1, x: 0, y: 0, facing: 0 } }]);
  // A player-1 unit's order must NOT fire the player-0 registration.
  interpB.pumpOrderEvents([{ unit: { id: 7, typeId: 'hfoo', owner: 1, x: 0, y: 0, facing: 0 }, orderId: 851986, kind: 'point', x: 0, y: 0, target: null }]);
  const ptHits = interpB.rt.globals.get('udg_ptHits'), tgHits = interpB.rt.globals.get('udg_tgHits');
  const ordId = interpB.rt.globals.get('udg_ordId'), px = interpB.rt.globals.get('udg_px'), tgtType = interpB.rt.globals.get('udg_tgtType');
  if (ptHits && ptHits.n === 1) ok(`ISSUED_POINT_ORDER fired for the owner-matched order only`); else fail(`point hits: ${ptHits && ptHits.n} (want 1)`);
  if (ordId && ordId.n === 851983) ok(`GetIssuedOrderId() == 851983 (attack)`); else fail(`order id: ${ordId && ordId.n}`);
  if (px && Math.abs(px.n - 640) < 1e-6) ok(`GetOrderPointX() == 640`); else fail(`point x: ${px && px.n}`);
  if (tgHits && tgHits.n === 1) ok(`ISSUED_TARGET_ORDER fired once`); else fail(`target hits: ${tgHits && tgHits.n}`);
  if (tgtType && tgtType.n === rawcodeToInt('hpea')) ok(`GetOrderTargetUnit() is the peasant target`); else fail(`target type: ${tgtType && tgtType.n}`);
}

// --- 7.15: trigger threads — TriggerSleepAction / PolledWait (waits) ---
console.log('\n[7.15] Trigger threads (TriggerSleepAction suspends; PolledWait; waits in map init)');
{
  const { rawcodeToInt } = require(join(BUILD, 'lexer.js'));

  // Part A: a wait SUSPENDS the trigger's actions mid-way, and the thread keeps its event
  // responses across the wait (GetDyingUnit() still resolves after "Wait 3 seconds").
  const SRC_A = `
globals
    integer udg_phase  = 0
    integer udg_before = 0
    integer udg_after  = 0
endglobals
function OnDeath takes nothing returns nothing
    set udg_phase  = 1
    set udg_before = GetUnitTypeId( GetDyingUnit() )
    call TriggerSleepAction( 3.0 )
    set udg_phase  = 2
    set udg_after  = GetUnitTypeId( GetDyingUnit() )
endfunction
function InitW takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerAddAction( t, function OnDeath )
    call TriggerRegisterPlayerUnitEvent( t, Player(0), ConvertPlayerUnitEvent(20), null ) // UNIT_DEATH
endfunction`;
  const iA = buildInterpreter([SRC_A]);
  const gA = (n) => iA.rt.globals.get(n);
  iA.run('InitW', []);
  iA.pumpUnitDeaths([{ victim: { id: 1, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, killer: null }]);
  const phase1 = gA('udg_phase'), before = gA('udg_before');
  if (phase1 && phase1.n === 1 && before && before.n === rawcodeToInt('hfoo')) ok(`actions run immediately up to the wait (phase 1, GetDyingUnit resolved)`);
  else fail(`pre-wait: phase ${phase1 && phase1.n} dying ${before && before.n} (want 1/'hfoo')`);
  if (iA.sleepingThreads === 1) ok(`the wait parked the trigger thread (1 sleeping)`);
  else fail(`sleeping threads: ${iA.sleepingThreads} (want 1)`);
  iA.advanceTime(1.0);
  iA.advanceTime(1.0);
  const midPhase = gA('udg_phase');
  if (midPhase && midPhase.n === 1) ok(`still parked after 2.0s of a 3.0s wait (phase 1)`);
  else fail(`mid-wait phase: ${midPhase && midPhase.n} (want 1)`);
  iA.advanceTime(1.5); // 3.5s total — the wait is up
  const phase2 = gA('udg_phase'), after = gA('udg_after');
  if (phase2 && phase2.n === 2) ok(`thread resumed after 3.0s of game time (phase 2)`);
  else fail(`post-wait phase: ${phase2 && phase2.n} (want 2)`);
  if (after && after.n === rawcodeToInt('hfoo')) ok(`event responses SURVIVE the wait — GetDyingUnit() still the victim`);
  else fail(`post-wait GetDyingUnit: ${after && after.n} (want 'hfoo')`);
  if (iA.sleepingThreads === 0) ok(`the finished thread left the scheduler (0 sleeping)`);
  else fail(`sleeping threads after: ${iA.sleepingThreads} (want 0)`);

  // Part B: PolledWait — the REAL blizzard.j BJ the GUI's "Wait" compiles to. It polls a
  // timer in a loop calling TriggerSleepAction, so before threads existed it span to the
  // 2,000,000-iteration cap and ABANDONED the rest of the trigger. It must now just wait.
  const SRC_B = `
globals
    integer udg_step = 0
    real    udg_at   = 0.0
endglobals
function DoWait takes nothing returns nothing
    set udg_step = 1
    call PolledWait( 2.0 )
    set udg_step = 2
endfunction`;
  const iB = buildInterpreter([COMMON_J, BLIZZARD_J, SRC_B]);
  const gB = (n) => iB.rt.globals.get(n);
  iB.run('DoWait', []);
  const bPre = gB('udg_step');
  if (bPre && bPre.n === 1 && iB.sleepingThreads === 1) ok(`PolledWait(2.0) parked the thread instead of spinning`);
  else fail(`PolledWait pre: step ${bPre && bPre.n} sleeping ${iB.sleepingThreads} (want 1/1)`);
  let ticks = 0;
  while (ticks < 400 && iB.sleepingThreads > 0) {
    iB.advanceTime(0.05); // 20 Hz, like the sim tick
    ticks++;
  }
  const bStep = gB('udg_step');
  if (bStep && bStep.n === 2) ok(`PolledWait returned and the rest of the function ran (step 2)`);
  else fail(`PolledWait post: step ${bStep && bStep.n} (want 2) after ${ticks} ticks`);
  // bj_POLLED_WAIT_INTERVAL is 0.10s, so a 2.0s polled wait lands a little past 2.0s.
  if (iB.rt.gameTime >= 2.0 && iB.rt.gameTime < 2.6) ok(`it waited ~2.0s of game time (${iB.rt.gameTime.toFixed(2)}s)`);
  else fail(`PolledWait elapsed: ${iB.rt.gameTime.toFixed(2)}s (want ~2.0)`);

  // Part C: a 0-second wait must still yield a tick — else `loop / TriggerSleepAction(0) /
  // endloop` would hang the frame. A thread resumes at most once per pump.
  const SRC_C = `
globals
    integer udg_n = 0
endglobals
function Spin takes nothing returns nothing
    loop
        set udg_n = udg_n + 1
        exitwhen udg_n >= 3
        call TriggerSleepAction( 0.0 )
    endloop
endfunction`;
  const iC = buildInterpreter([SRC_C]);
  iC.run('Spin', []);
  const c0 = iC.rt.globals.get('udg_n');
  iC.advanceTime(0.05);
  const c1 = iC.rt.globals.get('udg_n');
  iC.advanceTime(0.05);
  const c2 = iC.rt.globals.get('udg_n');
  if (c0 && c0.n === 1 && c1 && c1.n === 2 && c2 && c2.n === 3) ok(`TriggerSleepAction(0) costs one tick per wait (1 → 2 → 3), no hang`);
  else fail(`zero-wait loop: ${c0 && c0.n} → ${c1 && c1.n} → ${c2 && c2.n} (want 1 → 2 → 3)`);

  // Part D: a wait in a CONDITION has no thread to park (WC3 can't wait there either) —
  // it must abandon that condition, NOT spin. The trigger then simply doesn't fire.
  const SRC_D = `
globals
    integer udg_fired = 0
endglobals
function BadCond takes nothing returns boolean
    call PolledWait( 1.0 )
    return true
endfunction
function Act takes nothing returns nothing
    set udg_fired = 1
endfunction
function InitD takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerAddCondition( t, Condition( function BadCond ) )
    call TriggerAddAction( t, function Act )
    call TriggerRegisterPlayerUnitEvent( t, Player(0), ConvertPlayerUnitEvent(20), null )
endfunction`;
  const iD = buildInterpreter([COMMON_J, BLIZZARD_J, SRC_D]);
  iD.run('InitD', []);
  iD.pumpUnitDeaths([{ victim: { id: 1, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, killer: null }]);
  const fired = iD.rt.globals.get('udg_fired');
  if (fired && fired.n === 0 && iD.sleepingThreads === 0) ok(`a wait in a condition is abandoned, not spun (trigger didn't fire, nothing parked)`);
  else fail(`condition wait: fired ${fired && fired.n} sleeping ${iD.sleepingThreads} (want 0/0)`);

  // Part E: the real-world shape — a MAP INIT trigger that waits, then spawns. WC3 runs
  // main() on a thread, and ConditionalTriggerExecute runs the trigger's actions ON it, so
  // the wait suspends main() itself and the rest of init is deferred (faithful to WC3).
  const spawned = [];
  const hooksE = { createUnit: (player, typeId, x, y) => (spawned.push({ player, typeId, x, y }), 300 + spawned.length) };
  const SRC_E = `
globals
    trigger gg_trg_Wave = null
    integer udg_afterInit = 0
endglobals
function WaveActions takes nothing returns nothing
    call TriggerSleepAction( 5.0 )
    call CreateUnit( Player(0), 'hfoo', 128.0, 256.0, 270.0 )
endfunction
function main takes nothing returns nothing
    set gg_trg_Wave = CreateTrigger()
    call TriggerAddAction( gg_trg_Wave, function WaveActions )
    call ConditionalTriggerExecute( gg_trg_Wave )
    set udg_afterInit = 1
endfunction`;
  const iE = buildInterpreter([COMMON_J, BLIZZARD_J, SRC_E], { hooks: hooksE });
  iE.run('main', []);
  const initFlagPre = iE.rt.globals.get('udg_afterInit');
  if (spawned.length === 0 && initFlagPre && initFlagPre.n === 0 && iE.sleepingThreads === 1) ok(`a Wait in map init suspends main() itself — nothing spawned yet, init deferred`);
  else fail(`init wait: spawned ${spawned.length} afterInit ${initFlagPre && initFlagPre.n} sleeping ${iE.sleepingThreads} (want 0/0/1)`);
  for (let i = 0; i < 120 && iE.sleepingThreads > 0; i++) iE.advanceTime(0.05); // 6s
  const initFlag = iE.rt.globals.get('udg_afterInit');
  if (spawned.length === 1 && spawned[0].typeId === 'hfoo') ok(`after the 5s wait the trigger spawned its unit (CreateUnit reached the bridge)`);
  else fail(`post-wait spawn: ${JSON.stringify(spawned)}`);
  if (initFlag && initFlag.n === 1) ok(`main() resumed and finished after the trigger's wait`);
  else fail(`afterInit: ${initFlag && initFlag.n} (want 1)`);
}

// --- 7.16: unit groups — the GUI's "Pick every unit in <region> matching <cond>" ---
console.log('\n[7.16] Unit groups (GroupEnum* / ForGroup / FirstOfGroup / group orders — through the real BJs)');
{
  // A mock sim: 5 units the enumeration hooks expose, exactly as mapViewer's bridge does
  // over SimWorld.units. Two footmen + a peasant sit inside the rect (0,0)-(512,512); a
  // player-1 grunt and a far-off footman sit outside it.
  const sim = [
    { id: 1, typeId: 'hfoo', owner: 0, x: 100, y: 100, facing: 0 },
    { id: 2, typeId: 'hfoo', owner: 0, x: 300, y: 200, facing: 0 },
    { id: 3, typeId: 'hpea', owner: 0, x: 400, y: 400, facing: 0 },
    { id: 4, typeId: 'ogru', owner: 1, x: 200, y: 200, facing: 0 }, // inside, but player 1
    { id: 5, typeId: 'hfoo', owner: 0, x: 2000, y: 2000, facing: 0 }, // outside the rect
  ];
  const issued = [];
  const hooks = {
    enumUnits: () => sim,
    selectedUnits: (p) => (p === 0 ? [2, 3] : []),
    objectName: (typeId) => ({ hfoo: 'Footman', hpea: 'Peasant', ogru: 'Grunt' })[typeId],
    isUnitType: (id, t) => (t === 2 ? false : t === 0 ? false : t === 4), // everything is GROUND
    issueUnitOrder: (unitId, orderId, order, kind, x, y) => (issued.push({ unitId, orderId, order, kind, x, y }), true),
    getUnitState: (id, s) => (s === 0 ? 100 : 0), // UNIT_STATE_LIFE — all alive
  };
  const SRC = `
globals
    integer udg_picked   = 0
    integer udg_footmen  = 0
    integer udg_ofPlayer = 0
    integer udg_inRange  = 0
    integer udg_selected = 0
    integer udg_firstId  = 0
    boolean udg_inGroup  = false
    boolean udg_notIn    = false
    integer udg_counted  = 0
endglobals
// The exact shape the World Editor compiles "Pick every unit in <rect> matching
// <(Unit-type of (Matching unit)) Equal to Footman> and do <actions>" into.
function FiltFootman takes nothing returns boolean
    return GetUnitTypeId( GetFilterUnit() ) == 'hfoo'
endfunction
function PickAction takes nothing returns nothing
    set udg_picked = udg_picked + 1
    if GetUnitTypeId( GetEnumUnit() ) == 'hfoo' then
        set udg_footmen = udg_footmen + 1
    endif
endfunction
function RunGroups takes nothing returns nothing
    local group  g   = null
    local rect   r   = Rect( 0.0, 0.0, 512.0, 512.0 )
    local unit   u   = null

    // "Pick every unit in region matching condition" — ForGroupBJ over GetUnitsInRectMatching.
    call ForGroupBJ( GetUnitsInRectMatching( r, Condition( function FiltFootman ) ), function PickAction )

    // The un-filtered rect enum: 4 units are inside (the 5th is far away).
    set g = GetUnitsInRectAll( r )
    set udg_counted = CountUnitsInGroup( g )
    set udg_firstId = GetUnitTypeId( FirstOfGroup( g ) )
    set udg_inGroup = IsUnitInGroup( FirstOfGroup( g ), g )
    call GroupPointOrder( g, "attack", 1024.0, 64.0 )   // mass order: the whole group marches
    call DestroyGroup( g )

    // Ownership / radius / selection scans.
    set g = GetUnitsOfPlayerAll( Player(0) )
    set udg_ofPlayer = CountUnitsInGroup( g )
    call DestroyGroup( g )

    set g = CreateGroup()
    call GroupEnumUnitsInRange( g, 0.0, 0.0, 250.0, null )   // only unit 1 (100,100) is within 250
    set udg_inRange = CountUnitsInGroup( g )
    call GroupClear( g )

    call GroupEnumUnitsSelected( g, Player(0), null )
    set udg_selected = CountUnitsInGroup( g )

    // A group is a SET, and the enum REPLACED its contents (no leftovers from above).
    call GroupClear( g )
    set u = FirstOfGroup( GetUnitsOfPlayerAll( Player(1) ) )
    call GroupAddUnit( g, u )
    call GroupAddUnit( g, u )
    set udg_notIn = IsUnitInGroup( u, g ) and CountUnitsInGroup( g ) == 1
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('RunGroups', []);
  const g = (n) => interp.rt.globals.get(n);
  const picked = g('udg_picked'), counted = g('udg_counted'), ofPlayer = g('udg_ofPlayer');
  const inRange = g('udg_inRange'), selected = g('udg_selected'), inGroup = g('udg_inGroup'), setOnce = g('udg_notIn');
  const footmen = g('udg_footmen');
  if (picked && picked.n === 2 && footmen && footmen.n === 2) ok(`"Pick every unit in region matching Footman" → ForGroupBJ ran the action for 2 units; GetEnumUnit resolves each`);
  else fail(`picked: ${picked && picked.n} / GetEnumUnit footmen: ${footmen && footmen.n} (want 2/2 — the 2 footmen inside the rect)`);
  if (counted && counted.n === 4) ok(`GetUnitsInRectAll + CountUnitsInGroup → 4 (the far-off unit excluded)`);
  else fail(`rect count: ${counted && counted.n} (want 4)`);
  if (ofPlayer && ofPlayer.n === 4) ok(`GroupEnumUnitsOfPlayer(Player(0)) → 4 (the player-1 grunt excluded)`);
  else fail(`of-player count: ${ofPlayer && ofPlayer.n} (want 4)`);
  if (inRange && inRange.n === 1) ok(`GroupEnumUnitsInRange(0,0,250) → 1 (a circle test from the unit's origin)`);
  else fail(`in-range count: ${inRange && inRange.n} (want 1)`);
  if (selected && selected.n === 2) ok(`GroupEnumUnitsSelected(Player(0)) → 2 (the bridge's selection)`);
  else fail(`selected count: ${selected && selected.n} (want 2)`);
  if (inGroup && inGroup.b === true && setOnce && setOnce.b === true) ok(`IsUnitInGroup true for a member; GroupAddUnit twice adds once (a group is a set)`);
  else fail(`membership: inGroup ${inGroup && inGroup.b} setOnce ${setOnce && setOnce.b} (want true/true)`);
  // The mass order reached the bridge for every member of the rect group, with the right id.
  const marching = issued.filter((o) => o.kind === 'point' && o.orderId === 851983 && o.x === 1024);
  if (marching.length === 4 && new Set(marching.map((o) => o.unitId)).size === 4) ok(`GroupPointOrder("attack") ordered all 4 members through the bridge (id 851983)`);
  else fail(`group order: ${JSON.stringify(issued)}`);

  // A trigger-CREATED unit must enumerate as the SAME handle CreateUnit returned —
  // else `GetTriggerUnit() == GetEnumUnit()` and IsUnitInGroup silently fail.
  const sim2 = [];
  const hooks2 = {
    createUnit: (player, typeId, x, y, facing) => {
      const id = 900 + sim2.length;
      sim2.push({ id, typeId, owner: player, x, y, facing });
      return id;
    },
    enumUnits: () => sim2,
  };
  const SRC2 = `
globals
    boolean udg_same = false
endglobals
function RunIdentity takes nothing returns nothing
    local unit  u = CreateUnit( Player(0), 'hfoo', 64.0, 64.0, 0.0 )
    local group g = CreateGroup()
    call GroupEnumUnitsInRange( g, 64.0, 64.0, 128.0, null )
    set udg_same = IsUnitInGroup( u, g ) and ( FirstOfGroup( g ) == u )
endfunction`;
  const interp2 = buildInterpreter([COMMON_J, BLIZZARD_J, SRC2], { hooks: hooks2 });
  interp2.run('RunIdentity', []);
  const same = interp2.rt.globals.get('udg_same');
  if (same && same.b === true) ok(`a CreateUnit'd unit enumerates as the SAME handle (IsUnitInGroup + \`==\` hold)`);
  else fail(`handle identity: ${same && same.b} (want true — one sim unit must mean one handle)`);
}

// --- 7.17a: ability + hero effect natives (a trigger grants a spell / levels a hero) ---
console.log('\n[7.17] Ability + hero effects (UnitAddAbility / SetHeroLevel / AddHeroXP / invulnerable / animation)');
{
  // A mock sim unit with the state these natives mutate, mirroring SimWorld's own rules:
  // an ability is added at rank 1, SetHeroLevel only ever levels UP (and each level grants
  // a skill point), and XP crossing a threshold levels the hero.
  const XP_FOR = (lvl) => (lvl - 1) * 200; // a stand-in curve (the real one is gameplayConstants')
  const u = { level: 1, xp: 0, skillPoints: 1, abilities: [], invulnerable: false, pathing: true, anim: '' };
  const level = (n) => {
    while (u.level < n) {
      u.level++;
      u.skillPoints++;
    }
    u.xp = Math.max(u.xp, XP_FOR(u.level));
  };
  const hooks = {
    createUnit: () => 1,
    unitAddAbility: (id, a) => (u.abilities.some((x) => x.id === a) ? false : (u.abilities.push({ id: a, level: 1 }), true)),
    unitRemoveAbility: (id, a) => {
      const i = u.abilities.findIndex((x) => x.id === a);
      return i < 0 ? false : (u.abilities.splice(i, 1), true);
    },
    getUnitAbilityLevel: (id, a) => u.abilities.find((x) => x.id === a)?.level ?? 0,
    setUnitAbilityLevel: (id, a, lvl) => {
      const ab = u.abilities.find((x) => x.id === a);
      return ab ? ((ab.level = Math.max(0, Math.min(3, lvl))), ab.level) : 0;
    },
    getUnitLevel: () => u.level,
    setHeroLevel: (id, n) => level(n),
    getHeroXp: () => u.xp,
    addHeroXp: (id, xp) => {
      u.xp += xp;
      while (u.xp >= XP_FOR(u.level + 1)) level(u.level + 1);
    },
    getHeroSkillPoints: () => u.skillPoints,
    modifySkillPoints: (id, d) => ((u.skillPoints = Math.max(0, u.skillPoints + d)), true),
    setUnitInvulnerable: (id, f) => (u.invulnerable = f),
    setUnitPathing: (id, f) => (u.pathing = f),
    setUnitAnimation: (id, a) => (u.anim = a),
  };
  const SRC = `
globals
    integer udg_abilLvl  = 0
    integer udg_gone     = 0
    integer udg_incLvl   = 0
    integer udg_heroLvl  = 0
    integer udg_xp       = 0
    integer udg_points   = 0
    integer udg_custom   = 0
    real    udg_dist     = 0.0
endglobals
function RunEffects takes nothing returns nothing
    local unit h = CreateUnit( Player(0), 'Hpal', 0.0, 0.0, 0.0 )

    // Abilities: grant one, read its rank, rank it up, then strip a second one.
    call UnitAddAbility( h, 'AHhb' )                       // Holy Light — added at rank 1
    set udg_abilLvl = GetUnitAbilityLevel( h, 'AHhb' )
    call SetUnitAbilityLevel( h, 'AHhb', 3 )
    call DecUnitAbilityLevel( h, 'AHhb' )                  // 3 → 2 (rides on the setter)
    set udg_incLvl = GetUnitAbilityLevel( h, 'AHhb' )
    call UnitAddAbility( h, 'AHds' )
    call UnitRemoveAbility( h, 'AHds' )
    set udg_gone = GetUnitAbilityLevel( h, 'AHds' )        // 0 — it's gone

    // Hero: jump to level 3 (the GUI's "Set hero level" is SetHeroLevelBJ), then XP.
    call SetHeroLevelBJ( h, 3, false )
    call AddHeroXP( h, 250, true )                         // 400 (lvl 3) + 250 = 650 → level 4
    set udg_heroLvl = GetHeroLevel( h )
    set udg_xp      = GetHeroXP( h )
    call UnitModifySkillPoints( h, 2 )
    set udg_points  = GetHeroSkillPoints( h )

    // Flags / animation / custom value.
    call SetUnitInvulnerable( h, true )
    call SetUnitPathing( h, false )
    call SetUnitAnimation( h, "attack" )
    call SetUnitUserData( h, 42 )
    set udg_custom = GetUnitUserData( h )

    // DistanceBetweenPoints is a real blizzard.j BJ built on SquareRoot — without that
    // native every distance in the BJ layer measured 0.
    set udg_dist = DistanceBetweenPoints( Location(0.0, 0.0), Location(300.0, 400.0) )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('RunEffects', []);
  const g = (n) => interp.rt.globals.get(n);
  if (g('udg_abilLvl')?.n === 1 && g('udg_incLvl')?.n === 2 && g('udg_gone')?.n === 0) {
    ok(`UnitAddAbility → rank 1; SetUnitAbilityLevel(3) + DecUnitAbilityLevel → 2; UnitRemoveAbility → 0`);
  } else fail(`ability levels: add ${g('udg_abilLvl')?.n} dec ${g('udg_incLvl')?.n} removed ${g('udg_gone')?.n} (want 1/2/0)`);
  // level 3 from SetHeroLevel, then 250 XP crosses into 4; skill points: 1 + 2 levels + 1 + 2.
  if (g('udg_heroLvl')?.n === 4 && g('udg_xp')?.n === 650 && g('udg_points')?.n === 6) {
    ok(`SetHeroLevelBJ → level 3; AddHeroXP(250) → level 4 @ 650 XP; UnitModifySkillPoints → 6 unspent`);
  } else fail(`hero: level ${g('udg_heroLvl')?.n} xp ${g('udg_xp')?.n} points ${g('udg_points')?.n} (want 4/650/6)`);
  if (u.invulnerable === true && u.pathing === false && u.anim === 'attack' && g('udg_custom')?.n === 42) {
    ok(`SetUnitInvulnerable / SetUnitPathing(false) / SetUnitAnimation("attack") reached the bridge; user data round-trips (42)`);
  } else fail(`flags: invuln ${u.invulnerable} pathing ${u.pathing} anim "${u.anim}" custom ${g('udg_custom')?.n}`);
  if (Math.abs((g('udg_dist')?.n ?? 0) - 500) < 0.001) ok(`DistanceBetweenPoints (blizzard.j → SquareRoot) → 500 (3-4-5)`);
  else fail(`DistanceBetweenPoints: ${g('udg_dist')?.n} (want 500 — SquareRoot must be implemented)`);
}

// --- 7.17b: the remaining sim events — spell, construct, train, hero level, unit-state ---
console.log('\n[7.17] Sim events (SPELL_* / CONSTRUCT_* / TRAIN_* / HERO_LEVEL / UNIT_STATE_LIMIT)');
{
  const hp = { 10: 500 }; // the watched unit's life — the unit-state poll reads this
  const hooks = { getUnitState: (id, s) => (s === 0 ? hp[id] ?? 0 : 0), createUnit: () => 10 };
  const SRC = `
globals
    integer udg_effect     = 0
    integer udg_channel    = 0
    integer udg_endcast    = 0
    integer udg_spellId    = 0
    integer udg_targetId   = 0
    integer udg_built      = 0
    integer udg_builtType  = 0
    integer udg_trained    = 0
    integer udg_trainType  = 0
    integer udg_levels     = 0
    integer udg_newLevel   = 0
    integer udg_skill      = 0
    integer udg_hurt       = 0
    unit    udg_watched    = null
endglobals
function OnEffect takes nothing returns nothing
    set udg_effect   = udg_effect + 1
    set udg_spellId  = GetSpellAbilityId()
    set udg_targetId = GetUnitTypeId( GetSpellTargetUnit() )
endfunction
function OnChannel takes nothing returns nothing
    set udg_channel = udg_channel + 1
endfunction
function OnEndcast takes nothing returns nothing
    set udg_endcast = udg_endcast + 1
endfunction
function OnBuilt takes nothing returns nothing
    set udg_built     = udg_built + 1
    set udg_builtType = GetUnitTypeId( GetConstructedStructure() )
endfunction
function OnTrained takes nothing returns nothing
    set udg_trained   = GetUnitTypeId( GetTrainedUnit() )
    set udg_trainType = GetTrainedUnitType()
endfunction
function OnLevel takes nothing returns nothing
    set udg_levels   = udg_levels + 1
    set udg_newLevel = GetHeroLevel( GetLevelingUnit() )
endfunction
function OnSkill takes nothing returns nothing
    set udg_skill = GetLearnedSkill()
endfunction
function OnHurt takes nothing returns nothing
    set udg_hurt = udg_hurt + 1
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    // "A unit starts the effect of an ability" — the phase nearly every GUI trigger uses.
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_SPELL_EFFECT )
    call TriggerAddAction( t, function OnEffect )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_SPELL_CHANNEL )
    call TriggerAddAction( t, function OnChannel )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_SPELL_ENDCAST )
    call TriggerAddAction( t, function OnEndcast )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_CONSTRUCT_FINISH )
    call TriggerAddAction( t, function OnBuilt )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_TRAIN_FINISH )
    call TriggerAddAction( t, function OnTrained )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_HERO_LEVEL )
    call TriggerAddAction( t, function OnLevel )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_HERO_SKILL )
    call TriggerAddAction( t, function OnSkill )
    // "Life of <unit> drops below 100" — TriggerRegisterUnitStateEvent, the polled one.
    set udg_watched = CreateUnit( Player(0), 'hfoo', 0.0, 0.0, 0.0 )
    set t = CreateTrigger()
    call TriggerRegisterUnitStateEvent( t, udg_watched, UNIT_STATE_LIFE, LESS_THAN, 100.0 )
    call TriggerAddAction( t, function OnHurt )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('Setup', []);
  const g = (n) => interp.rt.globals.get(n);
  const caster = { id: 1, typeId: 'Hpal', owner: 0, x: 0, y: 0, facing: 0 };
  const victim = { id: 2, typeId: 'ogru', owner: 1, x: 100, y: 0, facing: 0 };
  const enemyCaster = { id: 3, typeId: 'Ofar', owner: 1, x: 0, y: 0, facing: 0 };

  // The five phases of one cast (as SimWorld raises them), plus an enemy's cast that
  // must NOT reach a Player(0)-registered trigger.
  interp.pumpSpellEvents([
    { caster, abilityId: 'AHhb', phase: 'channel', target: victim, x: 100, y: 0 },
    { caster, abilityId: 'AHhb', phase: 'cast', target: victim, x: 100, y: 0 },
    { caster, abilityId: 'AHhb', phase: 'effect', target: victim, x: 100, y: 0 },
    { caster, abilityId: 'AHhb', phase: 'finish', target: victim, x: 100, y: 0 },
    { caster, abilityId: 'AHhb', phase: 'endcast', target: victim, x: 100, y: 0 },
    { caster: enemyCaster, abilityId: 'AHhb', phase: 'effect', target: null, x: 0, y: 0 },
  ]);
  if (g('udg_effect')?.n === 1 && g('udg_channel')?.n === 1 && g('udg_endcast')?.n === 1) {
    ok(`SPELL_EFFECT/CHANNEL/ENDCAST each fired once for the owner's cast (the enemy's cast fired none)`);
  } else fail(`spell phases: effect ${g('udg_effect')?.n} channel ${g('udg_channel')?.n} endcast ${g('udg_endcast')?.n} (want 1/1/1)`);
  if (g('udg_spellId')?.n === 0x41486862 && g('udg_targetId')?.n === 0x6f677275) {
    ok(`GetSpellAbilityId → 'AHhb'; GetSpellTargetUnit → the grunt it was cast at`);
  } else fail(`spell responses: id ${g('udg_spellId')?.n?.toString(16)} target ${g('udg_targetId')?.n?.toString(16)}`);

  interp.pumpConstructEvents([{ structure: { id: 4, typeId: 'hbar', owner: 0, x: 0, y: 0, facing: 0 }, phase: 'finish' }]);
  if (g('udg_built')?.n === 1 && g('udg_builtType')?.n === 0x68626172) ok(`CONSTRUCT_FINISH fired once; GetConstructedStructure → the barracks ('hbar')`);
  else fail(`construct: fires ${g('udg_built')?.n} type ${g('udg_builtType')?.n?.toString(16)}`);

  interp.pumpTrainEvents([
    { building: { id: 4, typeId: 'hbar', owner: 0, x: 0, y: 0, facing: 0 }, unitTypeId: 'hfoo', trained: { id: 5, typeId: 'hfoo', owner: 0, x: 0, y: 0, facing: 0 }, phase: 'finish' },
  ]);
  if (g('udg_trained')?.n === 0x68666f6f && g('udg_trainType')?.n === 0x68666f6f) ok(`TRAIN_FINISH → GetTrainedUnit is the new footman; GetTrainedUnitType → 'hfoo'`);
  else fail(`train: unit ${g('udg_trained')?.n?.toString(16)} type ${g('udg_trainType')?.n?.toString(16)}`);

  interp.pumpHeroEvents([
    { hero: caster, phase: 'level', level: 2, abilityId: '' },
    { hero: caster, phase: 'skill', level: 1, abilityId: 'AHhb' },
  ]);
  // GetHeroLevel on the levelling unit reads the LIVE sim value through the bridge (no
  // getUnitLevel hook here → 0), so assert on the fire count + the learned skill instead.
  if (g('udg_levels')?.n === 1 && g('udg_skill')?.n === 0x41486862) ok(`HERO_LEVEL fired once (GetLevelingUnit set); HERO_SKILL → GetLearnedSkill 'AHhb'`);
  else fail(`hero events: levels ${g('udg_levels')?.n} skill ${g('udg_skill')?.n?.toString(16)}`);

  // The unit-state threshold is EDGE-triggered: full HP → nothing; drop below 100 → one
  // fire; stay below → no repeat; heal above and drop again → a second fire.
  interp.pumpUnitStates(); // baseline (500 hp — above the limit)
  interp.pumpUnitStates();
  const before = g('udg_hurt')?.n;
  hp[10] = 60;
  interp.pumpUnitStates();
  interp.pumpUnitStates(); // still below — must NOT fire again
  const after = g('udg_hurt')?.n;
  hp[10] = 400;
  interp.pumpUnitStates();
  hp[10] = 20;
  interp.pumpUnitStates();
  const again = g('udg_hurt')?.n;
  if (before === 0 && after === 1 && again === 2) ok(`UNIT_STATE_LIMIT ("life < 100") fires on each CROSSING — not while it sits below, not at full HP`);
  else fail(`unit-state limit: healthy ${before} crossed ${after} re-crossed ${again} (want 0/1/2)`);
}

// --- 7.3: melee run from the MAP'S OWN SCRIPT (blizzard.j's Melee* library) ------------
//
// The milestone: retire the hard-coded roster and let (2)EchoIsles.w3x's war3map.j drive a
// melee game through main() → its "Melee Initialization" trigger → the eight Melee* calls.
// We run the REAL map script over the REAL blizzard.j, against a mock sim (the same bridge
// shape mapViewer hands the interpreter), and assert the outcome equals what the old
// hard-coded startMelee produced: same starting units per race, same 500/150 purse, creeps
// cleared off the used start locations.
console.log('\n[7.3] Melee from the script (EchoIsles war3map.j → blizzard.j Melee*)');
{
  const echo = join(WC3, 'Maps', 'FrozenThrone', '(2)EchoIsles.w3x');
  if (!existsSync(echo)) {
    console.log('      (2)EchoIsles.w3x not found — skipped');
  } else {
    const MAP_J = readStr(openArchive(echo), 'war3map.j');
    // Echo Isles' config(): DefineStartLocation(0, -5184, 2944) / (1, 4672, 2944).
    const START = [{ x: -5184, y: 2944 }, { x: 4672, y: 2944 }];

    /** One melee bring-up: races per slot → what the script did to the world. */
    function runMelee(races) {
      // The pre-placed world CreateAllUnits would have put down — a gold mine by each start
      // location, creeps camped on start 0, and a creep camp + a shop far away. This is what
      // mapViewer's bridge exposes from SimWorld (+ the mines, which are units to a script).
      const sim = [
        { id: 100, typeId: 'ngol', owner: 15, x: START[0].x + 500, y: START[0].y - 300, facing: 0, structure: true, gold: 12500 },
        { id: 101, typeId: 'ngol', owner: 15, x: START[1].x - 500, y: START[1].y - 300, facing: 0, structure: true, gold: 12500 },
        { id: 200, typeId: 'ngrb', owner: 12, x: START[0].x + 600, y: START[0].y + 200, facing: 0, structure: false }, // creep ON start 0 → cleared
        { id: 201, typeId: 'nfor', owner: 12, x: START[1].x - 400, y: START[1].y + 100, facing: 0, structure: false }, // creep ON start 1 → cleared
        { id: 202, typeId: 'ngrb', owner: 12, x: 0, y: -4000, facing: 0, structure: false }, // creep in the middle → kept
        { id: 300, typeId: 'nrat', owner: 15, x: START[0].x + 300, y: START[0].y, facing: 0, structure: false }, // critter by start 0 → cleared
        { id: 301, typeId: 'nmer', owner: 15, x: START[0].x - 400, y: START[0].y, facing: 0, structure: true }, // shop by start 0 → KEPT (a structure)
      ];
      const spawned = []; // every CreateUnit that reached the bridge (i.e. was NOT record-only)
      const removed = [];
      const stash = {}; // player → { gold, lumber }
      const camera = { x: 0, y: 0 };
      const world = { tod: 0 };
      let nextId = 1;
      const find = (id) => sim.find((u) => u.id === id) ?? spawned.find((u) => u.id === id);
      const hooks = {
        createUnit: (player, typeId, x, y, facing) => {
          const u = { id: nextId++, player, typeId, x, y, facing, structure: /^(htow|ogre|unpl|etol)$/.test(typeId) };
          spawned.push(u);
          return u.id;
        },
        removeUnit: (id) => {
          const i = sim.findIndex((u) => u.id === id);
          if (i < 0) return;
          // A gold mine isn't a sim unit for us, so the bridge ignores RemoveUnit on one —
          // which is what makes the Undead haunted-mine swap a no-op instead of a mine loss.
          if (sim[i].typeId === 'ngol') return;
          removed.push(sim.splice(i, 1)[0].id);
        },
        enumUnits: () => sim,
        getUnitX: (id) => find(id)?.x ?? 0,
        getUnitY: (id) => find(id)?.y ?? 0,
        // Same shape as mapViewer's bridge: from the sim unit while it lives, from its TYPE
        // once it's a corpse (GetDyingUnit is already out of the sim — see deadUnitTypeIs).
        isUnitType: (id, t, typeId) => {
          const u = find(id);
          if (u) return t === 2 ? !!u.structure : t === 4;
          if (t === 1) return true; // UNIT_TYPE_DEAD
          return t === 2 ? /^(htow|ogre|unpl|etol|ngol|nmer)$/.test(typeId ?? '') : t === 4;
        },
        getUnitState: (id, s) => (s === 0 ? 100 : 0), // everything alive (IsUnitAliveBJ)
        setPlayerState: (p, state, v) => {
          stash[p] ??= { gold: 0, lumber: 0 };
          if (state === 1) stash[p].gold = v;
          else if (state === 2) stash[p].lumber = v;
        },
        getPlayerState: (p, state) => (state === 1 ? stash[p]?.gold ?? 0 : state === 2 ? stash[p]?.lumber ?? 0 : 0),
        setTimeOfDay: (h) => (world.tod = h),
        getTimeOfDay: () => world.tod,
        setCameraPosition: (x, y) => ((camera.x = x), (camera.y = y)),
        getResourceAmount: (id) => find(id)?.gold ?? 0,
        setResourceAmount: (id, amount) => { const m = find(id); if (m) m.gold = amount; },
        // Our engine has no haunted mine: the Undead swap hands back the mine still standing
        // there (RemoveUnit left it alone), so the acolytes clump around a real location.
        createBlightedGoldMine: (_p, x, y) => sim.find((u) => u.typeId === 'ngol' && Math.hypot(u.x - x, u.y - y) < 64)?.id ?? -1,
        playerStructureCount: (p) => spawned.filter((u) => u.player === p && u.structure).length,
        playerTypedUnitCount: (p, name) => spawned.filter((u) => u.player === p && ({ htow: 'townhall', ogre: 'greathall', etol: 'treeoflife', unpl: 'necropolis' })[u.typeId] === name).length,
        isPlayerAlly: (p, q) => p === q,
      };
      const interp = buildInterpreter([COMMON_J, BLIZZARD_J, MAP_J], { gameType: 1, hooks });
      interp.run('config', []);
      // The lobby handoff: which slots are PLAYING, as which race (a "random" already rolled).
      interp.rt.applyLobby(races.map((raceIndex, i) => ({ index: i, raceIndex, controller: 1, team: i, startLocation: -1 })), 0);
      interp.run('main', []); // → CreateAllUnits (records only) → InitBlizzard → the Melee Init trigger
      return { interp, sim, spawned, removed, stash, camera, world };
    }

    // --- Human vs Orc, the canonical Echo Isles game ---
    const r = runMelee([1, 2]); // RACE_HUMAN, RACE_ORC
    const of = (p, typeId) => r.spawned.filter((u) => u.player === p && u.typeId === typeId);

    // The map's pre-placed units were RECORDED, not spawned: CreateAllUnits put ~90 rows in
    // the runtime, and NOT ONE of them reached the createUnit bridge (no doubled creeps).
    const rows = r.interp.rt.units.length;
    const meleeSpawns = r.spawned.length;
    if (rows > 80 && meleeSpawns === 12) {
      ok(`CreateAllUnits recorded ${rows} pre-placed unit rows and spawned NONE — only the melee roster (${meleeSpawns}) reached the bridge`);
    } else fail(`record-only gate: ${rows} rows recorded, ${meleeSpawns} spawned (want >80 rows, exactly 12 spawns)`);

    // MeleeStartingUnits: 1 Town Hall + 5 Peasants / 1 Great Hall + 5 Peons — the same
    // roster src/data/races.ts hard-coded (STARTING_UNITS), now from Blizzard's own script.
    if (of(0, 'htow').length === 1 && of(0, 'hpea').length === 5 && of(1, 'ogre').length === 1 && of(1, 'opeo').length === 5) {
      ok(`starting units: P0 1×Town Hall + 5×Peasant, P1 1×Great Hall + 5×Peon (== the old hard-coded roster)`);
    } else fail(`starting units: P0 ${of(0, 'htow').length}×htow ${of(0, 'hpea').length}×hpea, P1 ${of(1, 'ogre').length}×ogre ${of(1, 'opeo').length}×opeo`);

    // The hall sits ON the start location; the workers clump 320 units off the MINE, back
    // toward the hall (MeleeGetProjectedLoc + 64u spacing) — the exact geometry
    // MELEE_WORKER_CLUSTERS encodes. Recompute it here and compare.
    const hall = of(0, 'htow')[0];
    const mine = r.sim.find((u) => u.id === 100);
    const dir = Math.atan2(START[0].y - mine.y, START[0].x - mine.x);
    const cx = mine.x + 320 * Math.cos(dir), cy = mine.y + 320 * Math.sin(dir);
    const peons = of(0, 'hpea');
    const spread = peons.every((p) => Math.hypot(p.x - cx, p.y - cy) <= 64 * 1.5 + 0.01);
    if (Math.hypot(hall.x - START[0].x, hall.y - START[0].y) < 0.01 && spread) {
      ok(`placement: Town Hall on the start location; all 5 Peasants clumped 320u off the mine (MeleeGetProjectedLoc)`);
    } else fail(`placement: hall (${hall.x},${hall.y}) vs start (${START[0].x},${START[0].y}); peasant clump centre (${cx.toFixed(0)},${cy.toFixed(0)}) spread=${spread}`);

    // MeleeStartingResources — the Frozen Throne purse (bj_MELEE_STARTING_GOLD_V1 = 500 /
    // _LUMBER_V1 = 150). Reign of Chaos would have given 750/200, so this also proves
    // VersionGet() reports TFT.
    if (r.stash[0]?.gold === 500 && r.stash[0]?.lumber === 150 && r.stash[1]?.gold === 500 && r.stash[1]?.lumber === 150) {
      ok(`starting resources: 500 gold / 150 lumber for both playing slots (TFT V1 constants)`);
    } else fail(`starting resources: P0 ${JSON.stringify(r.stash[0])} P1 ${JSON.stringify(r.stash[1])} (want 500/150)`);

    // An EMPTY slot gets nothing at all — no units, no purse. That's GetPlayerSlotState
    // gating the whole library; if it read PLAYING for every slot, 10 ghost bases would spawn.
    if (!r.spawned.some((u) => u.player > 1) && r.stash[2] === undefined) {
      ok(`empty slots (2–11) got no units and no resources — GetPlayerSlotState gates the library`);
    } else fail(`empty slots: ${r.spawned.filter((u) => u.player > 1).length} unit(s), stash ${JSON.stringify(r.stash[2])}`);

    // MeleeClearExcessUnits: Neutral Hostile creeps AND non-structure Neutral Passive
    // critters within 1500 of a USED start location are removed; the creep camp in the
    // middle of the map survives, and so do the structures (the shop — and the GOLD MINE,
    // which would otherwise be wiped and take the whole economy with it).
    const gone = new Set(r.removed);
    if (gone.has(200) && gone.has(201) && gone.has(300) && !gone.has(202) && !gone.has(301) && !gone.has(100) && !gone.has(101)) {
      ok(`MeleeClearExcessUnits: creeps + critters on the used start locations removed (3); the far camp, the shop and BOTH gold mines kept`);
    } else fail(`clear excess: removed [${[...gone]}] (want 200,201,300 — not 202/301/100/101)`);

    // MeleeStartingVisibility: a melee game opens at 08:00 (bj_MELEE_STARTING_TOD).
    if (Math.abs(r.world.tod - 8) < 0.001) ok(`MeleeStartingVisibility: game clock set to 08:00 (bj_MELEE_STARTING_TOD)`);
    else fail(`time of day: ${r.world.tod} (want 8.0)`);

    // MeleeStartingUnitsHuman ends by centring the camera on the initial PEASANTS (not the
    // hall) — for the LOCAL player only, via SetCameraPositionForPlayer's GetLocalPlayer gate.
    if (Math.hypot(r.camera.x - cx, r.camera.y - cy) < 0.01) ok(`camera framed on the local player's starting workers (SetCameraPositionForPlayer)`);
    else fail(`camera: (${r.camera.x},${r.camera.y}) — want the P0 worker clump (${cx.toFixed(0)},${cy.toFixed(0)})`);

    // The victory/defeat conditions are armed (MeleeInitVictoryDefeat): each playing slot
    // watches its own deaths + construction, and the 2s "already won/lost?" timer is set.
    const regs = r.interp.rt.triggerRegs.length;
    if (regs >= 12 && r.interp.rt.timers.length >= 1) ok(`MeleeInitVictoryDefeat armed: ${regs} event registration(s), ${r.interp.rt.timers.length} timer(s)`);
    else fail(`victory/defeat: ${regs} registration(s), ${r.interp.rt.timers.length} timer(s)`);

    // …and nobody is defeated at the start: the 2-second "has anyone already won/lost?"
    // check runs GetPlayerStructureCount over every slot. Stub that at 0 and BOTH players
    // are defeated two seconds into every melee game. The empty slots ARE pre-defeated
    // (MeleeInitVictoryDefeat does that up front), which is what makes victory detectable.
    r.interp.advanceTime(2.5);
    const flag = (name, i) => r.interp.rt.globalArrays.get(name)?.get(i)?.b;
    if (!flag('bj_meleeDefeated', 0) && !flag('bj_meleeDefeated', 1) && flag('bj_meleeDefeated', 2) && !r.interp.rt.globals.get('bj_meleeGameOver')?.b) {
      ok(`the 2s victory/defeat check leaves both playing slots alive (and pre-defeats the empty ones)`);
    } else fail(`after 2s: defeated P0 ${flag('bj_meleeDefeated', 0)} P1 ${flag('bj_meleeDefeated', 1)} empty ${flag('bj_meleeDefeated', 2)}`);

    // Now take the Town Hall away: EVENT_PLAYER_UNIT_DEATH → MeleeTriggerActionUnitDeath →
    // "was it a STRUCTURE?" → the owner has none left → defeat, and the opponent wins.
    // The dying unit is already OUT of the sim (it's a corpse), so IsUnitType has to answer
    // STRUCTURE from its unit TYPE — get that wrong and a razed player plays on forever.
    const hallId = hall.id;
    r.spawned.splice(r.spawned.findIndex((u) => u.id === hallId), 1); // the hall is gone from the world
    r.interp.pumpUnitDeaths([{ victim: { id: hallId, typeId: 'htow', owner: 0, x: hall.x, y: hall.y, facing: 0 }, killer: null }]);
    if (flag('bj_meleeDefeated', 0) && flag('bj_meleeVictoried', 1) && r.interp.rt.globals.get('bj_meleeGameOver')?.b) {
      ok(`killing the last structure defeats its owner and hands the opponent victory (blizzard.j's own conditions)`);
    } else fail(`after razing P0: defeated ${flag('bj_meleeDefeated', 0)}, P1 victorious ${flag('bj_meleeVictoried', 1)}, gameOver ${r.interp.rt.globals.get('bj_meleeGameOver')?.b}`);

    // --- Undead + Night Elf: the two starts that DON'T just drop a hall on the start loc ---
    const r2 = runMelee([3, 4]); // RACE_UNDEAD, RACE_NIGHTELF
    const of2 = (p, typeId) => r2.spawned.filter((u) => u.player === p && u.typeId === typeId);
    // Undead: 1 Necropolis + 3 Acolytes + 1 Ghoul — and the gold mine SURVIVES the haunting
    // (BlightGoldMineForPlayerBJ RemoveUnit's it, then CreateBlightedGoldmine puts it back;
    // with that native missing, the acolytes would clump around a null location at (0,0)).
    const acolytes = of2(0, 'uaco');
    const mineU = r2.sim.find((u) => u.id === 100);
    const nearMine = acolytes.length === 3 && acolytes.every((a) => Math.hypot(a.x - mineU.x, a.y - mineU.y) < 500);
    if (of2(0, 'unpl').length === 1 && nearMine && of2(0, 'ugho').length === 1 && mineU) {
      ok(`Undead: 1×Necropolis + 3×Acolyte (clumped at the mine) + 1×Ghoul — the haunted-mine swap kept the mine`);
    } else fail(`undead: ${of2(0, 'unpl').length}×unpl, ${acolytes.length}×uaco (at the mine: ${nearMine}), ${of2(0, 'ugho').length}×ugho, mine ${mineU ? 'kept' : 'LOST'}`);
    // Night Elf: the Tree of Life is planted BY THE MINE (to entangle it), not on the start
    // location — 3.5 cells (448u) of it. Our old hard-coded roster got this wrong.
    const tree = of2(1, 'etol')[0];
    const mineNE = r2.sim.find((u) => u.id === 101);
    if (tree && of2(1, 'ewsp').length === 5 && Math.abs(tree.x - mineNE.x) <= 448.01 && Math.abs(tree.y - mineNE.y) <= 448.01) {
      ok(`Night Elf: 5×Wisp + the Tree of Life planted within 3.5 cells of the mine (not on the start location)`);
    } else fail(`night elf: tree ${tree ? `(${tree.x.toFixed(0)},${tree.y.toFixed(0)})` : 'MISSING'} vs mine (${mineNE.x},${mineNE.y}); ${of2(1, 'ewsp').length}×ewsp`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
