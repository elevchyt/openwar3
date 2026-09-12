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
//   • Training goes to the EMPTIEST queue in the selected sub-group
//     (`RtsController.focusedGroupIds` → `MapViewerScene.trainUnit`): a click is one unit, and
//     with three Barracks held, five clicks buy five Footmen — two, two and one. The pick
//     itself lives in the renderer; what is checked here is the authority property it rests
//     on — that it charges AS IT GOES, so a stash covering one Footman buys exactly one.
//
//   • FOOD is paid at the HEAD of the queue, never when the button is pressed. A job behind
//     another costs the player nothing, pays when its turn comes, and STANDS THERE at 0
//     seconds of progress if there is no supply to pay with — then starts on its own the
//     moment a Farm lands. `BuildJob.foodPaid` is the receipt, and `foodFor` reads it.
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
  // `builderIds` and the two costs are there for `tickBuildings`' CONSTRUCTION branch, which
  // one block below deliberately walks (a Farm pegged out but not finished). With nobody
  // hammering, that branch advances nothing — which is exactly the state being checked.
  const u = {
    id: nextId++, owner, team: owner, typeId, hp: 100, x: 0, y: 0,
    building: { queue: [], constructionLeft: 0, buildTimeTotal: 0, builderIds: [], goldCost: 0, lumberCost: 0 },
  };
  world.units.set(u.id, u);
  world.tech.invalidate();
  return u;
}
/** A standing unit — no `building`, so it eats food and holds no queue. */
function soldier(typeId, owner) {
  const u = { id: nextId++, owner, team: owner, typeId, hp: 100, x: 0, y: 0 };
  world.units.set(u.id, u);
  world.tech.invalidate();
  return u;
}
const research = (player, b, upgradeId) => authority.execute(player, { c: "research", buildingId: b.id, upgradeId });
const train = (player, b, unitId) => authority.execute(player, { c: "train", buildingId: b.id, unitId });
// Advance the production queues and nothing else. A whole `world.tick` wants real SimUnits
// (buffs, orders, pathing) and the fixtures above are the three fields a building needs —
// which is the point of them: this file is about the queue, and `tickBuildings` is the queue.
const tickQueues = (dt) => world.tickBuildings(dt);

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
  // Chaining levels in ONE building is refused too: the game empties the button while a rank
  // is in research, so Steel is never queued behind Iron — the SAME Barracks is shut out of
  // the ladder until its own research lands, and then the next rank is priced from its own
  // level (100, then 175).
  newWorld();
  world.initStash(0, 1000, 1000);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  check("level 1 at the first Barracks", research(0, a, "Rhme"), true);
  check("level 2 behind it, same Barracks, is refused", research(0, a, "Rhme"), false);
  check("…only the one queued", a.building.queue.map((j) => j.level), [1]);
  check("…and only the one charged", world.stashOf(0).gold, 1000 - 100);
  check("the other Barracks is shut out of the whole ladder", research(0, b, "Rhme"), false);
  // …and the moment the first one finishes, the ladder is anybody's again — at the next rank.
  a.building.queue.length = 0;
  world.tech.setResearchLevel(0, "Rhme", 1);
  check("with the research landed the other Barracks may take level 2", research(0, b, "Rhme"), true);
  check("…queued at 2", b.building.queue.map((j) => j.level), [2]);
  check("…and priced from its own level", world.stashOf(0).gold, 1000 - 100 - 175);
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

console.log("\n-- FOOD is paid at the HEAD of the queue, and an unpaid head does not move --------");

