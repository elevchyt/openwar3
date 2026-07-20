import type { SimUnit, SimMine, SimItem, BuildJob, SimBuff, SimAbility, HeldItem } from "../sim/world";

/**
 * What one client is TOLD about the world (docs/multiplayer.md Phase E item 5).
 *
 * A client that does not simulate still has to draw a frame, fill the selection panel and
 * light the right command-card button. This module is the answer to "what exactly does that
 * take", and it is a SUBSET rather than a serialisation of `SimUnit`: the struct carries ~150
 * fields and the client half reads about 60 of them. The rest — every pathing scratch value,
 * every stuck/stall timer, every `base*` baseline `recomputeStats` derives from — is how the
 * sim reaches its answers, not the answers, and putting it on the wire would ship a client the
 * means to second-guess the authority.
 *
 * The field set was not guessed. It was read off the consumers (`rts.ts`'s entry sync,
 * `infoFor` and the health bars, `mapViewer.ts`'s command card and effects, `minimapView.ts`,
 * `viewpoint.ts`), which is the same discipline that kept being right in items 1c–1h: classify
 * by what the readers read, not by what the field is called.
 *
 * **This file imports no transport and no renderer**, and it must not grow either. It is the
 * authority's answer; who carries it is item 8's question and encoding is item 10's. The
 * payload is plain JSON-shaped data by decision (Open questions — "JSON first, binary when it
 * hurts"), which is why every member here is a primitive, an array or a plain object.
 *
 * ## What is per-recipient here, and what is not yet
 *
 * `snapshotFor` takes a recipient because two whole classes of field are ALREADY answerable
 * "…for whom?" without any reference to fog:
 *
 *   • **The illusion mask.** `docs/illusions.md` is explicit that to an enemy an illusion
 *     reports as an ordinary unit, and the client today gets that right by reading `isIllusion`
 *     and then throwing it away (`rts.ts` `applyFogTint`, `infoFor`). That is the correct
 *     BEHAVIOUR and the wrong ARCHITECTURE: a filter applied after the bit crossed the wire is
 *     a filter a modified client deletes. Here the bit never leaves — an enemy's snapshot
 *     carries `isIllusion: false`, `illusionOf: 0`, and the summon timer zeroed, because a
 *     ticking summon bar is itself the tell.
 *   • **Private intent.** `buildPending`, `orderQueue` and `pendingCast` are what a player is
 *     ABOUT to do. Every client read site is already owner-gated, so nothing changes on screen
 *     — but "where my opponent is about to drop a tower" is the strongest intel in the game and
 *     it has no business being sent at all.
 *
 * Both are TEAM/OWNERSHIP questions, answered by `seesFor` and a slot comparison. The GRID
 * question — may this unit be sent at all, given where the recipient's fog is — is deliberately
 * NOT here. That is item 6, it is a different predicate from `fogHides` (which only answers
 * "draw?"), and conflating the two is the trap that ships a maphack. Until item 6 lands, a
 * snapshot describes the whole world: it is not yet safe to send to an opponent, and nothing
 * sends it.
 */

/** The slice of the world a snapshot is built from. `SimView` satisfies it structurally, so
 *  the authority hands over the read-only window it already has rather than the world. */
export interface SnapshotWorld {
  readonly units: ReadonlyMap<number, SimUnit>;
  readonly mines: ReadonlyMap<number, SimMine>;
  readonly items: ReadonlyMap<number, SimItem>;
  readonly timeOfDay: number;
  readonly dawnDusk: boolean;
}

/** The per-recipient half. `Viewpoint` satisfies it; a test can pass a two-line stub.
 *  Narrow on purpose — a snapshot must not become a second handle on the fog grid, which is
 *  what item 6 will widen this with, deliberately and visibly. */
export interface SnapshotViewer {
  /** True for the recipient itself and for every team-mate (`Viewpoint.seesFor`). */
  seesFor(player: number): boolean;
}

/** A weapon, as the client reads it: the HUD's damage figures plus the two ratios
 *  `attackAnimRate` recovers the attack-speed factor from. */
export interface WeaponSnapshot {
  damage: number;
  dice: number;
  sides: number;
  range: number;
  cooldown: number;
  damagePoint: number;
  backswing: number;
  baseDamagePoint: number;
  baseBackswing: number;
}

/** Harvest load. The capacities and chop rates stay behind — the client draws the carry
 *  animation and the "Gold: 10" line, and neither needs to know how fast the trip refills. */
export interface WorkerSnapshot {
  gold: boolean;
  lumber: boolean;
  carryGold: number;
  carryLumber: number;
}

