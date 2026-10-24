// Headless checks on the two things a shift-queued BUILD order outlives: its ground, and the
// stash it was queued against.
//
// A build site is authorised once, when the player clicks it — and a shift-queued one can
// then sit in a worker's queue for a minute before the worker walks over. That was long
// enough for the previous building in the same queue to rise straight through it: shift-
// click a Barracks, shift-click a second building on top of the first's silhouette, and the
// second was raised INSIDE the first, because nothing ever re-asked the ground. (Nor need
// the two be one player's: an ally or an enemy founding something on the spot you queued
// does it just as well.)
//
// So the sites are re-asked every tick — `SimWorld.dropBlockedBuilds` — and an order the
// ground now refuses is dropped and refunded rather than carried to a wrong build. What is
// checked here is that half: the money comes back, the queue loses exactly the doomed
// entries and keeps the rest, and a worker walking to a site that just died stops so its
// queue can advance. The per-cell test itself (`footprintBuildable`) is checked first, since
// everything above rests on it agreeing with the stamp cell-for-cell.
//
// The MONEY half is the same story told about the stash. A player's placement is bought at the
// click, shift-queued or not, and clearing the queue refunds every building that never started
// (the Authority section). The sim still takes an order handed to it UNPAID — priced when its
// turn comes (`payPendingBuild`), waiting at its site until the stash can answer — and what is
// checked for those is that nothing is refunded that was never taken.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { stampFootprint, footprintBuildable, footprintCellsAt } = require(join(REPO, ".sim-build", "src", "sim", "destructibles.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const CELL = 32;
const FLAGS = new Uint8Array(64 * 64); // walkable + buildable everywhere
const grid = new PathingGrid({ width: 64, height: 64, flags: FLAGS }, [0, 0]);
const world = new SimWorld(grid, 1, { get: () => undefined });

/** A square footprint whose blue (unbuildable) extent is the whole texture — a Farm's
 *  `4x4SimpleSolid.tga` shape, no walkable border, which keeps the arithmetic here honest. */
function solidFp(n) {
  return { w: n, h: n, blocked: new Array(n * n).fill(true), buildBlocked: new Array(n * n).fill(true) };
}

