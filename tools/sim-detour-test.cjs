// Pathing: A* goes ROUND a treeline it cannot see past, instead of walking into it.
//
// findPath is best-effort by design (WC3 is too): when it runs out of budget it hands back
// the explored cell CLOSEST TO THE GOAL. Against a wall of trees that cell is the wall of
// trees, so the exact shape of "the budget was too small" is a unit that marches at the
// forest, stops with its nose against it and stands there — and re-pathing from the trees
// gives the same answer, so it stands there for good.
//
// The budget used to grow with how far away the goal was, which is the wrong measure: the
// flood needed to round a forest is set by the size of the FOREST, not by what is behind it.
// It is now chosen from the grid's static connectivity labels (PathingGrid.regionAt), which
// separate "unreachable" from "reachable the long way round" before the search starts.
//
// Pure grid + findPath — no world, no units, so the numbers below are the pathfinder's own.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { findPath } = require(join(REPO, ".sim-build", "src", "sim", "pathfind.js"));
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

// A melee map's pathing grid: 96 terrain tiles a side, four pathing cells to the tile.
const W = 384, H = 384;
const blank = () => new Uint8Array(W * H);
const grid = (flags) => new PathingGrid({ width: W, height: H, flags }, [0, 0]);

/** A treeline standing on column `cx`, `thick` cells wide, from the south edge up to `top`.
 *  Below `top` there is no way through; above it the map is open. */
function treeline(cx, thick, top) {
  const flags = blank();
  for (let y = 0; y < top; y++)
    for (let x = cx; x < cx + thick; x++) flags[y * W + x] = PathingFlag.Unwalkable;
  return flags;
}

// The budget the old distance-scaled rule would have handed this search, so the test can
// show the two answers side by side rather than only asserting the new one.
const OLD_BUDGET = (from, to) => {
  const dx = Math.abs(from[0] - to[0]), dy = Math.abs(from[1] - to[1]);
  const octile = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  return Math.min(32768, Math.max(8192, Math.round(octile * 64)));
};

console.log("a goal behind a long treeline is walked round, not walked into");
{
  const g = grid(treeline(190, 6, 120)); // 3840 world units of unbroken trunks
  const from = [20, 20], to = [360, 20];

  const old = findPath(g, from, to, undefined, OLD_BUDGET(from, to));
  const oldEnd = old[old.length - 1];
  check(`the old distance-scaled budget never got there (stopped ${oldEnd[0]},${oldEnd[1]})`,
    oldEnd[0] !== to[0] || oldEnd[1] !== to[1]);

  const path = findPath(g, from, to);
  const end = path[path.length - 1];
  check(`now it arrives (end ${end[0]},${end[1]})`, end[0] === to[0] && end[1] === to[1]);
  const highest = path.reduce((m, [, y]) => Math.max(m, y), 0);
  check(`by going round the top of it (highest row ${highest})`, highest >= 120);
}

console.log("the way round is taken however near the thing behind the trees is");
{
  // Same forest, but the goal is just on the other side of it — a short straight line and a
  // very long walk. This is the case the distance-scaled budget was worst at: a near goal
  // bought almost nothing, so the shorter the hop the more certain the unit was to stand in
  // the trees.
  const g = grid(treeline(190, 6, 120));
  const from = [180, 20], to = [210, 20];
  const old = findPath(g, from, to, undefined, OLD_BUDGET(from, to));
  const oldEnd = old[old.length - 1];
  check(`the old budget stopped at the trees (x ${oldEnd[0]})`, oldEnd[0] < 190);

  const path = findPath(g, from, to);
  const end = path[path.length - 1];
  check(`now it arrives (end ${end[0]},${end[1]})`, end[0] === to[0] && end[1] === to[1]);
}

