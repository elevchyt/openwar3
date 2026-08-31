import type { PathDomain, PathingGrid } from "./pathing";

// A* pathfinding on the walkability grid (plan Phase 5/6). 8-directional,
// octile heuristic, no cutting across blocked diagonal corners. Pure/headless.
//
// Supports dynamic obstacles via `blocked` (unit occupancy stamped by the sim)
// and is best-effort like WC3: when the goal is unreachable it returns a path
// to the explored cell closest to the goal — possibly just the start cell,
// which callers treat as "can't move at all".

type Cell = [number, number];


// The eight steps, as three flat tables rather than an array of tuples — see the neighbour
// walk in findPath for why. ORTHOGONALS FIRST: the loop tests `ni >= 4` to know whether the
// step is diagonal and needs the corner-cutting check, so the order here is load-bearing.
const NEIGHBOR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOR_DY = [0, 0, 1, -1, 1, -1, 1, -1];
const NEIGHBOR_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

// Search cap: keeps a fully-blocked goal from flooding the whole map. With
// best-effort return semantics a capped search still yields a useful partial
// path toward the goal.
//
// It is a FLOOR rather than the cap, because a flat cap is a cap on how far a unit may be
// sent. On open ground A* with an octile heuristic and the h tie-break below walks almost
// straight at the goal, so a route costs about as many expansions as it has cells; it is
// only an obstacle that makes it flood, and the flood needed to get AROUND one grows with
// how big the thing in the way is. A melee map is 384 cells a side (96 tiles of 128 world
// units, four pathing cells to the tile), and 8192 expansions is a blob of roughly 50
// cells' radius — about 1600 world units. So an order given across a forest wider than
// that ran out of budget and came back best-effort, and best-effort means "the explored
// cell closest to the goal", which against a treeline is the treeline. That is the bug
// exactly as it was reported: an army sent at a creep camp it could plainly have walked to
// stood in a line facing a wall of trees.
//
// `EXPANSIONS_PER_CELL` buys the detour in proportion to the distance actually asked for —
// a search across the street is unchanged, one across the map gets what going round
// something map-sized costs — and `MAX_EXPANSIONS_FAR` is the flood ceiling that protects
// the frame from a goal on an island.
//
// That was not enough, because a detour's cost has nothing to do with how far away the goal
// is: the flood needed to round a forest is set by the SIZE OF THE FOREST, and a treeline
// wider than the budget is wider than the budget however near or far the thing behind it
// happens to be. Scaling with distance only moved the line at which a unit walks into the
// trees. Two goals that look identical to A* until it has already spent the budget —
// "unreachable" and "reachable the long way round" — need opposite answers, and asking the
// question the expensive way means the wrong one is only ever discovered by paying for it.
//
// So the budget is now chosen from the grid's STATIC CONNECTIVITY (PathingGrid.regionAt),
// which answers exactly that in O(1):
//
//   • Different regions — genuinely unreachable, and no amount of searching changes it. It
//     gets the FLOOR and nothing more: the result can only ever be best-effort, so all the
//     old distance-scaled budget bought was a longer wait for the same answer. This is where
//     the frame time saved below comes from.
//   • Same region — a way round EXISTS. Fund the search to find it: A* closes each cell at
//     most once, so the region's own cell count is the exact worst case and a budget that
//     size cannot fail on a route that is there.
//   • Unknown (an air search, or an approach whose target has no walkable ground near it) —
//     the old distance-scaled rule, unchanged.
//
// Measured on a 384×384 grid (a melee map's own size) against a solid wall with the only way
// round at the far end of it, one path at a time:
//
//     wall length      old            new
//        20 cells    1.7 ms  ok     1.5 ms  ok
//        60 cells    5.3 ms  ok     4.8 ms  ok
//       100 cells    6.9 ms  FAIL   7.3 ms  ok
//       300 cells    7.0 ms  FAIL  21.8 ms  ok
//
// — i.e. every search the old budget could finish is unchanged or cheaper (an open-ground
// walk right across the map is 0.16 ms either way, and an unreachable goal went from 7.3 ms
// to 3.1 ms), and the extra time is spent only where the answer used to be wrong. The
// The ceiling is what stops that trade running away, and it is set to bound the search by
// the REGION rather than to make it cheap: nothing short of that keeps the guarantee the fix
// exists for, which is that a route that exists is found rather than approximated. On a
// melee map a wide-open region is around 140k cells, so `MAX_EXPANSIONS_REACHABLE` is what
// actually binds, and the worst single search it permits is about 30 ms. That is a cost no
// real map pays — the 300-cell row above is a wall across three quarters of the map with one
// way round at the very end of it, and a real treeline is tens of cells with gaps in it.
//
// The labels are terrain-only, so "same region" is necessary rather than sufficient: a 4×4
// footprint may still not fit through a one-cell gap. That is the other thing the ceiling is
// for — it is the one case that can still spend the whole budget and come back best-effort.
const MAX_EXPANSIONS = 8192;
const EXPANSIONS_PER_CELL = 64;
const MAX_EXPANSIONS_FAR = 32768;
const MAX_EXPANSIONS_REACHABLE = 1 << 17;

