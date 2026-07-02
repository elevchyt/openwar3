import type { PathingGrid } from "./pathing";
import { findPath } from "./pathfind";

// Headless simulation (plan §1.4, Phase 5/6). Owns unit game-state; the renderer
// only displays it. Fixed-timestep, no rendering or DOM deps — runnable in tests
// and (later) on the authoritative server.

export interface SimUnit {
  id: number;
  x: number;
  y: number;
  facing: number; // radians
  speed: number; // world units / second
  turnRate: number; // UnitData turnrate; scaled to rad/sec below
  radius: number; // collision radius (0 = no unit collision)
  flying: boolean; // air units ignore ground pathing & collision
  path: Array<[number, number]>; // world waypoints
  waypoint: number;
  moving: boolean;
}

const ARRIVE_EPS = 8; // world units — "close enough" to a waypoint
const TURN_RATE_SCALE = 8; // turnrate → rad/sec (tunable feel)

export class SimWorld {
  readonly units = new Map<number, SimUnit>();

  constructor(readonly grid: PathingGrid) {}

  add(unit: Omit<SimUnit, "path" | "waypoint" | "moving">): SimUnit {
    const u: SimUnit = { ...unit, path: [], waypoint: 0, moving: false };
    this.units.set(u.id, u);
    return u;
  }

  /** Order a unit to a world point via the pathing grid. False if no path. */
  issueMove(id: number, tx: number, ty: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    if (u.flying) {
      // Air units ignore the pathing grid (fly over trees/cliffs/buildings) —
      // straight line to the target. Height is applied by the renderer.
      u.path = [[tx, ty]];
      u.waypoint = 0;
      u.moving = true;
      return true;
    }
    const cells = findPath(this.grid, this.grid.worldToCell(u.x, u.y), this.grid.worldToCell(tx, ty));
    if (!cells || cells.length === 0) {
      this.stop(id);
      return false;
    }
    // Cell centres as waypoints; append the exact target for precision. Skip the
    // first cell (the unit's current cell) to avoid a backwards initial step.
    const pts = cells.slice(1).map(([cx, cy]) => this.grid.cellToWorld(cx, cy)) as Array<[number, number]>;
    pts.push([tx, ty]);
    u.path = pts;
    u.waypoint = 0;
    u.moving = true;
    return true;
  }

  stop(id: number): void {
    const u = this.units.get(id);
    if (u) {
      u.moving = false;
      u.path = [];
    }
  }

  tick(dt: number): void {
    for (const u of this.units.values()) {
      if (!u.moving) continue;
      let budget = u.speed * dt;
      let dirX = 0;
      let dirY = 0;
      while (budget > 0 && u.waypoint < u.path.length) {
        const [wx, wy] = u.path[u.waypoint];
        const dx = wx - u.x;
        const dy = wy - u.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= ARRIVE_EPS) {
          u.waypoint++;
          continue;
        }
        dirX = dx / dist;
        dirY = dy / dist;
        const step = Math.min(budget, dist);
        u.x += dirX * step;
        u.y += dirY * step;
        budget -= step;
        if (dist - step <= ARRIVE_EPS) u.waypoint++;
      }
      // Turn toward the movement direction at the unit's turn rate (WC3 units
      // don't snap instantly to face a new heading).
      if (dirX || dirY) {
        u.facing = turnToward(u.facing, Math.atan2(dirY, dirX), u.turnRate * TURN_RATE_SCALE * dt);
      }
      if (u.waypoint >= u.path.length) {
        u.moving = false;
        u.path = [];
      }
    }
    this.resolveCollisions();
  }

  // Push overlapping ground units apart so they don't stack (WC3 circle collision).
  // Air units and footprint-less units (radius 0) are excluded. O(n²) — fine for
  // melee-scale counts; a spatial grid is the scale-up path.
  private resolveCollisions(): void {
    const list: SimUnit[] = [];
    // Movable ground units only. Buildings (speed 0) block via their stamped grid
    // footprint, not separation; air units don't collide.
    for (const u of this.units.values()) if (!u.flying && u.radius > 0 && u.speed > 0) list.push(u);
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const min = a.radius + b.radius;
          let d = Math.hypot(dx, dy);
          if (d >= min) continue;
          if (d === 0) {
            dx = 1;
            dy = 0;
            d = 1;
          }
          const push = (min - d) / 2;
          this.nudge(a, (-dx / d) * push, (-dy / d) * push);
          this.nudge(b, (dx / d) * push, (dy / d) * push);
        }
      }
    }
  }

  // Move a unit, but never onto an unwalkable cell (don't push units into walls).
  private nudge(u: SimUnit, dx: number, dy: number): void {
    const nx = u.x + dx;
    const ny = u.y + dy;
    const [cx, cy] = this.grid.worldToCell(nx, ny);
    if (this.grid.walkable(cx, cy)) {
      u.x = nx;
      u.y = ny;
    }
  }
}

// Rotate `from` toward `to` by at most `maxDelta` radians, shortest direction.
function turnToward(from: number, to: number, maxDelta: number): number {
  let diff = to - from;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) <= maxDelta) return to;
  return from + Math.sign(diff) * maxDelta;
}
