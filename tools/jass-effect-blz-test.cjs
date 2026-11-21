// The `BlzSetSpecialEffect…` natives' JASS half (src/jass/natives/effects.ts —
// docs/map-compatibility.md pass 10), with `GetLocationZ` and `BlzGetUnitZ` beside them: that
// each reaches the engine with the right effect, the right AXIS and the right units, and that the
// documented refusals hold.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-effect-blz-test.cjs
//
// What is pinned, by source (lep.nrw/jassbot, one page per native):
//   * every position is ABSOLUTE, and X, Y and Z each move ONLY their own axis — Test of Faith
//     sets X, then Y, then Z on one effect every tick;
//   * Height is Z ("appears to be mostly identical to BlzSetSpecialEffectZ");
//   * colour and alpha are 0–255, and "does nothing if any single parameter is invalid";
//   * ColorByPlayer takes the player's COLOUR, which SetPlayerColor can move off their slot;
//   * the animation and its tags cross as WORDS, read off the install's own common.j constants;
//   * the time scale is a MULTIPLIER (1 normal, 0 holds, negative runs back to the clip's start)
//     and the time a playhead in SECONDS that "can't be a negative value" — why not jassdoc's
//     100 = normal is in src/render/specialFxClock.ts, whose rules are checked here too;
//   * GetLocationZ asks the surface (it used to answer 0 — blizzard.j's AddLightningLoc passes
//     it as an absolute height, so every GUI bolt on raised ground was underground).
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
const J = (x) => JSON.stringify(x);

const calls = [];
const rec = (name) => (...args) => { calls.push([name, ...args]); };
const hooks = {
  createUnit: () => 9,
  addSpecialEffect: () => 4,
  setSpecialEffectPosition: rec('pos'),
  setSpecialEffectOrientation: rec('turn'),
  setSpecialEffectScale: rec('scale'),
  setSpecialEffectColor: rec('color'),
  setSpecialEffectAlpha: rec('alpha'),
  setSpecialEffectTeamColor: rec('team'),
  playSpecialEffect: rec('play'),
  specialEffectSubAnim: rec('tag'),
  setSpecialEffectTimeScale: rec('speed'),
  setSpecialEffectTime: rec('seek'),
  specialEffectPosition: (id) => (id === 4 ? { x: 11, y: 22, z: 33 } : null),
  surfaceZ: (x, y) => x + y,
  unitZ: (id) => (id === 9 ? 640 : 0),
};

