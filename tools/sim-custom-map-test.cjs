// A CUSTOM map is not a melee game — the hero limits and the supply cap (issue #127).
//
// Reported on "WTii's Unit Tester", which arrives with a melee game's rules bolted on: three
// heroes per player, one of each, and 0/0 food on a map whose entire purpose is spawning
// hundreds of units. Neither rule is the engine's.
//
//   • The hero limits are JASS. Blizzard.j's `MeleeStartingHeroLimit` is the only thing in the
//     whole game that sets them —
//         call SetPlayerMaxHeroesAllowed(bj_MELEE_HERO_LIMIT, Player(index))   // 'HERO' → 3
//         call ReducePlayerTechMaxAllowed(Player(index), 'Hamg', bj_MELEE_HERO_TYPE_LIMIT)
//     — and a map that never calls it has none: the same hero may be hired over and over,
//     which on a unit tester is the point.
//
//   • The supply cap is a WRITABLE player state. The tester has no food-producing building
//     anywhere on it and simply states the cap it wants, ceiling first:
//         call SetPlayerStateBJ( Player(0), PLAYER_STATE_FOOD_CAP_CEILING, 300 )
//         call SetPlayerStateBJ( Player(0), PLAYER_STATE_RESOURCE_FOOD_CAP, 300 )
//     Ours is derived from the units, so the write was dropped and every player sat at 0/0.
//
// What is checked here is the gate itself — `Authority.execute`, the one door every click,
// hotkey, computer player and LAN peer comes through — under both regimes: the caps unset (a
// custom map) and the caps set exactly as MeleeStartingHeroLimit sets them.
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

// --- the smallest world that can train a hero -------------------------------------------------
//
// An Altar of Kings ('halt') and its four heroes, with the fields the train gate actually reads.
const unit = (id, over) => ({
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, ...over,
});
const hero = (id) => unit(id, { isHero: true, goldCost: 425, lumberCost: 100, buildTime: 55, foodUsed: 5 });
const HEROES = ["Hamg", "Hmkg", "Hpal", "Hblm"];
const units = new UnitRegistry(new Map([
  ["halt", unit("halt", { isBuilding: true })],
  ["hhou", unit("hhou", { isBuilding: true, foodMade: 6 })], // a Farm, for the accumulator check
  ...HEROES.map((h) => [h, hero(h)]),
]));
const techNode = (id, over = {}) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false, ...over,
}];
const tech = new TechRegistry(new Map([
  techNode("halt", { trains: HEROES, revive: true }),
  techNode("hhou"),
  ...HEROES.map((h) => techNode(h)),
]));
const upgrades = new UpgradeRegistry(new Map());

const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]);
const world = new SimWorld(grid, 1, undefined, undefined, units, tech, upgrades);
const authority = new Authority(world, units, { get: () => undefined }, tech, upgrades);

let nextId = 1;
function building(typeId, owner) {
  const u = { id: nextId++, owner, team: owner, typeId, hp: 100, x: 0, y: 0, building: { queue: [], constructionLeft: 0 } };
  world.units.set(u.id, u);
  return u;
}
/** Train `id` at the altar, then finish it, so the hero is a UNIT rather than a queue entry —
 *  the roster has to survive the job it came from. */
function trainAndFinish(player, altar, id) {
  if (!authority.execute(player, { c: "train", buildingId: altar.id, unitId: id })) return false;
  const job = altar.building.queue.pop();
  world.units.set(nextId, { id: nextId, owner: player, team: player, typeId: job.unitId, hp: 100, x: 0, y: 0 });
  nextId++;
  return true;
}

const altar = building("halt", 0);
world.initStash(0, 100000, 100000);
authority.setFoodCap(0, 300); // the map's own line; without it nothing below can be paid for

console.log("a custom map sets no hero limits, so it has none");
{
  check("the roster limit is WC3's -1 (no limit)", world.tech.heroLimit(0), -1);
  check("…and so is every hero's own", HEROES.map((h) => world.tech.maxAllowed(0, h)), [-1, -1, -1, -1]);
  check("all four heroes can be trained", HEROES.map((h) => trainAndFinish(0, altar, h)), [true, true, true, true]);
  check("…which is already one past a melee game's three", authority.heroCount(0), 4);
  check("and the SAME hero can be trained again", trainAndFinish(0, altar, "Hamg"), true);
  check("…and again", trainAndFinish(0, altar, "Hamg"), true);
  check("the roster counts every copy, not every type",
    [authority.heroCount(0), authority.heroCensus(0).get("Hamg")], [6, 3]);
}

console.log("\n…and with MeleeStartingHeroLimit's own two calls, it is a melee game again");
{
  const altar2 = building("halt", 1);
  world.initStash(1, 100000, 100000);
  authority.setFoodCap(1, 300);
  // Exactly what Blizzard.j writes: 'HERO' → bj_MELEE_HERO_LIMIT, each hero → …TYPE_LIMIT.
  world.tech.setMaxAllowed(1, "HERO", 3);
  for (const h of HEROES) world.tech.setMaxAllowed(1, h, 1);
  check("three heroes go through", [
    trainAndFinish(1, altar2, "Hamg"), trainAndFinish(1, altar2, "Hmkg"), trainAndFinish(1, altar2, "Hpal"),
  ], [true, true, true]);
  check("the fourth is refused — the roster is full", trainAndFinish(1, altar2, "Hblm"), false);
  check("…and a second Archmage is refused on the TYPE limit, not the roster one",
    (world.tech.setMaxAllowed(1, "HERO", 9), trainAndFinish(1, altar2, "Hamg")), false);
  check("the other player is untouched by any of it", world.tech.heroLimit(0), -1);
}

console.log("\nthe supply cap a map states, and the ceiling that bounds it");
{
  const p = 3;
  world.initStash(p, 0, 0);
  check("a player with no farm makes nothing", authority.foodFor(p).made, 0);
  check("the stock ceiling is 100", authority.foodCapCeilingOf(p), 100);
  authority.setFoodCap(p, 300);
  check("…so the tester's 300 alone would come out as 100", authority.foodFor(p).made, 100);
  authority.setFoodCapCeiling(p, 300);
  authority.setFoodCap(p, 300);
  check("ceiling first, then the cap — the map's own order — gives 0/300",
    [authority.foodFor(p).used, authority.foodFor(p).made], [0, 300]);
  // WC3 keeps the cap as an ACCUMULATOR: a farm raised after the write still adds its 6, and
  // the ceiling still bounds the total. Ours stores the write as an offset to get the same.
  building("hhou", p);
  check("a farm raised afterwards adds its own food, under the ceiling", authority.foodFor(p).made, 300);
  authority.setFoodCapCeiling(p, 999);
  check("…and shows through once the ceiling is lifted", authority.foodFor(p).made, 306);
  // The other direction: a write while buildings are already standing, then losing one.
  authority.setFoodCap(p, 50);
  check("a later write is the new total", authority.foodFor(p).made, 50);
  world.units.delete([...world.units.values()].find((u) => u.typeId === "hhou" && u.owner === p).id);
  check("…and the razed farm takes its 6 back off it", authority.foodFor(p).made, 44);
}

console.log(failed === 0 ? "\ncustom map: all checks passed" : `\ncustom map: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
