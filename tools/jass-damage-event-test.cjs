// The 1.31 damage events' JASS half (Interpreter.fireDamagePhase, natives/events.ts), through the
// real interpreter against the install's own common.j and Blizzard.j with our compat prelude —
// the handlers a Damage Engine registers, changing a blow the sim hands them.
//
//   * DAMAGING reaches EVENT_PLAYER_UNIT_DAMAGING / EVENT_UNIT_DAMAGING, DAMAGED the classic pair;
//   * BlzSetEventDamage changes the blow, and GetEventDamage reads back what was set (jassbot);
//   * the attack/damage/weapon TYPES change only before resistances, and answer false after;
//   * the weapon type is joined to our data's sound names through common.j's own constant names;
//   * the script is recognised as one that can change a blow (scriptModifiesDamage).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-damage-event-test.cjs
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
const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j and Blizzard.j.");
  process.exit(2);
}
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const common = decode(readFileSync(join(SCRIPTS, 'common.j')));
const blizzard = decode(readFileSync(join(SCRIPTS, 'Blizzard.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};

let next = 1;
const hooks = { createUnit: () => next++ };
const SRC = `
globals
    unit victim = null
    real seenBefore = 0.0
    real seenAfterSet = 0.0
    boolean typeSetLate = true
    integer damagedAmount = 0
    integer weaponIdx = -1
endglobals
function OnDamaging takes nothing returns nothing
    set seenBefore = GetEventDamage()
    call BlzSetEventDamage(GetEventDamage() * 3.0)
    set seenAfterSet = GetEventDamage()
    call BlzSetEventAttackType(ATTACK_TYPE_CHAOS)
    call BlzSetEventDamageType(DAMAGE_TYPE_FIRE)
    call BlzSetEventWeaponType(WEAPON_TYPE_WOOD_HEAVY_BASH)
endfunction
function OnDamaged takes nothing returns nothing
    set damagedAmount = R2I(GetEventDamage())
    set typeSetLate = BlzSetEventAttackType(ATTACK_TYPE_MAGIC)
    call BlzSetEventDamage(1.0)
endfunction
function Setup takes nothing returns nothing
    local trigger t = CreateTrigger()
    set victim = CreateUnit(Player(1), 'hfoo', 0.0, 0.0, 0.0)
    call TriggerRegisterAnyUnitEventBJ(t, EVENT_PLAYER_UNIT_DAMAGING)
    call TriggerAddAction(t, function OnDamaging)
    set t = CreateTrigger()
    call TriggerRegisterUnitEvent(t, victim, EVENT_UNIT_DAMAGED)
    call TriggerAddAction(t, function OnDamaged)
endfunction
function Get takes nothing returns real
    return seenBefore
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks });
interp.callFunction('Setup', []);
[console.info, console.warn] = quiet;
const g = (name) => interp.rt.globals.get(name);

const victimId = interp.rt.data(g('victim')).simId;
const blow = { target: { id: victimId, owner: 1, typeId: 'hfoo', x: 0, y: 0, facing: 0 }, source: null, amount: 40, attackType: 'normal', damageType: 4, weaponSound: 'MetalMediumSlice' };

console.log('--- DAMAGING, before resistances ---');
interp.fireDamagePhase('damaging', blow);
check('the handler saw the raw blow', g('seenBefore').n, 40);
check('BlzSetEventDamage changed it', blow.amount, 120);
check('…and GetEventDamage read back what was set', g('seenAfterSet').n, 120);
check('BlzSetEventAttackType took (ATTACK_TYPE_CHAOS)', blow.attackType, 'chaos');
check('BlzSetEventDamageType took (DAMAGE_TYPE_FIRE)', blow.damageType, interp.rt.enumIndex(g('DAMAGE_TYPE_FIRE')));
check("the weapon type crossed by common.j's own name (WEAPON_TYPE_WOOD_HEAVY_BASH)", blow.weaponSound, 'WoodHeavyBash');

console.log('\n--- DAMAGED, after them ---');
blow.amount = 84;
interp.fireDamagePhase('damaged', blow);
check('the per-unit EVENT_UNIT_DAMAGED handler saw the final amount', g('damagedAmount').n, 84);
check('a TYPE cannot change after resistances (false)', g('typeSetLate').b, false);
check('…the amount still can', blow.amount, 1);
check('outside an event there is no blow to change', interp.rt.damageStack.length, 0);

console.log('\n--- which scripts get the synchronous path ---');
check('a script that calls BlzSetEventDamage can change a blow', interp.scriptModifiesDamage(), true);
console.info = () => {};
const plain = buildInterpreter([common, COMPAT_PRELUDE, blizzard, 'function Quiet takes nothing returns real\n    return GetEventDamage()\nendfunction\n'], { hooks });
console.info = quiet[0];
check('one that only READS damage cannot (it keeps the queued events)', plain.scriptModifiesDamage(), false);

console.log(failures ? `\n${failures} failure(s).` : '\nAll damage-event checks passed.');
process.exit(failures ? 1 : 0);
