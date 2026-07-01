import type { PathingGrid } from "./pathing";

// A* pathfinding on the walkability grid (plan Phase 5). 8-directional, octile
// heuristic, no cutting across blocked diagonal corners. Pure/headless.

type Cell = [number, number];

const NEIGHBORS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * Find a walkable cell path from start to goal (inclusive). Returns null if
 * unreachable. Snaps start/goal to the nearest walkable cell first.
 */
export function findPath(grid: PathingGrid, start: Cell, goal: Cell): Cell[] | null {
  const from = grid.nearestWalkable(start[0], start[1]);
  const to = grid.nearestWalkable(goal[0], goal[1]);
  if (!from || !to) return null;

  const key = (x: number, y: number) => y * grid.width + x;
  const goalKey = key(to[0], to[1]);

  const open = new Map<number, { x: number; y: number; g: number; f: number }>();
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>();
  const closed = new Set<number>();

  const startKey = key(from[0], from[1]);
  gScore.set(startKey, 0);
  open.set(startKey, { x: from[0], y: from[1], g: 0, f: octile(from[0], from[1], to[0], to[1]) });

  while (open.size) {
    // Pop lowest f. (Linear scan — fine for melee-map A* distances; swap for a
    // binary heap if profiling ever demands it.)
    let currentKey = -1;
    let best = Infinity;
    for (const [k, n] of open) {
      if (n.f < best) { best = n.f; currentKey = k; }
    }
    const current = open.get(currentKey)!;
    if (currentKey === goalKey) return reconstruct(cameFrom, currentKey, grid.width);
    open.delete(currentKey);
    closed.add(currentKey);

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!grid.walkable(nx, ny)) continue;
      // No corner-cutting through a blocked orthogonal neighbour.
      if (dx !== 0 && dy !== 0 && (!grid.walkable(current.x + dx, current.y) || !grid.walkable(current.x, current.y + dy))) {
        continue;
      }
      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;
      const tentative = current.g + cost;
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentative);
        open.set(nKey, { x: nx, y: ny, g: tentative, f: tentative + octile(nx, ny, to[0], to[1]) });
      }
    }
  }
  return null;
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