/** A worker, built the way the other sim tests build theirs. */
let nextId = 1;
function worker(over = {}) {
  const u = {
    id: nextId++, owner: 0, team: 0, hp: 220, x: 1024, y: 1024, prevX: 1024, prevY: 1024,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    inventory: [], buffs: [], footprint: 0, hasReservation: false, abilities: [],
    orderQueue: [], order: "idle", targetId: null, followLeaderId: null,
    inCombat: false, noCollision: false, stuckT: 0, stuckRetries: 0, acquireT: 0,
    pendingCast: null, buildPending: null, path: [], moving: false,
    worker: { gold: true, lumber: true, builds: true },
    weapons: [], baseArmor: 0, baseMaxHp: 220, baseMaxMana: 0, baseSpeed: 270, baseSight: 1400,
    maxHp: 220, maxMana: 0, mana: 0, speed: 270,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}

console.log("footprintBuildable indexes the grid exactly as the stamp does");
{
  const fp = solidFp(4);
  const [x, y] = [16 * CELL, 16 * CELL]; // cell-corner centred, as an even footprint snaps
  check("clear ground accepts the site", footprintBuildable(grid, fp, x, y), true);
  stampFootprint(grid, fp, x, y);
  check("…and the same site is refused once something stands on it", footprintBuildable(grid, fp, x, y), false);
  // One cell of overlap is enough — the corner cases are the ones a sloppy centring gets wrong.
  check("a site overlapping by a single cell is refused", footprintBuildable(grid, fp, x + 3 * CELL, y + 3 * CELL), false);
  check("a site exactly clear of it is accepted", footprintBuildable(grid, fp, x + 4 * CELL, y + 4 * CELL), true);
}

console.log("\nground a pending build has spoken for, which is on no grid");
{
  // The click-time half: a queued build reserves nothing on the pathing grid (no structure
  // exists yet), so its cells are carried alongside it and refuse the next placement there.
  const fp = solidFp(4);
  const [x, y] = [40 * CELL, 40 * CELL];
  const taken = new Set();
  footprintCellsAt(grid, fp, x, y, taken);
  check("the reserved cells are the footprint's own", taken.size, 16);
  check("the site itself is still clear ground", footprintBuildable(grid, fp, x, y), true);
  check("…but refused once its own order holds it", footprintBuildable(grid, fp, x, y, taken), false);
  check("an overlapping neighbour is refused too", footprintBuildable(grid, fp, x + 3 * CELL, y, taken), false);
  check("…and one clear of it is not", footprintBuildable(grid, fp, x + 4 * CELL, y, taken), true);
  // Off-map cells must not wrap onto the row above and reserve ground on the far edge.
  const edge = new Set();
  footprintCellsAt(grid, fp, 0, 0, edge);
  check("a site half off the map reserves only its on-map cells", edge.size, 4);
}

console.log("\nthe bug: a queued build on top of the one before it");
{
  world.initStash(0, 500, 300);
  const w = worker();
  // Build A is up (its footprint is the stamp above, at cell 16); build B was queued on the
  // same spot while A was still a ghost, and is what used to be raised inside A.
  world.queueOrder(w.id, { kind: "buildnew", defId: "hbar", x: 16 * CELL, y: 16 * CELL, gold: 160, lumber: 50, paid: true });
  world.queueOrder(w.id, { kind: "buildnew", defId: "hbar", x: 24 * CELL, y: 24 * CELL, gold: 160, lumber: 50, paid: true });
  const blocked = (_defId, x, y) => !footprintBuildable(grid, solidFp(4), x, y);
  check("the doomed order is dropped", world.dropBlockedBuilds(w.id, blocked), 1);
  check("…and only it — the site still clear keeps its place in the queue",
    w.orderQueue.map((o) => [o.kind, o.x / CELL]), [["buildnew", 24]]);
  const stash = world.stashOf(0);
  check("…and its cost comes back", [stash.gold, stash.lumber], [660, 350]);
  check("asking again changes nothing", world.dropBlockedBuilds(w.id, blocked), 0);
}

console.log("\na worker already walking to a site that dies under it");
{
  world.initStash(1, 0, 0);
  const w = worker({ owner: 1, order: "move", moving: true });
  w.buildPending = { defId: "hbar", x: 16 * CELL, y: 16 * CELL, gold: 160, lumber: 50, paid: true };
  w.orderQueue.push({ kind: "harvest", res: "lumber", nodeId: 1 });
  const blocked = (_defId, x, y) => !footprintBuildable(grid, solidFp(4), x, y);
  check("the walk-to-build intent is dropped", [world.dropBlockedBuilds(w.id, blocked), w.buildPending], [1, null]);
  const stash = world.stashOf(1);
  check("…refunded to ITS owner, not the other player's stash", [stash.gold, stash.lumber], [160, 50]);
  // Stopped, so the tick's queue pump (idle + no buildPending) starts the next order rather
  // than the worker finishing a walk to a site that no longer exists.
  check("…and the worker stops, with its remaining queue intact",
    [w.order, w.moving, w.orderQueue.map((o) => o.kind)], ["idle", false, ["harvest"]]);
}

console.log("\nan order the ground still allows is left alone");
{
  world.initStash(2, 100, 100);
  const w = worker({ owner: 2 });
  w.buildPending = { defId: "hbar", x: 40 * CELL, y: 40 * CELL, gold: 160, lumber: 50, paid: true };
  world.queueOrder(w.id, { kind: "buildnew", defId: "hbar", x: 48 * CELL, y: 48 * CELL, gold: 160, lumber: 50, paid: true });
  const blocked = (_defId, x, y) => !footprintBuildable(grid, solidFp(4), x, y);
  check("nothing is dropped", world.dropBlockedBuilds(w.id, blocked), 0);
  check("…no refund is invented", [world.stashOf(2).gold, world.stashOf(2).lumber], [100, 100]);
  check("…and both orders stand", [!!w.buildPending, w.orderQueue.length], [true, 1]);
}

console.log("\nan UNPAID build order is priced when its turn comes, not when it was queued");
{
  // A player's builds are bought at the click (the Authority section below); a bare order handed
  // to the sim with `paid: false` takes nothing until `payPendingBuild` asks the stash at the
  // site, and keeps asking until it can.
  world.initStash(3, 100, 0);
  const w = worker({ owner: 3 });
  world.queueOrder(w.id, { kind: "buildnew", defId: "hwtw", x: 52 * CELL, y: 52 * CELL, gold: 60, lumber: 0, paid: false });
  world.queueOrder(w.id, { kind: "buildnew", defId: "hwtw", x: 56 * CELL, y: 56 * CELL, gold: 60, lumber: 0, paid: false });
  check("queueing two towers on one tower's gold costs nothing yet", world.stashOf(3).gold, 100);

  // Order one becomes the worker's live order: it pays as the worker sets off.
  world.issueBuildNew(w.id, "hwtw", 52 * CELL, 52 * CELL, 60, 0, false);
  check("the live order pays for itself", [world.stashOf(3).gold, w.buildPending.paid], [40, true]);
  check("…and arriving at the site charges nothing a second time",
    [world.payPendingBuild(w.id), world.stashOf(3).gold], [true, 40]);

  // Order two becomes live at a stash that cannot cover it. Nothing is charged and nothing is
  // taken; the site is simply unpaid, which is what the red silhouette draws all the way there.
  world.issueBuildNew(w.id, "hwtw", 56 * CELL, 56 * CELL, 60, 0, false);
  check("a build it cannot afford stays pending, unpaid, and takes nothing",
    [world.payPendingBuild(w.id), w.buildPending.paid, world.stashOf(3).gold], [false, false, 40]);
  // …and if the gold lands while the worker is still walking, the same site goes through.
  world.stashOf(3).gold += 30;
  check("…and pays the moment the mining catches up",
    [world.payPendingBuild(w.id), w.buildPending.paid, world.stashOf(3).gold], [true, true, 10]);
}

console.log("\na build still unaffordable when the worker STANDS on it is refused and dropped");
{
  // The last time the price is asked. A worker that has walked to a building it cannot pay
  // for is told which resource ran out and the order goes — with every unpaid build queued
  // behind it, since a queue that cannot afford its first cannot afford the rest, and the
  // alternative is a lap of sites refused one at a time.
  world.initStash(7, 0, 500);
  const w = worker({ owner: 7, order: "move", moving: true });
  w.buildPending = { defId: "hwtw", x: 52 * CELL, y: 52 * CELL, gold: 60, lumber: 0, paid: false };
  world.queueOrder(w.id, { kind: "buildnew", defId: "hwtw", x: 56 * CELL, y: 56 * CELL, gold: 60, lumber: 0, paid: false });
  world.queueOrder(w.id, { kind: "harvest", res: "lumber", nodeId: 1 });
  check("the site names the resource it is short of", world.dropUnpaidBuilds(w.id), "gold");
  check("…the build it was standing on is gone", w.buildPending, null);
  check("…the unpaid builds behind it go too, and nothing else does",
    w.orderQueue.map((o) => o.kind), ["harvest"]);
  // Stopped, so the tick's queue pump takes the worker on to the harvest rather than leaving
  // it standing on a site it will never raise. Its stash is untouched: it never paid anything.
  check("…the worker stops, with its stash untouched",
    [w.order, w.moving, world.stashOf(7).gold, world.stashOf(7).lumber], ["idle", false, 0, 500]);
  check("…and asking again drops nothing", world.dropUnpaidBuilds(w.id), null);
  // Lumber is named when that is what ran out, and a PAID build is never dropped: its money
  // is committed and it is owed its building.
  const w2 = worker({ owner: 7 });
  w2.buildPending = { defId: "hwtw", x: 40 * CELL, y: 40 * CELL, gold: 0, lumber: 900, paid: false };
  check("a site short of lumber says so", world.dropUnpaidBuilds(w2.id), "lumber");
  const w3 = worker({ owner: 7 });
  w3.buildPending = { defId: "hwtw", x: 44 * CELL, y: 44 * CELL, gold: 60, lumber: 0, paid: true };
  check("a PAID build is not dropped", [world.dropUnpaidBuilds(w3.id), !!w3.buildPending], [null, true]);
}

console.log("\nthe AUTHORITY charges EVERY placement at the click, shift-queued ones included");
{
  // WC3: each silhouette a shift-click lays down takes its price out of the stash the moment
  // it appears, and clearing the queue gives back every one whose construction never started.
  const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));
  const def = { id: "hwtw", goldCost: 30, lumberCost: 20 };
  const registry = { get: (id) => (id === "hwtw" ? def : undefined) };
  const tech = { builds: () => ["hwtw"] };
  const auth = new Authority(world, registry, {}, tech, {});
  world.initStash(6, 10, 40); // ten gold: not a tower's worth, whatever the lumber says
  const w = worker({ owner: 6, typeId: "hpea" });
  const at = (x, y, queued) => ({ c: "build", unitId: w.id, defId: "hwtw", x, y, queued });
  check("a build placed outright on an empty stash is refused", auth.execute(6, at(60 * CELL, 8 * CELL, false)), false);
  check("…and so is the same one shift-queued", auth.execute(6, at(60 * CELL, 8 * CELL, true)), false);
  check("…taking nothing, queueing nothing", [world.stashOf(6).gold, w.orderQueue.length], [10, 0]);
  // Ninety gold buys three towers: one outright, two queued behind it — each paid as it lands.
  world.stashOf(6).gold = 90;
  world.stashOf(6).lumber = 100;
  check("an outright build pays at the click",
    [auth.execute(6, at(56 * CELL, 8 * CELL, false)), world.stashOf(6).gold, w.buildPending.paid], [true, 60, true]);
  check("a shift-queued one pays at the click too",
    [auth.execute(6, at(52 * CELL, 8 * CELL, true)), world.stashOf(6).gold, w.orderQueue.map((o) => o.paid)], [true, 30, [true]]);
  check("…and the next", [auth.execute(6, at(48 * CELL, 8 * CELL, true)), world.stashOf(6).gold], [true, 0]);
  check("a fourth the stash cannot cover is refused at the click", auth.execute(6, at(44 * CELL, 8 * CELL, true)), false);
  check("…leaving the queue at the two it paid for", w.orderQueue.length, 2);
  // Moving the worker away (any fresh order) clears the queue: all three unstarted buildings
  // come back, the one it was walking to and the two behind it.
  check("a fresh order clears the queue…",
    auth.execute(6, { c: "order", unitId: w.id, order: { kind: "move", x: 30 * CELL, y: 30 * CELL }, queued: false }), true);
  check("…and refunds every building that never started",
    [world.stashOf(6).gold, world.stashOf(6).lumber, w.buildPending, w.orderQueue.length], [90, 100, null, 0]);
  // …and so does the worker dying with a paid queue.
  auth.execute(6, at(56 * CELL, 8 * CELL, false));
  auth.execute(6, at(52 * CELL, 8 * CELL, true));
  check("two more bought", world.stashOf(6).gold, 30);
  world.clearQueue(w.id); // what SimWorld's death path does with a dead worker's orders
  check("…both come back when the queue is dropped", [world.stashOf(6).gold, world.stashOf(6).lumber], [90, 100]);
  // A queue that is FULL takes no more, and the click that found it full is not charged.
  for (let i = 0; i < 40; i++) w.orderQueue.push({ kind: "hold" });
  check("a full queue refuses the placement", auth.execute(6, at(40 * CELL, 8 * CELL, true)), false);
  check("…and the price stays in the stash", world.stashOf(6).gold, 90);
  w.orderQueue.length = 0;
}

