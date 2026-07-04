import { PATHING_CELL, footprintCells, type PathingGrid } from "./pathing";
import { findPath } from "./pathfind";
import { type AbilityRegistry, type AbilityDef, type AbilityLevel, requiredHeroLevel } from "../data/abilities";
import { SPELL_HANDLERS, AURA_BUFFS, type SpellApi, type SimBuffInit, type SpellFieldInit } from "./spells";

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
  attackType: string; // UnitWeapons atkType1 (normal/pierce/siege/magic/chaos/hero) → damage table
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
  attackType?: string; // attacker's weapon attack type, carried so the damage-table
  // multiplier is correct even if the attacker dies before the arrow lands
  // Spell projectiles (Storm Bolt, Death Coil) run an ability effect on impact
  // instead of dealing plain `damage` — the base code + rank to dispatch.
  spell?: { code: string; rank: number; abilityId: string };
}

export type SimOrder = "idle" | "move" | "attackmove" | "patrol" | "attack" | "follow" | "harvest" | "return" | "repair" | "cast";

/** A learned/innate ability on a unit. `code` is the base ability code (dispatch
 *  key — see data/abilities). `level` 0 = a hero ability not yet learned. */
export interface SimAbility {
  id: string; // alias (for tooltip/icon lookup in the registry)
  code: string; // base ability code — spell dispatch key
  level: number; // current rank (0 = unlearned hero ability, ≥1 = active)
  cooldownLeft: number; // seconds until castable again
  autocastOn: boolean; // autocast toggle (Heal/Slow/…)
}

/** A timed effect on a unit. `kind` is our gameplay category; `group` de-dupes
 *  non-stacking sources (e.g. two Devotion Auras → one armour buff, the larger). */
export interface SimBuff {
  kind: BuffKind;
  group: string; // non-stacking key ("" = always its own instance)
  timeLeft: number; // seconds (Infinity for auras, refreshed while in range)
  sourceId: number;
  value: number; // primary magnitude (armour, slow %, hp/sec, damage, …)
  value2: number; // secondary magnitude (e.g. attack-speed slow)
  art: string; // attached effect model (renderer), "" = none
}

export type BuffKind =
  | "stun" // cannot act
  | "slow" // value = move-slow fraction, value2 = attack-slow fraction
  | "haste" // value = move bonus fraction, value2 = attack-speed bonus fraction
  | "invuln" // immune to damage + enemy targeting (Divine Shield)
  | "armor" // value = flat armour bonus (Devotion Aura, Inner Fire)
  | "manaRegen" // value = flat mana/sec bonus (Brilliance Aura)
  | "damage" // value = flat attack-damage bonus (Inner Fire)
  | "damagePct" // value = fraction of base damage added (Command/Trueshot Aura)
  | "hpRegen" // value = flat hp/sec bonus (Unholy Aura)
  | "lifesteal" // value = fraction of melee damage dealt healed back (Vampiric Aura)
  | "thorns" // value = fraction of melee damage returned to the attacker (Thorns Aura)
  | "hot" // value = hp/sec healed
  | "dot" // value = dps taken
  | "sleep" // cannot act (like stun) but wakes the instant it takes damage (Sleep)
  | "silence" // cannot cast spells (Silence, Soul Burn) — can still move & attack
  | "manaShield" // absorb incoming damage into mana instead of hp; value = mana spent per hp
  | "root"; // value = move-slow fraction (Entangling Roots pins to 1.0); can still attack

/** An in-progress spell cast (order === "cast"). Walk into range, face, then at
 *  the cast point fire the effect (or launch the spell missile). */
export interface PendingCast {
  code: string; // base ability code (dispatch)
  abilityId: string; // the SimAbility on the caster (for cooldown/mana)
  rank: number; // ability level being cast
  targetId: number; // unit target (0 = none)
  x: number; // point target
  y: number;
  range: number; // cast range (hull-to-hull); 0 = self/no-target
  castLeft: number; // remaining cast point before the effect fires (-1 = not yet started)
  started: boolean; // cast point begun (mana spent, animation playing)
  fired: boolean; // the effect has fired (for channelled spells that then hold)
  channelLeft: number; // remaining channel time — the caster stands + holds (Blizzard)
  // The order to resume after the cast (so an autocast/manual cast mid attack-move
  // or follow continues afterward instead of falling idle).
  resume: { kind: "attackmove"; x: number; y: number } | { kind: "follow"; id: number } | null;
}

/** A corpse left by a dead unit (Liquipedia: Corpse). Persists on the ground,
 *  decaying flesh→bone, and is a targetable entity for corpse-consuming spells
 *  (Raise Dead, Cannibalize, Resurrection, Meat Wagon). */
export interface SimCorpse {
  id: number;
  deadId: number; // the dead unit's sim id (renderer adopts its model as the corpse)
  unitId: string; // the dead unit's type (renderer reuses/re-spawns its model)
  x: number;
  y: number;
  facing: number;
  owner: number;
  isHero: boolean; // hero corpses can't be raised (they revive at an altar instead)
  mechanical: boolean; // mechanical/summoned units leave no raisable corpse
  decayLeft: number; // seconds until the corpse fully decays and is removed
  raised: boolean; // consumed by a spell (renderer hides it immediately)
}

/** Attributes + growth for a hero, applied on spawn and each level-up. */
export interface HeroInit {
  level: number;
  str: number;
  agi: number;
  int: number;
  strPerLevel: number;
  agiPerLevel: number;
  intPerLevel: number;
  primaryAttr: "STR" | "AGI" | "INT" | "";
}

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
  | { kind: "attack"; targetId: number; force?: boolean }
  // offX/offY: optional formation offset from the leader's centre, so a group told
  // to follow one unit fans into distinct slots instead of stacking on its centre.
  | { kind: "follow"; targetId: number; offX?: number; offY?: number }
  // ax/ay: optional distinct approach point around the node, so a group ordered
  // together fans over the mine's rim instead of all pathing to its centre.
  | { kind: "harvest"; res: "gold" | "lumber"; nodeId: number; ax?: number; ay?: number }
  | { kind: "buildnew"; defId: string; x: number; y: number; gold: number; lumber: number }
  // ax/ay: as above, a distinct spot around the building's footprint to spread builders.
  | { kind: "buildresume"; buildingId: number; ax?: number; ay?: number }
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
  race: string; // human|orc|undead|nightelf|… — for spell polarity (Holy Light vs undead)
  typeId: string; // unit-def id (for corpses/Resurrection to re-create the unit)
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
  armorType: string; // UnitBalance defType (none/small/medium/large/fort/hero/divine) → damage table
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
  chopSeq: number; // increments each lumber chop (renderer re-triggers the chop clip in sync)
  inCombat: boolean; // engaging in range this tick (drives the attack animation)
  path: Array<[number, number]>; // world waypoints
  waypoint: number;
  moving: boolean;
  chaseX: number; // where the current chase path was aimed (repath when stale)
  chaseY: number;
  // Follow-formation offset from the leader's centre (0,0 = a lone follower that
  // just trails). A group told to follow one unit is fanned into distinct slots
  // so they hold a spread instead of stacking on the leader's centre and shoving.
  followOffX: number;
  followOffY: number;
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
  yieldT: number; // seconds paused giving way to another unit (breaks head-on "dancing")
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
  // --- hero / abilities / buffs (spells slice) ---
  isHero: boolean;
  level: number; // hero level (0 for non-heroes)
  xp: number; // hero experience
  skillPoints: number; // unspent skill points (1 gained per level)
  primaryAttr: "STR" | "AGI" | "INT" | "";
  baseStr: number; // level-1 attributes (growth is added per level)
  baseAgi: number;
  baseInt: number;
  strPerLevel: number;
  agiPerLevel: number;
  intPerLevel: number;
  str: number; // current (floored) attributes, recomputed on level-up
  agi: number;
  int: number;
  baseMaxHp: number; // level-1 maxHp — attribute growth is layered on top
  baseMaxMana: number;
  baseArmor: number; // armour before agility growth + buffs
  baseDamage: number; // weapon base damage before primary-attr growth + buffs
  baseSpeed: number; // move speed before slow/haste
  baseCooldown: number; // weapon cooldown before haste/slow
  manaRegen: number; // mana per second (recomputed from INT + buffs)
  hpRegen: number; // hp per second
  lifesteal: number; // fraction of melee damage healed back (Vampiric Aura); derived
  thorns: number; // fraction of melee damage returned to attackers (Thorns Aura); derived
  bonusArmor: number; // buff/aura portion of armour (green "+N" in the HUD); derived
  bonusDamage: number; // buff/aura portion of attack damage (green "+N"); derived
  abilities: SimAbility[]; // learned/innate abilities
  buffs: SimBuff[]; // active timed effects
  stunned: boolean; // derived from buffs (cannot act)
  silenced: boolean; // derived from buffs (cannot cast spells)
  invulnerable: boolean; // derived from buffs (immune to damage + enemy targeting)
  mechanical: boolean; // machines/summons — no raisable corpse, unhealable by Heal
  isSummon: boolean; // a summoned unit (Water Elemental) — leaves no corpse, ×0.5 XP
  spawning: number; // >0: materializing (playing its birth clip) — cannot act yet
  summonLeft: number; // >0: a temporary summon that expires (Water Elemental); else 0
  summonMax: number; // the summon's full duration (for the "Summoned Unit" bar fill)
  pendingCast: PendingCast | null; // in-progress cast (order === "cast")
  // --- neutral-hostile creep guard AI (see the CREEP_* constants) -----------
  isCreep: boolean; // a map-placed Neutral Hostile creep with guard/leash behaviour
  guardX: number; // guard ("home") position — where it was placed; it leashes back here
  guardY: number;
  guardFacing: number; // facing to restore once it has returned home
  aggroRange: number; // acquisition range (per-placed targetAcquisition, else the weapon's)
  canSleep: boolean; // sleeps at night when guarding at home (UnitData `cansleep`)
  asleep: boolean; // currently asleep (won't auto-acquire; wakes on damage/proximity/camp)
  returning: boolean; // leashing back to the guard point (ignores enemies until home)
  strayT: number; // seconds chasing past GUARD_DISTANCE without being attacked (→ return)
  returnBestDist: number; // closest-to-home distance reached this return (stuck detection)
  returnStuckT: number; // seconds making no homeward progress while returning (→ give up, fight)
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
const FOLLOW_GAP = 64; // edge-to-edge distance a follower keeps behind its leader
// Hysteresis for follow (mirrors ATTACK_LEASH): once caught up and parked, the
// leader must drift this much FURTHER than FOLLOW_GAP before the follower gives
// chase again — without it the follower flip-flops chase↔settle at the gap edge
// every tick (settle() snaps it to the grid, nudging the gap back over the line),
// which flickers the walk↔stand clip and visibly jiggles the model.
const FOLLOW_LEASH = 48;
const FOLLOW_SLOT_ARRIVE = 24; // how close a fanned follower parks to its formation slot
const ACQUIRE_PERIOD = 0.5; // seconds between idle auto-acquire scans
const STUCK_TIME = 0.5; // seconds of blocked movement before a unit gives up
const STUCK_RATIO = 0.3; // "blocked" = actual displacement below this share of expected
// When two units meet head-on, the lower-priority one pauses for YIELD_TIME so the
// other can clear — this breaks the symmetric "dance" (both endlessly sidestepping
// into the tile the other just vacated) instead of letting it churn for seconds.
const YIELD_TIME = 0.2;
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

