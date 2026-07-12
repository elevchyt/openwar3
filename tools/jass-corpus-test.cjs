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

// --- 7.18: items — the trigger surface + the item events ------------------
// Everything runs through the REAL blizzard.j BJs the World Editor emits (the GUI's
// "Hero - Create item and give", "Hero - Drop item", "Hero - Use item", "Item - Pick
// random item"), so this exercises the native layer the way a map actually reaches it.
//
// The mock item world below mirrors SimWorld's item rules, and the one that matters most
// is IDENTITY: an item keeps its entity id when it moves between the ground and an
// inventory, so the handle CreateItem returned is the same handle GetManipulatedItem
// hands a PICKUP trigger. Get that wrong and every "what did they just pick up?" trigger
// in the wild silently compares two different handles for the same item.
console.log('\n[7.18] Item natives (CreateItem / UnitAddItem / drop / use / charges / ChooseRandomItemEx)');
{
  // A tiny item world: ground items + per-unit inventories, sharing ONE id space.
  const ITEM_TYPES = {
    phea: { name: 'Potion of Healing', level: 1, classType: 'Charged', charges: 1, powerup: false, sellable: true, pawnable: true },
    stwp: { name: 'Scroll of Town Portal', level: 2, classType: 'Purchasable', charges: 1, powerup: false, sellable: true, pawnable: true },
    ratf: { name: 'Claws of Attack +15', level: 6, classType: 'Permanent', charges: 0, powerup: false, sellable: true, pawnable: true },
    tkno: { name: 'Tome of Knowledge', level: 2, classType: 'PowerUp', charges: 1, powerup: true, sellable: true, pawnable: false },
  };
  const RANDOM_POOL = [ // what ChooseRandomItemEx draws from (droppable + pickRandom items)
    { id: 'ratf', level: 6, classType: 'Permanent' },
    { id: 'rde1', level: 6, classType: 'Permanent' },
    { id: 'phea', level: 1, classType: 'Charged' },
  ];
  const HERO = 10, ALLY = 11;
  const w = {
    items: new Map(), // id → { id, typeId, charges, x, y } (on the ground)
    inv: new Map([[HERO, new Array(6).fill(null)], [ALLY, new Array(6).fill(null)]]), // unit → slots of item ids
    pos: new Map([[HERO, [500, 500]], [ALLY, [700, 500]]]),
    next: 1,
    used: [], // { unit, item } — every UnitUseItem that fired
  };
  const held = (id) => {
    for (const [unit, slots] of w.inv) {
      const slot = slots.findIndex((s) => s && s.id === id);
      if (slot >= 0) return { unit, slot, rec: slots[slot] };
    }
    return null;
  };
  const hooks = {
    createUnit: () => HERO,
    getUnitX: (u) => w.pos.get(u)?.[0] ?? 0,
    getUnitY: (u) => w.pos.get(u)?.[1] ?? 0,
    createItem: (typeId, x, y) => {
      const t = ITEM_TYPES[typeId];
      if (!t) return -1;
      const it = { id: w.next++, typeId, charges: t.charges, x, y };
      w.items.set(it.id, it);
      return it.id;
    },
    removeItem: (id) => {
      if (!w.items.delete(id)) {
        const h = held(id);
        if (h) w.inv.get(h.unit)[h.slot] = null;
      }
    },
    itemInfo: (id) => {
      const g = w.items.get(id);
      if (g) return { ...g, holder: 0, slot: -1, owner: 15 };
      const h = held(id);
      if (!h) return null;
      const [x, y] = w.pos.get(h.unit);
      return { id, typeId: h.rec.typeId, charges: h.rec.charges, x, y, holder: h.unit, slot: h.slot, owner: 0 };
    },
    itemTypeInfo: (typeId) => ITEM_TYPES[typeId] ?? null,
    setItemCharges: (id, n) => {
      const g = w.items.get(id);
      if (g) g.charges = n;
      else if (held(id)) held(id).rec.charges = n;
    },
    setItemPosition: (id, x, y) => {
      const g = w.items.get(id);
      if (g) { g.x = x; g.y = y; return; }
      const h = held(id); // WC3: positioning a CARRIED item drops it there
      if (h) { w.inv.get(h.unit)[h.slot] = null; w.items.set(id, { ...h.rec, x, y }); }
    },
    // Identity is preserved: the ground item BECOMES the held record, same id. A requested
    // slot is exact (UnitAddItemToSlotById fails on a taken slot); -1 = first free.
    unitAddItem: (unitId, itemId, want) => {
      const slots = w.inv.get(unitId);
      const g = w.items.get(itemId);
      if (!slots || !g) return false;
      const slot = want >= 0 ? (!slots[want] ? want : -1) : slots.indexOf(null);
      if (slot < 0) return false; // full / slot taken — the item stays on the ground
      slots[slot] = { id: g.id, typeId: g.typeId, charges: g.charges };
      w.items.delete(g.id);
      return true;
    },
    unitRemoveItem: (unitId, itemId) => {
      const h = held(itemId);
      if (!h || h.unit !== unitId) return false;
      const [x, y] = w.pos.get(unitId);
      w.inv.get(unitId)[h.slot] = null;
      w.items.set(itemId, { ...h.rec, x, y });
      return true;
    },
    unitRemoveItemFromSlot: (unitId, slot) => {
      const rec = w.inv.get(unitId)?.[slot];
      if (!rec) return 0;
      const [x, y] = w.pos.get(unitId);
      w.inv.get(unitId)[slot] = null;
      w.items.set(rec.id, { ...rec, x, y });
      return rec.id;
    },
    unitDropItemPoint: (unitId, itemId, x, y) => {
      const h = held(itemId);
      if (!h || h.unit !== unitId) return false;
      w.inv.get(unitId)[h.slot] = null;
      w.items.set(itemId, { ...h.rec, x, y });
      return true;
    },
    unitDropItemSlot: (unitId, itemId, slot) => { // MOVES it within the inventory
      const h = held(itemId);
      const slots = w.inv.get(unitId);
      if (!h || h.unit !== unitId || !slots || slot < 0 || slot >= slots.length) return false;
      const tmp = slots[slot];
      slots[slot] = h.rec;
      slots[h.slot] = tmp;
      return true;
    },
    unitDropItemTarget: (unitId, itemId, targetId) => {
      const h = held(itemId);
      const to = w.inv.get(targetId);
      if (!h || h.unit !== unitId || !to) return false;
      const free = to.indexOf(null);
      if (free < 0) return false;
      to[free] = h.rec;
      w.inv.get(unitId)[h.slot] = null;
      return true;
    },
    unitUseItem: (unitId, itemId, _t, _x, _y) => {
      const h = held(itemId);
      if (!h || h.unit !== unitId || h.rec.charges <= 0) return false;
      h.rec.charges -= 1;
      w.used.push({ unit: unitId, item: itemId });
      if (h.rec.charges <= 0) w.inv.get(unitId)[h.slot] = null; // perishable: gone at 0
      return true;
    },
    unitInventorySize: (unitId) => w.inv.get(unitId)?.length ?? 0,
    unitItemInSlot: (unitId, slot) => w.inv.get(unitId)?.[slot]?.id ?? 0,
    enumItems: () => [...w.items.values()].map((it) => ({ ...it, holder: 0, slot: -1, owner: 15 })),
    chooseRandomItem: (cls, level) => {
      const pool = RANDOM_POOL.filter((d) => (level < 0 || d.level === level) && (!cls || d.classType === cls));
      return pool.length ? pool[0].id : '';
    },
  };
  const SRC = `
globals
    item    udg_potion   = null
    item    udg_claws    = null
    integer udg_typeId   = 0
    integer udg_charges  = 0
    integer udg_invIndex = 0
    boolean udg_hasIt    = false
    boolean udg_sameOne  = false
    integer udg_invSize  = 0
    real    udg_dropX    = 0.0
    integer udg_ground   = 0
    integer udg_randPerm = 0
    integer udg_randAny  = 0
    integer udg_dist     = 0
    boolean udg_slotFail = false
endglobals
function RunItems takes nothing returns nothing
    local unit h = CreateUnit( Player(0), 'Hpal', 500.0, 500.0, 0.0 )
    local item ground

    // The GUI's "Hero - Create item and give": blizzard.j creates the item AT the hero,
    // then UnitAddItem's it — so a full inventory leaves it lying at his feet.
    set udg_potion  = UnitAddItemByIdSwapped( 'phea', h )
    set udg_typeId  = GetItemTypeId( udg_potion )
    set udg_hasIt   = UnitHasItem( h, udg_potion )
    set udg_invSize = UnitInventorySize( h )
    // "Inventory index of item-type" — the BJ walks UnitItemInSlot + GetItemTypeId (1-based).
    set udg_invIndex = GetInventoryIndexOfItemTypeBJ( h, 'phea' )
    set udg_sameOne  = ( UnitItemInSlotBJ( h, 1 ) == udg_potion )   // one item = one handle

    // Charges: read, then hand one back (the classic "make it infinite" idiom).
    call SetItemCharges( udg_potion, 3 )
    set udg_charges = GetItemCharges( udg_potion )

    // A second item, then move it to slot 3 (UnitDropItemSlot MOVES, it doesn't drop).
    set udg_claws = UnitAddItemByIdSwapped( 'ratf', h )
    call UnitDropItemSlotBJ( h, udg_claws, 3 )
    set udg_slotFail = UnitAddItemToSlotById( h, 'stwp', 0 )        // slot 0 is taken → false

    // Drop the potion at a point (instant, as a trigger's drop is), then check it's really
    // on the ground there — and that a rect enumeration finds it.
    call UnitDropItemPointBJ( h, udg_potion, 900.0, 500.0 )
    set udg_dropX = GetItemX( udg_potion )
    set ground = RandomItemInRectSimpleBJ( Rect(800.0, 400.0, 1000.0, 600.0) )
    if ground == udg_potion then
        set udg_ground = 1
    endif

    // Random item pools: ChooseRandomItemExBJ(level, type) → an item TYPE id.
    set udg_randPerm = ChooseRandomItemExBJ( 6, ITEM_TYPE_PERMANENT )
    set udg_randAny  = ChooseRandomItemBJ( 1 )

    // The RandomDist* distribution (pure blizzard.j, riding on GetRandomInt).
    call RandomDistReset(  )
    call RandomDistAddItem( 'ratf', 100 )
    set udg_dist = RandomDistChoose(  )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('RunItems', []);
  const g = (n) => interp.rt.globals.get(n);
  const rawcode = (s) => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0);

  if (g('udg_typeId')?.n === rawcode('phea') && g('udg_hasIt')?.b === true && g('udg_invSize')?.n === 6) {
    ok(`UnitAddItemByIdSwapped → the hero holds a 'phea' (UnitHasItem true, inventory 6 slots)`);
  } else fail(`give item: typeId ${g('udg_typeId')?.n} has ${g('udg_hasIt')?.b} size ${g('udg_invSize')?.n}`);
  if (g('udg_invIndex')?.n === 1 && g('udg_sameOne')?.b === true) {
    ok(`GetInventoryIndexOfItemTypeBJ → slot 1, and UnitItemInSlot returns the SAME handle CreateItem did (one item = one handle)`);
  } else fail(`inventory index ${g('udg_invIndex')?.n} (want 1), same handle ${g('udg_sameOne')?.b}`);
  if (g('udg_charges')?.n === 3) ok(`SetItemCharges / GetItemCharges round-trip → 3`);
  else fail(`charges ${g('udg_charges')?.n} (want 3)`);
  // The claws moved to slot 3 (0-based 2); the potion is still in slot 0 — so adding to
  // slot 0 must fail, and no stray item may be left on the ground by that attempt.
  const clawSlot = w.inv.get(HERO).findIndex((s) => s && s.typeId === 'ratf');
  if (clawSlot === 2 && g('udg_slotFail')?.b === false && ![...w.items.values()].some((i) => i.typeId === 'stwp')) {
    ok(`UnitDropItemSlotBJ moved the claws to slot 3 (not dropped); UnitAddItemToSlotById into a TAKEN slot → false, no stray item created`);
  } else fail(`slot move: claws at ${clawSlot} (want 2), toSlot ${g('udg_slotFail')?.b} (want false)`);
  const potionOnGround = [...w.items.values()].find((i) => i.typeId === 'phea');
  if (Math.abs((g('udg_dropX')?.n ?? 0) - 900) < 0.01 && potionOnGround && g('udg_ground')?.n === 1) {
    ok(`UnitDropItemPointBJ put the potion on the ground at (900,500); EnumItemsInRect found it there (RandomItemInRectSimpleBJ)`);
  } else fail(`drop: x ${g('udg_dropX')?.n} onGround ${!!potionOnGround} enum ${g('udg_ground')?.n}`);
  if (g('udg_randPerm')?.n === rawcode('ratf') && g('udg_randAny')?.n === rawcode('phea') && g('udg_dist')?.n === rawcode('ratf')) {
    ok(`ChooseRandomItemExBJ(6, PERMANENT) → 'ratf'; ChooseRandomItemBJ(1) → 'phea'; the RandomDist* distribution picks through it`);
  } else fail(`random: perm ${g('udg_randPerm')?.n} any ${g('udg_randAny')?.n} dist ${g('udg_dist')?.n}`);
}

console.log('\n[7.18] Item events (PICKUP / DROP / USE, owner-matched, GetManipulatedItem)');
{
  const hooks = {
    createUnit: () => 10,
    getUnitX: () => 500,
    getUnitY: () => 500,
    createItem: () => 7, // the one item in this world (entity id 7)
    itemInfo: (id) => (id === 7 ? { id: 7, typeId: 'phea', charges: 1, x: 500, y: 500, holder: 0, slot: -1, owner: 15 } : null),
    itemTypeInfo: () => ({ name: 'Potion of Healing', level: 1, classType: 'Charged', powerup: false, sellable: true, pawnable: true }),
    unitAddItem: () => true,
  };
  const SRC = `
globals
    item    udg_made     = null
    integer udg_picked   = 0
    integer udg_dropped  = 0
    integer udg_usedCnt  = 0
    integer udg_pickType = 0
    boolean udg_sameItem = false
    integer udg_enemyHit = 0
endglobals
function OnPickup takes nothing returns nothing
    set udg_picked   = udg_picked + 1
    set udg_pickType = GetItemTypeId( GetManipulatedItem() )
    // The crux: the item the trigger CREATED is the item the event reports.
    if GetManipulatedItem() == udg_made and GetManipulatingUnit() == GetTriggerUnit() then
        set udg_sameItem = true
    endif
endfunction
function OnDrop takes nothing returns nothing
    set udg_dropped = udg_dropped + 1
endfunction
function OnUse takes nothing returns nothing
    set udg_usedCnt = udg_usedCnt + 1
endfunction
function OnEnemyPickup takes nothing returns nothing
    set udg_enemyHit = udg_enemyHit + 1
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    set udg_made = CreateItem( 'phea', 500.0, 500.0 )
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_PICKUP_ITEM )
    call TriggerAddAction( t, function OnPickup )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_DROP_ITEM )
    call TriggerAddAction( t, function OnDrop )
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(0), EVENT_PLAYER_UNIT_USE_ITEM )
    call TriggerAddAction( t, function OnUse )
    // A second player's pickup trigger must NOT fire for player 0's hero.
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEventSimple( t, Player(1), EVENT_PLAYER_UNIT_PICKUP_ITEM )
    call TriggerAddAction( t, function OnEnemyPickup )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('Setup', []);
  const g = (n) => interp.rt.globals.get(n);
  const hero = { id: 10, typeId: 'Hpal', owner: 0, x: 500, y: 500, facing: 0 };
  const potion = { id: 7, typeId: 'phea', charges: 1 };
  interp.pumpItemEvents([
    { unit: hero, item: potion, phase: 'pickup' },
    { unit: hero, item: potion, phase: 'drop' },
    { unit: hero, item: potion, phase: 'use' },
  ]);
  const rawcode = (s) => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0);
  if (g('udg_picked')?.n === 1 && g('udg_dropped')?.n === 1 && g('udg_usedCnt')?.n === 1 && g('udg_enemyHit')?.n === 0) {
    ok(`PICKUP / DROP / USE each fired once for the owning player — and NOT for the other player's trigger`);
  } else fail(`item events: pickup ${g('udg_picked')?.n} drop ${g('udg_dropped')?.n} use ${g('udg_usedCnt')?.n} enemy ${g('udg_enemyHit')?.n} (want 1/1/1/0)`);
  if (g('udg_pickType')?.n === rawcode('phea') && g('udg_sameItem')?.b === true) {
    ok(`GetManipulatedItem() is the very item CreateItem returned ('phea'), and GetManipulatingUnit() == GetTriggerUnit()`);
  } else fail(`GetManipulatedItem: type ${g('udg_pickType')?.n} sameHandle ${g('udg_sameItem')?.b}`);

  // A consumed item (a tome vanishes the instant it's picked up) must STILL resolve in the
  // handler — the event carries a snapshot, exactly as GetDyingUnit does for a corpse.
  const tome = { id: 99, typeId: 'tkno', charges: 1 };
  interp.pumpItemEvents([{ unit: hero, item: tome, phase: 'pickup' }]);
  if (g('udg_pickType')?.n === rawcode('tkno') && g('udg_picked')?.n === 2) {
    ok(`a POWERUP consumed on pickup (tome) still reports its type — the event snapshots the item, so it outlives it`);
  } else fail(`consumed item: type ${g('udg_pickType')?.n} (want 'tkno'), fires ${g('udg_picked')?.n}`);
}

