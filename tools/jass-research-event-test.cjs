// The research EVENTS through the real interpreter (issue #242): EVENT_(PLAYER_)UNIT_RESEARCH_
// START / CANCEL / FINISH (common.j 35–37 player, 72–74 unit) and their two responses,
// `GetResearchingUnit` and `GetResearched` — common.j declares both under exactly these events.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-research-event-test.cjs
//
// What is pinned is who the event is ABOUT: the RESEARCHING BUILDING. It is GetTriggerUnit and
// GetResearchingUnit, a unit-scoped registration on it fires, the player event is filed under its
// owner, and GetResearched is the upgrade's rawcode — the one line every "they finished Defend"
// trigger compares against. The sim half (who raises which phase, and when) is in
// tools/sim-production-test.cjs.
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

// Sim ids: 1 = a Barracks (player 3), 2 = another Barracks of the same player.
let nextSim = 1;
const hooks = { createUnit: () => nextSim++ };
const snap = (id, owner) => ({ id, typeId: 'hbar', owner, x: 0, y: 0, facing: 0 });

const SRC = `
globals
    unit barracks = null
    unit other = null
    integer starts = 0
    integer cancels = 0
    integer finishes = 0
    integer byOtherPlayer = 0
    integer onBarracks = 0
    integer onOther = 0
    integer researched = 0
    boolean triggerIsBarracks = false
    boolean researchingIsBarracks = false
endglobals
function OnStart takes nothing returns nothing
    set starts = starts + 1
endfunction
function OnCancel takes nothing returns nothing
    set cancels = cancels + 1
endfunction
function OnFinish takes nothing returns nothing
    set finishes = finishes + 1
    set researched = GetResearched()
    set triggerIsBarracks = GetTriggerUnit() == barracks
    set researchingIsBarracks = GetResearchingUnit() == barracks
endfunction
function OnOtherPlayer takes nothing returns nothing
    set byOtherPlayer = byOtherPlayer + 1
endfunction
function OnBarracks takes nothing returns nothing
    set onBarracks = onBarracks + 1
endfunction
function OnOther takes nothing returns nothing
    set onOther = onOther + 1
endfunction
function Make takes nothing returns nothing
    local trigger t
    set barracks = CreateUnit(Player(3), 'hbar', 0.0, 0.0, 0.0)
    set other = CreateUnit(Player(3), 'hbar', 0.0, 0.0, 0.0)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(3), EVENT_PLAYER_UNIT_RESEARCH_START, null)
    call TriggerAddAction(t, function OnStart)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(3), EVENT_PLAYER_UNIT_RESEARCH_CANCEL, null)
    call TriggerAddAction(t, function OnCancel)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(3), EVENT_PLAYER_UNIT_RESEARCH_FINISH, null)
    call TriggerAddAction(t, function OnFinish)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(4), EVENT_PLAYER_UNIT_RESEARCH_FINISH, null)
    call TriggerAddAction(t, function OnOtherPlayer)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, barracks, EVENT_UNIT_RESEARCH_FINISH)
    call TriggerAddAction(t, function OnBarracks)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, other, EVENT_UNIT_RESEARCH_FINISH)
    call TriggerAddAction(t, function OnOther)
endfunction
function OutsideEvent takes nothing returns integer
    return GetResearched()
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, SRC], { hooks });
interp.callFunction('Make', []);
[console.info, console.warn] = quiet;
const g = (n) => interp.rt.globals.get(n);
const RHDE = ((c) => [...c].reduce((n, ch) => n * 256 + ch.charCodeAt(0), 0))('Rhde');

console.log('--- each phase reaches its own event ---');
interp.pumpResearchEvents([{ building: snap(1, 3), techId: 'Rhde', phase: 'start' }]);
check('START fires the START registration', g('starts').n, 1);
check('…and not FINISH', g('finishes').n, 0);
interp.pumpResearchEvents([{ building: snap(1, 3), techId: 'Rhde', phase: 'cancel' }]);
check('CANCEL fires the CANCEL registration', g('cancels').n, 1);
interp.pumpResearchEvents([{ building: snap(1, 3), techId: 'Rhde', phase: 'finish' }]);
check('FINISH fires the FINISH registration', g('finishes').n, 1);

console.log('\n--- who the event is about ---');
check("GetResearched is the upgrade's rawcode ('Rhde')", g('researched').n, RHDE);
check('GetTriggerUnit is the researching building', g('triggerIsBarracks').b, true);
check('GetResearchingUnit is the researching building', g('researchingIsBarracks').b, true);

console.log('\n--- which registrations fire ---');
check("another player's FINISH does not", g('byOtherPlayer').n, 0);
check('a unit event on the building fires', g('onBarracks').n, 1);
check('a unit event on ANOTHER building does not', g('onOther').n, 0);
check('GetResearched outside an event is 0', interp.callFunction('OutsideEvent', []).n, 0);

console.log(failures ? `\n${failures} failure(s).` : '\nAll research-event checks passed.');
process.exit(failures ? 1 : 0);
