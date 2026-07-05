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
): Cell[] | null {
  const from = grid.nearestWalkable(start[0], start[1]);
  const to = grid.nearestWalkable(goal[0], goal[1]);
  if (!from || !to) return null;

  const key = (x: number, y: number) => y * grid.width + x;
  const goalKey = key(to[0], to[1]);
  const open = (x: number, y: number) => grid.walkable(x, y) && !(blocked && blocked(x, y));

  const openSet = new Map<number, { x: number; y: number; g: number; f: number }>();
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  const closed = new Set<number>();

  const startKey = key(from[0], from[1]);
  gScore.set(startKey, 0);
  openSet.set(startKey, { x: from[0], y: from[1], g: 0, f: octile(from[0], from[1], to[0], to[1]) });

  let bestKey = startKey;
  let bestH = octile(from[0], from[1], to[0], to[1]);
  let bestG = 0;
  let expansions = 0;

  while (openSet.size) {
    // Pop lowest f. (Linear scan — fine for melee-map A* distances; swap for a
    // binary heap if profiling ever demands it.)
    let currentKey = -1;
    let best = Infinity;
    for (const [k, n] of openSet) {
      if (n.f < best) { best = n.f; currentKey = k; }
    }
    const current = openSet.get(currentKey)!;
    if (currentKey === goalKey) return reconstruct(cameFrom, currentKey, grid.width);
    openSet.delete(currentKey);
    closed.add(currentKey);

    const h = octile(current.x, current.y, to[0], to[1]);
    if (h < bestH || (h === bestH && current.g < bestG)) {
      bestH = h;
      bestG = current.g;
      bestKey = currentKey;
    }
    if (++expansions > MAX_EXPANSIONS) break;

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!open(nx, ny)) continue;
      // No corner-cutting through a blocked orthogonal neighbour.
      if (dx !== 0 && dy !== 0 && (!open(current.x + dx, current.y) || !open(current.x, current.y + dy))) {
        continue;
      }
      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;
      const tentative = current.g + cost;
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentative);
        openSet.set(nKey, { x: nx, y: ny, g: tentative, f: tentative + octile(nx, ny, to[0], to[1]) });
      }
    }
  }
  // Goal unreachable (or search capped): walk as close as we got, WC3-style.
  return reconstruct(cameFrom, bestKey, grid.width);
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
