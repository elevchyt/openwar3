// Headless check of the per-UNIT object fields (SimWorld.unitField / setUnitField — the 1.31
// `BlzGetUnit…Field` / `BlzSetUnit…Field` family, docs/map-compatibility.md). Both rebalance maps
// scale each wave's creeps with them, and their Damage Engine saves a unit's DEFENSE type,
// overrides it for one blow and writes it back — so the checks are the ones those maps lean on:
//
//   * every write lands where the engine already reads that value per unit, and SURVIVES a tick
//     of recomputeStats (a weapon's range and its Attacks Enabled switch above all);
//   * the save/override/restore round trip leaves the unit exactly as it was;
//   * a unit's own bounty is what its killer is paid;
//   * nothing leaks into the type or into another unit.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const TYPE = { priority: 0, buffType: "", abilities: [], upgradesUsed: [], moveHeight: 0, defUp: 2, bountyPlus: 20, bountyDice: 0, bountySides: 0, lumberBountyPlus: 0, lumberBountyDice: 0, lumberBountySides: 0 };
const N = 128;
const world = new SimWorld(
  new PathingGrid({ width: N, height: N, flags: new Uint8Array(N * N).fill(0x40) }, [0, 0]), 1,
  { get: () => undefined, has: () => false, buffFx: () => [] },
  { get: () => undefined, has: () => false },
  { get: () => TYPE, has: () => true },
);
const weapon = (slot, over = {}) => ({
  slot, damage: 20, dice: 1, sides: 6, cooldown: 1.35, damagePoint: 0.5, backswing: 0.5, range: 90,
  rangeBuffer: 250, baseDamage: 20, baseDice: 1, baseRange: 90, baseCooldown: 1.35,
  baseDamagePoint: 0.5, baseBackswing: 0.5, enabled: true, targets: ["ground"], attackType: "normal", ...over,
});
let nextId = 1;
function unit(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 500, y: 500, prevX: 500, prevY: 500,
    hp: 400, maxHp: 400, mana: 100, maxMana: 100, buffs: [], inventory: [],
    weapons: [weapon(0), weapon(1, { baseRange: 500, range: 500, enabled: false })], abilities: [],
    isHero: false, building: null, mechanical: false, flying: false, invulnerable: false,
    baseInvulnerable: false, neutralPassive: false, isIllusion: false, isSummon: false,
    race: "human", level: 3, xp: 0, xpSuspended: false, skillPoints: 0, hpRegen: 0, manaRegen: 0,
    baseMaxHp: 400, baseMaxMana: 100, baseHpRegen: 0, baseManaRegen: 0, baseArmor: 2, armor: 2,
    baseSpeed: 270, speed: 270, radius: 16, footprint: 0, order: "idle", targetId: null, path: [],
    waypoint: 0, moving: false, facing: 0, stunned: false, magicImmune: false, detectRadius: 0,
    summonLeft: 0, immolation: "", cloakBurnTick: 0, spellShieldCooldown: 0, vanished: false,
    baseStr: 0, baseAgi: 0, baseInt: 0, startStr: 0, startAgi: 0, startInt: 0,
    str: 0, agi: 0, int: 0, strPerLevel: 0, agiPerLevel: 0, intPerLevel: 0, primaryAttr: "",
    armorType: "large", targClass: "air", castPoint: 0.3, garrison: [],
    ...over,
  };
  u.weapon = u.weapons[0] ?? null;
  world.units.set(u.id, u);
  world.recomputeStats(u);
  return u;
}

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

console.log("the Damage Engine's save / override / restore of a DEFENSE type");
{
  const u = unit();
  const saved = world.unitField(u.id, "defenseType");
  check("a Heavy unit reads 2 (the map's own DEFENSE_TYPE_HEAVY)", saved, 2);
  world.setUnitField(u.id, "defenseType", 6); // DIVINE for this blow
  check("…overridden to Divine, the damage table's column moves", u.armorType, "divine");
  world.setUnitField(u.id, "defenseType", saved);
  check("…and written back, it is Heavy again — not Light, which a 0 would have made it", u.armorType, "large");
  check("an integer outside 0..7 is refused", world.setUnitField(u.id, "defenseType", 9), false);
}

console.log("\na wave's creep, scaled the way the rebalance maps scale them");
{
  const a = unit(), b = unit();
  world.setUnitField(a.id, "level", 3 + 6); // `BlzSetUnitIntegerFieldBJ(u, UNIT_IF_LEVEL, GetUnitLevel(u) + 6)`
  check("its level (which XP-on-kill and GetUnitLevel read)", [a.level, b.level], [9, 3]);
  world.setUnitField(a.id, "targetedAs", 2);
  check("targeted as GROUND (0x2)", [a.targClass, world.unitField(a.id, "targetedAs")], ["ground", 2]);
  world.setUnitField(a.id, "scalingValue", 1.9);
  check("its model scale is kept for the reads (and handed to the renderer)", world.unitField(a.id, "scalingValue"), 1.9);
  check("…the other unit's is still its type's", world.unitField(b.id, "scalingValue"), undefined);
  world.setUnitField(a.id, "weaponAttackRange", 180, 0);
  world.recomputeStats(a);
  check("a weapon's range, surviving a tick of recomputeStats", [a.weapons[0].range, b.weapons[0].range], [180, 90]);
  world.setUnitField(a.id, "weaponAttacksEnabled", 1, 1);
  world.recomputeStats(a);
  check("Attacks Enabled switches a dormant slot ON, and it stays on", [a.weapons[1].enabled, world.unitField(a.id, "weaponAttacksEnabled", 1)], [true, true]);
  world.setUnitField(a.id, "weaponAttacksEnabled", 0, 0);
  world.recomputeStats(a);
  check("…and a live slot OFF", a.weapons[0].enabled, false);
  world.setUnitField(a.id, "weaponAttackType", 3, 1);
  check("a weapon's attack type by common.j's index (3 = SIEGE)", a.weapons[1].attackType, "siege");
  const hero = unit({ isHero: true });
  check("a HERO's level is SetHeroLevel's, not this", world.setUnitField(hero.id, "level", 20), false);
}

console.log("\na unit's own bounty is what its killer is paid");
{
  const victim = unit({ owner: 12 }), killer = unit({ owner: 0 });
  world.setUnitField(victim.id, "goldBountyBase", 25 * 9);
  world.setUnitField(victim.id, "goldBountyDice", 0);
  // Pay it directly: the bounty roll is the part under test, not who counts as hostile.
  world.givesBounty = () => true;
  world.hostile = () => true;
  const before = world.stashOf(0).gold;
  world.awardBounty(victim, killer.id);
  check("225 gold, not the type's 20", world.stashOf(0).gold - before, 225);
}

console.log("\nBlzSetUnitName / BlzSetHeroProperName (through the real hook table)");
{
  const { simHooks } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));
  const hooks = simHooks(world, () => 0);
  const u = unit(), h = unit({ isHero: true, properName: "Arthas" });
  hooks.setUnitName(u.id, "Unit One", false);
  check("GetUnitName answers the unit's own name", hooks.unitName(u.id), "Unit One");
  check("…and a unit with none answers the type's (undefined here)", hooks.unitName(h.id), undefined);
  hooks.setUnitName(u.id, "", false);
  check('an empty name is refused ("will crash the game" — jassbot)', hooks.unitName(u.id), "Unit One");
  hooks.setUnitName(h.id, "Uther", true);
  check("a hero's given name", h.properName, "Uther");
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall unit-field checks passed");