console.log("\na hall is held off the gold mine's mouth — HALL_MINE_DISTANCE, and who it binds");
{
  // The rule is read off `UnitBalance.type`: TownHall, less undead and less ancient. See the constant in
  // src/sim/world.ts for where 768 comes from (Blizzard's own start locations) and why the
  // Necropolis is out (hiveworkshop 255597 — its gold never travels).
  const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));
  const { HALL_MINE_DISTANCE } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
  const DEFS = {
    htow: { id: "htow", goldCost: 385, lumberCost: 205, classification: ["townhall", "mechanical"] },
    etol: { id: "etol", goldCost: 340, lumberCost: 185, classification: ["townhall", "ancient"] },
    unpl: { id: "unpl", goldCost: 225, lumberCost: 0, classification: ["townhall", "undead", "mechanical"] },
    hhou: { id: "hhou", goldCost: 80, lumberCost: 20, classification: ["mechanical"] },
  };
  const registry = { get: (id) => DEFS[id] };
  const w2 = new SimWorld(grid, 1, { get: () => undefined }, undefined, registry);
  const mine = w2.addMine(1024, 1024, 12500, 128);
  check("the floor is the stock maps' own 768", HALL_MINE_DISTANCE, 768);
  check("a Town Hall a unit inside it is too close", w2.tooCloseToMine("htow", 1024 + 767, 1024), true);
  check("…and ON it is allowed — Terenas Stand's start is exactly 768 on the axis", w2.tooCloseToMine("htow", 1024 + 768, 1024), false);
  check("…measured centre to centre, so a diagonal at Echo Isles' (448,640) is fine", w2.tooCloseToMine("htow", 1024 + 448, 1024 + 640), false);
  // …and neither does a Tree of Life: it is MEANT to stand beside its mine to entangle it, and
  // a wisp is paid inside the Entangled Gold Mine, so there is no trip to shorten either.
  check("a Tree of Life does not", w2.tooCloseToMine("etol", 1024 + 300, 1024), false);
  check("a Necropolis does not", w2.tooCloseToMine("unpl", 1024 + 300, 1024), false);
  check("nor does a Farm", w2.tooCloseToMine("hhou", 1024 + 300, 1024), false);
  // A collapsed mine keeps nothing away.
  w2.mines.delete(mine.id);
  check("a mine that has collapsed no longer binds", w2.tooCloseToMine("htow", 1024 + 300, 1024), false);
  w2.mines.set(mine.id, mine);
  // …and the AUTHORITY refuses it, which is what makes a computer's hall obey the same rule as
  // a player's click: every build order comes through this gate.
  const tech = { builds: () => ["htow", "unpl"] };
  const auth = new Authority(w2, registry, {}, tech, {});
  w2.initStash(3, 5000, 5000);
  const u = worker({ owner: 3, typeId: "hpea" });
  world.units.delete(u.id);
  w2.units.set(u.id, u);
  const build = (defId, x, y) => auth.execute(3, { c: "build", unitId: u.id, defId, x, y, queued: false });
  check("the authority refuses a hall 600 from the rock", build("htow", 1024 + 600, 1024), false);
  check("…and nothing was charged for it", w2.stashOf(3).gold, 5000);
  check("…a Necropolis at 300 goes through", build("unpl", 1024 + 300, 1024), true);
  const a = worker({ owner: 3, typeId: "hpea" });
  world.units.delete(a.id);
  w2.units.set(a.id, a);
  check("…and a hall at 800 goes through", auth.execute(3, { c: "build", unitId: a.id, defId: "htow", x: 1024 + 800, y: 1024, queued: false }), true);
}

