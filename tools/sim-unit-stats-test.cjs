// Headless check of the `BlzGetUnit…`/`BlzSetUnit…` stat accessors' SIM half —
// `SimWorld.unitStat` / `setUnitStat` (docs/map-compatibility.md pass 3).
//
// What is pinned is which BASE each setter means, because that is the whole design:
//
//   * max life, max mana and armour are TOTALS, so the setter solves the base UNDER whatever
//     bonus is on the unit right now — sourced for armour ("only possible to get/set total",
//     hiveworkshop 319734: set 0 under a +100 aura and the base becomes −100);
//   * `BlzSetUnitMaxHP` keeps the life POOL absolute (hiveworkshop 317026 tells a map to restore
//     the percentage itself), where the sim's own rule for a moving ceiling is to scale it;
//   * a weapon's damage is the editor's "Damage Base" — a hero's starting primary attribute is
//     folded into the sim's copy at parse time and has to come back out;
//   * a weapon is found by its SLOT, and the sim's weapon list skips unarmed slots, so a unit
//     whose only attack is slot 2 has it at index 0.
//
// And that a write SURVIVES — every value here is set, then `recomputeStats` is run again, which
// is what undoes a setter that wrote the derived number instead of the base.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const N = 128;
const world = new SimWorld(
  new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  { get: () => undefined, has: () => false, buffFx: () => [] },
  { get: () => undefined, has: () => false },
  { get: () => ({ priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2 }), has: () => false },
);

const weapon = (slot, over = {}) => ({
  slot, damage: 20, dice: 1, sides: 6, cooldown: 1.35, damagePoint: 0.5, backswing: 0.5, range: 90,
  rangeBuffer: 250, baseDamage: 20, baseDice: 1, baseRange: 90, baseCooldown: 1.35,
  baseDamagePoint: 0.5, baseBackswing: 0.5, enabled: true, targets: ["ground"], ...over,
});
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 400, maxHp: 400, mana: 100, maxMana: 100, buffs: [], inventory: [],
    weapons: [weapon(0)], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    baseInvulnerable: false, neutralPassive: false, isIllusion: false, isSummon: false,
    race: "human", level: 1, xp: 0, xpSuspended: false, skillPoints: 0, hpRegen: 0, manaRegen: 0,
    baseMaxHp: 400, baseMaxMana: 100, baseHpRegen: 0, baseManaRegen: 0, baseArmor: 2, armor: 2,
    baseSpeed: 270, speed: 270, radius: 16, footprint: 0, order: "idle", targetId: null, path: [],
    waypoint: 0, moving: false, facing: 0, stunned: false, magicImmune: false, detectRadius: 0,
    summonLeft: 0, immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0,
    str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0, primaryAttr: "",
    ...over,
  };
  u.weapon = u.weapons[0] ?? null;
  world.units.set(u.id, u);
  world.recomputeStats(u);
  return u;
}

