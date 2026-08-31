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
  const g = grid(treeline(190, 6, 300)); // open only along the top 84 rows
  const from = [20, 20], to = [360, 20];

  const old = findPath(g, from, to, undefined, OLD_BUDGET(from, to));
  const oldEnd = old[old.length - 1];
  check(`the old distance-scaled budget stopped at the trees (x ${oldEnd[0]}, y ${oldEnd[1]})`,
    oldEnd[0] < 190);

  const path = findPath(g, from, to);
  const end = path[path.length - 1];
  check(`now it arrives (end ${end[0]},${end[1]})`, end[0] === to[0] && end[1] === to[1]);
  const highest = path.reduce((m, [, y]) => Math.max(m, y), 0);
  check(`by going round the top of it (highest row ${highest})`, highest >= 300);
}

console.log("the way round is taken however near the thing behind the trees is");
{
  // Same forest, but the goal is just on the other side of it — a short straight line and a
  // very long walk. This is the case the distance-scaled budget was worst at: a near goal
  // bought almost nothing, so the shorter the hop the more certain the unit was to stand in
  // the trees.
  const g = grid(treeline(190, 6, 300));
  const from = [180, 20], to = [210, 20];
  const old = findPath(g, from, to, undefined, OLD_BUDGET(from, to));
  const oldEnd = old[old.length - 1];
  check(`the old budget stopped at the trees (x ${oldEnd[0]})`, oldEnd[0] < 190);

  const path = findPath(g, from, to);
  const end = path[path.length - 1];
  check(`now it arrives (end ${end[0]},${end[1]})`, end[0] === to[0] && end[1] === to[1]);
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

console.log(failures ? `\ndetour: ${failures} check(s) FAILED` : "\ndetour: all checks passed");
process.exit(failures ? 1 : 0);