{
  // A Farm is 12 food and a Footman is 2, so there is room for six standing units — and the
  // QUEUE is not bound by that at all. Queueing costs a player nothing but gold: the job pays
  // when it reaches the front, so ten of them get in and the supply only ever holds back what
  // is actually training.
  newWorld();
  world.initStash(0, 10000, 10000);
  building("hhou", 0);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  const taken = [];
  for (let i = 0; i < 5; i++) taken.push(train(0, a, "hfoo"), train(0, b, "hfoo"));
  check("every one of them is queued — food does not gate the button", taken.filter(Boolean).length, 10);
  check("…five apiece", [a.building.queue.length, b.building.queue.length], [5, 5]);
  check("…and nothing has been charged food yet", authority.foodFor(0), { used: 0, made: 12 });
  // One tick, and only the two at the FRONT have taken their food. The eight behind them are
  // free, which is the whole point: a player may load a line deeper than their supply.
  tickQueues(0.1);
  check("one tick in, the two heads have paid", authority.foodFor(0), { used: 4, made: 12 });
  check("…and the eight behind them still cost nothing",
    [a.building.queue.filter((j) => j.foodPaid).length, b.building.queue.filter((j) => j.foodPaid).length], [1, 1]);
}

{
  // …and at the cap, a head job STANDS THERE. One Footman's worth of room, two Barracks with a
  // Footman at the front of each: the first to be ticked pays and trains, the second holds at
  // its full build time — 0 seconds of progress — rather than both reading "we are over" and
  // neither moving. The moment the supply arrives it pays and starts, with no second click.
  newWorld();
  world.initStash(0, 10000, 10000);
  building("hhou", 0);
  const a = building("hbar", 0);
  const b = building("hbar", 0);
  // 12 made, and 10 already eaten by standing units, leaves room for exactly one Footman.
  for (let i = 0; i < 5; i++) soldier("hfoo", 0);
  check("five Footmen standing, one place left", authority.foodFor(0), { used: 10, made: 12 });
  train(0, a, "hfoo");
  train(0, b, "hfoo");
  tickQueues(1);
  check("the first head paid and is training", [a.building.queue[0].foodPaid === true, a.building.queue[0].timeLeft < 20], [true, true]);
  check("…the second is halted at 0s, unpaid",
    [b.building.queue[0].foodPaid === true, b.building.queue[0].timeLeft], [false, 20]);
  check("…and the halt did not overrun the cap", authority.foodFor(0), { used: 12, made: 12 });
  // A second Farm finishes: the halted job takes its food on the next tick and gets going.
  building("hhou", 0);
  tickQueues(1);
  check("with supply raised it pays and starts",
    [b.building.queue[0].foodPaid === true, b.building.queue[0].timeLeft < 20], [true, true]);
}

console.log("\n-- a FOOD building pays when it is finished (issue #144) --------------------------");

{
  // The report: "food buildings are providing food before they're finished". A Farm pegged out
  // a second ago is a foundation — it makes nothing until the last hammer blow lands.
  newWorld();
  world.initStash(0, 10000, 10000);
  const farm = building("hhou", 0);
  farm.building.constructionLeft = 35; // a Farm's own build time
  const a = building("hbar", 0);
  check("the site makes no food", authority.foodFor(0), { used: 0, made: 0 });
  // The Footman is QUEUED — food gates the head of the queue, not the button — but the head
  // cannot pay on a Farm that is still a foundation, so it stands there at 0s.
  check("…the Footman is still queued on it", train(0, a, "hfoo"), true);
  tickQueues(1);
  check("…but it cannot pay, so nothing moves",
    [a.building.queue[0].foodPaid === true, a.building.queue[0].timeLeft], [false, 20]);
  farm.building.constructionLeft = 0;
  check("finished, it makes its twelve", authority.foodFor(0), { used: 0, made: 12 });
  tickQueues(1);
  check("…and now the Footman pays and starts",
    [a.building.queue[0].foodPaid === true, a.building.queue[0].timeLeft < 20], [true, true]);
}

{
  // An UPGRADE is not a construction site: a hall becoming a Keep (or a Ziggurat a Spirit
  // Tower) keeps its food the whole way through, because an upgrade is a queue job and carries
  // no `constructionLeft` at all.
  newWorld();
  world.initStash(0, 10000, 10000);
  const farm = building("hhou", 0);
  farm.building.queue = [{ kind: "upgrade", unitId: "hhou", level: 1 }];
  check("a building UPGRADING still makes its food", authority.foodFor(0).made, 12);
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