// --- 7.19: the trigger's on-screen output ---------------------------------
// Floating text, the victory/defeat dialogs, and leaderboards. Everything a trigger
// SAYS to the player. All three go through the real blizzard.j BJs — for the dialogs
// that matters more than usual, because WC3's "Victory!" screen is not a bespoke panel:
// it is a plain JASS `dialog` that MeleeVictoryDialogBJ fills in from the game's own
// string table. So we drive the real BJ and check what lands on screen.

// The game's own string table (UI\FrameDef\GlobalStrings.fdf) — the engine's
// GetLocalizedString reads it, and blizzard.j writes the whole end screen in its keys.
// Parsed here with a regex rather than our FDF library, so the check is independent of it.
const GLOBAL_STRINGS = (() => {
  const path = join(WC3, 'ExtractedData', 'merged', 'UI', 'FrameDef', 'GlobalStrings.fdf');
  const map = new Map();
  if (!existsSync(path)) return map;
  const src = readFileSync(path, 'latin1');
  for (const m of src.matchAll(/^\s*([A-Z0-9_]+)\s+"((?:[^"\\]|\\.)*)"/gm)) map.set(m[1], m[2]);
  return map;
})();

// --- the REAL UI\SoundInfo tables, for the sound-label hook (7.20) --------------------
// A sound LABEL lives in ONE namespace spanning every SoundInfo table, with nothing at the
// call site to say which one: "N03Tyrande01" is DialogSounds, "HeroDeathKnightPissed" is
// UnitAckSounds, "QuestCompleted" is UISounds. This mirrors SoundBoard.labelParams — same
// tables, same order — but reads the game's own extracted data, so the test asserts against
// the real rows rather than a fixture.
const SOUND_LABELS = (() => {
  const splitCsv = (line) => {
    const out = [];
    let cur = '', quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const tables = [];
  for (const name of ['UISounds', 'UnitAckSounds', 'AnimSounds', 'UnitCombatSounds', 'AbilitySounds', 'AmbienceSounds', 'DialogSounds']) {
    const path = join(WC3, 'ExtractedData', 'merged', 'UI', 'SoundInfo', `${name}.csv`);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'latin1').split(/\r?\n/).filter(Boolean);
    const head = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
    const rows = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsv(lines[i]);
      const rec = {};
      head.forEach((h, j) => { rec[h] = (cells[j] ?? '').trim(); });
      if (cells[0]?.trim()) rows.set(cells[0].trim().toLowerCase(), rec);
    }
    tables.push(rows);
  }
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  return (label) => {
    if (!label) return null;
    for (const rows of tables) {
      const r = rows.get(label.toLowerCase());
      if (!r) continue;
      const dir = r.directorybase ?? '';
      const files = (r.filenames ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((f) => (dir + f).replace(/\//g, '\\'));
      if (!files.length) continue;
      return {
        files,
        volume: num(r.volume, 127),
        pitch: num(r.pitch, 1),
        channel: num(r.channel, 0),
        threeD: /WANT3D/i.test(r.flags ?? ''),
        minDist: num(r.mindistance, 0),
        maxDist: num(r.maxdistance, 0),
        cutoff: num(r.distancecutoff, 0),
      };
    }
    return null;
  };
})();

console.log('\n[7.19] Floating text (CreateTextTag: size/velocity/lifespan/fadepoint, permanence, expiry)');
{
  // The GUI's "Floating Text - Create floating text" + the setters every damage-number
  // snippet in the wild reaches for. Sizes and speeds go through blizzard.j's own scaling
  // (TextTagSize2Height: size 10 → 0.023; TextTagSpeed2Velocity: speed 128 → 0.071).
  const SRC = `
globals
    texttag udg_tag = null
    texttag udg_forever = null
endglobals
function Setup takes nothing returns nothing
    // "+15 gold" over a creep at (512, 256): rise at speed 64, live 3s, fade from 2s.
    set udg_tag = CreateTextTagLocBJ( "|cffffcc00+15 gold|r", Location(512, 256), 90, 10, 100, 80, 0, 0 )
    call SetTextTagVelocityBJ( udg_tag, 64, 90 )
    call SetTextTagPermanentBJ( udg_tag, false )
    call SetTextTagLifespanBJ( udg_tag, 3.0 )
    call SetTextTagFadepointBJ( udg_tag, 2.0 )
    // A second tag with nothing but text: WC3 leaves this one on screen forever.
    set udg_forever = CreateTextTag()
    call SetTextTagTextBJ( udg_forever, "Creep Camp Cleared", 10 )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
  interp.run('Setup', []);
  const rt = interp.rt;
  const tag = rt.textTags[0];
  const forever = rt.textTags[1];

  const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
  if (tag && near(tag.size, 0.023) && tag.x === 512 && tag.y === 256 && tag.z === 90) {
    ok(`CreateTextTagLocBJ → world anchor (512, 256, z 90); font size 10 → height 0.023 (TextTagSize2Height)`);
  } else fail(`text tag: size ${tag?.size} pos (${tag?.x}, ${tag?.y}, ${tag?.z})`);

  // SetTextTagVelocityBJ(64, 90°) → straight up the SCREEN at 64 * 0.071/128 = 0.0355/s.
  if (tag && near(tag.velX, 0) && near(tag.velY, 0.0355)) {
    ok(`SetTextTagVelocityBJ(speed 64, angle 90°) → screen-relative velocity (0, 0.0355) — TextTagSpeed2Velocity`);
  } else fail(`velocity: (${tag?.velX}, ${tag?.velY}) — want (0, 0.0355)`);

  if (forever && forever.permanent === true && tag.permanent === false && tag.lifespan === 3 && tag.fadepoint === 2) {
    ok(`a fresh tag is PERMANENT by default (the classic floating-text leak); lifespan 3.0 / fadepoint 2.0 only bite once permanence is cleared`);
  } else fail(`permanence: fresh ${forever?.permanent} (want true), configured ${tag?.permanent} life ${tag?.lifespan} fade ${tag?.fadepoint}`);

  // Age it on GAME time (advanceTime is the same sim-tick pump the timers ride).
  interp.advanceTime(1.0);
  if (near(tag.age, 1.0) && near(tag.offsetY, 0.0355) && rt.textTags.length === 2) {
    ok(`after 1.0 s of game time the tag has drifted 0.0355 up the screen and is still alive`);
  } else fail(`drift: age ${tag.age} offsetY ${tag.offsetY} live ${rt.textTags.length}`);

  interp.advanceTime(2.5); // total 3.5 s > its 3.0 s lifespan
  if (tag.dead === true && rt.textTags.length === 1 && rt.textTags[0] === forever) {
    ok(`the timed tag expires at its lifespan and is dropped; the PERMANENT one is untouched`);
  } else fail(`expiry: dead ${tag.dead}, ${rt.textTags.length} tag(s) left`);

  interp.run('Setup', []); // a fresh pair, to destroy explicitly
  const before = rt.textTags.length;
  interp.rt.destroyTextTag(rt.textTags[before - 1]);
  if (rt.textTags.length === before - 1) {
    ok(`DestroyTextTag unlinks the tag (the renderer drops it on the next frame)`);
  } else fail(`DestroyTextTag left ${rt.textTags.length} of ${before}`);
}

console.log('\n[7.19] Victory / defeat dialogs (the REAL MeleeVictoryDialogBJ / MeleeDefeatDialogBJ)');
{
  const sounds = [];
  const messages = [];
  const hooks = {
    // The engine's string table. This is the whole reason the dialog reads "Victory!"
    // rather than "GAMEOVER_VICTORY_MSG".
    localizedString: (key) => GLOBAL_STRINGS.get(key),
    // The win/lose sting is a plain `sound` handle: bj_victoryDialogSound =
    // CreateSoundFromLabel("QuestCompleted", …) → StartSound. 7.20 generalised it, so it
    // now resolves its file out of the real UISounds.slk like any other labelled sound.
    soundLabelInfo: (label) => SOUND_LABELS(label),
    playSound: (s) => (sounds.push(s.label), true),
    displayText: (p, msg) => messages.push(msg),
    playerStructureCount: () => 1,
    playerTypedUnitCount: () => 1,
  };
  const SRC = `
globals
    integer udg_clicks = 0
    integer udg_wasQuit = 0
    dialog  udg_own = null
endglobals
function OnButton takes nothing returns nothing
    set udg_clicks = udg_clicks + 1
    if (GetClickedDialog() == udg_own) then
        set udg_wasQuit = 1
    endif
endfunction
function Victory takes nothing returns nothing
    call InitBlizzardGlobals()               // sets bj_victoryDialogSound = "QuestCompleted"
    call SetPlayerName( Player(0), "Elev" )
    call MeleeVictoryDialogBJ( Player(0), false )
endfunction
function DefeatOther takes nothing returns nothing
    call MeleeDoDefeat( Player(1) )          // the real defeat path: → RemovePlayerPreserveUnitsBJ
endfunction
function DefeatLocal takes nothing returns nothing
    call MeleeDoDefeat( Player(0) )
endfunction
// A script's OWN dialog, the way the GUI builds one (DialogAddButtonBJ →
// bj_lastCreatedButton), with a trigger on its button.
function OwnDialog takes nothing returns nothing
    local trigger t = CreateTrigger()
    set udg_own = DialogCreate()
    call DialogSetMessage( udg_own, "Choose a mode" )
    call TriggerRegisterDialogButtonEvent( t, DialogAddButtonBJ( udg_own, "Normal" ) )
    call TriggerAddAction( t, function OnButton )
    call DialogDisplay( Player(0), udg_own, true )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('Victory', []);
  const rt = interp.rt;
  const d = rt.dialogs[0];
  // GlobalStrings marks a button's accelerator by colouring that letter white, so the
  // label arrives with WC3 markup: "|CFFFFFFFFQ|Ruit Game". Strip it to read the words.
  const plain = (s) => (s ?? '').replace(/\|[cC][0-9a-fA-F]{8}|\|[rRnN]/g, '');

  if (d && d.message === 'Victory!' && GLOBAL_STRINGS.get('GAMEOVER_VICTORY_MSG') === 'Victory!') {
    ok(`MeleeVictoryDialogBJ → a dialog reading "Victory!" (GetLocalizedString("GAMEOVER_VICTORY_MSG") off the game's own GlobalStrings.fdf)`);
  } else fail(`victory dialog message: ${JSON.stringify(d?.message)}`);

  const labels = (d?.buttons ?? []).map((b) => plain(b.text));
  const quitBtn = (d?.buttons ?? []).find((b) => b.quit);
  if (labels.join('|') === 'Continue Game|Quit Game' && quitBtn && quitBtn.doScoreScreen === true) {
    ok(`its buttons are "Continue Game" + a QUIT button ("Quit Game", doScoreScreen) — DialogAddQuitButton's quit flag is what ends the match`);
  } else fail(`victory buttons: ${JSON.stringify(labels)} quit=${!!quitBtn}`);

  // The hotkey comes out of the string itself: GlobalStrings marks the accelerator by
  // colouring it white ("|CFFFFFFFFQ|Ruit Game" → Q).
  if (quitBtn && quitBtn.hotkey === 'Q'.charCodeAt(0)) {
    ok(`GetLocalizedHotkey("GAMEOVER_QUIT_GAME") → 'Q' (the letter GlobalStrings colours white)`);
  } else fail(`quit hotkey: ${quitBtn?.hotkey} (want ${'Q'.charCodeAt(0)})`);

  if (d && d.visibleFor.has(0) && sounds[0] === 'QuestCompleted') {
    ok(`DialogDisplay puts it up for the winning player, and bj_victoryDialogSound plays the game's own "QuestCompleted" sting`);
  } else fail(`display: visibleFor=${[...(d?.visibleFor ?? [])]} sounds=${JSON.stringify(sounds)}`);

  if (messages.some((m) => m === 'Elev was victorious.')) {
    ok(`DisplayTimedTextFromPlayer substitutes the player into PLAYER_VICTORIOUS ("%s was victorious.") — the subject, not the audience`);
  } else fail(`victory message: ${JSON.stringify(messages)}`);

  // A click runs the script's own dialog-button trigger, with GetClickedButton/Dialog in scope.
  interp.run('OwnDialog', []);
  const own = rt.dialogs.find((x) => x.message === 'Choose a mode');
  interp.fireDialogClick(own.buttons[0].handleId, own.handleId, 0);
  const g = (n) => interp.rt.globals.get(n);
  if (g('udg_clicks')?.n === 1 && g('udg_wasQuit')?.n === 1) {
    ok(`clicking a button fires the trigger registered on it (TriggerRegisterDialogButtonEvent), with GetClickedDialog resolving to the dialog`);
  } else fail(`dialog-button trigger fired ${g('udg_clicks')?.n} time(s), GetClickedDialog matched ${g('udg_wasQuit')?.n}`);
  // ...and only for THAT button — the victory dialog's quit button has its own trigger.
  interp.fireDialogClick(quitBtn.handleId, d.handleId, 0);
  if (g('udg_clicks')?.n === 1) {
    ok(`a click on a DIFFERENT dialog's button doesn't fire it — registrations are per-button`);
  } else fail(`cross-dialog click fired the wrong trigger (clicks now ${g('udg_clicks')?.n})`);

  // The defeat path, through the real MeleeDoDefeat → RemovePlayerPreserveUnitsBJ.
  interp.run('DefeatOther', []);
  const lost = rt.dialogs.find((x) => x.visibleFor.has(1));
  const defeated = interp.rt.globalArrays.get('bj_meleeDefeated')?.get(1);
  if (lost && lost.message === 'You failed to achieve victory.' && defeated?.b === true) {
    ok(`MeleeDoDefeat(Player(1)) → bj_meleeDefeated[1] and the "You failed to achieve victory." dialog`);
  } else fail(`defeat: msg ${JSON.stringify(lost?.message)} flag ${defeated?.b}`);

  // ...but the LOSING sting is the local player's, not everyone's: StartSoundForPlayerBJ
  // gates on GetLocalPlayer, so player 1's defeat is silent here and player 0's is not.
  if (!sounds.includes('QuestFailed')) {
    ok(`another player's defeat plays no sound locally (StartSoundForPlayerBJ gates on GetLocalPlayer)`);
  } else fail(`player 1's defeat sting leaked to the local player: ${JSON.stringify(sounds)}`);
  interp.run('DefeatLocal', []);
  if (sounds.includes('QuestFailed')) {
    ok(`the LOCAL player's defeat plays the game's own "QuestFailed" sting`);
  } else fail(`local defeat played no sound: ${JSON.stringify(sounds)}`);

  // The defeat dialog offers "Continue Observing" only when the map allows observers on
  // death (IsMapFlagSet(MAP_OBSERVERS_ON_DEATH)) — which we report false, so: quit only.
  if (lost && lost.buttons.length === 1 && lost.buttons[0].quit === true) {
    ok(`with no observers-on-death map flag, the defeat dialog offers only Quit — no "Continue Observing"`);
  } else fail(`defeat buttons: ${JSON.stringify((lost?.buttons ?? []).map((b) => plain(b.text)))}`);
}

console.log('\n[7.19] Leaderboards (CreateLeaderboardBJ / AddItem / SetPlayerItemValue / Sort — through blizzard.j)');
{
  // Exactly what a TD's "Kills" board compiles to in the GUI.
  const SRC = `
globals
    leaderboard udg_board = null
endglobals
function Setup takes nothing returns nothing
    call InitBlizzardGlobals()               // populates bj_FORCE_ALL_PLAYERS (GetPlayersAll)
    set udg_board = CreateLeaderboardBJ( GetPlayersAll(), "Creeps Killed" )
    call LeaderboardAddItemBJ( Player(0), udg_board, "Red", 3 )
    call LeaderboardAddItemBJ( Player(1), udg_board, "Blue", 11 )
    call LeaderboardAddItemBJ( Player(2), udg_board, "Teal", 7 )
endfunction
function Unlabel takes nothing returns nothing
    call LeaderboardSetLabelBJ( udg_board, "" )
endfunction
function Score takes nothing returns nothing
    // "Set the value for Player 1 to 12" — the workhorse of every scoreboard trigger.
    call LeaderboardSetPlayerItemValueBJ( Player(0), udg_board, 12 )
    call LeaderboardSortItemsByPlayerBJ( udg_board, true )
    call LeaderboardSortItemsBJ( udg_board, bj_SORTTYPE_SORTBYVALUE, false )
endfunction
function Kick takes nothing returns nothing
    call LeaderboardRemovePlayerItemBJ( Player(2), udg_board )
endfunction`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
  interp.run('Setup', []);
  const rt = interp.rt;
  const lb = rt.leaderboards[0];

  if (lb && lb.label === 'Creeps Killed' && lb.items.length === 3 && lb.displayed === true) {
    ok(`CreateLeaderboardBJ → a displayed board titled "Creeps Killed" with 3 rows`);
  } else fail(`board: label ${JSON.stringify(lb?.label)} rows ${lb?.items.length} shown ${lb?.displayed}`);

  // CreateLeaderboardBJ assigns the board to a FORCE (ForceSetLeaderboardBJ over
  // GetPlayersAll), so every player is looking at it — that is what puts it on screen.
  if (rt.leaderboardFor(0) === lb && rt.leaderboardFor(5) === lb) {
    ok(`ForceSetLeaderboardBJ assigned it to every player in the force — leaderboardFor(local) resolves it`);
  } else fail(`assignment: p0 ${!!rt.leaderboardFor(0)} p5 ${!!rt.leaderboardFor(5)}`);

  // LeaderboardResizeBJ's own (surprising) rule: size = item count, MINUS ONE when the
  // board has no label. So a titled board reserves a row per item, and an untitled one
  // reserves one fewer. Read straight off Blizzard.j — worth pinning, because guessing
  // "+1 for the title" would leave a titled board a row short.
  if (lb.rows === 3) {
    ok(`LeaderboardResizeBJ sized the titled board to its 3 items`);
  } else fail(`rows: ${lb.rows} (want 3)`);
  interp.run('Unlabel', []);
  if (lb.rows === 2 && lb.label === '') {
    ok(`...and to items−1 once the label is cleared — LeaderboardResizeBJ's "if label == '' then size = size - 1"`);
  } else fail(`unlabelled rows: ${lb.rows} (want 2)`);

  interp.run('Score', []);
  const order = lb.items.map((it) => `${it.label}:${it.value}`);
  if (order.join(' ') === 'Red:12 Blue:11 Teal:7') {
    ok(`SetPlayerItemValue(Red → 12) then sort by value DESCENDING → Red:12 Blue:11 Teal:7 (the row is keyed by PLAYER, not by index)`);
  } else fail(`sorted order: ${order.join(' ')}`);

  interp.run('Kick', []);
  if (lb.items.length === 2 && !lb.items.some((it) => it.player === 2)) {
    ok(`LeaderboardRemovePlayerItemBJ drops that player's row and re-sizes the board`);
  } else fail(`after remove: ${lb.items.length} rows`);
}

console.log('\n[7.20] The trigger\'s AUDIO output — sounds + music (through the REAL blizzard.j sound BJs)');
{
  // The engine side, recorded. `played` is what actually reached the SoundBoard.
  const played = [];
  const stopped = [];
  const music = [];
  const groups = new Map();
  const playing = new Set();
  const hooks = {
    soundLabelInfo: (label) => SOUND_LABELS(label),
    playSound: (s) => {
      played.push({ file: s.file, label: s.label, volume: s.volume, pitch: s.pitch, is3D: s.is3D,
        x: s.x, y: s.y, z: s.z, positioned: s.positioned, attach: s.attachUnit, looping: s.looping,
        cutoff: s.cutoff, minDist: s.minDist, maxDist: s.maxDist,
        coneInside: s.coneInside, coneOutsideVolume: s.coneOutsideVolume });
      playing.add(s.handleId);
      return true;
    },
    stopSound: (id, fadeOut) => { stopped.push({ id, fadeOut }); playing.delete(id); },
    soundIsPlaying: (id) => playing.has(id),
    setMapMusic: (name, random, index) => music.push({ call: 'setMap', name, random, index }),
    playMusic: (name, fromMs) => music.push({ call: 'play', name, fromMs }),
    stopMusic: (fadeOut) => music.push({ call: 'stop', fadeOut }),
    resumeMusic: () => music.push({ call: 'resume' }),
    playThematicMusic: (name, fromMs) => music.push({ call: 'thematic', name, fromMs }),
    endThematicMusic: () => music.push({ call: 'endThematic' }),
    setMusicVolume: (v) => music.push({ call: 'volume', v }),
    setVolumeGroup: (g, scale) => groups.set(g, scale),
    // The hero the sound attaches to (PlaySoundOnUnitBJ) — a live sim unit at (900, 300).
    createUnit: () => 77,
    getUnitX: (id) => (id === 77 ? 900 : 0),
    getUnitY: (id) => (id === 77 ? 300 : 0),
  };

  const SRC = `
globals
    sound   udg_pissed = null
    sound   udg_line   = null
    sound   udg_boom   = null
    unit    udg_hero   = null
    real    udg_dur    = 0.0
    boolean udg_before  = false
    boolean udg_after   = false
endglobals

// The InitSounds() every map with sounds emits — CreateSound with an EXACT file, then the
// label for its params, then the baked duration. All 27 bundled maps that ship a
// war3map.w3s emit exactly this, which is why we need no .w3s parser.
function InitSounds takes nothing returns nothing
    set udg_pissed = CreateSound( "Units\\\\Undead\\\\HeroDeathKnight\\\\DeathKnightPissed6.wav", false, true, true, 12700, 12700, "HeroAcksEAX" )
    call SetSoundParamsFromLabel( udg_pissed, "HeroDeathKnightPissed" )
    call SetSoundDuration( udg_pissed, 3385 )
    set udg_dur = GetSoundDurationBJ( udg_pissed )
    // CreateSoundFromLabel is handed NO file — the row supplies it (this is the victory
    // sting's own constructor).
    set udg_line = CreateSoundFromLabel( "N03Tyrande01", false, false, false, 10, 10 )
endfunction

// "Play <sound> at <point>" — the GUI action, i.e. the real blizzard.j BJ chain:
//   SetSoundPositionLocBJ → SetSoundVolumeBJ(PercentToInt(pct,127)) → PlaySoundBJ → StartSound
function AtPoint takes nothing returns nothing
    call PlaySoundAtPointBJ( udg_pissed, 100.0, Location(512.0, 256.0), 0.0 )
endfunction

// "Play <sound> on <unit>" — attaches, so the engine must take the UNIT's live position.
function OnUnit takes nothing returns nothing
    set udg_hero = CreateUnit( Player(0), 'Hpal', 0.0, 0.0, 0.0 )
    call PlaySoundOnUnitBJ( udg_line, 50.0, udg_hero )
endfunction

function StartStop takes nothing returns nothing
    call PlaySoundBJ( udg_pissed )
    set udg_before = GetSoundIsPlaying( udg_pissed )
    call StopSoundBJ( udg_pissed, true )
    set udg_after = GetSoundIsPlaying( udg_pissed )
endfunction

// The World Editor emits these sentinels for a sound left on its defaults — seen verbatim
// in the shipped (10)DustwallowKeys war3map.j. They are not values.
function Sentinels takes nothing returns nothing
    call SetSoundVolume( udg_pissed, -1 )
    call SetSoundPitch( udg_pissed, 4294967296.0 )
endfunction

// A 3D sound with a cone + distances, through the BJs (the outside volume is a PERCENT).
function Cone takes nothing returns nothing
    set udg_boom = CreateSound( "Abilities\\\\Spells\\\\Other\\\\Doom\\\\DoomTarget.wav", false, true, true, 10, 10, "" )
    call SetSoundDistances( udg_boom, 600.0, 8000.0 )
    call SetSoundConeAnglesBJ( udg_boom, 45.0, 180.0, 20.0 )
    call SetSoundConeOrientation( udg_boom, 1.0, 0.0, 0.0 )
    call SetSoundDistanceCutoffBJ( udg_boom, 3000.0 )
    call PlaySoundAtPointBJ( udg_boom, 100.0, Location(128.0, 64.0), 50.0 )
endfunction

// blizzard.j's own fire-and-forget helper: create + start + kill-when-done.
function FireAndForget takes nothing returns nothing
    call PlaySound( "Sound\\\\Interface\\\\Hint.wav" )
endfunction

function Music takes nothing returns nothing
    call SetMapMusic( "Music", true, 0 )
    call PlayThematicMusicBJ( "Sound\\\\Music\\\\mp3Music\\\\Doom.mp3" )
    call EndThematicMusicBJ(  )
    call StopMusicBJ( true )
    call ResumeMusicBJ(  )
    call SetMusicVolumeBJ( 50.0 )
endfunction

// Cinematic mode ducks the volume groups — blizzard.j's own values. Then one explicit
// override on top, so we see both the library's ducking and a script's own call.
function Cine takes nothing returns nothing
    call SetCineModeVolumeGroupsImmediateBJ(  )
    call VolumeGroupSetVolumeBJ( SOUND_VOLUMEGROUP_COMBAT, 25.0 )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  const rt = interp.rt;
  const g = (n) => rt.globals.get(n);
  const sndOf = (n) => rt.handles.get(g(n).h);

  interp.run('InitSounds', []);
  const pissed = sndOf('udg_pissed');
  // THE semantic of SetSoundParamsFromLabel: params, never the file. The label's row lists
  // all six DeathKnightPissed WAVs; the map asked for #6 and must keep it.
  if (pissed.file === 'Units\\Undead\\HeroDeathKnight\\DeathKnightPissed6.wav') {
    ok(`SetSoundParamsFromLabel keeps the script's OWN file (not one of the label row's 6 variants)`);
  } else fail(`file: ${pissed.file}`);
  if (pissed.volume === 127 && pissed.is3D === true && pissed.minDist === 3000 && pissed.maxDist === 10000) {
    ok(`...but takes volume 127 / WANT3D / MinDistance 3000 / MaxDistance 10000 from the real UnitAckSounds.slk row`);
  } else fail(`params: vol ${pissed.volume}, 3D ${pissed.is3D}, min ${pissed.minDist}, max ${pissed.maxDist}`);
  const line = sndOf('udg_line');
  // ...whereas CreateSoundFromLabel has no file to keep, so it takes the row's — and the
  // row is in a DIFFERENT table (DialogSounds), which is the "one label namespace" rule.
  if (line.file === 'Sound\\Dialogue\\NightElfCampaign\\NightElf03\\N03Tyrande01.mp3' && line.volume === 120) {
    ok(`CreateSoundFromLabel resolves its file + volume 120 out of DialogSounds.slk — one label namespace spans every SoundInfo table`);
  } else fail(`from-label: file ${line.file}, vol ${line.volume}`);
  if (Math.abs(g('udg_dur').n - 3.385) < 1e-6) {
    ok(`GetSoundDurationBJ → 3.385 s (the real BJ: I2R(GetSoundDuration) * 0.001 over the editor's baked 3385 ms)`);
  } else fail(`GetSoundDurationBJ: ${g('udg_dur').n}`);

  interp.run('AtPoint', []);
  const at = played[played.length - 1];
  if (at && at.positioned && at.x === 512 && at.y === 256 && at.volume === 127) {
    ok(`PlaySoundAtPointBJ(100%) → the engine plays it AT (512, 256) with volume 127 (PercentToInt(100, 127))`);
  } else fail(`at-point: ${JSON.stringify(at)}`);
  const last = rt.globals.get('bj_lastPlayedSound');
  if (last && last.h === pissed.handleId) {
    ok(`...and PlaySoundBJ recorded it in bj_lastPlayedSound (GetLastPlayedSound)`);
  } else fail(`bj_lastPlayedSound: ${JSON.stringify(last)}`);

  interp.run('OnUnit', []);
  const on = played[played.length - 1];
  // The volume is the real PercentToInt(50, 127) = R2I(50 * 127 / 100) = 63.
  if (on && on.attach === 77 && on.x === 900 && on.y === 300 && on.volume === 63) {
    ok(`PlaySoundOnUnitBJ(50%) → AttachSoundToUnit: the sound plays at the UNIT's live position (900, 300), volume 63`);
  } else fail(`on-unit: ${JSON.stringify(on)}`);

  interp.run('StartStop', []);
  if (g('udg_before').b === true && g('udg_after').b === false) {
    ok(`GetSoundIsPlaying is true after PlaySoundBJ and false after StopSoundBJ`);
  } else fail(`playing: before ${g('udg_before').b}, after ${g('udg_after').b}`);
  if (stopped[stopped.length - 1]?.fadeOut === true) {
    ok(`StopSoundBJ(snd, true) passes the fade-out through to the engine`);
  } else fail(`stop: ${JSON.stringify(stopped[stopped.length - 1])}`);

  interp.run('Sentinels', []);
  if (pissed.volume === 127 && pissed.pitch === 1) {
    ok(`SetSoundVolume(-1) / SetSoundPitch(4294967296.0) — the World Editor's "left on defaults" sentinels — are rejected, not applied`);
  } else fail(`after sentinels: vol ${pissed.volume}, pitch ${pissed.pitch}`);

  interp.run('Cone', []);
  const boom = played[played.length - 1];
  // SetSoundConeAnglesBJ's outside volume is a PERCENT: PercentToInt(20, 127) = 25.
  if (boom && boom.minDist === 600 && boom.maxDist === 8000 && boom.cutoff === 3000 && boom.coneInside === 45 && boom.coneOutsideVolume === 25) {
    ok(`a 3D sound carries its distances (600/8000), cutoff (3000) and cone (45°, outside volume 20% → 25) to the engine`);
  } else fail(`cone: ${JSON.stringify(boom)}`);

  const soundsBefore = rt.sounds.length;
  interp.run('FireAndForget', []);
  const ff = rt.sounds[rt.sounds.length - 1];
  if (rt.sounds.length === soundsBefore + 1 && ff.killWhenDone === true && ff.started === true) {
    ok(`blizzard.j's PlaySound() → CreateSound + StartSound + KillSoundWhenDone (the engine reaps the handle when the clip ends)`);
  } else fail(`fire-and-forget: killWhenDone ${ff?.killWhenDone}, started ${ff?.started}`);
  rt.destroySound(ff); // what the engine's per-frame sweep does once playback ends
  if (rt.sounds.length === soundsBefore && rt.handles.get(ff.handleId) === undefined) {
    ok(`...and destroySound unlinks it and frees the handle`);
  } else fail(`after reap: ${rt.sounds.length} sound(s), handle ${rt.handles.get(ff.handleId) !== undefined ? 'live' : 'freed'}`);

  interp.run('Music', []);
  const calls = music.map((m) => m.call).join(' ');
  if (calls === 'setMap thematic endThematic stop resume volume') {
    ok(`the music BJs reach the engine in order: SetMapMusic → PlayThematicMusicBJ → End → StopMusicBJ → ResumeMusicBJ → SetMusicVolumeBJ`);
  } else fail(`music calls: ${calls}`);
  const setMap = music[0];
  if (setMap.name === 'Music' && setMap.random === true && setMap.index === 0) {
    ok(`SetMapMusic("Music", true, 0) — a PLAYLIST KEY, not a file (war3skins.txt resolves it per the local player's race)`);
  } else fail(`SetMapMusic: ${JSON.stringify(setMap)}`);
  if (music[music.length - 1].v === 63) {
    ok(`SetMusicVolumeBJ(50%) → 63 (PercentToInt(50, 127), as with sound volume)`);
  } else fail(`music volume: ${music[music.length - 1].v}`);

  interp.run('Cine', []);
  // VolumeGroupSetVolumeBJ is `VolumeGroupSetVolume(vgroup, percent * 0.01)`.
  if (Math.abs((groups.get(2) ?? -1) - 0.25) < 1e-6) {
    ok(`VolumeGroupSetVolumeBJ(COMBAT, 25%) → group 2 at scale 0.25`);
  } else fail(`combat group: ${groups.get(2)}`);
  // blizzard.j's own cinematic values: UNITSOUNDS + UI muted to 0.00, MUSIC held at 0.55.
  // That is what proves a script-created `sound` (a cinematic's dialogue) belongs to NO
  // volume group — the ducking would silence it otherwise.
  if (groups.get(1) === 0 && groups.get(4) === 0 && Math.abs(groups.get(5) - 0.55) < 1e-6 && groups.get(6) === 1) {
    ok(`SetCineModeVolumeGroupsImmediateBJ ducks all 8 groups to blizzard.j's values (UNITSOUNDS/UI → 0.00, MUSIC → 0.55, AMBIENT → 1.00)`);
  } else fail(`cine groups: ${JSON.stringify([...groups])}`);
}

console.log('\n[7.21] Timer dialogs — the countdown windows (and the MELEE crippled-player window)');
{
  // The crippled check counts a player's structures and their MAIN HALLS. Player 0 holds
  // buildings but no hall (→ crippled); player 1 holds a hall (→ not crippled).
  const hooks = {
    localizedString: (key) => GLOBAL_STRINGS.get(key),
    playerStructureCount: (p) => (p === 0 || p === 1 ? 3 : 0),
    playerTypedUnitCount: (p) => (p === 1 ? 1 : 0), // only player 1 still has a main hall
    displayText: () => {},
    soundLabelInfo: () => null,
    playSound: () => true,
  };
  const SRC = `
globals
    timerdialog udg_wave = null
    timer       udg_t    = null
    boolean     udg_shown = false
endglobals
// The GUI's "Countdown Timer - Create a timer window" — the real BJ chain.
function MakeWave takes nothing returns nothing
    set udg_t = CreateTimer()
    call TimerStart( udg_t, 45.0, false, null )
    set udg_wave = CreateTimerDialogBJ( udg_t, "Next Level" )
    set udg_shown = IsTimerDialogDisplayed( udg_wave )
endfunction
function HideWave takes nothing returns nothing
    call TimerDialogDisplayBJ( false, udg_wave )
endfunction
// The MELEE path: MeleeInitVictoryDefeat builds a cripple timer + window per playing slot.
function Melee takes nothing returns nothing
    call MeleeInitVictoryDefeat(  )
endfunction
// Losing your last main hall while you still hold structures = crippled → the 120 s clock.
function Cripple takes nothing returns nothing
    call MeleeCheckForCrippledPlayers(  )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  const rt = interp.rt;
  // Two PLAYING human slots, so MeleeInitVictoryDefeat builds a window for each.
  rt.applyLobby([
    { index: 0, raceIndex: 1, controller: 1, team: 0, startLocation: 0 },
    { index: 1, raceIndex: 2, controller: 2, team: 1, startLocation: 1 },
  ], 0);
  interp.run('InitBlizzard', []);

  interp.run('MakeWave', []);
  const wave = rt.timerDialogs[rt.timerDialogs.length - 1];
  if (rt.timerDialogs.length === 1 && wave.title === 'Next Level' && wave.displayed === true) {
    ok(`CreateTimerDialogBJ → a window titled "Next Level", DISPLAYED (the BJ shows it; the native alone does not)`);
  } else fail(`wave: ${JSON.stringify({ n: rt.timerDialogs.length, title: wave && wave.title, shown: wave && wave.displayed })}`);
  if (rt.globals.get('udg_shown').b === true) {
    ok(`...and IsTimerDialogDisplayed agrees`);
  } else fail(`IsTimerDialogDisplayed: ${rt.globals.get('udg_shown').b}`);
  // A timerdialog holds no clock — it READS the timer it was made over.
  if (Math.abs(rt.timerDialogSeconds(wave) - 45) < 1e-6) {
    ok(`the window shows 45 s — read live off its timer, not a copy (a timerdialog holds no clock)`);
  } else fail(`seconds: ${rt.timerDialogSeconds(wave)}`);
  interp.advanceTime(12.5);
  if (Math.abs(rt.timerDialogSeconds(wave) - 32.5) < 1e-6) {
    ok(`...and after 12.5 s of game time it reads 32.5 s (it ticks with the timer, and freezes when the game pauses)`);
  } else fail(`after 12.5 s: ${rt.timerDialogSeconds(wave)}`);
  interp.run('HideWave', []);
  if (wave.displayed === false) {
    ok(`TimerDialogDisplayBJ(false) takes it off screen (the "…ForPlayer" variant is blizzard.j gating on GetLocalPlayer)`);
  } else fail(`still displayed`);

  // --- the melee leftover this milestone closes ---------------------------------------
  const before = rt.timerDialogs.length;
  interp.run('Melee', []);
  const made = rt.timerDialogs.slice(before);
  // One "finish soon" dialog (over a NULL timer) + one cripple window per PLAYING slot.
  const nullTimer = made.filter((d) => d.timerId === 0);
  const crippleWins = made.filter((d) => d.timerId !== 0);
  if (made.length === 3 && nullTimer.length === 1 && crippleWins.length === 2) {
    ok(`MeleeInitVictoryDefeat builds 3 windows: the "finish soon" one + a cripple window for each of the 2 PLAYING slots`);
  } else fail(`melee windows: ${made.length} (null-timer ${nullTimer.length}, cripple ${crippleWins.length})`);
  // bj_finishSoonTimerDialog = CreateTimerDialog(null) — "it has no timer because it is
  // driven by real time". It must not crash, and it shows SetRealTimeRemaining's value.
  if (rt.timerDialogSeconds(nullTimer[0]) === 0) {
    ok(`the "finish soon" window is CreateTimerDialog(null) — a legal, clock-less dialog (it reads TimerDialogSetRealTimeRemaining)`);
  } else fail(`null-timer seconds: ${rt.timerDialogSeconds(nullTimer[0])}`);
  // Its title is the race-specific "Build <main hall>" string, off the game's own table.
  if (crippleWins[0].title === 'Build Town Hall' && crippleWins[1].title === 'Build Great Hall') {
    ok(`the cripple windows are titled from the game's own strings, per RACE — "Build Town Hall" (human) / "Build Great Hall" (orc)`);
  } else fail(`cripple titles: ${crippleWins.map((d) => d.title).join(' / ')}`);
  // Not shown yet — a player is only crippled once they LOSE their last hall.
  if (!crippleWins.some((d) => d.displayed)) {
    ok(`...and neither is on screen yet: a cripple window only shows when its player actually becomes crippled`);
  } else fail(`a cripple window was displayed at init`);

  interp.run('Cripple', []);
  // Player 0 has structures but no main hall → crippled. Player 1 still has its hall.
  const p0 = crippleWins[0], p1 = crippleWins[1];
  if (p0.displayed === true && p1.displayed === false) {
    ok(`MeleeCheckForCrippledPlayers: player 0 lost their last hall → their "Build Town Hall" window APPEARS; player 1 (still has one) stays clear`);
  } else fail(`displayed: p0 ${p0.displayed}, p1 ${p1.displayed}`);
  if (rt.globals.get('bj_playerIsCrippled') && rt.globals.get('bj_playerIsCrippled')) {
    // the flag lives in a JASS array; read it through the array table
    const arr = rt.globalArrays.get('bj_playerIsCrippled');
    if (arr && arr.get(0).b === true && arr.get(1).b === false) {
      ok(`...and bj_playerIsCrippled[0] is set while [1] is not — the melee state and the window agree`);
    } else fail(`bj_playerIsCrippled: ${arr ? [arr.get(0).b, arr.get(1).b] : 'missing'}`);
  }
  // 120 s is blizzard.j's own bj_MELEE_CRIPPLE_TIMEOUT, and the window counts it down.
  const shown = formatTimerValueCheck(rt.timerDialogSeconds(p0));
  if (shown === '2:00') {
    ok(`the window opens at 2:00 — blizzard.j's bj_MELEE_CRIPPLE_TIMEOUT (120 s), formatted as the engine does`);
  } else fail(`cripple countdown: ${shown} (want 2:00)`);
  interp.advanceTime(61);
  if (formatTimerValueCheck(rt.timerDialogSeconds(p0)) === '0:59') {
    ok(`...ticking: 0:59 after 61 s`);
  } else fail(`after 61 s: ${formatTimerValueCheck(rt.timerDialogSeconds(p0))}`);
}

