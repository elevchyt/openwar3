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
const { findPath, beginPath, PathScratch, pathExpansionsSpent, PATH_FLOOR_EXPANSIONS } = require(join(REPO, ".sim-build", "src", "sim", "pathfind.js"));
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

console.log("a treeline longer than any real map's is walked round too");
{
  // 9600 world units of unbroken trunks with the only way round at the very end — far longer
  // than a 96x96 map can hold. This needs ~77k expansions, which the old 32768 ceiling could
  // not buy, so it used to come back best-effort with its nose in the trees. That was the
  // documented limit of the first fix; it is now inside the budget.
  const g = grid(treeline(190, 6, 300));
  const path = findPath(g, [20, 20], [360, 20]);
  check("it arrives", path[path.length - 1][0] === 360);
}

console.log("and the same holds on the BIG grids, which is where 32768 never reached at all");
{
  // The report the ceiling was raised for: a destination past a big obstacle on a big map.
  // The cost of rounding an obstacle is set by the obstacle, and an obstacle grows with the
  // map, so a ceiling measured on a 96x96 melee map did not buy the way round even a SHORT
  // wall on a 192x192 or 256x256 one — on a big map essentially every obstacle worth the
  // name was "too big" and the unit walked into it.
  for (const [side, wall, oldNeed] of [[768, 200, 99426], [1024, 200, 143219]]) {
    const flags = new Uint8Array(side * side);
    const cx = (side >> 1) - 3;
    for (let y = 0; y < wall; y++)
      for (let x = cx; x < cx + 6; x++) flags[y * side + x] = PathingFlag.Unwalkable;
    const g = new PathingGrid({ width: side, height: side, flags }, [0, 0]);
    const from = [20, 20], to = [side - 24, 20];
    const old = findPath(g, from, to, undefined, 32768);
    check(`${side}: the old ceiling stopped at the trees (x ${old[old.length - 1][0]}, needs ~${oldNeed})`,
      old[old.length - 1][0] < cx);
    const t0 = process.hrtime.bigint();
    const path = findPath(g, from, to);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const end = path[path.length - 1];
    check(`${side}: now it arrives (${ms.toFixed(1)} ms)`, end[0] === to[0] && end[1] === to[1]);
  }
}

