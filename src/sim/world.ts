import { PATHING_CELL, footprintCells, type PathingGrid } from "./pathing";
import { findPath } from "./pathfind";

// Headless simulation (plan §1.4, Phase 5/6). Owns unit game-state; the renderer
// only displays it. Fixed-timestep, no rendering or DOM deps — runnable in tests
// and (later) on the authoritative server.

/** Weapon stats (from UnitWeapons.slk). Damage per swing = damage + dice d sides,
 *  reduced by the target's armor (WC3 formula). */
export interface SimWeapon {
  damage: number;
  dice: number;
  sides: number;
  cooldown: number; // seconds between swings
  range: number; // measured between collision hulls, WC3-style
  acquire: number; // auto-acquisition range (0 = never auto-attacks)
}

export type SimOrder = "idle" | "move" | "attack";

export interface SimUnit {
  id: number;
  owner: number; // player slot; -1 = map-neutral
  team: number; // units on the same team are allied; -1 = hostile to everyone
  x: number;
  y: number;
  facing: number; // radians
  desiredFacing: number; // turning continues toward this even when standing
  speed: number; // world units / second
  turnRate: number; // UnitData turnrate; scaled to rad/sec below
  radius: number; // collision radius (0 = no unit collision)
  flying: boolean; // air units ignore ground pathing & collision
  hp: number;
  maxHp: number;
  armor: number;
  weapon: SimWeapon | null;
  order: SimOrder;
  targetId: number | null;
  cooldownLeft: number;
  inCombat: boolean; // engaging in range this tick (drives the attack animation)
  path: Array<[number, number]>; // world waypoints
  waypoint: number;
  moving: boolean;
  chaseX: number; // where the current chase path was aimed (repath when stale)
  chaseY: number;
  acquireT: number; // seconds until the next auto-acquire scan
  stuckT: number; // seconds spent blocked while trying to move
  stuckRetries: number; // consecutive stuck-repath attempts without progress
  repathT: number; // chase-repath cooldown after getting blocked
  prevX: number; // position before this tick's movement (stuck detection)
  prevY: number;
  footprint: number; // reserved cells per side when stationary (0 = never)
  resX: number; // origin cell of the current reservation
  resY: number;
  hasReservation: boolean;
}

const ARRIVE_EPS = 8; // world units — "close enough" to a waypoint
// WC3 turn rate (hiveworkshop thread 129619): the object-editor value is
// radians per internal 0.03s frame, capped at ~0.2 rad/frame (≈381.95°/s).
const TURN_FRAME = 0.03;
const TURN_RATE_CAP = 0.2;
const FACING_EPS = 0.35; // radians — must roughly face the target to swing
const CHASE_REPATH = 128; // repath when the target strays this far from the path goal
const ACQUIRE_PERIOD = 0.5; // seconds between idle auto-acquire scans
const STUCK_TIME = 0.5; // seconds of blocked movement before a unit gives up
const STUCK_RATIO = 0.3; // "blocked" = actual displacement below this share of expected
const REPATH_COOLDOWN = 0.5; // seconds a blocked chaser waits before repathing

export class SimWorld {
  readonly units = new Map<number, SimUnit>();
  private deaths: number[] = [];
  private rng: () => number;

  constructor(readonly grid: PathingGrid, seed = 1) {
    this.rng = lcg(seed);
  }

  add(
    unit: Omit<
      SimUnit,
      | "desiredFacing"
      | "path"
      | "waypoint"
      | "moving"
      | "order"
      | "targetId"
      | "cooldownLeft"
      | "inCombat"
      | "chaseX"
      | "chaseY"
      | "acquireT"
      | "stuckT"
      | "stuckRetries"
      | "repathT"
      | "prevX"
      | "prevY"
      | "footprint"
      | "resX"
      | "resY"
      | "hasReservation"
    >,
  ): SimUnit {
    const u: SimUnit = {
      ...unit,
      desiredFacing: unit.facing,
      order: "idle",
      targetId: null,
      cooldownLeft: 0,
      inCombat: false,
      path: [],
      waypoint: 0,
      moving: false,
      chaseX: 0,
      chaseY: 0,
      acquireT: 0,
      stuckT: 0,
      stuckRetries: 0,
      repathT: 0,
      prevX: unit.x,
      prevY: unit.y,
      // Buildings (speed 0) block via their stamped static footprint instead.
      footprint: unit.flying || unit.speed <= 0 ? 0 : footprintCells(unit.radius),
      resX: 0,
      resY: 0,
      hasReservation: false,
    };
    this.units.set(u.id, u);
    this.settle(u);
    return u;
  }