console.log("the question is asked with the MOVER'S OWN FOOTPRINT");
{
  // A one-cell corridor through the wall: a point can thread it and a 2×2 body cannot. Told
  // one cell wide, the labels call the far side reachable for everybody — and the 2×2's
  // search then spends its ENTIRE budget discovering otherwise, every time it is asked. That
  // is what a flat ~40 ms stall several times a second looked like on a real map.
  const flags = blank();
  for (let y = 0; y < H; y++) for (let x = 190; x < 196; x++) flags[y * W + x] = PathingFlag.Unwalkable;
  for (let x = 190; x < 196; x++) flags[100 * W + x] = 0;
  const g = grid(flags);
  check("one region for a 1×1", g.sameRegion(20, 20, 360, 20, "ground", 1));
  check("two regions for a 2×2", !g.sameRegion(20, 20, 360, 20, "ground", 2));
  check("…and for a 3×3", !g.sameRegion(20, 20, 360, 20, "ground", 3));
  const blocked = (cx, cy) => !g.footprintClear(cx, cy, 2);
  const path = findPath(g, [20, 20], [360, 20], blocked, undefined, "ground", undefined, 2);
  check(`the 2×2 walks up to the wall (x ${path[path.length - 1][0]})`, path[path.length - 1][0] < 190);
  // The point is the COST, not the answer: both budgets end at the wall, and only one of them
  // pays the ceiling to get there.
  const spend = (b) => { const t = process.hrtime.bigint(); findPath(g, [20, 20], [360, 20], blocked, b, "ground", undefined, 2); return Number(process.hrtime.bigint() - t) / 1e6; };
  const floor = spend(8192), ceil = spend(32768);
  const auto = (() => { const t = process.hrtime.bigint(); findPath(g, [20, 20], [360, 20], blocked, undefined, "ground", undefined, 2); return Number(process.hrtime.bigint() - t) / 1e6; })();
  check(`and it is priced as unreachable, not as a detour (${auto.toFixed(1)} ms vs floor ${floor.toFixed(1)} / ceiling ${ceil.toFixed(1)})`,
    auto < (floor + ceil) / 2);
}

console.log("the ceiling is a real bound, and a wall past it does not hang the search");
{
  // Far longer than any real map's treeline — 9600 world units of unbroken trunks with the
  // only way round at the very end. This one needs about 77k expansions and the ceiling is
  // 32768, so it comes back best-effort at the trees, exactly as everything used to. That is
  // the documented limit of the fix and it is deliberate: the alternative is a budget every
  // failing search in a crush spends, which measured four times worse than the bug.
  const g = grid(treeline(190, 6, 300));
  const t0 = process.hrtime.bigint();
  const path = findPath(g, [20, 20], [360, 20]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`it returns, bounded (${ms.toFixed(1)} ms)`, path !== null && ms < 40);
  check("…best-effort, as the floor always did", path[path.length - 1][0] < 190);
}

console.log("a goal with no way to it at all is still refused, and cheaply");
{
  const flags = blank(); // a wall with no gap: two regions, and no route between them
  for (let y = 0; y < H; y++) for (let x = 190; x < 196; x++) flags[y * W + x] = PathingFlag.Unwalkable;
  const g = grid(flags);
  check("the two sides are different regions", !g.sameRegion(20, 20, 360, 20));
  const path = findPath(g, [20, 20], [360, 20]);
  const end = path[path.length - 1];
  check(`best-effort still walks up to the wall (x ${end[0]})`, end[0] >= 185 && end[0] < 190);
}

console.log("a goal on ground we cannot reach snaps to ground we can");
{
  // An order given across the water used to snap onto the far shore, which turned the walk
  // to our OWN beach into a capped best-effort search for a goal on the wrong side of the
  // map. Where the two sides are separate ground, aim at the near one and just walk there.
  // (Inside a treeline you can walk round, nothing changes: both sides are the same region,
  // so the nearest trunk-free cell still wins whichever side it is on — which is WC3's own
  // answer to a click into a forest.)
  const flags = blank();
  for (let y = 0; y < H; y++) for (let x = 190; x < 196; x++) flags[y * W + x] = PathingFlag.Unwalkable;
  const g = grid(flags);
  const path = findPath(g, [20, 20], [300, 20]); // across the divide
  const end = path[path.length - 1];
  check(`ends on our own side (x ${end[0]})`, end[0] < 190);
  check("having never crossed", path.every(([x]) => x < 190));
}

