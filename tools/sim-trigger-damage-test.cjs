// Headless check of the SIM entry points behind two map-compatibility passes: trigger-dealt
// damage (`SimWorld.damageTarget` ← `UnitDamageTarget`, pass 2) and the range question
// (`unitInRange`/`unitInRangeXY` ← `IsUnitInRange`, pass 4). Both are arithmetic a native can
// only pass through, which is why they are pinned here rather than in the natives' own test.
//
// This is how a custom map's spells deal damage at all: a map that rebuilt its spells on
// unrelated bases does its own arithmetic and then calls the native. 38 call sites across the
// eleven maps in the install's own `Maps\Download`, 24 of them DotA's.
//
// What is pinned here is the three ways it is NOT a swing:
//   * it carries the damage TABLE and the target's ARMOUR, because that is what passing an
//     `attacktype` is for…
//   * …but none of a swing's rolled procs, and it makes no weapon-on-armour clang unless the
//     native's own `attack` flag says it was one; and
//   * `DAMAGE_TYPE_UNIVERSAL` bypasses both multipliers AND magic immunity, which is the only
//     thing in the damagetype enum that changes the number.
//
// The expected multipliers are COMPUTED from the game's own table rather than transcribed, so
// this cannot drift from `Units\MiscGame.txt` (CLAUDE.md: never hand-transcribe a derived value).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { damageMultiplier, armorDamageReduction } = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));
const { AttackType, ArmorType } = require(join(REPO, ".sim-build", "src", "data", "enums.js"));

const N = 128;
const newWorld = () =>
  new SimWorld(new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
    { get: () => undefined, has: () => false, buffFx: () => [] },
    { get: () => undefined, has: () => false },
    { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => false });

let world = newWorld();
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, buffs: [], inventory: [], weapons: [], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    neutralPassive: false, isIllusion: false, isSummon: false, race: "human", level: 1, xp: 0,
    xpSuspended: false, skillPoints: 0, hpRegen: 0, manaRegen: 0, baseMaxHp: 1000, baseMaxMana: 0,
    baseHpRegen: 0, baseManaRegen: 0, baseArmor: 0, armor: 0, armorType: ArmorType.Medium,
    baseSpeed: 270, speed: 270, radius: 16, footprint: 0, order: "idle", targetId: null,
    path: [], waypoint: 0, moving: false, facing: 0, pendingCast: null, followLeaderId: null,
    inCombat: false, working: false, atNode: false, noCollision: false, stallT: 0, waitT: 0,
    gaveUp: false, acquireT: 0, arrowShot: null, constructing: 0, cooldownLeft: 0, linkT: 0,
    linkGroup: [], repathT: 0, stunned: false, magicImmune: false, detectRadius: 0, summonLeft: 0,
    immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false, illusionDamageTaken: 1,
    garrison: [], orderQueue: [], itemCooldowns: new Map(),
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0,
    str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0, primaryAttr: 0,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const NORMAL = { attack: true, ranged: false, attackType: AttackType.Normal, magic: false, universal: false };

let failed = 0;
function check(what, got, want) {
  const ok = Math.abs(got - want) < 1e-6 || got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${want}, got ${got}`}`);
}

// --- 1. the damage TABLE is applied -------------------------------------------------------
// Normal vs Medium is the table's best-known entry (×1.5) and Normal vs Fortified its worst
// (×0.7) — so the same 100 damage is two very different numbers depending only on who is hit.
// (Note which armour is which: the −30% row is FORTIFIED, not Heavy. Normal vs Heavy is a flat
// 1.0, and Heavy's real weakness is Magic at ×2.0. The expectations below are computed from
// `damageMultiplier` rather than typed, so the test is right even where a comment is not.)
{
  world = newWorld();
  const src = unit();
  const medium = unit({ armorType: ArmorType.Medium });
  const fort = unit({ armorType: ArmorType.Fort });
  const dealtM = world.damageTarget(src.id, medium.id, 100, NORMAL);
  const dealtF = world.damageTarget(src.id, fort.id, 100, NORMAL);
  check("Normal vs Medium is the table's own", dealtM, 100 * damageMultiplier(AttackType.Normal, ArmorType.Medium));
  check("Normal vs Fortified likewise", dealtF, 100 * damageMultiplier(AttackType.Normal, ArmorType.Fort));
  check("…and they are not the same number", dealtM === dealtF, false);
  check("the target lost exactly what landed", medium.hp, 1000 - dealtM);
}

