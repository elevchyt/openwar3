// Headless check that a shift-queued BUILD order cannot outlive its ground.
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
  world.queueOrder(w.id, { kind: "buildnew", defId: "hbar", x: 16 * CELL, y: 16 * CELL, gold: 160, lumber: 50 });
  world.queueOrder(w.id, { kind: "buildnew", defId: "hbar", x: 24 * CELL, y: 24 * CELL, gold: 160, lumber: 50 });
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
  w.buildPending = { defId: "hbar", x: 16 * CELL, y: 16 * CELL, gold: 160, lumber: 50 };
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
  w.buildPending = { defId: "hbar", x: 40 * CELL, y: 40 * CELL, gold: 160, lumber: 50 };
  world.queueOrder(w.id, { kind: "buildnew", defId: "hbar", x: 48 * CELL, y: 48 * CELL, gold: 160, lumber: 50 });
  const blocked = (_defId, x, y) => !footprintBuildable(grid, solidFp(4), x, y);
  check("nothing is dropped", world.dropBlockedBuilds(w.id, blocked), 0);
  check("…no refund is invented", [world.stashOf(2).gold, world.stashOf(2).lumber], [100, 100]);
  check("…and both orders stand", [!!w.buildPending, w.orderQueue.length], [true, 1]);
}

console.log(failed === 0 ? "\nbuild orders: all checks passed" : `\nbuild orders: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
