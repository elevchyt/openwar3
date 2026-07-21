import type { SimItem, SimUnit } from "../sim/world";
import type { UnitSnapshot, WorldSnapshot } from "./snapshot";

/**
 * Option 2's applier (docs/multiplayer.md — Open questions, decided): a CLIENT's `SimWorld`
 * stops stepping and becomes a record store this module writes. An arriving snapshot
 * CREATES a record for an id the store has not seen, UPDATES the fields it was sent, and
 * REMOVES records absent from the payload — absence means "you cannot see it", and deleting
 * the record is precisely what closes the maphack: the enemy's base is no longer in this
 * process's memory for devtools to read. AoI filtering keeps it off the wire; this keeps it
 * out of the store.
 *
 * The field set written here is `snapshotFor`'s construction run in reverse, and the 2a
 * sizing pass (Phase G item 6) is the warrant that it is ENOUGH: every field the ~55
 * identity/permission sites and the render surfaces read off a record is either written
 * below or re-derivable from the unit def. Sim-internal scratch (pathing, stall timers,
 * `base*` baselines) is left at whatever `addSimUnit` seeded — the sim never ticks on a
 * client, so nothing reads it.
 *
 * **This file imports no renderer and no transport.** It writes records; who delivered the
 * payload is `MatchLink`'s business, and what grows a model over a created record is the
 * renderer's (item 2c).
 */

/** The slice of `SimWorld` the applier writes. Structural, so a headless test passes a stub
 *  and the standalone compile stays free of the world's import closure. */
export interface ApplyWorld {
  readonly units: Map<number, SimUnit>;
  /** Mine positions are public map furniture (ids agree from `.doo` order); only the gold
   *  reading is written, and only when the recipient has eyes on it (-1 = "no eyes"). */
  readonly mines: ReadonlyMap<number, { gold: number }>;
  readonly items: Map<number, SimItem>;
  timeOfDay: number;
  dawnDusk: boolean;
  /** The sim's own clean removal (unstamps footprints, frees cells, queues the render-side
   *  drop) — NOT a bare `units.delete`, or a removed building would leave its collision
   *  stamped on the client's grid forever. */
  removeUnit(id: number): boolean;
}

/** Patch a live record with one unit's payload. Exported for the applier test.
 *
 *  The composite writes (weapon, building, worker) PATCH the existing sub-object where one
 *  exists rather than replacing it: `addSimUnit` built those from the unit def with the
 *  def-derived fields (costs, capacities, base ratios) the wire deliberately does not carry,
 *  and a wholesale replace would zero them. Where the record has none (a snapshot type the
 *  def disagrees with), the carried subset is seated as-is — the 2a inventory says nothing
 *  reads past it on a client. */
export function writeUnitSnapshot(u: SimUnit, s: UnitSnapshot): void {
  // Identity. `typeId` is writable on purpose: a morph (Town Hall → Keep) keeps the id and
  // rewrites the type, and the client learns of it exactly this way.
  u.owner = s.owner;
  u.team = s.team;
  u.typeId = s.typeId;
  u.race = s.race;
  u.neutralPassive = s.neutralPassive;
  u.isHero = s.isHero;
  u.properName = s.properName;
  u.isCreep = s.isCreep;

  // Pose. `prev*` is rolled forward first so anything reading "where was it last frame"
  // sees the previous payload's position rather than garbage.
  u.prevX = u.x;
  u.prevY = u.y;
  u.x = s.x;
  u.y = s.y;
  u.facing = s.facing;
  u.flyHeight = s.flyHeight;
  u.speed = s.speed;
  u.radius = s.radius;
  u.flying = s.flying;
  u.order = s.order as SimUnit["order"];
  u.moving = s.moving;
  u.inCombat = s.inCombat;
  u.working = s.working;
  u.swingSeq = s.swingSeq;
  u.chopSeq = s.chopSeq;
  u.swingBroken = s.swingBroken;
  u.swingSlam = s.swingSlam;
  u.altModel = s.altModel;
  u.spawning = s.spawning;
  u.constructing = s.constructing;
  // Only `.active` crosses the wire and only `.active` is read on a client (2a) — the rest
  // of RepairState is how the sim charges for a repair, and this sim never charges.
  u.repair = s.repair ? ({ active: s.repair.active } as unknown as SimUnit["repair"]) : null;

  // Hidden / faded.
  u.inMine = s.inMine;
  u.insideBuild = s.insideBuild;
  u.inBurrow = s.inBurrow;
  u.devouredBy = s.devouredBy;
  u.vanished = s.vanished;
  u.invisible = s.invisible;
  u.ethereal = s.ethereal;

  // Panel numbers.
  u.hp = s.hp;
  u.maxHp = s.maxHp;
  u.mana = s.mana;
  u.maxMana = s.maxMana;
  u.armor = s.armor;
  u.bonusArmor = s.bonusArmor;
  u.bonusDamage = s.bonusDamage;
  u.invulnerable = s.invulnerable;
  u.weapon = mergeWeapon(u.weapon, s.weapon);
  u.swingWeapon = mergeWeapon(u.swingWeapon, s.swingWeapon);

  // Hero block.
  u.level = s.level;
  u.xp = s.xp;
  u.skillPoints = s.skillPoints;
  u.str = s.str;
  u.agi = s.agi;
  u.int = s.int;
  u.bonusStr = s.bonusStr;
  u.bonusAgi = s.bonusAgi;
  u.bonusInt = s.bonusInt;

  // Composites.
  if (s.worker && u.worker) {
    u.worker.gold = s.worker.gold;
    u.worker.lumber = s.worker.lumber;
    u.worker.carryGold = s.worker.carryGold;
    u.worker.carryLumber = s.worker.carryLumber;
  } else if (s.worker) {
    u.worker = { ...s.worker } as unknown as SimUnit["worker"];
  } else {
    u.worker = null;
  }
  if (s.building && u.building) {
    u.building.constructionLeft = s.building.constructionLeft;
    u.building.buildTimeTotal = s.building.buildTimeTotal;
    u.building.queue = s.building.queue;
    u.building.producesUnits = s.building.producesUnits;
    u.building.rallyX = s.building.rallyX;
    u.building.rallyY = s.building.rallyY;
    u.building.rallyKind = s.building.rallyKind as NonNullable<SimUnit["building"]>["rallyKind"];
    u.building.rallyTargetId = s.building.rallyTargetId;
  } else if (s.building) {
    u.building = { ...s.building, builderIds: [], goldCost: 0, lumberCost: 0 } as unknown as SimUnit["building"];
  } else {
    u.building = null;
  }
  u.abilities = s.abilities;
  u.buffs = s.buffs;
  u.inventory = s.inventory;
  u.garrison = s.garrison;
  u.garrisonCap = s.garrisonCap;

  // Summons and illusions arrive PRE-MASKED per recipient (snapshot.ts) — written verbatim,
  // never re-derived, which is what keeps the tells viewpoint-gated (docs/illusions.md).
  u.isSummon = s.isSummon;
  u.summonLeft = s.summonLeft;
  u.summonMax = s.summonMax;
  u.isIllusion = s.isIllusion;
  u.illusionOf = s.illusionOf;

  u.guardX = s.guardX;
  u.guardY = s.guardY;

  // Private intent: null unless this recipient owns the unit (snapshot.ts own-gates them).
  u.buildPending = s.buildPending ? ({ ...s.buildPending } as unknown as SimUnit["buildPending"]) : null;
  u.orderQueue = (s.orderQueue as SimUnit["orderQueue"] | null) ?? [];
  u.pendingCast = s.pendingCastCode ? ({ code: s.pendingCastCode, started: true, fired: false } as unknown as SimUnit["pendingCast"]) : null;
}

