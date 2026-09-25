// The unit-LIFECYCLE natives through the real interpreter (docs/map-compatibility.md passes 6 and
// 7): the summon EVENT (EVENT_(PLAYER_)UNIT_SUMMON, `GetSummonedUnit`, `GetSummoningUnit`),
// `UnitApplyTimedLife`, and `ReviveHero` / `ReviveHeroLoc`.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-summon-test.cjs
//
// What is pinned is who the event is ABOUT. The install words it "'Spawns A Summoned Unit'", with
// the spawner as the "A unit" — the triggering unit (UI\TriggerStrings.txt's hints for the two
// responses; hiveworkshop 264641). So `GetTriggerUnit` is the SUMMONER, a unit-scoped registration
// on the summoner fires and one on the summoned unit does not, and the player event is filed under
// the summoner's owner. Get that backwards and a map's "my hero summoned something" trigger fires
// for the wrong player.
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

// Sim ids: 1 = the Far Seer (player 2), 2 = the wolf it summons (player 2).
let nextSim = 1;
const timed = [];
const revived = [];
const hooks = {
  createUnit: () => nextSim++,
  applyTimedLife: (id, s, buff) => timed.push([id, s, buff]),
  // The engine answers false for a hero that is not dead — the native must pass that through.
  reviveHero: (id, x, y, eyeCandy) => { revived.push([id, x, y, eyeCandy]); return id === 1; },
};
const snap = (id, owner) => ({ id, typeId: id === 1 ? 'Ofar' : 'osw1', owner, x: 0, y: 0, facing: 0 });

const SRC = `
globals
    unit seer = null
    unit wolf = null
    integer byPlayer = 0
    integer byOtherPlayer = 0
    integer onSeer = 0
    integer onWolf = 0
    boolean triggerIsSeer = false
    boolean summoningIsSeer = false
    boolean summonedIsWolf = false
endglobals
function OnPlayer takes nothing returns nothing
    set byPlayer = byPlayer + 1
    set triggerIsSeer = GetTriggerUnit() == seer
    set summoningIsSeer = GetSummoningUnit() == seer
    set summonedIsWolf = GetSummonedUnit() == wolf
endfunction
function OnOther takes nothing returns nothing
    set byOtherPlayer = byOtherPlayer + 1
endfunction
function OnSeer takes nothing returns nothing
    set onSeer = onSeer + 1
endfunction
function OnWolf takes nothing returns nothing
    set onWolf = onWolf + 1
endfunction
function Make takes nothing returns nothing
    local trigger t
    set seer = CreateUnit(Player(2), 'Ofar', 0.0, 0.0, 0.0)
    set wolf = CreateUnit(Player(2), 'osw1', 0.0, 0.0, 0.0)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(2), EVENT_PLAYER_UNIT_SUMMON, null)
    call TriggerAddAction(t, function OnPlayer)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(5), EVENT_PLAYER_UNIT_SUMMON, null)
    call TriggerAddAction(t, function OnOther)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, seer, EVENT_UNIT_SUMMON)
    call TriggerAddAction(t, function OnSeer)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, wolf, EVENT_UNIT_SUMMON)
    call TriggerAddAction(t, function OnWolf)
endfunction
function Dummy takes nothing returns nothing
    call UnitApplyTimedLife(wolf, 'BTLF', 2.5)
endfunction
function ReviveSeer takes nothing returns boolean
    return ReviveHero(seer, 300.0, -400.0, true)
endfunction
function ReviveSeerLoc takes nothing returns boolean
    return ReviveHeroLoc(seer, Location(-50.0, 75.0), false)
endfunction
function ReviveWolf takes nothing returns boolean
    return ReviveHero(wolf, 0.0, 0.0, true)
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, SRC], { hooks });
interp.callFunction('Make', []);
[console.info, console.warn] = quiet;
const g = (n) => interp.rt.globals.get(n);

interp.pumpSummonEvents([{ summoner: snap(1, 2), summoned: snap(2, 2) }]);

console.log('--- who the event is about ---');
check('GetTriggerUnit is the SUMMONER', g('triggerIsSeer').b, true);
check('GetSummoningUnit is the summoner', g('summoningIsSeer').b, true);
check('GetSummonedUnit is the new unit', g('summonedIsWolf').b, true);

console.log('\n--- which registrations fire ---');
check("the summoner's player event fires", g('byPlayer').n, 1);
check("another player's does not", g('byOtherPlayer').n, 0);
check('a unit event on the summoner fires', g('onSeer').n, 1);
check('a unit event on the SUMMONED unit does not', g('onWolf').n, 0);

console.log('\n--- UnitApplyTimedLife ---');
interp.callFunction('Dummy', []);
check('the duration reaches the engine for that unit', JSON.stringify(timed[0].slice(0, 2)), JSON.stringify([2, 2.5]));
// The buff names the clock's bar in the info panel ('BTLF' is [Btlf] Bufftip=Timed Life).
check('…with the buff the script named', timed[0][2], 'BTLF');

console.log('\n--- ReviveHero / ReviveHeroLoc (pass 7) ---');
check('ReviveHero returns what the engine answered', interp.callFunction('ReviveSeer', []).b, true);
check('…for the hero behind the handle, at the point, with eye candy', JSON.stringify(revived[0]), JSON.stringify([1, 300, -400, true]));
interp.callFunction('ReviveSeerLoc', []);
check('ReviveHeroLoc unpacks the location and the flag', JSON.stringify(revived[1]), JSON.stringify([1, -50, 75, false]));
check('a unit the engine will not revive answers false', interp.callFunction('ReviveWolf', []).b, false);

console.log(failures ? `\n${failures} failure(s).` : '\nAll lifecycle-native checks passed.');
process.exit(failures ? 1 : 0);
