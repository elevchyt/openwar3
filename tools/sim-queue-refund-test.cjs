// Headless checks on the HARD RULE that a building leaving the world pays its production queue
// back: whatever gold and lumber every job in it was charged goes back to whoever paid it, and
// the food it was holding is freed. For EVERY building and every kind of job — a unit, a
// research, a tier upgrade — whether the building is killed or removed outright.
//
// The price is the one the authority CHARGED (`Authority.jobCost`), which is also what a cancel
// pays back from: a tier upgrade is the DIFFERENCE between the two buildings, never the new
// one's whole cost (a cancelled Keep used to refund 75% of the Keep's full price).
//
// And a CONSTRUCTION SITE, which has no queue: CANCELLED it pays (3/4 × Cost) × (1 − dmg%), and
// DESTROYED it pays nothing at all.
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
const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const unit = (id, over) => ({
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, ...over,
});
const units = new UnitRegistry(new Map([
  ["hbar", unit("hbar", { isBuilding: true, goldCost: 160, lumberCost: 60 })],
  ["htow", unit("htow", { isBuilding: true, goldCost: 385, lumberCost: 185, foodMade: 12 })],
  ["hkee", unit("hkee", { isBuilding: true, goldCost: 705, lumberCost: 395, foodMade: 12 })],
  ["hhou", unit("hhou", { isBuilding: true, foodMade: 12 })],
  ["hfoo", unit("hfoo", { goldCost: 135, lumberCost: 0, buildTime: 20, foodUsed: 2 })],
  ["hrif", unit("hrif", { goldCost: 205, lumberCost: 30, buildTime: 26, foodUsed: 3 })],
]));
const techNode = (id, over = {}) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false, ...over,
}];
const tech = new TechRegistry(new Map([
  techNode("hbar", { trains: ["hfoo", "hrif"], researches: ["Rhde"] }),
  techNode("htow", { upgrade: ["hkee"] }),
  techNode("hkee"),
  techNode("hhou"),
  techNode("hfoo"),
  techNode("hrif"),
  techNode("Rhde"),
]));
const upgrades = new UpgradeRegistry(new Map([["Rhde", {
  id: "Rhde", race: "human", className: "melee", maxLevel: 1,
  goldBase: 150, goldMod: 0, lumberBase: 100, lumberMod: 0, timeBase: 30, timeMod: 0,
  effects: [], names: ["Rhde"], tips: ["Rhde"], uberTips: ["Rhde"], hotkeys: ["D"], icons: [""], buttonX: 0, buttonY: 0,
}]]));

let world, authority, nextId;
function newWorld() {
  const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]);
  world = new SimWorld(grid, 1, undefined, undefined, units, tech, upgrades);
  authority = new Authority(world, units, { get: () => undefined }, tech, upgrades);
  nextId = 1;
}
function building(typeId, owner) {
  const u = {
    id: nextId++, owner, team: owner, typeId, hp: 100, x: 0, y: 0, buffs: [], garrison: [], orderQueue: [], inventory: [], abilities: [],
    building: { queue: [], constructionLeft: 0, buildTimeTotal: 0, builderIds: [], goldCost: 0, lumberCost: 0 },
  };
  world.units.set(u.id, u);
  world.tech.invalidate();
  return u;
}
const stash = (p) => { const s = world.stashOf(p); return [s.gold, s.lumber]; };
const x = (p, cmd) => authority.execute(p, cmd);

console.log("\n-- a Barracks killed with a full queue pays all of it back ------------------------");
{
  newWorld();
  world.initStash(0, 2000, 1000);
  building("hhou", 0);
  const bar = building("hbar", 0);
  check("queue a Footman", x(0, { c: "train", buildingId: bar.id, unitId: "hfoo" }), true);
  check("queue a Rifleman", x(0, { c: "train", buildingId: bar.id, unitId: "hrif" }), true);
  check("queue Defend", x(0, { c: "research", buildingId: bar.id, upgradeId: "Rhde" }), true);
  check("…charged 135+205+150 gold, 30+100 lumber", stash(0), [2000 - 490, 1000 - 130]);
  world.tickBuildings(0.1); // the head job takes its food
  check("the Footman at the head holds its 2 food", authority.foodFor(0).used, 2);
  world.kill(bar, 0);
  check("the building is gone", world.units.has(bar.id), false);
  check("…every job's gold and lumber came back", stash(0), [2000, 1000]);
  check("…and the food it held is free", authority.foodFor(0).used, 0);
  check("…and Defend is not in research anywhere", world.playerResearching(0).has("Rhde"), false);
}