function mergeWeapon(base: SimUnit["weapon"], s: UnitSnapshot["weapon"]): SimUnit["weapon"] {
  if (!s) return null;
  if (base) {
    base.damage = s.damage;
    base.dice = s.dice;
    base.sides = s.sides;
    base.range = s.range;
    base.cooldown = s.cooldown;
    base.damagePoint = s.damagePoint;
    base.backswing = s.backswing;
    base.baseDamagePoint = s.baseDamagePoint;
    base.baseBackswing = s.baseBackswing;
    return base;
  }
  return { ...s } as unknown as SimUnit["weapon"];
}

/** What one application did — the renderer (item 2c) grows models over `created` and lets
 *  the existing removal drain retire `removed`'s entries. */
export interface ApplyResult {
  created: UnitSnapshot[];
  removed: number[];
}

/**
 * Write one payload into the record store. Create, update, remove — in that order per
 * category, and removal is computed against the payload's id set so a record is kept iff it
 * was SENT. The maphack invariant this enforces — a client's world holds no record of a unit
 * it was not sent — has its own named check in `tools/sim-apply-test.cjs`.
 *
 * `create` is a callback rather than a constructor import because building a full `SimUnit`
 * takes the unit REGISTRY (defs seed the ~90 sim-internal fields the wire does not carry),
 * and that lives with the controller. A def the registry cannot resolve leaves that unit
 * recordless this frame — same posture as the renderer's drains take (`if (!d) continue`).
 */
export function applyWorldSnapshot(world: ApplyWorld, snap: WorldSnapshot, create: (s: UnitSnapshot) => SimUnit | null): ApplyResult {
  const created: UnitSnapshot[] = [];
  const sent = new Set<number>();
  for (const s of snap.units) {
    sent.add(s.id);
    let u = world.units.get(s.id);
    if (!u) {
      u = create(s) ?? undefined;
      if (!u) continue;
      created.push(s);
    }
    writeUnitSnapshot(u, s);
  }
  const removed: number[] = [];
  for (const id of world.units.keys()) if (!sent.has(id)) removed.push(id);
  for (const id of removed) world.removeUnit(id);

  for (const m of snap.mines) {
    const rec = world.mines.get(m.id);
    if (rec && m.gold >= 0) rec.gold = m.gold; // -1 = no eyes on it: keep the last reading
  }
  // Ground items follow the units' create/remove rule (an item in the dark is ABSENT, not
  // remembered — snapshot.ts). `charges` does not cross: pickup and pawn are host-judged.
  const sentItems = new Set<number>();
  for (const it of snap.items) {
    sentItems.add(it.id);
    const rec = world.items.get(it.id);
    if (rec) {
      rec.x = it.x;
      rec.y = it.y;
    } else {
      world.items.set(it.id, { id: it.id, itemId: it.itemId, x: it.x, y: it.y, charges: 0 });
    }
  }
  for (const id of [...world.items.keys()]) if (!sentItems.has(id)) world.items.delete(id);

  world.timeOfDay = snap.timeOfDay;
  world.dawnDusk = snap.dawnDusk;
  return { created, removed };
}
