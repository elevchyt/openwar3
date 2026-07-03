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
  damagePoint: number; // seconds from swing start to the strike/projectile launch
  range: number; // measured between collision hulls, WC3-style
  acquire: number; // auto-acquisition range (0 = never auto-attacks)
  ranged: boolean; // fires a travelling projectile instead of hitting instantly
  missileArt: string; // projectile model path (renderer), "" = invisible
  missileSpeed: number; // projectile travel speed (world units/sec)
}

/** An in-flight projectile: homes on its target's current position, dealing its
 *  pre-rolled damage on arrival (the renderer draws + moves the missile model). */
export interface SimProjectile {
  id: number;
  x: number;
  y: number;
  sourceId: number; // attacker (for retaliation on hit); may have died mid-flight
  targetId: number;
  speed: number;
  damage: number; // pre-armor damage rolled at launch (armor applied on impact)
  art: string; // missile model path
}

export type SimOrder = "idle" | "move" | "attackmove" | "patrol" | "attack" | "harvest" | "return" | "repair";

/** Active repair job on a worker: restore a building's HP over time for a
 *  fraction of its build cost (WC3: 35% of cost, 150% of build time to full). */
export interface RepairState {
  targetId: number;
  hpPerSec: number;
  goldPerHp: number;
  lumberPerHp: number;
  active: boolean; // arrived + hammering (drives the build animation)
}

/** Harvesting profile + carried load for worker units. */
export interface WorkerState {
  gold: boolean;
  lumber: boolean;
  lumberCapacity: number;
  lumberPerChop: number;
  chopPeriod: number; // seconds between chops
  damagesTree: boolean; // wisps harvest without hurting the tree
  carryGold: number;
  carryLumber: number;
}

/** Where a rally point sends newly-produced units. A plain point is a move; a
 *  mine/tree makes new workers harvest it; a unit makes them move to it (WC3). */
export type RallyKind = "point" | "mine" | "tree" | "unit";

/** Per-building state: construction progress + a unit training queue. */
export interface BuildingState {
  constructionLeft: number; // seconds until built (0 = complete)
  buildTimeTotal: number; // full construction time (for the progress fraction)
  builderIds: number[]; // workers constructing (empty → progress halts). Extra
  // builders past the first "speed build" it (human peasants): faster, but they
  // burn extra resources — see SPEED_BUILD_* constants + tickBuildings.
  goldCost: number; // base build cost, for the speed-build surcharge
  lumberCost: number;
  queue: Array<{ unitId: string; timeLeft: number; buildTime: number }>;
  rallyX: number; // trained units gather here (default: just south of the hall)
  rallyY: number;
  rallyKind: RallyKind; // how the rally target is interpreted (point/mine/tree/unit)
  rallyTargetId: number; // mine/tree/unit id for non-point rallies (0 for a point)
  producesUnits: boolean; // trains units → has a rally point (towers etc. don't)
}

/** A shift-queued follow-up order, replayed when the unit's current order ends.
 *  WC3 allows chaining several (up to ~35) — move, attack, harvest, build… */
export type QueuedOrder =
  | { kind: "move"; x: number; y: number }
  | { kind: "attackmove"; x: number; y: number }
  | { kind: "patrol"; x: number; y: number }
  | { kind: "attack"; targetId: number }
  | { kind: "harvest"; res: "gold" | "lumber"; nodeId: number }
  | { kind: "buildnew"; defId: string; x: number; y: number; gold: number; lumber: number }
  | { kind: "buildresume"; buildingId: number }
  | { kind: "repair"; buildingId: number; hpPerSec: number; goldPerHp: number; lumberPerHp: number };

const MAX_QUEUED_ORDERS = 35; // WC3 action-queue cap

export interface SimMine {
  id: number;
  x: number;
  y: number;
  radius: number;
  gold: number;
  busy: boolean; // WC3 classic mines hold one worker at a time
}

export interface SimTree {
  id: number;
  x: number;
  y: number;
  lumber: number;
}

export interface SimUnit {
  id: number;
  owner: number; // player slot; -1 = map-neutral
  team: number; // units on the same team are allied; -1 = hostile to everyone
  neutralPassive: boolean; // Neutral Passive (shops, critters): never hostile, yellow ring
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
  mana: number;
  maxMana: number;
  armor: number;
  weapon: SimWeapon | null;
  worker: WorkerState | null;
  building: BuildingState | null; // set for structures (construction + training)
  depotGold: boolean; // accepts gold deposits (town halls)
  depotLumber: boolean; // accepts lumber deposits (halls + lumber mill)
  order: SimOrder;
  targetId: number | null;
  cooldownLeft: number;
  // A swing is in progress: the strike/projectile lands `swingLeft` seconds after
  // the attack animation begins (the weapon's damage point), not instantly.
  swingLeft: number; // -1 = no pending strike
  swingTargetId: number; // whom the pending strike is aimed at
  swingSeq: number; // increments each swing start (renderer re-triggers the attack clip)
  inCombat: boolean; // engaging in range this tick (drives the attack animation)
  path: Array<[number, number]>; // world waypoints
  waypoint: number;
  moving: boolean;
  chaseX: number; // where the current chase path was aimed (repath when stale)
  chaseY: number;
  amDestX: number; // attack-move final destination (units engage enemies en route)
  amDestY: number;
  patrolX: number; // the OTHER patrol endpoint (units bounce between the two)
  patrolY: number;
  acquireT: number; // seconds until the next auto-acquire scan
  stuckT: number; // seconds spent blocked while trying to move
  stuckRetries: number; // consecutive stuck-repath attempts without progress
  stuckAnchorX: number; // position at the start of the current stuck window (net-progress check)
  stuckAnchorY: number;
  repathT: number; // chase-repath cooldown after getting blocked
  prevX: number; // position before this tick's movement (stuck detection)
  prevY: number;
  velX: number; // scratch: intended pathed displacement this tick (collision steering)
  velY: number;
  footprint: number; // reserved cells per side when stationary (0 = never)
  resX: number; // origin cell of the current reservation
  resY: number;
  hasReservation: boolean;
  resKind: "gold" | "lumber" | null; // active harvest target kind
  resId: number; // mine/tree id being harvested
  workT: number; // chop/mine timer
  inMine: boolean; // inside the gold mine (renderer hides the unit)
  working: boolean; // chopping (renderer plays the attack animation)
  atNode: boolean; // parked at the resource (approach finished — stop pathing)
  noCollision: boolean; // ghosts through other units (mining workers, WC3-style)
  constructing: number; // building id this worker is constructing (0 = none)
  repair: RepairState | null; // active repair job (null = not repairing)
  orderQueue: QueuedOrder[]; // shift-queued follow-up orders (drained as each completes)
  // Walking to raise a new building; gold/lumber are the already-spent cost,
  // refunded if the build is abandoned before construction starts.
  buildPending: { defId: string; x: number; y: number; gold: number; lumber: number } | null;
}