// The timer-pump bug 7.21 uncovered — a general engine bug, so it gets its own gate.
// A timer handler that DESTROYS a timer splices rt.timers, and advanceTime was iterating
// that same array live: the splice made the iterator skip the very next timer, which then
// never advanced. blizzard.j's own MarkGameStarted does exactly this (it destroys
// bj_gameStartedTimer from inside its handler, 0.01 s into every map), so the next timer any
// map created after InitBlizzard silently stopped ticking.
console.log('\n[7.4c] Regression: a self-destroying timer must not stop the NEXT timer (advanceTime snapshot)');
{
  const SRC = `
globals
    timer udg_a = null
    timer udg_b = null
endglobals
function Boom takes nothing returns nothing
    call DestroyTimer( GetExpiredTimer() )   // the one-shot idiom — and what MarkGameStarted does
endfunction
function Setup takes nothing returns nothing
    set udg_a = CreateTimer()
    set udg_b = CreateTimer()
    call TimerStart( udg_a, 0.01, false, function Boom )   // expires immediately, destroys itself
    call TimerStart( udg_b, 60.0, false, null )            // ...and udg_b sits right after it
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC]);
  const rt = interp.rt;
  interp.run('Setup', []);
  const b = rt.handles.get(rt.globals.get('udg_b').h);
  interp.advanceTime(10);
  if (Math.abs(b.remaining - 50) < 1e-6) {
    ok(`the timer created after a self-destroying one still ticks (60 → 50 over 10 s); before the fix it stayed at 60 forever`);
  } else fail(`udg_b.remaining = ${b.remaining} (want 50)`);
  if (!rt.timers.includes(rt.handles.get(rt.globals.get('udg_a').h)) || rt.timers.length === 1) {
    ok(`...and the destroyed timer really is gone from the pump`);
  } else fail(`the destroyed timer is still in rt.timers`);
}

// ===========================================================================
// 7.22 — vision, fog and way gates.
//
// Driven through the REAL blizzard.j BJs, and — where the semantics actually live —
// against the REAL engine classes (src/sim/alliances.ts's AllianceTable and
// src/sim/vision.ts's VisionMap), not a mock that would just agree with itself. The
// bridge below is the same shape mapViewer's textHooks() installs.
// ===========================================================================
const { AllianceTable } = require(join(REPO, '.jass-build', 'src', 'sim', 'alliances.js'));
const { VisionMap, FogState, fogStateOf } = require(join(REPO, '.jass-build', 'src', 'sim', 'vision.js'));

console.log('\n[7.22] Shared vision + alliances (SetPlayerAlliance / CripplePlayer)');
{
  const alliances = new AllianceTable();
  // The lobby: players 0+1 on team 0, player 2 on team 1. This is what seeds the matrix,
  // exactly as RtsController.seedAlliances does before the map script runs.
  alliances.seedFromTeams((p) => (p === 0 || p === 1 ? 0 : 1));
  const exposedTo = new Map(); // player → the set of players they are revealed to
  const hooks = {
    setPlayerAlliance: (s, o, t, v) => alliances.set(s, o, t, v),
    getPlayerAlliance: (s, o, t) => alliances.get(s, o, t),
    cripplePlayer: (p, to, flag) => {
      if (!exposedTo.has(p)) exposedTo.set(p, new Set());
      for (const q of to) flag ? exposedTo.get(p).add(q) : exposedTo.get(p).delete(q);
      if (!flag && to.length === 0) exposedTo.set(p, new Set()); // the "clear" call
    },
    isPlayerAlly: (p, q) => alliances.coAllied(p, q),
    localizedString: (key) => GLOBAL_STRINGS.get(key),
    playerStructureCount: () => 3,
    playerTypedUnitCount: () => 0,
    displayText: () => {},
    soundLabelInfo: () => null,
    playSound: () => true,
  };
  const SRC = `
globals
    boolean udg_coAlliedBefore = false
    boolean udg_coAlliedAfter  = false
    boolean udg_visionAfter    = false
    boolean udg_stillAllied    = false
endglobals
// The GUI's "Player - Make Player 0 treat Player 2 as an Ally with shared vision" compiles
// to SetPlayerAllianceStateBJ — pure blizzard.j, riding on the single SetPlayerAlliance
// native. Nothing here calls the native directly.
function AllyThem takes nothing returns nothing
    set udg_coAlliedBefore = PlayersAreCoAllied( Player(0), Player(2) )
    call SetPlayerAllianceStateBJ( Player(0), Player(2), bj_ALLIANCE_ALLIED_VISION )
    call SetPlayerAllianceStateBJ( Player(2), Player(0), bj_ALLIANCE_ALLIED_VISION )
    set udg_coAlliedAfter = PlayersAreCoAllied( Player(0), Player(2) )
    set udg_visionAfter   = GetPlayerAlliance( Player(2), Player(0), ALLIANCE_SHARED_VISION )
endfunction
// One-directional: player 0 un-allies player 2, but player 2 has not un-allied player 0.
function HalfUnally takes nothing returns nothing
    call SetPlayerAllianceStateBJ( Player(0), Player(2), bj_ALLIANCE_UNALLIED )
    set udg_stillAllied = PlayersAreCoAllied( Player(0), Player(2) )
endfunction
// The melee punishment: expose a player to everyone not co-allied with them.
function Expose takes nothing returns nothing
    call MeleeExposePlayer( Player(2), true )
endfunction
function Unexpose takes nothing returns nothing
    call MeleeExposePlayer( Player(2), false )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  const rt = interp.rt;
  rt.applyLobby([
    { index: 0, raceIndex: 1, controller: 1, team: 0, startLocation: 0 },
    { index: 1, raceIndex: 1, controller: 2, team: 0, startLocation: 1 },
    { index: 2, raceIndex: 2, controller: 2, team: 1, startLocation: 2 },
  ], 0);
  interp.run('InitBlizzard', []);

  // The seed: team-mates are co-allied and share vision; the other team is neither.
  if (alliances.coAllied(0, 1) && alliances.sharesVisionWith(1, 0) && !alliances.coAllied(0, 2)) {
    ok(`the matrix is SEEDED from the lobby's teams — 0 and 1 (same team) are co-allied and share vision; 2 is not`);
  } else fail(`seed: coAllied(0,1)=${alliances.coAllied(0, 1)} vision(1→0)=${alliances.sharesVisionWith(1, 0)} coAllied(0,2)=${alliances.coAllied(0, 2)}`);

  interp.run('AllyThem', []);
  if (rt.globals.get('udg_coAlliedBefore').b === false && rt.globals.get('udg_coAlliedAfter').b === true) {
    ok(`SetPlayerAllianceStateBJ(bj_ALLIANCE_ALLIED_VISION) — the whole GUI "make X treat Y as an Ally" family — allies 0 and 2 through the real BJ`);
  } else fail(`coAllied before/after: ${rt.globals.get('udg_coAlliedBefore').b} / ${rt.globals.get('udg_coAlliedAfter').b}`);
  if (rt.globals.get('udg_visionAfter').b === true && alliances.sharesVisionWith(2, 0)) {
    ok(`...and it granted ALLIANCE_SHARED_VISION with it, so player 2's units now lift player 0's fog`);
  } else fail(`shared vision: ${rt.globals.get('udg_visionAfter').b}`);
  // The matrix is DIRECTED — that is the whole reason PlayersAreCoAllied reads both ways.
  interp.run('HalfUnally', []);
  if (rt.globals.get('udg_stillAllied').b === false && alliances.get(2, 0, 0) === true) {
    ok(`the matrix is DIRECTED: 0 un-allies 2, so they are no longer co-allied — even though 2 still grants 0 ALLIANCE_PASSIVE`);
  } else fail(`stillAllied=${rt.globals.get('udg_stillAllied').b}, 2→0 passive=${alliances.get(2, 0, 0)}`);

  // --- the melee leftover this milestone closes ------------------------------------
  // MeleeExposePlayer(p, true) → CripplePlayer(p, <every player NOT co-allied with p>, true).
  interp.run('Expose', []);
  const exposed2 = exposedTo.get(2) ?? new Set();
  if (exposed2.has(0) && exposed2.has(1)) {
    ok(`MeleeExposePlayer → CripplePlayer: player 2's units are REVEALED to players 0 and 1 (the cripple timer's real punishment)`);
  } else fail(`exposed to: ${[...exposed2].join(',')}`);
  if (!exposed2.has(2)) {
    ok(`...but not to player 2 themselves — MeleeExposePlayer only adds players who are NOT co-allied with the exposed one`);
  } else fail(`player 2 exposed to itself`);
  const flag = rt.globalArrays.get('bj_playerIsExposed');
  if (flag && flag.get(2).b === true) {
    ok(`...and blizzard.j's own bj_playerIsExposed[2] is set`);
  } else fail(`bj_playerIsExposed[2]: ${flag ? flag.get(2).b : 'missing'}`);
  interp.run('Unexpose', []);
  if ((exposedTo.get(2) ?? new Set()).size === 0) {
    ok(`MeleeExposePlayer(p, false) hides them again — it re-issues CripplePlayer with the flag cleared (build a hall in time and nothing was ever shown)`);
  } else fail(`still exposed to: ${[...exposedTo.get(2)].join(',')}`);
}

