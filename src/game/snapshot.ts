import { isOffField, type SimUnit, type SimMine, type SimItem, type BuildJob, type SimBuff, type SimAbility, type HeldItem } from "../sim/world";

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
 * Both are TEAM/OWNERSHIP questions, answered by `seesFor` and a slot comparison.
 *
 * ## The GRID question (item 6), and why it is not a predicate
 *
 * `fogHides` answers *should this be drawn?*. The snapshot asks *may this be sent?*, which is
 * strictly stronger: a client must never RECEIVE what it cannot see, or the fog is a
 * client-side suggestion and we have shipped a maphack.
 *
 * The item predicted a predicate. It is **three-valued**, and the third value is not an
 * embellishment — it is the one case `fogHides` deliberately answers "draw" to. WC3 leaves the
 * last-seen image of an enemy STRUCTURE standing in the fog, so `fogHides` is false for a
 * building you saw an hour ago; but its live hp, its construction progress and its production
 * queue are things you demonstrably do not know. Sending the record whole would leak exactly
 * the intel the fog exists to withhold, and omitting it would delete a building off the
 * player's screen that WC3 keeps there. Neither is right, so `visibilityFor` returns
 * `"live" | "remembered" | "omit"` and `remembered` records are REDACTED to the identity and
 * pose a last-seen image needs.
 *
 * **The reason that redaction needs no per-viewpoint memory is worth stating**, because it
 * looks like it should. A remembered record would in general have to carry where the thing was
 * WHEN IT WAS SEEN, which is per-recipient history the authority would have to keep. It does
 * not here — because the only things WC3 remembers are BUILDINGS, and a building's last-seen
 * position is its current position. The memory case collapses into a field mask. That is the
 * whole of why this fits in one move.
 *
 * The classification falls out of the two predicates the viewpoint already has, and the pairing
 * is not a coincidence: `fogHides` false + `fogBlocksClick` true IS "drawn from memory" — the
 * distinction issue #62 exists for (you can see the Goblin Merchant across the map; you cannot
 * shop at it). So item 6 needed no new fog rule, only the observation that the existing pair
 * already spans three states rather than two.
 */

/** The slice of the world a snapshot is built from. `SimWorld` satisfies it structurally —
 *  both send sites pass the real sim, and `stashOf` is why the narrower `SimView` cannot:
 *  the recipient's own gold/lumber ride in its snapshot (Phase G item 6 — a client's local
 *  stash is otherwise a stale fork: income accrues only on the host, so the two drift and
 *  every affordability question gets two different answers). */
export interface SnapshotWorld {
  readonly units: ReadonlyMap<number, SimUnit>;
  readonly mines: ReadonlyMap<number, SimMine>;
  readonly items: ReadonlyMap<number, SimItem>;
  readonly timeOfDay: number;
  readonly dawnDusk: boolean;
  stashOf(owner: number): { gold: number; lumber: number };
  /** The recipient's researched-upgrade ledger (`TechState.researchedBy`). Optional and
   *  nullable because it is exactly `SimWorld.tech`'s shape: null before registries load,
   *  absent on the hand-built worlds tests pass. The CENSUS half of tech state needs no
   *  lane of its own — it is derived live from the unit records, which already cross. */
  readonly tech?: { researchedBy(player: number): ReadonlyMap<string, number> } | null;
}

/** The per-recipient half. `Viewpoint` satisfies it; a test can pass a five-line stub.
 *  Still narrow: these are the four questions the send rule asks, not a handle on the grid. */
export interface SnapshotViewer {
  /** True for the recipient itself and for every team-mate (`Viewpoint.seesFor`). */
  seesFor(player: number): boolean;
  /** Is this unit's model hidden by fog right now? False for a SEEN building out of sight —
   *  WC3 keeps its image — which is the case that makes the send rule three-valued. */
  fogHides(u: SimUnit): boolean;
  /** Are there eyes on this unit right now? The stricter of the pair: true for that same
   *  remembered building, because the image is a memory rather than sight. */
  fogBlocksClick(u: SimUnit): boolean;
  /** Is this unit invisible to these eyes (undetected)? */
  invisHides(u: SimUnit): boolean;
  /** No eyes on this spot at all — the test for things with their own pick paths, a mine
   *  and a ground item, neither of which is remembered the way a building is. */
  fogBlocksAt(p: { x: number; y: number }): boolean;
}

/** How much of a unit this recipient is entitled to.
 *
 *  • `live` — eyes on it: the whole record.
 *  • `remembered` — a structure seen before and not currently watched. Identity and pose only;
 *    every live value is redacted, because the player's knowledge of them is an hour old.
 *  • `omit` — not in the snapshot at all. Not "sent and ignored": absent. */
export type Visibility = "live" | "remembered" | "omit";