// --- 2. …and so is the target's ARMOUR ----------------------------------------------------
{
  world = newWorld();
  const src = unit();
  const t = unit({ armor: 5, armorType: ArmorType.Medium });
  const dealt = world.damageTarget(src.id, t.id, 100, NORMAL);
  const want = 100 * damageMultiplier(AttackType.Normal, ArmorType.Medium) * (1 - armorDamageReduction(5));
  check("armour reduces trigger damage too", dealt, want);
}

// --- 3. magic immunity, and the one damage type that ignores it ---------------------------
{
  world = newWorld();
  const src = unit();
  const t = unit({ magicImmune: true });
  const magic = { ...NORMAL, attack: false, attackType: AttackType.Magic, magic: true };
  check("a magic-immune target takes no magic damage", world.damageTarget(src.id, t.id, 100, magic), 0);
  check("…and lost no hit points for it", t.hp, 1000);
  // Universal is the one that goes through: no table, no armour, no immunity.
  const universal = { ...magic, universal: true };
  check("DAMAGE_TYPE_UNIVERSAL goes through immunity", world.damageTarget(src.id, t.id, 100, universal), 100);
  const armoured = unit({ armor: 10, armorType: ArmorType.Large });
  check("…and past the table and the armour, undivided",
    world.damageTarget(src.id, armoured.id, 100, { ...NORMAL, universal: true }), 100);
}

// --- 4. invulnerable, dead, and nothing --------------------------------------------------
{
  world = newWorld();
  const src = unit();
  const divine = unit({ invulnerable: true });
  check("an invulnerable target takes nothing", world.damageTarget(src.id, divine.id, 500, NORMAL), 0);
  const corpse = unit({ hp: 0 });
  check("a dead one is not damaged again", world.damageTarget(src.id, corpse.id, 500, NORMAL), 0);
  check("a target that is not there is 0", world.damageTarget(src.id, 9999, 500, NORMAL), 0);
  const t = unit();
  check("zero damage is zero", world.damageTarget(src.id, t.id, 0, NORMAL), 0);
  check("…and so is negative", world.damageTarget(src.id, t.id, -50, NORMAL), 0);
  check("…and neither touched the bar", t.hp, 1000);
}

// --- 5. it is not a swing -----------------------------------------------------------------
// `hits` is the weapon-on-armour clang the renderer plays. A spell's damage out of nowhere
// makes none; the native's own `attack` flag is the only thing that says otherwise.
{
  world = newWorld();
  const src = unit();
  const t = unit();
  world.damageTarget(src.id, t.id, 50, { ...NORMAL, attack: false });
  check("a trigger's spell damage makes no hit", world.hits.length, 0);
  world.damageTarget(src.id, t.id, 50, { ...NORMAL, attack: true });
  check("…and an attack-flagged one does", world.hits.length, 1);
}

// --- 6. it kills ---------------------------------------------------------------------------
{
  world = newWorld();
  const src = unit();
  const t = unit({ hp: 40, maxHp: 1000, armor: 0, armorType: ArmorType.Medium });
  world.damageTarget(src.id, t.id, 1000, NORMAL);
  check("lethal trigger damage kills", t.hp <= 0, true);
}

// --- 7. IsUnitInRange is measured to the COLLISION ----------------------------------------
// Not centre to centre. That is what "in range" already means everywhere else in this sim
// (`distSkip`: centre distance against `bound + both radii`), and a script that asked the
// question a second way would get a different answer from the engine for the same two units
// standing still. A Tauren and a Peasant are 100 apart in different amounts of space.
{
  world = newWorld();
  const a = unit({ x: 0, y: 0, radius: 16 });
  const b = unit({ x: 300, y: 0, radius: 16 });
  check("centre to centre would be short at 290", world.unitInRange(a.id, b.id, 290), true);
  check("…because both collisions count", world.unitInRange(a.id, b.id, 267), false);
  check("the boundary is inclusive", world.unitInRange(a.id, b.id, 268), true);
  // A bigger body is in range at a distance a smaller one is not — the whole point of the rule.
  const big = unit({ x: 300, y: 0, radius: 72 });
  check("a bigger body reaches further", world.unitInRange(a.id, big.id, 215), true);
  check("…and the small one does not", world.unitInRange(a.id, b.id, 215), false);
  // The POINT form has no far-end collision to add — bare ground has none.
  check("a point counts only the unit's own radius", world.unitInRangeXY(a.id, 300, 0, 284), true);
  check("…and not a second one", world.unitInRangeXY(a.id, 300, 0, 283), false);
  check("a unit that is gone is never in range", world.unitInRange(a.id, 9999, 99999), false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall trigger-damage and range checks passed");
process.exit(failed ? 1 : 0);