const SRC = `
globals
    effect e = null
    unit u = null
endglobals
function Make takes nothing returns nothing
    set e = AddSpecialEffect("Abilities\\\\Spells\\\\Human\\\\Heal\\\\HealTarget.mdl", 0.0, 0.0)
    set u = CreateUnit(Player(0), 'hfoo', 0.0, 0.0, 0.0)
endfunction
function Axes takes nothing returns nothing
    call BlzSetSpecialEffectX(e, 100.0)
    call BlzSetSpecialEffectY(e, 200.0)
    call BlzSetSpecialEffectZ(e, BlzGetLocalUnitZ(u) + 150.0)
    call BlzSetSpecialEffectHeight(e, 75.0)
    call BlzSetSpecialEffectPosition(e, 1.0, 2.0, 3.0)
    call BlzSetSpecialEffectPositionLoc(e, Location(30.0, 40.0))
endfunction
function Turns takes nothing returns nothing
    call BlzSetSpecialEffectYaw(e, 1.5)
    call BlzSetSpecialEffectPitch(e, Deg2Rad(10.0))
    call BlzSetSpecialEffectRoll(e, 0.25)
    call BlzSetSpecialEffectOrientation(e, 1.0, 2.0, 3.0)
endfunction
function Looks takes nothing returns nothing
    call BlzSetSpecialEffectScale(e, 0.8)
    call BlzSetSpecialEffectColor(e, 255, 0, 255)
    call BlzSetSpecialEffectColor(e, 256, 0, 0)
    call BlzSetSpecialEffectAlpha(e, 128)
    call BlzSetSpecialEffectAlpha(e, -1)
    call SetPlayerColor(Player(2), PLAYER_COLOR_GREEN)
    call BlzSetSpecialEffectColorByPlayer(e, Player(2))
endfunction
function Anims takes nothing returns nothing
    call BlzSpecialEffectAddSubAnimation(e, SUBANIM_TYPE_SECOND)
    call BlzSpecialEffectAddSubAnimation(e, SUBANIM_TYPE_ALTERNATE_EX)
    call BlzSpecialEffectRemoveSubAnimation(e, SUBANIM_TYPE_SECOND)
    call BlzSpecialEffectClearSubAnimations(e)
    call BlzPlaySpecialEffect(e, ANIM_TYPE_STAND)
    call BlzPlaySpecialEffect(e, ANIM_TYPE_PORTRAIT)
endfunction
function Speeds takes nothing returns nothing
    call BlzSetSpecialEffectTimeScale(e, 0.5)
    call BlzSetSpecialEffectTimeScale(e, 0.0)
    call BlzSetSpecialEffectTimeScale(e, -1.0)
    call BlzSetSpecialEffectTime(e, 0.51)
    call BlzSetSpecialEffectTime(e, -3.0)
    call BlzPlaySpecialEffectWithTimeScale(e, ANIM_TYPE_DEATH, 2.0)
endfunction
function Nulls takes nothing returns nothing
    call BlzSetSpecialEffectScale(null, 2.0)
    call BlzPlaySpecialEffect(null, ANIM_TYPE_STAND)
    call BlzSetSpecialEffectTimeScale(null, 2.0)
    call BlzSetSpecialEffectTime(null, 1.0)
    call BlzPlaySpecialEffectWithTimeScale(null, ANIM_TYPE_STAND, 2.0)
endfunction
function EX takes nothing returns real
    return BlzGetLocalSpecialEffectX(e)
endfunction
function EZ takes nothing returns real
    return BlzGetLocalSpecialEffectZ(e)
endfunction
function LocZ takes nothing returns real
    return GetLocationZ(Location(100.0, 20.0))
endfunction
function NullLocZ takes nothing returns real
    return GetLocationZ(null)
endfunction
function UnitZ takes nothing returns real
    return BlzGetUnitZ(u)
endfunction
function NullUnitZ takes nothing returns real
    return BlzGetUnitZ(null)
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, SRC], { hooks });
interp.callFunction('Make', []);
[console.info, console.warn] = quiet;
const call = (fn) => interp.callFunction(fn, []);

console.log('--- position: absolute, one axis at a time ---');
call('Axes');
check('X moves only X', J(calls[0]), J(['pos', 4, 100, null, null]));
check('Y moves only Y', J(calls[1]), J(['pos', 4, null, 200, null]));
check('Z is absolute — the corpus adds BlzGetLocalUnitZ itself', J(calls[2]), J(['pos', 4, null, null, 790]));
check('Height is Z', J(calls[3]), J(['pos', 4, null, null, 75]));
check('Position sets all three', J(calls[4]), J(['pos', 4, 1, 2, 3]));
check('PositionLoc stands it on the surface there', J(calls[5]), J(['pos', 4, 30, 40, 70]));

console.log('\n--- orientation, in radians ---');
calls.length = 0;
call('Turns');
check('Yaw turns only the yaw', J(calls[0]), J(['turn', 4, 1.5, null, null]));
check('Pitch arrives in radians', Math.round(calls[1][3] * 1e4) / 1e4, Math.round((10 * Math.PI / 180) * 1e4) / 1e4);
check('Roll turns only the roll', J(calls[2]), J(['turn', 4, null, null, 0.25]));
check('Orientation sets all three', J(calls[3]), J(['turn', 4, 1, 2, 3]));

console.log('\n--- look ---');
calls.length = 0;
call('Looks');
check('scale', J(calls[0]), J(['scale', 4, 0.8]));
check('colour in 0–255', J(calls[1]), J(['color', 4, 255, 0, 255]));
check('an out-of-range channel does NOTHING — the next call is the alpha', calls[2][0], 'alpha');
check('alpha in 0–255', J(calls[2]), J(['alpha', 4, 128]));
check('…and an out-of-range alpha does nothing either', calls[3][0], 'team');
check('ColorByPlayer takes the player\'s COLOUR, not their slot (green = 6)', J(calls[3]), J(['team', 4, 6]));

console.log('\n--- animation, by name ---');
calls.length = 0;
call('Anims');
check('SUBANIM_TYPE_SECOND is "second"', J(calls[0]), J(['tag', 4, 'second', true]));
check('ALTERNATE_EX is the "alternate" the world models spell', J(calls[1]), J(['tag', 4, 'alternate', true]));
check('remove', J(calls[2]), J(['tag', 4, 'second', false]));
check('clear', J(calls[3]), J(['tag', 4, null, false]));
check('ANIM_TYPE_STAND plays "stand"', J(calls[4]), J(['play', 4, 'stand']));
check('ANIM_TYPE_PORTRAIT plays "portrait"', J(calls[5]), J(['play', 4, 'portrait']));

console.log('\n--- speed and playhead ---');
calls.length = 0;
call('Speeds');
check('TimeScale 0.5 reaches the engine as 0.5 — a multiplier, not a percent', J(calls[0]), J(['speed', 4, 0.5]));
check('TimeScale 0 holds the frame', J(calls[1]), J(['speed', 4, 0]));
check('a negative TimeScale crosses as it is (it runs the clip backwards)', J(calls[2]), J(['speed', 4, -1]));
check('Time is seconds into the clip', J(calls[3]), J(['seek', 4, 0.51]));
check('a negative Time is the clip\'s start ("can\'t be a negative value")', J(calls[4]), J(['seek', 4, 0]));
check('PlayWithTimeScale plays the clip...', J(calls[5]), J(['play', 4, 'death']));
check('...then sets the same speed TimeScale does', J(calls[6]), J(['speed', 4, 2]));

const clock = require(join(REPO, '.jass-build', 'src', 'render', 'specialFxClock.js'));
const iv = [1000, 2000]; // a one-second clip at model frames 1000–2000
check('a scale of 1 ages the effect in real time', clock.ageAfter(0.25, 0.1, 1, false).toFixed(3), '0.350');
check('a scale of 0.5 ages it at half speed', clock.ageAfter(0.25, 0.1, 0.5, false).toFixed(3), '0.300');
check('a scale of 0 holds it', clock.ageAfter(0.25, 0.1, 0, true), 0.25);
check('backwards in its Birth rewinds the age...', clock.ageAfter(0.25, 0.1, -1, false).toFixed(3), '0.150');
check('...but never below 0', clock.ageAfter(0.05, 0.1, -1, false), 0);
check('backwards in its Stand leaves the age alone (the CLIP rewinds, not the life)', clock.ageAfter(3, 0.1, -1, true), 3);
check('seek 0.51 s into the clip', clock.seekFrame(iv, 0.51), 1510);
check('a 0–1 progress-bar percentage on a one-second clip', clock.seekFrame(iv, 0.25), 1250);
check('past the end holds the last frame', clock.seekFrame(iv, 100), 2000);
check('a backwards clip runs back at its speed', clock.rewindFrame(1400, 0.1, -2, iv), 1200);
check('...and stops at its first frame', clock.rewindFrame(1050, 0.1, -1, iv), 1000);

console.log('\n--- a null effect reaches nothing ---');
calls.length = 0;
call('Nulls');
check('no call for a null effect', calls.length, 0);

console.log('\n--- where things are ---');
check('BlzGetLocalSpecialEffectX', call('EX').n, 11);
check('BlzGetLocalSpecialEffectZ', call('EZ').n, 33);
check('GetLocationZ asks the SURFACE — no longer a flat 0', call('LocZ').n, 120);
check('GetLocationZ(null) is 0', call('NullLocZ').n, 0);
check('BlzGetUnitZ', call('UnitZ').n, 640);
check('BlzGetUnitZ(null) is 0', call('NullUnitZ').n, 0);

console.log(failures ? `\n${failures} failure(s).` : '\nAll special-effect native checks passed.');
process.exit(failures ? 1 : 0);