console.log("the ceiling is still a real bound, and nothing past it hangs the search");
{
  // A wall down four fifths of a 256x256 map's grid, gap at the far end: ~560k expansions,
  // past the 262144 ceiling. It still comes back best-effort rather than flooding on, and
  // the escalation that funded it then waits in proportion to what it spent (see
  // SimWorld.escalate) — which is what lets the ceiling be this size at all.
  const side = 1024;
  const flags = new Uint8Array(side * side);
  const cx = (side >> 1) - 3;
  for (let y = 0; y < 819; y++)
    for (let x = cx; x < cx + 6; x++) flags[y * side + x] = PathingFlag.Unwalkable;
  const g = new PathingGrid({ width: side, height: side, flags }, [0, 0]);
  findPath(g, [20, 20], [side - 24, 20]); // warm the scratch, which is allocated per map size
  const t0 = process.hrtime.bigint();
  const path = findPath(g, [20, 20], [side - 24, 20]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`it returns, bounded (${ms.toFixed(1)} ms)`, path !== null && ms < 200);
  check("…best-effort, as the floor always did", path[path.length - 1][0] < cx);
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

console.log("…and a unit ordered to ATTACK past it walks round it the same way");
{
  // The same wall, and an enemy standing where the move above was aimed. An ATTACK order
  // walked into the trunks instead: its chase searched with COMBAT_EXPANSIONS (700) and a
  // budgeted search was barred from the funded detour a move order buys, so the best-effort
  // path ended at the trees, the stall watchdog's 700-cell reachability probe agreed the
  // target was "unreachable", and the unit parked facing it (developer). A chase may now
  // escalate exactly as a move does, and reachability asks the region labels first.
  const SIM_DT = 1 / 60;
  const WALL = 120;
  const flags = blank();
  for (let y = 0; y < 150; y++) for (let k = 0; k < 4; k++) flags[y * W + WALL + k] = PathingFlag.Unwalkable;
  const world = new SimWorld(grid(flags), 1);
  const weapon = () => ({
    enabled: true, targets: ["ground", "air", "structure"], ranged: false,
    damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
    cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
    damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
    spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
    acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
    launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
  });
  const footman = (id, owner, x, y) => ({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 1e6, maxHp: 1e6, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0, sightDay: 6000, sightNight: 6000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [weapon()], oldWeapons: [weapon()],
  });
  world.add(footman(1, 0, 1000, 500));
  const goalX = (WALL + 60) * 32;
  world.add(footman(2, 1, goalX, 500)); // the enemy, the other side of the trunks
  world.issueHold(2); // it stays put — this is the attacker's walk being measured
  check("the attack order is accepted", world.issueAttack(1, 2, false, true));
  let highest = 0;
  let t = 0;
  for (let i = 0; i < Math.round(90 / SIM_DT); i++) {
    world.tick(SIM_DT);
    t += SIM_DT;
    const u = world.units.get(1);
    highest = Math.max(highest, u.y);
    if (u.x > goalX - 200) break;
  }
  const u = world.units.get(1);
  check(`it reached its target (x ${u.x.toFixed(0)} of ${goalX}, in ${t.toFixed(1)}s)`, u.x > goalX - 200);
  check(`by walking round the north end of the trees (reached y ${highest.toFixed(0)})`, highest > 150 * 32);
  check(`and is still on the attack (order ${u.order})`, u.order === "attack");
}

console.log("…and a GROUP does, on a big map, past an obstacle sized for one");
{
  // The report, end to end and at the size it was reported at. A 192x192 map's grid with a
  // 300-cell treeline: with the 32768 ceiling this needed ~117k expansions, so every search
  // — the first one and every re-path from the trees after it — came back best-effort at the
  // trunks, and the group stood there. Measured on this grid before the ceiling was raised,
  // 0 of 4 arrived in 400 simulated seconds; they now round it in about 66.
  //
  // FOUR of them, because the long search is funded out of a global allowance: one unit gets
  // it, the rest re-path a moment later and take their turn. That the last one still gets
  // round is what says the allowance — now priced in expansions, so a big search buys a
  // proportionally longer wait — is still handing the slot out often enough to be useful.
  const SIM_DT = 1 / 60;
  const SIDE = 768, WALL = SIDE >> 1, WALL_TOP = 300, N = 4;
  const flags = new Uint8Array(SIDE * SIDE);
  for (let y = 0; y < WALL_TOP; y++)
    for (let k = 0; k < 6; k++) flags[y * SIDE + WALL + k] = PathingFlag.Unwalkable;
  const world = new SimWorld(new PathingGrid({ width: SIDE, height: SIDE, flags }, [0, 0]), 1);
  for (let i = 0; i < N; i++) world.add({
    id: i + 1, owner: 0, team: 0, typeId: "hfoo", x: (WALL - 40) * 32 + i * 40, y: 20 * 32, facing: 0,
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
  const goalX = (WALL + 40) * 32;
  for (let i = 0; i < N; i++) world.issueMove(i + 1, goalX, 20 * 32);
  const there = () => { let n = 0; for (let k = 1; k <= N; k++) if (world.units.get(k).x > goalX - 200) n++; return n; };
  let t = 0;
  for (let i = 0; i < Math.round(150 / SIM_DT) && there() < N; i++) { world.tick(SIM_DT); t += SIM_DT; }
  check(`all ${N} got to the far side (${there()}/${N}, in ${t.toFixed(0)}s)`, there() === N);
}

// A CROWD-AVOIDING reroute must not buy the escalated flood.
//
// `escalate` licenses the big search off the static region labels, which are built on terrain
// and building stamps with bodies deliberately left out. That is a fair proof for the ordinary
// predicate (whose only bodies are units standing still) and no proof at all for `avoidMovers`,
// which makes a wall of everyone holding ground. The shape below is what the AI's own column
// looks like from inside it: open ground everywhere, so the labels say one region and "fund
// it", and the goal shut in by bodies, so nothing can arrive however long it looks.
console.log("a flood licensed by the terrain cannot pay off against BODIES");
{
  const BIG = 1024; // Feralas LV's own size, where a region is most of the map
  const g = new PathingGrid({ width: BIG, height: BIG, flags: new Uint8Array(BIG * BIG) }, [0, 0]);
  const sx = 100, sy = 500, gx = 400, gy = 500;
  const ringOfBodies = (cx, cy) => {
    const dx = cx - gx, dy = cy - gy, d2 = dx * dx + dy * dy;
    return d2 <= 30 * 30 && d2 >= 26 * 26;
  };
  const at = (budget) => {
    const p = findPath(g, [sx, sy], [gx, gy], ringOfBodies, budget);
    return { end: p && p.length ? p[p.length - 1] : null, spent: pathExpansionsSpent() };
  };
  const floor = at(PATH_FLOOR_EXPANSIONS);
  const flood = at(262144);
  check(`the floor cannot arrive either (spends ${floor.spent})`,
    !!floor.end && !(floor.end[0] === gx && floor.end[1] === gy));
  check(`the flood spends far more looking (${floor.spent} -> ${flood.spent})`,
    flood.spent > floor.spent * 20);
  check("…and hands back the very same cell for it",
    !!floor.end && !!flood.end && floor.end[0] === flood.end[0] && floor.end[1] === flood.end[1]);
}

// A blocked unit REPAIRS its route; it does not plan a new one.
//
// What Warcraft III does when the next node is shut (bear_369, hiveworkshop 352974 post
// 3614130, tested by dropping walls in front of a walking unit): drop the queued nodes that
// are no longer traversable, search to the first that still is, splice. The search is bounded
// by construction — the goal is on a route that was good a moment ago — and it is never the
// escalated flood, because that is licensed by terrain and the thing in the way is BODIES.
console.log("a unit walled off mid-walk mends its path and keeps its order");
{
  const { setSimProfiler } = require(join(REPO, ".sim-build", "src", "sim", "profile.js"));
  const SIM_DT = 1 / 60;
  const SIDE = 384;
  const world = new SimWorld(new PathingGrid({ width: SIDE, height: SIDE, flags: new Uint8Array(SIDE * SIDE) }, [0, 0]), 1);
  const footman = (id, x, y) => ({
    id, owner: 0, team: 0, typeId: "hfoo", x, y, facing: 0,
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
  // Every search the world makes, counted: how many were repairs, and the dearest of them.
  let repairs = 0, searches = 0, dearest = 0;
  setSimProfiler({
    begin() {}, end() {}, gauge() {},
    tally(name, n = 1) {
      if (name === "pathRepairs") repairs += n;
      if (name === "pathSearches") searches += n;
      if (name === "pathExpansions") dearest = Math.max(dearest, n);
    },
  });
  world.add(footman(1, 40 * 32, 200 * 32));
  // The goal is 30 cells past the wall, not 220: the leg from the wall's end back into the
  // lane is then STEEP rather than grazing. A shallow return leg trips a planner-vs-movement
  // mismatch that predates this test and is not what it measures — `smoothPath` validates a
  // leg from cell centre to cell centre, but the unit walks it from wherever it stood when it
  // passed the previous waypoint (inside ARRIVE_EPS), and at a corner that offset crosses the
  // even-footprint rounding boundary onto the wall's reserved row: every re-plan then says
  // "straight is clear" and every step says "reserved", and the unit parks there for good.
  const goalX = 150 * 32, goalY = 200 * 32;
  world.issueMove(1, goalX, goalY); // a walk across open ground: ONE plan
  const u = world.units.get(1);
  // …under way, and up to six cells short of where the wall will stand. The proactive poll
  // (repathPoll: five cells of lookahead every quarter second) would otherwise see the wall
  // land eighty cells ahead and re-plan before the unit ever bumped it — a fine thing, and a
  // different mechanism. This test is the BLOCKED branch's, so the poll is held off for it;
  // the one-body-gap test in sim-pathing-test.cjs is where the two run together.
  while (u.x < (120 - 6) * 32) world.tick(SIM_DT);
  u.repollT = 1e9;
  const plansBefore = searches;
  // Now a wall of STOPPED friendlies drops across the way ahead — a column 40 cells tall,
  // open ground above and below it. Standing still, they reserve their cells, which is
  // exactly what the pathfinder treats as a wall. They are put on HOLD, as the gap test's
  // plug is: an IDLE ally standing in a blocked unit's way is fair game for `makeWay`, which
  // shuffles it aside — and a wall that shuffles is not a wall, it is a different test
  // (and one that trips over makeWay leaving the shuffled unit's reservation behind).
  let id = 2;
  for (let y = 180; y <= 220; y += 2) { world.add(footman(id, 120 * 32, y * 32)); world.issueHold(id); id++; }
  let t = 0;
  const arrived = () => Math.hypot(u.x - goalX, u.y - goalY) < 200;
  for (let i = 0; i < Math.round(60 / SIM_DT) && !arrived(); i++) { world.tick(SIM_DT); t += SIM_DT; }
  setSimProfiler(null);
  check(`it got there anyway (in ${t.toFixed(0)}s)`, arrived());
  check(`by mending the route (${repairs} repair${repairs === 1 ? "" : "s"})`, repairs >= 1);
  check(`and its order survived the mending (still aimed at ${goalX},${goalY})`, u.chaseX === goalX && u.chaseY === goalY);
  check(`no search along the way was escalated (dearest ${dearest} of a ${PATH_FLOOR_EXPANSIONS} floor)`,
    dearest <= PATH_FLOOR_EXPANSIONS);
  check(`and the walk was ${searches - plansBefore} search(es) after the wall, not a flood`, searches - plansBefore <= 12);
}

// A route whose leg grazes a reserved corner is walked as it was validated.
//
// The geometry that wedged: the goal far past the wall, so the leg from the wall's end back
// into the lane is shallow and passes within a hair of the corner. lineClear validated it
// from cell centre to cell centre; the unit then walked it from wherever it stood inside
// ARRIVE_EPS of the previous waypoint, and at the corner that offset crossed the
// even-footprint rounding onto the wall's reserved row — every plan said "clear", every
// step said "reserved", and it parked there for the rest of the run. Waypoints are now
// passed by standing ON them.
console.log("a leg that grazes a reserved corner is walked as it was validated");
{
  const SIM_DT = 1 / 60;
  const SIDE = 384;
  const world = new SimWorld(new PathingGrid({ width: SIDE, height: SIDE, flags: new Uint8Array(SIDE * SIDE) }, [0, 0]), 1);
  const footman = (id, x, y) => ({
    id, owner: 0, team: 0, typeId: "hfoo", x, y, facing: 0,
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
  world.add(footman(1, 40 * 32, 200 * 32));
  const goalX = 340 * 32, goalY = 200 * 32; // far past the wall: the shallow return leg
  world.issueMove(1, goalX, goalY);
  const u = world.units.get(1);
  while (u.x < (120 - 6) * 32) world.tick(SIM_DT);
  let id = 2;
  for (let y = 180; y <= 220; y += 2) { world.add(footman(id, 120 * 32, y * 32)); world.issueHold(id); id++; }
  let t = 0;
  const arrived = () => Math.hypot(u.x - goalX, u.y - goalY) < 200;
  for (let i = 0; i < Math.round(60 / SIM_DT) && !arrived(); i++) { world.tick(SIM_DT); t += SIM_DT; }
  check(`it rounded the corner and got there (in ${t.toFixed(0)}s)`, arrived());
}

// The proactive poll mends too. Same wall, dropped eighty cells ahead with the poll RUNNING:
// it used to see the wall inside its lookahead and re-plan to the far goal at once (one
// 579-expansion search, no repair). Now it mends the route it has, like the blocked branch.
console.log("the poll mends the route it has rather than planning a new one");
{
  const { setSimProfiler } = require(join(REPO, ".sim-build", "src", "sim", "profile.js"));
  const SIM_DT = 1 / 60;
  const SIDE = 384;
  const world = new SimWorld(new PathingGrid({ width: SIDE, height: SIDE, flags: new Uint8Array(SIDE * SIDE) }, [0, 0]), 1);
  const footman = (id, x, y) => ({
    id, owner: 0, team: 0, typeId: "hfoo", x, y, facing: 0,
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
  let repairs = 0, dearest = 0;
  setSimProfiler({ begin() {}, end() {}, gauge() {},
    tally(name, n = 1) { if (name === "pathRepairs") repairs += n; if (name === "pathExpansions") dearest = Math.max(dearest, n); } });
  world.add(footman(1, 40 * 32, 200 * 32));
  const goalX = 150 * 32, goalY = 200 * 32;
  world.issueMove(1, goalX, goalY);
  const u = world.units.get(1);
  for (let i = 0; i < Math.round(2 / SIM_DT); i++) world.tick(SIM_DT); // under way, wall 80 cells ahead
  let id = 2;
  for (let y = 180; y <= 220; y += 2) { world.add(footman(id, 120 * 32, y * 32)); world.issueHold(id); id++; }
  let t = 0;
  const arrived = () => Math.hypot(u.x - goalX, u.y - goalY) < 200;
  for (let i = 0; i < Math.round(60 / SIM_DT) && !arrived(); i++) { world.tick(SIM_DT); t += SIM_DT; }
  setSimProfiler(null);
  check(`it got there (in ${t.toFixed(0)}s)`, arrived());
  check(`the poll mended the route (${repairs} repair${repairs === 1 ? "" : "s"})`, repairs >= 1);
  check(`and nothing was escalated (dearest ${dearest})`, dearest <= PATH_FLOOR_EXPANSIONS);
}

// A search cut into slices answers exactly what the same search answers in one go.
//
// The escalated search now runs across sim steps (SimWorld.pumpPathJob). It is the same
// loop on a working set of its own, and the slice boundary is counted in expansions, so a
// replay and a LAN client — which never see the wall clock — get the same route cell for
// cell. Checked on the treeline the group test uses, which is a real ~100k-expansion detour.
console.log("a sliced search is the same search");
{
  const SIDE = 768, WALL = SIDE >> 1, WALL_TOP = 300;
  const flags = new Uint8Array(SIDE * SIDE);
  for (let y = 0; y < WALL_TOP; y++)
    for (let k = 0; k < 6; k++) flags[y * SIDE + WALL + k] = PathingFlag.Unwalkable;
  const g = new PathingGrid({ width: SIDE, height: SIDE, flags }, [0, 0]);
  const from = [WALL - 40, 20], to = [WALL + 40, 20];
  const whole = findPath(g, from, to, undefined, undefined, "ground", undefined, 2);
  const spentWhole = pathExpansionsSpent();
  const own = new PathScratch();
  const job = beginPath(own, g, from, to, undefined, undefined, "ground", undefined, 2);
  let slices = 0;
  while (!job.run(8192)) slices++;
  const sliced = job.result();
  const same = whole.length === sliced.length && whole.every((c, i) => c[0] === sliced[i][0] && c[1] === sliced[i][1]);
  check(`it took ${slices + 1} slices of 8192 for ${job.expansions} expansions (one-go: ${spentWhole})`, job.expansions === spentWhole);
  check(`and produced the identical ${sliced.length}-cell path`, same);
  check(`which reaches the goal`, sliced.length > 1 && sliced[sliced.length - 1][0] === to[0] && sliced[sliced.length - 1][1] === to[1]);
}

// …and no sim step ever pays for the whole of it. The group test above is the escalation
// in anger — four units, a 300-cell treeline, a detour the floor cannot find — so it is run
// again here with the profiler counting what each STEP spends. Before slicing, one step
// carried the entire detour (~100k expansions); now no step carries more than a plan, a
// slice and a handful of repairs.
console.log("no single step pays for the detour");
{
  const { setSimProfiler } = require(join(REPO, ".sim-build", "src", "sim", "profile.js"));
  const SIM_DT = 1 / 60;
  const SIDE = 768, WALL = SIDE >> 1, WALL_TOP = 300, N = 4;
  const flags = new Uint8Array(SIDE * SIDE);
  for (let y = 0; y < WALL_TOP; y++)
    for (let k = 0; k < 6; k++) flags[y * SIDE + WALL + k] = PathingFlag.Unwalkable;
  const world = new SimWorld(new PathingGrid({ width: SIDE, height: SIDE, flags }, [0, 0]), 1);
  for (let i = 0; i < N; i++) world.add({
    id: i + 1, owner: 0, team: 0, typeId: "hfoo", x: (WALL - 40) * 32 + i * 40, y: 20 * 32, facing: 0,
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
  let thisStep = 0, worstStep = 0, landed = 0, total = 0;
  setSimProfiler({ begin() {}, end() {}, gauge() {},
    tally(name, n = 1) {
      if (name === "pathExpansions") { thisStep += n; total += n; }
      if (name === "pathJobsLanded") landed += n;
    } });
  const goalX = (WALL + 40) * 32;
  for (let i = 0; i < N; i++) world.issueMove(i + 1, goalX, 20 * 32);
  const there = () => { let n = 0; for (let k = 1; k <= N; k++) if (world.units.get(k).x > goalX - 200) n++; return n; };
  let t = 0;
  for (let i = 0; i < Math.round(150 / SIM_DT) && there() < N; i++) {
    thisStep = 0; world.tick(SIM_DT); t += SIM_DT;
    if (thisStep > worstStep) worstStep = thisStep;
  }
  setSimProfiler(null);
  check(`all ${N} still get to the far side (${there()}/${N}, in ${t.toFixed(0)}s)`, there() === N);
  check(`the detours landed as jobs (${landed})`, landed >= 1);
  check(`and the dearest step spent ${worstStep} expansions of ${total} — never the whole detour`,
    worstStep <= 3 * PATH_FLOOR_EXPANSIONS);
}

// A WAVE gets past the treeline — re-issued every pass, as a computer's is.
//
// The treeline bug's real mechanism (SimWorld.routeStillServes): Computer+ re-states a wave's
// attack-move every pass in which its march waypoint has drifted, a re-plan from scratch past
// a big obstacle is a floor search best-effort INTO the trees, and the one detour a second the
// sliced search lands was thrown away within 1.5 s. Twelve units re-issued every 1.5 s past
// the group test's 300-cell treeline arrived 1 of 12 in 300 s, eleven standing at the trees,
// after 150 landed detours and 27,538 searches. A re-issue to the same place now keeps a route
// that reaches it or has its detour pending, and a landed detour is shared with the wave
// (SimWorld.sharedRoute), so the second unit does not wait a second for its own.
console.log("a wave re-issued every pass still gets past the treeline");
{
  const { setSimProfiler } = require(join(REPO, ".sim-build", "src", "sim", "profile.js"));
  const SIM_DT = 1 / 60;
  const SIDE = 768, WALL = SIDE >> 1, WALL_TOP = 300, N = 12;
  const flags = new Uint8Array(SIDE * SIDE);
  for (let y = 0; y < WALL_TOP; y++)
    for (let k = 0; k < 6; k++) flags[y * SIDE + WALL + k] = PathingFlag.Unwalkable;
  const world = new SimWorld(new PathingGrid({ width: SIDE, height: SIDE, flags }, [0, 0]), 1);
  for (let i = 0; i < N; i++) world.add({
    id: i + 1, owner: 0, team: 0, typeId: "hfoo", x: (WALL - 40) * 32 + (i % 4) * 40, y: 20 * 32 + Math.floor(i / 4) * 40, facing: 0,
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
  let landed = 0, shared = 0, searches = 0;
  setSimProfiler({ begin() {}, end() {}, gauge() {},
    tally(name, n = 1) { if (name === "pathJobsLanded") landed += n; if (name === "pathShared") shared += n; if (name === "pathSearches") searches += n; } });
  const goalX = (WALL + 40) * 32, goalY = 20 * 32;
  const order = () => { for (let i = 0; i < N; i++) world.issueAttackMove(i + 1, goalX, goalY); };
  order();
  const there = () => { let n = 0; for (let k = 1; k <= N; k++) if (world.units.get(k).x > goalX - 200) n++; return n; };
  let t = 0, since = 0;
  for (let i = 0; i < Math.round(150 / SIM_DT) && there() < N; i++) {
    world.tick(SIM_DT); t += SIM_DT; since += SIM_DT;
    if (since >= 1.5) { since = 0; order(); } // the pass, re-stating the wave's order
  }
  setSimProfiler(null);
  check(`all ${N} got past the trees (${there()}/${N}, in ${t.toFixed(0)}s)`, there() === N);
  check(`on ${landed} landed detour${landed === 1 ? "" : "s"}, shared ${shared} time${shared === 1 ? "" : "s"}`, landed >= 1 && shared >= 1);
  check(`and ${searches} searches in all, not tens of thousands`, searches < 1000);
}

console.log(failures ? `\ndetour: ${failures} check(s) FAILED` : "\ndetour: all checks passed");
process.exit(failures ? 1 : 0);