console.log('\n[7.22] Fog of war — script-placed fog modifiers (a DIFFERENT system from the terrain haze)');
{
  // A real 2048×2048 VisionMap, origin (-1024, -1024).
  const vision = new VisionMap(-1024, -1024, 2048, 2048);
  const modifiers = new Map();
  let nextMod = 1;
  const LOCAL = 0;
  const hooks = {
    createFogModifier: (player, state, area) => {
      const id = nextMod++;
      modifiers.set(id, { player, state, area, running: false });
      return id;
    },
    fogModifierStart: (id) => { modifiers.get(id).running = true; },
    fogModifierStop: (id) => { modifiers.get(id).running = false; },
    destroyFogModifier: (id) => modifiers.delete(id),
    setFogState: (player, state, area) => { if (player === LOCAL) stamp(area, fogStateOf(state)); },
    fogEnable: (f) => vision.setFogEnabled(f),
    fogMaskEnable: (f) => vision.setMaskEnabled(f),
  };
  const stamp = (area, state) => {
    if (area.kind === 'rect') vision.stampRect(area.minX, area.minY, area.maxX, area.maxY, state);
    else vision.stampCircle(area.x, area.y, area.radius, state);
  };
  // What RtsController.updateVision does every rebuild: clear, reveal from units, THEN
  // stamp the running modifiers over the top.
  const rebuild = () => {
    vision.beginFrame();
    vision.reveal(-800, -800, 300); // one friendly unit down in the corner
    for (const m of modifiers.values()) if (m.running && m.player === LOCAL) stamp(m.area, fogStateOf(m.state));
  };

  const SRC = `
globals
    fogmodifier udg_reveal = null
    fogmodifier udg_hide   = null
endglobals
// The compiled GUI shape: "Visibility - Create an initially Enabled visibility modifier".
function MakeReveal takes nothing returns nothing
    set udg_reveal = CreateFogModifierRectBJ( true, Player(0), FOG_OF_WAR_VISIBLE, Rect(0.0, 0.0, 512.0, 512.0) )
endfunction
// Created DISABLED — the native does not start a modifier, FogModifierStart does.
function MakeHiddenStopped takes nothing returns nothing
    set udg_hide = CreateFogModifierRadiusLocBJ( false, Player(0), FOG_OF_WAR_MASKED, Location(-800.0, -800.0), 200.0 )
endfunction
function StartHide takes nothing returns nothing
    call FogModifierStart( udg_hide )
endfunction
function StopReveal takes nothing returns nothing
    call FogModifierStop( udg_reveal )
endfunction
function NoFog takes nothing returns nothing
    call FogEnableOff(  )
    call FogMaskEnableOff(  )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('InitBlizzard', []);

  rebuild();
  // Nobody is anywhere near (256, 256), so it starts black.
  if (vision.stateAt(256, 256) === FogState.Unexplored) {
    ok(`before any modifier, ground no unit can see is Unexplored (black)`);
  } else fail(`state at (256,256): ${vision.stateAt(256, 256)}`);

  interp.run('MakeReveal', []);
  rebuild();
  if (vision.stateAt(256, 256) === FogState.Visible) {
    ok(`CreateFogModifierRectBJ(enabled) → the rect is held at FOG_OF_WAR_VISIBLE — ground nobody stands near is LIT (the TD that shows you its whole maze)`);
  } else fail(`state at (256,256): ${vision.stateAt(256, 256)}`);
  if (vision.stateAt(700, 700) === FogState.Unexplored) {
    ok(`...and only inside the rect: (700,700) is outside it and stays black`);
  } else fail(`state at (700,700): ${vision.stateAt(700, 700)}`);

  // The crux of the whole family: a fog modifier is created STOPPED.
  interp.run('MakeHiddenStopped', []);
  rebuild();
  if (vision.stateAt(-800, -800) === FogState.Visible) {
    ok(`CreateFogModifierRadiusLocBJ(enabled=false) does NOT start it — the unit standing at (-800,-800) still sees (the native creates, FogModifierStart runs)`);
  } else fail(`state at (-800,-800): ${vision.stateAt(-800, -800)} (want Visible — the modifier should be inert)`);
  interp.run('StartHide', []);
  rebuild();
  // MASKED must beat a unit's own sight AND clear `explored` — that is what makes a
  // re-masked area go properly black rather than settling to remembered grey.
  if (vision.stateAt(-800, -800) === FogState.Unexplored) {
    ok(`FogModifierStart → FOG_OF_WAR_MASKED blacks out ground a unit is STANDING IN (a cinematic area), clearing the sticky 'explored' layer with it`);
  } else fail(`after start, state at (-800,-800): ${vision.stateAt(-800, -800)}`);

  interp.run('StopReveal', []);
  rebuild();
  // Stopping the reveal drops it to Explored, not black: the modifier lit it, so it was seen.
  if (vision.stateAt(256, 256) === FogState.Explored) {
    ok(`FogModifierStop → the revealed rect falls back to Explored grey (it WAS seen; terrain memory is sticky)`);
  } else fail(`after stop, state at (256,256): ${vision.stateAt(256, 256)}`);

  // The two global switches are NOT the same switch.
  interp.run('NoFog', []);
  if (vision.stateAt(700, 700) === FogState.Visible && vision.stateAt(256, 256) === FogState.Visible) {
    ok(`FogEnableOff + FogMaskEnableOff → the whole map reads Visible (the grey veil and the black mask are two separate layers, and blizzard.j switches them separately)`);
  } else fail(`no-fog: (700,700)=${vision.stateAt(700, 700)} (256,256)=${vision.stateAt(256, 256)}`);
}

console.log('\n[7.22] Terrain fog — the atmospheric haze (SetTerrainFogEx), which is NOT the fog of war');
{
  let fog = { start: 3000, end: 5000, r: 0.5, g: 0.5, b: 0.5 }; // the map's own w3i fog
  const w3i = { ...fog };
  let reset = 0;
  const hooks = {
    setTerrainFog: (style, zstart, zend, density, r, g, b) => { fog = { style, start: zstart, end: zend, density, r, g, b }; },
    resetTerrainFog: () => { fog = { ...w3i }; reset++; },
  };
  const SRC = `
// A hand-written script calls the native with rgb in 0–1 — verbatim from (6)Jack-o-Lantern's
// own war3map.j (a green horizon).
function Spooky takes nothing returns nothing
    call SetTerrainFogEx( 0, 1000.0, 5000.0, 0.000, 0.000, 0.502, 0.000 )
endfunction
// The GUI's "Environment - Set fog to style ..." is SetTerrainFogExBJ, which takes 0–100
// and multiplies by 0.01 on the way to the native. Same fog, different scale.
function GuiBlue takes nothing returns nothing
    call SetTerrainFogExBJ( 0, 1200.0, 4000.0, 0.0, 50.2, 50.2, 100.0 )
endfunction
function Restore takes nothing returns nothing
    call ResetTerrainFogBJ(  )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  interp.run('InitBlizzard', []);

  interp.run('Spooky', []);
  if (fog.style === 0 && fog.start === 1000 && fog.end === 5000 && Math.abs(fog.g - 0.502) < 1e-6 && fog.r === 0 && fog.b === 0) {
    ok(`SetTerrainFogEx → a green horizon 1000–5000 units out, rgb in 0–1 (style 0 = LINEAR, which every one of the corpus's 12 calls passes — our shader is linear)`);
  } else fail(`fog: ${JSON.stringify(fog)}`);
  interp.run('GuiBlue', []);
  // The BJ's ×0.01: 50.2 → 0.502, 100.0 → 1.0. Get this backwards and a GUI fog is white.
  if (Math.abs(fog.r - 0.502) < 1e-6 && Math.abs(fog.b - 1.0) < 1e-6 && fog.start === 1200) {
    ok(`...and SetTerrainFogExBJ's 0–100 scale is divided by 100 on the way in (50.2 → 0.502, 100 → 1.0) — the BJ and the native take DIFFERENT units`);
  } else fail(`gui fog: ${JSON.stringify(fog)}`);
  interp.run('Restore', []);
  if (reset === 1 && fog.start === 3000 && Math.abs(fog.g - 0.5) < 1e-6) {
    ok(`ResetTerrainFog restores the MAP's own w3i fog — not "no fog" (the w3i is the baseline, and that is what the engine resets to)`);
  } else fail(`after reset: ${JSON.stringify(fog)} (resets: ${reset})`);
}