console.log("\nan unpaid build refunds nothing, having never been charged");
{
  world.initStash(4, 0, 0);
  const w = worker({ owner: 4 });
  w.buildPending = { defId: "hwtw", x: 16 * CELL, y: 16 * CELL, gold: 60, lumber: 0, paid: false };
  world.queueOrder(w.id, { kind: "buildnew", defId: "hwtw", x: 16 * CELL, y: 16 * CELL, gold: 60, lumber: 0, paid: false });
  const blocked = () => true; // both sites' ground has gone
  check("both doomed orders are dropped", world.dropBlockedBuilds(w.id, blocked), 2);
  check("…and the stash is not paid for gold it never spent", world.stashOf(4).gold, 0);
  // The same rule on the other abandon path: a worker re-tasked off an unpaid build.
  world.initStash(5, 0, 0);
  const w2 = worker({ owner: 5 });
  w2.buildPending = { defId: "hwtw", x: 20 * CELL, y: 20 * CELL, gold: 60, lumber: 0, paid: false };
  world.clearQueue(w2.id);
  check("re-tasking off an unpaid build invents no refund either",
    [w2.buildPending, world.stashOf(5).gold], [null, 0]);
}

console.log("\nthe free first hero is a melee RESOURCE, not a rule about heroes");
{
  // WC3's "first hero is free" is `PLAYER_STATE_RESOURCE_HERO_TOKENS`, and the ONLY thing in
  // the game that hands one out is the melee opening — five `SetPlayerState(…, HERO_TOKENS,
  // bj_MELEE_STARTING_HERO_TOKENS)` calls, all inside Blizzard.j's `MeleeStartingUnits*`, and
  // every one of them a SET rather than an add. A CUSTOM map runs none of them, so its heroes
  // cost full price. We used to model this as a boolean defaulting to "you have one", which
  // made hero #1 free on every map ever loaded — reported on Azure Tower Defense, where the
  // first hero out of the Altar of Summoning came out for nothing.
  const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));
  const auth = new Authority(world, { get: () => undefined }, {}, { builds: () => [] }, {});

  check("a player starts with NO free hero — a custom map never grants one", auth.hasFreeHero(3), false);
  check("…and reads back as zero tokens through GetPlayerState", auth.heroTokensFor(3), 0);

  // The melee opening grants exactly one, however many times it runs (SetPlayerState is a SET).
  auth.setHeroTokens(3, 1);
  auth.setHeroTokens(3, 1);
  check("the melee grant is idempotent", auth.heroTokensFor(3), 1);
  check("…and that player's first hero is free", auth.hasFreeHero(3), true);

  auth.takeFreeHero(3);
  check("spending it leaves none", [auth.heroTokensFor(3), auth.hasFreeHero(3)], [0, false]);
  check("…and spending again cannot go negative", (auth.takeFreeHero(3), auth.heroTokensFor(3)), 0);

  // A cancelled hero train refunds the token with the gold.
  auth.restoreFreeHero(3);
  check("a cancelled hero hands the token back", [auth.heroTokensFor(3), auth.hasFreeHero(3)], [1, true]);

  // The grant is per player: nobody else got one.
  check("the grant is per player", auth.hasFreeHero(4), false);
}

console.log(failed === 0 ? "\nbuild orders: all checks passed" : `\nbuild orders: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