// Expansions an APPROACH search (one carrying a `ring` measure) is allowed once it has
// first stood right against the target. A* pops in f order, so the first cell that reaches
// ring 0 is already found by about the cheapest route there is — but a cheaper or tidier
// one may be a few expansions behind it. This buys that little bit of extra looking, and
// nothing like the map flood a goal it can never occupy would otherwise provoke.
const ARRIVE_EXTRA = 192;

/**
 * The search's working set, allocated ONCE for the map and reused by every call.
 *
 * A* used a `Map`/`Map`/`Set` triple keyed on the cell index. Measured on a 256×256 grid
 * with a wave of 30 units pathing at once (the shape of Computer+'s `commit`, which is what
 * the session logs blamed for 100–420 ms `aiAttackPass` frames): the Map churn is most of
 * the cost, and all of the GARBAGE — the same logs show long tasks climbing from 32 ms/s to
 * 268 ms/s with a flat heap, which is a collector kept busy by allocation rate rather than a
 * leak. Parallel typed arrays hold the same three facts with no allocation at all.
 *
 * Nothing is cleared between searches. Each cell carries the `gen` of the search that last
 * wrote it, so a stale value from the previous search reads as absent — an O(1) reset in
 * place of an O(width×height) wipe, which on a 256×256 grid is 65k writes per path and
 * would cost more than the search for a short one.
 */
class PathScratch {
  size = 0;
  gen = 0;
  /** Generation that last wrote gScore/cameFrom for the cell. */
  seen = new Int32Array(0);
  gScore = new Float64Array(0);
  cameFrom = new Int32Array(0);
  /** Generation that CLOSED the cell (the old `closed` Set). */
  closed = new Int32Array(0);
  /** Memo for the clearance test — see `open` in findPath. */
  openGen = new Int32Array(0);
  openVal = new Uint8Array(0);
  // The heap's parallel arrays, kept across calls and merely truncated. `length = 0` on a
  // plain array keeps the backing store, so a steady stream of searches stops growing one.
  heapF: number[] = [];
  heapH: number[] = [];
  heapK: number[] = [];

  /** Ready the pool for one search over a grid of `size` cells, and return its generation. */
  begin(size: number): number {
    if (size > this.size) {
      this.size = size;
      this.seen = new Int32Array(size);
      this.gScore = new Float64Array(size);
      this.cameFrom = new Int32Array(size);
      this.closed = new Int32Array(size);
      this.openGen = new Int32Array(size);
      this.openVal = new Uint8Array(size);
      this.gen = 0; // fresh arrays are all-zero, so generations must restart above it
    }
    // Int32 wrap would make a stale stamp compare equal to the live one. Costs one wipe
    // every two billion searches, which is never, and makes the stamp trick airtight.
    if (++this.gen === 0x7fffffff) {
      this.seen.fill(0); this.closed.fill(0); this.openGen.fill(0);
      this.gen = 1;
    }
    this.heapF.length = 0;
    this.heapH.length = 0;
    this.heapK.length = 0;
    return this.gen;
  }
}