// --- hero XP / leveling (docs/REFERENCES.md — Liquipedia Experience + warcraft3.info) ---
const MAX_HERO_LEVEL = 10;
// XP a hero KILL grants, indexed by the victim's level (1-based): 25/40/60/85/…
// = xp[L-1] + 5·(L+1). Buildings/level-0 grant none.
const KILL_XP = [0, 25, 40, 60, 85, 115, 150, 190, 235, 285, 340];
// Creeps grant reduced XP by the killing hero's level (index = hero level).
const CREEP_XP_FACTOR = [0.8, 0.8, 0.7, 0.6, 0.5, 0, 0, 0, 0, 0, 0];
const XP_SHARE_RANGE = 1200; // heroes within this of a kill share its XP (else global)
const SUMMON_XP_FACTOR = 0.5; // summoned victims grant half XP
// WC3 (TFT 1.27a) attack-type vs armor-type damage multiplier table. Source: the
// official classic Battle.net basics page, "Armor and Weapon Types" (the Frozen
// Throne chart) — https://classic.battle.net/war3/basics/armorandweapontypes.shtml
// — cross-checked against Liquipedia. NB the classic TFT values differ from
// Reforged 2.x (e.g. Pierce vs Heavy is 1.0 here, 0.9 in 2.x). Rows = weapon
// attack type (UnitWeapons `atkType1`); cols = armor type (UnitBalance `defType`).
// Divine (campaign-only) takes 5% from everything but Chaos (per Liquipedia; the
// official chart omits it). Unknown attack/armor pairs default to 1.0 (no change).
const DAMAGE_TABLE: Record<string, Record<string, number>> = {
  //         none  small(light) medium large(heavy) fort  hero  divine
  normal: { none: 1.0, small: 1.0, medium: 1.5, large: 1.0, fort: 0.7, hero: 1.0, divine: 0.05 },
  pierce: { none: 1.5, small: 2.0, medium: 0.75, large: 1.0, fort: 0.35, hero: 0.5, divine: 0.05 },
  siege: { none: 1.5, small: 1.0, medium: 0.5, large: 1.0, fort: 1.5, hero: 0.5, divine: 0.05 },
  magic: { none: 1.0, small: 1.25, medium: 0.75, large: 2.0, fort: 0.35, hero: 0.5, divine: 0.05 },
  chaos: { none: 1.0, small: 1.0, medium: 1.0, large: 1.0, fort: 1.0, hero: 1.0, divine: 1.0 },
  hero: { none: 1.0, small: 1.0, medium: 1.0, large: 1.0, fort: 0.5, hero: 1.0, divine: 0.05 },
  spells: { none: 1.0, small: 1.0, medium: 1.0, large: 1.0, fort: 1.0, hero: 0.7, divine: 0.05 },
};

/** Damage multiplier for a weapon `attackType` striking an `armorType`. Missing/
 *  unknown types fall back to 1.0 so unrecognised data degrades to plain damage. */
function damageMultiplier(attackType: string, armorType: string): number {
  const row = DAMAGE_TABLE[attackType.toLowerCase()];
  if (!row) return 1;
  const m = row[armorType.toLowerCase()];
  return m === undefined ? 1 : m;
}

// Attribute → stat conversions (Liquipedia Hero): verified against UnitBalance.
const HP_PER_STR = 25;
const MANA_PER_INT = 15;
const ARMOR_PER_AGI = 0.3;
const REGEN_PER_STR = 0.05; // hp/sec per Strength point
const REGEN_PER_INT = 0.05; // mana/sec per Intelligence point
const UNIT_MANA_REGEN = 0.67; // flat mana/sec for non-hero casters (approx WC3 base)
const AURA_REFRESH = 0.5; // aura buffs re-applied each tick with this TTL (fade on leave)
const FACING_CAST_EPS = 0.4; // must roughly face a unit target to cast
const SPELL_CAST_POINT = 0.4; // seconds the cast animation plays before the effect fires
// Corpse decay (Units\MiscData.txt BoneDecayTime): a corpse persists 88s after
// death — the renderer sequences it Death → Decay Flesh → Decay Bone within this
// window — and is then removed. The flesh stage is an early sub-phase, not added
// on top; 88s is the full lifetime from the moment of death.
const CORPSE_TOTAL_TIME = 88;

/** Total XP required to REACH a given hero level (Liquipedia: 50·(L²+L−2)). */
export function xpForLevel(level: number): number {
  return 50 * (level * level + level - 2);
}

// WC3 day/night: a full cycle is 480 real seconds = 24 game hours (so one game
// hour = 20 real seconds); daytime is 06:00–18:00. Melee games start at 08:00.
const GAME_HOURS_PER_SEC = 24 / 480;
const DAY_START = 6;
const DAY_END = 18;