const ARRIVE_EPS = 8; // world units — "close enough" to a waypoint
// A move ordered within this distance of the unit only turns it in place (WC3
// doesn't shuffle a unit a few pixels — it just pivots to face the point).
const MOVE_MIN_DIST = 40;
// WC3 turn rate (hiveworkshop thread 129619): the object-editor value is
// radians per internal 0.03s frame, capped at ~0.2 rad/frame (≈381.95°/s).
const TURN_FRAME = 0.03;
const TURN_RATE_CAP = 0.2;
const FACING_EPS = 0.35; // radians — must roughly face the target to swing
// Hysteresis: once a unit is attacking in range, the target must move this much
// FURTHER than weapon range before it gives chase again — stops the walk/attack
// animation flip-flop (and position jiggle) at the range boundary.
const ATTACK_LEASH = 48;
const CHASE_REPATH = 128; // repath when the target strays this far from the path goal
const ACQUIRE_PERIOD = 0.5; // seconds between idle auto-acquire scans
const STUCK_TIME = 0.5; // seconds of blocked movement before a unit gives up
const STUCK_RATIO = 0.3; // "blocked" = actual displacement below this share of expected
// Human "speed build": each builder beyond the first adds SPEED_BUILD_BONUS to the
// build rate (1.0 = one builder) and, spread across the shortened build time, a
// SPEED_BUILD_SURCHARGE share of the base cost per extra builder. Tuned to WC3's
// Town Hall reference: 5 peasants take ~53s (from 90s) and cost ~615g (from 385g).
const SPEED_BUILD_BONUS = 0.17;
const SPEED_BUILD_SURCHARGE = 0.15;
const REPATH_COOLDOWN = 0.5; // seconds a blocked chaser waits before repathing
// Resource gathering (community-documented WC3 values; docs/REFERENCES.md).
const GOLD_PER_TRIP = 10;
const MINE_TIME = 1.0; // seconds a worker spends inside the mine
const TREE_LUMBER = 50; // lumber a standard tree yields before falling
const TREE_RADIUS = 16; // half a tree's 2×2-cell footprint, for the reach latch
const DEPOSIT_RANGE = 64; // gap to a depot edge to turn in the load
const RETARGET_RANGE = 1200; // how far a worker looks for the next tree

// WC3 day/night: a full cycle is 480 real seconds = 24 game hours (so one game
// hour = 20 real seconds); daytime is 06:00–18:00. Melee games start at 08:00.
const GAME_HOURS_PER_SEC = 24 / 480;
const DAY_START = 6;
const DAY_END = 18;

export class SimWorld {
  readonly units = new Map<number, SimUnit>();
  readonly mines = new Map<number, SimMine>();
  readonly trees = new Map<number, SimTree>();
  readonly projectiles = new Map<number, SimProjectile>();
  /** Per-player resource stash (gold/lumber). */
  readonly stash = new Map<number, { gold: number; lumber: number }>();
  /** Time of day in game-hours [0,24); advances every tick. */
  timeOfDay = 8;
  private deaths: number[] = [];
  private removals: number[] = []; // units removed WITHOUT a death animation (cancels)
  private felled: SimTree[] = [];
  private depleted: SimMine[] = [];
  private nextProjectileId = 1;
  private spawnedProjectiles: Array<{ id: number; art: string; x: number; y: number }> = [];
  private removedProjectiles: number[] = [];
  // Projectiles that actually HIT (vs fizzled) — the renderer plays the impact
  // effect (the missile model's Death clip) at the recorded point.
  private projectileImpacts: Array<{ id: number; x: number; y: number }> = [];
  // Landed hits (melee + projectile) — the renderer plays the weapon-impact SFX
  // (attacker's weapon material vs target's armour material).
  private hits: Array<{ attackerId: number; targetId: number }> = [];
  // Trained units ready to spawn: the renderer creates the model + sim unit.
  private trainCompletions: Array<{ buildingId: number; unitId: string; x: number; y: number; rallyX: number; rallyY: number; rallyKind: RallyKind; rallyTargetId: number }> = [];
  private nextNodeId = 1;
  private rng: () => number;

  constructor(readonly grid: PathingGrid, seed = 1) {
    this.rng = lcg(seed);
  }

  addMine(x: number, y: number, gold: number, radius = 96): SimMine {
    const mine: SimMine = { id: this.nextNodeId++, x, y, radius, gold, busy: false };
    this.mines.set(mine.id, mine);
    return mine;
  }

  addTree(x: number, y: number, lumber = TREE_LUMBER): SimTree {
    const tree: SimTree = { id: this.nextNodeId++, x, y, lumber };
    this.trees.set(tree.id, tree);
    return tree;
  }

  initStash(owner: number, gold: number, lumber: number): void {
    this.stash.set(owner, { gold, lumber });
  }

  stashOf(owner: number): { gold: number; lumber: number } {
    let s = this.stash.get(owner);
    if (!s) {
      s = { gold: 0, lumber: 0 };
      this.stash.set(owner, s);
    }
    return s;
  }