console.log("region labels follow the map as it changes");
{
  const g = grid(blank());
  // A treeline STAMPED on open ground, the way destructibles and buildings arrive.
  for (let y = 0; y < H; y++) for (let x = 190; x < 196; x++) g.block(x, y);
  check("stamped: two regions", !g.sameRegion(20, 20, 360, 20));
  check("and no route through", findPath(g, [20, 20], [360, 20]).pop()[0] < 190);
  // Fell one row of it. The labels are rebuilt on the next question, not on the edit.
  for (let x = 190; x < 196; x++) g.unblock(x, 100);
  check("felled: one region again", g.sameRegion(20, 20, 360, 20));
  check("and the gap is used", findPath(g, [20, 20], [360, 20]).pop()[0] === 360);
  // Counted stamps: a second tree on the same cells keeps them shut when one is felled.
  for (let x = 190; x < 196; x++) { g.block(x, 100); g.block(x, 100); g.unblock(x, 100); }
  check("a doubly-stamped cell stays shut", !g.sameRegion(20, 20, 360, 20));
}

console.log("a 4-connected label never promises a diagonal pinch");
{
  // Two rooms joined only at a corner. A* forbids corner-cutting, so nothing can pass; an
  // 8-connected labelling would call them one region and fund a search for a route that
  // does not exist.
  const flags = blank();
  for (let y = 0; y < H; y++) for (let x = 190; x < 196; x++) flags[y * W + x] = PathingFlag.Unwalkable;
  for (let x = 190; x < 196; x++) flags[100 * W + x] = 0; // a one-cell-tall corridor…
  const g = grid(flags);
  check("a one-cell corridor does join them", g.sameRegion(20, 20, 360, 20));
  const path = findPath(g, [20, 20], [360, 20]);
  check("and the search threads it", path[path.length - 1][0] === 360);
}

console.log("and a UNIT sent past a treeline walks round it");
{
  // The whole point, end to end, and the shape of the report: findPath above is one search,
  // while a move order re-runs it every time the walk stalls — so a unit does claw its way
  // round a SHORT wall on best-effort paths alone, a bit at a time. Past a certain length it
  // stops being able to: the search from the treeline is no better than the one that put it
  // there, the walk makes no headway, and the order is given up. Measured on this grid, a
  // wall of 150 cells (4800 world units of unbroken trunks) is past that line — before this
  // it parked at x≈3808, one cell from the trees, and went idle.
  const SIM_DT = 1 / 60;
  const WALL = 120; // column, ×32 = world x 3840
  const flags = blank();
  for (let y = 0; y < 150; y++) for (let k = 0; k < 4; k++) flags[y * W + WALL + k] = PathingFlag.Unwalkable;
  const world = new SimWorld(grid(flags), 1);
  world.add({
    id: 1, owner: 0, team: 0, typeId: "hfoo", x: 1000, y: 500, facing: 0,
    hp: 1e6, maxHp: 1e6, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0, sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [],
  });
  const goalX = (WALL + 60) * 32;
  world.issueMove(1, goalX, 500); // straight through the wall, as the crow flies
  let highest = 0;
  let t = 0;
  for (let i = 0; i < Math.round(90 / SIM_DT); i++) {
    world.tick(SIM_DT);
    t += SIM_DT;
    const u = world.units.get(1);
    highest = Math.max(highest, u.y);
    if (u.x > goalX - 64) break;
  }
  const u = world.units.get(1);
  check(`it got to the far side (x ${u.x.toFixed(0)} of ${goalX}, in ${t.toFixed(1)}s)`, u.x > goalX - 200);
  check(`by walking round the north end of the trees (reached y ${highest.toFixed(0)})`, highest > 150 * 32);
  check(`and never gave the order up (order ${u.order})`, u.order !== "idle" || u.x > goalX - 200);
}

console.log(failures ? `\ndetour: ${failures} check(s) FAILED` : "\ndetour: all checks passed");
process.exit(failures ? 1 : 0);