/** Construction progress and the production queue. `builderIds`, the speed-build costs and
 *  the shop `stock` map stay behind: stock reaches the client through `shopStock` on the
 *  read window, and the rest is how the sim charges for a build. */
export interface BuildingSnapshot {
  constructionLeft: number;
  buildTimeTotal: number;
  queue: BuildJob[];
  producesUnits: boolean;
  rallyX: number;
  rallyY: number;
  rallyKind: string;
  rallyTargetId: number;
}

/** One unit, as a client that did not simulate it needs it. */
export interface UnitSnapshot {
  // --- identity -------------------------------------------------------------
  id: number;
  owner: number;
  team: number;
  typeId: string;
  race: string;
  neutralPassive: boolean;
  isHero: boolean;
  properName: string;
  isCreep: boolean;

  // --- pose and animation ---------------------------------------------------
  x: number;
  y: number;
  facing: number;
  flyHeight: number;
  speed: number;
  radius: number;
  flying: boolean;
  order: string;
  moving: boolean;
  inCombat: boolean;
  working: boolean;
  /** Swing/chop counters. They are sent as the plain running totals they are: the renderer
   *  re-triggers a clip when the number CHANGES, so a client that missed a snapshot re-syncs
   *  on the next one instead of replaying a swing it already drew. */
  swingSeq: number;
  chopSeq: number;
  swingBroken: boolean;
  swingSlam: boolean;
  altModel: boolean;
  spawning: number;
  constructing: number;
  repairing: boolean;

  // --- hidden / faded (viewpoint-independent: gone for EVERYONE) -------------
  inMine: boolean;
  insideBuild: boolean;
  inBurrow: boolean;
  devouredBy: number;
  vanished: boolean;
  invisible: boolean;
  ethereal: boolean;

  // --- the numbers the selection panel and health bars show -----------------
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  armor: number;
  bonusArmor: number;
  bonusDamage: number;
  invulnerable: boolean;
  weapon: WeaponSnapshot | null;
  swingWeapon: WeaponSnapshot | null;

  // --- hero ------------------------------------------------------------------
  level: number;
  xp: number;
  skillPoints: number;
  str: number;
  agi: number;
  int: number;
  bonusStr: number;
  bonusAgi: number;
  bonusInt: number;

  // --- composites ------------------------------------------------------------
  worker: WorkerSnapshot | null;
  building: BuildingSnapshot | null;
  abilities: SimAbility[];
  buffs: SimBuff[];
  inventory: (HeldItem | null)[];
  garrison: number[];
  garrisonCap: number;

  // --- summons and illusions (MASKED — see the header) ----------------------
  isSummon: boolean;
  summonLeft: number;
  summonMax: number;
  isIllusion: boolean;
  illusionOf: number;

  // --- creep guard, for the minimap's camp markers ---------------------------
  guardX: number;
  guardY: number;

  // --- private intent: present ONLY on the recipient's own units -------------
  buildPending: { defId: string; x: number; y: number } | null;
  orderQueue: unknown[] | null;
  pendingCastCode: string | null;
}

export interface MineSnapshot {
  id: number;
  x: number;
  y: number;
  radius: number;
  gold: number;
}

export interface GroundItemSnapshot {
  id: number;
  itemId: string;
  x: number;
  y: number;
}

/** One frame of world, addressed to one player. */
export interface WorldSnapshot {
  /** Who this was built for. Carried in the payload rather than inferred from the connection,
   *  so a mis-routed snapshot is a thing a client can NOTICE rather than silently render. */
  recipient: number;
  /** The authority's game clock at the moment it was built (seconds). Ordering and
   *  interpolation both need it; a client that receives an older one drops it. */
  time: number;
  timeOfDay: number;
  dawnDusk: boolean;
  units: UnitSnapshot[];
  mines: MineSnapshot[];
  items: GroundItemSnapshot[];
}

function weaponOf(w: SimUnit["weapon"]): WeaponSnapshot | null {
  if (!w) return null;
  return {
    damage: w.damage,
    dice: w.dice,
    sides: w.sides,
    range: w.range,
    cooldown: w.cooldown,
    damagePoint: w.damagePoint,
    backswing: w.backswing,
    baseDamagePoint: w.baseDamagePoint,
    baseBackswing: w.baseBackswing,
  };
}

/**
 * Build `player`'s view of the world.
 *
 * `own` (the recipient's own units) and `friendly` (`seesFor` — itself plus team-mates) are two
 * different gates and both are used: private intent is `own`, the illusion tell is `friendly`.
 * That difference is the reason this takes a viewer AND a recipient rather than deriving one
 * from the other — an ally may not see where you are about to build, but an ally must be able
 * to tell your illusions from you, or Mirror Image would fool your own team.
 */