console.log("\n-- a Town Hall halfway to a Keep pays back what the Keep cost ---------------------");
{
  newWorld();
  world.initStash(0, 1000, 1000);
  const hall = building("htow", 0);
  check("upgrade to Keep", x(0, { c: "upgradebuilding", buildingId: hall.id, toTypeId: "hkee" }), true);
  check("…charged the difference, 320/210", stash(0), [680, 790]);
  world.kill(hall, 0);
  check("killed: the difference comes back in full", stash(0), [1000, 1000]);
}

{
  newWorld();
  world.initStash(0, 1000, 1000);
  const hall = building("htow", 0);
  x(0, { c: "upgradebuilding", buildingId: hall.id, toTypeId: "hkee" });
  check("a CANCELLED Keep refunds 75% of the difference, not of the Keep", x(0, { c: "canceltrain", buildingId: hall.id, index: 0 }), true);
  check("…680 + 240, 790 + 158", stash(0), [920, 948]);
}

console.log("\n-- removed outright (RemoveUnit) pays back the same, and only once ---------------");
{
  newWorld();
  world.initStash(0, 1000, 0);
  building("hhou", 0);
  const bar = building("hbar", 0);
  x(0, { c: "train", buildingId: bar.id, unitId: "hfoo" });
  x(0, { c: "train", buildingId: bar.id, unitId: "hfoo" });
  check("charged two Footmen", stash(0), [730, 0]);
  world.removeUnit(bar.id);
  check("removed: both come back", stash(0), [1000, 0]);
  world.removeUnit(bar.id);
  world.kill(bar, 0);
  check("…and a second exit pays nothing more", stash(0), [1000, 0]);
}

console.log("\n-- the enemy is not paid for the building they razed -------------------------------");
{
  newWorld();
  world.initStash(0, 1000, 0);
  world.initStash(1, 0, 0);
  building("hhou", 0);
  const bar = building("hbar", 0);
  const killer = building("hbar", 1);
  x(0, { c: "train", buildingId: bar.id, unitId: "hfoo" });
  world.kill(bar, killer.id);
  check("the owner gets the Footman back", stash(0)[0], 1000);
  check("…and the killer gets none of it", stash(1)[0], 0);
}

console.log("\n-- a construction site: cancelled pays (3/4 × Cost) × (1 − dmg%), destroyed pays nothing");
function site(typeId, owner, built, damage) {
  // A site `built` of the way up, with the life the ramp has given it by now (10% at the stamp,
  // the rest across the build time) less `damage`.
  const u = building(typeId, owner);
  const maxHp = 1000;
  u.maxHp = maxHp;
  u.building.buildTimeTotal = 60;
  u.building.constructionLeft = 60 * (1 - built);
  u.hp = maxHp * (0.1 + 0.9 * built) - damage;
  return u;
}
{
  newWorld();
  world.initStash(0, 0, 0);
  const bar = site("hbar", 0, 0, 0);
  check("a site cancelled the instant it is placed is undamaged", world.constructionDamageFrac(bar.id), 0);
  check("cancel it", x(0, { c: "cancelbuild", buildingId: bar.id }), true);
  check("…75% of 160/60 back: 120/45", stash(0), [120, 45]);
}
{
  newWorld();
  world.initStash(0, 0, 0);
  const bar = site("hbar", 0, 0.5, 400); // 550 life due, 150 left: 40% of the pool is gone
  check("half built, 400 of 1000 life knocked off: dmg% = 40%", world.constructionDamageFrac(bar.id), 0.4);
  x(0, { c: "cancelbuild", buildingId: bar.id });
  check("…(3/4 × 160/60) × 0.6 = 72/27", stash(0), [72, 27]);
}
{
  newWorld();
  world.initStash(0, 0, 0);
  world.initStash(1, 0, 0);
  const bar = site("hbar", 0, 0.5, 100);
  const enemy = building("hbar", 1);
  world.kill(bar, enemy.id);
  check("a site DESTROYED under construction pays nothing", stash(0), [0, 0]);
  check("…and nothing to the killer either", stash(1), [0, 0]);
}
{
  newWorld();
  world.initStash(0, 0, 0);
  const bar = building("hbar", 0);
  bar.maxHp = 1000;
  bar.hp = 300;
  check("a FINISHED building cannot be cancelled, damaged or not", x(0, { c: "cancelbuild", buildingId: bar.id }), false);
  check("…and pays nothing", stash(0), [0, 0]);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall queue-refund checks passed");
