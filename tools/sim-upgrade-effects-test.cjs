// Four stock researches that used to complete and change nothing (issue #280): the upgrade
// EFFECTS `rhpr`, `rart`, `rspi` (+ 1.31's `rspp`) and `rrai`.
//
// The rows are Units\UpgradeData.slk's own:
//
//   Rotr  Troll Regeneration   rhpr  base 1          → +1 hit point a second
//   Rorb  Reinforced Defenses  rart  base 1 (3 from 2.0.2) → the Burrow / Watch Tower turn Fortified
//   Rosp  Spiked Barricades    rspi  base 5 mod 7    → 5 / 12 / 19 back at a melee attacker
//                              rspp  base 0.2 mod 0.3  (1.31) a share of the blow on top
//   Rusm  Skeletal Mastery     rrai  base 20         → +20 s on what Raise Dead raises
//
// The Skeletal Mage half of Skeletal Mastery is the ability's own (sim-corpse-test.cjs).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { TechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
const { UpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { damageMultiplier } = require(join(REPO, ".sim-build", "src", "data", "gameplayConstants.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}
const SIM_DT = 1 / 60;

const up = (id, maxLevel, effects) => [id, {
  id, race: "orc", className: "_", maxLevel, goldBase: 100, goldMod: 0, lumberBase: 0, lumberMod: 0,
  timeBase: 30, timeMod: 0, effects, names: [id], tips: [id], uberTips: [id], hotkeys: ["D"], icons: [""],
  buttonX: 0, buttonY: 0,
}];
const fx = (effect, base, mod = 0) => ({ effect, base, mod });
const upgrades = new UpgradeRegistry(new Map([
  up("Rotr", 1, [fx("rhpr", 1, 1)]),
  up("Rorb", 1, [fx("rart", 1)]), // 1.30.4's row
  up("Ror3", 1, [fx("rart", 3)]), // 2.0.2's value, on a row of its own
  up("Rosp", 3, [fx("rspi", 5, 7)]),
  up("Rosq", 2, [fx("rspi", 5, 0), fx("rspp", 0.2, 0.3)]), // the 1.31 shape
  up("Rusm", 1, [fx("rrai", 20)]),
]));
const unit = (id, over) => ({
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, upgradesUsed: [], defUp: 2, abilities: [],
  hpRegen: 0, regenType: "none", armorType: "medium", ...over,
});
const units = new UnitRegistry(new Map([
  ["ohun", unit("ohun", { upgradesUsed: ["Rotr"], hpRegen: 0.25, regenType: "always" })],
  ["ogru", unit("ogru", {})],
  ["otrb", unit("otrb", { upgradesUsed: ["Rosp", "Rorb"], isBuilding: true, armorType: "large" })],
  ["owtw", unit("owtw", { upgradesUsed: ["Rosq", "Ror3"], isBuilding: true, armorType: "large" })],
  ["unec", unit("unec", { upgradesUsed: ["Rusm"] })],
]));
const techNode = (id) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false,
}];
const tech = new TechRegistry(new Map(
  ["ohun", "ogru", "otrb", "owtw", "unec", "Rotr", "Rorb", "Ror3", "Rosp", "Rosq", "Rusm"].map(techNode),
));

const WEAPON = (over = {}) => ({
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 90, baseRange: 90, rangeBuffer: 250,
  dice: 1, baseDice: 1, sides: 1, base: 19, damage: 20, baseDamage: 20, cooldown: 1, baseCooldown: 1,
  rangeMotionBuffer: 250, damagePoint: 0.1, baseDamagePoint: 0.1, backswing: 0.1, baseBackswing: 0.1,
  baseSpillDist: 0, baseSpillRadius: 0, attackType: "normal", ranged: false,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0, ...over,
});

function world() {
  const W = 64, H = 64;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(g, 1, undefined, undefined, units, tech, upgrades);
}
function spawn(w, id, owner, x, y, typeId, over = {}) {
  const def = units.get(typeId);
  const w1 = WEAPON(over.weapon || {});
  const isB = !!def.isBuilding;
  return w.add({
    id, owner, team: owner, typeId, x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: def.hpRegen,
    speed: isB ? 0 : 270, turnRate: 0.6, radius: isB ? 64 : 16, scale: 1, armor: 0, armorType: def.armorType, defUp: 2,
    weapon: isB ? null : w1, weapons: isB ? [] : [w1], oldWeapons: [],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "orc",
    isBuilding: isB,
    foodCost: 0, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: isB ? "structure" : "ground", deathTime: 2, name: typeId,
    worker: null, depotGold: false, depotLumber: false,
  }, isB ? { constructionLeft: 0, queue: [], rally: null } : null);
}
const run = (w, steps) => { for (let i = 0; i < steps; i++) w.tick(SIM_DT); };

// --- rhpr: Troll Regeneration ---------------------------------------------------------------
{
  const w = world();
  const troll = spawn(w, 1, 0, 1000, 1000, "ohun");
  const grunt = spawn(w, 2, 0, 1400, 1000, "ogru");
  run(w, 2);
  check("a Headhunter regenerates its row's 0.25 before the research", Math.abs(troll.hpRegen - 0.25) < 1e-9, `${troll.hpRegen}`);
  w.tech.setResearchLevel(0, "Rotr", 1);
  run(w, 2);
  check("Troll Regeneration adds its 1 hit point a second", Math.abs(troll.hpRegen - 1.25) < 1e-9, `${troll.hpRegen}`);
  check("…and nothing to a unit that does not list it", grunt.hpRegen === 0, `${grunt.hpRegen}`);
  troll.hp = 500;
  run(w, 60);
  check("…which is what the hit points actually do", Math.abs(troll.hp - 501.25) < 0.05, `${troll.hp}`);
}

// --- rart: Reinforced Defenses ---------------------------------------------------------------
{
  const w = world();
  const burrow = spawn(w, 1, 0, 1000, 1000, "otrb");
  const tower = spawn(w, 2, 0, 1600, 1000, "owtw");
  const enemy = spawn(w, 3, 1, 1000, 2000, "otrb");
  run(w, 2);
  check("a Burrow is Large before the research", burrow.armorType === "large");
  w.tech.setResearchLevel(0, "Rorb", 1);
  w.tech.setResearchLevel(0, "Ror3", 1);
  run(w, 2);
  check("Reinforced Defenses (1.30.4's base 1) makes it Fortified", burrow.armorType === "fort", burrow.armorType);
  check("…and so does 2.0.2's base 3, the defenseTypeInt for Fortified", tower.armorType === "fort", tower.armorType);
  check("…for the player who researched it alone", enemy.armorType === "large", enemy.armorType);
  check("Siege now does its 1.5× and Pierce its 0.35×",
    damageMultiplier("siege", burrow.armorType) === 1.5 && damageMultiplier("pierce", burrow.armorType) === 0.35,
    `${damageMultiplier("siege", burrow.armorType)} / ${damageMultiplier("pierce", burrow.armorType)}`);
}

// --- rspi / rspp: Spiked Barricades ----------------------------------------------------------
function blow(research, type, weapon = {}) {
  const w = world();
  const b = spawn(w, 1, 0, 1000, 1000, type);
  const a = spawn(w, 2, 1, 1000 + (weapon.ranged ? 300 : 90), 1000, "ogru", { weapon });
  research(w);
  w.issueAttack(2, 1);
  let steps = 0;
  while (b.hp === b.maxHp && steps++ < 600) w.tick(SIM_DT);
  return { lost: a.maxHp - a.hp, took: b.maxHp - b.hp };
}
{
  const none = blow(() => {}, "otrb");
  check("an unspiked Burrow hurts nobody", none.took > 0 && none.lost === 0, `took ${none.took}, attacker lost ${none.lost}`);
  const l1 = blow((w) => w.tech.setResearchLevel(0, "Rosp", 1), "otrb");
  check("Spiked Barricades returns its 5 to a melee attacker", Math.abs(l1.lost - 5) < 1e-6, `${l1.lost}`);
  const l3 = blow((w) => w.tech.setResearchLevel(0, "Rosp", 3), "otrb");
  check("…and 19 at Advanced (5 + 7 + 7)", Math.abs(l3.lost - 19) < 1e-6, `${l3.lost}`);
  const ranged = blow((w) => w.tech.setResearchLevel(0, "Rosp", 3), "otrb", { ranged: true, range: 400, baseRange: 400, weaponType: "instant" });
  check("…and nothing to a ranged one", ranged.took > 0 && ranged.lost === 0, `took ${ranged.took}, lost ${ranged.lost}`);
  const pct = blow((w) => w.tech.setResearchLevel(0, "Rosq", 2), "owtw");
  // The tower has no armour, so what it took IS the blow.
  check("1.31's rspp adds a share of the blow: 5 + 50% of it", pct.took > 0 && Math.abs(pct.lost - (5 + 0.5 * pct.took)) < 1e-6, `${pct.lost} off a blow of ${pct.took}`);
}

// --- rrai: what the spell is told ------------------------------------------------------------
{
  const w = world();
  const nec = spawn(w, 1, 0, 1000, 1000, "unec");
  const other = spawn(w, 2, 0, 1200, 1000, "ogru");
  w.tech.setResearchLevel(0, "Rusm", 1);
  check("Skeletal Mastery: the Necromancer's Raise Dead bonus is 20 s", w.spellApi.raiseDeadBonus(nec) === 20, `${w.spellApi.raiseDeadBonus(nec)}`);
  check("…and a caster that does not list it gets none", w.spellApi.raiseDeadBonus(other) === 0);
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nupgrade effects: all checks passed");