  nearestTree(x: number, y: number, maxDist: number): SimTree | null {
    let best: SimTree | null = null;
    let bestD = maxDist;
    for (const t of this.trees.values()) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** Up to `limit` trees within `maxDist` of a point, nearest first — used to
   *  spread a group of lumber workers across a cluster instead of piling every
   *  worker onto the single closest tree. */
  nearestTrees(x: number, y: number, maxDist: number, limit: number): SimTree[] {
    const within: Array<{ t: SimTree; d: number }> = [];
    for (const t of this.trees.values()) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d <= maxDist) within.push({ t, d });
    }
    within.sort((a, b) => a.d - b.d);
    return within.slice(0, Math.max(1, limit)).map((e) => e.t);
  }

  nearestMine(x: number, y: number, maxDist: number): SimMine | null {
    let best: SimMine | null = null;
    let bestD = maxDist;
    for (const m of this.mines.values()) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** Trees felled since the last drain (renderer hides them + unstamps cells). */
  drainFelledTrees(): SimTree[] {
    if (!this.felled.length) return this.felled;
    const out = this.felled;
    this.felled = [];
    return out;
  }

  /** Mines that ran dry since the last drain. */
  drainDepletedMines(): SimMine[] {
    if (!this.depleted.length) return this.depleted;
    const out = this.depleted;
    this.depleted = [];
    return out;
  }

  /** Units finished training since the last drain (renderer spawns them). */
  drainTrained(): typeof this.trainCompletions {
    if (!this.trainCompletions.length) return this.trainCompletions;
    const out = this.trainCompletions;
    this.trainCompletions = [];
    return out;
  }

  /** Projectiles launched since the last drain (renderer creates missile models). */
  drainSpawnedProjectiles(): Array<{ id: number; art: string; x: number; y: number }> {
    if (!this.spawnedProjectiles.length) return this.spawnedProjectiles;
    const out = this.spawnedProjectiles;
    this.spawnedProjectiles = [];
    return out;
  }

  /** Projectiles that hit/fizzled since the last drain (renderer detaches them). */
  drainRemovedProjectiles(): number[] {
    if (!this.removedProjectiles.length) return this.removedProjectiles;
    const out = this.removedProjectiles;
    this.removedProjectiles = [];
    return out;
  }

  /** Projectiles that HIT their target since the last drain, with the hit point
   *  (renderer plays the impact effect there). Fizzles are absent. */
  drainProjectileImpacts(): Array<{ id: number; x: number; y: number }> {
    if (!this.projectileImpacts.length) return this.projectileImpacts;
    const out = this.projectileImpacts;
    this.projectileImpacts = [];
    return out;
  }

  /** Weapon hits (melee + projectile) landed since the last drain — the renderer
   *  resolves each attacker/target's material to a combat-impact sound. */
  drainHits(): Array<{ attackerId: number; targetId: number }> {
    if (!this.hits.length) return this.hits;
    const out = this.hits;
    this.hits = [];
    return out;
  }

  /** Queue a unit for training at a building. Timing only — the caller has
   *  already checked/charged resources and food. */
  enqueueTrain(buildingId: number, unitId: string, buildTime: number): boolean {
    const b = this.units.get(buildingId)?.building;
    if (!b) return false;
    b.queue.push({ unitId, timeLeft: buildTime, buildTime });
    return true;
  }

  /** Cancel the last queued item (returns its unitId for a refund, or null). */
  cancelLastTrain(buildingId: number): string | null {
    const b = this.units.get(buildingId)?.building;
    if (!b || !b.queue.length) return null;
    return b.queue.pop()!.unitId;
  }

  /** Cancel a specific queued item by index (0 = the one currently training).
   *  Returns its unitId for a full refund, or null. Removing index 0 just
   *  promotes the next item, which keeps its own untouched build timer (WC3:
   *  cancelling the in-progress unit refunds in full and starts the next fresh). */
  cancelTrainAt(buildingId: number, index: number): string | null {
    const b = this.units.get(buildingId)?.building;
    if (!b || index < 0 || index >= b.queue.length) return null;
    return b.queue.splice(index, 1)[0].unitId;
  }

  /** Set a building's rally point. A plain point (kind "point") is a move
   *  destination; a mine/tree/unit target makes produced units harvest it or
   *  move to it (resolved in the renderer when each unit finishes). */
  setRally(buildingId: number, x: number, y: number, kind: RallyKind = "point", targetId = 0): void {
    const b = this.units.get(buildingId)?.building;
    if (b) {
      b.rallyX = x;
      b.rallyY = y;
      b.rallyKind = kind;
      b.rallyTargetId = targetId;
    }
  }

  /** Assign a worker to construct a building (walk there; progress advances
   *  once it arrives). Called when the building is first placed and when a
   *  worker is ordered to resume a halted construction. */
  assignBuilder(workerId: number, buildingId: number): void {
    const w = this.units.get(workerId);
    const b = this.units.get(buildingId);
    if (!w || !b?.building) return;
    // Release this worker from any previous job, then add it to the site's
    // builder list (multiple workers speed-build a single structure).
    this.detachBuilder(workerId);
    w.buildPending = null; // its walk-to-build intent is now realised
    w.constructing = buildingId;
    if (!b.building.builderIds.includes(workerId)) b.building.builderIds.push(workerId);
    w.noCollision = false;
    w.stuckT = 0;
    w.stuckRetries = 0;
    const gap = Math.max(Math.abs(w.x - b.x), Math.abs(w.y - b.y)) - b.radius - w.radius;
    if (gap >= 96) {
      // Far from the site (e.g. resuming a halted build): walk there. Progress
      // stays paused until the worker arrives (tickBuildings' nearby check).
      w.order = "move";
      if (!this.pathTo(w, b.x, b.y)) {
        w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x);
      }
      return;
    }
    // Adjacent: snap to the nearest free tile outside the building's (now
    // stamped) footprint, so it stands beside the site hammering rather than
    // being trapped inside the under-construction model.
    this.unsettle(w);
    const [cx, cy] = this.grid.worldToCell(w.x, w.y);
    const free = this.grid.nearestWalkable(cx, cy, 8);
    if (free && (free[0] !== cx || free[1] !== cy)) {
      [w.x, w.y] = this.grid.cellToWorld(free[0], free[1]);
    }
    w.order = "idle";
    w.moving = false;
    w.path = [];
    this.settle(w);
    w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x); // face the build site
  }

  /** Stop a worker constructing/repairing (manual order, or death). Called by
   *  every re-task path, so it also cancels a repair job. */
  private detachBuilder(workerId: number): void {
    const w = this.units.get(workerId);
    if (!w) return;
    w.repair = null; // re-tasking cancels a repair
    if (!w.constructing) return;
    const b = this.units.get(w.constructing)?.building;
    if (b) b.builderIds = b.builderIds.filter((id) => id !== workerId);
    w.constructing = 0;
  }

  /** Order a worker to repair a damaged friendly building. Params (rate + cost
   *  per HP) are computed by the caller from the building's build cost/time. */
  issueRepair(id: number, buildingId: number, hpPerSec: number, goldPerHp: number, lumberPerHp: number): boolean {
    const u = this.units.get(id);
    const b = this.units.get(buildingId);
    if (!u || !u.worker || !b?.building || b.building.constructionLeft > 0 || b.hp >= b.maxHp) return false;
    this.detachBuilder(id); // clears any prior repair/build first
    u.order = "repair";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.repair = { targetId: buildingId, hpPerSec, goldPerHp, lumberPerHp, active: false };
    this.pathTo(u, b.x, b.y);
    return true;
  }

  /** Advance a worker's repair: walk to the building, then restore HP over time
   *  while spending the owner's gold/lumber; stop at full or when out of funds. */
  private tickRepair(u: SimUnit, dt: number): void {
    const r = u.repair;
    if (!r) {
      this.stop(u.id);
      return;
    }
    const b = this.units.get(r.targetId);
    if (!b?.building || b.hp >= b.maxHp) {
      this.stop(u.id); // repaired to full, or the building is gone
      return;
    }
    const gap = Math.max(Math.abs(b.x - u.x), Math.abs(b.y - u.y)) - b.radius - u.radius;
    if (u.moving && gap > 96) {
      r.active = false; // still walking to the site
      return;
    }
    this.settle(u);
    r.active = true;
    u.desiredFacing = Math.atan2(b.y - u.y, b.x - u.x);
    const stash = this.stashOf(u.owner);
    const hpAdd = r.hpPerSec * dt;
    if (stash.gold < hpAdd * r.goldPerHp || stash.lumber < hpAdd * r.lumberPerHp) {
      this.stop(u.id); // out of resources
      return;
    }
    stash.gold -= hpAdd * r.goldPerHp;
    stash.lumber -= hpAdd * r.lumberPerHp;
    b.hp = Math.min(b.maxHp, b.hp + hpAdd);
    if (b.hp >= b.maxHp) this.stop(u.id);
  }

  /** Advance construction and training queues for all buildings. */
  private tickBuildings(dt: number): void {
    for (const u of this.units.values()) {
      const b = u.building;
      if (!b) continue;
      if (b.constructionLeft > 0) {
        // Only advance while a builder is assigned AND standing next to the site
        // (WC3: construction halts if the worker wanders off). Progress resumes
        // when a worker is re-tasked to build/repair it. Drop any builder that
        // died or was re-tasked away, then count who is actually hammering.
        b.builderIds = b.builderIds.filter((id) => this.units.get(id)?.constructing === u.id);
        let present = 0;
        for (const id of b.builderIds) {
          const builder = this.units.get(id)!;
          const nearby =
            !builder.moving &&
            Math.max(Math.abs(builder.x - u.x), Math.abs(builder.y - u.y)) - u.radius - builder.radius < 96;
          if (nearby) {
            builder.desiredFacing = Math.atan2(u.y - builder.y, u.x - builder.x); // face the site while hammering
            present++;
          }
        }
        if (present > 0) {
          // Extra builders past the first speed the build but burn extra
          // resources. If the owner can't pay this tick's surcharge, drop back
          // toward the base rate (only as many extras as they can afford).
          let extra = present - 1;
          if (extra > 0) {
            const stash = this.stashOf(u.owner);
            while (extra > 0) {
              const rate = 1 + extra * SPEED_BUILD_BONUS;
              const frac = extra * SPEED_BUILD_SURCHARGE * ((rate * dt) / b.buildTimeTotal);
              const g = frac * b.goldCost;
              const l = frac * b.lumberCost;
              if (stash.gold >= g && stash.lumber >= l) {
                stash.gold -= g;
                stash.lumber -= l;
                break;
              }
              extra--;
            }
          }
          const rate = 1 + extra * SPEED_BUILD_BONUS;
          b.constructionLeft = Math.max(0, b.constructionLeft - rate * dt);
          const done = 1 - b.constructionLeft / b.buildTimeTotal;
          u.hp = u.maxHp * (0.1 + 0.9 * done);
          if (b.constructionLeft === 0) for (const bid of [...b.builderIds]) this.detachBuilder(bid); // free the workers
        }
        continue; // can't train while still being built
      }
      const job = b.queue[0];
      if (job) {
        job.timeLeft -= dt;
        if (job.timeLeft <= 0) {
          b.queue.shift();
          this.trainCompletions.push({ buildingId: u.id, unitId: job.unitId, x: u.x, y: u.y, rallyX: b.rallyX, rallyY: b.rallyY, rallyKind: b.rallyKind, rallyTargetId: b.rallyTargetId });
        }
      }
    }
  }

  /** Cancel a building (manual cancel of an under-construction structure): free
   *  its builder and remove it WITHOUT a death animation — a cancelled building
   *  isn't destroyed in combat, it simply vanishes (the caller plays the race's
   *  cancel-explosion effect over the spot). Returns whether it was removed. */
  cancelBuilding(id: number): boolean {
    const u = this.units.get(id);
    if (!u?.building) return false;
    for (const bid of [...u.building.builderIds]) this.detachBuilder(bid);
    this.unsettle(u); // free its reserved cells
    this.units.delete(u.id);
    this.removals.push(u.id);
    return true;
  }

  /** Whether a building is still under construction (renderer/HUD cue). */
  isUnderConstruction(id: number): boolean {
    const b = this.units.get(id)?.building;
    return !!b && b.constructionLeft > 0;
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
      | "swingLeft"
      | "swingTargetId"
      | "swingSeq"
      | "inCombat"
      | "neutralPassive"
      | "chaseX"
      | "chaseY"
      | "amDestX"
      | "amDestY"
      | "patrolX"
      | "patrolY"
      | "acquireT"
      | "stuckT"
      | "stuckRetries"
      | "stuckAnchorX"
      | "stuckAnchorY"
      | "repathT"
      | "prevX"
      | "prevY"
      | "velX"
      | "velY"
      | "footprint"
      | "resX"
      | "resY"
      | "hasReservation"
      | "resKind"
      | "resId"
      | "workT"
      | "inMine"
      | "working"
      | "atNode"
      | "noCollision"
      | "building"
      | "constructing"
      | "repair"
      | "orderQueue"
      | "buildPending"
    >,
    building?: BuildingState | null,
  ): SimUnit {
    const u: SimUnit = {
      ...unit,
      desiredFacing: unit.facing,
      order: "idle",
      targetId: null,
      cooldownLeft: 0,
      swingLeft: -1,
      swingTargetId: 0,
      swingSeq: 0,
      inCombat: false,
      neutralPassive: false,
      path: [],
      waypoint: 0,
      moving: false,
      chaseX: 0,
      chaseY: 0,
      amDestX: unit.x,
      amDestY: unit.y,
      patrolX: unit.x,
      patrolY: unit.y,
      acquireT: 0,
      stuckT: 0,
      stuckRetries: 0,
      stuckAnchorX: unit.x,
      stuckAnchorY: unit.y,
      repathT: 0,
      prevX: unit.x,
      prevY: unit.y,
      velX: 0,
      velY: 0,
      // Buildings (speed 0) block via their stamped static footprint instead.
      footprint: unit.flying || unit.speed <= 0 ? 0 : footprintCells(unit.radius),
      resX: 0,
      resY: 0,
      hasReservation: false,
      resKind: null,
      resId: 0,
      workT: 0,
      inMine: false,
      working: false,
      atNode: false,
      noCollision: false,
      building: building ?? null,
      constructing: 0,
      repair: null,
      orderQueue: [],
      buildPending: null,
    };
    this.units.set(u.id, u);
    this.settle(u);
    return u;
  }

  // --- cell reservation (WC3 pathing grid) ---------------------------------

  /** A unit came to rest: align it to its cell footprint and reserve the cells
   *  so other units path around it (this is what makes surrounds possible).
   *  `snap` grid-aligns the position — skipped when parking a worker at a
   *  resource so it doesn't teleport off the spot it walked to. */
  private settle(u: SimUnit, snap = true): void {
    u.moving = false;
    u.path = [];
    if (u.footprint <= 0 || u.hasReservation) return;
    let sx = u.x;
    let sy = u.y;
    if (snap) {
      [sx, sy] = this.grid.snapForFootprint(u.x, u.y, u.footprint);
      u.x = sx;
      u.y = sy;
    }
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

  /** Sim ids removed WITHOUT a death animation (cancelled buildings) — the
   *  renderer just hides them (an explosion effect covers the spot instead). */
  drainRemovals(): number[] {
    if (!this.removals.length) return this.removals;
    const out = this.removals;
    this.removals = [];
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
    u.noCollision = false; // manual control restores collision
    this.cancelSwing(u);
    this.detachBuilder(id); // wandering off halts the construction
    u.stuckT = 0;
    u.stuckRetries = 0;
    // Ordered essentially onto our own position: don't shuffle, just pivot.
    if (Math.hypot(tx - u.x, ty - u.y) <= MOVE_MIN_DIST) {
      this.settle(u);
      u.order = "idle";
      if (Math.hypot(tx - u.x, ty - u.y) > 1) u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return false;
    }
    if (!this.pathTo(u, tx, ty)) {
      this.stop(id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return false;
    }
    return true;
  }

  /** Attack-move to a point: walk there but engage any enemies acquired en
   *  route (WC3 A-click). Behaves like a move for pathing/arrival. */
  issueAttackMove(id: number, tx: number, ty: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    u.order = "attackmove";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.amDestX = tx; // final destination; tickAttackMove engages enemies en route
    u.amDestY = ty;
    u.acquireT = 0; // scan on the very first tick so it fights before advancing
    this.pathTo(u, tx, ty); // best-effort initial move (re-decided each tick)
    return true;
  }

  /** Order a unit to patrol between its current position and a point (bounces
   *  back and forth; combat units acquire enemies along the way). */
  issuePatrol(id: number, tx: number, ty: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    u.order = "patrol";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.patrolX = u.x; // the return endpoint is where the patrol was issued
    u.patrolY = u.y;
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
    u.noCollision = false; // manual control restores collision
    this.cancelSwing(u); // a fresh target starts a fresh swing
    this.detachBuilder(id);
    return true;
  }

  stop(id: number): void {
    const u = this.units.get(id);
    if (u) {
      u.order = "idle";
      u.targetId = null;
      u.inCombat = false;
      u.working = false;
      u.atNode = false;
      u.noCollision = false; // manual stop restores collision
      this.cancelSwing(u);
      this.detachBuilder(id);
      this.settle(u);
    }
  }

  // --- shift-queued orders --------------------------------------------------

  /** Append a follow-up order to a unit's queue (WC3 shift-queue, capped at 35).
   *  It runs once the unit's current order — and any orders queued before it —
   *  finish. Does not interrupt whatever the unit is doing now. */
  queueOrder(id: number, order: QueuedOrder): void {
    const u = this.units.get(id);
    if (!u || u.orderQueue.length >= MAX_QUEUED_ORDERS) return;
    u.orderQueue.push(order);
  }

  /** Drop a unit's whole queue + any pending new-building intent. Every fresh
   *  (non-shift) order calls this so it replaces the queue instead of appending.
   *  An unstarted build's cost is refunded (the structure never went up). */
  clearQueue(id: number): void {
    const u = this.units.get(id);
    if (!u) return;
    this.refundPendingBuild(u);
    u.orderQueue.length = 0;
  }

  /** Return an abandoned build's already-spent cost and drop the intent. Called
   *  whenever a `buildPending` worker is re-tasked, stopped, dies, or times out
   *  waiting for its site to clear — i.e. any path where the building never rises.
   *  (A successful raise clears `buildPending` in assignBuilder, without refund.) */
  private refundPendingBuild(u: SimUnit): void {
    if (!u.buildPending) return;
    const s = this.stashOf(u.owner);
    s.gold += u.buildPending.gold;
    s.lumber += u.buildPending.lumber;
    u.buildPending = null;
  }

  /** Public entry: abandon a worker's pending build and refund it (the renderer
   *  calls this when the build site can't be cleared of units in time). */
  cancelPendingBuild(id: number): void {
    const u = this.units.get(id);
    if (u) this.refundPendingBuild(u);
  }

  /** Send a worker to raise a NEW building at (x,y): it walks there and the
   *  renderer raises the foundation on arrival (watches `buildPending`). Used for
   *  immediate (non-shift) placement; the shift path queues a `buildnew` order.
   *  gold/lumber are the already-spent cost, refunded if the build is abandoned. */
  issueBuildNew(id: number, defId: string, x: number, y: number, gold: number, lumber: number): void {
    const u = this.units.get(id);
    if (!u) return;
    u.buildPending = { defId, x, y, gold, lumber };
    if (!this.issueMove(id, x, y)) u.moving = false; // already at the site → raise now
  }

  /** Execute an order right now, replacing whatever the unit is doing and its
   *  whole queue (every fresh, non-shift order goes through here). */
  issueOrder(id: number, order: QueuedOrder): boolean {
    this.clearQueue(id);
    return this.dispatch(id, order);
  }

  /** Route a QueuedOrder to the matching issue* method. Shared by immediate
   *  orders (issueOrder) and queue replay (startNextQueued). */
  private dispatch(id: number, o: QueuedOrder): boolean {
    switch (o.kind) {
      case "move": return this.issueMove(id, o.x, o.y);
      case "attackmove": return this.issueAttackMove(id, o.x, o.y);
      case "patrol": return this.issuePatrol(id, o.x, o.y);
      case "attack": return this.issueAttack(id, o.targetId);
      case "harvest": return this.issueHarvest(id, o.res, o.nodeId);
      case "buildresume": this.assignBuilder(id, o.buildingId); return true;
      case "repair": return this.issueRepair(id, o.buildingId, o.hpPerSec, o.goldPerHp, o.lumberPerHp);
      case "buildnew": this.issueBuildNew(id, o.defId, o.x, o.y, o.gold, o.lumber); return true;
    }
  }

  /** Start the next queued order (called when a unit falls idle with a queue).
   *  A failed order (dead target, unbuildable, …) is simply dropped and the next
   *  one is tried on the following tick. */
  private startNextQueued(u: SimUnit): void {
    const o = u.orderQueue.shift();
    if (o) this.dispatch(u.id, o);
  }

  /** Order a worker to harvest a mine or tree. False if it can't. */
  issueHarvest(id: number, kind: "gold" | "lumber", nodeId: number): boolean {
    const u = this.units.get(id);
    if (!u || !u.worker) return false;
    if (kind === "gold" && (!u.worker.gold || !this.mines.has(nodeId))) return false;
    if (kind === "lumber" && (!u.worker.lumber || !this.trees.has(nodeId))) return false;
    u.order = "harvest";
    u.targetId = null;
    u.inCombat = false;
    u.resKind = kind;
    u.resId = nodeId;
    u.atNode = false;
    u.working = false;
    u.noCollision = false; // manual harvest order restores collision
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    this.pathToNode(u); // walk toward the node once; arrival latches atNode
    return true;
  }

  /** Path a harvesting worker toward its current node (once — arriveAtNode then
   *  waits for arrival instead of re-pathing, which is what caused the jitter).
   *  Gold miners approach the mine from the drop-off (town hall) side so they line
   *  up mine-centre → hall-centre like the original game, rather than entering
   *  whichever edge they happened to wander to. */
  private pathToNode(u: SimUnit): void {
    const node = u.resKind === "gold" ? this.mines.get(u.resId) : this.trees.get(u.resId);
    if (node) this.pathTo(u, node.x, node.y); // approach (and enter) from any side
  }

  /** A point on the mine's edge facing the drop-off (town hall). Workers enter the
   *  mine from whatever side they walked up to, but always EMERGE here so they exit
   *  toward the nearest hall and form the mine→hall line (WC3). */
  private mineApproach(u: SimUnit, mine: SimMine): [number, number] {
    const depot = this.nearestGoldDepot(u);
    if (!depot) return [mine.x, mine.y];
    const dx = depot.x - mine.x;
    const dy = depot.y - mine.y;
    const d = Math.hypot(dx, dy) || 1;
    return [mine.x + (dx / d) * (mine.radius + u.radius), mine.y + (dy / d) * (mine.radius + u.radius)];
  }

  /** Nearest gold drop-off (town hall) of the worker's owner — the anchor for the
   *  mine→hall harvest line. Distinct from nearestDepot, which keys off the load. */
  private nearestGoldDepot(u: SimUnit): SimUnit | null {
    let depot: SimUnit | null = null;
    let bestD = Infinity;
    for (const d of this.units.values()) {
      if (d.owner !== u.owner || !d.depotGold) continue;
      const dist = Math.hypot(d.x - u.x, d.y - u.y);
      if (dist < bestD) {
        bestD = dist;
        depot = d;
      }
    }
    return depot;
  }

  /** Send a loaded worker back to deposit: path to the nearest depot ONCE, then
   *  tickReturn waits for arrival (same "park where the pathfinder stops"
   *  contract as harvesting — this is what fixes workers getting stuck at the
   *  town hall, whose big footprint made a fixed deposit radius unreachable). */
  private startReturn(u: SimUnit): void {
    u.order = "return";
    u.working = false;
    u.atNode = false;
    const depot = this.nearestDepot(u);
    if (depot) {
      const [ax, ay] = this.depotApproach(u, depot);
      this.pathTo(u, ax, ay);
    }
  }

  /** A point on the depot's near side (toward the worker) rather than its
   *  centre, so resources return to the closest edge of the building from
   *  whatever direction the worker comes — not always the same back corner
   *  (which is what pathing to the centre + nearest-walkable produced). */
  private depotApproach(u: SimUnit, depot: SimUnit): [number, number] {
    const dx = u.x - depot.x;
    const dy = u.y - depot.y;
    const d = Math.hypot(dx, dy) || 1;
    return [depot.x + (dx / d) * depot.radius, depot.y + (dy / d) * depot.radius];
  }

  private nearestDepot(u: SimUnit): SimUnit | null {
    const w = u.worker;
    if (!w) return null;
    const wantGold = w.carryGold > 0;
    let depot: SimUnit | null = null;
    let bestD = Infinity;
    for (const d of this.units.values()) {
      if (d.owner !== u.owner) continue;
      if (wantGold ? !d.depotGold : !d.depotLumber) continue;
      const dist = Math.hypot(d.x - u.x, d.y - u.y);
      if (dist < bestD) {
        bestD = dist;
        depot = d;
      }
    }
    return depot;
  }

  // Different teams are enemies; creeps all share team -1 (hostile to every
  // player team but not to each other, like WC3's Neutral Hostile). Neutral
  // Passive entities (shops, critters) are hostile to no one.
  hostile(a: SimUnit, b: SimUnit): boolean {
    if (a.neutralPassive || b.neutralPassive) return false;
    return a.team !== b.team;
  }

  /** True during daylight (06:00–18:00 game time). */
  get isDay(): boolean {
    return this.timeOfDay >= DAY_START && this.timeOfDay < DAY_END;
  }

  tick(dt: number): void {
    this.timeOfDay = (this.timeOfDay + dt * GAME_HOURS_PER_SEC) % 24;
    this.tickBuildings(dt);
    for (const u of this.units.values()) {
      if (u.cooldownLeft > 0) u.cooldownLeft -= dt;
      if (u.repathT > 0) u.repathT -= dt;
      u.prevX = u.x;
      u.prevY = u.y;
      switch (u.order) {
        case "attack":
          this.tickAttack(u);
          break;
        case "harvest":
          this.tickHarvest(u, dt);
          break;
        case "return":
          this.tickReturn(u);
          break;
        case "repair":
          this.tickRepair(u, dt);
          break;
        case "attackmove":
          this.tickAttackMove(u, dt); // fight nearby enemies first, then advance
          break;
        case "patrol":
          this.tickAcquire(u, dt); // engage enemies encountered en route
          break;
        case "idle":
          this.tickAcquire(u, dt);
          break;
      }
    }
    this.tickMovement(dt);
    this.resolveCollisions();
    this.tickProjectiles(dt);
    for (const u of this.units.values()) {
      // Turning runs every tick, independent of movement: a unit that arrived
      // (or stands attacking) still finishes rotating to its desired heading.
      if (u.facing !== u.desiredFacing) {
        u.facing = turnToward(u.facing, u.desiredFacing, turnSpeed(u.turnRate) * dt);
      }
      this.tickSwing(u, dt); // land pending strikes at their damage point
      this.checkStuck(u, dt);
    }
    // Advance shift-queues: a unit that just fell idle (and isn't building or
    // walking to a build site) starts its next queued order. Runs after all
    // order/movement processing so "arrived → idle" is visible this tick.
    for (const u of this.units.values()) {
      if (u.orderQueue.length && u.order === "idle" && u.constructing === 0 && !u.buildPending) {
        this.startNextQueued(u);
      }
    }
  }

  // A moving unit that barely progresses (blocked by units it may not push) gives
  // up after a moment: move orders stop (WC3 units halt when the way is blocked);
  // chasers pause before repathing so they don't grind against the blocker.
  //
  // Progress is measured as NET displacement over a whole STUCK_TIME window, not
  // per-tick speed: two units orbiting each other move at full speed every tick
  // (so a per-tick check never fires) yet drift almost nowhere — the window catches
  // that "dancing" and breaks it up, while a unit legitimately detouring around an
  // obstacle keeps covering real ground and is left alone.
  private checkStuck(u: SimUnit, dt: number): void {
    if (!u.moving || u.speed <= 0) {
      u.stuckT = 0;
      return;
    }
    if (u.stuckT === 0) {
      u.stuckAnchorX = u.prevX; // window opens from where this tick started
      u.stuckAnchorY = u.prevY;
    }
    u.stuckT += dt;
    if (u.stuckT < STUCK_TIME) return;
    const netMoved = Math.hypot(u.x - u.stuckAnchorX, u.y - u.stuckAnchorY);
    const expected = u.speed * u.stuckT;
    u.stuckT = 0;
    if (netMoved >= expected * STUCK_RATIO) {
      u.stuckRetries = 0; // covered real ground — not stuck
      return;
    }
    if (u.order === "attack") {
      this.settle(u);
      u.repathT = REPATH_COOLDOWN;
      return;
    }
    // Gatherers must NEVER idle mid-job just because they're jostling in a crowd
    // around the trees/mine (which the stricter net-progress check above would
    // otherwise flag). Re-route around the crowd; a boxed-in lumberjack parks in
    // place so tickHarvest chops the nearest reachable tree instead of standing idle.
    if (u.worker && (u.order === "harvest" || u.order === "return")) {
      const routed = this.pathTo(u, u.chaseX, u.chaseY);
      if (!routed && u.order === "harvest" && u.resKind === "lumber") {
        this.settle(u);
        u.atNode = false;
      }
      u.stuckRetries = 0;
      return;
    }
    // Blocked/orbiting: the blockers may have stopped since the original path
    // was computed — repath around them. A unit that stays stuck (boxed in)
    // stands down after a couple of attempts and just faces where it was
    // ordered — WC3 units never squeeze through crowds.
    const [tx, ty] = [u.chaseX, u.chaseY];
    if (++u.stuckRetries > 1 || !this.pathTo(u, tx, ty)) {
      this.stop(u.id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
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
    this.engage(u, t);
  }

  /** Close to weapon range, then face + swing at the damage point. Shared by
   *  direct Attack orders and attack-move engagements. */
  private engage(u: SimUnit, t: SimUnit): void {
    const w = u.weapon!;
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    // Hysteresis: while already in combat, tolerate a little extra distance before
    // re-chasing, so a target that jostles across the range edge doesn't make the
    // unit oscillate walk↔attack (the "jiggling" between animations).
    const chaseGap = u.inCombat ? w.range + ATTACK_LEASH : w.range;
    if (gap > chaseGap) {
      u.inCombat = false;
      this.chase(u, t);
      return;
    }
    // In range: halt, face the target, swing when ready (rotation itself is
    // applied by the shared per-tick turning pass).
    this.settle(u);
    u.inCombat = true;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    // Don't start a new swing while facing the wrong way, cooling down, or with a
    // swing already mid-flight toward its damage point.
    if (Math.abs(angleDiff(u.facing, u.desiredFacing)) > FACING_EPS || u.cooldownLeft > 0 || u.swingLeft >= 0) return;
    // Begin the attack: the cooldown starts now, but the strike/projectile only
    // lands at the weapon's damage point (a fraction into the swing animation) —
    // matching WC3 so e.g. the Archmage's fireball leaves at the right moment.
    u.cooldownLeft = w.cooldown;
    u.swingLeft = Math.max(0, w.damagePoint);
    u.swingTargetId = t.id;
    u.swingSeq++; // renderer restarts the attack animation so the strike lines up
  }

  /** Attack-move: fight any hostiles within acquisition range FIRST (chasing +
   *  attacking, and acquiring the next the moment one dies), advancing toward the
   *  destination only when nothing is left to fight nearby (WC3 A-move). */
  private tickAttackMove(u: SimUnit, dt: number): void {
    const w = u.weapon;
    if (w && w.acquire > 0) {
      const hadTarget = u.targetId !== null;
      let t = hadTarget ? this.units.get(u.targetId!) : undefined;
      // Drop the target if it died, turned friendly, or fled past the leash.
      if (t && (!this.hostile(u, t) || Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > w.acquire)) t = undefined;
      if (!t) {
        if (hadTarget) u.acquireT = 0; // just lost one — re-scan now, don't creep forward
        u.acquireT -= dt;
        if (u.acquireT <= 0) {
          u.acquireT = ACQUIRE_PERIOD;
          t = this.nearestEnemy(u, w.acquire) ?? undefined;
        }
      }
      if (t) {
        u.targetId = t.id;
        this.engage(u, t);
        return; // an enemy is in range — stand and fight, don't advance
      }
    }
    // Nothing to fight nearby: resume toward the attack-move destination.
    u.targetId = null;
    u.inCombat = false;
    if (Math.hypot(u.amDestX - u.x, u.amDestY - u.y) <= ARRIVE_EPS) {
      this.stop(u.id); // arrived
      return;
    }
    if (!u.moving) {
      if (!this.pathTo(u, u.amDestX, u.amDestY)) {
        this.stop(u.id);
        u.desiredFacing = Math.atan2(u.amDestY - u.y, u.amDestX - u.x);
      }
    } else if (Math.hypot(u.chaseX - u.amDestX, u.chaseY - u.amDestY) > CHASE_REPATH) {
      this.pathTo(u, u.amDestX, u.amDestY); // was chasing an enemy — steer back on course
    }
  }

  /** Nearest hostile within `range` (gap measured hull-to-hull), or null. */
  private nearestEnemy(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap < bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    return best;
  }

  /** Advance an in-progress attack swing; when it reaches the weapon's damage
   *  point, launch the projectile (ranged) or deal the hit (melee). */
  private tickSwing(u: SimUnit, dt: number): void {
    if (u.swingLeft < 0 || !u.weapon) return;
    u.swingLeft -= dt;
    if (u.swingLeft > 0) return;
    u.swingLeft = -1;
    const t = this.units.get(u.swingTargetId);
    if (!t) return; // target gone before impact — the swing whiffs
    if (u.weapon.ranged) {
      this.spawnProjectile(u, t);
    } else {
      // Melee connects if the target is still within the same reach the unit is
      // allowed to swing from (range + the combat-hold leash) — NOT the tighter
      // ARRIVE_EPS, which left a dead band where the attack animation played but
      // the strike whiffed and no damage landed against a target drifting away.
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap <= u.weapon.range + ATTACK_LEASH) this.dealDamage(u, t);
    }
  }

  /** Cancel any pending swing (unit re-tasked away from its attack). */
  private cancelSwing(u: SimUnit): void {
    u.swingLeft = -1;
  }

  /** Launch a homing projectile from attacker to target. Damage is rolled now
   *  and applied when it lands (armor is applied at impact). */
  private spawnProjectile(u: SimUnit, t: SimUnit): void {
    const w = u.weapon!;
    const id = this.nextProjectileId++;
    const proj: SimProjectile = {
      id,
      x: u.x,
      y: u.y,
      sourceId: u.id,
      targetId: t.id,
      speed: w.missileSpeed > 0 ? w.missileSpeed : 900,
      damage: this.rollDamage(w),
      art: w.missileArt,
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y });
  }

  /** Advance in-flight projectiles toward their (moving) targets; deal damage on
   *  arrival, and fizzle harmlessly if the target died before impact. */
  private tickProjectiles(dt: number): void {
    for (const p of this.projectiles.values()) {
      const t = this.units.get(p.targetId);
      if (!t) {
        this.removeProjectile(p.id);
        continue;
      }
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const dist = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (dist <= step + t.radius) {
        this.projectileImpacts.push({ id: p.id, x: t.x, y: t.y }); // record the hit point
        this.applyDamage(t, p.damage, p.sourceId);
        this.removeProjectile(p.id);
      } else {
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
      }
    }
  }

  private removeProjectile(id: number): void {
    if (this.projectiles.delete(id)) this.removedProjectiles.push(id);
  }

  // Path toward the target; repath only when the target strays from the path
  // goal (A* every tick would be wasteful and jittery), and not while cooling
  // down after being blocked by units we may not push.
  private chase(u: SimUnit, t: SimUnit): void {
    this.chasePoint(u, t.x, t.y);
  }

  private chasePoint(u: SimUnit, x: number, y: number): void {
    if (u.repathT > 0) return;
    if (u.moving && Math.hypot(x - u.chaseX, y - u.chaseY) < CHASE_REPATH) return;
    this.pathTo(u, x, y);
  }

  // --- resource gathering ---------------------------------------------------

  private tickHarvest(u: SimUnit, dt: number): void {
    const w = u.worker;
    if (!w) {
      this.stop(u.id);
      return;
    }
    // Inside the mine: wait out the mining time, then emerge with the load.
    if (u.inMine) {
      u.workT -= dt;
      if (u.workT <= 0) {
        u.inMine = false;
        const mine = this.mines.get(u.resId);
        if (mine) {
          mine.busy = false;
          w.carryGold = Math.min(GOLD_PER_TRIP, mine.gold);
          mine.gold -= w.carryGold;
          if (mine.gold <= 0) {
            this.mines.delete(mine.id);
            this.depleted.push(mine);
          }
          // Emerge on the side facing the town hall — the worker was invisible
          // inside, so re-placing it here is seamless and makes it ALWAYS exit
          // toward the drop-off (forming the mine→hall line) whatever side it
          // entered from. `mine` is still a valid object even if just depleted.
          [u.x, u.y] = this.mineApproach(u, mine);
        }
        // Emerging from the mine with gold: ghost through other units for the
        // whole auto back-and-forth (WC3), until the player takes manual control.
        u.noCollision = true;
        this.startReturn(u);
      }
      return;
    }
    // Carrying a full load already (e.g. re-ordered mid-return): go deposit.
    if (w.carryGold > 0 || (w.lumberCapacity > 0 && w.carryLumber >= w.lumberCapacity)) {
      this.startReturn(u);
      return;
    }

    if (u.resKind === "gold") {
      const mine = this.mines.get(u.resId);
      if (!mine) {
        this.stop(u.id);
        return;
      }
      // Walk up to the mine and duck inside from WHATEVER side we reached — the
      // reach hugs the footprint edge (radius + own body) with a hair of slack so
      // the worker visibly touches the mine before it vanishes. (It re-emerges on
      // the hall-facing side; see the emerge branch above.)
      if (!this.arriveAtNode(u, mine.x, mine.y, mine.radius + u.radius + 8)) return;
      if (mine.busy) return; // parked at the entrance, waiting our turn (no re-path)
      mine.busy = true;
      u.inMine = true;
      u.workT = MINE_TIME;
      u.atNode = false;
      this.unsettle(u); // don't block cells while invisible inside
      u.moving = false;
      u.path = [];
      return;
    }

    // Lumber.
    let tree = this.trees.get(u.resId) ?? null;
    if (!tree) {
      tree = this.nearestTree(u.x, u.y, RETARGET_RANGE);
      if (!tree) {
        // No tree left to chop: haul the partial load home (startReturn clears the
        // working flag and paths to the depot), or idle if empty-handed.
        if (w.carryLumber > 0) this.startReturn(u);
        else this.stop(u.id);
        return;
      }
      u.resId = tree.id;
      u.atNode = false;
      u.working = false;
      this.pathTo(u, tree.x, tree.y); // walk to the freshly-picked tree
    }
    // Approach until parked next to the tree, then chop in place (never re-path
    // once working — that was the source of the mining "jiggle").
    const reach = u.radius + TREE_RADIUS + 40;
    if (!this.arriveAtNode(u, tree.x, tree.y, reach)) {
      u.working = false;
      return;
    }
    // Parked. If the clicked tree is out of reach (walled in / deep in the
    // forest), harvest the nearest tree to where the worker actually stopped —
    // WC3 gathers from the closest ACCESSIBLE tree to the one you clicked.
    if (Math.hypot(tree.x - u.x, tree.y - u.y) > reach) {
      const near = this.nearestTree(u.x, u.y, reach + 48);
      if (near && near.id !== tree.id) {
        tree = near;
        u.resId = near.id;
      }
    }
    u.working = true;
    u.desiredFacing = Math.atan2(tree.y - u.y, tree.x - u.x);
    u.workT -= dt;
    if (u.workT > 0) return;
    u.workT = w.chopPeriod;
    w.carryLumber = Math.min(w.lumberCapacity, w.carryLumber + w.lumberPerChop);
    if (w.damagesTree) {
      tree.lumber -= w.lumberPerChop;
      if (tree.lumber <= 0) {
        this.trees.delete(tree.id);
        this.felled.push(tree);
        // The tree we were chopping just fell. If we aren't full yet, walk to the
        // nearest remaining tree straight away and keep gathering (no idle frame).
        if (w.carryLumber < w.lumberCapacity) {
          const next = this.nearestTree(u.x, u.y, RETARGET_RANGE);
          if (next) {
            u.resId = next.id;
            u.atNode = false;
            u.working = false;
            this.pathTo(u, next.x, next.y);
            return;
          }
        }
      }
    }
    if (w.carryLumber >= w.lumberCapacity) {
      this.startReturn(u);
    }
  }

  /** Latch a worker as "parked at the node". The approach path was issued once
   *  at order time (pathToNode), so here we only need to wait for arrival: still
   *  moving → keep walking; within `reach` or arrived (best-effort path ended)
   *  → park in place (no snap, no re-path — this is what killed the jitter). */
  private arriveAtNode(u: SimUnit, x: number, y: number, reach: number): boolean {
    if (u.atNode) return true;
    if (u.moving && Math.hypot(x - u.x, y - u.y) > reach) return false;
    this.settle(u, false);
    u.atNode = true;
    return true;
  }

  private tickReturn(u: SimUnit): void {
    const w = u.worker;
    if (!w || (w.carryGold <= 0 && w.carryLumber <= 0)) {
      if (w && u.resKind) u.order = "harvest";
      else this.stop(u.id);
      return;
    }
    const depot = this.nearestDepot(u);
    if (!depot) {
      this.stop(u.id); // nowhere to drop off (hall destroyed) — idle
      return;
    }
    // Deposit once we've reached the depot's near edge: within range, or parked
    // as close as the pathfinder can get us (its footprint blocks the last
    // stretch). Approaching the near side keeps workers from all funnelling to
    // one back corner, and the arrive-then-deposit contract stops them circling
    // a town hall they can't quite touch.
    const [ax, ay] = this.depotApproach(u, depot);
    if (!this.arriveAtNode(u, ax, ay, u.radius + DEPOSIT_RANGE)) return;
    const stash = this.stashOf(u.owner);
    stash.gold += w.carryGold;
    stash.lumber += w.carryLumber;
    w.carryGold = 0;
    w.carryLumber = 0;
    // Head back to the same node (or the nearest remaining tree), WC3-style.
    u.atNode = false;
    if (u.resKind === "gold" && this.mines.has(u.resId)) {
      u.order = "harvest";
      // Return to the SAME hall-facing edge we exited from (not the centre), so the
      // round trip is a straight mine→hall line instead of re-entering off a side.
      const mine = this.mines.get(u.resId)!;
      const [tx, ty] = this.mineApproach(u, mine);
      this.pathTo(u, tx, ty);
    } else if (u.resKind === "lumber") {
      const tree = this.trees.get(u.resId) ?? this.nearestTree(u.x, u.y, RETARGET_RANGE);
      if (tree) {
        u.resId = tree.id;
        u.order = "harvest";
        this.pathToNode(u);
      } else {
        this.stop(u.id);
      }
    } else {
      this.stop(u.id);
    }
  }

  /** Roll a weapon's pre-armor damage: base + dice×(1..sides). */
  private rollDamage(w: SimWeapon): number {
    let dmg = w.damage;
    for (let i = 0; i < w.dice; i++) dmg += 1 + Math.floor(this.rng() * w.sides);
    return dmg;
  }

  private dealDamage(attacker: SimUnit, target: SimUnit): void {
    this.applyDamage(target, this.rollDamage(attacker.weapon!), attacker.id);
  }

  /** Apply already-rolled damage to a target (armor reduction, death, return
   *  fire). Shared by melee (instant) and projectile (on-impact) hits. */
  private applyDamage(target: SimUnit, rawDamage: number, attackerId: number): void {
    this.hits.push({ attackerId, targetId: target.id }); // renderer plays the impact SFX
    // WC3 armor reduction: each armor point is worth 6% of pre-armor damage.
    const reduction = (target.armor * 0.06) / (1 + 0.06 * Math.max(0, target.armor));
    target.hp -= rawDamage * (1 - reduction);
    if (target.hp <= 0) {
      this.kill(target);
      return;
    }
    // Retaliate: an idle armed victim turns on its attacker (WC3 return fire),
    // unless the attacker has since died mid-flight.
    if (target.order === "idle" && target.weapon && this.units.has(attackerId)) {
      this.issueAttack(target.id, attackerId);
    }
  }

  private kill(u: SimUnit): void {
    this.refundPendingBuild(u); // died before its building went up → refund the cost
    this.unsettle(u); // corpses don't block cells
    if (u.inMine) {
      const mine = this.mines.get(u.resId);
      if (mine) mine.busy = false; // don't wedge the mine shut forever
    }
    if (u.constructing) this.detachBuilder(u.id); // free the halted construction
    this.units.delete(u.id); // Map delete during values() iteration is safe
    this.deaths.push(u.id);
  }

  // Idle (or patrolling) armed units scan for the nearest enemy in acquisition
  // range and turn on it.
  private tickAcquire(u: SimUnit, dt: number): void {
    if (!u.weapon || u.weapon.acquire <= 0) return;
    u.acquireT -= dt;
    if (u.acquireT > 0) return;
    u.acquireT = ACQUIRE_PERIOD;
    const best = this.nearestEnemy(u, u.weapon.acquire);
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
        if ((u.order === "move" || u.order === "attackmove") && this.retryFreedGoal(u)) continue;
        // Patrol: reached one endpoint — turn around and head to the other.
        if (u.order === "patrol") {
          const nx = u.patrolX;
          const ny = u.patrolY;
          u.patrolX = u.chaseX; // the endpoint just reached becomes the return point
          u.patrolY = u.chaseY;
          if (!this.pathTo(u, nx, ny)) this.stop(u.id);
          continue;
        }
        this.settle(u); // arrival: snap to the cell grid and reserve
        // A plain move ends here. An attack-move only ends when it has actually
        // reached its destination — a path that ended mid-chase (or short of the
        // goal) stays an attack-move so tickAttackMove keeps fighting/advancing.
        if (u.order === "move") u.order = "idle";
        else if (u.order === "attackmove" && Math.hypot(u.amDestX - u.x, u.amDestY - u.y) <= PATHING_CELL * 1.5) u.order = "idle";
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
    // footprint, not separation; air units don't collide; mining workers ghost
    // through everything until manually controlled (u.noCollision).
    for (const u of this.units.values())
      if (!u.flying && u.radius > 0 && u.speed > 0 && !u.noCollision) list.push(u);
    // Snapshot each unit's intended (pathed) velocity for this tick, captured
    // before the nudges below mutate positions. prevX/prevY are set pre-movement,
    // so (x-prevX) is the step tickMovement just took toward the goal — used to
    // tell head-on closers (slide past) from units circling or brushing shoulders
    // (separate radially only, so they don't feed a perpetual orbit = "dancing").
    for (const u of list) {
      u.velX = u.x - u.prevX;
      u.velY = u.y - u.prevY;
    }
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
            const nx = dx / d; // unit vector a→b
            const ny = dy / d;
            const half = overlap / 2;
            // Tangential slide ONLY when the pair is genuinely closing head-on
            // (relative velocity shrinks the gap) — that's the deadlock case the
            // slide is meant to break. Parallel/circling pairs (relative velocity
            // perpendicular to the gap) get pure radial separation, so nothing
            // keeps spinning them around each other.
            const closing = (b.velX - a.velX) * nx + (b.velY - a.velY) * ny < -1e-4;
            const tx = closing ? -ny * half : 0;
            const ty = closing ? nx * half : 0;
            this.nudge(a, -nx * half + tx, -ny * half + ty);
            this.nudge(b, nx * half - tx, ny * half - ty);
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