let failed = 0;
function check(what, got, want) {
  const ok = typeof want === "number" && typeof got === "number" ? Math.abs(got - want) < 1e-6 : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `\n        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
}

// --- 1. armour is a TOTAL, and the base is solved under the bonus --------------------------
{
  const u = unit();
  u.buffs.push({ kind: "armor", value: 5, abilityId: "AHad", timeLeft: -1 }); // a Devotion-Aura-sized bonus
  world.recomputeStats(u);
  check("armour reads the total, bonus included", world.unitStat(u.id, "armor"), 7);
  world.setUnitStat(u.id, "armor", 10);
  check("BlzSetUnitArmor(10) reads back 10", world.unitStat(u.id, "armor"), 10);
  check("…by solving the BASE under the +5", u.baseArmor, 5);
  world.recomputeStats(u);
  check("…and a tick does not undo it", u.armor, 10);
  // The sourced case, in miniature: set 0 under a bonus and the base goes NEGATIVE.
  world.setUnitStat(u.id, "armor", 0);
  check("setting 0 under a +5 leaves the base at −5", u.baseArmor, -5);
  u.buffs.length = 0;
  world.recomputeStats(u);
  check("…so when the bonus leaves, the total is −5", u.armor, -5);
}

// --- 2. max life is a TOTAL, and the POOL is held absolute ----------------------------------
{
  const u = unit({ hp: 300 });
  world.setUnitStat(u.id, "maxHp", 800);
  check("BlzSetUnitMaxHP(800) reads back 800", world.unitStat(u.id, "maxHp"), 800);
  check("…and the life pool did NOT scale with it", u.hp, 300);
  world.recomputeStats(u);
  check("…through a tick", u.maxHp, 800);
  world.setUnitStat(u.id, "maxHp", 200);
  check("a ceiling below the pool clamps the pool", u.hp, 200);
  world.setUnitStat(u.id, "maxMana", 250);
  check("max mana is the same rule", world.unitStat(u.id, "maxMana"), 250);
}

// --- 3. a hero's damage is the editor's "Damage Base" ----------------------------------------
// Blademaster-shaped: 18 agility primary, and data/units.ts folds that 18 into `dmgplus`, so the
// sim's `baseDamage` is 18 higher than the column the map is talking about.
{
  const u = unit({
    isHero: true, primaryAttr: "AGI",
    startAgi: 18, baseAgi: 18, agi: 18, startStr: 18, baseStr: 18, str: 18,
    weapons: [weapon(0, { baseDamage: 25 + 18, damage: 25 + 18 })],
  });
  check("BlzGetUnitBaseDamage is the column WITHOUT the folded primary", world.unitStat(u.id, "baseDamage", 0), 25);
  world.setUnitStat(u.id, "baseDamage", world.unitStat(u.id, "baseDamage", 0) + 15, 0);
  check("the corpus's read-modify-write adds exactly 15", world.unitStat(u.id, "baseDamage", 0), 40);
  check("…with the primary still folded underneath", u.weapons[0].baseDamage, 40 + 18);
  world.recomputeStats(u);
  check("…through a tick", world.unitStat(u.id, "baseDamage", 0), 40);
}

// --- 4. a weapon is found by its SLOT, not its place in the list --------------------------
// A unit whose only attack is slot 2 — the list skips the unarmed slot 1, so it sits at index 0.
{
  const u = unit({ weapons: [weapon(1, { baseDamage: 30, damage: 30 })] });
  check("slot 2 (index 1) is found where the list put it", world.unitStat(u.id, "baseDamage", 1), 30);
  check("slot 1 is not there at all", world.unitStat(u.id, "baseDamage", 0), undefined);
  check("…and cannot be written", world.setUnitStat(u.id, "baseDamage", 99, 0), false);
  check("…so slot 2 kept its value", u.weapons[0].baseDamage, 30);
}

// --- 5. the rest of a weapon's columns, and that they survive a tick -----------------------
{
  const u = unit();
  world.setUnitStat(u.id, "attackCooldown", 0.9, 0);
  world.setUnitStat(u.id, "diceNumber", 3, 0);
  world.setUnitStat(u.id, "diceSides", 4, 0);
  world.recomputeStats(u);
  check("BlzSetUnitAttackCooldown writes the BASE cooldown", world.unitStat(u.id, "attackCooldown", 0), 0.9);
  check("…and the swing clock is derived from it", u.weapons[0].cooldown, 0.9);
  check("dice number", world.unitStat(u.id, "diceNumber", 0), 3);
  check("dice sides", world.unitStat(u.id, "diceSides", 0), 4);
  check("…and the live roll uses them", u.weapons[0].dice, 3);
}

// --- 6. invulnerable is a read, and nothing is written for a unit that is not there ----------
{
  const u = unit({ baseInvulnerable: true });
  check("BlzIsUnitInvulnerable reads the live flag", world.unitStat(u.id, "invulnerable"), true);
  check("a unit that is not there has no stats", world.unitStat(9999, "maxHp"), undefined);
  check("…and takes no writes", world.setUnitStat(9999, "maxHp", 5), false);
  check("a non-number is refused", world.setUnitStat(u.id, "maxHp", NaN), false);
}

// --- 7. the acquisition range: SetUnitAcquireRange used to do NOTHING ------------------------
// The native was registered and its hook declared, so coverage counted it done — and no engine
// ever answered it. Test of Faith pairs it with GetUnitDefaultAcquireRange to reset a unit.
{
  const u = unit({ weapons: [weapon(0, { acquire: 500 })], scriptAcquire: -1 });
  check("a unit's own range is its weapon's acquire", world.getUnitAcquireRange(u.id), 500);
  world.setUnitAcquireRange(u.id, 1200);
  check("SetUnitAcquireRange is read back", world.getUnitAcquireRange(u.id), 1200);
  check("…and is the range it auto-acquires at", world.acquireRange(u), 1200);
  world.setUnitAcquireRange(u.id, -50);
  check("a negative range is none", world.getUnitAcquireRange(u.id), 0);
  const worker = unit({ weapons: [weapon(0, { acquire: 500 })], scriptAcquire: -1, isPeon: true });
  world.setUnitAcquireRange(worker.id, 900);
  check("a worker still picks no fights of its own — the range replaces the range, not the gates", world.acquireRange(worker), 0);
  check("…though the range it was SET to reads back", world.getUnitAcquireRange(worker.id), 900);
  const creep = unit({ isCreep: true, aggroRange: 200, scriptAcquire: -1 });
  check("a creep's own range is its camp's aggro range", world.getUnitAcquireRange(creep.id), 200);
  world.setUnitAcquireRange(creep.id, 700);
  check("…and a script's range moves the camp's aggro range with it", creep.aggroRange, 700);
  check("a unit that is not there has none", world.getUnitAcquireRange(9999), undefined);
}

console.log(failed ? `\n${failed} FAILED` : "\nall unit-stat checks passed");
process.exit(failed ? 1 : 0);