const scratch = new PathScratch();

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * Find a walkable cell path from start toward goal (inclusive of both ends).
 * `blocked` marks extra dynamic obstacles (stationary units). `domain` is the medium the
 * unit moves through — a transport ship searches the water the same way a Footman searches
 * the land, over the same grid read through its other flag (see PathingFlag.NoWater).
 * Returns null only when start/goal can't be snapped to the static grid; otherwise returns
 * the path to the goal or, if unreachable, to the closest explored cell.
 *
 * `ring` turns the search into an APPROACH: "walk up to that thing", where the goal is a
 * unit or a building whose own cells the mover can never stand on. It reports, for a unit
 * standing on a cell, how many whole CELLS clear of the target that leaves it — 0 meaning
 * "up against it". Three things change.
 *
 *   • The goal cell is NOT snapped to the nearest walkable one. Snapping a building's
 *     centre spirals out to whichever cell the ring scan happens to reach first — always
 *     the same corner — and the heuristic would then steer at THAT corner.
 *   • Closeness for the best-effort endpoint is `ring`, not the distance to the goal cell.
 *     That matters because a building is a BOX: measured from its centre cell, the spots
 *     off its short ends are nearer than the whole length of its long face, so a unit
 *     walking at the long face would always find something "closer" round the corner and
 *     hike there. Measured as clearance from the box, every face is ring 0 and the tie
 *     goes to the cheapest one to WALK to — which is the side the unit came from. That is
 *     what "as close as possible, by the fastest path" means.
 *   • It stops early (ARRIVE_EXTRA) once ring 0 is touched, instead of flooding the
 *     reachable map looking for a goal cell it can never occupy.
 */
