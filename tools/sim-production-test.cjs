// Headless checks on the two things a PRODUCTION building's card promises when there is more
// than one of it: an upgrade is bought ONCE, and a train order is spread.
//
//   • An upgrade belongs to the PLAYER, not to the building that pays for it. Two Barracks
//     could both start Defend, and the second one's 100 gold simply vanished: the research
//     completes, `researchLevel` is already 1, and nothing on the card or in the stash ever
//     said so. WC3 greys the button out on every other building that researches it until the
//     first one lands. The card does that (`pushResearchButtons`), and `Authority.execute` is
//     the gate behind it — the one that matters, because a command comes over the wire without
//     a card in front of it.
//
//   • Training is spread across the whole selected sub-group (`RtsController.focusedGroupIds`
//     → `MapViewerScene.trainUnit`): two Barracks with a Footman clicked once start one each,
//     so they walk out together. That needs no bookkeeping — each click adds one job per
//     building — and the fairness rests entirely on the authority charging AS IT GOES, so that
//     a stash covering one Footman buys exactly one. That property is what is checked here;
//     the spread itself lives in the renderer.
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

// --- the smallest world with two Barracks in it ------------------------------------------------
//
// A Human Barracks ('hbar'), a Footman ('hfoo') and a Farm ('hhou') for the food, plus the two
// upgrades a Barracks really researches: Defend ('Rhde', one level) and, standing in for a
// ranked one, Iron/Steel/Mithril Forged Swords ('Rhme', three).
const unit = (id, over) => ({
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, ...over,
});
const units = new UnitRegistry(new Map([
  ["hbar", unit("hbar", { isBuilding: true })],
  ["hhou", unit("hhou", { isBuilding: true, foodMade: 12 })],
  ["hfoo", unit("hfoo", { goldCost: 135, lumberCost: 0, buildTime: 20, foodUsed: 2 })],
]));
const techNode = (id, over = {}) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false, ...over,
}];
const tech = new TechRegistry(new Map([
  techNode("hbar", { trains: ["hfoo"], researches: ["Rhde", "Rhme"] }),
  techNode("hhou"),
  techNode("hfoo"),
  techNode("Rhde"),
  techNode("Rhme"),
]));
const upgrade = (id, maxLevel, gold) => [id, {
  id, race: "human", className: "melee", maxLevel,
  goldBase: gold, goldMod: 75, lumberBase: 0, lumberMod: 0, timeBase: 30, timeMod: 10,
  effects: [], names: [id], tips: [id], uberTips: [id], hotkeys: ["D"], icons: [""], buttonX: 0, buttonY: 0,
}];
const upgrades = new UpgradeRegistry(new Map([upgrade("Rhde", 1, 100), upgrade("Rhme", 3, 100)]));

let world, authority, nextId;
function newWorld() {
  const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]);
  world = new SimWorld(grid, 1, undefined, undefined, units, tech, upgrades);
  authority = new Authority(world, units, { get: () => undefined }, tech, upgrades);
  nextId = 1;
}
function building(typeId, owner) {
  const u = { id: nextId++, owner, team: owner, typeId, hp: 100, x: 0, y: 0, building: { queue: [], constructionLeft: 0 } };
  world.units.set(u.id, u);
  world.tech.invalidate();
  return u;
}
const research = (player, b, upgradeId) => authority.execute(player, { c: "research", buildingId: b.id, upgradeId });
const train = (player, b, unitId) => authority.execute(player, { c: "train", buildingId: b.id, unitId });

console.log("\n-- an upgrade is the PLAYER's, so only one building may be on it ------------------");

{
  newWorld();
  world.initStash(0, 1000, 1000);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  check("the first Barracks takes Defend", research(0, a, "Rhde"), true);
  check("…and it cost the level's own price", world.stashOf(0).gold, 900);
  check("the second Barracks is refused", research(0, b, "Rhde"), false);
  check("…and was charged nothing", world.stashOf(0).gold, 900);
  check("…and queued nothing", b.building.queue.length, 0);
  // Who is holding it — one pass over the units, and what the command card greys the button on.
  const busy = world.playerResearching(0);
  check("playerResearching names the holder", [busy.get("Rhde").level, busy.get("Rhde").buildingId], [1, a.id]);
  check("…and says nothing about an upgrade nobody is on", busy.has("Rhme"), false);
}