export function snapshotFor(
  world: SnapshotWorld,
  viewer: SnapshotViewer,
  recipient: number,
  time: number,
): WorldSnapshot {
  const units: UnitSnapshot[] = [];
  for (const u of world.units.values()) {
    const own = u.owner === recipient;
    // The illusion tell, resolved HERE rather than on arrival. `seesFor` and not `own`
    // deliberately: docs/illusions.md gates the tells on the viewpoint, and a team-mate is
    // inside that viewpoint.
    const knowsIllusion = u.isIllusion && viewer.seesFor(u.owner);
    // A summon timer on an illusion IS a tell — an enemy must see an ordinary unit with no
    // expiry — so the whole summon triple is masked with it, not just the flag.
    const showSummon = u.isSummon && (!u.isIllusion || knowsIllusion);
    units.push({
      id: u.id,
      owner: u.owner,
      team: u.team,
      typeId: u.typeId,
      race: u.race,
      neutralPassive: u.neutralPassive,
      isHero: u.isHero,
      properName: u.properName,
      isCreep: u.isCreep,

      x: u.x,
      y: u.y,
      facing: u.facing,
      flyHeight: u.flyHeight,
      speed: u.speed,
      radius: u.radius,
      flying: u.flying,
      order: u.order,
      moving: u.moving,
      inCombat: u.inCombat,
      working: u.working,
      swingSeq: u.swingSeq,
      chopSeq: u.chopSeq,
      swingBroken: u.swingBroken,
      swingSlam: u.swingSlam,
      altModel: u.altModel,
      spawning: u.spawning,
      constructing: u.constructing,
      repairing: u.repair?.active ?? false,

      inMine: u.inMine,
      insideBuild: u.insideBuild,
      inBurrow: u.inBurrow,
      devouredBy: u.devouredBy,
      vanished: u.vanished,
      invisible: u.invisible,
      ethereal: u.ethereal,

      hp: u.hp,
      maxHp: u.maxHp,
      mana: u.mana,
      maxMana: u.maxMana,
      armor: u.armor,
      bonusArmor: u.bonusArmor,
      bonusDamage: u.bonusDamage,
      invulnerable: u.invulnerable,
      weapon: weaponOf(u.weapon),
      swingWeapon: weaponOf(u.swingWeapon),

      level: u.level,
      xp: u.xp,
      skillPoints: u.skillPoints,
      str: u.str,
      agi: u.agi,
      int: u.int,
      bonusStr: u.bonusStr,
      bonusAgi: u.bonusAgi,
      bonusInt: u.bonusInt,

      worker: u.worker
        ? {
            gold: u.worker.gold,
            lumber: u.worker.lumber,
            carryGold: u.worker.carryGold,
            carryLumber: u.worker.carryLumber,
          }
        : null,
      building: u.building
        ? {
            constructionLeft: u.building.constructionLeft,
            buildTimeTotal: u.building.buildTimeTotal,
            queue: u.building.queue,
            producesUnits: u.building.producesUnits,
            rallyX: u.building.rallyX,
            rallyY: u.building.rallyY,
            rallyKind: u.building.rallyKind,
            rallyTargetId: u.building.rallyTargetId,
          }
        : null,
      abilities: u.abilities,
      buffs: u.buffs,
      inventory: u.inventory,
      garrison: u.garrison,
      garrisonCap: u.garrisonCap,

      isSummon: showSummon,
      summonLeft: showSummon ? u.summonLeft : 0,
      summonMax: showSummon ? u.summonMax : 0,
      isIllusion: knowsIllusion,
      illusionOf: knowsIllusion ? u.illusionOf : 0,

      guardX: u.guardX,
      guardY: u.guardY,

      buildPending: own && u.buildPending ? { defId: u.buildPending.defId, x: u.buildPending.x, y: u.buildPending.y } : null,
      orderQueue: own ? u.orderQueue : null,
      pendingCastCode: own ? (u.pendingCast?.code ?? null) : null,
    });
  }

  const mines: MineSnapshot[] = [];
  for (const m of world.mines.values()) mines.push({ id: m.id, x: m.x, y: m.y, radius: m.radius, gold: m.gold });

  const items: GroundItemSnapshot[] = [];
  for (const it of world.items.values()) items.push({ id: it.id, itemId: it.itemId, x: it.x, y: it.y });

  return { recipient, time, timeOfDay: world.timeOfDay, dawnDusk: world.dawnDusk, units, mines, items };
}
