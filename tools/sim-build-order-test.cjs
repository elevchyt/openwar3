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
// The MONEY half is the same story told about the stash. A queued build is not asked what it
// costs at the click — queueing five towers is a statement about the next minute, and the gold
// for the fifth is meant to come out of the mining that happens while the first four go up — so
// it is priced when its turn comes (`payPendingBuild`) and simply waits at its site, unpaid,
// until the stash can answer. What is checked here is that the two halves of that never leak:
// nothing is taken at the click, nothing is refunded that was never taken, and an outright
// (unshifted) placement still pays at the click exactly as WC3 does.
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

console.log("\na shift-queued build is priced when its turn comes, not when it was queued");
{
  // The queue is a statement about the next minute: five towers queued on one tower's gold is
  // a normal thing to ask for, because the mining that happens while the first goes up pays
  // for the second. So a queued `buildnew` carries `paid: false` and takes nothing at the
  // click; `payPendingBuild` asks the stash at the site, and keeps asking until it can.
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

  // Order two arrives at a stash that cannot cover it. The build is NOT dropped: the worker
  // waits at the site (its silhouette drawn red) and the question is asked again next tick.
  world.issueBuildNew(w.id, "hwtw", 56 * CELL, 56 * CELL, 60, 0, false);
  check("a build it cannot afford stays pending, unpaid, and takes nothing",
    [world.payPendingBuild(w.id), w.buildPending.paid, world.stashOf(3).gold], [false, false, 40]);
  // …and the moment the gold lands, the same site goes through.
  world.stashOf(3).gold += 30;
  check("…and pays the moment the mining catches up",
    [world.payPendingBuild(w.id), w.buildPending.paid, world.stashOf(3).gold], [true, true, 10]);
}

console.log("\nthe AUTHORITY asks the price of an outright build and not of a queued one");
{
  const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));
  const def = { id: "hwtw", goldCost: 30, lumberCost: 20 };
  const registry = { get: (id) => (id === "hwtw" ? def : undefined) };
  const tech = { builds: () => ["hwtw"] };
  const auth = new Authority(world, registry, {}, tech, {});
  world.initStash(6, 10, 40); // ten gold: not a tower's worth, whatever the lumber says
  const w = worker({ owner: 6, typeId: "hpea" });
  const at = (x, y, queued) => ({ c: "build", unitId: w.id, defId: "hwtw", x, y, queued });
  check("a build placed outright on an empty stash is refused", auth.execute(6, at(60 * CELL, 8 * CELL, false)), false);
  // …but the same building SHIFT-queued is taken, because it is not this instant's gold it
  // is spending. Nothing is charged and nothing is refused; the price is asked at the site.
  check("…and the same one shift-queued is accepted", auth.execute(6, at(60 * CELL, 8 * CELL, true)), true);
  check("…taking nothing from the stash, and marked unpaid",
    [world.stashOf(6).gold, w.orderQueue.map((o) => o.paid)], [10, [false]]);
  // With the gold in hand the outright build goes through and pays at the click, WC3-style.
  world.stashOf(6).gold = 100;
  check("an outright build the player CAN afford still pays at the click",
    [auth.execute(6, at(56 * CELL, 8 * CELL, false)), world.stashOf(6).gold, w.buildPending.paid], [true, 70, true]);
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

console.log(failed === 0 ? "\nbuild orders: all checks passed" : `\nbuild orders: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
