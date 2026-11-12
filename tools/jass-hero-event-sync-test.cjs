// Hero events a NATIVE causes fire from inside the native (NativeCtx.flushHeroEvents).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-hero-event-sync-test.cjs
//
// `SelectHeroSkill`, `SetHeroLevel` and `AddHeroXP` raise EVENT_(PLAYER_)HERO_SKILL / _LEVEL
// before they return, and a script's re-entry guard depends on it:
//
//     call DisableTrigger(GetTriggeringTrigger())
//     call SelectHeroSkill(clone, GetLearnedSkill())
//     call EnableTrigger(GetTriggeringTrigger())
//
// DotA's Geomancer is that shape exactly — learning Divided We Stand makes a clone and teaches
// every clone the skill. With the event left to the frame's pump it arrived after
// EnableTrigger, so each clone's lesson made another clone: 1 000 Geomancers in ten game
// seconds. Here the same trigger runs against a stand-in sim that queues events the way
// SimWorld does, and must run exactly once.
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
const common = new TextDecoder('windows-1252').decode(readFileSync(join(SCRIPTS, 'common.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

// The stand-in sim: a learn or a level queues an event, exactly as SimWorld's does.
const snap = (id) => ({ id, typeId: 'Hpal', owner: 1, x: 0, y: 0, facing: 0 });
let queue = [];
const hooks = {
  selectHeroSkill: (id, abilityId) => void queue.push({ hero: snap(id), phase: 'skill', level: 1, abilityId }),
  setHeroLevel: (id, level) => void queue.push({ hero: snap(id), phase: 'level', level, abilityId: '' }),
  drainHeroEvents: () => { const out = queue; queue = []; return out; },
};
const src = `
globals
    unit clone = null
    integer learned = 0
    integer levelled = 0
    integer levelSeenInside = -1
endglobals
function OnLearn takes nothing returns nothing
    set learned = learned + 1
    call DisableTrigger(GetTriggeringTrigger())
    call SelectHeroSkill(clone, GetLearnedSkill())
    call EnableTrigger(GetTriggeringTrigger())
endfunction
function OnLevel takes nothing returns nothing
    set levelled = levelled + 1
endfunction
function Setup takes unit c returns nothing
    local trigger t = CreateTrigger()
    set clone = c
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_HERO_SKILL, null)
    call TriggerAddAction(t, function OnLearn)
    set t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_HERO_LEVEL, null)
    call TriggerAddAction(t, function OnLevel)
endfunction
function LevelThenLook takes unit h returns nothing
    call SetHeroLevel(h, 5, false)
    set levelSeenInside = levelled
endfunction
`;
const interp = buildInterpreter([common, src], { hooks });
const rt = interp.rt;
const g = (n) => rt.globals.get(n)?.n;
const hero = rt.unitForSim(snap(21));
const clone = rt.unitForSim(snap(22));
interp.callFunction('Setup', [clone]);

console.log('a guarded re-entry');
// The player teaches the hero a skill: the sim queues it and the frame pumps it.
interp.pumpHeroEvents([{ hero: snap(21), phase: 'skill', level: 1, abilityId: 'AHhb' }]);
check('the trigger ran once — the clone\'s lesson arrived while it was disabled', g('learned'), 1);
check('…and nothing is left for the frame to raise after it is enabled again', queue.length, 0);

console.log('\nthe event precedes the native\'s return');
interp.callFunction('LevelThenLook', [hero]);
check('EVENT_PLAYER_HERO_LEVEL had fired by the line after SetHeroLevel', g('levelSeenInside'), 1);

console.log(failures ? `\n${failures} FAILED` : '\nall hero-event checks passed');
process.exit(failures ? 1 : 0);