export function findPath(
  grid: PathingGrid,
  start: Cell,
  goal: Cell,
  blocked?: (cx: number, cy: number) => boolean,
  maxExpansions?: number,
  domain: PathDomain = "ground",
  ring?: (cx: number, cy: number) => number,
): Cell[] | null {
  const from = grid.nearestWalkable(start[0], start[1], undefined, domain);
  if (!from) return null;
  const startRegion = grid.regionAt(from[0], from[1], domain);
  // Snap the goal to walkable ground WE CAN ACTUALLY GET TO, when there is any nearby. A
  // point dropped on something unwalkable snaps to whichever cell the ring scan finds
  // closest, and "closest" pays no attention to which side of the obstacle it is on: an
  // order given at an island snapped onto the island, and the whole walk to the shore was
  // then a capped best-effort search for a goal on the far side of the water. Asking for a
  // cell in the mover's own region instead makes it an ordinary walk to an ordinary place.
  // Note this only ever moves the snap where the two sides are genuinely separate ground —
  // clicking into a treeline you can walk round still snaps to the nearest trunk-free cell,
  // near side or far, exactly as WC3 does. Falls back to the plain snap so a goal with
  // nothing reachable near it keeps the best-effort walk toward it that it always had.
  const to = ring
    ? goal
    : (startRegion >= 0
        ? grid.nearestWalkable(goal[0], goal[1], undefined, domain, (x, y) => grid.regionAt(x, y, domain) === startRegion)
        : null) ?? grid.nearestWalkable(goal[0], goal[1], undefined, domain);
  if (!to) return null;

  // The budget the caller did not name is chosen from static connectivity — see the note on
  // `MAX_EXPANSIONS`. An approach's goal cell is the target itself (never walkable), so it
  // is asked about the ground AROUND it, which is where the walk actually ends.
  const goalRegion = ring
    ? grid.regionNear(to[0], to[1], domain)
    : grid.regionAt(to[0], to[1], domain);
  let budget: number;
  if (maxExpansions !== undefined) {
    budget = maxExpansions;
  } else if (startRegion >= 0 && goalRegion >= 0 && startRegion !== goalRegion) {
    // Proven unreachable: the search can only ever come back best-effort, so buy the
    // best-effort probe and not a flood that ends the same way.
    budget = MAX_EXPANSIONS;
  } else if (startRegion >= 0 && startRegion === goalRegion) {
    // Proven reachable: pay for the detour. Bounded by the region, which is the most the
    // search could possibly close, so this is "search until you find it" with a ceiling
    // rather than an open-ended flood.
    budget = Math.min(MAX_EXPANSIONS_REACHABLE, Math.max(MAX_EXPANSIONS, grid.regionSize(from[0], from[1], domain)));
  } else {
    // Nothing to go on (air, or a target with no ground near it): the distance-scaled rule.
    budget = Math.min(
      MAX_EXPANSIONS_FAR,
      Math.max(MAX_EXPANSIONS, Math.round(octile(from[0], from[1], to[0], to[1]) * EXPANSIONS_PER_CELL)),
    );
  }

  const width = grid.width;
  const height = grid.height;
  const gen = scratch.begin(width * height);
  const { seen, gScore, cameFrom, closed, openGen, openVal, heapF, heapH, heapK } = scratch;
  const goalKey = to[1] * width + to[0];

  /**
   * May the mover stand here — asked at most ONCE per cell per search.
   *
   * `blocked` is the clearance predicate (SimWorld.clearanceBlocker): for an n×n footprint
   * it walks the whole block, so one call is up to 2n² grid reads. A* asks about the same
   * cell over and over — every cell is a neighbour of up to eight expanded nodes, and the
   * no-corner-cutting test asks about two more each time — so an unmemoized search paid that
   * price ten to twenty-five times over for every cell it touched. This is the single
   * biggest cost in the pass, and it is pure for the duration of a search: nothing reserves
   * a cell or fells a tree while A* is running.
   */
  const open = (x: number, y: number): boolean => {
    // Bounds first: the memo is indexed by y*width+x, which for a cell off the left edge
    // would alias onto the row above. `grid.walkable` answers false out of bounds, and
    // `blocked` is never consulted for one, so returning here is the same answer.
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = y * width + x;
    if (openGen[i] === gen) return openVal[i] === 1;
    const ok = grid.walkable(x, y, domain) && !(blocked && blocked(x, y));
    openGen[i] = gen;
    openVal[i] = ok ? 1 : 0;
    return ok;
  };

  // Binary min-heap of open nodes keyed on f (parallel arrays: f-value + cell key).
  // Popping the lowest f was an O(open) linear scan, making a whole search O(n²) — a
  // failing search floods MAX_EXPANSIONS cells, so with many units probing paths toward
  // (often unreachable) attack targets it tanked the frame rate. The heap makes each
  // pop/push O(log n). Decrease-key is handled lazily: a relaxed node is pushed again and
  // any now-stale duplicate is skipped on pop via the closed set.
  //
  // Ordered by f, then by h (lower h — nearer the goal — wins ties). The h tie-break is
  // the standard A* refinement: it drives the frontier straight at the goal, so a capped
  // or unreachable search's best-effort endpoint lands as close to the goal as possible
  // (and deterministically), rather than fanning out sideways.
  const hpush = (k: number, g: number, h: number): void => {
    let i = heapF.length;
    heapF.push(g + h);
    heapH.push(h);
    heapK.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[i] < heapF[p] || (heapF[i] === heapF[p] && heapH[i] < heapH[p])) {
        const tf = heapF[i]; heapF[i] = heapF[p]; heapF[p] = tf;
        const th = heapH[i]; heapH[i] = heapH[p]; heapH[p] = th;
        const tk = heapK[i]; heapK[i] = heapK[p]; heapK[p] = tk;
        i = p;
      } else break;
    }
  };
  const hpop = (): number => {
    const topK = heapK[0];
    const lastF = heapF.pop()!;
    const lastH = heapH.pop()!;
    const lastK = heapK.pop()!;
    const size = heapF.length;
    if (size > 0) {
      heapF[0] = lastF;
      heapH[0] = lastH;
      heapK[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < size && (heapF[l] < heapF[m] || (heapF[l] === heapF[m] && heapH[l] < heapH[m]))) m = l;
        if (r < size && (heapF[r] < heapF[m] || (heapF[r] === heapF[m] && heapH[r] < heapH[m]))) m = r;
        if (m === i) break;
        const tf = heapF[m]; heapF[m] = heapF[i]; heapF[i] = tf;
        const th = heapH[m]; heapH[m] = heapH[i]; heapH[i] = th;
        const tk = heapK[m]; heapK[m] = heapK[i]; heapK[i] = tk;
        i = m;
      }
    }
    return topK;
  };

  const startKey = from[1] * width + from[0];
  seen[startKey] = gen;
  gScore[startKey] = 0;
  cameFrom[startKey] = -1;
  hpush(startKey, 0, octile(from[0], from[1], to[0], to[1]));

  // Closeness measure for the best-effort endpoint: distance to the goal CELL normally,
  // clearance from the target's own box in approach mode (see the `ring` note above).
  const closeness = ring ?? ((cx: number, cy: number) => octile(cx, cy, to[0], to[1]));

  let bestKey = startKey;
  let bestH = closeness(from[0], from[1]);
  let bestG = 0;
  let expansions = 0;
  let limit = budget;

  while (heapF.length) {
    const currentKey = hpop();
    if (closed[currentKey] === gen) continue; // stale duplicate from a decrease-key
    // An approach never "reaches" its goal — the goal is the thing itself, standing on
    // cells nobody may occupy — so it is `ring` + the closeness rule that end it.
    if (!ring && currentKey === goalKey) return reconstruct(cameFrom, seen, gen, currentKey, width);
    closed[currentKey] = gen;
    const cx = currentKey % width;
    const cy = (currentKey / width) | 0;
    const cg = gScore[currentKey];

    const h = closeness(cx, cy);
    if (h < bestH || (h === bestH && cg < bestG)) {
      bestH = h;
      bestG = cg;
      bestKey = currentKey;
    }
    // First time we stand right against the target: give the search a short tail to settle
    // on the cheapest such spot, then stop. Set once — `limit` only ever shrinks.
    if (ring && limit === budget && h <= 0) {
      limit = Math.min(budget, expansions + ARRIVE_EXTRA);
    }
    if (++expansions > limit) break;

    // Flat, indexed neighbour walk. `for (const [dx, dy, cost] of NEIGHBORS)` allocated an
    // iterator result and destructured a tuple on EVERY expansion — thousands per search,
    // hundreds of thousands per wave, and all of it garbage.
    for (let ni = 0; ni < 8; ni++) {
      const nx = cx + NEIGHBOR_DX[ni];
      const ny = cy + NEIGHBOR_DY[ni];
      if (!open(nx, ny)) continue;
      // No corner-cutting through a blocked orthogonal neighbour.
      if (ni >= 4 && (!open(nx, cy) || !open(cx, ny))) continue;
      const nKey = ny * width + nx;
      if (closed[nKey] === gen) continue;
      const tentative = cg + NEIGHBOR_COST[ni];
      if (seen[nKey] !== gen || tentative < gScore[nKey]) {
        seen[nKey] = gen;
        cameFrom[nKey] = currentKey;
        gScore[nKey] = tentative;
        hpush(nKey, tentative, octile(nx, ny, to[0], to[1]));
      }
    }
  }
  // Goal unreachable (or search capped): walk as close as we got, WC3-style.
  return reconstruct(cameFrom, seen, gen, bestKey, width);
}