// Neutral-hostile creep guard/leash AI. Values are the real WC3 gameplay
// constants from Units\MiscGame.txt (verified against the 1.27 MPQ):
//   "After a unit has strayed 'GuardDistance' from where it started … and spends
//    'GuardReturnTime' seconds chasing a target without getting attacked by
//    anyone, the unit … heads home. If a creep goes beyond 'MaxGuardDistance'
//    then it always returns home regardless of who's attacking it."
// (These supersede the ~1.8×-aggro guess — the MPQ wins; see CLAUDE.md.)
const GUARD_DISTANCE = 600; // strayed this far from home → start the return timer
const MAX_GUARD_DISTANCE = 1000; // strayed this far → return home unconditionally, even under attack
const GUARD_RETURN_TIME = 5.0; // MiscGame GuardReturnTime — also the "can't get home, resume fighting" window
const CREEP_CALL_FOR_HELP = 600; // MiscGame CreepCallForHelp — camp cohesion: one aggros → the whole camp wakes/joins
const CREEP_HOME_EPS = 64; // within this of the guard point counts as "home" (reset + can sleep)
// Hysteresis for the "walk back to post" trigger (mirrors ATTACK_LEASH / FOLLOW_LEASH):
// a return FINISHES at CREEP_HOME_EPS and settle() then snaps the creep to the grid —
// a snap of up to ~half a cell can nudge it just back over CREEP_HOME_EPS. Without a
// wider re-trigger threshold an idle creep resting near its post would oscillate
// finish→snap→return→finish, flickering the walk↔stand clip (the return "jiggle"). So a
// guarding creep only heads home again once displaced comfortably past the snap noise.
const CREEP_RETURN_TRIGGER = 128; // 4 cells — safely beyond CREEP_HOME_EPS + the settle snap
// Not in any data file (engine-internal): a sleeping creep only wakes to a hostile
// that strays very close — far enough that you can still scout past camps at night.
const SLEEP_WAKE_RANGE = 200; // a sleeping creep wakes if a hostile comes within this

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
  // Worker ids whose axe just landed a chop this tick — the renderer plays the
  // chop SFX (worker's lumber-weapon material vs Wood).
  private chops: number[] = [];
  // Debug cheat: when true, construction + unit training complete in ~1 second
  // (any build time is compressed to one second), regardless of builders present.
  fastBuild = false;
  // Trained units ready to spawn: the renderer creates the model + sim unit.
  private trainCompletions: Array<{ buildingId: number; unitId: string; x: number; y: number; rallyX: number; rallyY: number; rallyKind: RallyKind; rallyTargetId: number }> = [];
  private nextNodeId = 1;
  private rng: () => number;
  // --- corpses (persist + decay; targetable by corpse-consuming spells) ---
  readonly corpses = new Map<number, SimCorpse>();
  private nextCorpseId = 1;
  // --- spell / ability event channels drained by the renderer each frame ---
  // Spell effect models to play at a unit/point (targetArt/casterArt/areaArt).
  private spellEffects: Array<{ art: string; x: number; y: number; targetId: number; z: number }> = [];
  // A unit began casting: renderer plays the cast animation (spell/throw/slam).
  private castStarts: Array<{ casterId: number; code: string; abilityId: string }> = [];
  // Heroes that just gained a level: renderer plays the level-up nova + sound.
  private levelUps: Array<{ unitId: number; level: number }> = [];
  // Units summoned/raised by a spell this tick: the renderer creates their models
  // (same deferral as trainCompletions — the sim owns no model instances).
  private summonRequests: Array<{ unitId: string; x: number; y: number; facing: number; owner: number; team: number; summonLeft: number; sourceId: number }> = [];

  constructor(
    readonly grid: PathingGrid,
    seed = 1,
    private abilities?: AbilityRegistry,
  ) {
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

  /** Worker ids that landed a chop since the last drain (renderer plays the axe SFX). */
  drainChops(): number[] {
    if (!this.chops.length) return this.chops;
    const out = this.chops;
    this.chops = [];
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
  assignBuilder(workerId: number, buildingId: number, ax?: number, ay?: number): void {
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
      // stays paused until the worker arrives (tickBuildings' nearby check). A
      // grouped order passes ax/ay — a distinct spot around the footprint — so
      // builders fan around the structure rather than all making for its centre.
      w.order = "move";
      if (!this.pathTo(w, ax ?? b.x, ay ?? b.y)) {
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
        // Debug cheat: finish in ~1s no matter what (no builder required).
        if (this.fastBuild) {
          b.constructionLeft = Math.max(0, b.constructionLeft - Math.max(dt, b.buildTimeTotal * dt));
          u.hp = u.maxHp * (0.1 + 0.9 * (1 - b.constructionLeft / b.buildTimeTotal));
          if (b.constructionLeft === 0) for (const bid of [...b.builderIds]) this.detachBuilder(bid);
          continue;
        }
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
        // Debug cheat compresses any train time to ~1 second.
        job.timeLeft -= this.fastBuild ? Math.max(dt, job.buildTime * dt) : dt;
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
      | "chopSeq"
      | "inCombat"
      | "neutralPassive"
      | "chaseX"
      | "chaseY"
      | "followOffX"
      | "followOffY"
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
      | "yieldT"
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
      | "isHero"
      | "level"
      | "xp"
      | "skillPoints"
      | "primaryAttr"
      | "baseStr"
      | "baseAgi"
      | "baseInt"
      | "strPerLevel"
      | "agiPerLevel"
      | "intPerLevel"
      | "str"
      | "agi"
      | "int"
      | "baseMaxHp"
      | "baseMaxMana"
      | "baseArmor"
      | "baseDamage"
      | "baseSpeed"
      | "baseCooldown"
      | "manaRegen"
      | "hpRegen"
      | "lifesteal"
      | "thorns"
      | "bonusArmor"
      | "bonusDamage"
      | "abilities"
      | "buffs"
      | "stunned"
      | "silenced"
      | "invulnerable"
      | "mechanical"
      | "isSummon"
      | "spawning"
      | "summonLeft"
      | "summonMax"
      | "pendingCast"
      | "isCreep"
      | "guardX"
      | "guardY"
      | "guardFacing"
      | "aggroRange"
      | "canSleep"
      | "asleep"
      | "returning"
      | "strayT"
      | "returnBestDist"
      | "returnStuckT"
    >,
    building?: BuildingState | null,
    opts?: { hero?: HeroInit; abilities?: SimAbility[]; mechanical?: boolean; manaRegen?: number; level?: number },
  ): SimUnit {
    const hero = opts?.hero;
    const u: SimUnit = {
      ...unit,
      desiredFacing: unit.facing,
      order: "idle",
      targetId: null,
      cooldownLeft: 0,
      swingLeft: -1,
      swingTargetId: 0,
      swingSeq: 0,
      chopSeq: 0,
      inCombat: false,
      neutralPassive: false,
      path: [],
      waypoint: 0,
      moving: false,
      chaseX: 0,
      chaseY: 0,
      followOffX: 0,
      followOffY: 0,
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
      yieldT: 0,
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
      // --- hero / abilities / buffs ---
      isHero: !!hero,
      level: hero?.level ?? opts?.level ?? 0,
      xp: hero ? xpForLevel(hero.level) : 0,
      skillPoints: 0, // granted by leveling (initHero sets the starting points)
      primaryAttr: hero?.primaryAttr ?? "",
      baseStr: hero?.str ?? 0,
      baseAgi: hero?.agi ?? 0,
      baseInt: hero?.int ?? 0,
      strPerLevel: hero?.strPerLevel ?? 0,
      agiPerLevel: hero?.agiPerLevel ?? 0,
      intPerLevel: hero?.intPerLevel ?? 0,
      str: hero?.str ?? 0,
      agi: hero?.agi ?? 0,
      int: hero?.int ?? 0,
      // Level-1 baselines — attribute growth + buffs layer on top of these.
      baseMaxHp: unit.maxHp,
      baseMaxMana: unit.maxMana,
      baseArmor: unit.armor,
      baseDamage: unit.weapon?.damage ?? 0,
      baseSpeed: unit.speed,
      baseCooldown: unit.weapon?.cooldown ?? 0,
      manaRegen: opts?.manaRegen ?? 0, // recomputeStats derives the real value below
      hpRegen: 0,
      lifesteal: 0,
      thorns: 0,
      bonusArmor: 0,
      bonusDamage: 0,
      abilities: opts?.abilities ?? [],
      buffs: [],
      stunned: false,
      silenced: false,
      invulnerable: false,
      mechanical: !!opts?.mechanical,
      isSummon: false,
      spawning: 0,
      summonLeft: 0,
      summonMax: 0,
      pendingCast: null,
      // Creep guard AI is off by default; the map seeder flips isCreep on and sets
      // the guard point / aggro range / sleep flag for Neutral Hostile units.
      isCreep: false,
      guardX: unit.x,
      guardY: unit.y,
      guardFacing: unit.facing,
      aggroRange: 0,
      canSleep: false,
      asleep: false,
      returning: false,
      strayT: 0,
      returnBestDist: 0,
      returnStuckT: 0,
    };
    this.units.set(u.id, u);
    this.settle(u);
    if (hero) {
      // Grant the starting skill point(s) for the hero's level and derive stats
      // (HP/mana/armour/damage/regen) from the level-1 attributes.
      u.skillPoints = hero.level;
      this.recomputeStats(u);
      u.hp = u.maxHp;
      u.mana = u.maxMana;
    } else {
      this.recomputeStats(u); // sets regen for casters and applies any base buffs
    }
    return u;
  }

  // --- cell reservation (WC3 pathing grid) ---------------------------------

  /** A unit came to rest: align it to its cell footprint and reserve the cells
   *  so other units path around it (this is what makes surrounds possible).
   *  `snap` grid-aligns the position — skipped when parking a worker at a
   *  resource so it doesn't teleport off the spot it walked to. */
  private settle(u: SimUnit, snap = true): void {
    u.moving = false;
    u.yieldT = 0; // no longer moving — drop any pending give-way pause
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

  /** Order a unit to attack another. Normally requires the target to be hostile;
   *  `force` (the deliberate Attack command) lets you attack allies/own units too. */
  issueAttack(id: number, targetId: number, force = false): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || !u.weapon || (!force && !this.hostile(u, t))) return false;
    u.order = "attack";
    u.targetId = targetId;
    u.noCollision = false; // manual control restores collision
    this.cancelSwing(u); // a fresh target starts a fresh swing
    this.detachBuilder(id);
    return true;
  }

  /** Order a unit to FOLLOW another (friendly/neutral/enemy) unit: it trails the
   *  leader at FOLLOW_GAP and does NOT auto-acquire targets on its own (WC3).
   *  offX/offY give a formation offset from the leader's centre so a group told to
   *  follow one unit fans out (0,0 = a lone follower that just trails). */
  issueFollow(id: number, targetId: number, offX = 0, offY = 0): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || u.speed <= 0) return false;
    u.order = "follow";
    u.targetId = targetId;
    u.followOffX = offX;
    u.followOffY = offY;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
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
      case "attack": return this.issueAttack(id, o.targetId, o.force);
      case "follow": return this.issueFollow(id, o.targetId, o.offX, o.offY);
      case "harvest": return this.issueHarvest(id, o.res, o.nodeId, o.ax, o.ay);
      case "buildresume": this.assignBuilder(id, o.buildingId, o.ax, o.ay); return true;
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

  /** Order a worker to harvest a mine or tree. False if it can't. `ax/ay` is an
   *  optional distinct approach point (a group ordered together fans around the
   *  node's rim rather than piling on its centre); only the FIRST walk-up uses
   *  it — later trips re-form the mine→hall line via mineApproach as before. */
  issueHarvest(id: number, kind: "gold" | "lumber", nodeId: number, ax?: number, ay?: number): boolean {
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
    if (ax !== undefined && ay !== undefined) this.pathTo(u, ax, ay); // spread approach for a grouped command
    else this.pathToNode(u); // walk toward the node once; arrival latches atNode
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

  /** Same team = allied (friendly). Neutral-passive shops count as nobody's ally. */
  allied(a: SimUnit, b: SimUnit): boolean {
    if (a.neutralPassive || b.neutralPassive) return false;
    return a.team === b.team;
  }

  // === abilities / buffs / casting ==========================================

  /** Recompute a unit's effective stats from its base values, hero attribute
   *  growth, and active buffs. Called every tick (cheap, idempotent). */
  private recomputeStats(u: SimUnit): void {
    if (u.isHero) {
      u.str = Math.floor(u.baseStr + u.strPerLevel * (u.level - 1));
      u.agi = Math.floor(u.baseAgi + u.agiPerLevel * (u.level - 1));
      u.int = Math.floor(u.baseInt + u.intPerLevel * (u.level - 1));
    }
    const dStr = u.isHero ? u.str - Math.floor(u.baseStr) : 0;
    const dAgi = u.isHero ? u.agi - Math.floor(u.baseAgi) : 0;
    const dInt = u.isHero ? u.int - Math.floor(u.baseInt) : 0;
    const primaryDelta = u.primaryAttr === "STR" ? dStr : u.primaryAttr === "AGI" ? dAgi : u.primaryAttr === "INT" ? dInt : 0;
    let armorBonus = 0;
    let manaRegenBonus = 0;
    let damageBonus = 0;
    let slowMove = 0;
    let slowAttack = 0;
    let hasteMove = 0;
    let hasteAttack = 0;
    let damagePct = 0;
    let hpRegenBonus = 0;
    let lifesteal = 0;
    let thorns = 0;
    let stun = false;
    let silence = false;
    let invuln = false;
    for (const b of u.buffs) {
      if (b.kind === "armor") armorBonus += b.value;
      else if (b.kind === "manaRegen") manaRegenBonus += b.value;
      else if (b.kind === "damage") damageBonus += b.value;
      else if (b.kind === "damagePct") damagePct += b.value; // Command/Trueshot Aura
      else if (b.kind === "hpRegen") hpRegenBonus += b.value; // Unholy Aura
      else if (b.kind === "lifesteal") lifesteal = Math.max(lifesteal, b.value); // Vampiric Aura
      else if (b.kind === "thorns") thorns = Math.max(thorns, b.value); // Thorns Aura
      else if (b.kind === "slow") {
        slowMove = Math.max(slowMove, b.value);
        slowAttack = Math.max(slowAttack, b.value2);
      } else if (b.kind === "haste") {
        hasteMove = Math.max(hasteMove, b.value);
        hasteAttack = Math.max(hasteAttack, b.value2);
      } else if (b.kind === "root") slowMove = Math.max(slowMove, b.value); // pins movement (can still attack)
      else if (b.kind === "stun" || b.kind === "sleep") stun = true; // sleep disables like a stun (wakes on damage)
      else if (b.kind === "silence") silence = true;
      else if (b.kind === "invuln") invuln = true;
    }
    u.maxHp = u.baseMaxHp + HP_PER_STR * dStr;
    u.maxMana = u.baseMaxMana + MANA_PER_INT * dInt;
    if (u.hp > u.maxHp) u.hp = u.maxHp;
    if (u.mana > u.maxMana) u.mana = u.maxMana;
    // Spiked Carapace (Crypt Lord passive AUts): a flat bonus armour (dataB) while learned.
    const carapace = this.passiveLevelData(u, "AUts");
    const carapaceArmor = carapace ? this.dataOf(carapace, 1) : 0;
    u.armor = u.baseArmor + ARMOR_PER_AGI * dAgi + armorBonus + carapaceArmor;
    u.bonusArmor = armorBonus + carapaceArmor; // the buff/aura portion (shown green in the HUD)
    if (u.weapon) {
      const base = u.baseDamage + primaryDelta;
      u.weapon.damage = Math.max(0, base + damageBonus + base * damagePct); // Command/Trueshot add a % of base
      u.bonusDamage = u.weapon.damage - base; // the buff/aura portion
      u.weapon.cooldown = (u.baseCooldown * (1 + slowAttack)) / (1 + hasteAttack);
    }
    u.speed = Math.max(0, u.baseSpeed * (1 - slowMove) * (1 + hasteMove));
    u.manaRegen = (u.isHero ? REGEN_PER_INT * u.int : u.baseMaxMana > 0 ? UNIT_MANA_REGEN : 0) + manaRegenBonus;
    u.hpRegen = (u.isHero ? REGEN_PER_STR * u.str : 0) + hpRegenBonus;
    u.lifesteal = lifesteal;
    // Spiked Carapace also returns a fraction of melee damage (dataA), like Thorns.
    u.thorns = Math.max(thorns, carapace ? this.dataOf(carapace, 0) : 0);
    u.stunned = stun;
    u.silenced = silence;
    u.invulnerable = invuln;
  }

  /** The level-data for a passive ability the unit has learned (by base code), or
   *  null. Shared by passive-effect derivations (Spiked Carapace, Critical Strike,
   *  Evasion, Cleaving Attack). */
  private passiveLevelData(u: SimUnit, code: string): AbilityLevel | null {
    if (!this.abilities) return null;
    const ab = u.abilities.find((a) => a.code === code && a.level >= 1);
    if (!ab) return null;
    const def = this.abilities.get(ab.id);
    if (!def) return null;
    return def.levelData[Math.min(ab.level, def.levelData.length) - 1] ?? null;
  }

  /** Read dataX (a=0..i=8) off an ability level, NaN-safe. */
  private dataOf(lvl: AbilityLevel, i: number, fallback = 0): number {
    const v = lvl.data[i];
    return v === undefined || Number.isNaN(v) ? fallback : v;
  }

  /** Advance timed buffs; apply DoT/HoT. Returns true if the unit died (DoT). */
  private tickBuffs(u: SimUnit, dt: number): boolean {
    if (!u.buffs.length) return false;
    for (const b of u.buffs) {
      if (b.kind === "hot" && b.value) u.hp = Math.min(u.maxHp, u.hp + b.value * dt);
      else if (b.kind === "dot" && b.value) u.hp -= b.value * dt;
      b.timeLeft -= dt;
    }
    u.buffs = u.buffs.filter((b) => b.timeLeft > 0);
    if (u.hp <= 0) {
      this.kill(u);
      return true;
    }
    return false;
  }

  private tickRegen(u: SimUnit, dt: number): void {
    if (u.maxMana > 0 && u.mana < u.maxMana) u.mana = Math.min(u.maxMana, u.mana + u.manaRegen * dt);
    if (u.hpRegen > 0 && u.hp > 0 && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.hpRegen * dt);
  }

  /** Re-apply every active aura's buff to allies in range (short-TTL, so it fades
   *  when a unit leaves the aura). Non-stacking auras keep the strongest. */
  private applyAuras(): void {
    if (!this.abilities) return;
    for (const src of this.units.values()) {
      if (src.hp <= 0) continue;
      for (const ab of src.abilities) {
        if (ab.level < 1) continue;
        const make = AURA_BUFFS[ab.code];
        if (!make) continue;
        const def = this.abilities.get(ab.id);
        if (!def) continue;
        const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
        const radius = lvl.area || 900;
        const effects = make(lvl);
        for (const t of this.units.values()) {
          if (t.building || t.hp <= 0 || t.team !== src.team) continue;
          if (Math.hypot(t.x - src.x, t.y - src.y) > radius) continue;
          const ranged = !!t.weapon?.ranged;
          for (const e of effects) {
            if (e.rangedOnly && !ranged) continue; // Trueshot only helps ranged units
            if (e.meleeOnly && (ranged || !t.weapon)) continue; // Vampiric only helps melee units
            this.applyBuffInternal(t, { kind: e.kind, group: `${ab.code}:${e.kind}`, timeLeft: AURA_REFRESH, sourceId: src.id, value: e.value, value2: e.value2 });
          }
        }
      }
    }
  }

  /** Add/refresh a buff. Grouped buffs (auras, Inner Fire) don't stack — the
   *  strongest wins and its timer refreshes. Ungrouped buffs are independent. */
  private applyBuffInternal(u: SimUnit, init: SimBuffInit): void {
    const group = init.group ?? "";
    if (group) {
      // De-dupe per (group, kind): abilities like Avatar/Inner Fire apply an armour
      // AND a damage buff under one group — keying on group alone would drop the 2nd.
      const existing = u.buffs.find((b) => b.group === group && b.kind === init.kind);
      if (existing) {
        existing.value = Math.max(existing.value, init.value ?? 0);
        existing.value2 = Math.max(existing.value2, init.value2 ?? 0);
        existing.timeLeft = Math.max(existing.timeLeft, init.timeLeft);
        existing.sourceId = init.sourceId;
        if (init.art) existing.art = init.art;
        return;
      }
    }
    u.buffs.push({ kind: init.kind, group, timeLeft: init.timeLeft, sourceId: init.sourceId, value: init.value ?? 0, value2: init.value2 ?? 0, art: init.art ?? "" });
  }

  private interruptForStun(u: SimUnit): void {
    // Pause movement WITHOUT clearing the path, so a plain move/patrol resumes when
    // the stun ends (settle() would wipe the path and strand the unit on "move",
    // which has no per-tick handler to restart it). Casting is fully interrupted.
    u.moving = false;
    u.inCombat = false;
    this.cancelSwing(u);
    if (u.order === "cast") {
      u.pendingCast = null;
      u.order = "idle";
    }
  }

  /** Passive Bash (AHbh): a landed attack has dataB chance to stun for dataC. */
  private tryBash(attacker: SimUnit, target: SimUnit): void {
    if (!this.abilities || target.invulnerable) return;
    const ab = attacker.abilities.find((a) => a.code === "AHbh" && a.level >= 1);
    if (!ab) return;
    const def = this.abilities.get(ab.id);
    if (!def) return;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    const chance = lvl.data[1]; // dataB = bash chance
    const stunDur = lvl.data[2] || 1; // dataC = stun duration
    if (Number.isFinite(chance) && this.rng() < chance) {
      this.applyBuffInternal(target, { kind: "stun", group: "", timeLeft: target.isHero ? Math.min(stunDur, lvl.heroDuration || stunDur) : stunDur, sourceId: attacker.id });
    }
  }

  /** Look up a learned/innate ability on a unit by its base code. */
  private findAbility(u: SimUnit, code: string): SimAbility | undefined {
    return u.abilities.find((a) => a.code === code && a.level >= 1);
  }

  /** Can a unit target another with a (harmful) spell right now? */
  private castableTarget(caster: SimUnit, target: SimUnit, flags: string[] = []): boolean {
    if (target.hp <= 0) return false;
    if (target.invulnerable && this.hostile(caster, target)) return false;
    return this.targetAllowed(caster, target, flags);
  }

  /** Enforce the ability's "Targets Allowed" (AbilityData `targs1`) allegiance +
   *  hero/non-hero flags, so a spell only hits what its data says it may. Verified
   *  against the 1.27 MPQ: Storm Bolt/Chain Lightning/Slow are `enemy` (never a
   *  friendly), Heal/Inner Fire/Frost Armor are `friend,self` (never an enemy),
   *  Holy Light/Death Coil/Life Drain are `notself` (anything but the caster).
   *  Codes with no allegiance flag (Banish) stay unrestricted. */
  private targetAllowed(caster: SimUnit, target: SimUnit, flags: string[]): boolean {
    const F = new Set(flags.map((f) => f.toLowerCase()));
    // Clear-cut unit-type gates.
    if (F.has("nonhero") && target.isHero) return false;
    if (F.has("hero") && !target.isHero) return false;
    const enemy = F.has("enemy");
    const friend = F.has("friend") || F.has("player"); // `player` = own units (Death Pact/Dark Ritual)
    const self = F.has("self");
    const neutral = F.has("neutral");
    const notself = F.has("notself");
    // No allegiance restriction in the data (e.g. Banish) → any allegiance allowed.
    if (!(enemy || friend || self || neutral || notself)) return true;
    if (target.id === caster.id) return self;
    if (notself) return true; // anything but the caster
    if (this.hostile(caster, target)) return enemy;
    if (target.neutralPassive) return neutral || friend;
    return friend; // a friendly (same-team) unit
  }

  /** Order a unit to cast an ability. `code` is the ability's base code; targetId
   *  (unit) / x,y (point) depend on the ability's target type. Returns false if
   *  the cast can't be started (unknown/unlearned ability, wrong target, dead). */
  issueCast(unitId: number, code: string, targetId = 0, x = 0, y = 0): boolean {
    const u = this.units.get(unitId);
    if (!u || u.stunned || u.silenced || !this.abilities) return false;
    const ab = this.findAbility(u, code);
    if (!ab) return false;
    const def = this.abilities.get(ab.id);
    if (!def || def.target === "passive") return false;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    const t = def.target === "unit" ? this.units.get(targetId) : undefined;
    if (def.target === "unit" && (!t || !this.castableTarget(u, t, def.targetFlags))) return false;
    // Remember an attack-move/follow to resume after the cast (WC3 casters keep
    // marching/following once they've cast).
    const resume: PendingCast["resume"] =
      u.order === "attackmove" ? { kind: "attackmove", x: u.amDestX, y: u.amDestY } : u.order === "follow" && u.targetId ? { kind: "follow", id: u.targetId } : null;
    // Re-task away from whatever it was doing.
    this.detachBuilder(unitId);
    this.cancelSwing(u);
    u.inCombat = false;
    u.targetId = null;
    u.order = "cast";
    u.pendingCast = {
      code,
      abilityId: ab.id,
      rank: ab.level,
      targetId: def.target === "unit" ? targetId : 0,
      x: def.target === "point" ? x : (t?.x ?? u.x),
      y: def.target === "point" ? y : (t?.y ?? u.y),
      range: def.target === "none" ? 0 : lvl.castRange,
      castLeft: -1,
      started: false,
      fired: false,
      channelLeft: 0,
      resume,
    };
    return true;
  }

  /** Drive a pending cast: close to cast range, face the target, then at the cast
   *  point spend mana + cooldown and fire the effect (or launch the spell missile). */
  private tickCast(u: SimUnit, dt: number): void {
    const pc = u.pendingCast;
    if (!pc || !this.abilities) {
      this.stop(u.id);
      return;
    }
    const def = this.abilities.get(pc.abilityId);
    const ab = u.abilities.find((a) => a.id === pc.abilityId);
    if (!def || !ab || ab.level < 1) {
      this.stop(u.id);
      return;
    }
    const lvl = def.levelData[Math.min(pc.rank, def.levelData.length) - 1];
    // Resolve where we're aiming; a unit target that died/became invalid aborts.
    let tx = pc.x;
    let ty = pc.y;
    if (pc.targetId) {
      const t = this.units.get(pc.targetId);
      if (!t || !this.castableTarget(u, t, def.targetFlags)) {
        this.stop(u.id);
        return;
      }
      tx = t.x;
      ty = t.y;
      pc.x = tx;
      pc.y = ty;
    }
    if (!pc.started) {
      // Approach: close to cast range (hull-to-hull for unit targets), then face.
      if (pc.range > 0) {
        const t = pc.targetId ? this.units.get(pc.targetId) : null;
        const gap = Math.hypot(tx - u.x, ty - u.y) - u.radius - (t?.radius ?? 0);
        if (gap > pc.range) {
          this.chasePoint(u, tx, ty);
          return;
        }
      }
      if (u.moving) this.settle(u);
      // Face a unit/point target; for a no-target SELF cast (Water Elemental,
      // Divine Shield, Avatar) keep the current facing so the caster doesn't spin
      // to face east — and so the summon appears in front of where it's looking.
      if (Math.hypot(tx - u.x, ty - u.y) > 1) u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      if (Math.abs(angleDiff(u.facing, u.desiredFacing)) > FACING_CAST_EPS) return; // still turning
      // Validate + pay: enough mana and off cooldown.
      if (ab.cooldownLeft > 0 || u.mana < lvl.cost) {
        this.stop(u.id);
        return;
      }
      u.mana -= lvl.cost;
      ab.cooldownLeft = lvl.cooldown;
      pc.started = true;
      // The effect fires at the cast POINT — a short delay while the caster plays
      // its spell animation (raise the hammer, etc.), THEN the spell lands. A
      // channelled spell (Blizzard, cast>0) uses its cast time as the delay.
      pc.castLeft = lvl.castTime > 0 ? lvl.castTime : SPELL_CAST_POINT;
      this.castStarts.push({ casterId: u.id, code: pc.code, abilityId: pc.abilityId }); // renderer plays the cast animation + sound
    }
    // Channelled spells (Blizzard): after firing, the caster STANDS and holds for
    // the channel duration — it doesn't auto-attack, so the channel isn't self-
    // interrupted (manual orders still break it).
    if (pc.fired) {
      pc.channelLeft -= dt;
      if (u.moving) this.settle(u);
      u.desiredFacing = Math.atan2(pc.y - u.y, pc.x - u.x);
      if (pc.channelLeft > 0) return;
      this.endCast(u, pc);
      return;
    }
    // Fire once the (short) cast point elapses.
    pc.castLeft -= dt;
    if (pc.castLeft > 0) return;
    pc.fired = true;
    this.resolveCast(u, def, pc);
    pc.channelLeft = this.channelDuration(def, pc.rank);
    if (pc.channelLeft > 0) {
      if (u.moving) this.settle(u); // begin channelling — hold position
      return;
    }
    this.endCast(u, pc);
  }

  /** End a cast: resume the pre-cast attack-move/follow, else fall idle. */
  private endCast(u: SimUnit, pc: PendingCast): void {
    if (pc.resume?.kind === "attackmove") this.issueAttackMove(u.id, pc.resume.x, pc.resume.y);
    else if (pc.resume?.kind === "follow") this.issueFollow(u.id, pc.resume.id);
    else this.stop(u.id);
  }

  /** Channel time (the caster holds after firing) for a channelled spell — for a
   *  wave field like Blizzard it's the field's lifetime (waves × interval). */
  private channelDuration(def: AbilityDef, rank: number): number {
    const lvl = def.levelData[Math.min(rank, def.levelData.length) - 1];
    if (lvl.castTime <= 0) return 0;
    if (def.code === "AHbz") {
      const waves = lvl.data[0];
      const interval = lvl.data[3] || 0.5;
      if (Number.isFinite(waves) && waves > 0) return waves * interval;
    }
    return lvl.castTime;
  }

  /** Deliver a cast's effect: launch the spell missile (if the ability has one)
   *  or apply the effect immediately (instant / point / no-target). */
  private resolveCast(u: SimUnit, def: AbilityDef, pc: PendingCast): void {
    if (def.target === "unit" && def.missileArt && pc.targetId) {
      // Travelling spell (Storm Bolt, Death Coil): the effect fires on impact.
      this.spawnSpellProjectile(u, pc.targetId, def, pc.rank);
      return;
    }
    this.applySpellEffect(pc.code, pc.rank, u, { targetId: pc.targetId, x: pc.x, y: pc.y }, def);
  }

  /** Idle autocast: a unit with a toggled-on autocast ability picks a valid
   *  target and casts. Returns true if a cast started. */
  private tickAutocast(u: SimUnit): boolean {
    if (!this.abilities || u.mana <= 0) return false;
    for (const ab of u.abilities) {
      if (!ab.autocastOn || ab.level < 1 || ab.cooldownLeft > 0) continue;
      const def = this.abilities.get(ab.id);
      if (!def || def.target !== "unit") continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (u.mana < lvl.cost) continue;
      // Friendly vs hostile autocast is decided by the ability's real Targets
      // Allowed flags (targs1), not a hard-coded code list: a spell allowing
      // `friend`/`self`/`player` (and not `enemy`) buffs/heals allies; `enemy`
      // targets foes. `self` in the flags lets the caster be its own target
      // (Heal/Inner Fire/Frost Armor all carry it — verified in the 1.27 MPQ).
      const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
      const friendly = !F.has("enemy") && (F.has("friend") || F.has("self") || F.has("player"));
      const target = this.autocastTarget(u, lvl.castRange, friendly, def.code, F.has("self"));
      if (target) return this.issueCast(u.id, def.code, target.id);
    }
    return false;
  }

  private autocastTarget(u: SimUnit, range: number, friendly: boolean, code: string, selfOk: boolean): SimUnit | null {
    let best: SimUnit | null = null;
    let bestScore = friendly ? 0.999 : Infinity;
    for (const t of this.units.values()) {
      if (t.building || t.hp <= 0) continue;
      // Skip the caster unless the spell's flags permit self-targeting (a `self`
      // autocast like Priest Heal can pick itself when it's the most-hurt ally).
      if (t === u && !(friendly && selfOk)) continue;
      if (Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > range) continue;
      if (friendly) {
        if (!this.allied(u, t) || t.mechanical) continue;
        if (code === "Ahea" && t.hp >= t.maxHp) continue; // only wounded
        const frac = t.hp / t.maxHp; // heal the most-hurt ally
        if (frac < bestScore) {
          bestScore = frac;
          best = t;
        }
      } else {
        if (!this.hostile(u, t) || t.invulnerable) continue;
        if (u.buffs.length && this.findBuffFrom(t, u.id)) continue;
        const d = Math.hypot(t.x - u.x, t.y - u.y);
        if (d < bestScore) {
          bestScore = d;
          best = t;
        }
      }
    }
    return best;
  }

  private findBuffFrom(t: SimUnit, sourceId: number): SimBuff | undefined {
    return t.buffs.find((b) => b.sourceId === sourceId);
  }

  /** Launch a spell projectile that runs the ability's effect on its target on
   *  impact (Storm Bolt hammer, Death Coil orb). */
  private spawnSpellProjectile(u: SimUnit, targetId: number, def: AbilityDef, rank: number): void {
    const id = this.nextProjectileId++;
    const proj: SimProjectile = {
      id,
      x: u.x,
      y: u.y,
      sourceId: u.id,
      targetId,
      speed: 900,
      damage: 0, // spell effect (not plain damage) is applied on impact
      art: def.missileArt,
      spell: { code: def.code, rank, abilityId: def.id },
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y });
  }

  /** Run a spell's effect handler (dispatched on base `code`). Shared by instant
   *  casts and spell-projectile impacts. */
  applySpellEffect(code: string, rank: number, caster: SimUnit, ctx: { targetId: number; x: number; y: number }, def?: AbilityDef): void {
    const handler = SPELL_HANDLERS[code];
    const d = def ?? (this.abilities ? this.abilityByCode(code) : undefined);
    if (!handler || !d) return;
    handler(this.spellApi, caster, d, Math.max(1, rank), ctx);
  }

  private abilityByCode(code: string): AbilityDef | undefined {
    if (!this.abilities) return undefined;
    for (const a of this.abilities.all()) if (a.code === code) return a;
    return undefined;
  }

  // === hero XP / leveling ===================================================

  /** Award XP to the killer's heroes for a kill (Liquipedia sharing rules). */
  private awardKillXp(victim: SimUnit, killerId: number): void {
    if (victim.building || !killerId) return; // structures / unattributed deaths grant no XP
    const victimLevel = Math.max(0, Math.min(KILL_XP.length - 1, victim.level || 0));
    let base = KILL_XP[victimLevel] || 0;
    if (base <= 0) return;
    if (victim.isSummon) base *= SUMMON_XP_FACTOR;
    const killer = this.units.get(killerId);
    // Beneficiaries: enemy heroes of the victim within share range (else global).
    const eligible: SimUnit[] = [];
    for (const h of this.units.values()) {
      if (!h.isHero || h.hp <= 0 || h.team === victim.team) continue;
      if (killer && h.team !== killer.team) continue; // only the killer's side
      if (Math.hypot(h.x - victim.x, h.y - victim.y) <= XP_SHARE_RANGE) eligible.push(h);
    }
    if (!eligible.length) {
      // No hero in range: award globally to the killer's heroes (no distance loss).
      for (const h of this.units.values()) {
        if (h.isHero && h.hp > 0 && killer && h.team === killer.team) eligible.push(h);
      }
    }
    if (!eligible.length) return;
    const share = base / eligible.length; // split evenly among the sharers
    for (const h of eligible) {
      let amount = share;
      const isCreep = victim.team === -1; // Neutral Hostile
      if (isCreep) amount *= CREEP_XP_FACTOR[Math.min(h.level, CREEP_XP_FACTOR.length - 1)] ?? 0;
      this.gainXp(h, amount);
    }
  }

  /** Add XP to a hero, leveling it up (with stat growth) across thresholds. */
  gainXp(hero: SimUnit, amount: number): void {
    if (!hero.isHero || hero.level >= MAX_HERO_LEVEL || amount <= 0) return;
    hero.xp += amount;
    while (hero.level < MAX_HERO_LEVEL && hero.xp >= xpForLevel(hero.level + 1)) {
      this.levelUp(hero);
    }
  }

  private levelUp(hero: SimUnit): void {
    hero.level++;
    hero.skillPoints++;
    this.recomputeStats(hero); // new maxHp/maxMana/attributes
    hero.hp = hero.maxHp; // WC3: leveling fully restores HP and mana
    hero.mana = hero.maxMana;
    this.levelUps.push({ unitId: hero.id, level: hero.level });
  }

  /** Learn (or rank up) a hero ability by spending a skill point. Returns true on
   *  success. Enforces the hero level requirement, max ranks, and points. */
  learnAbility(unitId: number, abilityId: string): boolean {
    const u = this.units.get(unitId);
    if (!u || !u.isHero || u.skillPoints <= 0 || !this.abilities) return false;
    const def = this.abilities.get(abilityId);
    if (!def) return false;
    const ab = u.abilities.find((a) => a.id === abilityId);
    if (!ab || ab.level >= def.levels) return false;
    if (u.level < requiredHeroLevel(def, ab.level + 1)) return false;
    ab.level++;
    u.skillPoints--;
    return true;
  }

  /** Toggle an ability's autocast (Heal/Slow/…). Returns the new state. */
  toggleAutocast(unitId: number, code: string): boolean {
    const u = this.units.get(unitId);
    const ab = u ? this.findAbility(u, code) : undefined;
    if (!ab) return false;
    ab.autocastOn = !ab.autocastOn;
    return ab.autocastOn;
  }

  // === spell fields (Blizzard-style repeating area effects) =================

  private spellFields: Array<SpellFieldInit & { timer: number; done: number; team: number }> = [];

  private addSpellFieldInternal(f: SpellFieldInit): void {
    // Capture the caster's team NOW so the field targets enemies correctly even
    // after the caster dies mid-channel (Blizzard would otherwise hit allies).
    const team = this.units.get(f.casterId)?.team ?? 0;
    this.spellFields.push({ ...f, timer: 0, done: 0, team });
  }

  private tickSpellFields(dt: number): void {
    for (let i = this.spellFields.length - 1; i >= 0; i--) {
      const f = this.spellFields[i];
      f.timer -= dt;
      if (f.timer <= 0) {
        f.timer = f.interval;
        f.done++;
        for (const t of this.unitsInAreaInternal(f.x, f.y, f.area)) {
          if (t.team === f.team || t.neutralPassive) continue; // hit only the caster's enemies
          this.landDamage(t, f.damagePerWave, f.casterId, false); // spell damage: ignore armor
        }
        // Scatter the wave effect at a random point within the area (WC3 drops the
        // ice shards across the whole circle each wave, not just the centre).
        if (f.art) {
          const ang = this.rng() * Math.PI * 2;
          const r = f.area * Math.sqrt(this.rng());
          this.spellEffects.push({ art: f.art, x: f.x + Math.cos(ang) * r, y: f.y + Math.sin(ang) * r, targetId: 0, z: 0 });
        }
      }
      if (f.done >= f.waves) this.spellFields.splice(i, 1);
    }
  }

  // === corpses ==============================================================

  /** Leave a corpse for an organic, ground, non-mechanical unit (Liquipedia:
   *  Corpse). Buildings collapse, mechanical units explode, summons vanish, and
   *  air units crash without leaving a raisable ground corpse — none of them do. */
  private spawnCorpse(u: SimUnit): void {
    // A summon (isSummon) leaves no corpse even after its timer hits 0 at expiry.
    if (u.building || u.mechanical || u.isSummon || u.neutralPassive || u.flying) return;
    this.corpses.set(this.nextCorpseId, {
      id: this.nextCorpseId,
      deadId: u.id,
      unitId: u.typeId,
      x: u.x,
      y: u.y,
      facing: u.facing,
      owner: u.owner,
      isHero: u.isHero,
      mechanical: u.mechanical,
      decayLeft: CORPSE_TOTAL_TIME,
      raised: false,
    });
    this.nextCorpseId++;
  }

  private tickCorpses(dt: number): void {
    for (const c of this.corpses.values()) {
      c.decayLeft -= dt;
      if (c.decayLeft <= 0) this.corpses.delete(c.id);
    }
  }

  /** Corpses within `radius` of a point, freshest first, excluding hero corpses
   *  and already-raised ones (used by Resurrection / Raise Dead / Cannibalize). */
  corpsesNear(x: number, y: number, radius: number): SimCorpse[] {
    const out: SimCorpse[] = [];
    for (const c of this.corpses.values()) {
      if (c.raised || c.isHero) continue;
      if (Math.hypot(c.x - x, c.y - y) > radius) continue;
      out.push(c);
    }
    return out.sort((a, b) => b.decayLeft - a.decayLeft);
  }

  /** Mark up to `max` friendly corpses near a point as raised, emitting a summon
   *  request to re-create each as a living unit for `owner`. Returns the count. */
  raiseNearbyCorpsesInternal(x: number, y: number, radius: number, owner: number, team: number, max: number): number {
    let raised = 0;
    for (const c of this.corpses.values()) {
      if (raised >= max) break;
      if (c.raised || c.isHero || c.mechanical || !c.unitId) continue;
      if (Math.hypot(c.x - x, c.y - y) > radius) continue;
      c.raised = true; // the renderer hides the corpse model once raised
      this.summonRequests.push({ unitId: c.unitId, x: c.x, y: c.y, facing: c.facing, owner, team, summonLeft: 0, sourceId: 0 });
      raised++;
    }
    return raised;
  }

  private unitsInAreaInternal(x: number, y: number, radius: number): SimUnit[] {
    const out: SimUnit[] = [];
    for (const t of this.units.values()) {
      if (t.hp <= 0) continue;
      if (Math.hypot(t.x - x, t.y - y) - t.radius <= radius) out.push(t);
    }
    return out;
  }

  // === SpellApi (what spell handlers may do to the world) ===================

  private spellApi: SpellApi = {
    rng: () => this.rng(),
    getUnit: (id) => this.units.get(id),
    unitsInArea: (x, y, r) => this.unitsInAreaInternal(x, y, r),
    hostile: (a, b) => this.hostile(a, b),
    ally: (a, b) => this.allied(a, b),
    spellDamage: (t, amount, src) => this.landDamage(t, amount, src, false), // ignores armor
    spellHeal: (t, amount) => {
      t.hp = Math.min(t.maxHp, t.hp + amount);
    },
    applyBuff: (t, buff) => this.applyBuffInternal(t, buff),
    dispel: (t) => {
      t.buffs = []; // Dispel Magic clears all timed buffs (auras re-apply next tick)
    },
    requestSummon: (unitId, x, y, facing, owner, team, dur, src) => {
      this.summonRequests.push({ unitId, x, y, facing, owner, team, summonLeft: dur, sourceId: src });
    },
    raiseNearbyCorpses: (x, y, r, owner, team, max) => this.raiseNearbyCorpsesInternal(x, y, r, owner, team, max),
    emitEffect: (art, x, y, targetId) => {
      if (art) this.spellEffects.push({ art, x, y, targetId, z: 0 });
    },
    addSpellField: (f) => this.addSpellFieldInternal(f),
    burnMana: (t, amount) => {
      const burned = Math.min(t.mana, Math.max(0, amount));
      t.mana -= burned;
      return burned;
    },
    teleport: (u, x, y) => this.teleportUnit(u, x, y),
    changeOwner: (u, owner, team) => {
      u.owner = owner;
      u.team = team;
    },
    killUnit: (u) => this.kill(u),
  };

  /** Relocate a unit instantly and re-settle it onto the pathing grid (Blink,
   *  Mass Teleport). Clears its current path so it doesn't walk back. */
  private teleportUnit(u: SimUnit, x: number, y: number): void {
    this.unsettle(u);
    if (this.grid && !u.flying) {
      const [cx, cy] = this.grid.worldToCell(x, y);
      const spot = this.grid.nearestFit(cx, cy, u.footprint, 12) ?? this.grid.nearestWalkable(cx, cy, 12);
      if (spot) [x, y] = this.grid.cellToWorld(spot[0], spot[1]);
    }
    u.x = x;
    u.y = y;
    u.prevX = x;
    u.prevY = y;
    u.path = [];
    u.waypoint = 0;
    u.moving = false;
    if (!u.flying) this.settle(u);
  }

  // === drains (renderer pulls these each frame) =============================

  /** Spell/effect models to play this frame (targetId>0 = follow that unit). */
  drainSpellEffects(): Array<{ art: string; x: number; y: number; targetId: number; z: number }> {
    if (!this.spellEffects.length) return this.spellEffects;
    const out = this.spellEffects;
    this.spellEffects = [];
    return out;
  }
  /** Casts that began this frame (renderer plays the cast animation). */
  drainCastStarts(): Array<{ casterId: number; code: string; abilityId: string }> {
    if (!this.castStarts.length) return this.castStarts;
    const out = this.castStarts;
    this.castStarts = [];
    return out;
  }
  /** Heroes that leveled up this frame (renderer plays the level-up nova). */
  drainLevelUps(): Array<{ unitId: number; level: number }> {
    if (!this.levelUps.length) return this.levelUps;
    const out = this.levelUps;
    this.levelUps = [];
    return out;
  }
  /** Units summoned/raised this frame — the renderer creates their models. */
  drainSummonRequests(): Array<{ unitId: string; x: number; y: number; facing: number; owner: number; team: number; summonLeft: number; sourceId: number }> {
    if (!this.summonRequests.length) return this.summonRequests;
    const out = this.summonRequests;
    this.summonRequests = [];
    return out;
  }

  tick(dt: number): void {
    this.timeOfDay = (this.timeOfDay + dt * GAME_HOURS_PER_SEC) % 24;
    this.tickBuildings(dt);
    this.applyAuras(); // refresh aura buffs on in-range allies (before recompute)
    for (const u of this.units.values()) {
      if (this.tickBuffs(u, dt)) continue; // decay timed effects (a DoT may kill)
      this.recomputeStats(u); // derive armour/speed/damage/regen/stun/invuln
      this.tickRegen(u, dt); // mana + (hero) hp regeneration
      if (u.cooldownLeft > 0) u.cooldownLeft -= dt;
      if (u.repathT > 0) u.repathT -= dt;
      for (const a of u.abilities) if (a.cooldownLeft > 0) a.cooldownLeft -= dt;
      if (u.summonLeft > 0) {
        u.summonLeft -= dt;
        if (u.summonLeft <= 0) {
          this.kill(u); // temporary summon (Water Elemental) expired
          continue;
        }
      }
      u.prevX = u.x;
      u.prevY = u.y;
      if (u.spawning > 0) {
        u.spawning -= dt; // still materializing (playing its birth clip) — can't act
        continue;
      }
      if (u.stunned) {
        this.interruptForStun(u); // stunned units can't act this tick
        continue;
      }
      // Neutral Hostile creeps run a guard/leash/sleep controller on top of the
      // normal order handling. It returns true when it has taken the unit over for
      // this tick (asleep at its post, or leashing home) — skip the order switch;
      // movement still runs in tickMovement so a returning creep keeps walking home.
      if (u.isCreep && this.tickCreep(u, dt)) continue;
      switch (u.order) {
        case "move":
          // Movement itself is driven by tickMovement while u.moving stays true;
          // this only restarts a move that a stun/interrupt paused.
          if (!u.moving && u.waypoint < u.path.length) u.moving = true;
          break;
        case "attack":
          this.tickAttack(u);
          break;
        case "cast":
          this.tickCast(u, dt); // walk into range, then fire the spell effect
          break;
        case "follow":
          this.tickFollow(u);
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
          if (!u.moving && u.waypoint < u.path.length) u.moving = true; // resume after a stun
          this.tickAcquire(u, dt); // engage enemies encountered en route
          break;
        case "idle":
          // Autocast (toggled-on Heal/Slow/…) gets first refusal, then auto-attack.
          if (!this.tickAutocast(u)) this.tickAcquire(u, dt);
          break;
      }
    }
    this.tickMovement(dt);
    this.resolveCollisions();
    this.tickProjectiles(dt);
    this.tickSpellFields(dt); // Blizzard-style repeating area effects
    this.tickCorpses(dt); // decay flesh→bone→gone
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
    // Nothing to fight nearby: autocast (Heal/Slow/…) if the caster has one, then
    // resume toward the attack-move destination (WC3 casters heal on the march).
    u.targetId = null;
    u.inCombat = false;
    if (this.tickAutocast(u)) return; // a cast started — hold and cast
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

  /** How much of a threat a target is to a creep, for target selection: armed
   *  units (incl. heroes) rank above helpless units, which rank above buildings.
   *  Creeps "attack enemy units first" instead of chewing a structure while an
   *  army stands on them. Same tier → distance breaks the tie (see bestCreepTarget). */
  private threatTier(t: SimUnit): number {
    if (t.building) return 0; // structures last
    if (t.weapon) return 2; // armed units / heroes first
    return 1; // unarmed units (workers) in between
  }

  /** Highest-threat hostile within `range` for a creep — the biggest threat tier,
   *  nearest within that tier. This is what makes a camp focus the real threat
   *  rather than the nearest thing. */
  private bestCreepTarget(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestTier = -1;
    let bestGap = Infinity;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap > range) continue;
      const tier = this.threatTier(t);
      if (tier > bestTier || (tier === bestTier && gap < bestGap)) {
        bestTier = tier;
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
      attackType: w.attackType,
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
        if (p.spell) {
          // Spell missile (Storm Bolt/Death Coil): run the ability effect on impact.
          // Resolve the exact ability by id (several abilities share a base code).
          const caster = this.units.get(p.sourceId) ?? t; // caster may have died mid-flight
          const def = this.abilities?.get(p.spell.abilityId);
          this.applySpellEffect(p.spell.code, p.spell.rank, caster, { targetId: t.id, x: t.x, y: t.y }, def);
        } else {
          const dealt = this.applyDamage(t, p.damage, p.sourceId, p.attackType ?? "");
          if (dealt > 0) this.applyArrowAutocast(this.units.get(p.sourceId), t); // Searing/Frost/Black/Incinerate arrows
        }
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

  /** Follow a leader: trail it at FOLLOW_GAP, parking when close and re-approaching
   *  when it moves off. No target acquisition — a follower only follows (WC3). If
   *  the leader dies/vanishes, stop where we stand. A group told to follow one unit
   *  carries a formation offset (followOff*) so each holds a distinct slot around
   *  the leader instead of stacking on its centre and shoving. */
  private tickFollow(u: SimUnit): void {
    const t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    if (!t) {
      this.stop(u.id);
      return;
    }
    // Fanned follower: home on its slot (leader centre + offset). The slot moves
    // with the leader, so it trails while keeping its place in the spread.
    if (u.followOffX !== 0 || u.followOffY !== 0) {
      const ax = t.x + u.followOffX;
      const ay = t.y + u.followOffY;
      const d = Math.hypot(ax - u.x, ay - u.y);
      // Same hysteresis as the lone case (see below), measured to the slot.
      const arrive = u.moving ? FOLLOW_SLOT_ARRIVE : FOLLOW_SLOT_ARRIVE + FOLLOW_LEASH;
      if (d > arrive) {
        this.chasePoint(u, ax, ay);
      } else {
        if (u.moving) this.settle(u);
        u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x); // face the leader while parked
      }
      return;
    }
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    // Hysteresis: while parked, tolerate the leader drifting out to FOLLOW_GAP +
    // FOLLOW_LEASH before re-chasing, so small leader movements (or the settle
    // snap) don't oscillate the walk↔stand clip — the follow-animation "jiggle".
    const chaseGap = u.moving ? FOLLOW_GAP : FOLLOW_GAP + FOLLOW_LEASH;
    if (gap > chaseGap) {
      this.chase(u, t); // approach (chasePoint repaths as the leader strays)
    } else {
      if (u.moving) this.settle(u); // caught up — hold position near the leader
      u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    }
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
    u.chopSeq++; // renderer re-triggers the chop swing so it stays in phase with the SFX
    this.chops.push(u.id); // axe landed → renderer plays the chop SFX
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
    // Critical Strike (Blademaster passive AOcr): a chance to multiply the swing.
    const raw = this.applyCriticalStrike(attacker, this.rollDamage(attacker.weapon!));
    const dealt = this.applyDamage(target, raw, attacker.id, attacker.weapon?.attackType ?? "");
    // Cleaving Attack (Pit Lord passive ANca): splash a fraction to nearby enemies.
    if (dealt > 0) this.applyCleave(attacker, target, raw);
    // Vampiric Aura: the attacker heals for a fraction of the melee damage dealt.
    if (attacker.lifesteal > 0 && dealt > 0 && attacker.hp > 0) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + dealt * attacker.lifesteal);
    }
    // Thorns Aura: the target returns a fraction of the damage to the attacker.
    if (target.thorns > 0 && dealt > 0) this.landDamage(attacker, dealt * target.thorns, target.id, false);
    this.tryBash(attacker, target); // passive: a chance to stun on a landed attack
  }

  /** Apply already-rolled PHYSICAL damage: reduced by the target's armor value,
   *  plays the weapon-impact SFX. Returns the HP actually removed (0 if immune). */
  /** Autocast attack modifiers that fire on a landed ranged hit: Searing Arrows
   *  (AHfa) / Black Arrow (ANba) / Incinerate (ANia) add bonus fire damage; Cold &
   *  Frost Arrows (AHca) slow the target. Each spends the ability's per-shot mana. */
  private applyArrowAutocast(attacker: SimUnit | undefined, target: SimUnit): void {
    if (!attacker || !this.abilities || target.hp <= 0) return;
    for (const ab of attacker.abilities) {
      if (!ab.autocastOn || ab.level < 1) continue;
      if (ab.code !== "AHfa" && ab.code !== "ANba" && ab.code !== "ANia" && ab.code !== "AHca") continue;
      const def = this.abilities.get(ab.id);
      if (!def) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (attacker.mana < lvl.cost) continue;
      attacker.mana -= lvl.cost;
      if (ab.code === "AHca") {
        const d = target.isHero && lvl.heroDuration > 0 ? lvl.heroDuration : lvl.duration || 4;
        this.applyBuffInternal(target, { kind: "slow", group: "coldarrow", timeLeft: d, value: this.dataOf(lvl, 0, 0.25) || 0.25, value2: this.dataOf(lvl, 1, 0.25) || 0.25, sourceId: attacker.id, art: def.targetArt });
      } else {
        const bonus = this.dataOf(lvl, 0, 10) || 10;
        this.landDamage(target, bonus, attacker.id, false);
      }
      if (def.targetArt) this.spellEffects.push({ art: def.targetArt, x: target.x, y: target.y, targetId: target.id, z: 0 });
    }
  }

  private applyDamage(target: SimUnit, rawDamage: number, attackerId: number, attackType = ""): number {
    // Evasion (Demon Hunter passive AEev): a chance to dodge a physical attack.
    if (this.tryEvade(target)) return 0;
    // WC3 damage table: the weapon's attack type vs the target's armor type scales
    // the hit (Normal +50% vs Medium, Pierce ×2 vs Light/Unarmored, Siege ×1.5 vs
    // Fortified, Magic ×2 vs Heavy, …). Applied before the armor-value reduction;
    // both are multiplicative so order is immaterial.
    const typeMult = damageMultiplier(attackType, target.armorType);
    // WC3 armor reduction: each armor point is worth 6% of pre-armor damage.
    const reduction = (target.armor * 0.06) / (1 + 0.06 * Math.max(0, target.armor));
    return this.landDamage(target, rawDamage * typeMult * (1 - reduction), attackerId, true);
  }

  /** Critical Strike (AOcr): dataB chance to multiply the swing damage by dataC. */
  private applyCriticalStrike(attacker: SimUnit, damage: number): number {
    const lvl = this.passiveLevelData(attacker, "AOcr");
    if (!lvl) return damage;
    const chance = this.dataOf(lvl, 1); // dataB — crit chance
    const mult = this.dataOf(lvl, 2, 2); // dataC — damage multiplier
    return chance > 0 && this.rng() < chance ? damage * mult : damage;
  }

  /** Evasion (AEev): dataA chance for the DEFENDER to dodge a physical attack. */
  private tryEvade(target: SimUnit): boolean {
    const lvl = this.passiveLevelData(target, "AEev");
    if (!lvl) return false;
    const chance = this.dataOf(lvl, 0); // dataA — evasion chance
    return chance > 0 && this.rng() < chance;
  }

  /** Cleaving Attack (ANca): the attacker splashes dataA of its swing to other
   *  enemies within a short radius of the struck target (armor-reduced). */
  private applyCleave(attacker: SimUnit, target: SimUnit, rawDamage: number): void {
    const lvl = this.passiveLevelData(attacker, "ANca");
    if (!lvl) return;
    const frac = this.dataOf(lvl, 0); // dataA — cleave fraction
    if (frac <= 0) return;
    const radius = this.dataOf(lvl, 3, 200) || 200; // dataD — cleave radius
    for (const t of this.unitsInAreaInternal(target.x, target.y, radius)) {
      if (t === target || t === attacker || t.building || !this.hostile(attacker, t)) continue;
      this.landDamage(t, rawDamage * frac, attacker.id, false); // splash ignores further armor tables
    }
  }

  /** Apply FINAL (post-reduction) damage: death, return fire, and (for physical
   *  hits) the impact SFX. Spell damage calls this directly with recordHit=false —
   *  WC3 ability damage ignores the armor value and plays its own effects. Returns
   *  the HP removed (0 if the target was invulnerable). */
  private landDamage(target: SimUnit, amount: number, attackerId: number, recordHit: boolean): number {
    if (target.invulnerable) return 0; // Divine Shield / Avatar: immune to damage
    // Sleep (Dreadlord) breaks the instant the sleeper takes damage (WC3).
    if (target.buffs.some((b) => b.kind === "sleep")) target.buffs = target.buffs.filter((b) => b.kind !== "sleep");
    // Mana Shield (Naga): absorb incoming damage into mana at `value` mana per hp.
    amount = this.absorbWithManaShield(target, amount);
    if (amount <= 0) return 0;
    if (recordHit) this.hits.push({ attackerId, targetId: target.id });
    target.hp -= amount;
    if (target.hp <= 0) {
      this.kill(target, attackerId);
      return amount;
    }
    // A struck creep wakes and, being in combat, resets its "head home" timer —
    // so while it's between the soft and hard guard limits, continued attacks keep
    // it fighting (MiscGame: it only leaves after GuardReturnTime *unattacked*).
    if (target.isCreep) {
      target.asleep = false;
      target.strayT = 0;
    }
    // Retaliate: an idle armed victim turns on its attacker (WC3 return fire),
    // unless the attacker has since died mid-flight. A creep leashing home ignores
    // attackers until it's back at its post (it prioritises returning).
    const attacker = this.units.get(attackerId);
    if (target.order === "idle" && target.weapon && !target.returning && attacker) {
      this.issueAttack(target.id, attackerId);
    }
    // Creep "call for help" (Battle.net creep basics): attacking one creep rallies
    // its whole camp — every camp-mate within CREEP_CALL_FOR_HELP aggros the
    // attacker at once, even one still out of its own acquisition range.
    if (target.isCreep && attacker && this.hostile(target, attacker)) {
      this.alertCamp(target, attacker);
    }
    // "Creeps will also call for help if you attack another unit currently being
    // targeted by those creeps." Only a NON-creep attacker striking a NON-creep
    // victim can trigger this (a creep is never hostile to a fellow creep, and no
    // creep ever targets a camp-mate), so the reverse-target scan is skipped in the
    // common player↔creep exchanges where it could never fire.
    else if (attacker && !attacker.isCreep && !target.isCreep) {
      for (const c of this.units.values()) {
        if (c.isCreep && c.hp > 0 && !c.returning && c.targetId === target.id && this.hostile(c, attacker)) {
          this.alertCamp(c, attacker);
        }
      }
    }
    return amount;
  }

  /** Mana Shield (Naga Sea Witch, ANms): redirect incoming damage into the unit's
   *  mana. `value` = mana consumed per hp absorbed; the shield covers as much as the
   *  mana pool allows, then any overflow damage falls through to hp. */
  private absorbWithManaShield(u: SimUnit, amount: number): number {
    if (amount <= 0 || u.mana <= 0) return amount;
    const buff = u.buffs.find((b) => b.kind === "manaShield");
    if (!buff) return amount;
    const perHp = buff.value > 0 ? buff.value : 1;
    const absorbable = Math.min(amount, u.mana / perHp);
    u.mana -= absorbable * perHp;
    return amount - absorbable;
  }

  /** Reincarnation (AOre): if a dying hero has it learned and off cooldown, revive
   *  it in place at full HP/mana, put the ability on cooldown, and keep it alive. */
  private tryReincarnate(u: SimUnit): boolean {
    if (!u.isHero || u.hp > 0) return false;
    const ab = u.abilities.find((a) => a.code === "AOre" && a.level >= 1 && a.cooldownLeft <= 0);
    if (!ab || !this.abilities) return false;
    const def = this.abilities.get(ab.id);
    if (!def) return false;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    ab.cooldownLeft = lvl.cooldown > 0 ? lvl.cooldown : 240;
    u.hp = u.maxHp;
    u.mana = u.maxMana;
    u.buffs = u.buffs.filter((b) => b.kind === "manaShield"); // clear debuffs on revive
    if (def.targetArt || def.casterArt) this.spellEffects.push({ art: def.targetArt || def.casterArt, x: u.x, y: u.y, targetId: u.id, z: 0 });
    return true;
  }

  private kill(u: SimUnit, killerId = 0): void {
    // Reincarnation (Tauren Chieftain / Elder Sage, AOre): a fatal blow instead
    // revives the hero in place, on a long cooldown (stored on the ability).
    if (this.tryReincarnate(u)) return;
    this.refundPendingBuild(u); // died before its building went up → refund the cost
    this.unsettle(u); // corpses don't block cells
    if (u.inMine) {
      const mine = this.mines.get(u.resId);
      if (mine) mine.busy = false; // don't wedge the mine shut forever
    }
    if (u.constructing) this.detachBuilder(u.id); // free the halted construction
    this.awardKillXp(u, killerId); // enemy heroes near the kill gain experience
    this.spawnCorpse(u); // leave a decaying corpse (targetable by corpse spells)
    this.units.delete(u.id); // Map delete during values() iteration is safe
    this.deaths.push(u.id);
  }

  // Idle (or patrolling) armed units scan for the nearest enemy in acquisition
  // range and turn on it. Creeps acquire within their own aggro range (from the
  // map's per-unit target-acquisition, else the weapon's), and never while asleep
  // or leashing home; acquiring rallies the rest of their camp (call-for-help).
  private tickAcquire(u: SimUnit, dt: number): void {
    if (!u.weapon) return;
    if (u.isCreep && (u.asleep || u.returning)) return;
    const range = u.isCreep ? u.aggroRange : u.weapon.acquire;
    if (range <= 0) return;
    u.acquireT -= dt;
    if (u.acquireT > 0) return;
    u.acquireT = ACQUIRE_PERIOD;
    // Creeps pick the highest-threat target (enemy units before buildings); other
    // units keep WC3's plain nearest-enemy acquisition.
    const best = u.isCreep ? this.bestCreepTarget(u, range) : this.nearestEnemy(u, range);
    if (best) {
      this.issueAttack(u.id, best.id);
      if (u.isCreep) this.alertCamp(u, best);
    } else if (u.isCreep) {
      // Nothing in our own aggro range, but if a camp-mate is still fighting, go
      // help — no creep sits idle at the post while its camp is in a fight.
      const help = this.campFightTarget(u);
      if (help) this.issueAttack(u.id, help.id);
    }
  }

  // === neutral-hostile creep guard AI =======================================

  /** Drive a creep's guard/leash/sleep behaviour, run before the order switch.
   *  Returns true when it has handled the unit this tick (asleep or leashing
   *  home) so the caller skips the normal order logic. */
  private tickCreep(u: SimUnit, dt: number): boolean {
    const atHome = Math.hypot(u.x - u.guardX, u.y - u.guardY) <= CREEP_HOME_EPS;
    // --- sleep (night): doze off while guarding at the post, with no hostile
    // right on top of us; dawn (or the checks below) wakes it. ---
    if (u.canSleep && !u.returning) {
      if (this.isDay) u.asleep = false;
      else if (!u.asleep && u.order === "idle" && atHome && !this.nearestEnemy(u, SLEEP_WAKE_RANGE)) u.asleep = true;
    } else if (!u.canSleep) {
      u.asleep = false;
    }
    if (u.asleep) {
      // A hostile straying very close wakes it (else you can scout past at night).
      if (this.nearestEnemy(u, SLEEP_WAKE_RANGE)) {
        u.asleep = false;
        return false; // awake now — let it acquire this tick
      }
      u.inCombat = false;
      this.settle(u);
      u.desiredFacing = u.guardFacing;
      return true; // still asleep — stand at the post
    }
    // --- leashing home: ignore enemies until back at the post ---
    if (u.returning) {
      this.tickCreepReturn(u, dt);
      return true;
    }
    // --- fighting: leash back once we've strayed too far from the post ---
    const engaged = u.order === "attack" && u.targetId !== null && this.units.has(u.targetId);
    const dist = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    if (engaged) {
      // Stay on the biggest threat: periodically upgrade off a low-threat target
      // (e.g. a building) onto a real unit that walked into range.
      u.acquireT -= dt;
      if (u.acquireT <= 0) {
        u.acquireT = ACQUIRE_PERIOD;
        const cur = this.units.get(u.targetId!)!;
        const best = this.bestCreepTarget(u, u.aggroRange);
        if (best && best.id !== cur.id && this.threatTier(best) > this.threatTier(cur)) {
          this.issueAttack(u.id, best.id);
        }
      }
      if (dist >= MAX_GUARD_DISTANCE) {
        this.beginCreepReturn(u); // dragged out past the hard limit — always go home
        return true;
      }
      if (dist >= GUARD_DISTANCE) {
        // Past the soft limit: normally head home after chasing GUARD_RETURN_TIME
        // unattacked (each hit resets strayT in landDamage). But do NOT peel off
        // while a camp-mate is still in the fight — the camp commits as one and
        // breaks off together (or at the hard MaxGuardDistance above). This is what
        // stops a single creep being left fighting at max range while the rest sit.
        if (this.campFightTarget(u)) {
          u.strayT = 0;
        } else {
          u.strayT += dt;
          if (u.strayT >= GUARD_RETURN_TIME) {
            this.beginCreepReturn(u);
            return true;
          }
        }
      } else {
        u.strayT = 0;
      }
      return false; // keep fighting
    }
    // Guarding: nothing to fight. If displaced from the post (e.g. a target just
    // died out in the field) and no new enemy is in range, walk back home. The
    // trigger uses CREEP_RETURN_TRIGGER, NOT the tighter CREEP_HOME_EPS the return
    // finishes at — the gap between them is the hysteresis that stops the settle
    // snap from re-triggering a return every tick (the return "jiggle").
    u.strayT = 0;
    if (u.order === "idle" && dist > CREEP_RETURN_TRIGGER && !this.nearestEnemy(u, u.aggroRange)) {
      // About to walk home — but if a camp-mate is still fighting, go help instead
      // of standing down while the camp is engaged.
      const help = u.weapon ? this.campFightTarget(u) : null;
      if (help) {
        this.issueAttack(u.id, help.id);
        return false;
      }
      this.beginCreepReturn(u);
      return true;
    }
    return false;
  }

  /** Begin leashing a creep back to its guard point. */
  private beginCreepReturn(u: SimUnit): void {
    u.returning = true;
    u.targetId = null;
    u.inCombat = false;
    this.cancelSwing(u);
    u.strayT = 0;
    u.returnBestDist = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    u.returnStuckT = 0;
    u.order = "move";
    if (!this.pathTo(u, u.guardX, u.guardY)) u.desiredFacing = Math.atan2(u.guardY - u.y, u.guardX - u.x);
  }

  /** Advance a leashing creep: walk home, and — if it can't make progress for
   *  GUARD_RETURN_TIME (boxed in / body-blocked) — give up and fight again where
   *  it stands (so a player can't kite it forever against a wall). */
  private tickCreepReturn(u: SimUnit, dt: number): void {
    const d = Math.hypot(u.x - u.guardX, u.y - u.guardY);
    if (d <= CREEP_HOME_EPS) {
      this.finishCreepReturn(u); // back at the post — resume guarding
      return;
    }
    if (d < u.returnBestDist - ARRIVE_EPS) {
      u.returnBestDist = d; // getting closer — reset the give-up timer
      u.returnStuckT = 0;
    } else {
      u.returnStuckT += dt;
      if (u.returnStuckT >= GUARD_RETURN_TIME) {
        u.returning = false; // can't get home — resume fighting from here
        u.returnStuckT = 0;
        u.order = "idle";
        this.settle(u);
        return;
      }
    }
    if (!u.moving) {
      // Stopped short of home (path blocked when computed) — try again toward it.
      if (this.pathTo(u, u.guardX, u.guardY)) u.order = "move";
      else u.desiredFacing = Math.atan2(u.guardY - u.y, u.guardX - u.x);
    }
  }

  /** A creep reached its guard point: face its guard heading and resume guarding
   *  (it will re-acquire any enemies still in range next tick). It keeps whatever
   *  HP it had — no return-to-camp heal (removed at the maintainer's request). */
  private finishCreepReturn(u: SimUnit): void {
    u.returning = false;
    u.returnStuckT = 0;
    u.strayT = 0;
    u.order = "idle";
    this.settle(u);
    u.desiredFacing = u.guardFacing;
  }

  /** Two creeps belong to the same camp when their guard posts were placed within
   *  CreepCallForHelp of each other. Membership is keyed to the fixed GUARD points,
   *  NOT live positions — so a creep dragged out to the edge of its leash still
   *  counts as a camp-mate and can rally (or be rallied by) the ones back home. */
  private sameCamp(a: SimUnit, b: SimUnit): boolean {
    return Math.hypot(a.guardX - b.guardX, a.guardY - b.guardY) <= CREEP_CALL_FOR_HELP;
  }

  /** Camp cohesion (MiscGame CreepCallForHelp): a creep that engages a target
   *  wakes every sleeping camp-mate and pulls idle ones onto the same target —
   *  "a creep camp acts as one unit; attack one and they all attack" (Battle.net
   *  creep basics). Leashing camp-mates are left alone. */
  private alertCamp(u: SimUnit, target: SimUnit): void {
    for (const c of this.units.values()) {
      if (c === u || !c.isCreep || c.hp <= 0 || c.returning) continue;
      if (!this.sameCamp(c, u)) continue;
      c.asleep = false; // rouse the camp
      if (c.order === "idle" && c.weapon && this.hostile(c, target)) this.issueAttack(c.id, target.id);
    }
  }

  /** A hostile currently being fought by a live camp-mate of `u`, or null. Used to
   *  keep the camp committed as one: while any member is engaged, the rest rejoin
   *  rather than idling at the post or peeling off home — even when the fight has
   *  been kited out near the leash limit (the exact case where a lone creep used to
   *  be left fighting while its camp sat back). */
  private campFightTarget(u: SimUnit): SimUnit | null {
    for (const c of this.units.values()) {
      if (c === u || !c.isCreep || c.hp <= 0 || c.returning) continue;
      if (c.order !== "attack" || c.targetId === null) continue;
      if (!this.sameCamp(c, u)) continue;
      const t = this.units.get(c.targetId);
      if (t && this.hostile(u, t)) return t;
    }
    return null;
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
      if (u.yieldT > 0) {
        // Giving way to an oncoming unit: hold position this tick (the shared
        // turning pass still lets it keep facing its heading) so the other passes.
        u.yieldT -= dt;
        continue;
      }
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
            if (closing && a.yieldT <= 0 && b.yieldT <= 0) {
              // Head-on: rather than both sidestepping forever (the "dance"), the
              // lower-priority unit (higher id) pauses a beat so the other clears.
              // The guard (neither already yielding) keeps it a one-shot pause per
              // encounter, not a re-armed freeze; checkStuck() is the backstop if the
              // way never opens.
              (a.id > b.id ? a : b).yieldT = YIELD_TIME;
            }
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