/**
 * What may be sent about `u` to these eyes.
 *
 * Exported because it is the rule, and a rule buried inside the builder is a rule nobody can
 * test at the boundary that matters. The order of the tests is load-bearing and each one is a
 * different reason:
 *
 *  1. **Off the field entirely** (in a mine, inside a building under construction, in a burrow,
 *     swallowed, whisked away by Mirror Image). Gone for everyone — but the OWNER and its
 *     allies still need them, or a burrow could not list its garrison and a mining peasant
 *     would blink out of its owner's own world. So this is a `seesFor` gate, not a drop.
 *  2. **Undetected invisibility.** `fogHides` says nothing about it; the client currently ORs
 *     the two, which is right for drawing and far too weak for sending. A Wind Walking hero's
 *     coordinates must not be in the enemy's payload at all.
 *  3. **Fog.** Then the memory split above.
 */
export function visibilityFor(viewer: SnapshotViewer, u: SimUnit): Visibility {
  if (isOffField(u)) return viewer.seesFor(u.owner) ? "live" : "omit";
  if (viewer.invisHides(u)) return "omit";
  // A NEUTRAL PASSIVE structure — a shop, a tavern, a fountain — is map furniture every
  // player knows from the loading screen: its minimap glyph paints over pitch-black
  // unexplored ground in the real 1.27a client (minimapView.minimapIcons), so the identity
  // and pose a remembered image carries were never secrets. It is therefore sent as
  // REMEMBERED even where fog would omit a player's building — which is also what keeps a
  // frozen client's copy of the map furniture standing instead of letting the applier
  // delete it (records, models, glyphs and splats all hang off the record). Its DESTRUCTION
  // is still learned by discovery: the ghost path keeps the image for every viewer that was
  // not watching, and only re-scouting the spot clears it (GhostMemory.forgetSeen).
  if (viewer.fogHides(u)) return u.neutralPassive && u.building != null ? "remembered" : "omit";
  return viewer.fogBlocksClick(u) ? "remembered" : "live";
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

/** One shop ware's shelf state, as the card draws it: `count` greys the button, `timer`/
 *  `period` drive the restock cooldown sweep, `kind` files the ware on the right half of the
 *  card (`shopWaresOf`), and `max` is the shelf ceiling. `regen` stays behind — it is how the
 *  host winds the timer, not something the client draws.
 *
 *  `timer`/`period` are `Infinity` in the sim for a ware that never restocks — but this
 *  payload is JSON, and `JSON.stringify(Infinity)` is `null`. They cross as **-1** and the
 *  applier decodes back; encode/decode live beside the two types so they cannot drift. */
export interface StockSnapshot {
  id: string;
  count: number;
  max: number;
  timer: number;
  period: number;
  kind: "item" | "unit";
}

export const encodeStockTime = (t: number): number => (Number.isFinite(t) ? t : -1);
export const decodeStockTime = (t: number): number => (t < 0 ? Infinity : t);

/** Construction progress and the production queue. `builderIds` and the speed-build costs
 *  stay behind — they are how the sim charges for a build. */
export interface BuildingSnapshot {
  constructionLeft: number;
  buildTimeTotal: number;
  queue: BuildJob[];
  producesUnits: boolean;
  rallyX: number;
  rallyY: number;
  rallyKind: string;
  rallyTargetId: number;
  /** The shop shelf, for buildings this recipient may SHOP AT — a neutral shop, its own or
   *  an ally's (WC3 never shows an enemy shop's wares; you cannot even open its card, so an
   *  enemy Vault's shelf crossing the wire would be intel the game itself withholds). Null
   *  for everything else. This used to "stay behind" on the theory that `shopStock` answered
   *  from the read window — true only where the sim steps; a frozen client's shelves never
   *  restocked and never felt anybody else's purchases. */
  stock: StockSnapshot[] | null;
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
  /** This record is a last-seen IMAGE, not sight (`visibilityFor` → `"remembered"`). Every
   *  live value below it is redacted to a zero, so a client must not read them — and the
   *  renderer already knows not to: it cannot be clicked (`fogBlocksClick`) and it draws
   *  dimmed (`showsFromMemory`), which is the same fact arriving as data instead of as a
   *  second derivation of the grid. */
  remembered: boolean;

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
  /** Whether this worker is hammering. Kept as an OBJECT rather than the flat `repairing`
   *  boolean it was until item 10c-2b: the renderer's animation picker is typed against
   *  `RenderUnit`, which `SimUnit` must satisfy too, and the sim's field is
   *  `repair: RepairState | null`. The derived shape moves so the two can share one type —
   *  flattening here would have cost an adapter allocation per unit per frame on the host,
   *  which is the path that has to stay free. The rest of `RepairState` (the target, the
   *  rates, the costs) is how the sim charges for a repair and stays behind. */
  repair: { active: boolean } | null;

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
  /** Gold remaining, or **-1 when this recipient has no eyes on the mine**. Not 0: an empty
   *  mine and an unscouted one are different facts, and a client that conflated them would
   *  route workers away from a full expansion. */
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
  /** The RECIPIENT's own gold and lumber — the authority's figures, which are the only real
   *  ones: income (mining, pawning) happens only where the sim steps, so a client that kept
   *  its own ledger watched it drift from the truth with every trip a peon made. The drift
   *  was not cosmetic: the client's authority pre-judges every purchase against its local
   *  stash, so a figure lower than the host's refused trains the player could afford, and a
   *  figure higher let a train charge locally, be refused by the host, and look "instantly
   *  canceled" when the next snapshot wiped the queue (the July playtest bug). Nobody else's
   *  stash is ever sent — an opponent's bank balance is scouting information. */
  stash: { gold: number; lumber: number };
  /** The RECIPIENT's researched upgrades (`upgradeId → level`). Same lane and same reasoning
   *  as `stash`: research completes only where the sim steps, so a client's own `TechState`
   *  ledger sat at zero forever — its card offered Iron Forged Swords after Steel was in, a
   *  `rtma` swap (Berserker) never swapped, and every requirement gate answered from a stale
   *  world. Only the recipient's own — an enemy's research is scouting information. The
   *  census half (which buildings satisfy what) is derived from unit records and needs no
   *  lane. */
  research: Record<string, number>;
  /** Creep-camp difficulty markers, as THIS recipient's minimap should paint them — computed
   *  on the authority with the same `CreepCamps.markers(viewpoint)` rule the host's own map
   *  uses (map-public at match start, yields to a visible member, gone once cleared). Carried
   *  rather than re-derived because the client's record store holds only what it was sent:
   *  the creeps behind the markers are exactly the units the payload omits. */
  creepCamps: Array<{ x: number; y: number; level: number }>;
  units: UnitSnapshot[];
  mines: MineSnapshot[];
  items: GroundItemSnapshot[];
  /**
   * How many commands the world this was built from has applied (docs/multiplayer.md F5).
   *
   * Carried so a client can tell whether comparing this against its own sim means anything.
   * A client keeps simulating (sequencing B) but is fed only its OWN input — it never sees
   * another player's commands — so once either side has applied one, the two worlds are
   * running different matches and every difference between them is explained by that. Zero on
   * both sides is the only state in which a difference is a bug rather than an input.
   */
  commands: number;
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
 * A last-seen image: what the player is entitled to remember about a structure nobody is
 * currently looking at.
 *
 * Everything here is either immutable for the life of the building (id, owner, team, type,
 * race) or the pose of something that cannot move — which is why this needs no history. What
 * is redacted is everything that CHANGES while you are not watching: hp, mana, the
 * construction timer, the production queue, the rally point, buffs, abilities, garrison,
 * upgrades in progress. A player who could read those through the fog would know an enemy
 * expansion was being repaired, or that a Keep upgrade was 3 seconds out.
 *
 * `building` is a fixed non-null stub rather than the real one: the renderer keys "is this a
 * structure" (health-bar suppression, minimap glyph, selection-ring size) off its presence, so
 * dropping it would change the drawn shape of the memory, while passing the live one is the
 * leak. `altModel` is carried because it is which HALF of the model is showing — a rooted
 * Ancient looks different from a walking one, and you saw which.
 *
 * **Known gap, and it is pre-existing rather than introduced here.** A remembered building that
 * has since been DESTROYED simply stops appearing, because it is no longer in `world.units` to
 * be classified. WC3 keeps the ghost image until you re-see the spot. The client has the same
 * hole today for the same reason (`fogHides` reads live units), so this is not a regression —
 * but it is now a hole in a payload rather than in a render loop, which is a better place to
 * fix it from. Recorded as item 6b.
 */
export function rememberedUnit(u: SimUnit): UnitSnapshot {
  return {
    id: u.id,
    owner: u.owner,
    team: u.team,
    typeId: u.typeId,
    race: u.race,
    neutralPassive: u.neutralPassive,
    isHero: u.isHero,
    properName: "",
    isCreep: u.isCreep,
    remembered: true,

    x: u.x,
    y: u.y,
    facing: u.facing,
    flyHeight: u.flyHeight,
    speed: 0,
    radius: u.radius,
    flying: u.flying,
    order: "idle",
    moving: false,
    inCombat: false,
    working: false,
    swingSeq: 0,
    chopSeq: 0,
    swingBroken: false,
    swingSlam: false,
    altModel: u.altModel,
    spawning: 0,
    constructing: 0,
    repair: null,

    inMine: false,
    insideBuild: false,
    inBurrow: false,
    devouredBy: 0,
    vanished: false,
    invisible: false,
    ethereal: false,

    hp: 0,
    maxHp: 0,
    mana: 0,
    maxMana: 0,
    armor: 0,
    bonusArmor: 0,
    bonusDamage: 0,
    invulnerable: false,
    weapon: null,
    swingWeapon: null,

    level: 0,
    xp: 0,
    skillPoints: 0,
    str: 0,
    agi: 0,
    int: 0,
    bonusStr: 0,
    bonusAgi: 0,
    bonusInt: 0,

    worker: null,
    building: { constructionLeft: 0, buildTimeTotal: 0, queue: [], producesUnits: false, rallyX: 0, rallyY: 0, rallyKind: "point", rallyTargetId: 0, stock: null },
    abilities: [],
    buffs: [],
    inventory: [],
    garrison: [],
    garrisonCap: 0,

    isSummon: false,
    summonLeft: 0,
    summonMax: 0,
    isIllusion: false,
    illusionOf: 0,

    guardX: 0,
    guardY: 0,

    buildPending: null,
    orderQueue: null,
    pendingCastCode: null,
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
 *
 * `ghosts` are the buildings this recipient still believes are standing — structures that have
 * left the world while nobody of theirs was looking (`GhostMemory`, item 6b). They are appended
 * rather than merged: by construction they are not in `world.units` any more, so there is
 * nothing to merge them with, and a ghost whose id somehow IS live would be a bug in the
 * memory rather than something to paper over here.
 */
export function snapshotFor(
  world: SnapshotWorld,
  viewer: SnapshotViewer,
  recipient: number,
  time: number,
  ghosts: readonly UnitSnapshot[] = [],
  /** `Authority.applied` for the world being snapshotted. Defaults to 0, which is the honest
   *  answer for a synthetic world nobody has commanded — every test builds one of those. */
  commands = 0,
  /** This recipient's creep-camp markers (`CreepCamps.markers(viewpoint)` on the host).
   *  Defaults empty — a hand-built test world has no camps to mark. */
  creepCamps: Array<{ x: number; y: number; level: number }> = [],
): WorldSnapshot {
  const units: UnitSnapshot[] = [...ghosts];
  for (const u of world.units.values()) {
    const vis = visibilityFor(viewer, u);
    if (vis === "omit") continue;
    if (vis === "remembered") {
      units.push(rememberedUnit(u));
      continue;
    }
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
      remembered: false,

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
      repair: u.repair ? { active: u.repair.active } : null,

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
            // The shelf crosses only for shops this recipient may shop at (see the field):
            // `seesFor` is the ally gate — the same one Aall "Shop Sharing" draws in game.
            stock:
              u.building.stock && (u.neutralPassive || viewer.seesFor(u.owner))
                ? [...u.building.stock].map(([id, st]) => ({ id, count: st.count, max: st.max, timer: encodeStockTime(st.timer), period: encodeStockTime(st.period), kind: st.kind }))
                : null,
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

  // Mines are always SENT and their gold is not. A gold mine is map-placement furniture: its
  // position is public knowledge from tick 0 — `minimapIcons` paints its glyph over unexplored
  // ground deliberately, measured against the real 1.27a client (item 4) — so omitting it would
  // put a hole in the minimap the real game does not have. How much gold is LEFT in it is the
  // opposite: it is the single most valuable scouting fact on the map, and a player with no
  // eyes on a mine does not know whether it is full or nearly dry.
  const mines: MineSnapshot[] = [];
  for (const m of world.mines.values()) {
    const seen = !viewer.fogBlocksAt(m);
    mines.push({ id: m.id, x: m.x, y: m.y, radius: m.radius, gold: seen ? m.gold : -1 });
  }

  // Ground items are the strict case and get no memory at all. `fogBlocksAt`'s own comment
  // says why: an item is a live widget that vanishes with the eyes on it, not a building whose
  // image persists. So an item in the dark is absent, not remembered.
  const items: GroundItemSnapshot[] = [];
  for (const it of world.items.values()) {
    if (viewer.fogBlocksAt(it)) continue;
    items.push({ id: it.id, itemId: it.itemId, x: it.x, y: it.y });
  }

  // Copied, not referenced: the payload must be a frozen reading, not a live handle the
  // sim keeps mutating while the message waits to serialize.
  const stash = world.stashOf(recipient);
  const research = Object.fromEntries(world.tech?.researchedBy(recipient) ?? []);
  return { recipient, time, timeOfDay: world.timeOfDay, dawnDusk: world.dawnDusk, stash: { gold: stash.gold, lumber: stash.lumber }, research, creepCamps, units, mines, items, commands };
}