  // --- cell reservation (WC3 pathing grid) ---------------------------------

  /** A unit came to rest: align it to its cell footprint and reserve the cells
   *  so other units path around it (this is what makes surrounds possible). */
  private settle(u: SimUnit): void {
    u.moving = false;
    u.path = [];
    if (u.footprint <= 0 || u.hasReservation) return;
    const [sx, sy] = this.grid.snapForFootprint(u.x, u.y, u.footprint);
    u.x = sx;
    u.y = sy;
    const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, u.footprint);
    this.grid.reserve(cx0, cy0, u.footprint);
    u.resX = cx0;
    u.resY = cy0;
    u.hasReservation = true;
  }

  /** A unit is about to move: give its reserved cells back. */
  private unsettle(u: SimUnit): void {
    if (u.hasReservation) {
      this.grid.release(u.resX, u.resY, u.footprint);
      u.hasReservation = false;
    }
  }

  /** Sim ids of units that died since the last drain (renderer plays deaths). */
  drainDeaths(): number[] {
    if (!this.deaths.length) return this.deaths;
    const out = this.deaths;
    this.deaths = [];
    return out;
  }

  /** Order a unit to a world point via the pathing grid. When no movement is
   *  possible at all (blocked in by units/terrain), the unit stays put and
   *  only turns to face the point — WC3 does exactly this. */
  issueMove(id: number, tx: number, ty: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    u.order = "move";
    u.targetId = null;
    u.inCombat = false;
    u.stuckT = 0;
    u.stuckRetries = 0;
    if (!this.pathTo(u, tx, ty)) {
      this.stop(id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return false;
    }
    return true;
  }

  /** Order a unit to attack another. False if either is missing or they're allied. */
  issueAttack(id: number, targetId: number): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || !u.weapon || !this.hostile(u, t)) return false;
    u.order = "attack";
    u.targetId = targetId;
    return true;
  }

  stop(id: number): void {
    const u = this.units.get(id);
    if (u) {
      u.order = "idle";
      u.targetId = null;
      u.inCombat = false;
      this.settle(u);
    }
  }

  // Different teams are enemies; creeps all share team -1 (hostile to every
  // player team but not to each other, like WC3's Neutral Hostile).
  hostile(a: SimUnit, b: SimUnit): boolean {
    return a.team !== b.team;
  }

  tick(dt: number): void {
    for (const u of this.units.values()) {
      if (u.cooldownLeft > 0) u.cooldownLeft -= dt;
      if (u.repathT > 0) u.repathT -= dt;
      u.prevX = u.x;
      u.prevY = u.y;
      switch (u.order) {
        case "attack":
          this.tickAttack(u);
          break;
        case "idle":
          this.tickAcquire(u, dt);
          break;
      }
    }
    this.tickMovement(dt);
    this.resolveCollisions();
    for (const u of this.units.values()) {
      // Turning runs every tick, independent of movement: a unit that arrived
      // (or stands attacking) still finishes rotating to its desired heading.
      if (u.facing !== u.desiredFacing) {
        u.facing = turnToward(u.facing, u.desiredFacing, turnSpeed(u.turnRate) * dt);
      }
      this.checkStuck(u, dt);
    }
  }

  // A moving unit that barely progresses (blocked by units it may not push) gives
  // up after a moment: move orders stop (WC3 units halt when the way is blocked);
  // chasers pause before repathing so they don't grind against the blocker.
  private checkStuck(u: SimUnit, dt: number): void {
    if (!u.moving || u.speed <= 0) {
      u.stuckT = 0;
      return;
    }
    const actual = Math.hypot(u.x - u.prevX, u.y - u.prevY);
    if (actual < u.speed * dt * STUCK_RATIO) {
      u.stuckT += dt;
      if (u.stuckT >= STUCK_TIME) {
        u.stuckT = 0;
        if (u.order === "attack") {
          this.settle(u);
          u.repathT = REPATH_COOLDOWN;
        } else {
          // Blocked mid-move: the blockers may have stopped since the original
          // path was computed — repath around them. A unit that stays stuck
          // (boxed in) stands down after a couple of attempts and just faces
          // where it was ordered — WC3 units never squeeze through crowds.
          const [tx, ty] = [u.chaseX, u.chaseY];
          if (++u.stuckRetries > 1 || !this.pathTo(u, tx, ty)) {
            this.stop(u.id);
            u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
          }
        }
      }
    } else {
      u.stuckT = 0;
      u.stuckRetries = 0;
    }
  }

  // --- combat -------------------------------------------------------------

  private tickAttack(u: SimUnit): void {
    const t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    if (!t || !u.weapon) {
      // Target died or vanished — go idle where we stand (auto-acquire resumes).
      this.stop(u.id);
      return;
    }
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    if (gap > u.weapon.range) {
      u.inCombat = false;
      this.chase(u, t);
      return;
    }
    // In range: halt, face the target, swing when ready (rotation itself is
    // applied by the shared per-tick turning pass).
    this.settle(u);
    u.inCombat = true;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    if (Math.abs(angleDiff(u.facing, u.desiredFacing)) > FACING_EPS || u.cooldownLeft > 0) return;
    u.cooldownLeft = u.weapon.cooldown;
    this.dealDamage(u, t);
  }

  // Path toward the target; repath only when the target strays from the path
  // goal (A* every tick would be wasteful and jittery), and not while cooling
  // down after being blocked by units we may not push.
  private chase(u: SimUnit, t: SimUnit): void {
    if (u.repathT > 0) return;
    if (u.moving && Math.hypot(t.x - u.chaseX, t.y - u.chaseY) < CHASE_REPATH) return;
    this.pathTo(u, t.x, t.y);
  }

  private dealDamage(attacker: SimUnit, target: SimUnit): void {
    const w = attacker.weapon!;
    let dmg = w.damage;
    for (let i = 0; i < w.dice; i++) dmg += 1 + Math.floor(this.rng() * w.sides);
    // WC3 armor reduction: each armor point is worth 6% of pre-armor damage.
    const reduction = (target.armor * 0.06) / (1 + 0.06 * Math.max(0, target.armor));
    target.hp -= dmg * (1 - reduction);
    if (target.hp <= 0) {
      this.kill(target);
      return;
    }
    // Retaliate: an idle armed victim turns on its attacker (WC3 return fire).
    if (target.order === "idle" && target.weapon) this.issueAttack(target.id, attacker.id);
  }

  private kill(u: SimUnit): void {
    this.unsettle(u); // corpses don't block cells
    this.units.delete(u.id); // Map delete during values() iteration is safe
    this.deaths.push(u.id);
  }

  // Idle armed units scan for the nearest enemy in acquisition range.
  private tickAcquire(u: SimUnit, dt: number): void {
    if (!u.weapon || u.weapon.acquire <= 0) return;
    u.acquireT -= dt;
    if (u.acquireT > 0) return;
    u.acquireT = ACQUIRE_PERIOD;
    let best: SimUnit | null = null;
    let bestGap = u.weapon.acquire;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap < bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    if (best) this.issueAttack(u.id, best.id);
  }

  // --- movement -----------------------------------------------------------

  /** Set a path toward a world point (straight line for air units). False when
   *  no movement toward the point is possible at all. */
  private pathTo(u: SimUnit, tx: number, ty: number): boolean {
    u.chaseX = tx;
    u.chaseY = ty;
    if (u.flying) {
      // Air units ignore the pathing grid (fly over trees/cliffs/buildings) —
      // straight line to the target. Height is applied by the renderer.
      u.path = [[tx, ty]];
      u.waypoint = 0;
      u.moving = true;
      return true;
    }
    // Release our own cells while pathing so they don't block us, but re-settle
    // if no path exists (position/reservation must stay consistent).
    const wasReserved = u.hasReservation;
    this.unsettle(u);
    const start = this.grid.worldToCell(u.x, u.y);
    const cells = findPath(this.grid, start, this.grid.worldToCell(tx, ty), this.clearanceBlocker(u, start));
    // A single-cell (or empty) result means the unit can't get any closer.
    if (!cells || cells.length <= 1) {
      if (wasReserved) this.settle(u);
      return false;
    }
    // Cell centres as waypoints. When the path actually reaches the target cell
    // (best-effort paths stop short), finish on the footprint-aligned point so
    // the unit settles exactly onto the cells it will reserve.
    const pts = cells.slice(1).map(([cx, cy]) => this.grid.cellToWorld(cx, cy)) as Array<[number, number]>;
    const [lastX, lastY] = pts[pts.length - 1];
    if (Math.hypot(tx - lastX, ty - lastY) <= PATHING_CELL) {
      pts.push(this.grid.snapForFootprint(tx, ty, u.footprint));
    }
    u.path = pts;
    u.waypoint = 0;
    u.moving = true;
    return true;
  }

  /** After finishing a path that stopped short of the ordered point, try again
   *  when the goal's cells have been vacated in the meantime. */
  private retryFreedGoal(u: SimUnit): boolean {
    if (u.stuckRetries >= 2) return false;
    if (Math.hypot(u.chaseX - u.x, u.chaseY - u.y) <= PATHING_CELL * 1.5) return false;
    const n = u.footprint;
    if (n > 0) {
      const [sx, sy] = this.grid.snapForFootprint(u.chaseX, u.chaseY, n);
      const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
      for (let y = cy0; y < cy0 + n; y++) {
        for (let x = cx0; x < cx0 + n; x++) {
          if (!this.grid.walkable(x, y) || this.grid.isReserved(x, y)) return false;
        }
      }
    }
    u.stuckRetries++;
    return this.pathTo(u, u.chaseX, u.chaseY);
  }

  /** WC3-style clearance test for pathfinding: the mover's own n×n cell
   *  footprint must fit on statically-walkable, unreserved cells at every path
   *  node. Cells adjacent to the start stay exempt from reservations so a unit
   *  overlapping others (spawn overflow) can still leave. */
  private clearanceBlocker(
    self: SimUnit,
    start: [number, number],
  ): ((cx: number, cy: number) => boolean) | undefined {
    const n = self.footprint;
    if (n <= 0) return undefined;
    const [sx, sy] = start;
    const half = n >> 1;
    return (cx, cy) => {
      const nearStart = Math.abs(cx - sx) <= 1 && Math.abs(cy - sy) <= 1;
      const cx0 = cx - half;
      const cy0 = cy - half;
      for (let y = cy0; y < cy0 + n; y++) {
        for (let x = cx0; x < cx0 + n; x++) {
          if (!this.grid.walkable(x, y)) return true;
          if (!nearStart && this.grid.isReserved(x, y)) return true;
        }
      }
      return false;
    };
  }

  private tickMovement(dt: number): void {
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
      // Face the movement direction; the shared turning pass rotates at the
      // unit's turn rate (and keeps rotating after arrival if needed).
      if (dirX || dirY) {
        u.desiredFacing = Math.atan2(dirY, dirX);
      }
      if (u.waypoint >= u.path.length) {
        // A best-effort path may have stopped short because the goal cells
        // were reserved when it was computed; if the blocker has since left,
        // continue to the real goal (bounded retries).
        if (u.order === "move" && this.retryFreedGoal(u)) continue;
        this.settle(u); // arrival: snap to the cell grid and reserve
        if (u.order === "move") u.order = "idle"; // auto-acquire resumes
      }
    }
  }

  // Keep overlapping ground units apart (WC3 circle collision) WITHOUT pushing:
  // WC3 units never displace others. A moving unit that runs into a stationary
  // one is shoved back out itself (net effect: blocked; checkStuck() then makes
  // it give up). Two moving units split the correction, letting them slide past
  // each other. Stationary pairs are left alone. Air units and footprint-less
  // units (radius 0) are excluded. O(n²) — fine for melee-scale counts; a
  // spatial grid is the scale-up path.
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
          if (!a.moving && !b.moving) continue; // nobody to blame — leave them
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
          const overlap = min - d;
          if (a.moving && b.moving) {
            // Split the correction and add a tangential component so head-on
            // movers spiral around each other instead of deadlocking.
            const tx = (-dy / d) * (overlap / 2);
            const ty = (dx / d) * (overlap / 2);
            this.nudge(a, (-dx / d) * (overlap / 2) + tx, (-dy / d) * (overlap / 2) + ty);
            this.nudge(b, (dx / d) * (overlap / 2) - tx, (dy / d) * (overlap / 2) - ty);
          } else if (a.moving) {
            this.nudge(a, (-dx / d) * overlap, (-dy / d) * overlap);
          } else {
            this.nudge(b, (dx / d) * overlap, (dy / d) * overlap);
          }
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

// Angular speed in rad/sec from a unit's UnitData turnrate (WC3 semantics).
function turnSpeed(turnRate: number): number {
  return Math.min(turnRate, TURN_RATE_CAP) / TURN_FRAME;
}

// Rotate `from` toward `to` by at most `maxDelta` radians, shortest direction.
function turnToward(from: number, to: number, maxDelta: number): number {
  const diff = angleDiff(from, to);
  if (Math.abs(diff) <= maxDelta) return to;
  return from + Math.sign(diff) * maxDelta;
}

// Signed shortest angular distance from `from` to `to`, in (-π, π].
function angleDiff(from: number, to: number): number {
  let diff = to - from;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

// Deterministic RNG (plan §1.4: sim stays replayable) — Park–Miller LCG.
function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