console.log('\n[7.22] Way gates — a unit walks in, and comes out the far end');
{
  // The gate box is 400×400 world units: the Way Gate's `Awrp` ("Warp") ability, whose
  // DataA1/DataB1 (400/400) AbilityMetaData.slk names "Teleport Area Width"/"Height".
  const HALF = 200;
  const units = new Map(); // simId → {x, y, waygate}
  let nextSim = 1;
  const place = (typeId, x, y) => { const id = nextSim++; units.set(id, { id, typeId, x, y, waygate: null }); return id; };
  // Two gates + a traveller, all pre-placed (as they are on every real map).
  const gateA = place('nwgt', -3840, -3840);
  const gateB = place('nwgt', 3456, 3200);
  const walker = place('hfoo', 0, 0);
  const hooks = {
    // The record-only CreateUnit path: CreateAllUnits records the row, and the handle is
    // bound to the unit ALREADY standing there. Without this, every WaygateSetDestination
    // below would fall on a handle with simId -1 and do nothing at all.
    findPlacedUnit: (typeId, x, y) => {
      for (const u of units.values()) if (u.typeId === typeId && Math.hypot(u.x - x, u.y - y) <= 128) return u.id;
      return -1;
    },
    waygateSetDestination: (id, x, y) => {
      const u = units.get(id);
      u.waygate = u.waygate || { destX: 0, destY: 0, active: false, inside: new Set() };
      u.waygate.destX = x;
      u.waygate.destY = y;
    },
    waygateActivate: (id, active) => {
      const u = units.get(id);
      u.waygate = u.waygate || { destX: 0, destY: 0, active: false, inside: new Set() };
      u.waygate.active = active;
    },
    waygateDestination: (id) => { const w = units.get(id).waygate; return w ? { x: w.destX, y: w.destY } : null; },
    waygateIsActive: (id) => !!(units.get(id).waygate && units.get(id).waygate.active),
    getUnitX: (id) => units.get(id).x,
    getUnitY: (id) => units.get(id).y,
  };
  // SimWorld.tickWaygates, in miniature. A gate fires on a unit ENTERING its box (the
  // rising edge), never on one standing in it — and that is not a nicety. A gate's
  // destination is its PARTNER gate, so the traveller lands inside the partner's box: fire
  // on occupancy and the two gates throw the unit back and forth forever. Measured live on
  // (4)CentaurGrove before the fix — the footman bounced SW↔NE every tick and never
  // arrived. Hence `inside`, the same silent baseline the enter-region pump keeps.
  const inBox = (u, g) => u !== g && u.typeId !== 'nwgt' && Math.abs(u.x - g.x) <= HALF && Math.abs(u.y - g.y) <= HALF;
  const tickWaygates = () => {
    const gates = [...units.values()].filter((g) => g.waygate && g.waygate.active);
    const moved = new Set();
    for (const g of gates) {
      for (const u of units.values()) {
        if (!inBox(u, g) || g.waygate.inside.has(u.id) || moved.has(u.id)) continue;
        u.x = g.waygate.destX;
        u.y = g.waygate.destY;
        moved.add(u.id);
      }
    }
    // Re-baseline from FINAL positions — this seeds the arriving unit into the destination
    // gate's occupancy so that gate does not fire on it.
    for (const g of gates) {
      g.waygate.inside = new Set();
      for (const u of units.values()) if (inBox(u, g)) g.waygate.inside.add(u.id);
    }
  };
  // Verbatim in shape from (4)CentaurGrove's own CreateNeutralPassiveBuildings — the gates
  // are set up INSIDE CreateAllUnits, which is exactly why the handle binding matters.
  const SRC = `
globals
    unit    udg_gateA  = null
    unit    udg_gateB  = null
    real    udg_destX  = 0.0
    boolean udg_active = false
endglobals
function CreateAllUnits takes nothing returns nothing
    local player p = Player(PLAYER_NEUTRAL_PASSIVE)
    set udg_gateA = CreateUnit( p, 'nwgt', -3840.0, -3840.0, 270.000 )
    call WaygateSetDestination( udg_gateA, 3456.0, 3200.0 )
    call WaygateActivate( udg_gateA, true )
    set udg_gateB = CreateUnit( p, 'nwgt', 3456.0, 3200.0, 270.000 )
    call WaygateSetDestination( udg_gateB, -3840.0, -3840.0 )
    call WaygateActivate( udg_gateB, true )
endfunction
function Read takes nothing returns nothing
    set udg_destX  = WaygateGetDestinationX( udg_gateA )
    set udg_active = WaygateIsActive( udg_gateA )
endfunction
function Switchoff takes nothing returns nothing
    call WaygateActivate( udg_gateA, false )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  const rt = interp.rt;
  interp.run('InitBlizzard', []);
  // Run it exactly as main() does: record-only, so nothing is spawned.
  rt.spawnDepth = 1;
  interp.run('CreateAllUnits', []);
  rt.spawnDepth = 0;

  const hA = rt.data(rt.globals.get('udg_gateA'));
  if (hA && hA.simId === gateA) {
    ok(`a record-only CreateUnit inside CreateAllUnits BINDS its handle to the pre-placed unit already standing there (simId ${hA.simId}, not -1)`);
  } else fail(`gateA handle simId: ${hA && hA.simId} (want ${gateA})`);
  if (units.get(gateA).waygate && units.get(gateA).waygate.active && units.get(gateA).waygate.destX === 3456) {
    ok(`...so WaygateSetDestination + WaygateActivate on that handle actually reach the gate — which is the ONLY reason a melee map's waygates can work`);
  } else fail(`gateA waygate: ${JSON.stringify(units.get(gateA).waygate)}`);

  interp.run('Read', []);
  if (rt.globals.get('udg_destX').n === 3456 && rt.globals.get('udg_active').b === true) {
    ok(`WaygateGetDestinationX / WaygateIsActive read it back`);
  } else fail(`read back: ${rt.globals.get('udg_destX').n} / ${rt.globals.get('udg_active').b}`);

  // Walk in. 150 units off-centre is inside the 400×400 box (half-extent 200).
  units.get(walker).x = -3840 + 150;
  units.get(walker).y = -3840 - 150;
  tickWaygates();
  if (units.get(walker).x === 3456 && units.get(walker).y === 3200) {
    ok(`a unit ENTERING gate A's 400×400 box comes out at gate B (Awrp DataA1/DataB1 = "Teleport Area Width"/"Height" = 400×400 — from the MPQ, not a guess)`);
  } else fail(`walker at ${units.get(walker).x},${units.get(walker).y}`);
  // THE regression gate for this milestone. The traveller now stands on gate B — inside
  // gate B's own box. A gate that fired on OCCUPANCY would throw it straight back, and
  // gate A would throw it forward again: the live run on (4)CentaurGrove bounced the
  // footman SW↔NE every single tick and it never arrived. Firing on ENTRY fixes it, so
  // run several ticks and insist it stays put.
  let bounced = false;
  for (let t = 0; t < 5; t++) {
    tickWaygates();
    if (units.get(walker).x !== 3456 || units.get(walker).y !== 3200) bounced = true;
  }
  if (!bounced) {
    ok(`...and it STAYS there over 5 more ticks — a gate fires on ENTERING its box, not on standing in it, so the pair cannot ping-pong the traveller forever`);
  } else fail(`the traveller ping-ponged between the gates (now at ${units.get(walker).x},${units.get(walker).y})`);
  // …and it can still walk back through: leave the box, re-enter, and it crosses again.
  units.get(walker).x = 3456 + 500; // step out of gate B
  units.get(walker).y = 3200;
  tickWaygates();
  units.get(walker).x = 3456 + 100; // …and back in
  tickWaygates();
  if (units.get(walker).x === -3840 && units.get(walker).y === -3840) {
    ok(`...while a unit that LEAVES and walks back in crosses again — the gate is re-armed by the exit, not permanently spent`);
  } else fail(`return trip: ${units.get(walker).x},${units.get(walker).y}`);

  // A unit just outside the box is untouched.
  units.get(walker).x = -3840 + 250; // 250 > half-extent 200
  units.get(walker).y = -3840;
  tickWaygates();
  if (units.get(walker).x === -3840 + 250) {
    ok(`a unit 250 units off the gate is OUTSIDE the box (half-extent 200) and is not teleported — the gate is a box, not "anywhere near"`);
  } else fail(`teleported from outside the box`);

  interp.run('Switchoff', []);
  units.get(walker).x = -3840;
  units.get(walker).y = -3840;
  tickWaygates();
  if (units.get(walker).x === -3840) {
    ok(`WaygateActivate(gate, false) → a deactivated gate teleports nothing, even standing dead centre`);
  } else fail(`a deactivated gate still teleported`);
}