{
  // The rule is per PLAYER: an enemy Barracks researching Defend says nothing about ours.
  newWorld();
  world.initStash(0, 1000, 1000);
  world.initStash(1, 1000, 1000);
  const mine = building("hbar", 0);
  const theirs = building("hbar", 1);
  check("the enemy starts Defend", research(1, theirs, "Rhde"), true);
  check("…and we may still start our own", research(0, mine, "Rhde"), true);
}

{
  // Chaining levels in ONE building is untouched: WC3 lets a Blacksmith queue Iron and Steel
  // back to back, and each is priced from its own level (100, then 175).
  newWorld();
  world.initStash(0, 1000, 1000);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  check("level 1 at the first Barracks", research(0, a, "Rhme"), true);
  check("level 2 behind it, same Barracks", research(0, a, "Rhme"), true);
  check("…both queued, at 1 then 2", a.building.queue.map((j) => j.level), [1, 2]);
  check("…and priced per level", world.stashOf(0).gold, 1000 - 100 - 175);
  check("the other Barracks is shut out of the whole ladder", research(0, b, "Rhme"), false);
  // …and the moment the first one finishes, the ladder is anybody's again.
  a.building.queue.length = 0;
  check("with the queue empty the other Barracks may take it", research(0, b, "Rhme"), true);
}

console.log("\n-- a train order charges AS IT GOES, which is what makes the spread fair ----------");

{
  newWorld();
  world.initStash(0, 270, 0); // exactly two Footmen
  building("hhou", 0); // 12 food
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  check("one Footman from each Barracks", [train(0, a, "hfoo"), train(0, b, "hfoo")], [true, true]);
  check("…and the stash is empty", world.stashOf(0).gold, 0);
  check("…one job apiece, so they walk out together",
    [a.building.queue.length, b.building.queue.length], [1, 1]);
}

{
  // The one the player asked about: enough gold for ONE Footman and two Barracks selected.
  // The first takes it, the second is refused — and the refusal is what the renderer counts
  // when it decides whether to say anything at all.
  newWorld();
  world.initStash(0, 135, 0);
  building("hhou", 0);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  check("the first Barracks takes the only Footman", train(0, a, "hfoo"), true);
  check("…and the second finds the stash already spent", train(0, b, "hfoo"), false);
  check("…so exactly one is in production",
    [a.building.queue.length, b.building.queue.length], [1, 0]);
}

{
  // FOOD is committed at the same moment, so the spread stops at the supply block too: a Farm
  // is 12 food and a Footman is 2, leaving room for six however much gold is in the bank.
  newWorld();
  world.initStash(0, 10000, 10000);
  building("hhou", 0);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  const taken = [];
  for (let i = 0; i < 5; i++) taken.push(train(0, a, "hfoo"), train(0, b, "hfoo"));
  check("six get in, the rest are refused on food", taken.filter(Boolean).length, 6);
  check("…three from each, evenly",
    [a.building.queue.length, b.building.queue.length], [3, 3]);
}

console.log("\n-- a building still going up is not part of the spread ---------------------------");

{
  // A finished Barracks and a half-built one group together in the selection (they share a
  // typeId), so the click reaches both. Only the finished one may take it.
  newWorld();
  world.initStash(0, 10000, 0);
  building("hhou", 0);
  const done = building("hbar", 0);
  const going = building("hbar", 0);
  going.building.constructionLeft = 30;
  check("the finished Barracks trains", train(0, done, "hfoo"), true);
  check("…the site does not", train(0, going, "hfoo"), false);
  check("…and researches nothing either", research(0, going, "Rhde"), false);
}

console.log(failed ? `\nFAILED (${failed})` : "\nproduction: all checks passed");
process.exit(failed ? 1 : 0);
