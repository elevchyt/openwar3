import type { PathingGrid } from "./pathing";

// A* pathfinding on the walkability grid (plan Phase 5/6). 8-directional,
// octile heuristic, no cutting across blocked diagonal corners. Pure/headless.
//
// Supports dynamic obstacles via `blocked` (unit occupancy stamped by the sim)
// and is best-effort like WC3: when the goal is unreachable it returns a path
// to the explored cell closest to the goal — possibly just the start cell,
// which callers treat as "can't move at all".

type Cell = [number, number];


const NEIGHBORS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

// Search cap: keeps a fully-blocked goal from flooding the whole map. With
// best-effort return semantics a capped search still yields a useful partial
// path toward the goal.
const MAX_EXPANSIONS = 8192;

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * Find a walkable cell path from start toward goal (inclusive of both ends).
 * `blocked` marks extra dynamic obstacles (stationary units). Returns null
 * only when start/goal can't be snapped to the static grid; otherwise returns
 * the path to the goal or, if unreachable, to the closest explored cell.
 */
export function findPath(
  grid: PathingGrid,
  start: Cell,
  goal: Cell,
  blocked?: (cx: number, cy: number) => boolean,
  maxExpansions = MAX_EXPANSIONS,
): Cell[] | null {
  const from = grid.nearestWalkable(start[0], start[1]);
  const to = grid.nearestWalkable(goal[0], goal[1]);
  if (!from || !to) return null;

  const width = grid.width;
  const key = (x: number, y: number) => y * width + x;
  const goalKey = key(to[0], to[1]);
  const open = (x: number, y: number) => grid.walkable(x, y) && !(blocked && blocked(x, y));

  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  const closed = new Set<number>();

  // Binary min-heap of open nodes keyed on f (parallel arrays: f-value + cell key).
  // Popping the lowest f was an O(open) linear scan, making a whole search O(n²) — a
  // failing search floods MAX_EXPANSIONS cells, so with many units probing paths toward
  // (often unreachable) attack targets it tanked the frame rate. The heap makes each
  // pop/push O(log n). Decrease-key is handled lazily: a relaxed node is pushed again and
  // any now-stale duplicate is skipped on pop via the closed set.
  const heapF: number[] = [];
  const heapH: number[] = []; // tie-break key: prefer the node closest to the goal
  const heapK: number[] = [];
  // Ordered by f, then by h (lower h — nearer the goal — wins ties). The h tie-break is
  // the standard A* refinement: it drives the frontier straight at the goal, so a capped
  // or unreachable search's best-effort endpoint lands as close to the goal as possible
  // (and deterministically), rather than fanning out sideways.
  const before = (a: number, b: number): boolean => heapF[a] < heapF[b] || (heapF[a] === heapF[b] && heapH[a] < heapH[b]);
  const swap = (a: number, b: number): void => {
    const tf = heapF[a]; heapF[a] = heapF[b]; heapF[b] = tf;
    const th = heapH[a]; heapH[a] = heapH[b]; heapH[b] = th;
    const tk = heapK[a]; heapK[a] = heapK[b]; heapK[b] = tk;
  };
  const hpush = (k: number, g: number, h: number): void => {
    let i = heapF.length;
    heapF.push(g + h);
    heapH.push(h);
    heapK.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(i, p)) break;
      swap(i, p);
      i = p;
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
        if (l < size && before(l, m)) m = l;
        if (r < size && before(r, m)) m = r;
        if (m === i) break;
        swap(m, i);
        i = m;
      }
    }
    return topK;
  };

  const startKey = key(from[0], from[1]);
  gScore.set(startKey, 0);
  hpush(startKey, 0, octile(from[0], from[1], to[0], to[1]));

  let bestKey = startKey;
  let bestH = octile(from[0], from[1], to[0], to[1]);
  let bestG = 0;
  let expansions = 0;

  while (heapF.length) {
    const currentKey = hpop();
    if (closed.has(currentKey)) continue; // stale duplicate from a decrease-key
    if (currentKey === goalKey) return reconstruct(cameFrom, currentKey, width);
    closed.add(currentKey);
    const cx = currentKey % width;
    const cy = (currentKey / width) | 0;
    const cg = gScore.get(currentKey)!;

    const h = octile(cx, cy, to[0], to[1]);
    if (h < bestH || (h === bestH && cg < bestG)) {
      bestH = h;
      bestG = cg;
      bestKey = currentKey;
    }
    if (++expansions > maxExpansions) break;

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!open(nx, ny)) continue;
      // No corner-cutting through a blocked orthogonal neighbour.
      if (dx !== 0 && dy !== 0 && (!open(cx + dx, cy) || !open(cx, cy + dy))) {
        continue;
      }
      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;
      const tentative = cg + cost;
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentative);
        hpush(nKey, tentative, octile(nx, ny, to[0], to[1]));
      }
    }
  }
  // Goal unreachable (or search capped): walk as close as we got, WC3-style.
  return reconstruct(cameFrom, bestKey, width);
}

function reconstruct(cameFrom: Map<number, number>, endKey: number, width: number): Cell[] {
  const path: Cell[] = [];
  let k: number | undefined = endKey;
  while (k !== undefined) {
    path.push([k % width, Math.floor(k / width)]);
    k = cameFrom.get(k);
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
): boolean {
  const open = (x: number, y: number) => grid.walkable(x, y) && !(blocked && blocked(x, y));
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
): Cell[] {
  if (cells.length <= 2) return cells;
  const out: Cell[] = [cells[0]];
  let anchor = 0;
  for (let i = 1; i < cells.length - 1; i++) {
    // Keep cell i only when the anchor can no longer see the cell after it —
    // i.e. i is a real corner. Otherwise i is redundant and gets skipped.
    if (!lineClear(grid, cells[anchor], cells[i + 1], blocked)) {
      out.push(cells[i]);
      anchor = i;
    }
  }
  out.push(cells[cells.length - 1]);
  return out;
}