console.log('\n[7.22] Multiboards — the grid scoreboard (what DotA puts on screen)');
{
  const SRC = `
globals
    multiboard     udg_mb   = null
    multiboarditem udg_cell = null
    string         udg_read = ""
    integer        udg_rows = 0
    integer        udg_cols = 0
endglobals
// The compiled GUI shape, verbatim from (10)Skibi'sCastleTD: CreateMultiboardBJ(cols, rows, title).
function Make takes nothing returns nothing
    set udg_mb   = CreateMultiboardBJ( 3, 12, "Skibi's Castle" )
    set udg_rows = MultiboardGetRowCount( udg_mb )
    set udg_cols = MultiboardGetColumnCount( udg_mb )
endfunction
// The BJs are 1-based (col, row); the NATIVE underneath is 0-based (row, column). Blizzard
// does the swap: "set mbitem = MultiboardGetItem(mb, curRow - 1, curCol - 1)".
function Fill takes nothing returns nothing
    call MultiboardSetItemValueBJ( udg_mb, 2, 5, "Kills" )
    call MultiboardSetItemIconBJ ( udg_mb, 3, 1, "ReplaceableTextures\\\\CommandButtons\\\\BTNChestOfGold.blp" )
endfunction
// A borrowed handle: Get → write → Release. Reading through the RELEASED handle must not work.
function Borrow takes nothing returns nothing
    set udg_cell = MultiboardGetItem( udg_mb, 0, 0 )
    call MultiboardSetItemValue( udg_cell, "top-left" )
    call MultiboardReleaseItem( udg_cell )
    call MultiboardSetItemValue( udg_cell, "STALE WRITE" )
endfunction
function Hide takes nothing returns nothing
    call MultiboardDisplayBJ( false, udg_mb )
endfunction
function Suppress takes nothing returns nothing
    call MultiboardAllowDisplayBJ( false )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks: {} });
  const rt = interp.rt;
  interp.run('InitBlizzard', []);

  interp.run('Make', []);
  const mb = rt.multiboards[0];
  if (rt.multiboards.length === 1 && mb.rows === 12 && mb.columns === 3 && mb.title === "Skibi's Castle") {
    ok(`CreateMultiboardBJ(3, 12, …) → a 12-row × 3-column board titled "Skibi's Castle"`);
  } else fail(`board: ${JSON.stringify({ n: rt.multiboards.length, rows: mb && mb.rows, cols: mb && mb.columns, title: mb && mb.title })}`);
  // CreateMultiboardBJ sets rows FIRST, then columns — so the grid is reshaped twice, and a
  // reshape that dropped cells would lose everything written before the second call.
  if (mb.items.length === 36) {
    ok(`...and the grid really has 12 × 3 = 36 cells (the BJ sets rows THEN columns, so the reshape has to survive being run twice)`);
  } else fail(`cells: ${mb.items.length}`);
  // The BJ shows it: CreateMultiboardBJ ends with MultiboardDisplay(…, true).
  if (mb.displayed === true) {
    ok(`...and it is DISPLAYED — CreateMultiboardBJ shows it (the native alone does not)`);
  } else fail(`not displayed`);
  if (rt.globals.get('udg_rows').n === 12 && rt.globals.get('udg_cols').n === 3) {
    ok(`MultiboardGetRowCount / GetColumnCount read them back`);
  } else fail(`counts read back: ${rt.globals.get('udg_rows').n} / ${rt.globals.get('udg_cols').n}`);

  // THE axis trap. MultiboardSetItemValueBJ(mb, col=2, row=5) is 1-based (col, row); it must
  // land in cell (row 4, col 1) 0-based. Swap the axes and it lands in (row 1, col 4) — off
  // this board entirely, and on a square board it would silently transpose instead.
  interp.run('Fill', []);
  const kills = mb.items[4 * mb.columns + 1];
  if (kills && kills.value === 'Kills') {
    ok(`MultiboardSetItemValueBJ(mb, col 2, row 5) — 1-based (COL, ROW) — lands in the 0-based (row 4, col 1) cell: the BJ and the native take the axes in OPPOSITE order`);
  } else fail(`(4,1) = ${JSON.stringify(kills)}; row5/col2 as written = ${JSON.stringify(mb.items[1 * mb.columns + 4])}`);
  const gold = mb.items[0 * mb.columns + 2];
  if (gold && /BTNChestOfGold/.test(gold.icon)) {
    ok(`...and MultiboardSetItemIconBJ(mb, col 3, row 1) puts the gold icon in (row 0, col 2)`);
  } else fail(`icon cell: ${JSON.stringify(gold)}`);

  // A multiboarditem handle is BORROWED — Get, write, Release. The released cursor is dead.
  interp.run('Borrow', []);
  if (mb.items[0].value === 'top-left') {
    ok(`MultiboardGetItem → MultiboardSetItemValue → MultiboardReleaseItem writes the cell through the borrowed handle`);
  } else fail(`(0,0) = ${mb.items[0].value}`);
  if (mb.items[0].value !== 'STALE WRITE') {
    ok(`...and a write through the RELEASED handle is a no-op — the handle is given back, not kept (every blizzard.j BJ pairs Get with Release)`);
  } else fail(`a released item handle still wrote to the board`);

  interp.run('Hide', []);
  if (mb.displayed === false) {
    ok(`MultiboardDisplayBJ(false) takes it off screen`);
  } else fail(`still displayed`);
  // Suppression is a separate, GLOBAL switch: it hides every board without clearing any
  // `displayed` flag, so the boards come back exactly as they were (Skibi's wraps its
  // minigame cinematics in it).
  interp.run('Suppress', []);
  if (rt.multiboardSuppressed === true && mb.displayed === false) {
    ok(`MultiboardAllowDisplayBJ(false) → MultiboardSuppressDisplay(true): a GLOBAL hide that leaves each board's own displayed flag untouched`);
  } else fail(`suppressed=${rt.multiboardSuppressed}`);
}