/** Walk the parent chain back to the start. `seen`/`gen` stand in for the old Map's "has":
 *  a cell this search never wrote carries a stale generation, and the start cell — the one
 *  cell it writes with no parent — carries -1. */
function reconstruct(
  cameFrom: Int32Array,
  seen: Int32Array,
  gen: number,
  endKey: number,
  width: number,
): Cell[] {
  const path: Cell[] = [];
  let k = endKey;
  while (k >= 0 && seen[k] === gen) {
    path.push([k % width, (k / width) | 0]);
    k = cameFrom[k];
  }
  return path.reverse();
}

/**
 * Line-of-sight on the grid: true when the mover's footprint clears every cell
 * the straight segment a→b passes through. `blocked` is the SAME clearance
 * predicate A* used (footprint fit + reservations), so a smoothed segment is
 * never routed anywhere A* wouldn't step. Supercover walk (Amanatides–Woo): it
 * visits every cell the line crosses, and an exact corner crossing requires both
 * orthogonal neighbours open — mirroring A*'s no-diagonal-corner-cutting rule.
 */
function lineClear(
  grid: PathingGrid,
  a: Cell,
  b: Cell,
  blocked?: (cx: number, cy: number) => boolean,
  domain: PathDomain = "ground",
): boolean {
  const open = (x: number, y: number) => grid.walkable(x, y, domain) && !(blocked && blocked(x, y));
  let x = a[0];
  let y = a[1];
  if (!open(x, y)) return false;
  const nx = Math.abs(b[0] - x);
  const ny = Math.abs(b[1] - y);
  const stepX = Math.sign(b[0] - x);
  const stepY = Math.sign(b[1] - y);
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    if (iy >= ny) { x += stepX; ix++; } // ran out of vertical moves — go horizontal
    else if (ix >= nx) { y += stepY; iy++; }
    else {
      // Compare the segment param at the next x-boundary vs the next y-boundary.
      const tx = (0.5 + ix) / nx;
      const ty = (0.5 + iy) / ny;
      if (Math.abs(tx - ty) < 1e-9) {
        // Exact corner: don't cut it if either flanking cell is blocked.
        if (!open(x + stepX, y) || !open(x, y + stepY)) return false;
        x += stepX; y += stepY; ix++; iy++;
      } else if (tx < ty) { x += stepX; ix++; }
      else { y += stepY; iy++; }
    }
    if (!open(x, y)) return false;
  }
  return true;
}

/**
 * String-pull a raw cell path into straight runs: drop any waypoint the mover
 * can see past (footprint-clear LOS), keeping only genuine turn-points. WC3 units
 * glide in straight lines toward their goal, not down the A* grid's 8-direction
 * staircase; without this the per-cell heading zig-zags, so a unit's facing never
 * settles on the true travel direction and visibly rotates as it arrives. Endpoints
 * are always preserved. `blocked` must be the predicate passed to findPath().
 */
export function smoothPath(
  grid: PathingGrid,
  cells: Cell[],
  blocked?: (cx: number, cy: number) => boolean,
  domain: PathDomain = "ground",
): Cell[] {
  if (cells.length <= 2) return cells;
  const out: Cell[] = [cells[0]];
  let anchor = 0;
  for (let i = 1; i < cells.length - 1; i++) {
    // Keep cell i only when the anchor can no longer see the cell after it —
    // i.e. i is a real corner. Otherwise i is redundant and gets skipped.
    if (!lineClear(grid, cells[anchor], cells[i + 1], blocked, domain)) {
      out.push(cells[i]);
      anchor = i;
    }
  }
  out.push(cells[cells.length - 1]);
  return out;
}