// ===========================================================================
// 7.23 — Weather: the map's atmosphere.
//
// Driven through the REAL TerrainArt\Weather.slk and our REAL parser
// (src/data/weather.ts), not a fixture — the whole point is that every emitter parameter
// is the game's, so a test against a hand-written copy of the table would prove nothing.
// ===========================================================================
const { loadWeatherRegistry } = require(join(REPO, '.jass-build', 'src', 'data', 'weather.js'));

console.log("\n[7.23] Weather — the map's atmosphere (rain, snow, fog, light rays)");
{
  // A DataSource over the extracted install, which is all loadWeatherRegistry asks for.
  const vfs = {
    rawBytes: (p) => {
      const path = join(WC3, 'ExtractedData', 'merged', ...p.split(SEP));
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    },
  };
  const weather = loadWeatherRegistry(vfs);
  if (weather.size === 21) {
    ok(`TerrainArt\\Weather.slk parses to all 21 weather types`);
  } else fail(`weather types: ${weather.size} (want 21)`);

  // THE finding this milestone rests on. The table gives BOTH an emission rate and a
  // particle count and never says how they relate — but they are not independent:
  //     particles == emrate × lifespan × 20     for every row, exactly.
  // So `particles` is the steady-state population and the two columns encode one number. We
  // take `particles` as the live-particle budget; if this ever stops holding, the density
  // model behind src/render/weather.ts is wrong and this gate says so.
  const raw = readFileSync(join(WC3, 'ExtractedData', 'merged', 'TerrainArt', 'Weather.slk'), 'latin1');
  const emrates = new Map(); // id → emrate, straight out of the SLK cells
  {
    const cells = new Map();
    let x = 0, y = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('C;')) continue;
      for (const p of line.split(';')) {
        if (p[0] === 'X') x = parseInt(p.slice(1), 10);
        else if (p[0] === 'Y') y = parseInt(p.slice(1), 10);
        else if (p[0] === 'K') { let v = p.slice(1); if (v.startsWith('"')) v = v.slice(1, -1); cells.set(`${y},${x}`, v); }
      }
    }
    const cols = new Map();
    for (const [k, v] of cells) { const [ry, rx] = k.split(',').map(Number); if (ry === 1) cols.set(v, rx); }
    for (const [k, v] of cells) {
      const [ry, rx] = k.split(',').map(Number);
      if (rx !== cols.get('effectID') || ry === 1) continue;
      emrates.set(v, Number(cells.get(`${ry},${cols.get('emrate')}`)));
    }
  }
  let derived = 0;
  for (const id of weather.ids()) {
    const d = weather.get(id);
    const em = emrates.get(id);
    if (em !== undefined && Math.abs(d.particles - em * d.lifespan * 20) < 1e-6) derived++;
  }
  if (derived === 21) {
    ok(`'particles' is a DERIVED column: particles == emrate × lifespan × 20 for ALL 21 rows, exactly — so it IS the steady-state population, and that is the density we emit`);
  } else fail(`the emrate×lifespan×20 identity holds for only ${derived}/21 rows — the density model is built on it`);

  // The five shapes, each read straight off the table.
  const rain = weather.get('RAhr');
  if (rain && rain.tail && !rain.head && rain.texture === 'ReplaceableTextures\\Weather\\rainTail.blp') {
    ok(`rain ('RAhr') is a TAIL particle on rainTail.blp — a streak stretched along its velocity, not a billboard`);
  } else fail(`RAhr: ${JSON.stringify(rain && { head: rain.head, tail: rain.tail, tex: rain.texture })}`);
  // Tail length = |veloc| × taillen. This is what makes rain a short dash (1200 × 0.14 = 168)
  // and a moonbeam a 3000-unit shaft (300 × 10) from the same two columns.
  if (Math.abs(Math.abs(rain.veloc) * rain.taillen - 168) < 1e-6) {
    ok(`...and its streak is |veloc| × taillen = 1200 × 0.14 = 168 world units long`);
  } else fail(`rain streak: ${Math.abs(rain.veloc) * rain.taillen}`);
  const ray = weather.get('LRma');
  if (Math.abs(Math.abs(ray.veloc) * ray.taillen - 3000) < 1e-6) {
    ok(`...while moonlight ('LRma') is the SAME two columns — 300 × 10 = a 3000-unit shaft of light`);
  } else fail(`ray shaft: ${Math.abs(ray.veloc) * ray.taillen}`);

  const snow = weather.get('SNls');
  if (snow && snow.head && !snow.tail && !snow.additive) {
    ok(`light snow ('SNls') is a HEAD billboard and the ONLY alphaMode 0 in the corpus's set — solid flakes, alpha-blended, not additive`);
  } else fail(`SNls: ${JSON.stringify(snow && { head: snow.head, additive: snow.additive })}`);
  const wind = weather.get('WOlw');
  if (wind && wind.texRows === 8 && wind.texCols === 8 && wind.uvEnd === 63) {
    ok(`Outland wind ('WOlw') is an 8×8 sprite ATLAS (clouds8x8) whose frame walks 0 → 32 → 63 across the sheet over the particle's life`);
  } else fail(`WOlw atlas: ${JSON.stringify(wind && { r: wind.texRows, c: wind.texCols, uvEnd: wind.uvEnd })}`);
  const fog = weather.get('FDwl');
  if (fog && fog.alphaStart === 0 && fog.alphaMid === 16 && fog.alphaEnd === 0 && fog.scaleStart === 20 && fog.scaleEnd === 100) {
    ok(`dungeon fog ('FDwl') fades IN and OUT (alpha 0 → 16 → 0) while swelling 20 → 100 units — the three-key ramps are per-particle, over its life`);
  } else fail(`FDwl ramps: ${JSON.stringify(fog && { a: [fog.alphaStart, fog.alphaMid, fog.alphaEnd], s: [fog.scaleStart, fog.scaleEnd] })}`);
  if (rain.ambientSound === 'AmbientSoundRain' && fog.ambientSound === null) {
    ok(`the ambient bed comes off the table too — rain carries "AmbientSoundRain", fog's "-" is correctly read as NO sound (the SLK's dash-for-empty)`);
  } else fail(`ambient: ${rain.ambientSound} / ${fog.ambientSound}`);

  // --- the natives ------------------------------------------------------------------
  let added = null, enabled = null, removed = null;
  let nextId = 1;
  const live = new Map();
  const hooks = {
    addWeatherEffect: (effectId, area) => {
      if (!weather.get(effectId)) return -1;
      const id = nextId++;
      live.set(id, { effectId, area, enabled: false });
      added = { id, effectId, area };
      return id;
    },
    enableWeatherEffect: (id, on) => { live.get(id).enabled = on; enabled = { id, on }; },
    removeWeatherEffect: (id) => { live.delete(id); removed = id; },
  };
  const SRC = `
globals
    weathereffect udg_we    = null
    weathereffect udg_bogus = null
endglobals
// Verbatim in shape from (6)UpperKingdom's own CreateRegions() — this is what the World
// Editor compiles a placed weather region into, and it is why 40 maps want this.
function MakeSnow takes nothing returns nothing
    set udg_we = AddWeatherEffect( Rect(-512.0, -512.0, 512.0, 512.0), 'SNls' )
    call EnableWeatherEffect( udg_we, true )
endfunction
function StopSnow takes nothing returns nothing
    call EnableWeatherEffect( udg_we, false )
endfunction
function Clean takes nothing returns nothing
    call RemoveWeatherEffect( udg_we )
endfunction
// A weather id we don't know must not crash the map — it just gets no weather.
function Bogus takes nothing returns nothing
    set udg_bogus = AddWeatherEffect( Rect(0.0, 0.0, 1.0, 1.0), 'ZZZZ' )
endfunction
`;
  const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks });
  const rt = interp.rt;
  interp.run('InitBlizzard', []);

  interp.run('MakeSnow', []);
  if (added && added.effectId === 'SNls' && added.area.minX === -512 && added.area.maxY === 512) {
    ok(`AddWeatherEffect(rect, 'SNls') reaches the engine with the rawcode and the rect's real bounds`);
  } else fail(`added: ${JSON.stringify(added)}`);
  // The same "created, not started" shape the fog modifiers have (7.22): the editor always
  // emits EnableWeatherEffect on the very next line, which would be pointless otherwise.
  if (enabled && enabled.on === true && live.get(added.id).enabled === true) {
    ok(`...and EnableWeatherEffect(we, true) is what actually STARTS it — AddWeatherEffect alone creates it disabled`);
  } else fail(`enabled: ${JSON.stringify(enabled)}`);
  interp.run('StopSnow', []);
  if (live.get(added.id).enabled === false) {
    ok(`EnableWeatherEffect(we, false) switches the storm off without destroying it (a map toggles one on and off)`);
  } else fail(`still enabled`);
  interp.run('Clean', []);
  if (removed === added.id && !live.has(added.id)) {
    ok(`RemoveWeatherEffect destroys it`);
  } else fail(`removed: ${removed}`);
  interp.run('Bogus', []);
  if (rt.globals.get('udg_bogus').k === 'null' || rt.globals.get('udg_bogus').h === 0) {
    ok(`an UNKNOWN weather id hands back a null handle rather than crashing the map (CLAUDE.md: never hard-crash)`);
  } else fail(`bogus handle: ${JSON.stringify(rt.globals.get('udg_bogus'))}`);
}

// Mirrors src/ui/timerDialog.ts formatTimerValue — Game.dll carries exactly two countdown
// formats (`%d:%02d` and `%02d:%02d:%02d`), so under an hour is M:SS and over is HH:MM:SS.
function formatTimerValueCheck(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
