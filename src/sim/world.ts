import { PATHING_CELL, footprintCells, type PathingGrid } from "./pathing";
import { findPath, smoothPath } from "./pathfind";
import { unstampFootprint, type Footprint } from "./destructibles";
import { type AbilityRegistry, type AbilityDef, type AbilityLevel, type BuffFx, requiredHeroLevel, KNOWN_ABILITIES } from "../data/abilities";
import { type ItemRegistry, type ItemDef } from "../data/items";
import { type UnitDef, type UnitRegistry } from "../data/units";
import { type TechRegistry } from "../data/techtree";
import { type UpgradeRegistry } from "../data/upgrades";
import { TechState } from "./tech";
import { AttackType, ArmorType, PrimaryAttribute, isRangedWeapon } from "../data/enums";
import {
  MISC_DATA,
  MISC_GAME,
  MELEE,
  GAME_HOURS_PER_SEC,
  armorDamageReduction,
  creepXpFactor,
  damageMultiplier,
  etherealDamageMultiplier,
  ETHEREAL_SPELL_BONUS,
  grantedXp,
  xpToReachLevel,
} from "../data/gameplayConstants";
import { SPELL_HANDLERS, AURA_BUFFS, POLARITY_SPELLS, HEAL_SPELLS, waveSchedule, WAVE_FIELDS, fx, type SpellApi, type SimBuffInit, type SpellFieldInit } from "./spells";

// Headless simulation (plan §1.4, Phase 5/6). Owns unit game-state; the renderer
// only displays it. Fixed-timestep, no rendering or DOM deps — runnable in tests
// and (later) on the authoritative server.

/** Weapon stats (from UnitWeapons.slk). Damage per swing = damage + dice d sides,
 *  reduced by the target's armor (WC3 formula). */
export interface SimWeapon {
  // Live values — recomputeStats() rebuilds these every tick from the base* baselines below,
  // so a mid-game Forged Swords lifts every Footman already on the field.
  damage: number;
  dice: number;
  sides: number;
  cooldown: number; // seconds between swings
  damagePoint: number; // seconds from swing start to the strike/projectile launch
  /** Seconds of follow-through AFTER the strike. Never gates the cooldown. Hasted/slowed with
   *  the damage point, so the pair's live/base ratio recovers the attack-speed factor — which
   *  is the rate the renderer plays the swing clip at (see rts.ts attackAnimRate). */
  backswing: number;
  range: number; // measured between collision hulls, WC3-style
  // Pre-upgrade baselines, straight off this slot's UnitWeapons columns.
  baseDamage: number;
  baseDice: number;
  baseRange: number;
  baseCooldown: number;
  baseDamagePoint: number;
  baseBackswing: number;
  /** Whether this slot may be used at all: its bit in `weapsOn`, which the `renw` upgrade
   *  effect can rewrite (Flying Machine Bombs switches the bomb slot on). See WeaponSlotDef. */
  enabled: boolean;
  /** "Targets Allowed" (`targs1`/`targs2`). A weapon strikes a target only if its list admits
   *  it — `air` for a flyer, `structure` for a building, `ground` for everything else — which
   *  is why a Footman cannot answer a Gryphon Rider and a Siege Engine only knocks down walls.
   *  Empty = unrestricted (a summon or custom unit with no data). See weaponVs(). */
  targets: string[];
  // Line-splash ("spill"): the hit carries down the missile's line, `spillDist` past the
  // target, catching anything within `spillRadius` of it and shedding `damageLoss` of the
  // damage per further body. Storm Hammers (`rasd`) is nothing but a spillDist of 200.
  spillDist: number;
  spillRadius: number;
  baseSpillDist: number; // pre-upgrade (`rasd`/`rasr` add to these, as Long Rifles adds to range)
  baseSpillRadius: number;
  damageLoss: number;
  acquire: number; // auto-acquisition range (0 = never auto-attacks)
  ranged: boolean; // fires a travelling projectile instead of hitting instantly
  missileArt: string; // projectile model path (renderer), "" = invisible
  missileSpeed: number; // projectile travel speed (world units/sec)
  attackType: AttackType; // UnitWeapons atkType1 → picks the damage-table row
  // Projectile launch offset (LOCAL frame: x forward, y left, z up; rotated by facing)
  // and impact height — UnitWeapons.slk launchx/y/z, impactz. The missile leaves from
  // launchZ (e.g. the Archmage's rod at 66) rather than the unit's feet.
  launchX: number;
  launchY: number;
  launchZ: number;
  impactZ: number;
}

/** An in-flight projectile: homes on its target's current position, dealing its
 *  pre-rolled damage on arrival (the renderer draws + moves the missile model). */
export interface SimProjectile {
  id: number;
  x: number;
  y: number;
  z: number; // current height ABOVE GROUND (renderer adds terrain height under x/y)
  sourceId: number; // attacker (for retaliation on hit); may have died mid-flight
  targetId: number;
  speed: number;
  damage: number; // pre-armor damage rolled at launch (armor applied on impact)
  art: string; // missile model path
  // Straight-line height interpolation launch→impact (all above-ground): z lerps from
  // startZ (the launch height) to impactZ across the horizontal flight (startDist).
  startZ: number;
  impactZ: number;
  startDist: number;
  attackType?: AttackType; // attacker's weapon attack type, carried so the damage-table
  // multiplier is correct even if the attacker dies before the arrow lands
  /** Line-splash, carried from the weapon so the hit spills even if the shooter dies in
   *  flight. `ox`/`oy` is the launch point — the line's direction is impact-minus-launch,
   *  and the spill runs on PAST the target from there. See applySpill. */
  spill?: { dist: number; radius: number; loss: number; ox: number; oy: number };
  // Spell projectiles (Storm Bolt, Death Coil) run an ability effect on impact
  // instead of dealing plain `damage` — the base code + rank to dispatch.
  spell?: { code: string; rank: number; abilityId: string };
}

/** A unit type's weapon slots as the sim wants them (see WeaponSlotDef for the data behind
 *  each one). A slot carrying no damage at all is dropped — that is how a Town Hall, which has
 *  a UnitWeapons row like everything else, ends up unarmed. A DISABLED slot is KEPT: the Flying
 *  Machine's bombs must be sitting there, switched off, for Flying Machine Bombs to switch on. */
export function weaponsFromDef(def: UnitDef): SimWeapon[] {
  const out: SimWeapon[] = [];
  for (const s of def.weapons) {
    if (s.cooldown <= 0 || s.damage + s.dice * s.sides <= 0) continue;
    // The Rifleman's weapTp1 is "instant" yet he clearly shoots: a missile model on a
    // nominally instant weapon still flies. Either signal makes the attack ranged.
    const ranged = isRangedWeapon(s.weaponType) || s.missileArt !== "";
    out.push({
      damage: s.damage,
      dice: s.dice,
      sides: s.sides,
      cooldown: s.cooldown,
      damagePoint: s.damagePoint,
      backswing: s.backswing,
      range: s.range,
      baseDamage: s.damage,
      baseDice: s.dice,
      baseRange: s.range,
      baseCooldown: s.cooldown,
      baseDamagePoint: s.damagePoint,
      baseBackswing: s.backswing,
      enabled: s.enabled,
      targets: s.targets,
      spillDist: s.spillDist,
      spillRadius: s.spillRadius,
      baseSpillDist: s.spillDist,
      baseSpillRadius: s.spillRadius,
      damageLoss: s.damageLoss,
      // `acquire`, and the launch/impact offsets, are UNIT columns — not per-weapon ones.
      acquire: def.acquireRange,
      ranged,
      missileArt: s.missileArt,
      missileSpeed: s.missileSpeed,
      attackType: s.attackType,
      launchX: def.launchX,
      launchY: def.launchY,
      launchZ: def.launchZ,
      impactZ: def.impactZ,
    });
  }
  return out;
}

export type SimOrder = "idle" | "move" | "attackmove" | "patrol" | "hold" | "attack" | "follow" | "harvest" | "return" | "repair" | "cast" | "getitem" | "garrison";

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
  art: string; // fx[0]'s path — the primary attached model (renderer), "" = none
  /** Every persistent model this buff hangs on the unit, with its attachment point
   *  (see AbilityDef.buffFx). Usually one; Bloodlust wears two, Spiked Carapace four. */
  fx: BuffFx[];
  /** Seconds until the buff's effect actually engages — Wind Walk's "Transition Time"
   *  (AbilityData.slk AOwk DataA = 0.6), the beat between the cast and the vanish. The
   *  buff exists and its duration is already running; it just isn't in force yet. 0 for
   *  everything else, which engages the instant it lands. */
  delay: number;
  /** Shadow Meld (`Ashm`), the one invisibility that is a STANCE rather than a spell. It
   *  never expires on a clock — it holds for as long as its conditions do — so it breaks on
   *  two things no other invisibility cares about: the unit MOVING, and DAY breaking. Both
   *  are checked in tickMeld; everything else (attack, cast) reveals it through the shared
   *  breakInvisibility path, same as Wind Walk. */
  meld?: boolean;
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
  | "root" // value = move-slow fraction (Entangling Roots pins to 1.0); can still attack
  | "vuln" // value = fraction of EXTRA damage the holder takes (Berserk +50%)
  | "shield" // Lightning Shield: value = dps dealt to units around the holder, value2 = radius
  | "ethereal" // Banish: value = move-slow fraction; can't attack, immune to physical
  //            damage but takes +66% from Magic/Spells (see u.ethereal, EtherealDamageBonus)
  | "invisible"; // Wind Walk/Invisibility: the holder renders half-faded (see u.invisible).
  //             CONCEALMENT is modelled — canSee() refuses an invisible unit, so it draws no
  //             aggro down any automatic path — and so is its counterpart, True Sight
  //             (`u.detectRadius`, teamDetects). The SCREEN follows the same rule: rts.ts
  //             (invisHides) hides the unit outright from a viewer who neither owns it nor
  //             detects it, and fades it for the ones who may see it.

/** An in-progress spell cast (order === "cast"). The lifecycle, matching WC3
 *  (hiveworkshop "Cast Point and Backswing Point" thread 265781): walk into range
 *  and face → WIND UP for the cast point (unit `castPoint` + the ability's own
 *  Casting Time) → at its end the effect FIRES and mana/cooldown are committed →
 *  then either CHANNEL (the caster stands locked; a new order stops it and the
 *  remaining ticks) or play a cast BACKSWING (pure recovery a new order cancels
 *  for free — the effect already happened, so canceling costs nothing: the
 *  "animation canceling" micro). Interrupting DURING the wind-up cancels the spell
 *  entirely (no effect, no mana, no cooldown), since nothing has committed yet. */
export interface PendingCast {
  code: string; // base ability code (dispatch)
  abilityId: string; // the SimAbility on the caster (for cooldown/mana)
  rank: number; // ability level being cast
  targetId: number; // unit target (0 = none)
  x: number; // point target
  y: number;
  range: number; // cast range (hull-to-hull); 0 = self/no-target
  castLeft: number; // remaining wind-up before the effect fires (-1 = not yet started)
  started: boolean; // wind-up begun (facing done, cast animation playing)
  committed: boolean; // mana/cooldown already spent (Flame Strike commits at wind-up start)
  fired: boolean; // the effect has fired (mana/cooldown committed) — now channel/backswing
  channelLeft: number; // remaining channel time — the caster stands + holds (Blizzard, Starfall)
  backLeft: number; // remaining cast backswing (recovery) after a non-channelled effect
  // The cast has run its course (endCast fired its SPELL_FINISH/ENDCAST). Set so a
  // stale pendingCast left behind by a resumed order can't raise a second ENDCAST
  // when the unit is later stopped (see clearCast — 7.17).
  ended: boolean;
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

/** An item held in a hero's inventory (one of 6 slots). Its stat bonus / active
 *  effect is derived from the item def's granted abilities (world.ts item logic),
 *  keyed by the base ability `code` — the same dispatch model spells use. */
/** Everything a copy needs to be indistinguishable from its original. Captured at cast time
 *  and carried through the summon request (spawning is async — see drainSummonRequests). */
export interface IllusionInit {
  dealt: number; // fraction of the copy's damage that lands (0)
  taken: number; // multiplier on damage it receives (2)
  properName: string; // the original's given name
  mana: number; // the original's pool after the cast was paid
  level: number; // the original's hero level
  baseStr: number; // base attributes INCLUDING permanent tome gains
  baseAgi: number;
  baseInt: number;
  baseMaxHp: number; // includes Manual of Health
  inventory: ({ itemId: string; charges: number } | null)[]; // what it is seen carrying
}

/** A unit a spell asked to be brought into the world this tick. The sim owns no model
 *  instances, so spawning is deferred to the renderer exactly like training is. */
export interface SummonRequest {
  unitId: string;
  x: number;
  y: number;
  facing: number;
  owner: number;
  team: number;
  summonLeft: number; // >0 = a temporary summon, seconds until it expires
  sourceId: number; // the caster
  summonArt: string; // the burst it materializes in
  unsummonArt: string; // the burst that replaces it when it leaves
  /** (x, y) is a point the player TARGETED (a ward, an infernal, a raised corpse) and the
   *  unit belongs exactly ON it. Without this the placement steps 96 units along `facing`
   *  first, which is right for a caster-relative summon and wrong for every targeted one
   *  (see MapViewerScene.summonSpot). */
  atPoint: boolean;
  illusion?: IllusionInit;
}

export interface HeldItem {
  /** Entity id — the SAME id space (and the same id) the item had on the ground.
   *  An item in WC3 is one entity that moves between the ground and an inventory,
   *  and a JASS `item` handle refers to it across that move: `CreateItem` →
   *  `UnitAddItem` → a PICKUP trigger's `GetManipulatedItem()` must all be the one
   *  item. So identity is carried through pickup/give/drop rather than re-minted
   *  (7.18) — without it the handle would go stale the moment a hero picked it up. */
  id: number;
  itemId: string; // item rawcode (ItemRegistry key)
  charges: number; // remaining uses (0 = a passive/permanent item, no active use)
  cooldownLeft: number; // seconds until this item can be used again
}

/** An item lying on the ground: droppable, pickable, and (in WC3) destructible.
 *  Not a SimUnit — a lightweight entity the renderer draws as the item's model. */
export interface SimItem {
  id: number; // sim entity id (own id space; kept when it moves into an inventory)
  itemId: string; // item rawcode
  x: number;
  y: number;
  charges: number; // charges carried onto the ground (restored when picked back up)
}

/** Where an item is right now — the one lookup the trigger engine needs, since a
 *  JASS `item` handle can refer to an item lying on the ground OR sitting in a
 *  hero's inventory (`holder`/`slot` are 0/-1 for a ground item). */
export interface ItemSnapshot {
  id: number;
  typeId: string; // item rawcode
  charges: number;
  x: number;
  y: number;
  holder: number; // sim id of the unit carrying it (0 = on the ground)
  slot: number; // inventory slot when held, else -1
  /** GetItemPlayer: the holder's owner, or Neutral Passive (15) for an item nobody
   *  carries — WC3 files every unowned item under that slot. */
  owner: number;
}

/** An item manipulated by a unit (EVENT_(PLAYER_)UNIT_PICKUP/DROP/USE/SELL_ITEM —
 *  7.18). The item is a SNAPSHOT, not a live reference, because the event is drained
 *  a tick after the sim raised it and the item may be gone by then (a tome is consumed
 *  on pickup; a potion's last charge destroys it) — GetManipulatedItem must still hand
 *  the script a usable handle, exactly as GetDyingUnit does for a corpse. */
export interface ItemEvent {
  unit: EventUnitInfo; // GetManipulatingUnit (the buyer, for a sale)
  item: { id: number; typeId: string; charges: number };
  phase: "pickup" | "drop" | "use" | "sell";
  /** GetSellingUnit — the SHOP, on a "sell". Blizzard.j's whole Marketplace restock cycle
   *  hangs off it: RemovePurchasedItem answers the sale with
   *  `RemoveItemFromStock(GetSellingUnit(), GetItemTypeId(GetSoldItem()))`. */
  seller?: EventUnitInfo;
}

/** A creep's dropped-item table (from war3mapUnits.doo). Each SET drops (at most)
 *  one item, chosen among its entries by their `chance` percentages; multiple sets
 *  mean multiple independent drops. Ids may be real item rawcodes or a "random item
 *  of level N" marker resolved through the ItemRegistry. */
export interface ItemDropSet {
  items: Array<{ id: string; chance: number }>;
}

/** Attributes + growth for a hero, applied on spawn and each level-up. */
export interface HeroInit {
  /** The hero's randomly-drawn name ("Painkiller"), from the unit's `Propernames`
   *  list in Units\*UnitStrings.txt. "" for heroes with no list (custom units). */
  properName: string;
  level: number;
  str: number;
  agi: number;
  int: number;
  strPerLevel: number;
  agiPerLevel: number;
  intPerLevel: number;
  primaryAttr: PrimaryAttribute;
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
  /** Lumber carried per trip. LIVE value: Improved/Advanced Lumber Harvesting (`rlum`) raises
   *  it above `baseLumberCapacity`, which is why recomputeStats owns it (a Peasant already in
   *  the forest when the research lands starts filling to the new load on its next trip). */
  lumberCapacity: number;
  baseLumberCapacity: number;
  lumberPerChop: number;
  chopPeriod: number; // seconds between chops
  damagesTree: boolean; // wisps harvest without hurting the tree
  carryGold: number;
  carryLumber: number;
}

/** Where a rally point sends newly-produced units. A plain point is a move; a
 *  mine/tree makes new workers harvest it; a unit makes them move to it (WC3). */
export type RallyKind = "point" | "mine" | "tree" | "unit";

/** One job in a building's production queue. A building produces three different kinds of
 *  thing on the SAME queue in WC3 — you cannot train a Footman while the Barracks researches
 *  Defend — so they share one list and are told apart by `kind`:
 *   - "unit"     — train a unit; spawns it at the rally point.
 *   - "research" — an upgrade at `level`; raises the player's researched level on completion.
 *   - "upgrade"  — the building becomes `unitId` (Town Hall → Keep). Morphs in place. */
export type BuildJob =
  // `free` marks the melee free first hero — charged nothing, so it must be refunded nothing.
  // `buyer` is who the job belongs to when the BUILDING's owner isn't the answer: a Tavern is
  // Neutral Passive, so a hero queued there is nobody's by ownership. Without it, a hero player
  // A is hiring counts toward player B's copy count — which is what selects B's requirement
  // tier ("your 2nd hero needs a Keep"). Harmless in 1v1, wrong the moment there are three.
  | { kind: "unit"; unitId: string; timeLeft: number; buildTime: number; free?: boolean; buyer?: number }
  | { kind: "research"; unitId: string; level: number; timeLeft: number; buildTime: number }
  | { kind: "upgrade"; unitId: string; timeLeft: number; buildTime: number };

/** Per-building state: construction progress + a production queue. */
export interface BuildingState {
  constructionLeft: number; // seconds until built (0 = complete)
  buildTimeTotal: number; // full construction time (for the progress fraction)
  builderIds: number[]; // workers constructing (empty → progress halts). Extra
  // builders past the first "speed build" it (human peasants): faster, but they
  // burn extra resources — see SPEED_BUILD_* constants + tickBuildings.
  goldCost: number; // base build cost, for the speed-build surcharge
  lumberCost: number;
  queue: BuildJob[];
  rallyX: number; // trained units gather here (default: just south of the hall)
  rallyY: number;
  rallyKind: RallyKind; // how the rally target is interpreted (point/mine/tree/unit)
  rallyTargetId: number; // mine/tree/unit id for non-point rallies (0 for a point)
  producesUnits: boolean; // trains units → has a rally point (towers etc. don't)
  // Shop stock, when this building sells things (Arcane Vault, Goblin Merchant, Tavern…).
  // Keyed by item/unit id. Absent on everything else. See SHOP stock rules in tickShops().
  //
  // Most shops fill this ONCE, from their data (`Sellitems`/`Makeitems`/`Sellunits`). The
  // Marketplace is the exception and the reason the map is mutable: it declares no wares at
  // all, and Blizzard's own JASS stocks it at runtime — see the AddItemToStock natives.
  stock?: Map<string, ShopStock>;
  /** How many distinct item / unit TYPES this shop may hold (JASS Set[All]ItemTypeSlots).
   *  Blizzard.j's InitNeutralBuildings sets both to 11 (bj_MAX_STOCK_ITEM_SLOTS). Undefined =
   *  use the world default. A full shelf silently refuses further stock, which is what makes
   *  the Marketplace rotate: buying an item frees its slot for the next restock tick. */
  stockItemSlots?: number;
  stockUnitSlots?: number;
}

/** One shop slot's stock. WC3 restocks per ITEM, not per shop: each item has its own
 *  `stockStart` (a delay before the shop first carries it), `stockRegen` (seconds to add one
 *  back) and `stockMax` (the ceiling). ItemData.slk carries these for items, UnitBalance.slk
 *  for the units a Tavern/Mercenary Camp sells. */
export interface ShopStock {
  count: number; // how many are on the shelf right now
  max: number; // stockMax
  regen: number; // stockRegen — seconds per restock tick (0 = never comes back once taken)
  timer: number; // seconds until the next one is added (Infinity = never)
  /** The full span `timer` was last wound to. Purely for the UI: an out-of-stock ware wears the
   *  same clockwise cooldown sweep an ability does, and the sweep needs the fraction
   *  `timer / period` — which the timer alone cannot give (a ware's FIRST arrival is a
   *  `stockStart` wait, not a `stockRegen` one, and the two are different lengths). */
  period: number;
  /** Which id space the key belongs to — one flat map holds both, and the slot caps are
   *  counted per kind (11 item types AND 11 unit types). */
  kind: "item" | "unit";
}

/** Why a shop purchase was refused. The HUD maps these onto the game's own messages in
 *  Units\commandstrings.txt — "A valid patron must be nearby." (Neednearbypatron),
 *  "Inventory is full." (Inventoryfull), and the standard cost/requirement lines. */
export type ShopResult = "ok" | "no" | "nostock" | "nopatron" | "full" | "cost" | "req";

/** Fallback patron reach for a shop whose ability data we can't read. The real numbers come
 *  from the shop ability itself (Aall 600 / Aneu 450); this only covers a broken data load. */
const DEFAULT_SHOP_RADIUS = 450;

/** A shift-queued follow-up order, replayed when the unit's current order ends.
 *  WC3 allows chaining several (up to ~35) — move, attack, harvest, build… */
export type QueuedOrder =
  | { kind: "move"; x: number; y: number }
  | { kind: "attackmove"; x: number; y: number }
  | { kind: "patrol"; x: number; y: number }
  | { kind: "hold" }
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

const MAX_QUEUED_ORDERS = 35; // WC3 action-queue cap (shift-queued ORDERS on a unit)
/** WC3 caps a building's PRODUCTION queue at 7 jobs — training, research and tier upgrades
 *  all share it. A different thing entirely from MAX_QUEUED_ORDERS above. */
const MAX_BUILD_QUEUE = 7;

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
  lumber: number; // remaining lumber a worker can chop before it falls
  hp: number; // destructible HP — drained by tree-damaging spells (Flame Strike), not by harvest
  // Half-extent of the tree's blocked pathing footprint (world units): 64 for the
  // usual 4x4Default tree, 32 for a 2x2Default one. The fog's line-of-sight blocker
  // is stamped over this square, not over the centre point alone (#43).
  blockRadius: number;
}

/** A frozen snapshot of a unit for a trigger event (death/damage/attack). Just enough
 *  for the trigger engine to mint a JASS unit handle (GetDyingUnit/GetEventDamageSource
 *  /GetAttacker/…) even after the unit is gone. */
export interface EventUnitInfo {
  id: number;
  typeId: string;
  owner: number;
  x: number;
  y: number;
  facing: number;
}

/** The unit's owner as the SCRIPT sees it (GetOwningPlayer). Our sim files every neutral
 *  under owner -1 and tells creeps from shops with `neutralPassive`; WC3 gives them real
 *  player slots — Neutral Hostile is **player 12** and Neutral Passive is **player 15**
 *  (common.j PLAYER_NEUTRAL_AGGRESSIVE / PLAYER_NEUTRAL_PASSIVE). Trigger code leans on
 *  that hard: blizzard.j's MeleeClearExcessUnit removes a start-location unit only if its
 *  owner IS one of those two, and countless custom maps spawn "for Player 12". So the
 *  translation happens here, at the one place a sim unit becomes a JASS unit. */
export function jassOwnerOf(u: { owner: number; neutralPassive: boolean }): number {
  if (u.owner >= 0) return u.owner;
  return u.neutralPassive ? 15 : 12;
}

const eventInfo = (u: SimUnit): EventUnitInfo => ({ id: u.id, typeId: u.typeId, owner: jassOwnerOf(u), x: u.x, y: u.y, facing: u.facing });

/** Where a cast is in its lifecycle, for the trigger engine's spell events (7.17).
 *  WC3 raises five, in this order: CHANNEL (the caster begins), CAST (the spell is
 *  committed), EFFECT (it goes off — the one most GUI triggers use), FINISH (the
 *  channel/recovery ran out) and ENDCAST (the caster stopped casting, interrupted
 *  or not). Our cast timeline (see PendingCast) maps onto it directly: the wind-up
 *  starting is CHANNEL+CAST, the cast point is EFFECT, endCast is FINISH+ENDCAST,
 *  and an interrupted wind-up raises ENDCAST alone. */
export type SpellPhase = "channel" | "cast" | "effect" | "finish" | "endcast";

/** One spell event: who cast what, at whom/where. `abilityId` is the SimAbility's
 *  own alias (the rawcode GetSpellAbilityId hands the script back). */
export interface SpellEvent {
  caster: EventUnitInfo;
  abilityId: string;
  phase: SpellPhase;
  target: EventUnitInfo | null; // unit target (null for point/no-target casts)
  x: number; // target point (the unit's position for a unit target)
  y: number;
}

/** A structure's construction reaching a milestone (EVENT_(PLAYER_)UNIT_CONSTRUCT_*):
 *  the foundation laid, the build cancelled, or the building finished. */
export interface ConstructEvent {
  structure: EventUnitInfo;
  phase: "start" | "cancel" | "finish";
}

/** A training queue milestone (EVENT_(PLAYER_)UNIT_TRAIN_*). `trained` is the new
 *  unit — only on "finish", and only once the engine has actually spawned it (the
 *  sim owns no models, so the unit is born in the renderer; see noteTrainFinish). */
export interface TrainEvent {
  building: EventUnitInfo;
  unitTypeId: string; // the trained unit's type rawcode (GetTrainedUnitType)
  trained: EventUnitInfo | null;
  phase: "start" | "cancel" | "finish";
}

/** A hero gaining a level (EVENT_PLAYER_HERO_LEVEL) or learning a skill
 *  (EVENT_PLAYER_HERO_SKILL). `abilityId` is set only for "skill". */
export interface HeroEvent {
  hero: EventUnitInfo;
  phase: "level" | "skill";
  level: number; // the new hero level, or the rank just learned (skill)
  abilityId: string;
}

/** A Way Gate's teleport config (7.22). A waygate is an ordinary unit ('nwgt') that
 *  carries the `Awrp` ("Warp") ability; a script points it somewhere with
 *  `WaygateSetDestination` and switches it on with `WaygateActivate`. Null/absent on
 *  every other unit, so this costs nothing. */
export interface WaygateState {
  destX: number;
  destY: number;
  active: boolean;
  /** Units currently standing in the gate's box. A gate fires on a unit ENTERING it —
   *  the rising edge — not on one merely standing in it, so this is the "was already
   *  inside" baseline the next tick is diffed against. See tickWaygates for why a gate
   *  that fires on occupancy instead of entry makes a pair of gates ping-pong forever. */
  inside: Set<number>;
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
  flyHeight: number; // altitude above ground the unit floats/draws at (0 for ground);
  // matches the render lift so missiles launch from / land at the unit's real height
  sightDay: number; // fog-of-war sight radius in daylight (UnitBalance `sight`)
  sightNight: number; // fog-of-war sight radius at night (UnitBalance `nsight`)
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  armor: number;
  armorType: ArmorType; // UnitBalance defType → picks the damage-table column
  /** Every weapon slot the unit's type declares, in slot order (see WeaponSlotDef). Which one
   *  swings is decided per TARGET — weaponVs(). */
  weapons: SimWeapon[];
  /** The primary weapon: the first ENABLED slot, or null when the unit is unarmed. This is the
   *  attack the HUD shows and what "is this unit armed / melee / ranged" means everywhere.
   *  recomputeStats() re-picks it, so a Flying Machine that researches Bombs keeps its air
   *  attack as primary and simply gains a second one. */
  weapon: SimWeapon | null;
  /** The slot the in-flight swing was launched with (weaponVs at swing start) — a Gargoyle
   *  that starts a ground swing must land THAT hit, not re-pick a weapon at the damage point. */
  swingWeapon: SimWeapon | null;
  // Ability cast animation timing (UnitWeapons.slk castpt/castbsw), per-unit — not
  // per-weapon, so a weaponless pure caster still has them. castPoint = wind-up
  // before a spell's effect fires (added to the ability's Casting Time); castBackswing
  // = the recovery after the effect, which any new order cancels for free (the WC3
  // "animation canceling" micro). See PendingCast + tickCast.
  castPoint: number;
  castBackswing: number;
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
  // "Animation break": the unit walked after firing (an attack's backswing was
  // move-canceled), so its attack clip must NOT resume — it stands out the recovery
  // until the next real swing fires (the swing clears this). Reset every swing start.
  swingBroken: boolean;
  // Swing procs, rolled ONCE at the swing's start (see engage) and spent at its damage
  // point. They are decided up front — not at the blow — because the strike they modify
  // has its own animation: WC3 models that carry a proc-on-attack passive carry an
  // "Attack Slam" clip for exactly this (HeroBlademaster.mdx has one alongside its plain
  // "Attack"/"Attack 2"; HeroMountainKing.mdx has "Attack Slam" + "Attack Slam Alternate"
  // for Bash/Avatar). The clip is chosen when the swing begins, so the roll must be too.
  swingCrit: boolean; // Critical Strike (AOcr) hit this swing — dealDamage multiplies it
  swingBash: boolean; // Bash (AHbh) procced this swing — dealDamage adds its bonus + stuns
  swingSlam: boolean; // this swing shows "Attack Slam": a crit, a bash, or the Wind Walk backstab
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
  // Leader to RESUME following after an opportunistic fight ends (issue #32): a
  // follower that reaches its leader guards it, attacking nearby enemies, but once
  // the fight is over it returns to trailing instead of going idle. Non-null only
  // while such a follow-and-fight is in flight; a fresh player order clears it.
  followLeaderId: number | null;
  // Attack-formation slot: a distinct offset from the TARGET's centre this unit
  // stands at to attack, so a group swarming one enemy fans out around it (WC3
  // surround) instead of lining up. atkOffTarget marks which target the slot was
  // assigned for (re-assigned only when the target changes, so slots stay stable).
  atkOffX: number;
  atkOffY: number;
  atkOffTarget: number; // -1 = no slot assigned
  amDestX: number; // attack-move final destination (units engage enemies en route)
  amDestY: number;
  patrolX: number; // the OTHER patrol endpoint (units bounce between the two)
  patrolY: number;
  acquireT: number; // seconds until the next auto-acquire scan
  stuckT: number; // seconds spent blocked while trying to move
  stuckRetries: number; // consecutive stuck-repath attempts without progress
  stallT: number; // seconds an attacker has been unable to close on its target (issue #24)
  stallAnchorX: number; // position at the start of the current combat-approach window
  stallAnchorY: number;
  stallGap: number; // gap to the target at the start of the current combat-approach window
  gaveUp: boolean; // holding: gave up reaching an unreachable attack target, standing put (issue #24)
  gaveUpGap: number; // gap to the target when the hold began — re-evaluate if it moves
  attackStalls: number; // consecutive combat-approach windows with no headway (forces a hold when high)
  stuckAnchorX: number; // position at the start of the current stuck window (net-progress check)
  stuckAnchorY: number;
  repathT: number; // chase-repath cooldown after getting blocked
  repollT: number; // proactive-reroute poll timer (issue #6): seconds until the next
  // check of whether the path ahead is still clear of newly-stopped units
  yieldT: number; // seconds paused giving way to another unit (breaks head-on "dancing")
  prevX: number; // position before this tick's movement (stuck detection)
  prevY: number;
  velX: number; // scratch: intended pathed displacement this tick (collision steering)
  velY: number;
  footprint: number; // reserved cells per side when stationary (0 = never)
  // A building's stamped pathTex footprint (see destructibles.ts) and the position it
  // was stamped at. Buildings don't reserve cells like a stopped unit does — they block
  // through this stamp — so the stamp is what has to come back when the building dies.
  // Held with its own x/y because the stamp is applied at the building's FOUNDING spot
  // and must be lifted from exactly there.
  pathStamp: { fp: Footprint; x: number; y: number } | null;
  resX: number; // origin cell of the current reservation
  resY: number;
  hasReservation: boolean;
  resKind: "gold" | "lumber" | null; // active harvest target kind
  resId: number; // mine/tree id being harvested
  workT: number; // chop/mine timer
  inMine: boolean; // inside the gold mine (renderer hides the unit)
  insideBuild: boolean; // Orc peon hidden INSIDE the structure it is building (renderer hides it)
  inBurrow: boolean; // peon garrisoned inside an Orc Burrow (renderer hides it)
  garrisonHost: number; // Orc Burrow id this peon is garrisoned in (0 = none)
  garrison: number[]; // for an Orc Burrow: the peon ids loaded inside (fires arrows; DPS scales)
  garrisonCap: number; // max passengers this unit can hold (0 = can't garrison; Abun Dataa1)
  linkGroup: number[]; // Spirit Link: the co-linked unit ids sharing this unit's damage (empty = unlinked)
  linkT: number; // Spirit Link time remaining (0 = not linked)
  linkShare: number; // Spirit Link: fraction of a hit distributed across the group (dataA)
  devouring: number; // Kodo Devour: the prey unit id being digested (0 = none; holds one)
  devouredBy: number; // this unit is swallowed inside that Kodo (0 = free; renderer hides it)
  /** Off the field for a moment while an effect resolves: the renderer hides it, nothing can
   *  target or hurt it, and it takes no orders. Mirror Image's shuffle uses it — the
   *  Blademaster is whisked away while MirrorImageCaster plays and the missiles fly out, then
   *  set down on one of the destination tiles as if he had been a copy all along. */
  vanished: boolean;
  etherealForm: boolean; // Spirit Walker in ethereal form: persistently ethereal (immune physical, no attack)
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
  properName: string; // hero's drawn name ("Painkiller"); "" for non-heroes
  level: number; // hero level (0 for non-heroes)
  xp: number; // hero experience
  skillPoints: number; // unspent skill points (1 gained per level)
  primaryAttr: PrimaryAttribute;
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
  // The PRIMARY weapon's base damage before primary-attr growth + buffs. Mirrors
  // weapon.baseDamage; kept on the unit because it is the "how hard does this unit hit"
  // figure other systems reason about (Inner Fire's +10% of base, the HUD's green bonus).
  // WC3's attack upgrades add a DIE (`ratd`), not flat damage — the engine HAS a flat-damage
  // effect (`ratx`, used by Burning Oil) and Blizzard pointedly did not use it for Forged
  // Swords: all 19 melee/ranged attack upgrades across the four races are `ratd` base=1 mod=1.
  // So a Footman (1d2+11 = 12-13) upgrades to 2d2+11 = 13-15, then 3d2+11 = 14-17 — the RANGE
  // widens, which is why upgraded WC3 units roll a bigger spread and not just a bigger number.
  baseDamage: number;
  baseSpeed: number; // move speed before slow/haste
  baseSightDay: number; // Magic Sentry / `rsig` widen a tower's vision
  baseSightNight: number;
  manaRegen: number; // mana per second (recomputed from INT + buffs)
  hpRegen: number; // hp per second
  lifesteal: number; // fraction of melee damage healed back (Vampiric Aura); derived
  thorns: number; // fraction of melee damage returned to attackers (Thorns Aura); derived
  bonusArmor: number; // buff/aura portion of armour (green "+N" in the HUD); derived
  bonusDamage: number; // buff/aura portion of attack damage (green "+N"); derived
  bonusStr: number; // item portion of Strength (green "+N" / red "-N" in the HUD); derived
  bonusAgi: number; // item portion of Agility; derived
  bonusInt: number; // item portion of Intelligence; derived
  abilities: SimAbility[]; // learned/innate abilities
  buffs: SimBuff[]; // active timed effects
  stunned: boolean; // derived from buffs (cannot act)
  paused: boolean; // JASS PauseUnit: frozen — no orders, movement, or turning (cinematics)
  waygate?: WaygateState | null; // JASS WaygateSetDestination/Activate — a Way Gate ('nwgt'), 7.22
  silenced: boolean; // derived from buffs (cannot cast spells)
  ethereal: boolean; // derived from buffs (Banish): can't attack, immune to physical damage
  /** Magic Immunity (`Amim`, and the creep copies that share its code) — the unit cannot be
   *  the target of a spell at all, and takes no spell damage. Carried by the Dryad, the
   *  Spell Breaker, the Destroyer, the Faerie Dragon, the Phoenix and the Serpent Wards
   *  (Units\UnitAbilities.slk). Derived from the ability, like `ethereal` from its buff. */
  magicImmune: boolean;
  /** True Sight radius — how far this unit reveals invisible enemies, or 0 for the vast
   *  majority that reveal nothing. Rng1 of `Atru` (the Shade, the general detector and the
   *  War Eagle, 900), `Adet` (the Sentry Ward, 1100) or `Adts` (Magic Sentinel, 900).
   *  Derived from the ability list. */
  detectRadius: number;
  /** Root (`Aroo`): this Ancient has pulled itself out of the ground and is walking. False is
   *  the resting state for every carrier — an Ancient is BUILT rooted, and a Tree of Life
   *  spends the whole game that way unless something goes badly wrong. See toggleRoot. */
  uprooted: boolean;
  /** This unit is currently showing the ALTERNATE half of its model. WC3 packs both looks of
   *  a two-form unit into one MDX — "Stand" and "Stand Alternate", with Morph/Morph Alternate
   *  between them — and nothing in the unit data says which half is live, because the ABILITY
   *  decides moment to moment.
   *
   *  Two unrelated-looking abilities land here: a ROOTED Ancient is alternate (its planted
   *  pose, see toggleRoot) and a BURROWED Crypt Fiend is alternate (its underground pose, see
   *  morphToggle). It is the same fact about the model either way, so the renderer reads this
   *  one flag rather than knowing about either ability. */
  altModel: boolean;
  /** The building footprint an uprooted Ancient will take back when it plants (0 for
   *  everything else). While it walks its own `footprint` is 0 — it collides by RADIUS like
   *  any other unit — because a 4×4 stamped block is a thing the pathfinder routes around,
   *  and an Ancient carrying one cannot leave the hole it is standing in. See toggleRoot. */
  rootedFootprint: number;
  /** The fade is IN FORCE: renders half-faded, and draws no aggro (see canSee). False during
   *  the Transition Time, when the unit is under the effect but hasn't vanished yet. */
  invisible: boolean;
  /** Under an invisibility effect AT ALL, transition included — a superset of `invisible`.
   *  This, not `invisible`, is what stops the unit picking its own fights and what a strike
   *  breaks: attacking during the transition has to cancel the vanish too, or Wind Walk
   *  would auto-attack its way out of its own 0.6s wind-up. */
  cloaked: boolean;
  invulnerable: boolean; // derived from buffs + baseInvulnerable (immune to damage + enemy targeting)
  baseInvulnerable: boolean; // persistent invulnerability from the unit type's "Invulnerable (Neutral)" ability (Avul) — goblin merchant, gold mine, mercenary camp, tavern, … (issue #26)
  mechanical: boolean; // machines/summons — no raisable corpse, unhealable by Heal
  // A worker, from the unit type's "Peon" classification (UnitBalance.slk `type`,
  // JASS's UNIT_TYPE_PEON): exactly the 9 harvest-and-build units — Peasant, Peon,
  // Acolyte, Wisp and the 5 neutral variants. Workers NEVER auto-acquire a target:
  // they ignore fights around them and only attack when explicitly ordered to
  // (issue #41). The Ghoul harvests lumber but is not Peon-classified, so it fights
  // like any other soldier — which is why the classification, not "can harvest", is
  // the flag to key off.
  isPeon: boolean;
  isSummon: boolean; // a summoned unit (Water Elemental) — leaves no corpse, ×0.5 XP
  spawning: number; // >0: materializing (playing its birth clip) — cannot act yet
  summonLeft: number; // >0: a temporary summon that expires (Water Elemental); else 0
  summonMax: number; // the summon's full duration (for the "Summoned Unit" bar fill)
  /** A Mirror Image illusion: a copy of the caster that fights but cannot hurt anything.
   *  Its factors come from AOmi's own data (AbilityMetaData names the columns):
   *  DataB "Damage Dealt (%)" = 0 and DataC "Damage Taken (%)" = 2. The unit is otherwise
   *  an exact copy — same type, same stats on the sheet — which is the point: only its
   *  owner can tell it apart. It is also a summon (isSummon), so it expires, leaves no
   *  corpse and dies to Dispel Magic. */
  isIllusion: boolean;
  /** The sim id of the unit this illusion copies (0 = not an illusion). The images have to
   *  be findable FROM their original — they level with it — and matching on owner+typeId
   *  would be a guess that quietly breaks the moment a player fields two of the same type. */
  illusionOf: number;
  illusionDamageDealt: number; // fraction of its damage that lands (AOmi DataB) — 0 = none
  illusionDamageTaken: number; // multiplier on damage it receives (AOmi DataC) — 2 = double

  /** The effect that replaces this summon when it LEAVES — its timer running out or a
   *  re-cast dismissing it. Carried from the ability that summoned it (its buff's
   *  Effectart: Feral Spirit -> feralspiritdone). "" = leave without one. This is not a
   *  death: a summon killed in combat plays its Death clip and dissipates instead. */
  unsummonArt: string;
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
  campHelper: boolean; // fighting only because a camp-mate called for help (may not call for help itself)
  campGuard: boolean; // war3mapUnits.doo targetAcquisition -2 ("Camp") — guards its ground, deaf to new construction

  strayT: number; // seconds chasing past GUARD_DISTANCE without being attacked (→ return)
  returnBestDist: number; // closest-to-home distance reached this return (stuck detection)
  returnStuckT: number; // seconds making no homeward progress while returning (→ give up, fight)
  // --- inventory (heroes) ---------------------------------------------------
  inventory: (HeldItem | null)[]; // 6 slots for heroes ([] for units without an inventory)
  getItemId: number; // ground item this unit is walking to pick up (order === "getitem"; 0 = none)
  pendingGive: { toId: number; slot: number } | null; // walking to hand a slot's item to another hero
  /** Walking to a SHOP to sell a slot's item (WC3: right-click the item, click the shop —
   *  the same gesture as dropping it, but the shop takes it and pays). See issueSellItem. */
  pendingSell: { shopId: number; slot: number } | null;
  pendingDrop: { slot: number; x: number; y: number } | null; // walking to a spot to drop a slot's item
}

/** The [Errors] key for "refused, but the game has no line for this" — an empty key finds no
 *  string, so the UI beeps and stays silent. Named so the intent isn't mistaken for a bug. */
const SILENT_REFUSAL = "";

const ARRIVE_EPS = 8; // world units — "close enough" to a waypoint
// Hero inventory reach, straight from the Gameplay Constants. Note that picking an
// item up reaches FURTHER than dropping one does (150 vs 100) — they are separate
// constants in the game, not one shared radius.
const ITEM_PICKUP_RANGE = MISC_GAME.PickupItemRange;
const ITEM_GIVE_RANGE = MISC_GAME.GiveItemRange;
const ITEM_DROP_RANGE = MISC_GAME.DropItemRange;
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
// Combat-approach watchdog (issue #24). An attacker that neither gets within its
// strike band nor makes real headway toward its target over this window has an
// effectively blocked route — whether it stands still or wobbles in and out of a
// tight crowd (settling/re-pathing every few ticks, which slips past both the
// per-tick "moving" reset and the 0.5s stuck window). It then re-decides: repath if
// the target is still reachable, else switch to the nearest target it CAN reach,
// else stand & face. "Headway" is measured two ways over the window — net ground
// covered AND how much the gap to the target shrank — and either one clears it, so a
// unit marching in, or chasing a runner it's keeping pace with, is never mistaken for
// a stuck wobbler (which does neither). ATTACK_PROGRESS is the least of either that
// still counts as genuine progress.
// A* expansion cap for LOCAL combat pathing (chases + reachability probes). The target
// is always within acquisition range (~25 cells), so a reachable path is found in a few
// hundred expansions; a bigger flood only ever happens when the target is unreachable,
// where we want to bail to a best-effort short path fast rather than flood the whole map
// (the full 8192 cap × 100 units all probing one crowded target was the ~20fps stall).
const COMBAT_EXPANSIONS = 700;
const ATTACK_STALL_TIME = 0.6;
const ATTACK_PROGRESS = PATHING_CELL * 1.5; // 48 world units per window
// After a unit gives up on an unreachable target with nothing else reachable, it
// commits to standing for this long before probing again — so a permanently boxed-in
// unit stands STILL instead of taking a shoved-back step every second (the residual
// micro-wobble). It still re-checks periodically in case a blocker dies or the target
// moves into reach.
const ATTACK_GIVEUP_COOLDOWN = 1.5;
// When an attacker keeps failing to make headway even though A* says the target is
// reachable — the outer unit of a full surround, where the pathfinder threads the ring's
// gaps but live collision keeps blocking the last stretch — it stops chasing and HOLDS,
// with a backoff that grows each time it re-stalls (capped here). A permanently over-
// surrounded unit thus ends up standing still, re-probing only every few seconds, instead
// of jittering at the range edge every tick. It leaves the hold the instant it gets into
// range or the target moves (so it's responsive when the fight actually shifts).
const ATTACK_HOLD_MAX = 4.0;
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
// How far an idle unit will look to JOIN a fight a friend is already in (issue #24). It
// wider than a unit's own acquisition range (~500) so a back-rank unit rallies to a
// nearby melee instead of standing idle a few paces behind it, but bounded so an idle
// unit doesn't sprint across the map to every distant skirmish. Only enemies actively
// attacking an ally qualify (see assistTarget), so it never wakes a peaceful creep camp.
const ASSIST_RANGE = 800;
const STUCK_TIME = 0.5; // seconds of blocked movement before a unit gives up
const STUCK_RATIO = 0.3; // "blocked" = actual displacement below this share of expected
// When two units meet head-on, the lower-priority one pauses for YIELD_TIME so the
// other can clear — this breaks the symmetric "dance" (both endlessly sidestepping
// into the tile the other just vacated) instead of letting it churn for seconds.
const YIELD_TIME = 0.2;
// Air units ignore ground pathing & collision *while cruising* (issue #31), so a
// group flies as one point and stacks perfectly on arrival / when swarming a
// target. WC3 flyers don't stack: once stopped (arrived or fighting) they glide
// apart until their collision hulls no longer overlap. This is the max drift speed
// of that fan-out, as a share of the flyer's own move speed — a share (not full
// speed) so it reads as a gentle spread rather than a pop.
const AIR_FANOUT_SPEED = 0.6;
// Human "speed build": each builder beyond the first adds SPEED_BUILD_BONUS to the
// build rate (1.0 = one builder) and, spread across the shortened build time, a
// SPEED_BUILD_SURCHARGE share of the base cost per extra builder. Tuned to WC3's
// Town Hall reference: 5 peasants take ~53s (from 90s) and cost ~615g (from 385g).
const SPEED_BUILD_BONUS = 0.17;
const SPEED_BUILD_SURCHARGE = 0.15;
// Per-race construction style (engine behaviour, not a data field — observed in-game +
// Warsmash). ORC/NIGHT ELF workers build from INSIDE the structure (hidden, one worker,
// no assist); HUMAN peasants build from outside and can "speed build" — extra peasants
// pile on to finish faster (SPEED_BUILD_*). Undead acolytes summon-and-leave (handled
// elsewhere). Night Elf's wisp is inside-build too; it joins buildsFromInside when we
// do the NE pass.
function buildsFromInside(u: SimUnit): boolean {
  return u.race === "orc";
}
function speedBuilds(u: SimUnit): boolean {
  return u.race === "human";
}
// Proactive reroute poll (issue #6). A unit's path is computed once, but other
// units may stop and reserve cells across it while it travels. Rather than let a
// unit grind into that crowd until checkStuck() fires (0.5 s of no progress),
// every REPATH_POLL seconds it re-checks the path just ahead and, if a unit has
// since blocked it, recomputes the route around the obstruction. REPATH_LOOKAHEAD
// bounds how far ahead (world units) the check scans — deliberately local, so a
// distant block that may clear before arrival doesn't trigger a needless reroute.
const REPATH_POLL = 0.25;
const REPATH_LOOKAHEAD = PATHING_CELL * 5; // ~5 cells (160 world units) ahead
// Resource gathering (community-documented WC3 values; docs/REFERENCES.md).
const GOLD_PER_TRIP = 10;
const MINE_TIME = 1.0; // seconds a worker spends inside the mine
const TREE_LUMBER = 50; // lumber a standard tree yields before falling
// Tree hit points, separate from lumber: harvesting drains `lumber`, but area
// spells that list `tree` in Targets Allowed (Flame Strike) burn a tree down by
// HP. 50 HP, armor "Wood" — DestructableData.slk `ATtr` (Ashenvale Tree Wall),
// the standard tree destructible; `hp=50`, `targtype=tree`.
const TREE_HP = 50;
const TREE_RADIUS = 16; // half a tree's 2×2-cell footprint, for the reach latch
const DEPOSIT_RANGE = 64; // gap to a depot edge to turn in the load
const RETARGET_RANGE = 1200; // how far a worker looks for the next tree

// --- hero XP / leveling ---
// The tables and thresholds live in data/gameplayConstants (Units\MiscGame.txt),
// derived from the game's own base lists + `f(x) = A·f(x-1) + B·x + C` formulas.
// Cross-checked with Liquipedia: Experience + warcraft3.info article 232.
const MAX_HERO_LEVEL = MISC_GAME.MaxHeroLevel;
/** Heroes within this of a kill share its XP; with none in range, GlobalExperience=1
 *  spreads it across all the killer's heroes instead. */
const XP_SHARE_RANGE = MISC_GAME.HeroExpRange;
const SUMMON_XP_FACTOR = MISC_GAME.SummonedKillFactor;

// Attribute → stat conversions (MiscGame Str/Int/Agi bonuses; Liquipedia: Hero).
const HP_PER_STR = MISC_GAME.StrHitPointBonus;
const MANA_PER_INT = MISC_GAME.IntManaBonus;
const ARMOR_PER_AGI = MISC_GAME.AgiDefenseBonus;
const REGEN_PER_STR = MISC_GAME.StrRegenBonus; // hp/sec per Strength point
const REGEN_PER_INT = MISC_GAME.IntRegenBonus; // mana/sec per Intelligence point
// Attack-speed (IAS) caps. NOT in MiscGame/MiscData — neither file carries any attack-speed
// cap key; the engine hardcodes them, so they live here at the use site rather than in
// gameplayConstants.ts (which mirrors the data files). "The most FAR a unit can have is +400%
// or -80%, afterwhich any excess is wasted" — Hive "Attack Speed Formula?" #12 (Dr Super Good);
// the pair mirrors each other (5x vs 1/5x). They clamp the SUMMED bonus, before the division.
const IAS_MAX = 4.0; // +400% — cannot swing faster than 5x its base attack time
const IAS_MIN = -0.8; // -80% — cannot be slowed below 1/5 of its base attack rate
const DAMAGE_POINT_FLOOR = 0.02; // a swing always lands 0.02s before it may start the next
const UNIT_MANA_REGEN = 0.67; // flat mana/sec for non-hero casters (approx WC3 base)
const AURA_REFRESH = 0.5; // aura buffs re-applied each tick with this TTL (fade on leave)
const FACING_CAST_EPS = 0.4; // must roughly face a unit target to cast
// Channelled abilities (base code): the caster stands locked for the channel and a
// new order stops it AND the remaining ticks (unlike a backswing, which is free to
// cancel because its effect already happened). These are WC3's stand-and-channel
// hero spells — verified against AbilityData.slk + Liquipedia: Blizzard, Rain of
// Fire, Starfall, Tranquility, Death and Decay, Stampede, Earthquake. NOT channelled
// (fire-and-forget, caster free right after the cast): Flame Strike, Volcano, Locust
// Swarm, Bladestorm (the Blademaster keeps moving), Immolation, Cluster Rockets.
const CHANNELED = new Set(["AHbz", "ANrf", "AEsf", "AEtq", "AUdd", "ANst", "AOeq"]);
// Delayed-strike abilities that drop their Effectart (a ground "beware" warning) the
// moment the cast WIND-UP begins — not when it lands — so it charges up in place and
// REMAINS visible even if the cast is interrupted before ignition. Flame Strike's
// FlameStrikeTarget smoke vortex (MPQ AHfs Effectart; Liquipedia: interrupting the
// Blood Mage — by moving or a stun — leaves only the gong + vortex, no flames). The
// strike itself (pillar + burn) still needs the wind-up to finish (see spells AHfs).
const PRECAST_WARNING = new Set(["AHfs"]);
// Immediate abilities (base code): pressing the button IS the cast. No wind-up, no
// cast animation, and no re-tasking — the caster keeps attacking/walking straight
// through it. Two cases, both with `Cast1=0` in AbilityData.slk and no `Animnames`
// in their AbilityFunc:
//   - Divine Shield (and Cenarius's ACds, the same spell) — no Animnames in
//     HumanAbilityFunc.txt, and a toggle rather than an order (`Order=divineshield`
//     / `Unorder=undivineshield`): in WC3 the Paladin bubbles mid-swing without
//     dropping his attack.
//   - Wind Walk — no Animnames in OrcAbilityFunc.txt, and the Blademaster's model
//     carries no "Spell" clip at all (HeroBlademaster.mdx sequences: Stand*/Attack/
//     Attack Slam/Walk/Death/Dissipate/Attack Walk Stand Spin), so the engine has
//     literally nothing to show for the cast — it fades him where he stands and he
//     keeps walking. That is the escape micro the ability exists for.
// Do NOT widen this to every no-Animnames spell: Holy Light and Water Elemental have
// none either, yet the engine falls back to the caster's "Spell" clip for them (see
// RtsController.playCastAnim).
const IMMEDIATE = new Set(["AHds", "ACds", "AOwk"]);
/** Buff group prefix worn by the regeneration items (`AIrg` — Healing Salve, Clarity
 *  Potion, Potion/Scroll of Rejuvenation). One prefix so a single filter drops both the
 *  life and the mana half together when the effect breaks. */
const ITEM_REGEN_GROUP = "item:regen";
/** Damage that dispels a regeneration item's effect. Not in any data file — see landDamage. */
const ITEM_REGEN_BREAK = 20;
/** Abilities that may be aimed at a magic-immune unit anyway. There is no flag for this in
 *  the ability data — no `targs1` value means "may target the immune" — so the engine
 *  hardcodes it and so must we, which is why the list is short and explicit rather than
 *  inferred. The dispels are the clear members: a Dryad's Abolish Magic and the Human
 *  Dispel Magic have to be able to clean a Spell Breaker, or a debuff placed before the
 *  immunity applied could never be removed. Kept deliberately narrow — add a code here only
 *  with a source, never to make a cast "work". */
const MAGIC_IMMUNE_EXEMPT = new Set(["Adis", "Aadm", "Adcn"]);
// Corpse decay (Units\MiscData.txt BoneDecayTime): a corpse persists 88s after
// death — the renderer sequences it Death → Decay Flesh → Decay Bone within this
// window — and is then removed. The flesh stage is an early sub-phase, not added
// on top; 88s is the full lifetime from the moment of death.
const CORPSE_TOTAL_TIME = MISC_DATA.BoneDecayTime;

// WC3 day/night (Units\MiscData.txt): a full cycle is DayLength=480 real seconds =
// DayHours=24 game hours (so one game hour = 20 real seconds); daytime runs from
// Dawn to Dusk. Melee games open at bj_MELEE_STARTING_TOD = 08:00.
const DAY_START = MISC_DATA.Dawn;
const DAY_END = MISC_DATA.Dusk;

// Neutral-hostile creep guard/leash AI, from Units\MiscGame.txt. (These supersede
// the ~1.8×-aggro guess — the MPQ wins; see CLAUDE.md.)
const GUARD_DISTANCE = MISC_GAME.GuardDistance; // strayed this far from home → start the return timer
const MAX_GUARD_DISTANCE = MISC_GAME.MaxGuardDistance; // strayed this far → return home unconditionally, even under attack
const GUARD_RETURN_TIME = MISC_GAME.GuardReturnTime; // also the "can't get home, resume fighting" window
const CREEP_CALL_FOR_HELP = MISC_GAME.CreepCallForHelp; // camp cohesion: one aggros → the whole camp wakes/joins
// "Radius of creep notification when a new building gets placed" — Units\MiscData.txt's
// own comment on this constant. Laying a foundation shouts to the creeps around it, quite
// apart from anyone's acquisition range: this is why a gold mine's guards charge a Peasant
// who starts an expansion from further out than they'd have noticed him merely walking by.
const BUILDING_PLACEMENT_NOTIFY_RADIUS = MISC_DATA.BuildingPlacementNotifyRadius;
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
// Shooting from the dark gives you away (issue #45). MiscData names no duration for
// FoggedAttackRevealRadius, so the blow buys the attacker's position one second,
// re-stamped by every following blow.
const FOGGED_ATTACK_REVEAL_RADIUS = MISC_DATA.FoggedAttackRevealRadius;
const FOGGED_ATTACK_REVEAL_TIME = 1;

/** A hidden attacker's position, given away to one team for a moment. */
export interface AttackReveal {
  x: number;
  y: number;
  radius: number;
  team: number; // the side that gets to see it — the one that was hit
  flying: boolean;
  timeLeft: number;
}

export class SimWorld {
  readonly units = new Map<number, SimUnit>();
  readonly mines = new Map<number, SimMine>();
  readonly trees = new Map<number, SimTree>();
  readonly projectiles = new Map<number, SimProjectile>();
  /** Per-player resource stash (gold/lumber). */
  readonly stash = new Map<number, { gold: number; lumber: number }>();
  /** Time of day in game-hours [0, DayHours); advances every tick. A melee game
   *  opens at 08:00 (Scripts\Blizzard.j bj_MELEE_STARTING_TOD). */
  timeOfDay: number = MELEE.MELEE_STARTING_TOD;
  /** `EnableDawnDusk(false)` — the clock STOPS (7.24). A cinematic freezes it so the shot
   *  plays under a constant light and doesn't drift from day into night halfway through;
   *  blizzard.j's CinematicModeExBJ turns it off on the way in and restores it on the way
   *  out. Nothing else in the game switches it. */
  dawnDusk = true;
  private deaths: number[] = [];
  /** Whether to record death/damage/attack events for the trigger engine (the host
   *  sets each only when the loaded script actually registers that event kind — off
   *  for melee and for maps that don't listen, so nothing accumulates unread). */
  captureDeaths = false;
  captureDamage = false;
  captureAttacks = false;
  captureOrders = false;
  captureSpells = false; // EVENT_(PLAYER_)UNIT_SPELL_* (7.17)
  captureConstruct = false; // EVENT_(PLAYER_)UNIT_CONSTRUCT_* (7.17)
  captureTrain = false; // EVENT_(PLAYER_)UNIT_TRAIN_* (7.17)
  captureHeroEvents = false; // EVENT_PLAYER_HERO_LEVEL / _SKILL (7.17)
  captureItems = false; // EVENT_(PLAYER_)UNIT_PICKUP/DROP/USE/SELL_ITEM (7.18)
  private deathEvents: Array<{ victim: EventUnitInfo; killer: EventUnitInfo | null }> = [];
  private damageEvents: Array<{ target: EventUnitInfo; source: EventUnitInfo | null; amount: number }> = [];
  private attackEvents: Array<{ attacked: EventUnitInfo; attacker: EventUnitInfo }> = [];
  private orderEvents: Array<{ unit: EventUnitInfo; orderId: number; kind: "immediate" | "point" | "target"; x: number; y: number; target: EventUnitInfo | null }> = [];
  private spellEvents: SpellEvent[] = [];
  private constructEvents: ConstructEvent[] = [];
  private trainEvents: TrainEvent[] = [];
  private heroEvents: HeroEvent[] = [];
  private itemEvents: ItemEvent[] = [];
  private removals: number[] = []; // units removed WITHOUT a death animation (cancels)
  private felled: SimTree[] = [];
  private depleted: SimMine[] = [];
  private nextProjectileId = 1;
  private spawnedProjectiles: Array<{ id: number; art: string; x: number; y: number; z: number }> = [];
  private removedProjectiles: number[] = [];
  // Projectiles that actually HIT (vs fizzled) — the renderer plays the impact
  // effect (the missile model's Death clip) at the recorded point (z above ground).
  private projectileImpacts: Array<{ id: number; x: number; y: number; z: number }> = [];
  // Landed hits (melee + projectile) — the renderer plays the weapon-impact SFX
  // (attacker's weapon material vs target's armour material).
  private hits: Array<{ attackerId: number; targetId: number }> = [];
  // Worker ids whose axe just landed a chop this tick — the renderer plays the
  // chop SFX (worker's lumber-weapon material vs Wood).
  private chops: number[] = [];
  // Positions of trees that took a (non-felling) chop this tick — the renderer plays
  // the tree doodad's "stand hit" wobble once per hit (a felling hit plays "death" via
  // the `felled` queue instead, so it isn't duplicated here).
  private treeHits: Array<{ x: number; y: number }> = [];
  // Attacker ids whose swing just reached its damage point (fired) this tick — the
  // renderer plays the unit's own attack/fire sound (the SND "K" event on its model:
  // rifleman gunshot, mortar boom, dragon breath). Distinct from the landed-hit clang.
  private attackSwings: number[] = [];
  // Debug cheat: when true, construction + unit training complete in ~1 second
  // (any build time is compressed to one second), regardless of builders present.
  fastBuild = false;
  // Injected by the game layer: is world point (x,y) currently VISIBLE (not fogged)
  // to `team`? Idle units only auto-acquire enemies their team can actually see —
  // WC3 units never aggro a target hidden in the fog of war (issue #17). Defaults to
  // always-visible so headless sim tests (which build no vision map) behave as before;
  // only the local player's team is fog-modelled, so other teams pass through as
  // visible (see rts.ts, which wires this to the per-team VisionMap).
  visibleToTeam: (team: number, x: number, y: number) => boolean = () => true;
  /** Does anything (treeline, high ground) stand between these two points? Injected by
   *  rts from the VisionMap's height field; defaults to open ground for headless sims. */
  lineOfSight: (fromX: number, fromY: number, toX: number, toY: number, flying: boolean) => boolean = () => true;
  /** Are two PLAYER slots allied? Injected by rts from the alliance matrix (7.22), so a
   *  script's `SetPlayerAlliance` can ally two players the lobby put on different teams —
   *  and un-ally two it put on the same one. `null` = "no opinion, use the teams", which
   *  is what creeps (owner < 0) and a headless sim with no matrix both get, so allegiance
   *  stays the plain team comparison it was before. */
  alliedPlayers: (ownerA: number, ownerB: number) => boolean | null = () => null;
  /** Live fogged-attacker reveals, keyed `attackerId:victimTeam` so a unit shooting two
   *  sides at once gives itself away to each, and each fresh blow re-stamps the entry. */
  private attackReveals = new Map<string, AttackReveal>();
  // Trained units ready to spawn: the renderer creates the model + sim unit.
  private trainCompletions: Array<{ buildingId: number; unitId: string; x: number; y: number; rallyX: number; rallyY: number; rallyKind: RallyKind; rallyTargetId: number }> = [];
  // Finished research (renderer plays the "upgrade complete" sound + refreshes the card).
  private researchCompletions: Array<{ buildingId: number; upgradeId: string; level: number; owner: number }> = [];
  // Buildings that changed type this tick (Town Hall → Keep): the renderer swaps the model.
  private morphs: Array<{ unitId: number; from: string; to: string }> = [];
  private nextNodeId = 1;
  private rng: () => number;
  // --- corpses (persist + decay; targetable by corpse-consuming spells) ---
  readonly corpses = new Map<number, SimCorpse>();
  private nextCorpseId = 1;
  // --- items on the ground (dropped / creep-dropped; pickable) -------------
  readonly items = new Map<number, SimItem>();
  private nextItemId = 1;
  /** Seconds since the match began. Shop restock schedules run on THIS clock, not on when a
   *  shop was raised — see initShopStock. */
  elapsed = 0;
  private itemSpawns: SimItem[] = []; // new ground items the renderer must model
  private itemRemovals: Array<{ id: number; died: boolean }> = []; // ground items picked up/destroyed (drop their model)
  // PowerUp items consumed on pickup this frame: the renderer plays the granted ability's
  // Target/Caster art on the picker and sounds it. See applyPowerup.
  private powerupPickups: Array<{ unitId: number; art: string; soundLabel: string }> = [];
  // Per-unit creep drop tables, seeded at spawn (map .doo), rolled on death.
  private unitDrops = new Map<number, ItemDropSet[]>();
  // --- spell / ability event channels drained by the renderer each frame ---
  // Spell effect models to play at a unit/point (targetArt/casterArt/areaArt).
  private spellEffects: Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean }> = [];
  // Temporary ground decals a spell paints (Thunder Clap's scorch): an UberSplatData
  // row id + where. The row carries the texture, half-width and fade timings.
  private spellSplats: Array<{ splatId: string; x: number; y: number }> = [];
  // A unit began casting: renderer plays the cast animation (spell/throw/slam) and
  // holds it for `hold` seconds — the whole cast (wind-up + backswing, or wind-up +
  // channel). `loop` = a channelled spell (loop the clip for the channel) vs a
  // one-shot gesture (Storm Bolt throw) that plays once. `warnArt` is the "beware"
  // model dropped at tx,ty this same instant (PRECAST_WARNING) — the renderer sounds
  // that model here, at the wind-up, since that is when WC3's model plays its clip.
  private castStarts: Array<{ casterId: number; code: string; abilityId: string; hold: number; loop: boolean; tx: number; ty: number; targetId: number; warnArt: string }> = [];
  // Casts whose effect just FIRED this frame (wind-up elapsed → the clap/bolt/etc.
  // happens now). The renderer plays the ability's cast SOUND off THIS, not off the
  // cast START — WC3 syncs the sound to the effect at the cast point (issue #23), and
  // an interrupted wind-up (which never reaches here) correctly makes no sound.
  private castFires: Array<{ casterId: number; code: string; abilityId: string }> = [];
  // Heroes that just gained a level: renderer plays the level-up nova + sound.
  private levelUps: Array<{ unitId: number; level: number }> = [];
  // Units summoned/raised by a spell this tick: the renderer creates their models
  // (same deferral as trainCompletions — the sim owns no model instances).
  private summonRequests: SummonRequest[] = [];

  /** Per-player tech state: researched levels + what their live units unlock (issue #57).
   *  Null until the registries are supplied — a bare sim (headless pathing/combat tests)
   *  has no tech tree, and every requirement check then trivially passes. */
  readonly tech: TechState | null;

  constructor(
    readonly grid: PathingGrid,
    seed = 1,
    private abilities?: AbilityRegistry,
    private itemReg?: ItemRegistry,
    private unitReg?: UnitRegistry,
    private techReg?: TechRegistry,
    private upgradeReg?: UpgradeRegistry,
  ) {
    this.rng = lcg(seed);
    this.tech =
      techReg && upgradeReg
        ? new TechState(techReg, upgradeReg, () =>
            [...this.units.values()].map((u) => ({
              owner: u.owner,
              typeId: u.typeId,
              alive: u.hp > 0,
              underConstruction: !!u.building && u.building.constructionLeft > 0,
            })),
          )
        : null;
  }

  /** Whether `player` may make `unitId` right now — tech prerequisites + availability cap.
   *  `owned` selects the requirement tier (hero #2 needs a Keep). Always true with no tech
   *  registry loaded. */
  canMake(player: number, unitId: string, owned = 0): boolean {
    return !this.tech || this.tech.canMake(player, unitId, owned);
  }

  /** Whether `player` meets the prerequisites for ANY tech id — a unit, an upgrade, a shop
   *  item or an ABILITY. Abilities declare theirs the same way everything else does
   *  (`[Adef] Requires=Rhde` in HumanAbilityFunc.txt), which is how the six "effectless" Human
   *  upgrades work: they grant no stat, they simply satisfy an ability's requirement. Ids with
   *  no requirements pass, so this is safe to ask of anything. */
  techMeets(player: number, id: string): boolean {
    return !this.tech || this.tech.meets(player, id);
  }

  addMine(x: number, y: number, gold: number, radius = 96): SimMine {
    const mine: SimMine = { id: this.nextNodeId++, x, y, radius, gold, busy: false };
    this.mines.set(mine.id, mine);
    return mine;
  }

  addTree(x: number, y: number, lumber = TREE_LUMBER, blockRadius = 64): SimTree {
    const tree: SimTree = { id: this.nextNodeId++, x, y, lumber, hp: TREE_HP, blockRadius };
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

  /** Standing trees within `radius` of a point — the set an area spell that lists
   *  `tree` in Targets Allowed (Flame Strike) damages, and which the green cast
   *  preview highlights. */
  treesInArea(x: number, y: number, radius: number): SimTree[] {
    const out: SimTree[] = [];
    for (const t of this.trees.values()) {
      if (Math.hypot(t.x - x, t.y - y) <= radius) out.push(t);
    }
    return out;
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

  // === shops (issue #57) =====================================================

  /** Everything a shop sells: its `Makeitems` (a race shop like the Arcane Vault),
   *  `Sellitems` (a neutral one like the Goblin Merchant) and `Sellunits` (a Tavern's heroes,
   *  a Mercenary Camp's creeps). A building with none of these is not a shop. */
  shopWares(typeId: string): { items: string[]; units: string[] } {
    const t = this.techReg?.get(typeId);
    if (!t) return { items: [], units: [] };
    return { items: [...t.makeitems, ...t.sellitems], units: [...t.sellunits] };
  }

  /** What THIS shop is actually selling: its data's wares plus whatever a script has put on its
   *  shelves. Only the second half exists for a Marketplace, whose entire stock is script-made
   *  and changes every 30 seconds — so the command card must be built from the building, not
   *  from the unit type. */
  shopWaresOf(shopId: number): { items: string[]; units: string[] } {
    const u = this.units.get(shopId);
    if (!u) return { items: [], units: [] };
    const w = this.shopWares(u.typeId);
    for (const [id, s] of u.building?.stock ?? []) {
      const list = s.kind === "item" ? w.items : w.units;
      if (!list.includes(id)) list.push(id);
    }
    return w;
  }

  isShop(typeId: string): boolean {
    const w = this.shopWares(typeId);
    return w.items.length > 0 || w.units.length > 0;
  }

  /** Whether this particular building can be bought from — by data OR by script-placed stock.
   *  A Marketplace passes only on the strength of the latter. */
  isShopUnit(shopId: number): boolean {
    const u = this.units.get(shopId);
    if (!u) return false;
    return this.isShop(u.typeId) || (u.building?.stock?.size ?? 0) > 0;
  }

  /** What a shop's "interact" ability says about using it. WC3 puts all of this on the
   *  ability, not the building, and there are three of them (AbilityData.slk, all with
   *  base code `Aneu`; column names from AbilityMetaData `Neu1..Neu4`):
   *
   *    alias  name                          DataA radius  DataB interact  DataC btn  DataD arrow
   *    Aneu   "Select Hero"                 450           1               1          1
   *    Aall   "Shop Sharing, Allied Bldg."  600           1               1          1
   *    Ane2   "Select Unit"                 450           16              0          0
   *
   *  The split is coherent and we honour it: buildings that sell ITEMS carry Aneu (Goblin
   *  Merchant `ngme`, Marketplace `nmrk`) or Aall (the four race shops `hvlt`/`ovln`/`eden`/
   *  `utom`) and get both the Select User button and the overhead arrow, because an item
   *  needs a unit to receive it. Buildings that sell UNITS carry Ane2 (Tavern, Mercenary
   *  Camps, Goblin Lab, the shipyards, Dragon Roosts) and explicitly set BOTH flags to 0 —
   *  a purchased unit walks out on its own, so there is nobody to nominate and nothing to
   *  point an arrow at.
   *
   *  `Rng1` is 350 on all three and is a different number: the range at which the
   *  `neutralinteract` order may be issued, not the range at which buying works.
   *  None of this is MiscData's NeutralUseNotifyRadius=900 either — that is how far the
   *  shop SHOUTS to nearby creeps when used (notifyCreepsOfShopUse).
   *
   *  Match on the BASE CODE, and note it is not one code: Aneu and Ane2 share `Aneu`, but
   *  Aall is its own code `Aall` (verified in the SLK — the two neutral ones being siblings
   *  makes it tempting to assume all three are, and then every race shop silently falls
   *  back to the default radius with no button and no arrow). */
  private shopInteract(typeId: string): { abilityId: string; radius: number; showButton: boolean; showArrow: boolean } {
    const fallback = { abilityId: "", radius: DEFAULT_SHOP_RADIUS, showButton: false, showArrow: false };
    const def = this.unitReg?.get(typeId);
    if (!def || !this.abilities) return fallback;
    for (const abilId of def.abilities) {
      const a = this.abilities.get(abilId);
      if (!a || (a.code !== "Aneu" && a.code !== "Aall")) continue;
      const lvl = a.levelData[0];
      if (!lvl) continue;
      const r = lvl.data[0];
      return {
        abilityId: abilId,
        radius: r && !Number.isNaN(r) ? r : DEFAULT_SHOP_RADIUS,
        showButton: lvl.data[2] === 1,
        showArrow: lvl.data[3] === 1,
      };
    }
    return fallback;
  }

  /** The shop's interact ability (Aneu/Ane2/Aall), so the HUD can build its Select User
   *  button — icon, name, hotkey and tooltip — out of the game's own ability data. */
  shopInteractAbility(shopId: number): string {
    const shop = this.units.get(shopId);
    return shop ? this.shopInteract(shop.typeId).abilityId : "";
  }

  /** How far from a shop a patron may stand (see shopInteract). */
  private shopRadius(typeId: string): number {
    return this.shopInteract(typeId).radius;
  }

  /** Does this shop nominate a purchasing unit — the "Select User" button on its command
   *  card and the team-coloured arrow over the chosen unit? False for the unit-sellers. */
  shopSelectsUser(shopId: number): boolean {
    const shop = this.units.get(shopId);
    return !!shop && this.shopInteract(shop.typeId).showButton;
  }
  shopShowsArrow(shopId: number): boolean {
    const shop = this.units.get(shopId);
    return !!shop && this.shopInteract(shop.typeId).showArrow;
  }

  /** The units of `player` that could take delivery of an item bought from this shop — WC3's
   *  "valid patron". A patron needs an inventory (in melee that means a hero) and must be
   *  standing inside the shop's activation radius; otherwise the purchase is refused with
   *  "A valid patron must be nearby." (commandstrings.txt `Neednearbypatron`).
   *  Measured centre-to-centre against radius + the shop's collision, so a big shop doesn't
   *  make its own doorstep out of range. */
  shopPatrons(shopId: number, player: number): SimUnit[] {
    const shop = this.units.get(shopId);
    if (!shop) return [];
    const out: SimUnit[] = [];
    for (const u of this.units.values()) {
      if (u.owner !== player || u.hp <= 0 || !u.inventory.length) continue;
      if (this.inShopRange(shop, u)) out.push(u);
    }
    return out;
  }

  /** Who a player has nominated to take delivery at a given shop: shopId → player → unitId.
   *
   *  Keyed by PLAYER as well as by shop because a neutral Goblin Merchant serves everyone at
   *  once and each player's choice is their own — which is also why WC3 issues the pick as
   *  `IssueNeutralTargetOrderById(owner, shop, 852566, buyer)`, with the player as the first
   *  argument rather than the shop's owner doing the ordering.
   *
   *  Nothing prunes this map: a nomination is re-validated on every read (shopBuyer), so a
   *  unit that dies, is removed, or simply walks out of range quietly stops being the buyer
   *  without every removal path in the sim having to know shops exist. */
  private shopBuyers = new Map<number, Map<number, number>>();

  /** Nominate `unitId` as `player`'s purchaser at `shop` (WC3's "Select Hero"/"Select Unit",
   *  the `neutralinteract` order). Refuses anything that isn't a valid patron right now.
   *  Passing 0 clears the nomination and hands the shop back to the default rule. */
  setShopBuyer(shopId: number, player: number, unitId: number): boolean {
    const shop = this.units.get(shopId);
    if (!shop || !this.isShopUnit(shopId) || !this.shopSelectsUser(shopId)) return false;
    if (unitId === 0) {
      this.shopBuyers.get(shopId)?.delete(player);
      return true;
    }
    const u = this.units.get(unitId);
    if (!u || u.owner !== player || u.hp <= 0 || !u.inventory.length) return false;
    if (!this.inShopRange(shop, u)) return false;
    let per = this.shopBuyers.get(shopId);
    if (!per) this.shopBuyers.set(shopId, (per = new Map()));
    per.set(player, unitId);
    return true;
  }

  /** The unit that takes delivery of `player`'s next purchase at `shop`, or null if they
   *  have no eligible unit nearby.
   *
   *  The choice is STICKY. Once a shop has a purchaser it keeps it until that unit stops
   *  being eligible (dies, is removed, walks out of range) or the player nominates another
   *  by hand — a second hero arriving, even a nearer one, must never quietly take delivery
   *  of what you were about to buy. This used to recompute "nearest patron" on every read,
   *  so the buyer changed under the player as units wandered past.
   *
   *  Adoption (picking one when there is none) is deliberately NOT done here: this is a
   *  query, called from the renderer among other places, and committing state from it would
   *  tie the sim's choice to how often something happened to ask. tickShopBuyers owns it. */
  shopBuyer(shopId: number, player: number): SimUnit | null {
    const shop = this.units.get(shopId);
    if (!shop) return null;
    const nominated = this.shopBuyers.get(shopId)?.get(player);
    if (nominated === undefined) return null;
    const u = this.units.get(nominated);
    if (u && u.owner === player && u.hp > 0 && u.inventory.length && this.inShopRange(shop, u)) return u;
    this.shopBuyers.get(shopId)?.delete(player); // stale — dead, gone, or walked away
    return null;
  }

  /** Give every shop a purchaser for every player who has one standing there and hasn't
   *  got one already — the first eligible unit to arrive becomes the buyer, and from then
   *  on only the player's own Select User pick moves it (see shopBuyer).
   *
   *  Ticked rather than resolved lazily so the choice depends on the sim's clock, not on
   *  who asked. Cheap: it only walks shops that actually nominate a buyer, and only reaches
   *  for the patron list when that shop+player has no valid one. */
  private tickShopBuyers(): void {
    for (const shop of this.units.values()) {
      if (shop.hp <= 0 || !this.isShopUnit(shop.id) || !this.shopSelectsUser(shop.id)) continue;
      // Which players have a unit here at all — no patrons, nothing to adopt.
      const seen = new Set<number>();
      for (const u of this.units.values()) {
        if (u.hp <= 0 || !u.inventory.length || seen.has(u.owner)) continue;
        if (!this.inShopRange(shop, u)) continue;
        seen.add(u.owner);
        if (this.shopBuyer(shop.id, u.owner)) continue; // already has a valid one — leave it
        let per = this.shopBuyers.get(shop.id);
        if (!per) this.shopBuyers.set(shop.id, (per = new Map()));
        per.set(u.owner, u.id);
      }
    }
  }

  /** Every (unit, shop) pairing that should wear the overhead arrow for `player` this
   *  frame: the buyer each arrow-showing shop would deliver to. Returns unit ids — one
   *  unit standing between two shops still wears ONE arrow, as in the game. */
  shopArrowUnits(player: number): Set<number> {
    const out = new Set<number>();
    for (const shop of this.units.values()) {
      if (shop.hp <= 0 || !this.isShopUnit(shop.id) || !this.shopShowsArrow(shop.id)) continue;
      const buyer = this.shopBuyer(shop.id, player);
      if (buyer) out.add(buyer.id);
    }
    return out;
  }

  /** Is `u` standing close enough to use `shop`? The one range test both the patron list and
   *  the purchase itself go through — stated as "within", never as "not beyond", so a NaN
   *  coordinate fails it. (`NaN > reach` is false, so the negated form would have quietly let
   *  a unit with a broken position shop from anywhere.) */
  private inShopRange(shop: SimUnit, u: SimUnit): boolean {
    return Math.hypot(u.x - shop.x, u.y - shop.y) <= this.shopRadius(shop.typeId) + shop.radius;
  }

  /** The requirements `player` has NOT met for `itemId` AT THIS SHOP — the red "Requires:" line,
   *  and the gate on the purchase itself.
   *
   *  A tech requirement belongs to the RACE shop, and to it alone. An item carries ONE
   *  requirement list but is sold in two very different places: the Arcane Vault MAKES a Scroll
   *  of Town Portal (`Makeitems`), and gates it on a Keep the way it gates anything it produces;
   *  a Goblin Merchant merely has one on the shelf (`Sellitems`), and it does not care who you
   *  are or what you have built. Anybody may buy anything a neutral shop has in stock — and
   *  BEING IN STOCK is the whole gate, which is why every ware carries a restock clock of its
   *  own (`stockStart` / `stockRegen`) and wears a cooldown sweep while it is out.
   *
   *  The Scroll of Healing is what makes this unmistakable: `[shea] Requires=unp2` is a Black
   *  Citadel — the Undead Tomb of Relics' own tier-3 gate, and the Tomb does sell the scroll —
   *  yet the same scroll sits on every Goblin Merchant, where a Human could never in the game's
   *  lifetime meet it. The requirement never belonged to the merchant. */
  missingForShop(shopId: number, itemId: string, player: number): string[] {
    if (!this.tech) return [];
    const shop = this.units.get(shopId);
    const raceShop = !!shop && (this.techReg?.get(shop.typeId).makeitems.includes(itemId) ?? false);
    return raceShop ? this.tech.missing(player, itemId) : [];
  }

  /** Stock remaining for one ware (item or unit) at a shop; -1 when it isn't stocked at all. */
  shopStock(shopId: number, wareId: string): number {
    const s = this.units.get(shopId)?.building?.stock?.get(wareId);
    return s ? s.count : -1;
  }

  /** A ware's whole shelf state, for the command card: how many are left, and — while none are
   *  — how long until the next arrives and how far through that wait we are. An out-of-stock
   *  ware wears the same clockwise sweep as an ability on cooldown, because that is exactly
   *  what it is on. */
  shopStockInfo(shopId: number, wareId: string): ShopStock | null {
    return this.units.get(shopId)?.building?.stock?.get(wareId) ?? null;
  }

  /** Seed a shop's shelves. The restock schedule runs on the GAME clock, not on when the shop
   *  was raised, so a shop built (or captured) late already carries whatever has come due —
   *  otherwise an Arcane Vault put up at minute 10 would make you wait until 17:20 for a
   *  Potion of Healing (stockStart 440). */
  private initShopStock(u: SimUnit): void {
    if (!u.building || !this.techReg) return;
    const wares = this.shopWares(u.typeId);
    if (!wares.items.length && !wares.units.length) return;
    const stock = new Map<string, ShopStock>();
    const seed = (id: string, kind: "item" | "unit", max: number, regen: number, start: number) => {
      if (max <= 0) return;
      const t = this.elapsed;
      let count: number;
      let timer: number;
      let period: number;
      if (t < start) {
        count = 0; // not on the shelves yet
        timer = start - t;
        period = timer; // the sweep runs the whole of the FIRST wait, which is not `regen` long
      } else if (regen > 0) {
        const since = t - start;
        count = Math.min(max, 1 + Math.floor(since / regen));
        timer = regen - (since % regen);
        period = regen;
      } else {
        count = 1; // one, and never replenished (a Tavern's heroes)
        timer = Infinity;
        period = Infinity;
      }
      stock.set(id, { count, max, regen, timer, period, kind });
    };
    for (const id of wares.items) {
      const d = this.itemReg?.get(id);
      if (d) seed(id, "item", d.stockMax, d.stockRegen, d.stockStart);
    }
    for (const id of wares.units) {
      const d = this.unitReg?.get(id);
      if (d) seed(id, "unit", d.stockMax, d.stockRegen, d.stockStart);
    }
    if (stock.size) u.building.stock = stock;
  }

  // --- runtime stock, for Blizzard.j's Marketplace (issue #57) ------------------
  //
  // The Marketplace (`nmrk`) is the one shop with no wares in its data at all: NeutralUnitFunc
  // gives it no `Sellitems`. Its shelves are stocked at RUNTIME by Blizzard's own JASS —
  // InitNeutralBuildings starts a timer, and every 30s (after a 120s delay) PerformStockUpdates
  // picks a random (item class, level) that some creep on the map is known to drop, then
  // UpdateEachStockBuilding enumerates every "marketplace" and calls AddItemToStock on it.
  // We run that script rather than reimplementing it (the house rule), so all the sim owes it
  // is these mutators. See src/jass/natives/stock.ts.

  /** Default type-slot caps for shops the script hasn't set explicitly — JASS
   *  SetAllItemTypeSlots / SetAllUnitTypeSlots. Blizzard.j's InitNeutralBuildings sets both to
   *  11 on its own; these defaults only matter on a map whose script never runs. */
  private allItemSlots: number = MELEE.MAX_STOCK_ITEM_SLOTS;
  private allUnitSlots: number = MELEE.MAX_STOCK_UNIT_SLOTS;

  setAllTypeSlots(kind: "item" | "unit", slots: number): void {
    if (kind === "item") this.allItemSlots = Math.max(0, slots);
    else this.allUnitSlots = Math.max(0, slots);
  }

  setTypeSlots(shopId: number, kind: "item" | "unit", slots: number): void {
    const b = this.units.get(shopId)?.building;
    if (!b) return;
    if (kind === "item") b.stockItemSlots = Math.max(0, slots);
    else b.stockUnitSlots = Math.max(0, slots);
  }

  private typeSlots(b: BuildingState, kind: "item" | "unit"): number {
    return (kind === "item" ? b.stockItemSlots : b.stockUnitSlots) ?? (kind === "item" ? this.allItemSlots : this.allUnitSlots);
  }

  /** JASS AddItemToStock / AddUnitToStock: put a ware on `shopId`'s shelf. Re-adding one the
   *  shop already carries just refreshes it. Refused when every type slot is taken — which is
   *  precisely what makes a Marketplace's window rotate rather than grow without bound: a sale
   *  removes the entry (RemoveItemFromStock, off the SELL_ITEM event) and frees the slot.
   *  Returns whether it went on the shelf. */
  addToStock(shopId: number, wareId: string, kind: "item" | "unit", count: number, max: number): boolean {
    const shop = this.units.get(shopId);
    const b = shop?.building;
    if (!shop || !b || shop.hp <= 0 || !wareId) return false;
    const stock = (b.stock ??= new Map());
    const held = stock.get(wareId);
    if (!held) {
      let used = 0;
      for (const s of stock.values()) if (s.kind === kind) used++;
      if (used >= this.typeSlots(b, kind)) return false; // shelf full
    }
    // A script-stocked ware carries no restock schedule of its own — the script IS its
    // schedule (the 30s stock-update timer), so regen stays 0 and the timer never runs.
    stock.set(wareId, { count: Math.max(0, count), max: Math.max(1, max), regen: 0, timer: Infinity, period: Infinity, kind });
    return true;
  }

  /** JASS RemoveItemFromStock / RemoveUnitFromStock: take the ware off the shelf entirely
   *  (not just decrement it) — the slot is freed for the next stock update. */
  removeFromStock(shopId: number, wareId: string): void {
    this.units.get(shopId)?.building?.stock?.delete(wareId);
  }

  /** Replenish every shop's shelves. A full shelf runs no timer; a ware with `stockRegen` 0
   *  never comes back once taken. */
  private tickShops(dt: number): void {
    for (const u of this.units.values()) {
      const stock = u.building?.stock;
      if (!stock || u.hp <= 0) continue;
      for (const s of stock.values()) {
        if (s.count >= s.max || !Number.isFinite(s.timer)) continue;
        s.timer -= dt;
        if (s.timer <= 0) {
          s.count++;
          s.timer = s.regen > 0 ? s.regen : Infinity;
          s.period = s.timer;
        }
      }
    }
  }

  /** Take one off the shelf, starting the restock timer if the shelf had been full. */
  private takeStock(shop: SimUnit, wareId: string): boolean {
    const s = shop.building?.stock?.get(wareId);
    if (!s || s.count <= 0) return false;
    const wasFull = s.count >= s.max;
    s.count--;
    if (wasFull) {
      s.timer = s.regen > 0 ? s.regen : Infinity;
      s.period = s.timer;
    }
    return true;
  }

  /** Buy an item from a shop and hand it straight to `buyerId` (WC3 puts it in the patron's
   *  inventory, it does not drop it on the floor). Returns why it failed, so the HUD can
   *  print the game's own message. */
  purchaseItem(shopId: number, buyerId: number, itemId: string, player: number): ShopResult {
    const shop = this.units.get(shopId);
    const buyer = this.units.get(buyerId);
    const def = this.itemReg?.get(itemId);
    if (!shop || !def || shop.hp <= 0) return "no";
    if (this.shopStock(shopId, itemId) <= 0) return "nostock";
    // A RACE shop's tech gates the shelf: an Arcane Vault's Scroll of Town Portal needs a Keep.
    // A NEUTRAL shop's does not — see missingForShop.
    if (this.missingForShop(shopId, itemId, player).length) return "req";
    if (!buyer || buyer.owner !== player || buyer.hp <= 0 || !buyer.inventory.length) return "nopatron";
    if (!this.inShopRange(shop, buyer)) return "nopatron";
    if (buyer.inventory.indexOf(null) < 0) return "full";
    const stash = this.stashOf(player);
    if (stash.gold < def.gold || stash.lumber < def.lumber) return "cost";

    if (!this.takeStock(shop, itemId)) return "nostock";
    stash.gold -= def.gold;
    stash.lumber -= def.lumber;
    const slot = buyer.inventory.indexOf(null);
    const bought = { id: this.nextItemId++, itemId, charges: def.charges, cooldownLeft: 0 };
    buyer.inventory[slot] = bought;
    this.notifyCreepsOfShopUse(shop, buyer, MISC_GAME.ItemSaleAggroRange);
    // EVENT_(PLAYER_)UNIT_SELL_ITEM. Blizzard.j listens for this on every neutral-passive
    // building and answers it with RemoveItemFromStock(GetSellingUnit(), …) — so a Marketplace
    // only ever clears a sold item off its shelf (and frees the slot for the next 30s update)
    // BECAUSE this event fires. The seller is the shop; the manipulating unit is the patron.
    this.noteItem(buyer, bought, "sell", shop);
    return "ok";
  }

  /** Buy a UNIT from a shop (a Tavern's heroes, a Mercenary Camp's creeps). No patron is
   *  needed — the unit is produced by the shop itself and walks out — but the stock still
   *  depletes, and hiring is loud: creeps hear it (UnitSaleAggroRange 600). The caller has
   *  already charged the cost and queues the training. */
  purchaseUnit(shopId: number, unitId: string, player: number): ShopResult {
    const shop = this.units.get(shopId);
    if (!shop || shop.hp <= 0) return "no";
    if (this.shopStock(shopId, unitId) <= 0) return "nostock";
    if (this.tech && !this.tech.meets(player, unitId)) return "req";
    if (!this.takeStock(shop, unitId)) return "nostock";
    // Whoever of the buyer's units is nearest the shop takes the blame for the noise. NOT
    // shopPatrons(), which only returns inventory-holders — you don't need a hero to hire a
    // mercenary, so an army of Footmen parked outside the camp must still draw the aggro.
    this.notifyCreepsOfShopUse(shop, this.nearestUnitOf(player, shop), MISC_GAME.UnitSaleAggroRange);
    return "ok";
  }

  /** The player's live unit closest to `to`, or null — who the creeps come for. */
  private nearestUnitOf(player: number, to: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      if (u.owner !== player || u.hp <= 0 || u.building) continue;
      const d = Math.hypot(u.x - to.x, u.y - to.y);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Sell an item back to a shop. WC3 pays `PawnItemRate` of its gold value (0.50 in the
   *  1.27a MiscGame.txt — NOT the 60% often quoted), and the hero must be within
   *  `PawnItemRange` (300) of the shop. The item is destroyed, not restocked. */
  pawnItem(unitId: number, slot: number, shopId: number): boolean {
    const u = this.units.get(unitId);
    const shop = this.units.get(shopId);
    if (!u || !shop || !this.itemReg || slot < 0 || slot >= u.inventory.length) return false;
    const held = u.inventory[slot];
    if (!held) return false;
    const def = this.itemReg.get(held.itemId);
    if (!def || !def.pawnable) return false;
    // The shop must actually DEAL IN ITEMS — the `Apit` ability, see canPawnAt. (Asking its
    // ware LIST instead, as this did, silently refused a Marketplace: it lists nothing.)
    if (!this.canPawnAt(shop)) return false;
    // Stated as "within", not "not beyond" — see inShopRange. Note pawning uses its own,
    // shorter reach (PawnItemRange 300) than buying does, so a hero can buy from further
    // away than he can sell.
    if (!this.inPawnRange(u, shop)) return false;
    u.inventory[slot] = null;
    const stash = this.stashOf(u.owner);
    stash.gold += Math.floor(def.gold * MISC_GAME.PawnItemRate);
    stash.lumber += Math.floor(def.lumber * MISC_GAME.PawnItemRate);
    return true;
  }

  /** Using a NEUTRAL building shouts to the creeps around it (issue #57). Two ranges, and
   *  they do two different things — the names say so:
   *
   *   - MiscData `NeutralUseNotifyRadius` (900) — creeps in earshot are NOTIFIED, i.e. they
   *     wake. Sleeping creeps are otherwise deaf, so this is what stops a player quietly
   *     shopping in the middle of a slumbering camp at night.
   *   - MiscGame `ItemSaleAggroRange` (0) / `UnitSaleAggroRange` (600) — creeps this close
   *     actually CHARGE. Buying a potion is silent (0); hiring a mercenary is not (600).
   *
   *  Only neutral buildings shout: the key is explicitly "when a neutral building is in use",
   *  and buying from the Arcane Vault in your own base must not rouse the map. */
  private notifyCreepsOfShopUse(shop: SimUnit, buyer: SimUnit | null, saleAggroRange: number): void {
    if (!shop.neutralPassive) return;
    for (const c of this.units.values()) {
      if (!c.isCreep || c.hp <= 0 || c.building || !c.weapon || c.returning) continue;
      const d = Math.hypot(c.x - shop.x, c.y - shop.y) - shop.radius;
      if (d > MISC_DATA.NeutralUseNotifyRadius) continue;
      c.asleep = false; // heard it — awake, but not necessarily coming
      if (d > saleAggroRange || !buyer || buyer.hp <= 0 || !this.hostile(c, buyer)) continue;
      c.campHelper = false; // roused in its own right, so it may call the rest of the camp
      this.issueAttack(c.id, buyer.id);
      this.alertCamp(c, buyer);
    }
  }

  /** Research finished since the last drain (renderer plays the completion sound). */
  drainResearchCompletions(): Array<{ buildingId: number; upgradeId: string; level: number; owner: number }> {
    const out = this.researchCompletions;
    this.researchCompletions = [];
    return out;
  }

  /** Buildings that morphed since the last drain (renderer swaps the model + food). */
  drainMorphs(): Array<{ unitId: number; from: string; to: string }> {
    const out = this.morphs;
    this.morphs = [];
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
  drainSpawnedProjectiles(): Array<{ id: number; art: string; x: number; y: number; z: number }> {
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
  drainProjectileImpacts(): Array<{ id: number; x: number; y: number; z: number }> {
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

  /** Positions of trees hit (but not felled) by a chop since the last drain — the
   *  renderer plays each tree's "stand hit" wobble. */
  drainTreeHits(): Array<{ x: number; y: number }> {
    if (!this.treeHits.length) return this.treeHits;
    const out = this.treeHits;
    this.treeHits = [];
    return out;
  }

  /** Attacker ids whose swing fired since the last drain (renderer plays the unit's
   *  own attack/fire sound — the SND "K" event embedded in its model). */
  drainAttackSwings(): number[] {
    if (!this.attackSwings.length) return this.attackSwings;
    const out = this.attackSwings;
    this.attackSwings = [];
    return out;
  }

  /** A building's production queue is FULL — WC3 caps it at 7 jobs, training, research and
   *  tier upgrades all sharing the one queue. Callers must ask BEFORE charging: an enqueue
   *  refused after the gold has come out of the stash is gold the player never gets back.
   *  (Not to be confused with MAX_QUEUED_ORDERS, the shift-queued ORDER cap on a unit.) */
  queueFull(buildingId: number): boolean {
    const b = this.units.get(buildingId)?.building;
    return !!b && b.queue.length >= MAX_BUILD_QUEUE;
  }

  /** Queue a unit for training at a building. Timing only — the caller has
   *  already checked/charged resources and food. */
  enqueueTrain(buildingId: number, unitId: string, buildTime: number, free = false, buyer?: number): boolean {
    const b = this.units.get(buildingId)?.building;
    if (!b || b.queue.length >= MAX_BUILD_QUEUE) return false;
    b.queue.push({ kind: "unit", unitId, timeLeft: buildTime, buildTime, free, buyer });
    this.noteTrain(buildingId, unitId, "start"); // EVENT_(PLAYER_)UNIT_TRAIN_START
    return true;
  }

  /** Queue an upgrade for research at a building. Timing only — the caller has already
   *  checked the tech requirements and charged the cost. WC3 shares ONE queue between
   *  training and research, so a Barracks researching Defend cannot also train a Footman. */
  enqueueResearch(buildingId: number, upgradeId: string, level: number, time: number): boolean {
    const b = this.units.get(buildingId)?.building;
    if (!b || b.queue.length >= MAX_BUILD_QUEUE) return false;
    b.queue.push({ kind: "research", unitId: upgradeId, level, timeLeft: time, buildTime: time });
    return true;
  }

  /** Queue this building's transformation into `toUnitId` (Town Hall → Keep, Scout Tower →
   *  Guard Tower). It keeps working while it upgrades, and morphs in place on completion. */
  enqueueUpgrade(buildingId: number, toUnitId: string, time: number): boolean {
    const b = this.units.get(buildingId)?.building;
    if (!b || b.queue.length >= MAX_BUILD_QUEUE) return false;
    b.queue.push({ kind: "upgrade", unitId: toUnitId, timeLeft: time, buildTime: time });
    return true;
  }

  /** The level a building is currently researching an upgrade at, or 0 — so the command card
   *  can show the in-progress rank and refuse to double-queue it. */
  researchingLevel(buildingId: number, upgradeId: string): number {
    const b = this.units.get(buildingId)?.building;
    if (!b) return 0;
    for (const j of b.queue) if (j.kind === "research" && j.unitId === upgradeId) return j.level;
    return 0;
  }

  /** Whether this building is already turning into something. A structure can only become one
   *  thing, so the upgrade buttons come off its card the moment one is queued — otherwise
   *  clicking "Upgrade to Keep" twice charges 705 gold twice and morphs a Keep into a Keep. */
  isUpgrading(buildingId: number): boolean {
    const b = this.units.get(buildingId)?.building;
    return !!b && b.queue.some((j) => j.kind === "upgrade");
  }

  /** Cancel the last queued item (returns the job, for the caller to refund). */
  cancelLastTrain(buildingId: number): BuildJob | null {
    const b = this.units.get(buildingId)?.building;
    if (!b || !b.queue.length) return null;
    return this.dropJob(buildingId, b.queue.pop()!);
  }

  /** Cancel a specific queued item by index (0 = the one currently in progress). Returns the
   *  job so the caller can refund it at the right rate — WC3 refunds training in full but a
   *  cancelled STRUCTURE UPGRADE only at 75% (MiscGame's UpgradeRefundRate). Removing index 0
   *  just promotes the next item, which keeps its own untouched timer. */
  cancelTrainAt(buildingId: number, index: number): BuildJob | null {
    const b = this.units.get(buildingId)?.building;
    if (!b || index < 0 || index >= b.queue.length) return null;
    return this.dropJob(buildingId, b.queue.splice(index, 1)[0]);
  }

  /** Common tail of a cancel: raise the event, and — the part that is easy to miss — put a
   *  SHOP-bought unit back on the shelf. Without this, hiring a Tavern hero and cancelling
   *  destroys her for the rest of the match: the stock was taken at purchase, and a Tavern's
   *  `stockRegen` is 0, so nothing ever restores it and NO player can hire her again. */
  private dropJob(buildingId: number, job: BuildJob): BuildJob {
    if (job.kind === "unit") {
      this.noteTrain(buildingId, job.unitId, "cancel");
      this.returnStock(buildingId, job.unitId);
    }
    return job;
  }

  /** Put one back on the shelf (a cancelled purchase). Caps at stockMax and stops the restock
   *  timer if that refills the shelf. */
  private returnStock(shopId: number, wareId: string): void {
    const s = this.units.get(shopId)?.building?.stock?.get(wareId);
    if (!s || s.count >= s.max) return;
    s.count++;
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
    // Only HUMAN peasants speed-build: extra builders pile on to finish faster. Every
    // other race builds with a single worker (Orc/NE from inside, Undead summon-and-go),
    // so refuse a would-be second builder on a non-speed-build construction.
    if (!speedBuilds(w) && b.building.constructionLeft > 0 && b.building.builderIds.length >= 1) return;
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
    // Orc peon: vanish INTO the site and build from inside (hidden), rather than
    // standing beside it. Emerges at the doorstep when the build ends (detachBuilder).
    if (buildsFromInside(w)) {
      this.enterBuildSite(w, b);
      return;
    }
    // Human peasant: snap to the nearest free tile outside the building's (now
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

  /** Orc peon disappearing INTO the structure it's building: parked at the site centre,
   *  hidden by the renderer, reserving no cells. It re-emerges via detachBuilder (called
   *  on completion, cancel, or the building's death). */
  private enterBuildSite(w: SimUnit, b: SimUnit): void {
    this.unsettle(w); // stop blocking cells while invisible inside
    w.x = b.x;
    w.y = b.y;
    w.insideBuild = true;
    w.order = "idle";
    w.moving = false;
    w.path = [];
    w.noCollision = false;
    w.desiredFacing = b.facing;
  }

  /** Orc peon leaving a structure it built from inside: place it on a free tile beside
   *  the building's footprint and clear the hidden flag. No-op for a normal builder. */
  private emergeBuilder(w: SimUnit, b: SimUnit): void {
    if (!w.insideBuild) return;
    w.insideBuild = false;
    const n = w.footprint || footprintCells(w.radius);
    const [bcx, bcy] = this.grid.worldToCell(b.x, b.y);
    const fit = this.grid.nearestFit(bcx, bcy, n) ?? this.grid.nearestWalkable(bcx, bcy);
    if (fit) [w.x, w.y] = this.grid.cellToWorld(fit[0], fit[1]);
    w.order = "idle";
    w.moving = false;
    w.path = [];
    this.settle(w);
    w.desiredFacing = Math.atan2(b.y - w.y, b.x - w.x);
  }

  // === Orc Burrow garrison ============================================================
  // Peons climb inside an Orc Burrow (up to Abun's Dataa1 = 4) and it fires arrows: one
  // piercing projectile whose DPS scales with the peon count (cooldown = base/(n+1);
  // recomputeStats). Ground truth: UnitAbilities.slk otrb has Abun (Load) + Abtl (Battle
  // Stations); Abun Dataa1=4; weapon 23-27 pierce, range 700, base cd 4 (UnitWeapons.slk);
  // scaling per Liquipedia Orc_Burrow.

  /** Passenger capacity of a unit type: Abun's Dataa1 (4 for the Orc Burrow), 0 if the
   *  type lacks the Load ability. Cached per unit in `garrisonCap` (computed once). */
  private computeGarrisonCap(typeId: string): number {
    const def = this.unitReg?.get(typeId);
    if (!def?.abilities.includes("Abun")) return 0; // only the Orc Burrow carries Load
    const cap = this.abilities?.get("Abun")?.levelData[0]?.data[0];
    return cap && cap > 0 ? Math.round(cap) : 4;
  }

  /** Whether `burrow` can take another passenger right now. */
  private burrowHasRoom(burrow: SimUnit): boolean {
    return (
      burrow.garrisonCap > 0 &&
      burrow.hp > 0 &&
      (!burrow.building || burrow.building.constructionLeft <= 0) &&
      burrow.garrison.length < burrow.garrisonCap
    );
  }

  /** Order a peon to garrison an Orc Burrow: walk there, then climb inside (tickGarrison). */
  issueGarrison(peonId: number, burrowId: number): boolean {
    const p = this.units.get(peonId);
    const b = this.units.get(burrowId);
    if (!p || !p.worker || this.castLocked(p) || !b || b.garrisonCap === 0) return false;
    if (this.hostile(p, b)) return false; // only your own / allied burrows
    p.order = "garrison";
    p.targetId = burrowId;
    p.inCombat = false;
    p.noCollision = false;
    this.cancelSwing(p);
    this.detachBuilder(peonId); // drop any build/harvest job
    p.stuckT = 0;
    p.stuckRetries = 0;
    if (this.inBurrowReach(p, b)) {
      this.enterBurrow(p, b); // already at the door — hop in now
      return true;
    }
    const [ax, ay] = this.burrowApproach(p, b);
    if (!this.pathTo(p, ax, ay)) this.stop(peonId); // no path at all → give up
    return true;
  }

  /** A walkable point just outside the burrow's footprint on the peon's side — the burrow
   *  centre itself is blocked, so pathing straight at it fails. */
  private burrowApproach(p: SimUnit, b: SimUnit): [number, number] {
    const dx = p.x - b.x, dy = p.y - b.y;
    const d = Math.hypot(dx, dy) || 1;
    const reach = b.radius + p.radius + 20;
    const ax = b.x + (dx / d) * reach, ay = b.y + (dy / d) * reach;
    const [cx, cy] = this.grid.worldToCell(ax, ay);
    const free = this.grid.nearestWalkable(cx, cy, 6);
    return free ? this.grid.cellToWorld(free[0], free[1]) : [ax, ay];
  }

  private inBurrowReach(p: SimUnit, b: SimUnit): boolean {
    return Math.max(Math.abs(p.x - b.x), Math.abs(p.y - b.y)) - b.radius - p.radius < 48;
  }

  /** Drive a peon walking to garrison: enter once it reaches the burrow's edge. */
  private tickGarrison(u: SimUnit): void {
    const b = u.targetId ? this.units.get(u.targetId) : null;
    if (!b || b.garrisonCap === 0 || b.hp <= 0) {
      this.stop(u.id);
      return;
    }
    if (u.moving) return; // still walking up
    if (this.inBurrowReach(u, b)) {
      if (this.burrowHasRoom(b)) this.enterBurrow(u, b);
      else this.stop(u.id); // full while we walked — give up
    } else {
      // Stopped short of the burrow (blocked); one more try toward the door, else idle.
      const [ax, ay] = this.burrowApproach(u, b);
      if (!this.pathTo(u, ax, ay)) this.stop(u.id);
    }
  }

  /** Peon climbs into a burrow: hidden, reserving no cells, added to its garrison. */
  private enterBurrow(peon: SimUnit, burrow: SimUnit): void {
    this.unsettle(peon); // no cell block while inside
    peon.inBurrow = true;
    peon.garrisonHost = burrow.id;
    peon.order = "idle";
    peon.targetId = null;
    peon.moving = false;
    peon.path = [];
    peon.noCollision = false;
    if (!burrow.garrison.includes(peon.id)) burrow.garrison.push(peon.id);
    this.recomputeStats(burrow); // switch the arrow attack on / rescale its cooldown
  }

  /** Eject one garrisoned peon to a free doorstep tile beside its burrow. */
  private ejectPeon(peon: SimUnit, burrow: SimUnit): void {
    peon.inBurrow = false;
    peon.garrisonHost = 0;
    const n = peon.footprint || footprintCells(peon.radius);
    const [bcx, bcy] = this.grid.worldToCell(burrow.x, burrow.y);
    const fit = this.grid.nearestFit(bcx, bcy, n) ?? this.grid.nearestWalkable(bcx, bcy);
    if (fit) [peon.x, peon.y] = this.grid.cellToWorld(fit[0], fit[1]);
    peon.order = "idle";
    peon.moving = false;
    peon.path = [];
    this.settle(peon); // blocks its cell so the next ejected peon fans out beside it
    peon.desiredFacing = Math.atan2(peon.y - burrow.y, peon.x - burrow.x);
  }

  /** Unload every peon from a burrow (the Unload command). */
  unloadBurrow(burrowId: number): boolean {
    const b = this.units.get(burrowId);
    if (!b || b.garrison.length === 0) return false;
    for (const pid of [...b.garrison]) {
      const p = this.units.get(pid);
      if (p) this.ejectPeon(p, b);
    }
    b.garrison = [];
    this.recomputeStats(b); // empty → arrow attack off
    return true;
  }

  /** Battle Stations: order nearby idle friendly peons into burrows with room, this one
   *  first, then the nearest others (Abtl). */
  battleStations(burrowId: number): boolean {
    const b = this.units.get(burrowId);
    if (!b || b.garrisonCap === 0) return false;
    const R2 = 800 * 800; // gather radius around the burrow (WC3 ~ screenful)
    const peons = [...this.units.values()]
      .filter((p) => p.worker && p.owner === b.owner && p.hp > 0 && !p.inBurrow && !p.inMine && !p.insideBuild && !p.constructing && (p.x - b.x) ** 2 + (p.y - b.y) ** 2 <= R2)
      .sort((a, c) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 - ((c.x - b.x) ** 2 + (c.y - b.y) ** 2));
    // Project the seats we've already handed out this call so peons distribute across
    // burrows instead of all walking to the same one (only `cap` can actually enter).
    const dispatched = new Map<number, number>();
    const roomFor = (bur: SimUnit): boolean =>
      bur.hp > 0 && (!bur.building || bur.building.constructionLeft <= 0) &&
      bur.garrison.length + (dispatched.get(bur.id) ?? 0) < bur.garrisonCap;
    let sent = 0;
    for (const p of peons) {
      let target: SimUnit | null = roomFor(b) ? b : null;
      if (!target) {
        let bestD = Infinity;
        for (const u of this.units.values()) {
          if (u.garrisonCap === 0 || u.owner !== b.owner || !roomFor(u)) continue;
          const d = (u.x - p.x) ** 2 + (u.y - p.y) ** 2;
          if (d < bestD) { bestD = d; target = u; }
        }
      }
      if (!target) break; // every burrow full
      if (this.issueGarrison(p.id, target.id)) {
        dispatched.set(target.id, (dispatched.get(target.id) ?? 0) + 1);
        sent++;
      }
    }
    return sent > 0;
  }

  /** Stop a worker constructing/repairing (manual order, or death). Called by
   *  every re-task path, so it also cancels a repair job. */
  private detachBuilder(workerId: number): void {
    const w = this.units.get(workerId);
    if (!w) return;
    w.repair = null; // re-tasking cancels a repair
    if (!w.constructing) return;
    const bu = this.units.get(w.constructing);
    if (bu?.building) bu.building.builderIds = bu.building.builderIds.filter((id) => id !== workerId);
    // Orc peon leaving the site it built from inside — pop it out to the doorstep.
    if (w.insideBuild && bu) this.emergeBuilder(w, bu);
    else w.insideBuild = false;
    w.constructing = 0;
  }

  /** Order a worker to repair a damaged friendly building. Params (rate + cost
   *  per HP) are computed by the caller from the building's build cost/time. */
  issueRepair(id: number, buildingId: number, hpPerSec: number, goldPerHp: number, lumberPerHp: number): boolean {
    const u = this.units.get(id);
    const b = this.units.get(buildingId);
    if (!u || !u.worker || !b?.building || b.building.constructionLeft > 0 || b.hp >= b.maxHp) return false;
    if (this.hasLiquidFire(b)) return false; // Liquid Fire prevents repair while it burns
    if (this.castLocked(u)) return false;
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
      // An UPROOTED Ancient is not a building right now: it trains nothing and researches
      // nothing while it walks. The queue is left exactly as it stands rather than refunded —
      // this is a pause, and planting again resumes it where it stopped.
      if (u.uprooted) continue;
      if (b.constructionLeft > 0) {
        // Debug cheat: finish in ~1s no matter what (no builder required).
        if (this.fastBuild) {
          b.constructionLeft = Math.max(0, b.constructionLeft - Math.max(dt, b.buildTimeTotal * dt));
          u.hp = u.maxHp * (0.1 + 0.9 * (1 - b.constructionLeft / b.buildTimeTotal));
          if (b.constructionLeft === 0) {
            for (const bid of [...b.builderIds]) this.detachBuilder(bid);
            this.noteConstruct(u.id, "finish"); // EVENT_(PLAYER_)UNIT_CONSTRUCT_FINISH
          }
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
          // Orc peon that has walked up to the site now vanishes inside to build
          // (hidden). Once inside it sits at the centre, so it reads as "present".
          if (buildsFromInside(builder) && !builder.insideBuild && !builder.moving &&
              Math.max(Math.abs(builder.x - u.x), Math.abs(builder.y - u.y)) - u.radius - builder.radius < 96) {
            this.enterBuildSite(builder, u);
          }
          const nearby =
            !builder.moving &&
            Math.max(Math.abs(builder.x - u.x), Math.abs(builder.y - u.y)) - u.radius - builder.radius < 96;
          if (nearby) {
            if (!builder.insideBuild) builder.desiredFacing = Math.atan2(u.y - builder.y, u.x - builder.x); // face the site while hammering
            present++;
          }
        }
        if (present > 0) {
          // Extra builders past the first speed the build but burn extra
          // resources (HUMAN only — speedBuilds()). If the owner can't pay this
          // tick's surcharge, drop back toward the base rate (only as many extras
          // as they can afford).
          let extra = speedBuilds(u) ? present - 1 : 0;
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
          if (b.constructionLeft === 0) {
            for (const bid of [...b.builderIds]) this.detachBuilder(bid); // free the workers
            this.noteConstruct(u.id, "finish"); // EVENT_(PLAYER_)UNIT_CONSTRUCT_FINISH
          }
        }
        continue; // can't train while still being built
      }
      const job = b.queue[0];
      if (job) {
        // Debug cheat compresses any train time to ~1 second.
        job.timeLeft -= this.fastBuild ? Math.max(dt, job.buildTime * dt) : dt;
        if (job.timeLeft <= 0) {
          b.queue.shift();
          if (job.kind === "research") {
            this.tech?.setResearchLevel(u.owner, job.unitId, job.level);
            this.researchCompletions.push({ buildingId: u.id, upgradeId: job.unitId, level: job.level, owner: u.owner });
            this.applyUnitSwap(u.owner, job.unitId); // rtma: morph existing units (Headhunter→Berserker)
          } else if (job.kind === "upgrade") {
            this.morphUnit(u, job.unitId);
          } else {
            this.trainCompletions.push({ buildingId: u.id, unitId: job.unitId, x: u.x, y: u.y, rallyX: b.rallyX, rallyY: b.rallyY, rallyKind: b.rallyKind, rallyTargetId: b.rallyTargetId });
          }
        }
      }
    }
  }

  /** Transform a finished building into its upgraded form in place (Town Hall → Keep, Scout
   *  Tower → Guard Tower). WC3 keeps the SAME entity — its rally point, its queue and its
   *  damage all carry over — so this rewrites the type and re-derives the stats rather than
   *  destroying and respawning, which would flash the selection and drop the rally.
   *
   *  HP carries over as a FRACTION: a Town Hall at half health becomes a half-health Keep,
   *  not a Keep with 750/2000. The renderer picks the swap up from `morphs` and re-attaches
   *  the new model. */
  private morphUnit(u: SimUnit, toTypeId: string): void {
    const def = this.unitReg?.get(toTypeId);
    if (!def) return;
    const frac = u.maxHp > 0 ? Math.min(1, u.hp / u.maxHp) : 1;
    const from = u.typeId;
    u.typeId = toTypeId;
    u.baseMaxHp = def.hitPoints;
    u.baseArmor = def.armor;
    u.armorType = def.armorType;
    u.baseSightDay = def.sightDay;
    u.baseSightNight = def.sightNight;
    u.baseSpeed = def.speed;
    // Rebuild the type-derived combat kit: a Headhunter→Berserker gains the Berserk ability
    // and the Berserker's stronger throw; a building keeps its (usually empty) kit. Preserve
    // any current cast/order by leaving order state alone — only the type's innate loadout swaps.
    u.weapons = weaponsFromDef(def);
    u.weapon = u.weapons.find((w) => w.enabled) ?? null;
    u.abilities = this.buildAbilitiesFor(def);
    // What it produces is a property of the TYPE, so re-derive it: a structure that only gains
    // a training list on upgrade would otherwise never get a rally point.
    if (u.building && this.techReg) {
      const t = this.techReg.get(toTypeId);
      u.building.producesUnits = t.trains.length > 0 || t.sellunits.length > 0;
    }
    this.recomputeStats(u); // maxHp now reflects the new type (+ any research already in)
    u.hp = Math.max(1, u.maxHp * frac);
    this.tech?.invalidate(); // a Keep satisfies requirements a Town Hall does not
    this.morphs.push({ unitId: u.id, from, to: toTypeId });
  }

  /**
   * The generic FORM TOGGLE behind every two-form ability in the game: Burrow, Bear Form,
   * Crow Form, Stone Form, Destroyer Form, Ethereal Form, Submerge. They are one mechanism
   * wearing different art, and the ability row says so — AbilityMetaData names the columns
   * the same way for all of them:
   *
   *   DataA   "Normal Form Unit"     `[Abur] = ucry`  the Crypt Fiend
   *   UnitID1 "Alternate Form Unit"  `[Abur] = ucrm`  the burrowed Crypt Fiend
   *
   * So a form is not a state to model — it is a UNIT, and morphing to it is the whole
   * implementation. Everything the burrowed Crypt Fiend does differently is already written
   * down in `ucrm`: spd "-" (it cannot move), weapsOn 0 (it cannot attack), regenHP 5 against
   * the walking form's 2 (the reason to burrow at all), and an abilList that drops Web but
   * keeps Burrow so it can dig out again. Not one of those needed a line of code here.
   *
   * Which direction to go is read off the unit rather than tracked: a unit standing in its
   * alternate form goes back to normal, anything else goes alternate. That also means the
   * pair can be entered from either side, which matters because several of these units are
   * TRAINED in their alternate form (the Spirit Walker arrives ethereal).
   */
  morphToggle(u: SimUnit, def: AbilityDef): boolean {
    const lvl = def.levelData[0];
    const normal = lvl?.dataStr[0] ?? ""; // DataA "Normal Form Unit"
    const alternate = lvl?.summon ?? ""; // UnitID1 "Alternate Form Unit"
    if (!normal || !alternate) return false;
    const to = u.typeId === alternate ? normal : alternate;
    if (!this.unitReg?.get(to)) return false; // this install doesn't ship the other form
    this.morphUnit(u, to);
    // Both forms share one MDX (ucrm is CryptFiend.mdx too), so the alternate FORM also wears
    // the alternate half of the model — the burrowed pose is "Stand Alternate", reached
    // through the same Morph clip an Ancient uses. See SimUnit.altModel.
    u.altModel = to === alternate;
    // A form with no weapon can neither attack nor keep a target it was swinging at, and the
    // weaponless one is also the ethereal one (weapsOn=0 is how the Spirit Walker's two forms
    // are told apart in the data — there is no "is ethereal" column).
    u.etherealForm = !u.weapon && this.isEtherealForm(u.typeId);
    if (!u.weapon) this.stop(u.id);
    this.recomputeStats(u);
    return true;
  }

  /** Is this unit type an ETHEREAL form, as opposed to merely a weaponless one? A burrowed
   *  Crypt Fiend has no weapon either and is emphatically not ethereal — it is underground,
   *  not on another plane. Only the Spirit Walker's form pair carries the ethereal rules
   *  (immune to physical, +magic taken), and its alternate form is the one unit that means
   *  it, so this stays an explicit list rather than being inferred from the empty weapon. */
  private isEtherealForm(typeId: string): boolean {
    return typeId === "ospm";
  }

  /** Spirit Walker form toggle (JASS/legacy entry point) — now just the generic morph with
   *  the Ethereal Form ability's own row supplying both ids. */
  toggleSpiritForm(u: SimUnit): void {
    const def = this.abilities?.get("Aetf");
    if (def) this.morphToggle(u, def);
  }

  /** The innate/learnable abilities a unit type carries (mirrors RtsController.
   *  buildInitialAbilities) — used when a unit morphs into another type. */
  private buildAbilitiesFor(def: UnitDef): SimAbility[] {
    const out: SimAbility[] = [];
    if (!this.abilities) return out;
    for (const id of def.abilities) {
      const a = this.abilities.get(id);
      if (a && KNOWN_ABILITIES[a.code]) out.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: def.autoAbility === id });
    }
    for (const id of def.heroAbilities) {
      const a = this.abilities.get(id);
      if (a && KNOWN_ABILITIES[a.code]) out.push({ id, code: a.code, level: 0, cooldownLeft: 0, autocastOn: false });
    }
    return out;
  }

  /** rtma unit-swap: when an upgrade completes, every existing unit of the withdrawn type
   *  (owned by that player) morphs into the enabled type in place — the Berserker Upgrade
   *  turning all of a player's Headhunters into Troll Berserkers. */
  private applyUnitSwap(owner: number, upgradeId: string): void {
    const swap = this.tech?.unitSwapForUpgrade(upgradeId);
    if (!swap || !this.tech) return;
    // Flip production: the enabled unit becomes trainable, the withdrawn one hidden. The map's
    // melee init caps the upgraded unit (SetPlayerTechMaxAllowed(otbk,0)) at start, and that
    // explicit cap outranks the rtma tech-availability — so the swap must override it here.
    this.tech.setMaxAllowed(owner, swap.to, -1);
    this.tech.setMaxAllowed(owner, swap.from, 0);
    // Morph every existing unit of the withdrawn type in place.
    for (const u of this.units.values()) {
      if (u.owner === owner && u.typeId === swap.from && u.hp > 0) this.morphUnit(u, swap.to);
    }
  }

  /** Cancel a building (manual cancel of an under-construction structure): free
   *  its builder and remove it WITHOUT a death animation — a cancelled building
   *  isn't destroyed in combat, it simply vanishes (the caller plays the race's
   *  cancel-explosion effect over the spot). Returns whether it was removed. */
  cancelBuilding(id: number): boolean {
    const u = this.units.get(id);
    if (!u?.building) return false;
    this.noteConstruct(u.id, "cancel"); // EVENT_(PLAYER_)UNIT_CONSTRUCT_CANCEL (before it's gone)
    for (const bid of [...u.building.builderIds]) this.detachBuilder(bid);
    this.unsettle(u); // free its reserved cells
    this.releasePathStamp(u); // …and its footprint's collision
    this.units.delete(u.id);
    this.removals.push(u.id);
    return true;
  }

  /** Remove a unit outright — NO death, corpse, XP, or item drops (JASS RemoveUnit
   *  semantics). Frees its cells/builders and queues the render-side drop (onRemove). */
  removeUnit(id: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    this.refundPendingBuild(u);
    this.unsettle(u);
    this.releasePathStamp(u);
    if (u.building) for (const bid of [...u.building.builderIds]) this.detachBuilder(bid);
    if (u.constructing) this.detachBuilder(u.id);
    if (u.garrison.length) this.unloadBurrow(u.id); // eject passengers before it vanishes
    if (u.garrisonHost) {
      const host = this.units.get(u.garrisonHost);
      if (host) {
        host.garrison = host.garrison.filter((id) => id !== u.id);
        this.recomputeStats(host);
      }
    }
    this.units.delete(u.id);
    this.removals.push(u.id);
    this.unitDrops.delete(u.id);
    return true;
  }

  /** Kill a unit as if slain (death animation + corpse + drops — JASS KillUnit). */
  killUnit(id: number): boolean {
    const u = this.units.get(id);
    if (!u) return false;
    this.kill(u);
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
      | "swingBroken"
      | "swingCrit"
      | "swingBash"
      | "swingSlam"
      | "chopSeq"
      | "inCombat"
      | "neutralPassive"
      | "chaseX"
      | "chaseY"
      | "followOffX"
      | "followOffY"
      | "followLeaderId"
      | "atkOffX"
      | "atkOffY"
      | "atkOffTarget"
      | "amDestX"
      | "amDestY"
      | "patrolX"
      | "patrolY"
      | "acquireT"
      | "stuckT"
      | "stuckRetries"
      | "stallT"
      | "stallAnchorX"
      | "stallAnchorY"
      | "stallGap"
      | "gaveUp"
      | "gaveUpGap"
      | "attackStalls"
      | "stuckAnchorX"
      | "stuckAnchorY"
      | "repathT"
      | "repollT"
      | "yieldT"
      | "prevX"
      | "prevY"
      | "velX"
      | "velY"
      | "footprint"
      | "pathStamp"
      | "resX"
      | "resY"
      | "hasReservation"
      | "resKind"
      | "resId"
      | "workT"
      | "inMine"
      | "insideBuild"
      | "inBurrow"
      | "garrisonHost"
      | "garrison"
      | "garrisonCap"
      | "linkGroup"
      | "linkT"
      | "linkShare"
      | "devouring"
      | "devouredBy"
      | "etherealForm"
      | "working"
      | "atNode"
      | "noCollision"
      | "building"
      | "constructing"
      | "repair"
      | "orderQueue"
      | "buildPending"
      | "isHero"
      | "properName"
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
      | "weapon"
      | "swingWeapon"
      | "manaRegen"
      | "hpRegen"
      | "lifesteal"
      | "thorns"
      | "bonusArmor"
      | "bonusDamage"
      | "bonusStr"
      | "bonusAgi"
      | "bonusInt"
      | "abilities"
      | "buffs"
      | "stunned"
      | "paused"
      | "silenced"
      | "ethereal"
      | "magicImmune"
      | "detectRadius"
      | "uprooted"
      | "rootedFootprint"
      | "altModel"
      | "invisible"
      | "cloaked"
      | "invulnerable"
      | "baseInvulnerable"
      | "mechanical"
      | "isPeon"
      | "isSummon"
      | "spawning"
      | "summonLeft"
      | "summonMax"
      | "unsummonArt"
      | "vanished"
      | "isIllusion"
      | "illusionOf"
      | "illusionDamageDealt"
      | "illusionDamageTaken"
      | "pendingCast"
      | "isCreep"
      | "guardX"
      | "guardY"
      | "guardFacing"
      | "aggroRange"
      | "canSleep"
      | "asleep"
      | "returning"
      | "campHelper"
      | "campGuard"
      | "strayT"
      | "returnBestDist"
      | "returnStuckT"
      | "inventory"
      | "getItemId"
      | "pendingGive"
      | "pendingSell"
      | "pendingDrop"
      | "baseSightDay"
      | "baseSightNight"
    >,
    building?: BuildingState | null,
    opts?: { hero?: HeroInit; abilities?: SimAbility[]; mechanical?: boolean; isPeon?: boolean; manaRegen?: number; level?: number; baseInvulnerable?: boolean },
  ): SimUnit {
    const hero = opts?.hero;
    // The primary weapon is DERIVED, never passed in: it is the first slot `weapsOn` has
    // switched on (the Chimaera's is slot 2 — its acid breath sits in slot 1, off, until
    // Corrosive Breath). recomputeStats() re-picks it whenever an upgrade rewrites the mask.
    const weapon = unit.weapons.find((w) => w.enabled) ?? null;
    const u: SimUnit = {
      ...unit,
      weapon,
      swingWeapon: null,
      // Pre-upgrade vision baselines. recomputeStats() rebuilds the live values from these
      // every tick, so researching Forged Swords mid-game lifts every existing Footman (the
      // weapon baselines live on each SimWeapon — see SimWeapon.base*).
      baseSightDay: unit.sightDay,
      baseSightNight: unit.sightNight,
      desiredFacing: unit.facing,
      order: "idle",
      targetId: null,
      cooldownLeft: 0,
      swingLeft: -1,
      swingTargetId: 0,
      swingSeq: 0,
      swingBroken: false,
      swingCrit: false,
      swingBash: false,
      swingSlam: false,
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
      followLeaderId: null,
      atkOffX: 0,
      atkOffY: 0,
      atkOffTarget: -1,
      amDestX: unit.x,
      amDestY: unit.y,
      patrolX: unit.x,
      patrolY: unit.y,
      acquireT: 0,
      stuckT: 0,
      stuckRetries: 0,
      stallT: 0,
      stallAnchorX: unit.x,
      stallAnchorY: unit.y,
      stallGap: 0,
      gaveUp: false,
      gaveUpGap: 0,
      attackStalls: 0,
      stuckAnchorX: unit.x,
      stuckAnchorY: unit.y,
      repathT: 0,
      repollT: 0,
      yieldT: 0,
      prevX: unit.x,
      prevY: unit.y,
      velX: 0,
      velY: 0,
      // Buildings (speed 0) block via their stamped static footprint instead.
      footprint: unit.flying || unit.speed <= 0 ? 0 : footprintCells(unit.radius),
      pathStamp: null, // set by setPathStamp once the building's footprint is on the grid
      resX: 0,
      resY: 0,
      hasReservation: false,
      resKind: null,
      resId: 0,
      workT: 0,
      inMine: false,
      insideBuild: false,
      inBurrow: false,
      garrisonHost: 0,
      garrison: [],
      garrisonCap: this.computeGarrisonCap(unit.typeId),
      linkGroup: [],
      linkT: 0,
      linkShare: 0,
      devouring: 0,
      devouredBy: 0,
      etherealForm: unit.typeId === "ospm", // the Spirit Walker is TRAINED in its ethereal form (ospm)
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
      properName: hero?.properName ?? "",
      level: hero?.level ?? opts?.level ?? 0,
      xp: hero ? xpToReachLevel(hero.level) : 0,
      skillPoints: 0, // granted by leveling (initHero sets the starting points)
      primaryAttr: hero?.primaryAttr ?? PrimaryAttribute.None,
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
      baseDamage: weapon?.baseDamage ?? 0,
      baseSpeed: unit.speed,
      manaRegen: opts?.manaRegen ?? 0, // recomputeStats derives the real value below
      hpRegen: 0,
      lifesteal: 0,
      thorns: 0,
      bonusArmor: 0,
      bonusDamage: 0,
      bonusStr: 0,
      bonusAgi: 0,
      bonusInt: 0,
      abilities: opts?.abilities ?? [],
      buffs: [],
      stunned: false,
      paused: false,
      silenced: false,
      ethereal: false,
      magicImmune: false, // recomputeStats derives it from the unit's ability list
      detectRadius: 0, // …and True Sight likewise
      uprooted: false, // an Ancient is built rooted (Aroo)
      rootedFootprint: 0, // set when it uproots, spent when it plants
      altModel: false, // derived: rooted Ancients and burrowed units wear the alternate model
      invisible: false,
      cloaked: false,
      invulnerable: !!opts?.baseInvulnerable, // recomputeStats keeps this in sync each tick
      baseInvulnerable: !!opts?.baseInvulnerable,
      mechanical: !!opts?.mechanical,
      isPeon: !!opts?.isPeon,
      isSummon: false,
      spawning: 0,
      summonLeft: 0,
      summonMax: 0,
      unsummonArt: "",
      vanished: false,
      isIllusion: false,
      illusionOf: 0,
      illusionDamageDealt: 1,
      illusionDamageTaken: 1,
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
      campHelper: false,
      campGuard: false,
      strayT: 0,
      returnBestDist: 0,
      returnStuckT: 0,
      // Only heroes carry an inventory in melee WC3 (6 slots). Other units get an
      // empty array (no inventory ability) so item logic simply skips them.
      inventory: hero ? [null, null, null, null, null, null] : [],
      getItemId: 0,
      pendingGive: null,
      pendingSell: null,
      pendingDrop: null,
    };
    this.units.set(u.id, u);
    this.settle(u);
    this.tech?.invalidate(); // a new unit may unlock (or, for a shop, be) something
    this.initShopStock(u); // Arcane Vault / Goblin Merchant / Tavern: fill the shelves
    // A structure that arrives already finished (a melee start Town Hall, a map-placed
    // neutral building) was not "placed" in the sense the notification means — only a
    // fresh foundation with construction left to run shouts at the creeps around it.
    if (u.building && u.building.constructionLeft > 0) this.notifyCreepsOfPlacement(u);
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
    const n = u.footprint;
    let sx = u.x;
    let sy = u.y;
    if (snap) {
      const combat = u.order === "attack" || u.order === "attackmove" || u.order === "hold" || u.order === "cast";
      if (combat) {
        // Combat rest: do NOT snap the position — snapping can shove a unit up to half a
        // cell out of its strike band and cause the edge-of-range jiggle. Reserve the
        // block under where it actually stopped; if that's taken, de-conflict onto the
        // nearest free tile (a snap around allies, terrain-only line so never through a
        // wall) so blocked/waiting attackers queue instead of stacking (issue #24).
        let [ccx0, ccy0] = this.grid.footprintOrigin(u.x, u.y, n);
        if (!this.blockFree(ccx0, ccy0, n)) {
          const [ssx, ssy] = this.grid.snapForFootprint(u.x, u.y, n);
          const free = this.nearestFreeBlock(ssx, ssy, n, 6, false);
          if (free) {
            u.x = free[0];
            u.y = free[1];
            [ccx0, ccy0] = this.grid.footprintOrigin(u.x, u.y, n);
          }
        }
        this.grid.reserve(ccx0, ccy0, n);
        u.resX = ccx0;
        u.resY = ccy0;
        u.hasReservation = true;
        return;
      }
      // Non-combat rest: snap to the grid. If the tile's taken (two units the same
      // distance from one free tile), settle onto the nearest FREE tile instead of
      // stacking — a one-shot snap, deterministic (first-settled keeps the tile).
      [sx, sy] = this.grid.snapForFootprint(u.x, u.y, n);
      let [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
      if (!this.blockFree(cx0, cy0, n)) {
        const free = this.nearestFreeBlock(sx, sy, n);
        if (free) {
          [sx, sy] = free;
          [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
        }
      }
      u.x = sx;
      u.y = sy;
      this.grid.reserve(cx0, cy0, n);
      u.resX = cx0;
      u.resY = cy0;
      u.hasReservation = true;
      return;
    }
    // snap=false: reserve exactly where the unit stands (worker parked at a resource).
    const [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
    this.grid.reserve(cx0, cy0, n);
    u.resX = cx0;
    u.resY = cy0;
    u.hasReservation = true;
  }

  /** True if the n×n reservation block at origin (cx0,cy0) is entirely walkable and
   *  unreserved — i.e. a unit can settle there without overlapping another's tile. */
  private blockFree(cx0: number, cy0: number, n: number): boolean {
    for (let y = cy0; y < cy0 + n; y++)
      for (let x = cx0; x < cx0 + n; x++)
        if (!this.grid.walkable(x, y) || this.grid.isReserved(x, y)) return false;
    return true;
  }

  /** Nearest snap-aligned settle position (world coords) whose reservation block is
   *  free, spiralling out from the snapped (sx,sy) in whole-cell steps. Uses the SAME
   *  footprintOrigin the reservation will — so the block it validates is exactly the
   *  block that gets reserved (no even-footprint off-by-one). Bounded; null if the
   *  whole neighbourhood is packed (caller then settles in place — a rare overlap beats
   *  a teleport across the map). */
  private nearestFreeBlock(sx: number, sy: number, n: number, maxR = 6, unitsBlockLine = true): [number, number] | null {
    const [scx, scy] = this.grid.worldToCell(sx, sy);
    const half = n >> 1;
    const oX0 = scx - half; // the unit's own footprint — exempt from the reachability
    const oY0 = scy - half; // block-check so it can leave the tile it's overlapping
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const wx = sx + dx * PATHING_CELL;
          const wy = sy + dy * PATHING_CELL;
          const [cx0, cy0] = this.grid.footprintOrigin(wx, wy, n);
          if (!this.blockFree(cx0, cy0, n)) continue;
          // Must be REACHABLE in a straight shot — the line to it crosses no wall (and,
          // when unitsBlockLine, no other unit's tile). This stops a unit at a choke from
          // snapping ACROSS a plug into unreachable space. Held attackers de-conflicting
          // among themselves pass unitsBlockLine=false + a small radius: repositioning a
          // tile or two AROUND an ally is fine (it's a snap, not a walk), only terrain must
          // not be crossed — otherwise a packed crowd finds no free tile and stacks.
          if (this.clearLineTo(sx, sy, wx, wy, oX0, oY0, n, unitsBlockLine)) return [wx, wy];
        }
      }
    }
    return null;
  }

  /** True if the straight segment from (sx,sy) to (wx,wy) crosses only walkable,
   *  unreserved cells (cells inside the mover's own start footprint are exempt, so it
   *  can step off the tile it's overlapping). A cheap reachability proxy for the short
   *  relocation hops settle() makes — no full A*. */
  private clearLineTo(sx: number, sy: number, wx: number, wy: number, oX0: number, oY0: number, n: number, unitsBlock = true): boolean {
    const dist = Math.hypot(wx - sx, wy - sy);
    const steps = Math.max(1, Math.ceil(dist / (PATHING_CELL * 0.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const [cx, cy] = this.grid.worldToCell(sx + (wx - sx) * t, sy + (wy - sy) * t);
      if (!this.grid.walkable(cx, cy)) return false;
      if (!unitsBlock) continue; // terrain-only line (for a snap-around-allies de-conflict)
      const own = cx >= oX0 && cx < oX0 + n && cy >= oY0 && cy < oY0 + n;
      if (!own && this.grid.isReserved(cx, cy)) return false;
    }
    return true;
  }

  /** Combat settle: like settle(), but treats an attacker's arrival like a move onto a
   *  distinct tile (issue #24 — "remove combat clustering; treat combat like movement").
   *  If the exact tile is contended, spread to the nearest free tile that STILL keeps us
   *  within striking range of the target — so melee units surround onto their own tiles
   *  instead of piling up, without landing past their re-chase leash (which would make
   *  them walk↔settle forever at the range edge). No free in-range tile (the surround is
   *  full) → settle in place; the slot system parked the extras further out on approach. */
  private settleSpread(u: SimUnit, t: SimUnit): void {
    if (u.hasReservation) {
      u.moving = false;
      u.yieldT = 0;
      u.path = [];
      return;
    }
    const n = u.footprint;
    if (n <= 0 || !u.weapon) {
      this.settle(u);
      return;
    }
    // Reserve the cell block under where the unit ACTUALLY stopped — do NOT snap its
    // position to the grid corner. For an even footprint that snap can shove a unit up to
    // half a cell (16 units) AWAY from the target, out of the strike band; it then
    // re-chases, reaches range, settles, gets snapped away again — the edge-of-range
    // jiggle, and it can even end up held out of range not attacking (issue #24).
    let sx = u.x;
    let sy = u.y;
    let [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
    if (!this.blockFree(cx0, cy0, n)) {
      // Our tile is taken — relocate to the nearest free tile still comfortably inside
      // the strike band (hits connect out to range + ATTACK_LEASH; cap a margin below so
      // we stay inCombat and don't re-chase). This branch DOES move us (onto that tile).
      const maxGap = (this.weaponVs(u, t) ?? u.weapon).range + ATTACK_LEASH * 0.6;
      let free = this.nearestFreeBlockInRange(u, t, n, maxGap);
      if (!free) {
        // The whole in-range ring is full. Rather than STACK in range (the "still
        // squeezing" overlap), back off to the nearest free tile just outside it — the
        // unit ends up out of range and holds/queues there for a slot to open, an outer
        // ring, exactly as WC3 does when more units than fit pile onto one target. Terrain-
        // only line + small radius: a snap around allies, never through a wall.
        const [ssx, ssy] = this.grid.snapForFootprint(sx, sy, n);
        free = this.nearestFreeBlock(ssx, ssy, n, 6, false);
      }
      if (free) {
        sx = free[0];
        sy = free[1];
        [cx0, cy0] = this.grid.footprintOrigin(sx, sy, n);
      }
    }
    u.x = sx;
    u.y = sy;
    this.grid.reserve(cx0, cy0, n);
    u.resX = cx0;
    u.resY = cy0;
    u.hasReservation = true;
    u.moving = false;
    u.yieldT = 0;
    u.path = [];
  }

  /** Nearest free settle tile (snap-aligned world pos) whose block is free, reachable in
   *  a straight shot, AND within `maxGap` of the target — preferring the tile CLOSEST to
   *  the target within the nearest ring, so attackers pack into a tight surround. */
  private nearestFreeBlockInRange(u: SimUnit, t: SimUnit, n: number, maxGap: number): [number, number] | null {
    const [sx, sy] = this.grid.snapForFootprint(u.x, u.y, n);
    const half = n >> 1;
    const [scx, scy] = this.grid.worldToCell(sx, sy);
    const oX0 = scx - half;
    const oY0 = scy - half;
    for (let r = 1; r <= 6; r++) {
      let best: [number, number] | null = null;
      let bestGap = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const wx = sx + dx * PATHING_CELL;
          const wy = sy + dy * PATHING_CELL;
          const [cx0, cy0] = this.grid.footprintOrigin(wx, wy, n);
          if (!this.blockFree(cx0, cy0, n)) continue;
          const gap = Math.hypot(wx - t.x, wy - t.y) - u.radius - t.radius;
          if (gap > maxGap) continue;
          if (!this.clearLineTo(sx, sy, wx, wy, oX0, oY0, n)) continue;
          if (gap < bestGap) {
            bestGap = gap;
            best = [wx, wy];
          }
        }
      }
      if (best) return best; // fill the nearer ring first
    }
    return null;
  }

  /** A unit is about to move: give its reserved cells back. */
  private unsettle(u: SimUnit): void {
    if (u.hasReservation) {
      this.grid.release(u.resX, u.resY, u.footprint);
      u.hasReservation = false;
    }
  }

  /** Hand a building the pathTex footprint that was stamped for it, so leaving the
   *  world takes its collision with it (see releasePathStamp). Called by the spawner
   *  once the stamp is down, and by the map loader for the buildings the .doo placed. */
  setPathStamp(id: number, fp: Footprint, x: number, y: number): void {
    const u = this.units.get(id);
    if (u) u.pathStamp = { fp, x, y };
  }

  /** A building has left the world: lift its footprint off the pathing grid. In WC3
   *  the ground a structure stood on is walkable the moment it dies — the collapse you
   *  watch afterwards is only the death animation playing over open ground, which is
   *  why units walk straight through the rubble. So this runs on death, on RemoveUnit,
   *  and on a cancelled construction alike — every way a building stops existing. */
  private releasePathStamp(u: SimUnit): void {
    if (!u.pathStamp) return;
    unstampFootprint(this.grid, u.pathStamp.fp, u.pathStamp.x, u.pathStamp.y);
    u.pathStamp = null;
  }

  /** True if any live ground unit's hull overlaps a circle of `radius` at (x,y).
   *  The grid's reservations only cover *settled* units; a unit that's moving
   *  (or freshly trained and already walking to its rally) doesn't reserve cells,
   *  so grid.footprintFits() alone can't tell a spawn spot is really clear. This
   *  catches those, keeping a new unit from popping out on top of another. Flyers
   *  and buildings (footprints handled by the grid) are ignored. */
  spotOccupied(x: number, y: number, radius: number, excludeId = 0): boolean {
    for (const u of this.units.values()) {
      if (u.id === excludeId || u.flying || u.building || u.radius <= 0 || u.hp <= 0) continue;
      const rr = radius + u.radius;
      if (Math.abs(u.x - x) < rr && Math.abs(u.y - y) < rr && Math.hypot(u.x - x, u.y - y) < rr) return true;
    }
    return false;
  }

  /** Sim ids of units that died since the last drain (renderer plays deaths). */
  drainDeaths(): number[] {
    if (!this.deaths.length) return this.deaths;
    const out = this.deaths;
    this.deaths = [];
    return out;
  }

  /** Death events (victim + killer snapshots) since the last drain, for the trigger
   *  engine. Only populated when `captureDeaths` is set (a script is listening). */
  drainDeathEvents(): Array<{ victim: EventUnitInfo; killer: EventUnitInfo | null }> {
    if (!this.deathEvents.length) return this.deathEvents;
    const out = this.deathEvents;
    this.deathEvents = [];
    return out;
  }

  /** Damage events (EVENT_UNIT_DAMAGED) since the last drain — only when a script
   *  registered that event (`captureDamage`). */
  drainDamageEvents(): Array<{ target: EventUnitInfo; source: EventUnitInfo | null; amount: number }> {
    if (!this.damageEvents.length) return this.damageEvents;
    const out = this.damageEvents;
    this.damageEvents = [];
    return out;
  }

  /** Attack events (EVENT_(PLAYER_)UNIT_ATTACKED) since the last drain — only when a
   *  script registered that event (`captureAttacks`). */
  drainAttackEvents(): Array<{ attacked: EventUnitInfo; attacker: EventUnitInfo }> {
    if (!this.attackEvents.length) return this.attackEvents;
    const out = this.attackEvents;
    this.attackEvents = [];
    return out;
  }

  /** Record an ISSUED-order event (EVENT_(PLAYER_)UNIT_ISSUED_ORDER/POINT/TARGET) — only
   *  when a script is listening (`captureOrders`). Called at the EXPLICIT-order boundaries
   *  (trigger IssueXOrder + the player command router), never the internal-AI issue* calls,
   *  so auto-acquisition retargeting stays silent, matching WC3. `kind` picks the event
   *  family; `target` is the ordered unit (target orders) else null. */
  noteOrder(unitId: number, orderId: number, kind: "immediate" | "point" | "target", x: number, y: number, targetId: number): void {
    if (!this.captureOrders) return;
    const u = this.units.get(unitId);
    if (!u) return;
    const t = targetId ? this.units.get(targetId) : undefined;
    this.orderEvents.push({ unit: eventInfo(u), orderId, kind, x, y, target: t ? eventInfo(t) : null });
  }
  /** Issued-order events since the last drain — only when a script registered one
   *  (`captureOrders`). Same shape/lifecycle as the death/damage/attack drains. */
  drainOrderEvents(): Array<{ unit: EventUnitInfo; orderId: number; kind: "immediate" | "point" | "target"; x: number; y: number; target: EventUnitInfo | null }> {
    if (!this.orderEvents.length) return this.orderEvents;
    const out = this.orderEvents;
    this.orderEvents = [];
    return out;
  }

  /** Record a spell event (EVENT_(PLAYER_)UNIT_SPELL_*) — only when a script is
   *  listening (`captureSpells`). Raised from the cast timeline in tickCast. */
  private noteSpell(u: SimUnit, pc: PendingCast, phase: SpellPhase): void {
    if (!this.captureSpells) return;
    const t = pc.targetId ? this.units.get(pc.targetId) : undefined;
    this.spellEvents.push({ caster: eventInfo(u), abilityId: pc.abilityId, phase, target: t ? eventInfo(t) : null, x: pc.x, y: pc.y });
  }
  /** Spell events since the last drain (`captureSpells`). */
  drainSpellEvents(): SpellEvent[] {
    if (!this.spellEvents.length) return this.spellEvents;
    const out = this.spellEvents;
    this.spellEvents = [];
    return out;
  }

  /** Record a construction milestone (`captureConstruct`). Called where each one
   *  actually happens: the foundation laid (RtsController.addUnit with a build time),
   *  cancelBuilding, and construction reaching 0 in tickBuildings. */
  noteConstruct(unitId: number, phase: ConstructEvent["phase"]): void {
    if (!this.captureConstruct) return;
    const u = this.units.get(unitId);
    if (u) this.constructEvents.push({ structure: eventInfo(u), phase });
  }
  /** Construction events since the last drain (`captureConstruct`). */
  drainConstructEvents(): ConstructEvent[] {
    if (!this.constructEvents.length) return this.constructEvents;
    const out = this.constructEvents;
    this.constructEvents = [];
    return out;
  }

  /** Record a training milestone (`captureTrain`) — start/cancel, from the queue
   *  methods below. The FINISH is noteTrainFinish: only the engine knows the new
   *  unit (the sim owns no models, so a trained unit is born in the renderer). */
  private noteTrain(buildingId: number, unitTypeId: string, phase: TrainEvent["phase"]): void {
    if (!this.captureTrain) return;
    const b = this.units.get(buildingId);
    if (b) this.trainEvents.push({ building: eventInfo(b), unitTypeId, trained: null, phase });
  }
  /** The engine spawned a trained unit: raise EVENT_(PLAYER_)UNIT_TRAIN_FINISH with it
   *  (GetTrainedUnit). Called from the renderer's drainTrained handler, once the model
   *  is up and the sim unit exists. */
  noteTrainFinish(buildingId: number, trainedId: number): void {
    if (!this.captureTrain) return;
    const b = this.units.get(buildingId);
    const t = this.units.get(trainedId);
    if (b && t) this.trainEvents.push({ building: eventInfo(b), unitTypeId: t.typeId, trained: eventInfo(t), phase: "finish" });
  }
  /** Training events since the last drain (`captureTrain`). */
  drainTrainEvents(): TrainEvent[] {
    if (!this.trainEvents.length) return this.trainEvents;
    const out = this.trainEvents;
    this.trainEvents = [];
    return out;
  }

  /** Hero level-up / skill-learn events since the last drain (`captureHeroEvents`). */
  drainHeroEvents(): HeroEvent[] {
    if (!this.heroEvents.length) return this.heroEvents;
    const out = this.heroEvents;
    this.heroEvents = [];
    return out;
  }

  /** Record an item manipulation (`captureItems`) — raised where the item actually moves
   *  (pickUpItem / doDropItem / transferItem / useItem), so a trigger's UnitAddItem and a
   *  hero walking over the item raise the same event, as in WC3. The item is snapshotted:
   *  a consumed powerup no longer exists by the time the event is drained. */
  private noteItem(u: SimUnit, item: { id: number; itemId: string; charges: number }, phase: ItemEvent["phase"], seller?: SimUnit): void {
    if (!this.captureItems) return;
    this.itemEvents.push({
      unit: eventInfo(u),
      item: { id: item.id, typeId: item.itemId, charges: item.charges },
      phase,
      seller: seller ? eventInfo(seller) : undefined,
    });
  }
  /** Item events since the last drain (`captureItems`). */
  drainItemEvents(): ItemEvent[] {
    if (!this.itemEvents.length) return this.itemEvents;
    const out = this.itemEvents;
    this.itemEvents = [];
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
    if (!u || this.castLocked(u)) return false;
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
    if (!u || this.castLocked(u)) return false;
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
    if (!u || this.castLocked(u)) return false;
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

  /** Hold Position: the unit plants where it stands and NEVER chases, but it still
   *  attacks any hostile that comes within its weapon range (WC3 Hold, issue #17). */
  issueHold(id: number): boolean {
    const u = this.units.get(id);
    if (!u || this.castLocked(u)) return false;
    u.order = "hold";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    u.acquireT = 0; // scan for an in-range enemy immediately
    this.settle(u); // stop any current movement and hold this cell
    return true;
  }

  /** Order a unit to attack another. Normally requires the target to be hostile;
   *  `force` (the deliberate Attack command) lets you attack allies/own units too. */
  issueAttack(id: number, targetId: number, force = false): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || !u.weapon || u.ethereal || (!force && !this.hostile(u, t))) return false; // ethereal (Banished) → weapon disabled (issue #49)
    // No weapon that may strike this target — a Footman ordered onto a Gryphon Rider. WC3
    // refuses the order outright (the cursor never turns red); the caller falls back to a
    // move, exactly as it does for any other refused attack.
    if (!this.canAttack(u, t)) return false;
    if (this.castLocked(u)) return false; // mid-wind-up: only Stop breaks a cast
    if (t.invulnerable) return false; // invulnerable units can't be attacked at all — not even with a forced Attack order (issue #26)
    // A FRESH attack (from any non-attack state — a player command, idle auto-acquire,
    // a follower peeling off to fight) drops any pending resume-to-follow. Re-targeting
    // WITHIN an ongoing fight (reacquire after a kill, switching to a reachable enemy)
    // leaves it intact — the whole combat episode still belongs to that follow (#32).
    if (u.order !== "attack") u.followLeaderId = null;
    u.order = "attack";
    u.targetId = targetId;
    u.noCollision = false; // manual control restores collision
    u.stallT = 0; // fresh target — reset the unreachable-target watchdog (issue #24)
    u.gaveUp = false; // no longer holding — a new target may well be reachable
    u.attackStalls = 0;
    u.repathT = 0; // clear any lingering hold/repath cooldown so we chase the new target
    // NOW — otherwise a freshly re-acquired enemy (e.g. after the first kill) inherited
    // the previous target's multi-second hold cooldown and the unit just stood there.
    this.cancelSwing(u); // a fresh target starts a fresh swing
    this.detachBuilder(id);
    // Claim a distinct standing slot around the target so a group swarming one
    // enemy fans out around it instead of lining up (generic: every attack order,
    // player-issued or a creep camp's, goes through here). No-op if the unit
    // already holds a slot for this target, so an already-committed attacker keeps
    // its place (no per-hit re-shuffle).
    this.setAttackSlot(u, t);
    return true;
  }

  /** Assign `u` a fan-out slot for target `t` (once per target). Melee units get a
   *  distinct ring slot around the target (assignAttackSlot); ranged units stand
   *  off at weapon range and don't surround, so they just aim at the centre. */
  private setAttackSlot(u: SimUnit, t: SimUnit): void {
    if (u.atkOffTarget === t.id) return; // already placed for this target
    if (u.weapon && !u.weapon.ranged) {
      this.assignAttackSlot(u, t);
    } else {
      u.atkOffX = 0;
      u.atkOffY = 0;
      u.atkOffTarget = t.id;
    }
  }

  /** Give `u` a distinct standing slot (offset from the target's centre) among the
   *  units already attacking the same target — the sim-side equivalent of the
   *  worker fan-out around a building/mine, but relative so it tracks a moving
   *  target. Concentric rings sized to the unit's own collision radius, filling the
   *  inner ring first; the unit takes the nearest FREE slot to where it stands (so
   *  it surrounds from its approach side with least crossing). */
  private assignAttackSlot(u: SimUnit, t: SimUnit): void {
    u.atkOffTarget = t.id;
    u.atkOffX = 0;
    u.atkOffY = 0;
    const wr = Math.max(u.radius, 16);
    const spacing = wr * 2 + 24; // neighbour gap so bodies don't overlap
    // Obstacles to route AROUND: every other unit already attacking this same target
    // — both where it stands now and the slot it's heading to — so we don't pick a
    // spot it occupies or is claiming. This is what makes a blocked unit go around
    // to a free spot instead of grinding into the one ahead of it.
    const obstacles: Array<[number, number]> = [];
    for (const o of this.units.values()) {
      if (o === u || o.atkOffTarget !== t.id || o.order !== "attack" || o.targetId !== t.id) continue;
      obstacles.push([o.x, o.y]);
      if (o.atkOffX !== 0 || o.atkOffY !== 0) obstacles.push([t.x + o.atkOffX, t.y + o.atkOffY]);
    }
    // Effective target radius: a building surrounds its footprint, a unit its hull.
    const tr = t.building ? Math.max(t.radius, (t.footprint || 2) * PATHING_CELL * 0.5) : t.radius;
    // Innermost ring sits at the unit's actual standing distance (hull gap == weapon
    // range), so a melee unit that reaches its slot is exactly in range — the slots
    // ARE the surround positions, giving a full ring of them rather than a tight
    // clump the units overshoot.
    const stand = tr + wr + Math.min(this.weaponVs(u, t)?.range ?? 0, 160);
    // Own footprint origin — exempt from the reachability line check so the unit can
    // step off the tile it's standing on.
    const half = u.footprint >> 1;
    const [scx, scy] = this.grid.worldToCell(u.x, u.y);
    const oX0 = scx - half;
    const oY0 = scy - half;
    let best: [number, number] | null = null; // nearest slot we can actually reach
    let bestD = Infinity;
    let fallback: [number, number] | null = null; // nearest fitting slot, reachable or not
    let fallbackD = Infinity;
    for (let ring = 0; ring < 8; ring++) {
      const rr = stand + ring * spacing;
      const n = Math.max(1, Math.floor((2 * Math.PI * rr) / spacing));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.618; // golden-ish stagger between rings
        const ox = Math.cos(a) * rr;
        const oy = Math.sin(a) * rr;
        const sx = t.x + ox;
        const sy = t.y + oy;
        // Skip a slot another attacker holds or occupies.
        let taken = false;
        for (const [hx, hy] of obstacles) {
          if (Math.hypot(hx - sx, hy - sy) < spacing * 0.75) { taken = true; break; }
        }
        if (taken) continue;
        // Skip a slot our own footprint can't actually stand on (blocked terrain, a
        // building, or a cell reserved by a settled unit) — only offer slots we FIT.
        const [cx, cy] = this.grid.worldToCell(sx, sy);
        if (u.footprint > 0 && !this.grid.footprintFits(cx, cy, u.footprint)) continue;
        const d = Math.hypot(sx - u.x, sy - u.y);
        if (d < fallbackD) { fallbackD = d; fallback = [ox, oy]; }
        // A slot can FIT yet be unreachable — walled off by the ring of attackers around
        // the target, a free tile we can't get to through the other bodies (the reported
        // "picks a spot it can't reach for its size"). Require a clear straight approach —
        // no wall, no other unit's tile between us and the slot — so we head for a slot we
        // can actually stand in, letting the surround fill from the outside in.
        if (u.footprint > 0 && !this.clearLineTo(u.x, u.y, sx, sy, oX0, oY0, u.footprint)) continue;
        if (d < bestD) { bestD = d; best = [ox, oy]; }
      }
      if (best) break; // fill this ring (with a reachable slot) before stepping out
    }
    const pick = best ?? fallback;
    if (pick) { u.atkOffX = pick[0]; u.atkOffY = pick[1]; }
  }

  /** Order a unit to FOLLOW another (friendly/neutral/enemy) unit: it trails the
   *  leader at FOLLOW_GAP and does NOT auto-acquire targets on its own (WC3).
   *  offX/offY give a formation offset from the leader's centre so a group told to
   *  follow one unit fans out (0,0 = a lone follower that just trails). */
  issueFollow(id: number, targetId: number, offX = 0, offY = 0): boolean {
    const u = this.units.get(id);
    const t = this.units.get(targetId);
    if (!u || !t || u === t || u.speed <= 0 || this.castLocked(u)) return false;
    u.order = "follow";
    u.targetId = targetId;
    u.followOffX = offX;
    u.followOffY = offY;
    u.followLeaderId = null; // fresh follow — no fight in flight yet; tickFollow arms it
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(id);
    u.stuckT = 0;
    u.stuckRetries = 0;
    return true;
  }

  /** True while a cast's WIND-UP is running (the cast-point timer, after facing
   *  is done and before the effect fires). WC3 locks the caster in for it: the
   *  spell is committed to and only an explicit Stop aborts it — a move/attack/
   *  another cast issued mid-wind-up is dropped, not obeyed. Before the wind-up
   *  (walking into range, turning to face) the caster re-tasks freely, and after
   *  the effect has fired the channel/backswing cancel for free (animation
   *  canceling), so neither phase is locked. Stuns still interrupt regardless
   *  (interruptForStun). */
  private castLocked(u: SimUnit): boolean {
    const pc = u.pendingCast;
    return u.order === "cast" && pc !== null && pc.started && !pc.fired;
  }

  stop(id: number): void {
    const u = this.units.get(id);
    if (u) {
      u.order = "idle";
      this.clearCast(u); // the one command that aborts a locked-in wind-up (raises SPELL_ENDCAST)
      u.targetId = null;
      u.followLeaderId = null; // an explicit stop ends any follow-and-guard episode
      u.inCombat = false;
      u.working = false;
      u.atNode = false;
      u.noCollision = false; // manual stop restores collision
      u.stallT = 0;
      u.gaveUp = false;
      u.acquireT = 0; // scan for a new target on the very next idle tick (no ½s lag)
      this.cancelSwing(u);
      this.detachBuilder(id);
      this.settle(u);
      // Any errand the unit was walking to finish is off: a Stop cancels a pending drop, hand-
      // over or sale as it cancels everything else.
      u.pendingSell = null;
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
    if (!u || this.castLocked(u)) return;
    u.buildPending = { defId, x, y, gold, lumber };
    if (!this.issueMove(id, x, y)) u.moving = false; // already at the site → raise now
  }

  /** Execute an order right now, replacing whatever the unit is doing and its
   *  whole queue (every fresh, non-shift order goes through here). */
  issueOrder(id: number, order: QueuedOrder): boolean {
    const u = this.units.get(id);
    if (u && this.castLocked(u)) return false; // don't even drop the queue for an ignored order
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
      case "hold": return this.issueHold(id);
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
    if (!u || !u.worker || this.castLocked(u)) return false;
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
    if (u.resKind === "gold") {
      const mine = this.mines.get(u.resId);
      if (!mine) return;
      // Aim at the rim point FACING the worker, not the mine's centre: the centre sits
      // inside the mine's own footprint, so the pathfinder snapped the goal to the first
      // walkable cell of its scan (always the same corner) and the worker walked around
      // the mine to enter from behind (issue #63). The near rim is the shortest path in.
      const dx = u.x - mine.x;
      const dy = u.y - mine.y;
      const d = Math.hypot(dx, dy) || 1;
      this.pathTo(u, mine.x + (dx / d) * (mine.radius + u.radius), mine.y + (dy / d) * (mine.radius + u.radius));
      return;
    }
    const tree = this.trees.get(u.resId);
    if (tree) this.pathTo(u, tree.x, tree.y); // a tree is one cell — walk at its trunk
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
  // Passive entities (shops, critters) are hostile to no one. Between two PLAYER
  // slots the alliance matrix wins over the team (7.22): the GUI's "Player - Make
  // X treat Y as an Ally" is exactly a pair of players who stop fighting.
  hostile(a: SimUnit, b: SimUnit): boolean {
    if (a.neutralPassive || b.neutralPassive) return false;
    const allied = this.playerAllegiance(a, b);
    return allied !== null ? !allied : a.team !== b.team;
  }

  /** The alliance matrix's verdict on two units' owners, or null when it has none
   *  (either side is a creep / neutral, or no matrix is installed) and the caller
   *  should fall back to comparing teams. */
  private playerAllegiance(a: SimUnit, b: SimUnit): boolean | null {
    if (a.owner < 0 || b.owner < 0) return null;
    return this.alliedPlayers(a.owner, b.owner);
  }

  /** True during daylight (06:00–18:00 game time). */
  get isDay(): boolean {
    return this.timeOfDay >= DAY_START && this.timeOfDay < DAY_END;
  }

  /** Same team = allied (friendly), unless the alliance matrix says otherwise (7.22).
   *  Neutral-passive shops count as nobody's ally. */
  allied(a: SimUnit, b: SimUnit): boolean {
    if (a.neutralPassive || b.neutralPassive) return false;
    const allied = this.playerAllegiance(a, b);
    return allied !== null ? allied : a.team === b.team;
  }

  // === abilities / buffs / casting ==========================================

  /** Sum the passive stat bonuses granted by the items in a unit's inventory.
   *  Item behaviour is dispatched off the granted ability's base `code` (verified
   *  against AbilityData.slk): +damage AIat, +armour AIde, +attributes AIab
   *  (dataA=agi, dataB=int, dataC=str), +attack-speed AIas, +mana-regen AHab.
   *  Lifesteal (Mask of Death AIva) does NOT stack — we keep the strongest.
   *  Permanent item stats are computed here every tick rather than stored as
   *  buffs, so Dispel Magic (which wipes `u.buffs`) can never remove them. */
  private itemBonuses(u: SimUnit): {
    str: number; agi: number; int: number; damage: number; armor: number; attackSpeed: number; manaRegen: number; lifesteal: number;
    speed: number; maxHp: number; hpRegen: number;
  } {
    const b = { str: 0, agi: 0, int: 0, damage: 0, armor: 0, attackSpeed: 0, manaRegen: 0, lifesteal: 0, speed: 0, maxHp: 0, hpRegen: 0 };
    if (!u.inventory.length || !this.itemReg || !this.abilities) return b;
    for (const held of u.inventory) {
      if (!held) continue;
      const item = this.itemReg.get(held.itemId);
      if (!item) continue;
      for (const abilId of item.abilities) {
        const def = this.abilities.get(abilId);
        if (!def) continue;
        const d = def.levelData[0]?.data ?? [];
        const val = (i: number) => (d[i] === undefined || Number.isNaN(d[i]) ? 0 : d[i]);
        switch (def.code) {
          case "AIat": b.damage += val(0); break; // Claws of Attack (+damage)
          case "AIde": b.armor += val(0); break; // Ring of Protection (+armour)
          case "AIab": b.agi += val(0); b.int += val(1); b.str += val(2); break; // stat items
          case "AIas": b.attackSpeed += val(0); break; // Gloves of Haste (+attack speed)
          case "AHab": b.manaRegen += val(0); break; // Pipe of Insight (mana regen)
          // The two REGENERATION items, as distinct from the potions that restore over a
          // fixed duration (AIrg): these are permanent, passive rates while the item is
          // carried. Ring of Regeneration / Health Stone give dataA hp per second; the
          // Sobi Mask and the wands give dataA mana per second.
          case "Arel": b.hpRegen += val(0); break; // Regen Life (+2 hp/sec)
          case "AIrm": b.manaRegen += val(0); break; // ItemRegenMana (+0.5 mana/sec)
          // Orb of Fire and its family — the part of an orb that is plainly data: dataA
          // flat bonus damage. NOT modelled: the on-hit effect an orb also carries (the
          // burn, the frost slow, the lightning), which lives in the attack path rather
          // than in a stat, and the air-attack grant some orbs give a ground-only weapon.
          case "AIfb": b.damage += val(0); break; // Item Attack Fire Bonus (+5)
          case "AIva": b.lifesteal = Math.max(b.lifesteal, val(0)); break; // Mask of Death (lifesteal)
          // The two the shops made reachable (issue #57). Both are plain passive bonuses, and
          // both were dead code paths until now because nothing sold them: Boots of Speed are
          // the Goblin Merchant's signature item, and the Periapt is the +HP staple.
          case "AIms": b.speed += val(0); break; // Boots of Speed (+60 movement)
          case "AIml": b.maxHp += val(0); break; // Periapt of Vitality (+150 max HP)
        }
      }
    }
    return b;
  }

  /** Sum the bonuses the owner's RESEARCHED upgrades grant this unit (issue #57).
   *
   *  Two gates decide whether an upgrade touches a unit at all, and both come from the data:
   *  the owner must have researched it, and the unit must LIST it in UnitBalance's `upgrades`
   *  column. That second gate is what separates Forged Swords (on the Footman's list) from
   *  Gunpowder (on the Rifleman's) — they are the same `ratd` effect and would otherwise both
   *  fire on both units.
   *
   *  Effect values are the TOTAL at the researched level, not an increment:
   *  `base + mod*(level-1)`. Priest Master Training therefore reads +200 max mana at level 2,
   *  not another +100 on top of level 1.
   *
   *  Still deliberately unhandled rather than guessed at: `rart` (armour-type swap, Orc
   *  Reinforced Defenses), `ratc` (attack target count — Moon Glaive's bounce), `rrai`,
   *  `rent`, `rspi`, `rlev`, `raud`, `rmin`, `radl`. `rtma` is not a stat at all — it flips a
   *  unit's availability and is handled by TechState.maxAllowed. */
  private upgradeBonuses(u: SimUnit): {
    dice: number; armor: number; hp: number; hpPct: number; mana: number; manaRegen: number;
    range: number; sight: number; speed: number; attackSpeed: number; damage: number;
    lumber: number; spillDist: number; spillRadius: number; weaponMask: number;
  } {
    const b = {
      dice: 0, armor: 0, hp: 0, hpPct: 0, mana: 0, manaRegen: 0, range: 0, sight: 0, speed: 0,
      attackSpeed: 0, damage: 0, lumber: 0, spillDist: 0, spillRadius: 0,
      // -1 = "no `renw` researched" — the unit keeps whatever mask its data shipped with.
      weaponMask: -1,
    };
    if (!this.tech || !this.upgradeReg || !this.unitReg) return b;
    const def = this.unitReg.get(u.typeId);
    if (!def || !def.upgradesUsed.length) return b;
    for (const upId of def.upgradesUsed) {
      const level = this.tech.researchLevel(u.owner, upId);
      if (level < 1) continue;
      const up = this.upgradeReg.get(upId);
      if (!up) continue;
      for (const e of up.effects) {
        const v = e.base + e.mod * (level - 1);
        switch (e.effect) {
          case "ratd": b.dice += v; break; // attack DICE (the melee/ranged attack upgrades)
          case "ratx": b.damage += v; break; // flat attack damage (Burning Oil et al.)
          // Armour upgrades ship no magnitude of their own — it is the target's `defUp`
          // (2 per level for a unit, 1 for a building), so one Plating research is +2 on a
          // Footman and one Masonry is +1 on a Farm. Scales with the level researched.
          case "rarm": b.armor += def.defUp * level; break;
          case "rhpx": b.hp += v; break;
          case "rhpo": b.hpPct += v; break; // Masonry's +10%/level building HP
          case "rmnx": b.mana += v; break;
          case "rmnr": b.manaRegen += v; break;
          case "ratr": b.range += v; break; // Long Rifles +200
          case "rsig": b.sight += v; break;
          case "rmvx": b.speed += v; break;
          case "rats": b.attackSpeed += v; break;
          // Improved/Advanced Lumber Harvesting (`Rhlh`): the lumber a worker carries per
          // trip. base 10 / mod 10, so 10 at level 1 and 20 at level 2 — ON TOP of the
          // Peasant's own 10, matching the game's own tooltip ("Increases the amount of
          // lumber that Peasants can carry by <Rhlh,mod1>").
          case "rlum": b.lumber += v; break;
          // Attack spill (Storm Hammers `Rhhb` = rasd 200, Impaling Bolt `Repb` = rasd 200):
          // opens up the line-splash the weapon already carries a radius for.
          case "rasd": b.spillDist += v; break;
          case "rasr": b.spillRadius += v; break;
          // Enable Weapons (`renw`) — an attackBits MASK that REPLACES `weapsOn`, it does not
          // add to it. Flying Machine Bombs (`Rhgb`) and Corrosive Breath (`Recb`) are 3 (both
          // slots); Impaling Bolt (`Repb`) is 2, which SWITCHES the Glaive Thrower off slot 1
          // and onto slot 2 — the tree-piercing bolt — rather than giving it a second attack.
          case "renw": b.weaponMask = v; break;
        }
      }
    }
    return b;
  }

  /** The weapon `u` would strike `t` with: the first ENABLED slot whose Targets Allowed admits
   *  the target. null = it cannot attack `t` at all, which is a real and common answer in WC3 —
   *  a Footman has no answer to a Gryphon Rider, a Siege Engine cannot touch a Footman, and a
   *  Flying Machine cannot hit the ground until Bombs is researched.
   *
   *  WC3 classifies the target by what it IS (allegiance is the caller's business, via
   *  hostile()): a flyer answers to `air`, a structure to `structure`, everything else to
   *  `ground`. Note that a building is NOT "ground" — the Chimaera's corrosive breath lists
   *  `structure,debris` alone and hits nothing but buildings, and the Mortar Team keeps a
   *  separate structure-only slot precisely because its ground shot lists no `structure`. */
  weaponVs(u: SimUnit, t: SimUnit): SimWeapon | null {
    for (const w of u.weapons) {
      if (!w.enabled) continue;
      // No Targets Allowed data at all (a summon or custom unit with no weapons row) → treat
      // the weapon as unrestricted rather than silently disarming the unit.
      if (!w.targets.length) return w;
      const key = t.building ? "structure" : t.flying ? "air" : "ground";
      if (w.targets.includes(key)) return w;
    }
    return null;
  }

  /** Whether `u` has any weapon that may strike `t`. Every automatic target scan asks this, so
   *  a Footman never walks across the map at a passing Gargoyle it can never hit. */
  private canAttack(u: SimUnit, t: SimUnit): boolean {
    return this.weaponVs(u, t) !== null;
  }

  /** Recompute a unit's effective stats from its base values, hero attribute
   *  growth, active buffs, items and the owner's researched upgrades. Called every
   *  tick (cheap, idempotent). */
  private recomputeStats(u: SimUnit): void {
    const item = this.itemBonuses(u);
    const upg = this.upgradeBonuses(u);
    if (u.isHero) {
      u.str = Math.floor(u.baseStr + u.strPerLevel * (u.level - 1)) + item.str;
      u.agi = Math.floor(u.baseAgi + u.agiPerLevel * (u.level - 1)) + item.agi;
      u.int = Math.floor(u.baseInt + u.intPerLevel * (u.level - 1)) + item.int;
    }
    const dStr = u.isHero ? u.str - Math.floor(u.baseStr) : 0;
    const dAgi = u.isHero ? u.agi - Math.floor(u.baseAgi) : 0;
    const dInt = u.isHero ? u.int - Math.floor(u.baseInt) : 0;
    const primaryDelta = u.primaryAttr === PrimaryAttribute.Strength ? dStr : u.primaryAttr === PrimaryAttribute.Agility ? dAgi : u.primaryAttr === PrimaryAttribute.Intelligence ? dInt : 0;
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
    let ethereal = false;
    let invisible = false;
    let cloaked = false;
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
      else if (b.kind === "ethereal") {
        ethereal = true;
        slowMove = Math.max(slowMove, b.value); // Banish's Movement Speed Reduction (DataA)
      } else if (b.kind === "stun" || b.kind === "sleep") stun = true; // sleep disables like a stun (wakes on damage)
      else if (b.kind === "silence") silence = true;
      else if (b.kind === "invisible") {
        cloaked = true; // under the effect from the moment it lands
        if (b.delay <= 0) invisible = true; // …but not actually faded until the transition elapses
      }
      else if (b.kind === "invuln") invuln = true;
    }
    // Masonry-style `rhpo` is a PERCENTAGE of the base pool, applied before the flat `rhpx`
    // adds (Animal War Training's +150).
    const newMaxHp = (u.baseMaxHp + HP_PER_STR * dStr) * (1 + upg.hpPct) + upg.hp + item.maxHp;
    const newMaxMana = u.baseMaxMana + MANA_PER_INT * dInt + upg.mana;
    // Moving the ceiling keeps the unit's RELATIVE pool, in both directions: "Increasing the
    // maximum amount of Hit Points of a unit does not change its relative Hit Points"
    // (Liquipedia, Hit_Points). The page's own item-drop trick proves the ratio (not a flat
    // delta) is what is preserved — regenerate with the item off, re-equip, and the current
    // HP scales up with the ceiling for a gain of `regenerated · Bonus/(MaxHP − Bonus)`, which
    // an additive model could never produce. So this is the ONE rule behind every ceiling
    // move: a hero levelling (issue #69), strength/intellect growth, a tome, an item, and
    // Brute Strength finishing over a field of Grunts (issue #70). A full-health Grunt stays
    // full; a half-health one stays half; a wounded building researching Masonry gains
    // headroom but is no more healed than before.
    if (u.maxHp > 0 && newMaxHp !== u.maxHp) u.hp *= newMaxHp / u.maxHp;
    if (u.maxMana > 0 && newMaxMana !== u.maxMana) u.mana *= newMaxMana / u.maxMana;
    u.maxHp = newMaxHp;
    u.maxMana = newMaxMana;
    if (u.hp > u.maxHp) u.hp = u.maxHp;
    if (u.mana > u.maxMana) u.mana = u.maxMana;
    // Defend: "While Defend is active, movement is reduced to <DataC1,%>% of normal speed"
    // (30%) — a stance, not a debuff, so it is derived here rather than carried as a buff.
    const defend = this.defendStance(u);
    if (defend) slowMove = Math.max(slowMove, 1 - this.dataOf(defend, 2, 0.3));
    // Spiked Carapace (Crypt Lord passive AUts): a flat bonus armour (dataB) while learned.
    const carapace = this.passiveLevelData(u, "AUts");
    const carapaceArmor = carapace ? this.dataOf(carapace, 1) : 0;
    u.armor = u.baseArmor + ARMOR_PER_AGI * dAgi + armorBonus + carapaceArmor + item.armor + upg.armor;
    u.bonusArmor = armorBonus + carapaceArmor + item.armor + upg.armor; // the buff/aura/item/upgrade portion (shown green in the HUD)
    // Attack speed ("IAS"): every source — agility, items, buffs, upgrades, slows — sums
    // into ONE additive bonus term, which then divides the base attack time exactly once.
    // Bonuses never chain multiplicatively (Hive "Attack Speed Formula?" #12, Dr Super Good:
    // "ARf = ARi/(1+FAR)"; Liquipedia Attack_Speed: "IAS = (0.02 * Agility) + Item Bonuses +
    // Ability Bonuses", "Attack Speed = BCD/1 + IAS"), and a hero's slow is SUBTRACTED from
    // the IAS rather than scaling the result. Heroes gain AgiAttackSpeedBonus (2%) per point
    // of TOTAL agility — `cool1` is the raw Base Attack Time with no agility baked in
    // (Blademaster cool1=1.77, and Liquipedia's displayed 1.23 = 1.77/(1+0.02*22) at that
    // patch's 22 agi). Verified against MiscGame.txt AgiAttackSpeedBonus=0.02.
    const agiAttackSpeed = u.isHero ? MISC_GAME.AgiAttackSpeedBonus * u.agi : 0;
    const ias = Math.min(
      IAS_MAX,
      Math.max(IAS_MIN, agiAttackSpeed + hasteAttack + item.attackSpeed + upg.attackSpeed - slowAttack),
    );
    const speedFactor = 1 / (1 + ias);
    const root = this.rootAbility(u); // Ancients: which weapon slot is live depends on it
    // EVERY slot is rebuilt, not just the one in hand: a Gargoyle's ground and air attacks
    // both carry Forged Talons, and a Flying Machine that researches Bombs must find its bomb
    // slot already carrying its armour/damage upgrades the moment the slot switches on.
    for (const w of u.weapons) {
      // `renw` REPLACES weapsOn (see upgradeBonuses) — hence a bit test against the new mask
      // rather than an OR with the old one, which is what lets Impaling Bolt take the Glaive
      // Thrower OFF its original weapon.
      if (upg.weaponMask >= 0) w.enabled = (upg.weaponMask & (1 << u.weapons.indexOf(w))) !== 0;
      const base = w.baseDamage + primaryDelta;
      w.damage = Math.max(0, base + damageBonus + item.damage + upg.damage + base * damagePct); // Command/Trueshot add a % of base
      w.dice = w.baseDice + upg.dice; // Forged Swords / Gunpowder add dice, widening the roll
      w.range = w.baseRange + upg.range; // Long Rifles
      w.damagePoint = w.baseDamagePoint * speedFactor;
      w.backswing = w.baseBackswing * speedFactor; // the follow-through hastes with the damage point
      // The same IAS divides the cooldown. Floor: a unit can never swing faster than its own
      // strike lands — "the unit is restricted to about its attack animation damage point…
      // always attack slightly slower than the actual animation damage point by 0.02 seconds"
      // (Hive "Attack Speed Formula?", Dr Super Good). Both sides scale with IAS, so this only
      // binds where dmgpt1 > cool1 — rare in stock data, common in custom object data.
      w.cooldown = Math.max(w.baseCooldown * speedFactor, w.damagePoint + DAMAGE_POINT_FLOOR);
      w.spillDist = w.baseSpillDist + upg.spillDist; // Storm Hammers — see the spill fields on SimWeapon
      w.spillRadius = w.baseSpillRadius + upg.spillRadius;
    }
    // Root (`Aroo`) swaps which WEAPON SLOT is live, and the Data columns say so outright
    // (AbilityMetaData Roo1..Roo4 → WorldEditStrings):
    //   DataA "Rooted Weapons"    Aroo/Aro1 = 1, Aro2 = 2
    //   DataB "Uprooted Weapons"  Aroo/Aro1 = 2, Aro2 = 1
    // Same bitmask as `weapsOn` (1 = first slot, 2 = second, 3 = both), so this is a mask
    // assignment and not a bit test. The Ancient Protector is what the column is FOR: `etrp`
    // has weapsOn=3 and takes Aro2, so planted it fires slot 2 — the 700-range attack that
    // also hits air — and uprooted it swings slot 1, a 128-range melee. A tower while it
    // stands still, a slow angry tree while it walks. The three plain Ancients carry the same
    // stats in both slots, so for them this is bookkeeping the data still insists on.
    if (root) {
      const lvl = this.abilities?.get(root.id)?.levelData[0];
      const mask = u.uprooted ? lvl?.data[1] : lvl?.data[0];
      if (mask !== undefined && !Number.isNaN(mask)) {
        for (let i = 0; i < u.weapons.length; i++) u.weapons[i].enabled = (mask & (1 << i)) !== 0;
      }
    }
    // Orc Burrow: its arrow weapon is `weapsOn=1` in data but only fires while GARRISONED,
    // and its attack SPEED scales with the peon count — one projectile always, cooldown =
    // base/(peons+1) → 100/150/200/250 % DPS for 1-4 (Liquipedia Orc_Burrow; base cd 4 from
    // UnitWeapons.slk). Damage per hit is unchanged. Empty → weapon off (no auto-attack).
    if (u.garrisonCap > 0) {
      const n = u.garrison.length;
      for (const w of u.weapons) {
        w.enabled = n >= 1;
        if (n >= 1) w.cooldown = (w.baseCooldown * speedFactor) / (n + 1);
      }
    }
    // Re-pick the primary: an upgrade may have just switched the unit's first live slot.
    u.weapon = u.weapons.find((w) => w.enabled) ?? null;
    if (u.weapon) u.bonusDamage = u.weapon.damage - (u.weapon.baseDamage + primaryDelta); // the buff/aura/item portion
    if (u.worker) u.worker.lumberCapacity = u.worker.baseLumberCapacity + upg.lumber; // Improved/Advanced Lumber Harvesting
    u.sightDay = u.baseSightDay + upg.sight;
    // Ultravision (`Ault`) — the unit keeps its DAY sight radius at night, i.e. the night
    // penalty simply does not apply to it.
    //
    // It is not innate, and that is the whole of the "do night elves see at night?"
    // question. `Ault` does sit on the night elf heroes, the Archer and the Glaive Thrower
    // from birth (Units\UnitAbilities.slk), which makes it look racial — but its own row
    // is `[Ault] Requires=Reuv`, the Ultravision upgrade researched at the Hunter's Hall.
    // So until that research lands a night elf takes exactly the same night penalty as
    // everyone else (Archer 1400 day / 800 night), and afterwards it does not. Same
    // upgrade-gated-ability shape as Pillage (Ropg) and Defend (Rhde).
    const ultravision = this.tech && this.tech.researchLevel(u.owner, "Reuv") > 0
      && u.abilities.some((a) => a.code === "Ault" && a.level >= 1);
    u.sightNight = ultravision ? u.sightDay : u.baseSightNight + upg.sight;
    u.speed = Math.max(0, (u.baseSpeed + upg.speed + item.speed) * (1 - slowMove) * (1 + hasteMove));
    // Root (`Aroo`) — an Ancient is a building that can decide to walk. UnitBalance already
    // gives every carrier a real movement speed (eaom spd=40): that is its UPROOTED walk, and
    // what makes it a building the rest of the time is simply that we refuse to spend it.
    // Zeroing the speed is the whole of "rooted" as far as movement is concerned — u.speed<=0
    // is already what issueFollow, the stuck check and the collision list all gate on.
    if (root && !u.uprooted) u.speed = 0;
    if (root) u.altModel = !u.uprooted; // planted = the alternate half of the Ancient model
    u.manaRegen = (u.isHero ? REGEN_PER_INT * u.int : u.baseMaxMana > 0 ? UNIT_MANA_REGEN : 0) + manaRegenBonus + item.manaRegen + upg.manaRegen;
    u.hpRegen = (u.isHero ? REGEN_PER_STR * u.str : 0) + hpRegenBonus + item.hpRegen;
    u.lifesteal = Math.max(lifesteal, item.lifesteal);
    // Spiked Carapace also returns a fraction of melee damage (dataA), like Thorns.
    u.thorns = Math.max(thorns, carapace ? this.dataOf(carapace, 0) : 0);
    u.stunned = stun;
    u.silenced = silence;
    u.ethereal = ethereal || u.etherealForm; // Banish (timed) OR the Spirit Walker's ethereal FORM (persistent)
    // Magic Immunity is a plain property of the unit's ability list, not a buff — nothing
    // grants or removes it mid-life, so it is derived here alongside the rest. (`Amim` carries
    // no Requires, so the tech gate below is a formality for it — it is the tower detection
    // that actually needs one.)
    u.magicImmune = u.abilities.some((a) => a.code === "Amim" && a.level >= 1 && this.techMeets(u.owner, a.id));
    // True Sight, likewise a property of the ability list. Three separate base codes do the
    // one job, so all three are read and the widest wins if a unit somehow carries more than
    // one. AbilityData.slk names them plainly:
    //
    //   Atru  "Detect (Shade)"           Rng1  900
    //   Adet  "Detect (Sentry Ward)"     Rng1 1100
    //   Adts  "Detect (Magic Sentinel)"  Rng1  900
    //
    // The radius is `Rng1` (castRange), NOT dataA — dataA reads 3 for all three, a
    // detection-TYPE enum that is not a distance at all, while those Rng1 values are exactly
    // the radii the game is documented to have. Reading dataA gave every detector a 3-unit
    // reach, i.e. True Sight silently never fired: nothing was ever revealed.
    //
    // `Adet` is the odd one out in the table: its row carries no `code` cell, so it reaches
    // the registry under the id fallback (abilities.ts `str(r, "code") || id`). No 1.27a unit
    // lists it — it is kept here for custom maps that hand it out.
    //
    // The tech gate is the standing "abilList membership is not availability" rule, and this
    // is the case that rule was written for: all four Human towers carry `Adts` from birth,
    // but `[Adts] Requires=Rhse` — Magic Sentry. Without the check, every Scout Tower on the
    // map would see through Wind Walk with the research still unbought.
    u.detectRadius = 0;
    for (const a of u.abilities) {
      if ((a.code !== "Atru" && a.code !== "Adet" && a.code !== "Adts") || a.level < 1) continue;
      if (!this.techMeets(u.owner, a.id)) continue;
      const lvl = this.abilities?.get(a.id)?.levelData[Math.max(0, a.level - 1)];
      const r = lvl?.castRange;
      if (r !== undefined && !Number.isNaN(r)) u.detectRadius = Math.max(u.detectRadius, r);
    }
    u.invisible = invisible;
    u.cloaked = cloaked;
    u.invulnerable = invuln || u.baseInvulnerable; // buffs (Divine Shield/Avatar) OR the unit type's Avul (issue #26)
    if (u.vanished) u.invulnerable = true; // whisked off the field mid-effect — nothing can reach it
    // Item attribute contribution (shown as green "+N" / red "-N" beside the stat).
    u.bonusStr = item.str;
    u.bonusAgi = item.agi;
    u.bonusInt = item.int;
  }

  /** This unit's Root ability (`Aroo`), or undefined for everything that is not an Ancient.
   *  Aro1/Aro2 are aliases of the same base code, which is what lets one lookup serve the
   *  Ancients, the three Tree of Life tiers and the Ancient Protector alike. */
  private rootAbility(u: SimUnit): SimAbility | undefined {
    return u.abilities.find((a) => a.code === "Aroo" && a.level >= 1);
  }

  /**
   * Root / Unroot (`Aroo`) — an Ancient pulling itself out of the ground, or planting again.
   * `Order=root` / `Unorder=unroot` in NightElfAbilityFunc: one ability, two directions, which
   * is why this toggles rather than taking a direction.
   *
   * Almost everything about the two states is derived in recomputeStats (the walk speed and
   * the live weapon slot both fall out of `uprooted`). What CANNOT be derived is the physical
   * transition, which is the only reason this method exists: a rooted Ancient occupies its
   * cells and an uprooted one must not, or it would collide with the hole it left behind.
   *
   * Rooting refuses if the Ancient no longer fits where it stands — it may have walked onto
   * ground too tight for its footprint, and a building that plants itself inside a wall is
   * worse than one that refuses to plant. Returns whether the toggle happened, so a caller
   * can tell a refusal from a no-op.
   */
  toggleRoot(u: SimUnit): boolean {
    if (!this.rootAbility(u)) return false;
    if (u.uprooted) {
      // Planting: test the ground FIRST, because it is the only step that can fail, and it
      // must be tested against the footprint the Ancient is about to take back rather than
      // the 0 it walks around with.
      const n = u.rootedFootprint;
      if (n > 0 && this.grid) {
        const [cx, cy] = this.grid.worldToCell(u.x, u.y);
        if (!this.grid.footprintFits(cx, cy, n)) return false;
      }
      u.uprooted = false;
      u.footprint = n;
      u.rootedFootprint = 0;
      this.stop(u.id); // drop any walk/target — it is a building again
      this.settle(u); // stamp its cells and snap onto the grid
    } else {
      u.uprooted = true;
      this.unsettle(u); // free the cells before it can take a step out of them
      // Put the building footprint away for the walk. A stamped n×n block is an obstacle the
      // pathfinder routes AROUND, so an Ancient that kept its 4×4 while walking would be
      // permanently boxed in by itself — pathTo fails on the first step and the thing just
      // stands there having visibly pulled its roots up. Walking, it collides by radius like
      // every other mobile unit; the footprint comes back when it plants.
      u.rootedFootprint = u.footprint;
      u.footprint = 0;
      // Whatever it was building keeps its place in the queue: WC3 halts an uprooted
      // Ancient's production rather than cancelling it (see tickBuildings).
    }
    this.recomputeStats(u);
    return true;
  }

  /** Defend (Adef), when the unit is actually braced: the ability's level data, else null.
   *
   *  WC3 models Defend as an ORDER PAIR — `Order=defend` / `Unorder=undefend` in
   *  HumanAbilityFunc.txt — which is the same on/off shape as an autocast toggle, so it rides
   *  the autocast flag rather than inventing a second toggle mechanism. (tickAutocast only ever
   *  fires `target: "unit"` abilities, so nothing tries to auto-cast it at anybody.)
   *
   *  The research gate is checked HERE and not merely on the button: an ability the player has
   *  not researched must not do anything even if a trigger or a stale toggle switched it on. */
  private defendStance(u: SimUnit): AbilityLevel | null {
    const ab = u.abilities.find((a) => a.code === "Adef" && a.level >= 1 && a.autocastOn);
    if (!ab || !this.abilities) return null;
    if (this.tech && !this.tech.meets(u.owner, ab.id)) return null; // Rhde not researched
    const def = this.abilities.get(ab.id);
    return def?.levelData[0] ?? null;
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
      if (b.delay > 0) b.delay -= dt; // Wind Walk's Transition Time, counting down to the vanish
      b.timeLeft -= dt;
    }
    u.buffs = u.buffs.filter((b) => b.timeLeft > 0);
    if (u.hp <= 0) {
      this.kill(u);
      return true;
    }
    return false;
  }

  /** Lightning Shield (Alsh): the shielded unit itself is unharmed, but every OTHER unit
   *  within the buff's radius takes `value` dps (spell damage, bypasses armor) — friend or
   *  foe, which is why it's cast on an enemy (or an expendable own unit). */
  private tickLightningShields(dt: number): void {
    // Snapshot holders first — a shield can kill units (including other holders) mid-pass.
    const shields = [];
    for (const u of this.units.values()) {
      for (const b of u.buffs) {
        if (b.kind === "shield" && b.value > 0) shields.push({ holder: u, dps: b.value, radius: b.value2 || 160, killerId: b.sourceId });
      }
    }
    for (const s of shields) {
      if (s.holder.hp <= 0) continue;
      for (const t of this.unitsInAreaInternal(s.holder.x, s.holder.y, s.radius)) {
        if (t === s.holder || t.hp <= 0 || t.building || t.invulnerable) continue;
        t.hp -= s.dps * dt; // spell damage — no armor reduction
        if (t.hp <= 0) this.kill(t, s.killerId);
      }
    }
  }

  /** Witch Doctor wards, ticked off their own data: the Healing Ward (`Aoar`) heals nearby
   *  friendly non-mechanical units by a % of max HP/sec; the Stasis Trap (`otot`) detonates
   *  when an enemy land unit enters its trigger radius, stunning enemies around it, then is
   *  consumed. Sentry Ward needs nothing — an owned unit reveals fog on its own. */
  private tickWards(dt: number): void {
    for (const u of this.units.values()) {
      if (!u.isSummon || u.hp <= 0) continue;
      const def = this.unitReg?.get(u.typeId);
      if (!def) continue;
      // Healing Ward — ability Aoar on the ward: heal allied non-mechanical units in range.
      if (def.abilities.includes("Aoar")) {
        const aoar = this.abilities?.get("Aoar")?.levelData[0];
        const pct = aoar ? this.dataOf(aoar, 0, 0.02) : 0.02;
        const area = aoar?.area || 500;
        for (const t of this.unitsInAreaInternal(u.x, u.y, area)) {
          if (t === u || t.hp <= 0 || t.mechanical || t.building || t.team !== u.team) continue;
          if (t.hp < t.maxHp) t.hp = Math.min(t.maxHp, t.hp + t.maxHp * pct * dt);
        }
      }
      // Stasis Trap — otot: arm until an enemy land unit steps into the trigger radius, then
      // stun every enemy land unit in the (larger) blast radius and consume the trap.
      if (u.typeId === "otot") {
        const astaDef = this.abilities?.get("Asta");
        const asta = astaDef?.levelData[0];
        const trig = asta ? this.dataOf(asta, 1, 250) : 250; // dataB — trigger radius
        const blast = asta ? this.dataOf(asta, 2, 400) : 400; // dataC — stun radius
        const stunDur = asta ? this.dataOf(asta, 3, 6) : 6; // dataD — stun duration
        const armed = this.unitsInAreaInternal(u.x, u.y, trig).some((e) => e.hp > 0 && !e.flying && !e.building && this.hostile(u, e));
        if (armed) {
          // Bsta, Stasis Trap's own buff, wears the same overhead stun swirl as BPSE.
          const stunFx = astaDef ? fx(astaDef) : undefined;
          for (const e of this.unitsInAreaInternal(u.x, u.y, blast)) {
            if (e.hp > 0 && !e.flying && !e.building && this.hostile(u, e)) this.applyBuffInternal(e, { kind: "stun", timeLeft: stunDur, sourceId: u.id, ...stunFx });
          }
          this.removeUnit(u.id); // trap consumed
        }
      }
    }
  }

  /** Kodo Devour: swallow an enemy land non-hero unit — it vanishes inside the Kodo (hidden,
   *  reserving no cells) and is digested. A Kodo holds only one at a time. */
  private devourInternal(kodo: SimUnit, prey: SimUnit): void {
    if (kodo.devouring > 0 || prey.devouredBy > 0 || prey.hp <= 0) return;
    this.unsettle(prey); // no cell block while inside
    this.cancelSwing(prey);
    prey.devouredBy = kodo.id;
    prey.order = "idle";
    prey.moving = false;
    prey.path = [];
    prey.targetId = null;
    prey.noCollision = false;
    kodo.devouring = prey.id;
  }

  /** Digest each swallowed unit at the Kodo's Devour dps; a fully-digested unit dies. */
  private tickDevour(dt: number): void {
    for (const u of this.units.values()) {
      if (u.devouring <= 0) continue;
      const prey = this.units.get(u.devouring);
      if (!prey || prey.hp <= 0) { u.devouring = 0; continue; }
      const lvl = this.passiveLevelData(u, "Adev");
      prey.hp -= (lvl ? this.dataOf(lvl, 0, 5) : 5) * dt; // dataA — digest damage/sec
      if (prey.hp <= 0) { u.devouring = 0; this.kill(prey, u.id); }
    }
  }

  /** Spit a swallowed unit back out beside the Kodo (the Kodo died mid-digest). */
  private freePrey(prey: SimUnit, kodo: SimUnit): void {
    prey.devouredBy = 0;
    const [cx, cy] = this.grid.worldToCell(kodo.x, kodo.y);
    const fit = this.grid.nearestWalkable(cx, cy, 6);
    if (fit) [prey.x, prey.y] = this.grid.cellToWorld(fit[0], fit[1]);
    prey.order = "idle";
    prey.moving = false;
    prey.path = [];
    this.settle(prey);
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
        // Which side an aura lands on is the ability's own business, read off `targs1`:
        // almost all of them are `friend,self` and help the owner's army, but Disease Cloud
        // is `ground,enemy,organic,neutral` and afflicts the other side. A hostile aura also
        // has to respect the rest of its flags — the plague takes neither a flyer nor a
        // mechanical unit — so it runs the same targetError gate a cast would.
        const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
        const hostileAura = F.has("enemy") && !F.has("friend");
        for (const t of this.units.values()) {
          if (t.building || t.hp <= 0) continue;
          if (hostileAura) {
            if (!this.hostile(src, t) || this.targetError(src, t, def.targetFlags, ab.code) !== null) continue;
          } else if (t.team !== src.team) continue;
          if (Math.hypot(t.x - src.x, t.y - src.y) > radius) continue;
          const ranged = !!t.weapon?.ranged;
          for (const e of effects) {
            if (e.rangedOnly && !ranged) continue; // Trueshot only helps ranged units
            if (e.meleeOnly && (ranged || !t.weapon)) continue; // Vampiric only helps melee units
            // An ordinary aura re-applies on a short TTL so it fades as its holder walks
            // away; one with its own `duration` (Disease Cloud) leaves something behind.
            this.applyBuffInternal(t, { kind: e.kind, group: `${ab.code}:${e.kind}`, timeLeft: e.duration ?? AURA_REFRESH, sourceId: src.id, value: e.value, value2: e.value2 });
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
        existing.delay = init.delay ?? 0; // a re-cast restarts the transition
        if (init.art) existing.art = init.art;
        return;
      }
    }
    const art = init.art ?? "";
    u.buffs.push({ kind: init.kind, group, timeLeft: init.timeLeft, sourceId: init.sourceId, value: init.value ?? 0, value2: init.value2 ?? 0, art, fx: init.fx ?? (art ? [{ path: art, attach: [] }] : []), delay: init.delay ?? 0, meld: init.meld });
  }

  private interruptForStun(u: SimUnit): void {
    // Pause movement WITHOUT clearing the path, so a plain move/patrol resumes when
    // the stun ends (settle() would wipe the path and strand the unit on "move",
    // which has no per-tick handler to restart it). Casting is fully interrupted.
    u.moving = false;
    u.inCombat = false;
    this.cancelSwing(u);
    if (u.order === "cast") {
      this.clearCast(u); // interrupted mid-cast → SPELL_ENDCAST
      u.order = "idle";
    }
  }

  /** Bash (Mountain King passive AHbh): roll whether THIS swing bashes.
   *
   *  The Data columns are named by AbilityMetaData.slk's Hbh1..5 rows (resolved through
   *  WorldEditStrings): dataA "Chance to Bash", dataB "Damage Multiplier", dataC "Damage
   *  Bonus", dataD "Chance to Miss". dataA is a PERCENT — Hbh1 carries maxVal=100 and
   *  AHbh stores 20/30/40, the 20/30/40% the Ubertip quotes — so it needs /100, exactly
   *  like Critical Strike's dataA. (This used to read dataB, which is 0 at every rank:
   *  Bash simply never fired.) */
  private rollBash(u: SimUnit): boolean {
    const lvl = this.passiveLevelData(u, "AHbh");
    if (!lvl) return false;
    return this.rng() < this.dataOf(lvl, 0, 20) / 100; // dataA — "Chance to Bash" (%)
  }

  /** Spend a rolled Bash at the blow: stun the target for Dur (HeroDur against a hero).
   *  The bonus damage is added to the swing itself in dealDamage, not here — it is attack
   *  damage and must go through the target's armour like the rest of the strike. */
  private applyBash(attacker: SimUnit, target: SimUnit): void {
    if (!this.abilities || target.invulnerable || target.hp <= 0) return;
    const ab = this.findAbility(attacker, "AHbh");
    const def = ab && this.abilities.get(ab.id);
    const lvl = this.passiveLevelData(attacker, "AHbh");
    if (!def || !lvl) return;
    // Dur1=2 / HeroDur1=1 — the game gives heroes their own, shorter stun rather than
    // clamping the normal one. `group` is the ability code so a second bash REFRESHES the
    // stun instead of stacking a pile of independent 2s buffs on the same victim.
    const stunDur = target.isHero ? lvl.heroDuration : lvl.duration;
    if (stunDur <= 0) return;
    // Bash's buff is BPSE — the same overhead swirl every stun in the game wears
    // (CommonAbilityFunc [BPSE] Targetart=…\Thunderclap\ThunderclapTarget.mdl, overhead).
    this.applyBuffInternal(target, { kind: "stun", group: "AHbh", timeLeft: stunDur, sourceId: attacker.id, ...fx(def) });
  }

  /** The flat damage a rolled Bash adds to its swing (dataC "Damage Bonus" — 25). */
  private bashDamageBonus(u: SimUnit): number {
    const lvl = this.passiveLevelData(u, "AHbh");
    return lvl ? this.dataOf(lvl, 2, 25) : 0; // dataC
  }

  /** Look up a learned/innate ability on a unit by its base code. */
  private findAbility(u: SimUnit, code: string): SimAbility | undefined {
    return u.abilities.find((a) => a.code === code && a.level >= 1);
  }

  /** Can a unit target another with a (harmful) spell right now? */
  private castableTarget(caster: SimUnit, target: SimUnit, flags: string[] = [], code = ""): boolean {
    return this.targetError(caster, target, flags, code) === null;
  }

  /** WHY a unit may not target another with an ability — a commandstrings.txt [Errors]
   *  key ("Targetenemy"), or null when the target is legal. This is the one place the
   *  rule lives: the sim gates the cast on it and the UI turns the key into the gold
   *  line above the console, so what the player is told can never drift from what the
   *  engine actually enforces.
   *
   *  The keys are the game's own and map almost 1:1 onto the `targs1` flags they refuse
   *  (`enemy` → Targetenemy = "Must target an enemy unit.", `nonhero` → Nohero =
   *  "Unable to target Heroes."), which is a good sign the real engine is table-driven
   *  off the same data. */
  targetError(caster: SimUnit, target: SimUnit, flags: string[] = [], code = ""): string | null {
    // Coarsest first: what the target IS, then what the ability may touch, then whether
    // this particular cast would achieve anything. Order is what the player reads — a
    // Paladin aimed at himself hears "Unable to target self." (the flag), not "Hero has
    // full health." (a fact about a target he can't pick in the first place).
    if (target.hp <= 0) return "Notcorpse"; // "Target must be living."
    if (target.invulnerable && this.hostile(caster, target)) return "Notinvulnerable";
    // Magic Immunity — "That unit is immune to magic." It refuses BOTH directions, which is
    // the part people misremember: you cannot Polymorph an enemy Spell Breaker, and you
    // cannot Bloodlust or Heal a friendly one either. See MAGIC_IMMUNE_EXEMPT for the
    // handful of abilities the engine lets through anyway.
    if (target.magicImmune && !MAGIC_IMMUNE_EXEMPT.has(code)) return "Immunetomagic";
    const flagError = this.targetAllowed(caster, target, flags);
    if (flagError !== null) return flagError;
    // Abilities whose legal targets are a rule, not a flag list — the data can't say
    // "friendly living OR enemy Undead", so the engine hardcodes it and gives the
    // ability its own error string. Holy Light and Death Coil are mirror images.
    const polarity = POLARITY_SPELLS[code];
    if (polarity && !this.polarityOk(caster, target, polarity.healsUndead)) return polarity.error;
    // A heal with nothing to heal is refused, not wasted — WC3 won't let you spend a
    // Paladin's mana on an undamaged Footman. The hero/unit split is the data's own:
    // "Hero has full health." vs "Already at full health."
    if (this.wouldHeal(caster, target, code) && target.hp >= target.maxHp) return target.isHero ? "HPmaxed" : "UnitHPmaxed";
    return null;
  }

  /** Would casting `code` on this target HEAL it? For a polarity spell the friendly half
   *  of its rule is the healing half (Holy Light heals the friendly living and smites the
   *  enemy Undead), so allegiance decides; polarityOk has already vouched for the race. */
  private wouldHeal(caster: SimUnit, target: SimUnit, code: string): boolean {
    if (POLARITY_SPELLS[code]) return !this.hostile(caster, target);
    return HEAL_SPELLS.has(code);
  }

  /** The Holy Light / Death Coil rule: one of heal-a-friendly and harm-an-enemy is for
   *  the Undead and the other is for the living. `healsUndead` picks which way round.
   *  Kept beside the spell handlers' own polarity check (sim/spells.ts) — that's what
   *  decides heal vs. damage once the cast lands; this decides whether it may start. */
  private polarityOk(caster: SimUnit, target: SimUnit, healsUndead: boolean): boolean {
    const undead = target.race === "undead";
    if (!this.hostile(caster, target)) return undead === healsUndead; // friendly
    return undead !== healsUndead; // enemy
  }

  /** Enforce the ability's "Targets Allowed" (AbilityData `targs1`) allegiance +
   *  hero/non-hero flags, so a spell only hits what its data says it may. Verified
   *  against the 1.27 MPQ: Storm Bolt/Chain Lightning/Slow are `enemy` (never a
   *  friendly), Heal/Inner Fire/Frost Armor are `friend,self` (never an enemy),
   *  Holy Light/Death Coil/Life Drain are `notself` (anything but the caster).
   *  Codes with no allegiance flag (Banish) stay unrestricted.
   *  Returns an [Errors] key, or null when allowed. */
  private targetAllowed(caster: SimUnit, target: SimUnit, flags: string[]): string | null {
    const F = new Set(flags.map((f) => f.toLowerCase()));
    // Clear-cut unit-type gates.
    if (F.has("nonhero") && target.isHero) return "Nohero";
    if (F.has("hero") && !target.isHero) return "Targethero";
    // "organic" is the absence of the two inorganic kinds — WC3 has no organic flag on the
    // unit, it has `mechanical` in UnitData and buildings, and everything else is flesh.
    if (F.has("organic") && (target.mechanical || target.building)) return "Notmechanical"; // "Must target organic units."
    // What the target IS — the same air/structure/ground classification weaponVs() already
    // applies to Targets Allowed, and for the same reason: a building is NOT "ground" (see
    // the Chimaera/Mortar Team note there). Spells read the identical flags, so the rule is
    // shared rather than re-derived.
    //
    // `ground` and `air` are the two commonest flags in the table (391 and 296 of the 799
    // rows) and they are an ALLOW-list: Entangling Roots is `ground,enemy,neutral,organic`
    // and may not root a Gryphon; the Batrider's Unstable Concoction is `air,neutral,enemy`
    // and may not be spent on a Grunt. Refusals are the game's own words — commandstrings.txt
    // [Errors] Noair/Noground/Nostructure.
    //
    // Gated only when the data names a target kind at all: plenty of rows restrict by
    // allegiance alone (Absorb Mana is `player,vuln,invu`) and stay unrestricted.
    // A structure-ONLY ability keeps the game's positive wording ("Must target a building.")
    // rather than the generic refusal — that is what Repair says when aimed at a Footman.
    if (F.has("structure") && !F.has("ground") && !F.has("air") && !target.building) return "Targetstructure";
    if (F.has("air") || F.has("ground") || F.has("structure")) {
      const kind = target.building ? "structure" : target.flying ? "air" : "ground";
      if (!F.has(kind)) return kind === "air" ? "Noair" : kind === "structure" ? "Nostructure" : "Noground";
    }
    const enemy = F.has("enemy");
    const friend = F.has("friend") || F.has("player"); // `player` = own units (Death Pact/Dark Ritual)
    const self = F.has("self");
    const neutral = F.has("neutral");
    const notself = F.has("notself");
    // No allegiance restriction in the data (e.g. Banish) → any allegiance allowed.
    if (!(enemy || friend || self || neutral || notself)) return null;
    if (target.id === caster.id) return self ? null : "Notself";
    if (notself) return null; // anything but the caster
    if (this.hostile(caster, target)) return enemy ? null : "Notenemy";
    if (target.neutralPassive) return neutral || friend ? null : "Notneutral";
    return friend ? null : "Notfriendly";
  }

  /** A refusal the game has no words for: the click is rejected and the error beeps, but no
   *  gold line appears. Not every "no" in WC3 comes with a sentence. */
  static readonly SILENT_REFUSAL = SILENT_REFUSAL;

  /** WHY this unit can't cast this ability at this target right now — a commandstrings.txt
   *  [Errors] key, or null if it can. This is the click-time gate: the UI asks before it
   *  spends the order, so the player gets told and the cursor stays armed rather than the
   *  click being silently eaten.
   *
   *  Mana and cooldown are checked HERE, at click time, and not only in tickCast — WC3
   *  says "Not enough mana." the instant you click, it doesn't walk the caster into range
   *  first and then quietly give up. tickCast still re-checks both, because the walk takes
   *  time and a cheaper spell may drain the mana in the meantime. */
  castError(unitId: number, code: string, targetId = 0): string | null {
    const u = this.units.get(unitId);
    if (!u || !this.abilities) return "Notthisunit";
    const ab = this.findAbility(u, code);
    if (!ab) return "Notthisunit";
    const def = this.abilities.get(ab.id);
    if (!def || def.target === "passive") return "Notthisunit";
    // Silenced/stunned has no string in the data because WC3 never needs one — it greys the
    // button out, so the click can't happen. We refuse with the error beep and no sentence
    // rather than borrow a line that means something else (Notdisabled is about movement).
    if (u.stunned || u.silenced) return SILENT_REFUSAL;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    if (ab.cooldownLeft > 0) return "Cooldown"; // "Spell is not ready yet."
    if (u.mana < lvl.cost) return "Nomana"; // "Not enough mana."
    if (def.target !== "unit") return null;
    const t = this.units.get(targetId);
    if (!t) return "Targetunit"; // "Must target a unit with this action." — clicked bare ground
    return this.targetError(u, t, def.targetFlags, code);
  }

  /** Order a unit to cast an ability. `code` is the ability's base code; targetId
   *  (unit) / x,y (point) depend on the ability's target type. Returns false if
   *  the cast can't be started (unknown/unlearned ability, wrong target, dead). */
  issueCast(unitId: number, code: string, targetId = 0, x = 0, y = 0): boolean {
    const u = this.units.get(unitId);
    if (!u || u.stunned || u.silenced || !this.abilities) return false;
    // An illusion is a picture of a caster, not a caster: it has the abilities on its sheet
    // (it is an exact copy) but may not use them. The command card hides them too — this is
    // the backstop for every other route in (a trigger, a hotkey, autocast).
    if (u.isIllusion) return false;
    const ab = this.findAbility(u, code);
    if (!ab) return false;
    const def = this.abilities.get(ab.id);
    if (!def || def.target === "passive") return false;
    const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
    // Immediate abilities (see IMMEDIATE) fire here and now: pay, run the effect, done.
    // They take no order and touch none of the unit's state below, so they neither need
    // the castLocked gate nor interrupt a swing, a walk, or another spell's wind-up.
    if (IMMEDIATE.has(code)) return this.castImmediate(u, ab, def, lvl);
    if (this.castLocked(u)) return false; // already committed to a spell — see castLocked
    const t = def.target === "unit" ? this.units.get(targetId) : undefined;
    if (def.target === "unit" && (!t || !this.castableTarget(u, t, def.targetFlags, code))) return false;
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
      committed: false,
      fired: false,
      channelLeft: 0,
      backLeft: 0,
      ended: false,
      resume,
    };
    return true;
  }

  /** Cast an IMMEDIATE ability on the spot: no PendingCast, no wind-up, no cast
   *  animation, and the caster's current order (an attack in mid-swing, a walk) is
   *  left completely alone. The whole cast collapses into this one call, so every
   *  spell event fires here in the order tickCast would have raised them. */
  private castImmediate(u: SimUnit, ab: SimAbility, def: AbilityDef, lvl: AbilityLevel): boolean {
    if (ab.cooldownLeft > 0 || u.mana < lvl.cost) return false;
    u.mana -= lvl.cost;
    ab.cooldownLeft = lvl.cooldown;
    // A stand-in PendingCast purely to describe the cast to noteSpell/resolveCast —
    // it is never stored on the unit, so nothing can interrupt or resume it.
    const pc: PendingCast = {
      code: def.code,
      abilityId: ab.id,
      rank: ab.level,
      targetId: 0,
      x: u.x,
      y: u.y,
      range: 0,
      castLeft: 0,
      started: true,
      committed: true,
      fired: true,
      channelLeft: 0,
      backLeft: 0,
      ended: true,
      resume: null,
    };
    this.noteSpell(u, pc, "channel");
    this.noteSpell(u, pc, "cast");
    this.breakInvisibility(u); // casting reveals, the same as for a wound-up spell
    this.castFires.push({ casterId: u.id, code: def.code, abilityId: ab.id }); // sound only — no castStarts, so no clip to hold
    this.noteSpell(u, pc, "effect");
    this.resolveCast(u, def, pc);
    this.noteSpell(u, pc, "finish");
    this.noteSpell(u, pc, "endcast");
    return true;
  }

  /** Drive a pending cast through its lifecycle (see PendingCast): approach + face
   *  → wind up → fire (commit mana/cooldown) → channel or backswing → resume. */
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
    // Resolve where we're aiming; a unit target that died/became invalid aborts
    // (but only until the effect has fired — a channel/backswing keeps its point).
    let tx = pc.x;
    let ty = pc.y;
    if (pc.targetId && !pc.fired) {
      const t = this.units.get(pc.targetId);
      if (!t || !this.castableTarget(u, t, def.targetFlags, pc.code)) {
        this.stop(u.id);
        return;
      }
      tx = t.x;
      ty = t.y;
      pc.x = tx;
      pc.y = ty;
    }

    // --- phase 3: post-effect. Either CHANNEL (locked, a new order stops it and
    // its ticks) or a cast BACKSWING (pure recovery a new order cancels for free).
    // We reach here only via the normal timeline; any new order re-tasks u.order
    // away from "cast", so tickCast simply stops running (the recovery/channel is
    // abandoned) — which is exactly WC3 animation canceling.
    if (pc.fired) {
      if (u.moving) this.settle(u);
      if (pc.channelLeft > 0) {
        // Channelling: keep facing the target point (Blizzard aims where you cast).
        u.desiredFacing = Math.atan2(pc.y - u.y, pc.x - u.x);
        pc.channelLeft -= dt;
        if (pc.channelLeft > 0) return;
      } else if (pc.backLeft > 0) {
        // Backswing: the effect already happened; just stand out the recovery.
        pc.backLeft -= dt;
        if (pc.backLeft > 0) return;
      }
      this.endCast(u, pc);
      return;
    }

    // --- phase 1: approach + face (before the wind-up begins) ---
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
      // Gate on affordability up front so the caster never winds up a spell it
      // can't pay for. Mana/cooldown are only COMMITTED at the effect (below), so
      // interrupting the wind-up cancels the spell for free.
      if (ab.cooldownLeft > 0 || u.mana < lvl.cost) {
        this.stop(u.id);
        return;
      }
      pc.started = true;
      // Wind-up before the effect = the unit's Cast Point PLUS the ability's own
      // Casting Time (they add — hiveworkshop "Cast Point and Backswing" 265781;
      // castPoint 0 → an instant cast). Storm Bolt = MK's 0.4; Blizzard = Archmage's
      // 0.3 + the spell's 1.0 Casting Time = 1.3s before the first shard.
      pc.castLeft = u.castPoint + lvl.castTime;
      const channelLen = this.channelDuration(def, pc.rank);
      // Tell the renderer to play the cast clip and hold it for the whole cast
      // (wind-up + backswing, or wind-up + channel — looped for a channel).
      const hold = pc.castLeft + (channelLen > 0 ? channelLen : u.castBackswing);
      const warnArt = PRECAST_WARNING.has(pc.code) ? def.effectArt : "";
      // tx/ty/targetId let the renderer aim cast-triggered visuals at the target —
      // e.g. the Blood Mage hurling one of his orbiting spheres (issue #37).
      this.castStarts.push({ casterId: u.id, code: pc.code, abilityId: pc.abilityId, hold, loop: channelLen > 0, tx, ty, targetId: pc.targetId, warnArt });
      // The caster has begun: SPELL_CHANNEL then SPELL_CAST (7.17). WC3 raises both at
      // the start of the cast — CHANNEL as the caster commits to it, CAST as the spell
      // itself begins; the EFFECT below is the one most triggers actually listen for.
      this.noteSpell(u, pc, "channel");
      this.noteSpell(u, pc, "cast");
      // Delayed-strike "beware" warning (see PRECAST_WARNING): drop the ability's
      // Effectart at the target NOW, as the wind-up begins, so Flame Strike's smoke
      // vortex charges in place and lingers even if the cast is interrupted before
      // the pillar erupts. Only the completed cast reaches the effect handler.
      if (PRECAST_WARNING.has(pc.code)) {
        if (def.effectArt) this.spellEffects.push({ art: def.effectArt, x: tx, y: ty, targetId: 0, z: 0 });
        // ...and spend the mana + cooldown UP FRONT (WC3/Liquipedia: interrupting the
        // Blood Mage mid-cast still wastes the cast). `committed` stops phase 2 from
        // charging a second time. The affordability gate above already ran, so we know
        // it's payable here.
        u.mana -= lvl.cost;
        ab.cooldownLeft = lvl.cooldown;
        pc.committed = true;
      }
    }

    // --- phase 2: wind-up. The effect fires when it elapses; canceling before then
    // (a new order, or a stun via interruptForStun) aborts the spell — with no cost
    // for a normal spell, but a PRECAST_WARNING spell (Flame Strike) has already paid
    // at wind-up start, so an interrupt there simply wastes the cast. ---
    pc.castLeft -= dt;
    if (pc.castLeft > 0) return;
    // Commit: spend mana + start the cooldown, THEN fire. Re-check mana in case it
    // was drained (Mana Burn) mid-wind-up. Abilities that committed at wind-up start
    // (PRECAST_WARNING) already paid, so skip the charge and fire regardless.
    if (!pc.committed) {
      if (u.mana < lvl.cost || ab.cooldownLeft > 0) {
        this.stop(u.id);
        return;
      }
      u.mana -= lvl.cost;
      ab.cooldownLeft = lvl.cooldown;
    }
    pc.fired = true;
    // Casting reveals, the same as attacking ("anything but move or stop"). This runs BEFORE
    // resolveCast so that Wind Walk itself doesn't break the very fade it is about to grant —
    // the break settles the OLD invisibility, then the handler applies the new one.
    this.breakInvisibility(u); // no backstab: only a blow earns that
    // The effect fires NOW (cast point) — cue its cast sound here so it lands with
    // the visible clap/bolt, not 0.4s early at the wind-up (issue #23).
    this.castFires.push({ casterId: u.id, code: pc.code, abilityId: pc.abilityId });
    this.noteSpell(u, pc, "effect"); // EVENT_(PLAYER_)UNIT_SPELL_EFFECT — the spell goes off
    this.resolveCast(u, def, pc);
    pc.channelLeft = this.channelDuration(def, pc.rank);
    // No channel → play the cast backswing recovery (0 = none). A channel holds
    // instead; there's no backswing after one.
    pc.backLeft = pc.channelLeft > 0 ? 0 : u.castBackswing;
    if (u.moving) this.settle(u);
    if (pc.channelLeft <= 0 && pc.backLeft <= 0) this.endCast(u, pc); // instant, no recovery
  }

  /** End a cast: resume the pre-cast attack-move/follow, else fall idle. */
  private endCast(u: SimUnit, pc: PendingCast): void {
    // The cast ran its course: SPELL_FINISH (the channel/recovery is over) then
    // SPELL_ENDCAST (the caster has stopped casting). `ended` marks it done so the
    // stop below — and any later stop of a stale pendingCast — can't raise a second
    // ENDCAST for the same cast (see clearCast).
    this.noteSpell(u, pc, "finish");
    this.noteSpell(u, pc, "endcast");
    pc.ended = true;
    if (pc.resume?.kind === "attackmove") this.issueAttackMove(u.id, pc.resume.x, pc.resume.y);
    else if (pc.resume?.kind === "follow") this.issueFollow(u.id, pc.resume.id);
    else this.stop(u.id);
  }

  /** Drop a unit's pending cast, raising SPELL_ENDCAST if it was interrupted mid-cast
   *  (WC3 fires ENDCAST whether the spell completed or was cancelled — a stun, a Stop,
   *  a new order). A cast that already ran to endCast is marked `ended` and stays quiet. */
  private clearCast(u: SimUnit): void {
    const pc = u.pendingCast;
    if (!pc) return;
    u.pendingCast = null;
    if (pc.started && !pc.ended) this.noteSpell(u, pc, "endcast");
  }

  /** How long a channelled spell locks its caster (0 = not a channel). Matches the
   *  wave field the handler schedules so the caster channels exactly as long as the
   *  effect lasts: the ability's Duration for the timed fields (Tranquility 30s,
   *  Starfall 45s, Death and Decay 35s, Stampede/Earthquake), or waves × interval for
   *  the wave fields. A wave field's Duration column is NEVER its channel: Blizzard's
   *  is 0 and Rain of Fire's 3 is how long its burn lingers — the Pit Lord channels
   *  6/8/10s (one second per wave), not 3. See `waveSchedule`. */
  private channelDuration(def: AbilityDef, rank: number): number {
    if (!CHANNELED.has(def.code)) return 0;
    const lvl = def.levelData[Math.min(rank, def.levelData.length) - 1];
    if (lvl.duration > 0 && !WAVE_FIELDS.has(def.code)) return lvl.duration;
    const { waves, interval } = waveSchedule(lvl);
    return waves * interval;
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
      const target = this.autocastTarget(u, lvl.castRange, friendly, def.code, F.has("self"), def.targetFlags);
      if (target) return this.issueCast(u.id, def.code, target.id);
    }
    return false;
  }

  private autocastTarget(u: SimUnit, range: number, friendly: boolean, code: string, selfOk: boolean, flags: string[] = []): SimUnit | null {
    let best: SimUnit | null = null;
    let bestScore = friendly ? 0.999 : Infinity;
    for (const t of this.units.values()) {
      if (t.building || t.hp <= 0) continue;
      // The pick must satisfy the same Targets Allowed gate the cast itself will run.
      // Without this the search happily returns a target issueCast then refuses — and a
      // Shaman standing between a Gryphon and a Grunt would keep choosing the Gryphon for
      // his ground-only Lightning Shield and never shield anything at all.
      if (this.targetError(u, t, flags, code) !== null) continue;
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
    // Launch from the caster's weapon model point if it has one (e.g. the Death
    // Knight's Death Coil from his hand); otherwise from a default missile height so
    // it never leaves from the feet.
    const w = u.weapon;
    const lzLocal = w && w.launchZ > 0 ? w.launchZ : DEFAULT_MISSILE_HEIGHT;
    const [lx, ly, lz0] = launchPoint(u, w?.launchX ?? 0, w?.launchY ?? 0, lzLocal);
    const t = this.units.get(targetId);
    // Same height handling as attacks: launch from the caster's altitude, land at
    // the target's (a flying caster's/target's spell missile tracks their height).
    const lz = lz0 + u.flyHeight;
    const impactBase = w && w.impactZ > 0 ? w.impactZ : DEFAULT_MISSILE_HEIGHT;
    const proj: SimProjectile = {
      id,
      x: lx,
      y: ly,
      z: lz,
      sourceId: u.id,
      targetId,
      speed: 900,
      damage: 0, // spell effect (not plain damage) is applied on impact
      art: def.missileArt,
      spell: { code: def.code, rank, abilityId: def.id },
      startZ: lz,
      impactZ: impactBase + (t?.flyHeight ?? 0),
      startDist: t ? Math.hypot(t.x - lx, t.y - ly) : 0,
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y, z: proj.z });
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
    const killer = this.units.get(killerId);
    // Only an ENEMY kill grants XP: killing your own or an allied unit (same team),
    // or a neutral-passive critter/shop, awards nothing (issue #21). Without this the
    // even-share loop finds no eligible hero and the global fallback below would still
    // reward the killer's own heroes for a friendly-fire kill.
    if (killer && !this.hostile(killer, victim)) return;
    // A slain enemy hero pays out the (much larger) GrantHeroXP table; everything
    // else pays GrantNormalXP. Both are indexed by the victim's own level.
    let base = grantedXp(victim.level || 0, victim.isHero);
    if (base <= 0) return;
    if (victim.isSummon) base *= SUMMON_XP_FACTOR;
    // Beneficiaries: enemy heroes of the victim within share range (else global).
    // NB max-level heroes are deliberately NOT excluded — MiscGame
    // MaxLevelHeroesDrainExp=1, so a level-10 hero standing in range still claims a
    // share of the pool (which gainXp then discards), shrinking what its lower-level
    // team-mates receive. This is real WC3 behaviour, not an oversight.
    const eligible: SimUnit[] = [];
    for (const h of this.units.values()) {
      if (!h.isHero || h.hp <= 0 || h.team === victim.team) continue;
      if (killer && h.team !== killer.team) continue; // only the killer's side (team = alliance group)
      if (Math.hypot(h.x - victim.x, h.y - victim.y) <= XP_SHARE_RANGE) eligible.push(h);
    }
    if (!eligible.length) {
      // No hero in range: GlobalExperience=1 — award to ALL the killer's heroes
      // regardless of distance (still split among them, no per-distance loss).
      for (const h of this.units.values()) {
        if (h.isHero && h.hp > 0 && killer && h.team === killer.team) eligible.push(h);
      }
    }
    if (!eligible.length) return;
    const share = base / eligible.length; // split evenly among the sharers
    for (const h of eligible) {
      let amount = share;
      const isCreep = victim.team === -1; // Neutral Hostile
      if (isCreep) amount *= creepXpFactor(h.level);
      this.gainXp(h, amount, isCreep);
    }
  }

  /** Add XP to a hero, leveling it up (with stat growth) across thresholds. */
  gainXp(hero: SimUnit, amount: number, isCreep = false): void {
    if (!hero.isHero || hero.level >= MAX_HERO_LEVEL || amount <= 0) return;
    hero.xp += amount;
    while (hero.level < MAX_HERO_LEVEL && hero.xp >= xpToReachLevel(hero.level + 1)) {
      this.levelUp(hero);
      // WC3: once a hero reaches a level where creeps grant no XP (HeroFactorXP=0 at
      // level 5+), any surplus that a creep kill pushed past the threshold is dropped
      // — the overshoot came from a creep and must not count (issue #30). The bar sits
      // exactly at the new level's threshold rather than carrying leftover creep XP.
      if (isCreep && creepXpFactor(hero.level) === 0) {
        hero.xp = xpToReachLevel(hero.level);
        break;
      }
    }
  }

  private levelUp(hero: SimUnit): void {
    hero.level++;
    hero.skillPoints++;
    // Levelling does NOT refill (issue #69). The new strength/intellect raise the ceiling and
    // recomputeStats carries the current pool up with it in proportion — a hero who dings at
    // 100/1000 comes out at 105/1050, not healed to full. A level-up is not an escape.
    this.recomputeStats(hero); // new maxHp/maxMana/attributes, current pool scaled with them
    this.levelUps.push({ unitId: hero.id, level: hero.level }); // renderer: level-up nova
    // EVENT_(PLAYER_)HERO_LEVEL for the trigger engine (7.17) — a separate queue from
    // the renderer's, since each side drains its own.
    if (this.captureHeroEvents) this.heroEvents.push({ hero: eventInfo(hero), phase: "level", level: hero.level, abilityId: "" });
    // A hero's images level with him, nova and all. They are copies of him as he is NOW, so
    // a Blademaster who dinged while his images stood beside him would otherwise be the only
    // one of the four to grow and flash — pointing straight at the real one.
    for (const im of this.units.values()) {
      if (im.isIllusion && im.illusionOf === hero.id && im.hp > 0) this.levelUpIllusion(im, hero);
    }
  }

  /** Make a freshly-spawned copy into an illusion of `ofId`. Called by the renderer once the
   *  unit exists (spawning is async — see drainSummonRequests).
   *
   *  Order matters, which is why this is one method and not six writes at the call site: the
   *  level must land BEFORE recomputeStats, and hp/mana can only be set once that has run.
   *  Spawning starts every hero at the unit TYPE's level 1, so an image of a level-5
   *  Blademaster arrives with a level-1 pool; leave it and the next tick's recomputeStats
   *  raises its maxHp past its hp and the copy stands there looking wounded. */
  initIllusion(u: SimUnit, ofId: number, init: IllusionInit): void {
    u.isIllusion = true;
    u.illusionOf = ofId;
    u.illusionDamageDealt = init.dealt; // AOmi DataB "Damage Dealt (%)" — 0: it hurts nothing
    u.illusionDamageTaken = init.taken; // AOmi DataC "Damage Taken (%)" — 200%
    u.properName = init.properName; // the original's name, not the fresh roll spawning gave it
    u.level = Math.max(1, init.level);
    // Tomes are PERMANENT and live in the original's base attributes (applyPowerup bumps
    // baseStr/baseAgi/baseInt/baseMaxHp), so a copy spawned off the unit type alone would be
    // missing every tome he ever drank — visibly weaker on the sheet than the hero beside it.
    u.baseStr = init.baseStr;
    u.baseAgi = init.baseAgi;
    u.baseInt = init.baseInt;
    u.baseMaxHp = init.baseMaxHp;
    // The original's items, as INERT copies: same itemId (so the panel draws the same six
    // slots and itemBonuses grants the same +damage/+armour/+stats), but no entity id. An
    // item is ONE entity that JASS handles track across ground↔inventory (see HeldItem.id);
    // handing four copies the original's ids would have four units claiming to hold it. The
    // image can't drop, give or use them anyway — see the isIllusion guards on those.
    u.inventory = init.inventory.map((it) => (it ? { id: 0, itemId: it.itemId, charges: it.charges, cooldownLeft: 0 } : null));
    this.recomputeStats(u); // maxHp/maxMana/attributes off THAT level, tomes and items
    u.hp = u.maxHp;
    u.mana = Math.min(u.maxMana, init.mana); // the original's pool as it stands after the cast
  }

  /** Bring an illusion up to its hero's new level. Not levelUp(): an image earns nothing of
   *  its own — no skill point (it cannot learn or cast), and no HERO_LEVEL event, which is
   *  the player's hero levelling and must fire once, not once per copy. */
  private levelUpIllusion(im: SimUnit, hero: SimUnit): void {
    im.level = hero.level;
    // The hero's pool rides his new ceiling in proportion, so the images' must too — matching
    // pools is the whole point. recomputeStats does exactly that for both.
    this.recomputeStats(im); // new maxHp/maxMana/attributes off the level
    this.levelUps.push({ unitId: im.id, level: im.level }); // the same nova, on every image
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
    // EVENT_(PLAYER_)HERO_SKILL → GetLearningUnit/GetLearnedSkill/GetLearnedSkillLevel.
    if (this.captureHeroEvents) this.heroEvents.push({ hero: eventInfo(u), phase: "skill", level: ab.level, abilityId });
    return true;
  }

  // === trigger effect API (7.17) ===========================================
  // The natives a map's triggers call to grant abilities, level heroes, and flip
  // per-unit flags. Each is a thin, guarded mutation the JASS bridge routes into
  // (src/jass/natives/abilities.ts + world.ts → EngineHooks).

  /** UnitAddAbility — grant an ability, already usable (WC3 adds it at rank 1, even
   *  a hero ability: it is *added*, not made learnable). A duplicate is a no-op. */
  addAbility(unitId: number, abilityId: string): boolean {
    const u = this.units.get(unitId);
    const def = this.abilities?.get(abilityId);
    if (!u || !def) return false;
    if (u.abilities.some((a) => a.id === abilityId)) return false;
    u.abilities.push({ id: abilityId, code: def.code, level: 1, cooldownLeft: 0, autocastOn: false });
    this.recomputeStats(u); // an ability can carry stat bonuses / an aura
    return true;
  }

  /** UnitRemoveAbility — take an ability away (and any cast of it in flight). */
  removeAbility(unitId: number, abilityId: string): boolean {
    const u = this.units.get(unitId);
    if (!u) return false;
    const i = u.abilities.findIndex((a) => a.id === abilityId);
    if (i < 0) return false;
    u.abilities.splice(i, 1);
    if (u.pendingCast?.abilityId === abilityId) this.stop(u.id);
    this.recomputeStats(u);
    return true;
  }

  /** GetUnitAbilityLevel — the unit's rank in an ability (0 = doesn't have it, or a
   *  hero ability it hasn't learned). */
  abilityLevelOf(unitId: number, abilityId: string): number {
    return this.units.get(unitId)?.abilities.find((a) => a.id === abilityId)?.level ?? 0;
  }

  /** SetUnitAbilityLevel (and Inc/DecUnitAbilityLevel, which ride on it) — set the
   *  rank directly, clamped to the ability's max. Returns the resulting rank. */
  setAbilityLevel(unitId: number, abilityId: string, level: number): number {
    const u = this.units.get(unitId);
    const ab = u?.abilities.find((a) => a.id === abilityId);
    const def = this.abilities?.get(abilityId);
    if (!u || !ab || !def) return 0;
    ab.level = Math.max(0, Math.min(def.levels || 1, Math.trunc(level)));
    this.recomputeStats(u);
    return ab.level;
  }

  /** UnitResetCooldown — clear every ability cooldown on the unit. */
  resetCooldowns(unitId: number): void {
    const u = this.units.get(unitId);
    if (u) for (const a of u.abilities) a.cooldownLeft = 0;
  }

  /** SetHeroLevel — jump a hero to `level`. WC3 only ever levels a hero UP with this
   *  (a lower level is ignored), granting the skill points and stat growth of each
   *  level crossed — so it runs the real levelUp path (nova, HP/mana refill, and the
   *  HERO_LEVEL event) once per level, and parks the XP bar at the new level's floor. */
  setHeroLevel(unitId: number, level: number): void {
    const h = this.units.get(unitId);
    if (!h?.isHero) return;
    const target = Math.min(MAX_HERO_LEVEL, Math.trunc(level));
    while (h.level < target) this.levelUp(h);
    h.xp = Math.max(h.xp, xpToReachLevel(h.level));
  }

  /** AddHeroXP — grant experience (levels follow through gainXp). Not a creep kill,
   *  so no HeroFactorXP discount applies. */
  addHeroXp(unitId: number, amount: number): void {
    const h = this.units.get(unitId);
    if (h) this.gainXp(h, amount);
  }

  /** SetHeroXP — set the XP bar directly, levelling the hero to match it. */
  setHeroXp(unitId: number, xp: number): void {
    const h = this.units.get(unitId);
    if (!h?.isHero) return;
    h.xp = Math.max(0, Math.trunc(xp));
    while (h.level < MAX_HERO_LEVEL && h.xp >= xpToReachLevel(h.level + 1)) this.levelUp(h);
  }

  /** UnitModifySkillPoints — add/remove unspent skill points (never below zero). */
  modifySkillPoints(unitId: number, delta: number): boolean {
    const h = this.units.get(unitId);
    if (!h?.isHero) return false;
    h.skillPoints = Math.max(0, h.skillPoints + Math.trunc(delta));
    return true;
  }

  /** SetUnitInvulnerable — the unit takes no damage and can't be targeted by enemies
   *  (issue #26's baseInvulnerable, which recomputeStats folds into `invulnerable`
   *  each tick alongside the buff-granted ones, so set both). */
  setInvulnerable(unitId: number, flag: boolean): void {
    const u = this.units.get(unitId);
    if (!u) return;
    u.baseInvulnerable = flag;
    u.invulnerable = flag || u.invulnerable;
    if (!flag) this.recomputeStats(u); // buffs may still hold it invulnerable
  }

  /** SetUnitPathing(false) — the unit ignores collision (walks through units and,
   *  in WC3, terrain; ours is the sim's existing ghost flag). */
  setPathing(unitId: number, flag: boolean): void {
    const u = this.units.get(unitId);
    if (u) u.noCollision = !flag;
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

  private spellFields: Array<SpellFieldInit & { timer: number; done: number; team: number; flags: string[] }> = [];

  /** Waves that have been thrown but haven't hit the ground yet (see SHARD_FALL).
   *  They live OUTSIDE their field on purpose: shards already in the air still land
   *  when the channel is broken, so a Blizzard cancelled the instant before impact
   *  still deals that last wave. */
  private waveImpacts: Array<{ t: number; x: number; y: number; area: number; damage: number; casterId: number; team: number; flags: string[]; maxDamage: number; buildingReduction: number; dot: SpellFieldInit["dot"] }> = [];

  // --- Mirror Image (AOmi) ------------------------------------------------------------
  //
  // The shuffle, as the game stages it: the Blademaster vanishes and MirrorImageCaster
  // stands in his place; after the ability's own "Animation Delay" (DataD = 0.5s) that
  // effect throws one MirrorImageMissile per destination; each missile that lands puts an
  // illusion on its tile — except the one tile, picked at random, where the real hero is
  // set back down. Which of them is the true Blademaster is therefore anyone's guess,
  // including the caster's, and that IS the ability.
  //
  // It runs here rather than on the projectile system because these missiles fly to a
  // POINT and deal nothing; tickProjectiles is built around a target unit it damages.
  private mirrorCasts: Array<{
    casterId: number;
    abilityId: string;
    rank: number;
    delayLeft: number; // AOmi DataD "Animation Delay" — the beat before the missiles fly
    thrown: boolean;
    duration: number; // how long each illusion lasts (Dur1)
    dealt: number; // AOmi DataB "Damage Dealt (%)"
    taken: number; // AOmi DataC "Damage Taken (%)"
    /** The caster's mana the instant the spell went off — i.e. AFTER its 125 was paid. An
     *  image is a copy of the Blademaster as he is NOW, half-drained pool included; spawning
     *  it on a full bar would mark it out at a glance. Captured once here rather than read at
     *  landing, so all the images match each other and the hero exactly (mana regenerates
     *  during the missiles' flight). */
    mana: number;
    missileArt: string;
    /** One per destination tile. `hero` marks the single slot the real Blademaster takes. */
    spots: Array<{ x: number; y: number; hero: boolean; t: number; flight: number; sx: number; sy: number; landed: boolean }>;
  }> = [];

  /** Strip every timed buff (Dispel Magic; Mirror Image dispels its own caster). Auras
   *  re-apply on the next tick, so only the timed ones actually go. */
  private dispelUnit(u: SimUnit): void {
    u.buffs = [];
  }

  /** Begin Mirror Image: hide the caster, and work out where everyone lands. */
  private startMirrorImage(caster: SimUnit, def: AbilityDef, rank: number): void {
    const lvl = def.levelData[Math.min(rank, def.levelData.length) - 1];
    if (!lvl) return;
    const images = Math.max(1, Math.round(this.dataOf(lvl, 0, 1))); // DataA "Number of Images"
    // A re-cast replaces the pack: the previous images pop (each with its own
    // MirrorImageDeathCaster) rather than piling up alongside the new ones.
    for (const u of [...this.units.values()]) {
      if (u.isIllusion && u.owner === caster.owner && u.typeId === caster.typeId && u.hp > 0) this.unsummon(u);
    }
    // One tile per image PLUS one for the hero himself — he is shuffled in among them.
    const spots = this.mirrorSpots(caster, images + 1);
    if (!spots.length) return;
    const heroSlot = Math.floor(this.rng() * spots.length); // never a fixed slot: the whole
    // point is that the enemy (and the caster's own hand) cannot know which one is real.
    const speed = 1000; // AOmi Missilespeed
    this.mirrorCasts.push({
      casterId: caster.id,
      abilityId: def.id,
      rank,
      delayLeft: this.dataOf(lvl, 3, 0.5), // DataD "Animation Delay"
      thrown: false,
      duration: lvl.heroDuration || lvl.duration || 60,
      dealt: this.dataOf(lvl, 1, 0), // DataB "Damage Dealt (%)" — 0: an illusion hurts nothing
      taken: this.dataOf(lvl, 2, 2), // DataC "Damage Taken (%)"
      // The cost is spent UP FRONT at the cast commit (see the `committed` phase), so the
      // caster's pool is already post-cast by the time this handler runs.
      mana: caster.mana,
      missileArt: def.missileArt,
      spots: spots.map((s, i) => ({
        ...s,
        hero: i === heroSlot,
        t: 0,
        flight: Math.max(0.05, Math.hypot(s.x - caster.x, s.y - caster.y) / speed),
        sx: caster.x,
        sy: caster.y,
        landed: false,
      })),
    });
    // "Dispels all magic from the Blademaster" — straight off the Ubertip.
    this.dispelUnit(caster);
    caster.vanished = true; // off the field: hidden, untargetable, and it keeps him from
    // being attacked while the illusions are still in the air.
    this.stop(caster.id);
    if (def.specialArt) this.spellEffects.push({ art: def.specialArt, x: caster.x, y: caster.y, targetId: 0, z: 0 });
  }

  /** `count` free tiles to scatter the images (and the hero) across, nearest-fit around the
   *  caster so nobody lands in a cliff or a tree. Ordered randomly and spread over a ring,
   *  so the pattern differs every cast. */
  private mirrorSpots(caster: SimUnit, count: number): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    const n = caster.footprint || footprintCells(caster.radius);
    const start = this.rng() * Math.PI * 2; // random ring phase — never the same fan twice
    for (let i = 0; i < count; i++) {
      const ang = start + (i / count) * Math.PI * 2;
      const dist = 96 + this.rng() * 96;
      const wx = caster.x + Math.cos(ang) * dist;
      const wy = caster.y + Math.sin(ang) * dist;
      let spot = { x: wx, y: wy };
      if (this.grid) {
        const [cx, cy] = this.grid.worldToCell(wx, wy);
        const cell = this.grid.nearestFit(cx, cy, n, 14) ?? this.grid.nearestWalkable(cx, cy, 14);
        if (cell) {
          const [fx, fy] = this.grid.cellToWorld(cell[0], cell[1]);
          spot = { x: fx, y: fy };
        }
      }
      out.push(spot);
    }
    return out;
  }

  private tickMirrorImage(dt: number): void {
    for (let i = this.mirrorCasts.length - 1; i >= 0; i--) {
      const m = this.mirrorCasts[i];
      const caster = this.units.get(m.casterId);
      // The Blademaster died (or was removed) mid-shuffle: drop the whole thing rather than
      // leave illusions of a hero who isn't there.
      if (!caster || caster.hp <= 0) {
        if (caster) caster.vanished = false;
        this.mirrorCasts.splice(i, 1);
        continue;
      }
      if (!m.thrown) {
        m.delayLeft -= dt;
        if (m.delayLeft > 0) continue; // MirrorImageCaster is still playing
        m.thrown = true;
        for (const s of m.spots) {
          this.mirrorMissiles.push({ art: m.missileArt, sx: s.sx, sy: s.sy, tx: s.x, ty: s.y, flight: s.flight });
        }
        continue;
      }
      let all = true;
      for (const s of m.spots) {
        if (s.landed) continue;
        s.t += dt;
        if (s.t < s.flight) { all = false; continue; }
        s.landed = true;
        if (s.hero) {
          // The real one steps out of the missile that happened to draw the short straw.
          caster.vanished = false;
          this.teleportUnit(caster, s.x, s.y);
        } else {
          this.spawnIllusion(caster, s.x, s.y, m);
        }
      }
      if (all) this.mirrorCasts.splice(i, 1);
    }
  }

  /** The illusion request itself — an exact copy of the caster's own type, flagged so the
   *  sim knows it must not hurt anything and the renderer knows to tint it. */
  private spawnIllusion(caster: SimUnit, x: number, y: number, m: { duration: number; dealt: number; taken: number; abilityId: string; mana: number }): void {
    const def = this.abilities?.get(m.abilityId);
    this.summonRequests.push({
      unitId: caster.typeId,
      x,
      y,
      facing: caster.facing,
      owner: caster.owner,
      team: caster.team,
      summonLeft: m.duration,
      sourceId: caster.id,
      summonArt: "",
      // Each image lands on the exact spot its missile flew to (the real hero teleports to
      // one of them), so the spot is final — never a step further along the caster's facing.
      atPoint: true,
      // An image popping is BOmi's Specialart (MirrorImageDeathCaster) — its folder-mate
      // MirrorImageDeath.wav rides it as a model SND event (AnimLookups AOMI).
      unsummonArt: def?.buffSpecialArt ?? "",
      // An image is an exact copy, and that includes the name over its head and the level
      // in its bar. Spawning rolls a fresh proper name per hero and starts it at the unit
      // TYPE's level (1), so a level-5 Blademaster would have conjured three level-1 copies
      // wearing three different names — the enemy could pick the real one out of the pack
      // without swinging at it.
      illusion: {
        dealt: m.dealt,
        taken: m.taken,
        properName: caster.properName,
        mana: m.mana,
        level: caster.level,
        baseStr: caster.baseStr,
        baseAgi: caster.baseAgi,
        baseInt: caster.baseInt,
        baseMaxHp: caster.baseMaxHp,
        inventory: caster.inventory.map((it) => (it ? { itemId: it.itemId, charges: it.charges } : null)),
      },
    });
  }

  /** MirrorImageMissile models in flight, drained by the renderer (they are pure visuals —
   *  the sim already knows where and when each one lands). */
  private mirrorMissiles: Array<{ art: string; sx: number; sy: number; tx: number; ty: number; flight: number }> = [];

  drainMirrorMissiles(): Array<{ art: string; sx: number; sy: number; tx: number; ty: number; flight: number }> {
    const out = this.mirrorMissiles;
    this.mirrorMissiles = [];
    return out;
  }

  private addSpellFieldInternal(f: SpellFieldInit): void {
    // Capture the caster's team + the ability's Targets Allowed (targs1) NOW, so the
    // field keeps affecting the right allegiances even after the caster dies mid-channel.
    const caster = this.units.get(f.casterId);
    const team = caster?.team ?? 0;
    const ab = caster ? this.findAbility(caster, f.code) : undefined;
    const flags = (ab && this.abilities?.get(ab.id)?.targetFlags) ?? [];
    // timer counts down to the next wave; seeding it with `delay` (default 0) postpones the
    // FIRST wave without dropping any (Flame Strike's subsiding burn starts after the pillar).
    this.spellFields.push({ ...f, timer: f.delay ?? 0, done: 0, team, flags });
  }

  /** Would an area effect with `flags` (the ability's targs1), cast by unit `casterId`
   *  on `casterTeam`, affect `t`? Allegiance follows targs1 EXACTLY, so WC3 friendly
   *  fire works: Flame Strike lists `enemy,friend,self`, and Blizzard/Rain of Fire/
   *  Death&Decay list no allegiance at all — every one of them damages your own units
   *  too. Only a spell that lists `enemy` WITHOUT `friend`/`self` (Starfall, Stampede,
   *  Cluster Rockets, Locust Swarm) stays enemy-only. The `self` flag makes the CASTER
   *  a valid target too (Flame Strike has it, so it burns its own caster if he stands
   *  in the fire); without `self`, the caster is spared. Neutral-passive shops/critters
   *  are spared unless `neutral` is allowed. Shared by the damage tick and the green
   *  valid-target preview so the highlight always matches who actually gets hit. */
  areaEffectAffects(casterId: number, casterTeam: number, flags: string[], t: SimUnit): boolean {
    if (t.hp <= 0) return false;
    const F = new Set(flags.map((x) => x.toLowerCase()));
    if (t.neutralPassive) return F.has("neutral");
    const isSelf = t.id === casterId;
    const enemy = F.has("enemy");
    const friend = F.has("friend");
    const self = F.has("self");
    // No allegiance flag at all (Blizzard `_`, Death&Decay, Volcano's `notself`) → hit
    // everything in range except the caster (no `self` → the caster is spared).
    if (!(enemy || friend || self)) return !isSelf;
    if (isSelf) return self; // the caster is hit only when `self` is in targs1
    if (t.team === casterTeam) return friend; // own/allied (same team)
    return enemy; // different team
  }

  /** Ids of the units an area effect (`flags` = targs1) cast by `casterId`/`casterTeam`
   *  at (x,y,radius) would affect — the same set `tickSpellFields` damages. Drives the
   *  green valid-target preview (issue #20) so it matches reality, friendly fire and all. */
  areaEffectTargets(casterId: number, casterTeam: number, flags: string[], x: number, y: number, radius: number): number[] {
    const out: number[] = [];
    for (const t of this.unitsInAreaInternal(x, y, radius)) {
      if (this.areaEffectAffects(casterId, casterTeam, flags, t)) out.push(t.id);
    }
    return out;
  }

  private tickSpellFields(dt: number): void {
    for (let i = this.spellFields.length - 1; i >= 0; i--) {
      const f = this.spellFields[i];
      // A channelled field (Blizzard, Rain of Fire, Starfall, …) stops the instant
      // its caster is INTERRUPTED — re-tasked away from "cast" while channel time
      // remained, killed, or moved on to another cast — matching WC3. A channel that
      // ENDED normally (channelLeft reached 0) leaves the field to exhaust its own
      // final wave on schedule, so no tick is dropped. Fields from fire-and-forget
      // spells (Flame Strike, Volcano, Bladestorm) aren't in CHANNELED and run their
      // full course independently of the caster.
      if (CHANNELED.has(f.code)) {
        const caster = this.units.get(f.casterId);
        const pc = caster?.pendingCast;
        const interrupted = !caster || !pc || pc.code !== f.code || (caster.order !== "cast" && pc.channelLeft > 0);
        if (interrupted) {
          this.spellFields.splice(i, 1);
          continue;
        }
      }
      f.timer -= dt;
      if (f.timer <= 0) {
        f.timer = f.interval;
        f.done++;
        // The wave's damage lands when the wave does. A field with `impactDelay`
        // (Blizzard, Rain of Fire) throws its shards now and hurts on impact, 0.8s
        // later; every other field (Flame Strike's burn, Starfall, …) has no falling
        // art and detonates immediately.
        const impact = {
          t: f.impactDelay ?? 0,
          x: f.x,
          y: f.y,
          area: f.area,
          damage: f.damagePerWave,
          casterId: f.casterId,
          team: f.team,
          flags: f.flags,
          maxDamage: f.maxDamagePerWave ?? 0,
          buildingReduction: f.buildingReduction ?? 0,
          dot: f.dot,
        };
        if (impact.t > 0) this.waveImpacts.push(impact);
        else this.landWave(impact);
        // Scatter the wave effect over the area (WC3 drops the ice shards across the
        // whole circle each wave, not just the centre). `artPerWave` copies land per
        // wave — Blizzard rains a cluster of 6, most fields just one. Each shard gets
        // its own sqrt-weighted radius so hits spread evenly over the disc, and the
        // angles are spaced one-per-sector (with jitter inside the sector) so a wave
        // never bunches all six shards on one side of the circle.
        if (f.art) {
          const n = f.artPerWave ?? 1;
          const base = this.rng() * Math.PI * 2;
          for (let s = 0; s < n; s++) {
            const ang = base + ((s + this.rng()) * Math.PI * 2) / n;
            const r = f.area * Math.sqrt(this.rng());
            // `sound` cues the art's folder WAV — ONCE per wave (on the first shard),
            // not once per shard: six overlapping 3s BlizzardTarget clips a second
            // would be a wall of noise, where WC3 gives one shard-fall per wave.
            this.spellEffects.push({ art: f.art, x: f.x + Math.cos(ang) * r, y: f.y + Math.sin(ang) * r, targetId: 0, z: 0, sound: f.waveSound && s === 0 });
          }
        }
      }
      if (f.done >= f.waves) this.spellFields.splice(i, 1);
    }
    // Waves in flight: hurt whatever is standing there WHEN THEY LAND, not where the
    // targets were when the wave was thrown — so stepping out of the circle works.
    for (let i = this.waveImpacts.length - 1; i >= 0; i--) {
      const w = this.waveImpacts[i];
      w.t -= dt;
      if (w.t > 0) continue;
      this.waveImpacts.splice(i, 1);
      this.landWave(w);
    }
  }

  /** One wave of a repeating area field hitting the ground. */
  private landWave(w: (typeof this.waveImpacts)[number]): void {
    // Hit whoever the ability's targs1 allows — enemy-only for Starfall/Stampede,
    // but everyone (incl. your own units) for Flame Strike/Blizzard/Death&Decay.
    const hit = this.unitsInAreaInternal(w.x, w.y, w.area).filter((t) => this.areaEffectAffects(w.casterId, w.team, w.flags, t));
    // "Maximum Damage per Wave" (DataF): a wave has a damage BUDGET, not just a
    // per-unit figure. Blizzard's 30-per-wave with a 150 cap hits five units for full
    // and ten for 15 each — the classic WC3 AoE cap that stops a channelled nuke from
    // scaling forever with the size of the clump it lands on.
    const each = w.maxDamage > 0 && hit.length * w.damage > w.maxDamage ? w.maxDamage / hit.length : w.damage;
    for (const t of hit) {
      // "Building Reduction" (DataD): structures shrug off this fraction of the wave.
      const dmg = t.building ? each * (1 - w.buildingReduction) : each;
      if (dmg > 0) this.landDamage(t, dmg, w.casterId, false); // spell damage: ignore armor
      // Rain of Fire's burn: every wave (re)lights whatever it hits for DataE dps.
      if (w.dot && w.dot.dps > 0 && !t.building) {
        this.applyBuffInternal(t, { kind: "dot", group: w.dot.group, timeLeft: t.isHero && w.dot.heroDuration > 0 ? w.dot.heroDuration : w.dot.duration, sourceId: w.casterId, value: w.dot.dps, art: w.dot.art });
      }
    }
    // Burn down trees too when the ability lists `tree` in Targets Allowed
    // (Flame Strike's targs1 = ground,enemy,neutral,friend,structure,self,tree,debris —
    // MPQ AHfs). Each wave deals damagePerWave to a tree's HP; a standard 50-HP tree
    // falls after ~4 waves of L1 (15/wave), leaving a hole in the forest as in WC3.
    if (w.flags.includes("tree")) this.damageTreesInArea(w.x, w.y, w.area, w.damage);
  }

  /** Apply `dmg` to the HP of every tree within `radius`; fell any that hit 0. Felled
   *  trees go through the same `felled` queue as harvest-felling, so the renderer
   *  unstamps their pathing, hides the model, and clears the sight blocker. */
  private damageTreesInArea(x: number, y: number, radius: number, dmg: number): void {
    let fell: SimTree[] | null = null;
    for (const t of this.trees.values()) {
      if (Math.hypot(t.x - x, t.y - y) > radius) continue;
      t.hp -= dmg;
      if (t.hp <= 0) (fell ??= []).push(t);
    }
    if (!fell) return;
    for (const t of fell) {
      this.trees.delete(t.id);
      this.felled.push(t);
    }
  }

  // === corpses ==============================================================

  /** Leave a corpse for an organic, ground, non-mechanical unit (Liquipedia:
   *  Corpse). Buildings collapse, mechanical units explode, summons vanish, and
   *  air units crash without leaving a raisable ground corpse — none of them do. */
  private spawnCorpse(u: SimUnit): void {
    // A summon (isSummon) leaves no corpse even after its timer hits 0 at expiry.
    // Neutral Passive *buildings* (shops/fountains) are caught by `u.building`; their
    // mobile kin — critters — are organic and DO leave a decaying corpse (raiseable by
    // Raise Dead, edible by Cannibalize), just like any other ground unit (issue #39).
    if (u.building || u.mechanical || u.isSummon || u.flying) return;
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
      // A raised corpse stands back up where it fell, not a step in front of the caster.
      this.summonRequests.push({ unitId: c.unitId, x: c.x, y: c.y, facing: c.facing, owner, team, summonLeft: 0, sourceId: 0, summonArt: "", unsummonArt: "", atPoint: true });
      raised++;
    }
    return raised;
  }

  /** Eat the nearest corpse within `radius` (Cannibalize). Reuses the same `raised` flag
   *  raising does — from the corpse's point of view being eaten and being raised are the
   *  same fate, and the renderer already hides a corpse the moment it is set. Nearest
   *  first, so a Ghoul standing between two bodies takes the one it is on. */
  consumeCorpseInternal(x: number, y: number, radius: number): boolean {
    let best: SimCorpse | undefined;
    let bestDist = Infinity;
    for (const c of this.corpses.values()) {
      if (c.raised || c.mechanical) continue; // a mechanical wreck is not a meal
      const dist = Math.hypot(c.x - x, c.y - y);
      if (dist > radius || dist >= bestDist) continue;
      best = c;
      bestDist = dist;
    }
    if (!best) return false;
    best.raised = true;
    return true;
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
    // Untyped ability damage ignores armor; a Banished (ethereal) target takes +66%
    // (ETHEREAL_SPELL_BONUS — the file's Spells column), the flip side of its physical
    // immunity (issue #49).
    // Magic Immunity stops spell damage as well as spell targeting — that is what makes a
    // Dryad walk through a Blizzard. It belongs on this seam and not in landDamage, because
    // landDamage is also the ATTACK path and a magic-immune unit is hit by weapons normally.
    spellDamage: (t, amount, src) =>
      t.magicImmune ? 0 : this.landDamage(t, t.ethereal ? amount * ETHEREAL_SPELL_BONUS : amount, src, false),
    spellHeal: (t, amount) => {
      t.hp = Math.min(t.maxHp, t.hp + amount);
    },
    applyBuff: (t, buff) => this.applyBuffInternal(t, buff),
    dispel: (t) => this.dispelUnit(t),
    requestSummon: (unitId, x, y, facing, owner, team, dur, src, art, atPoint) => {
      this.summonRequests.push({ unitId, x, y, facing, owner, team, summonLeft: dur, sourceId: src, summonArt: art?.summon ?? "", unsummonArt: art?.unsummon ?? "", atPoint: !!atPoint });
    },
    raiseNearbyCorpses: (x, y, r, owner, team, max) => this.raiseNearbyCorpsesInternal(x, y, r, owner, team, max),
    consumeCorpse: (x, y, r) => this.consumeCorpseInternal(x, y, r),
    linkSpirits: (unit, group, durationSec, share) => {
      unit.linkGroup = [...group];
      unit.linkT = durationSec;
      unit.linkShare = share;
    },
    devour: (kodo, prey) => this.devourInternal(kodo, prey),
    toggleSpiritForm: (unit) => this.toggleSpiritForm(unit),
    isDay: () => this.isDay,
    holdPosition: (unit) => { this.issueHold(unit.id); },
    toggleRoot: (unit) => this.toggleRoot(unit),
    morphToggle: (unit, def) => this.morphToggle(unit, def),
    dismissSummons: (owner, typeIds) => {
      const set = new Set(typeIds);
      for (const u of [...this.units.values()]) {
        if (u.owner === owner && u.isSummon && u.hp > 0 && set.has(u.typeId)) this.unsummon(u);
      }
    },
    emitEffect: (art, x, y, targetId, life) => {
      if (art) this.spellEffects.push({ art, x, y, targetId, z: 0, life });
    },
    emitSplat: (splatId, x, y) => {
      if (splatId) this.spellSplats.push({ splatId, x, y });
    },
    addSpellField: (f) => this.addSpellFieldInternal(f),
    burnMana: (t, amount) => {
      const burned = Math.min(t.mana, Math.max(0, amount));
      t.mana -= burned;
      return burned;
    },
    teleport: (u, x, y) => this.teleportUnit(u, x, y),
    mirrorImage: (caster, def, rank) => this.startMirrorImage(caster, def, rank),
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

  // === Way Gates (7.22 — issue #33) ========================================
  //
  // A Way Gate is a plain unit ('nwgt', Neutral Passive) whose behaviour is entirely
  // script-driven: `WaygateSetDestination` points it somewhere, `WaygateActivate`
  // switches it on, and anything that walks into it comes out the far end. Seven of the
  // eleven maps that use one are ordinary MELEE maps (CentaurGrove, WindyWaste, Riverrun,
  // Plaguelands, IceCrown, MysticIsles, Venetia) — the gate is a map feature, not a
  // custom-map gadget, and its pair of gates is set up inside `CreateAllUnits()`.
  //
  // The trigger volume is NOT a guess: the Way Gate carries ability `Awrp` (UnitAbilities
  // .slk `abilList=Awrp,Avul`), and Awrp's DataA1/DataB1 are 400/400 — which
  // AbilityMetaData.slk + WorldEditStrings.txt name **"Teleport Area Width"** and
  // **"Teleport Area Height"**. So the gate is a 400×400 world-unit BOX centred on the
  // building, not a circle.

  /** `Awrp` DataA1/DataB1 (Units\AbilityData.slk) — the Way Gate's teleport area, in
   *  world units. Half-extents, since the box is centred on the gate. */
  private static readonly WAYGATE_HALF_W = 400 / 2;
  private static readonly WAYGATE_HALF_H = 400 / 2;

  /** A gate teleports a unit that **ENTERS** its box — the rising edge — not one that
   *  merely stands in it. That distinction is the whole behaviour, and getting it wrong is
   *  not subtle: a gate's destination is its PARTNER gate, so a unit spat out at the far
   *  end lands inside the partner's box. Fire on occupancy and the partner immediately
   *  throws it back, the first gate throws it forward again, and the traveller ping-pongs
   *  between the two forever (measured live on (4)CentaurGrove — the footman bounced
   *  SW↔NE every tick and never arrived).
   *
   *  So each gate keeps the set of units already inside it, exactly as the enter-region
   *  pump keeps its baseline (7.4b): a unit deposited inside a gate is seeded as
   *  already-there and is only teleported once it leaves and walks back in. Runs after
   *  movement, so a unit ordered onto a gate crosses the instant it arrives. */
  private tickWaygates(): void {
    let gates: SimUnit[] | null = null;
    for (const g of this.units.values()) {
      if (!g.waygate?.active) continue;
      (gates ??= []).push(g);
    }
    if (!gates) return; // the overwhelmingly common case: no gates on this map

    // 1. Who has just ENTERED each gate (in its box now, wasn't last tick)?
    const moved = new Set<number>();
    for (const g of gates) {
      for (const u of this.units.values()) {
        if (!this.inWaygate(u, g) || g.waygate!.inside.has(u.id)) continue;
        if (moved.has(u.id)) continue; // one gate per unit per tick
        this.teleportUnit(u, g.waygate!.destX, g.waygate!.destY);
        moved.add(u.id);
      }
    }
    // 2. Re-baseline every gate from the FINAL positions. This is what seeds an arriving
    //    unit into the destination gate's `inside` set, so that gate does not fire on it.
    for (const g of gates) {
      const inside = g.waygate!.inside;
      inside.clear();
      for (const u of this.units.values()) if (this.inWaygate(u, g)) inside.add(u.id);
    }
  }

  /** Is `u` standing in gate `g`'s teleport box? A gate never swallows itself, another
   *  structure, or a neutral-passive prop. */
  private inWaygate(u: SimUnit, g: SimUnit): boolean {
    if (u === g || u.building || u.neutralPassive) return false;
    return (
      Math.abs(u.x - g.x) <= SimWorld.WAYGATE_HALF_W &&
      Math.abs(u.y - g.y) <= SimWorld.WAYGATE_HALF_H
    );
  }

  /** JASS WaygateSetDestination / WaygateActivate — configure a gate. Both natives
   *  work on a unit that isn't a Way Gate (WC3 lets you make anything a gate), so we
   *  don't gate on the type; a unit with no `waygate` record simply isn't one yet.
   *  Reconfiguring keeps the occupancy baseline — retargeting a gate must not make it
   *  re-fire on whoever happens to be standing in it. */
  private waygateOf(id: number): WaygateState | null {
    const u = this.units.get(id);
    if (!u) return null;
    return (u.waygate ??= { destX: 0, destY: 0, active: false, inside: new Set() });
  }
  setWaygateDestination(id: number, x: number, y: number): void {
    const w = this.waygateOf(id);
    if (!w) return;
    w.destX = x;
    w.destY = y;
  }
  waygateActivate(id: number, active: boolean): void {
    const g = this.units.get(id);
    const w = this.waygateOf(id);
    if (!g || !w) return;
    // Switching a gate ON seeds its occupancy baseline from whoever is already standing
    // in it, so it does not fire on them — a unit inside at activation has not *entered*.
    // Same silent-baseline rule the enter-region pump uses when a trigger is registered.
    if (active && !w.active) {
      w.inside.clear();
      for (const u of this.units.values()) if (this.inWaygate(u, g)) w.inside.add(u.id);
    }
    w.active = active;
  }
  /** WaygateGetDestinationX/Y — 0 on a unit that is not a gate, as the engine reports. */
  waygateDestination(id: number): { x: number; y: number } | null {
    const w = this.units.get(id)?.waygate;
    return w ? { x: w.destX, y: w.destY } : null;
  }
  waygateIsActive(id: number): boolean {
    return this.units.get(id)?.waygate?.active === true;
  }

  // === JASS trigger effects (Phase 7 — issue #33; see docs/triggers.md) ======
  // Small, public entry points the interpreter's EngineHooks bridge calls to mutate
  // a unit from a trigger action (SetUnitPosition/Facing/Owner/MoveSpeed/…). The
  // render-only properties (scale, vertex colour, fly height) live on RtsController.

  /** JASS SetUnitPosition / SetUnitX / SetUnitY — teleport with pathing re-settle. */
  setUnitPosition(id: number, x: number, y: number): void {
    const u = this.units.get(id);
    if (u) this.teleportUnit(u, x, y);
  }
  /** JASS SetUnitFacing[Timed] — instant sets both facing + target so it doesn't turn
   *  back; timed sets only the target so it rotates there at the unit's turn rate. */
  setUnitFacing(id: number, rad: number, instant: boolean): void {
    const u = this.units.get(id);
    if (!u) return;
    u.desiredFacing = rad;
    if (instant) u.facing = rad;
  }
  /** JASS SetUnitOwner — reassign owner + team (team decides allegiance/vision). */
  setUnitOwner(id: number, owner: number, team: number): void {
    const u = this.units.get(id);
    if (u) {
      u.owner = owner;
      u.team = team;
    }
  }
  /** JASS SetUnitMoveSpeed — the current move speed (buffs recompute from baseSpeed,
   *  so set the base too or a slow/haste tick would immediately overwrite it). */
  setUnitMoveSpeed(id: number, speed: number): void {
    const u = this.units.get(id);
    if (u) u.speed = u.baseSpeed = speed;
  }
  /** JASS SetUnitTurnSpeed — same 0..1 scale as UnitData `turnRate`. */
  setUnitTurnSpeed(id: number, turn: number): void {
    const u = this.units.get(id);
    if (u) u.turnRate = turn;
  }
  /** JASS SetUnitFlyHeight — the sim altitude (missiles launch/land here); the render
   *  lift is kept in step by RtsController.setUnitFlyHeight. */
  setUnitFlyHeight(id: number, height: number): void {
    const u = this.units.get(id);
    if (u) u.flyHeight = height;
  }
  /** JASS PauseUnit — freeze/unfreeze; halts movement immediately on pause. */
  pauseUnit(id: number, flag: boolean): void {
    const u = this.units.get(id);
    if (u) {
      u.paused = flag;
      if (flag) u.moving = false;
    }
  }
  isUnitPaused(id: number): boolean {
    return this.units.get(id)?.paused ?? false;
  }
  // Live reads for the Get* natives (a script-created unit's JASS handle otherwise
  // keeps its spawn-time position/facing — the sim value is the current one).
  //
  // **undefined, never 0, for a unit that is gone.** These answer the JASS natives through
  // liveNum (natives/world.ts), whose contract is "the live sim value, or the handle's
  // last-known field when there is none" — and it can only tell the two apart by
  // `undefined`. A dead unit is deleted from `units` inside kill(), one tick BEFORE the
  // death event it queued is pumped, so every GetUnitX a death trigger makes is a read of a
  // unit that no longer exists. Answering 0 there put the map origin into the hands of
  // Blizzard.j's UnitDropItem — every creep in the game dropped its loot in one pile in the
  // corner of the map, which is what "creep drops stopped working" turned out to be.
  getUnitX(id: number): number | undefined {
    return this.units.get(id)?.x;
  }
  getUnitY(id: number): number | undefined {
    return this.units.get(id)?.y;
  }
  getUnitFacing(id: number): number | undefined {
    return this.units.get(id)?.facing;
  }
  getUnitMoveSpeed(id: number): number | undefined {
    return this.units.get(id)?.speed;
  }
  getUnitFlyHeight(id: number): number | undefined {
    return this.units.get(id)?.flyHeight;
  }

  // === drains (renderer pulls these each frame) =============================

  /** Repeating area fields running RIGHT NOW (Blizzard, Rain of Fire, …). Unlike the
   *  drain* channels this is a live view, not a one-shot queue: the renderer polls it
   *  each frame to sustain a channel's looping bed and to stop it the moment the field
   *  ends — whether it exhausted its waves or the caster was interrupted. */
  activeSpellFields(): Array<{ code: string; x: number; y: number }> {
    return this.spellFields.map((f) => ({ code: f.code, x: f.x, y: f.y }));
  }

  /** Play a one-shot effect model at a point. For the spawn paths the renderer owns:
   *  a summon's burst belongs on the tile the renderer finally placed it on, which the
   *  sim never sees (see drainSummonRequests). Spell handlers use SpellApi.emitEffect. */
  emitEffectAt(art: string, x: number, y: number, sound = false): void {
    if (art) this.spellEffects.push({ art, x, y, targetId: 0, z: 0, sound });
  }

  /** Spell/effect models to play this frame (targetId>0 = follow that unit). */
  drainSpellEffects(): Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean }> {
    if (!this.spellEffects.length) return this.spellEffects;
    const out = this.spellEffects;
    this.spellEffects = [];
    return out;
  }
  /** Ground decals a spell asked for this frame (UberSplatData row id + centre). */
  drainSpellSplats(): Array<{ splatId: string; x: number; y: number }> {
    if (!this.spellSplats.length) return this.spellSplats;
    const out = this.spellSplats;
    this.spellSplats = [];
    return out;
  }
  /** Casts that began this frame (renderer plays the cast animation). */
  drainCastStarts(): Array<{ casterId: number; code: string; abilityId: string; hold: number; loop: boolean; tx: number; ty: number; targetId: number; warnArt: string }> {
    if (!this.castStarts.length) return this.castStarts;
    const out = this.castStarts;
    this.castStarts = [];
    return out;
  }
  /** Casts whose effect FIRED this frame (renderer plays the ability's cast sound). */
  drainCastFires(): Array<{ casterId: number; code: string; abilityId: string }> {
    if (!this.castFires.length) return this.castFires;
    const out = this.castFires;
    this.castFires = [];
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
  drainSummonRequests(): SummonRequest[] {
    if (!this.summonRequests.length) return this.summonRequests;
    const out = this.summonRequests;
    this.summonRequests = [];
    return out;
  }

  tick(dt: number): void {
    this.elapsed += dt;
    if (this.dawnDusk) this.timeOfDay = (this.timeOfDay + dt * GAME_HOURS_PER_SEC) % MISC_DATA.DayHours;
    // The tech census (who owns what, and so what each player may build) is invalidated
    // wholesale each tick rather than at every birth/death/morph/construction-finish. The
    // rebuild is a single O(units) pass and only happens if something actually asks — but
    // a *missed* invalidation site would leave a player's requirements silently stale,
    // which is a far nastier bug than one cheap pass.
    this.tech?.invalidate();
    this.tickAttackReveals(dt);
    this.tickBuildings(dt);
    this.tickShops(dt);
    this.tickShopBuyers(); // adopt a purchaser for whoever has just walked one up to a shop
    this.applyAuras(); // refresh aura buffs on in-range allies (before recompute)
    for (const u of this.units.values()) {
      if (this.tickBuffs(u, dt)) continue; // decay timed effects (a DoT may kill)
      this.tickMeld(u); // Shadow Meld holds only while the unit is still and the sun is down
      this.recomputeStats(u); // derive armour/speed/damage/regen/stun/invuln
      this.tickRegen(u, dt); // mana + (hero) hp regeneration
      if (u.cooldownLeft > 0) u.cooldownLeft -= dt;
      if (u.linkT > 0 && (u.linkT -= dt) <= 0) u.linkGroup = []; // Spirit Link expired
      if (u.repathT > 0) u.repathT -= dt;
      for (const a of u.abilities) if (a.cooldownLeft > 0) a.cooldownLeft -= dt;
      for (const it of u.inventory) if (it && it.cooldownLeft > 0) it.cooldownLeft -= dt;
      if (u.summonLeft > 0) {
        u.summonLeft -= dt;
        if (u.summonLeft <= 0) {
          // Its time is up. A summon whose data declares an unsummon effect LEAVES via it
          // (a Feral Spirit wolf is replaced by feralspiritdone, it is not slain); one that
          // declares none has no other way to go than to die, which is what a Water
          // Elemental does — BHwe carries no Effectart and the elemental splashes.
          if (u.unsummonArt) this.unsummon(u);
          else this.kill(u);
          continue;
        }
      }
      u.prevX = u.x;
      u.prevY = u.y;
      if (u.paused) continue; // PauseUnit: no orders/movement/turning until unpaused
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
          this.tickAttack(u, dt);
          break;
        case "cast":
          this.tickCast(u, dt); // walk into range, then fire the spell effect
          break;
        case "getitem":
          this.tickGetItem(u); // walk to a ground item / another hero, then pick up / hand over
          break;
        case "garrison":
          this.tickGarrison(u); // walk to the Orc Burrow, then climb inside
          break;
        case "follow":
          this.tickFollow(u, dt); // trail the leader; guard it against nearby enemies once caught up
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
        case "hold":
          this.tickHold(u, dt); // attack enemies in range, but never chase
          break;
        case "idle":
          // Autocast (toggled-on Heal/Slow/…) gets first refusal, then auto-attack.
          if (!this.tickAutocast(u)) this.tickAcquire(u, dt);
          break;
      }
    }
    this.tickMovement(dt);
    this.resolveCollisions();
    this.tickWaygates(); // anything now standing in a gate's box comes out the far end
    this.resolveAirSeparation(dt);
    this.tickProjectiles(dt);
    this.tickSpellFields(dt); // Blizzard-style repeating area effects
    this.tickMirrorImage(dt); // Mirror Image's caster effect -> missiles -> illusions
    this.tickLightningShields(dt); // Lightning Shield: damage units around each shielded unit
    this.tickWards(dt); // Witch Doctor Healing Ward heal + Stasis Trap proximity stun
    this.tickDevour(dt); // Kodo digests any swallowed unit
    this.tickCorpses(dt); // decay flesh→bone→gone
    for (const u of this.units.values()) {
      // Turning runs every tick, independent of movement: a unit that arrived
      // (or stands attacking) still finishes rotating to its desired heading.
      if (u.facing !== u.desiredFacing && !u.paused) {
        u.facing = turnToward(u.facing, u.desiredFacing, turnSpeed(u.turnRate) * dt);
      }
      this.tickSwing(u, dt); // land pending strikes at their damage point
      // Any walking (only possible after the damage point — the wind-up holds
      // position) breaks the attack animation: the unit move-canceled its backswing,
      // so its attack clip must not resume until the next real swing (which clears
      // this). Runs AFTER tickMovement so u.moving reflects this tick's actual walking.
      if (u.moving) u.swingBroken = true;
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
      // Attack-order approach is owned by the combat-approach watchdog in tickAttack
      // (issue #24), which measures net progress toward the target over its own window
      // and re-decides — repath if reachable, else switch to the nearest reachable
      // target. Don't also handle it here: the two would fight over the same unit with
      // different timers. (Falling through to the generic handler below would call
      // stop(), which wrongly drops the attack target.)
      u.stuckRetries = 0;
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
    const [tx, ty] = [u.chaseX, u.chaseY];
    // Already about as close to the destination as the crowd allows (within a body or
    // two): don't keep shoving through the units parked on the goal cell — just stop.
    // This kills the "wobble at the destination" where a move order aims onto a spot
    // other units occupy and the mover vibrates against them (issue #24). Only for
    // plain move/patrol — attack/attackmove/harvest handle their own arrival above.
    if ((u.order === "move" || u.order === "patrol") && Math.hypot(tx - u.x, ty - u.y) <= PATHING_CELL * 2) {
      this.stop(u.id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
      return;
    }
    // Blocked/orbiting: the blockers may have stopped since the original path
    // was computed — repath around them. A unit that stays stuck (boxed in)
    // stands down after a couple of attempts and just faces where it was
    // ordered — WC3 units never squeeze through crowds.
    if (++u.stuckRetries > 1 || !this.pathTo(u, tx, ty)) {
      this.stop(u.id);
      u.desiredFacing = Math.atan2(ty - u.y, tx - u.x);
    }
  }

  // --- combat -------------------------------------------------------------

  /** On a harvest round-trip: walking out to the node, working it, or hauling the
   *  load back to a depot. A worker mid-trip keeps working — it doesn't look up from
   *  the tree to fight (issue #41). This is what keeps the Ghoul, which is NOT
   *  Peon-classified and so fights like a soldier when it has nothing better to do,
   *  from abandoning the lumber line the moment a skirmish breaks out beside it. */
  private harvesting(u: SimUnit): boolean {
    return !!u.worker && (u.order === "harvest" || u.order === "return");
  }

  /** How far this unit will auto-acquire a target: the weapon's acquisition range
   *  (UnitWeapons.slk `acquire`), or a creep's own aggro range (its map-placed
   *  targetAcquisition). Zero — never auto-acquires — for a worker: always for the
   *  Peon-classified ones, and while on a harvest trip for anything else that
   *  harvests (the Ghoul). 0 here keeps them out of every automatic path: idle
   *  scans, assist, attack-move, post-kill re-acquire, and the switch to a reachable
   *  enemy. An explicit attack order goes through issueAttack and doesn't consult
   *  this, so you can always pull a worker off the line and into a fight. */
  private acquireRange(u: SimUnit): number {
    // An invisible unit doesn't pick its own fights, for the same reason a worker doesn't:
    // 0 here keeps it out of every automatic path. Nothing states this outright — it is
    // read off what invisibility is FOR. classic.battle.net's rule is that invisible units
    // "reveal themselves if they DO anything but move or stop", and an auto-attack is not
    // the player doing anything; if it counted, a Blademaster could never wind walk out of
    // a fight (he would turn round and re-reveal on the nearest enemy) and Invisibility
    // could never walk a unit past anyone. An explicit attack order still goes through
    // issueAttack, which never consults this — so you can always choose to strike, and
    // that strike is what reveals you. Gated on `cloaked`, not `invisible`, so the 0.6s
    // Transition Time isn't a window in which he auto-attacks his own wind-up away.
    if (u.cloaked) return 0;
    if (u.isPeon || this.harvesting(u)) return 0;
    if (u.isCreep) return u.aggroRange;
    return u.weapon ? u.weapon.acquire : 0;
  }

  private tickAttack(u: SimUnit, dt: number): void {
    // Banished mid-fight (issue #49): an ethereal unit can't attack — drop the order
    // and stand down rather than chase a target it can never hit.
    if (u.ethereal) {
      this.cancelSwing(u);
      this.stop(u.id);
      return;
    }
    let t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    // No target, no weapon, or nothing in hand that can strike THIS target (a Flying Machine
    // whose Bombs were never researched, ordered onto a Footman): don't just stand down — a
    // group that kills its target immediately rolls onto the next hostile still in range,
    // instead of waiting out an idle-scan tick (issue #24 — "especially ranged units" that
    // out-range a fleeing/dying target and were left standing around).
    let w = t ? this.weaponVs(u, t) : null;
    if (!t || !w) {
      this.reacquireOrStop(u);
      return;
    }
    // It vanished mid-fight: lose it. This is the other half of canSee's no-aggro rule — that
    // one stops an invisible unit being PICKED as a target, this one stops an attacker who
    // already had it from following it into the fade. Without it, wind walking out of a fight
    // wouldn't shake anyone: they'd keep swinging at a hero they can no longer see. The
    // re-acquire it falls into can't pick the same unit back up (canSee refuses it), so the
    // attacker rolls onto another enemy or stands down.
    if (t.invisible) {
      this.reacquireOrStop(u);
      return;
    }
    // Holding after giving up on an unreachable target (issue #24): stand completely
    // still — do NOT chase — so a boxed-in unit doesn't take a shoved-back probing step
    // every cooldown (the residual micro-wobble). While committed (repathT ticking) we
    // just hold and face; when the cooldown lapses we re-evaluate with a PURE A* check
    // (no movement): target now in reach or reachable again → drop the hold and fight;
    // a different target reachable → switch; still walled in → re-arm the hold.
    if (u.gaveUp) {
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      const band = w.ranged ? w.range : w.range + ATTACK_LEASH;
      if (gap <= band) {
        u.gaveUp = false; // it wandered into reach — fight
      } else if (Math.abs(gap - u.gaveUpGap) > ATTACK_LEASH) {
        // The target moved relative to us since we settled to wait — the fight has
        // shifted, so drop the hold and re-evaluate fresh (don't sit out a stale wait).
        u.gaveUp = false;
        u.attackStalls = 0;
      } else if (u.repathT > 0) {
        this.settle(u); // de-conflicting combat settle: queue onto our own tile, no stacking
        u.inCombat = false;
        u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
        return;
      } else if (this.canReachToAttack(u, t)) {
        u.gaveUp = false; // a blocker cleared — resume the chase (falls through to engage)
      } else {
        const range = this.acquireRange(u);
        const next = range > 0 ? this.reachableEnemy(u, range, t.id) : null;
        if (next) {
          this.issueAttack(u.id, next.id);
          return;
        }
        this.settle(u); // de-conflicting combat settle: queue onto our own tile, no stacking
        u.inCombat = false;
        u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
        u.repathT = ATTACK_GIVEUP_COOLDOWN; // keep holding — re-check again later
        return;
      }
    }
    // If we're chasing a far / walled-off target while a DIFFERENT enemy is ALREADY within
    // striking range, hit the one that's right here — a melee unit must never walk past an
    // enemy it can reach toward one it can't (issue #24: "won't fight even though it can
    // reach the enemy, especially after the first kill"). Only when we're not already
    // engaged and our current target isn't itself in reach. Cheap distance scan, filtered
    // like auto-acquire (visible, no idle creep camp); the switch resets the watchdog so
    // the rest of this tick runs against the new, in-range target. A worker keeps the
    // target it was ordered onto — it never picks up a fight of its own (issue #41).
    if (!u.inCombat && !u.isPeon) {
      u.acquireT -= dt; // throttle the scan to ~5x/sec (not every tick — it's an O(units) scan)
      if (u.acquireT <= 0) {
        u.acquireT = 0.2;
        const strike = w.ranged ? w.range : w.range + ATTACK_LEASH;
        const curGap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
        if (curGap > strike) {
          const near = this.acquireTarget(u, strike);
          if (near && near.id !== t.id) {
            this.issueAttack(u.id, near.id);
            t = near;
            w = this.weaponVs(u, t) ?? w; // the new target may want the other slot
          }
        }
      }
    }
    this.engage(u, t);
    // Combat-approach watchdog (issue #24). Reset the moment we're within the strike
    // band (range + leash) — genuinely fighting — rather than on engage()'s inCombat
    // flag, which a unit wobbling right at the range edge flips on/off every tick,
    // perpetually zeroing the timer. Otherwise measure headway toward the target two
    // ways: net ground covered, and how much the gap shrank. Either clears it; a
    // wobbler blocked by other bodies does neither, so it re-decides.
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    // Reset iff engage() counted us "in range" this tick (didn't chase) — same band it
    // uses: melee attack from within the strike leash, ranged only once actually in
    // range (leash is just their re-chase hysteresis).
    const band = w.ranged ? (u.inCombat ? w.range + ATTACK_LEASH : w.range) : w.range + ATTACK_LEASH;
    if (gap <= band) {
      u.stallT = 0;
      u.attackStalls = 0; // in the fight — clear the stall streak
      return;
    }
    // Committed to standing after giving up (or briefly cooling down after a block):
    // don't re-probe — engage() is already holding position while repathT ticks down.
    if (u.repathT > 0) {
      u.stallT = 0;
      return;
    }
    if (u.stallT === 0) {
      u.stallAnchorX = u.x;
      u.stallAnchorY = u.y;
      u.stallGap = gap;
    }
    u.stallT += dt;
    if (u.stallT < ATTACK_STALL_TIME) return;
    const moved = Math.hypot(u.x - u.stallAnchorX, u.y - u.stallAnchorY);
    const closed = u.stallGap - gap;
    u.stallT = 0;
    if (moved >= ATTACK_PROGRESS || closed >= ATTACK_PROGRESS) {
      u.attackStalls = 0; // real headway — keep chasing
      return;
    }
    // No headway this window. redecideAttack repaths/switches while it still looks
    // reachable; but if we keep stalling anyway (A* threads the surround's gaps, collision
    // blocks the last stretch — the outer-ring jitter), stop trusting it and HOLD.
    u.attackStalls++;
    if (u.attackStalls >= 2) {
      // Before standing down, make sure there isn't ANOTHER enemy we can actually reach
      // and fight instead — a unit must never stand idle beside an enemy it could attack
      // just because its ORIGINAL target is walled off (issue #24: "the nearest enemy must
      // always be attacked"). Only hold when nothing reachable remains.
      const range = this.acquireRange(u);
      const next = range > 0 ? this.reachableEnemy(u, range, t.id) : null;
      if (next) this.issueAttack(u.id, next.id);
      else this.holdAttack(u, t);
    } else {
      this.redecideAttack(u, t);
    }
  }

  /** Stop chasing and hold position facing the target — used when an attacker keeps
   *  failing to close despite the target looking reachable (see ATTACK_HOLD_MAX). The
   *  hold cooldown grows with the stall streak so a permanently blocked unit stands
   *  progressively stiller; tickAttack's gaveUp branch owns the wait and the exit. */
  private holdAttack(u: SimUnit, t: SimUnit): void {
    this.settle(u); // de-conflicting combat settle: queue onto our own tile, no stacking
    u.gaveUp = true;
    u.inCombat = false;
    u.gaveUpGap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    u.repathT = Math.min(ATTACK_GIVEUP_COOLDOWN * Math.max(1, u.attackStalls - 1), ATTACK_HOLD_MAX);
  }

  /** An attacker's target just died/vanished: keep fighting by acquiring the next
   *  hostile in acquisition range and attacking it; only fall idle when nothing is
   *  left nearby (WC3 units follow up after a kill). Creeps keep their own guard/
   *  camp controller, so they just fall idle here and re-engage via tickCreep/
   *  tickAcquire next tick. */
  private reacquireOrStop(u: SimUnit): void {
    const acq = this.acquireRange(u);
    if (acq > 0 && !u.isCreep) {
      const next = this.acquireTarget(u, acq);
      if (next) {
        // Grab the nearest enemy. If it turns out to be walled off, the in-strike-range
        // switch in tickAttack (cheap) and the stall watchdog (which hands off to the
        // nearest REACHABLE enemy) take over from here — no need for an A* probe on every
        // kill, which got expensive in high-churn fights.
        this.issueAttack(u.id, next.id);
        return;
      }
    }
    // A follower that peeled off to guard its leader has cleared the area — return to
    // trailing it rather than falling idle where it stands (issue #32). The leader may
    // have moved off during the fight; issueFollow re-homes on it (dead → fall to idle).
    if (u.followLeaderId !== null && this.units.has(u.followLeaderId)) {
      this.issueFollow(u.id, u.followLeaderId, u.followOffX, u.followOffY);
      return;
    }
    this.stop(u.id);
  }

  /** A unit has been unable to close on its attack target for ATTACK_STALL_TIME.
   *  Re-decide, escalating: (1) claim a fresh surround slot in case ours is walled
   *  off and repath around the blockers; (2) if the target is genuinely unreachable,
   *  switch to the nearest hostile we CAN path in to hit; (3) if nothing reachable
   *  is left, stop grinding and just face the target (WC3 units give up on a target
   *  they can't reach rather than jiggling in place forever). */
  private redecideAttack(u: SimUnit, t: SimUnit): void {
    // (1) Is the target actually reachable — can we path a foot into weapon range?
    // Gate on that, NOT on pathTo()'s boolean: pathTo always returns a best-effort
    // path (one cell toward the goal) even when the goal can't be reached, so a unit
    // wobbling toward a walled-off slot would "succeed" here every time and never let
    // go. Only when we can genuinely close do we claim a fresh slot and repath around
    // whatever blocked our old one.
    if (this.canReachToAttack(u, t)) {
      this.assignAttackSlot(u, t);
      const ax = u.atkOffX !== 0 || u.atkOffY !== 0 ? t.x + u.atkOffX : t.x;
      const ay = u.atkOffX !== 0 || u.atkOffY !== 0 ? t.y + u.atkOffY : t.y;
      u.repathT = 0;
      if (this.pathTo(u, ax, ay, COMBAT_EXPANSIONS)) {
        u.gaveUp = false; // moving again — not holding
        return; // found a way around — resume the chase
      }
    }
    // (2) Target unreachable — hand off to a reachable one within our normal
    // acquisition range (creeps use their aggro range and camp threat order).
    const range = this.acquireRange(u);
    const next = range > 0 ? this.reachableEnemy(u, range, t.id) : null;
    if (next) {
      this.issueAttack(u.id, next.id); // issueAttack clears gaveUp
      return;
    }
    // (3) Nothing reachable: enter the holding sub-state — stand and face, committed
    // for a spell so we don't probe (and get shoved back) every second. tickAttack's
    // gaveUp branch owns it from here (pure A* re-checks, no movement).
    this.settle(u);
    u.gaveUp = true;
    u.gaveUpGap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x);
    u.repathT = ATTACK_GIVEUP_COOLDOWN;
  }

  /** Nearest hostile within `range` (excluding `excludeId`) this unit can actually
   *  path in to strike — the reachability filter the issue asks for. Bounded: only
   *  the few nearest candidates get an A* probe, and it only runs when a unit has
   *  already given up on an unreachable target, so the cost is rare. Applies the
   *  same visibility / un-aggroed-creep gates as normal auto-acquire. */
  private reachableEnemy(u: SimUnit, range: number, excludeId: number): SimUnit | null {
    const cands: Array<{ t: SimUnit; gap: number }> = [];
    for (const t of this.units.values()) {
      if (t === u || t.id === excludeId || !this.hostile(u, t)) continue;
      if (!this.canAttack(u, t)) continue; // no weapon for it — not a candidate at any distance
      if (t.isCreep && !this.creepAggroed(t)) continue; // don't pull an idle camp
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap > range) continue;
      if (!this.canSee(u, t)) continue; // never aggro what we cannot see (sight + fog + LOS)
      cands.push({ t, gap });
    }
    cands.sort((a, b) => a.gap - b.gap);
    for (let i = 0; i < cands.length && i < 5; i++) {
      if (this.canReachToAttack(u, cands[i].t)) return cands[i].t;
    }
    return null;
  }

  /** True when `u` can path to within weapon range of `t` (best-effort A*: the
   *  closest reachable cell lands in striking distance). Air units and targets
   *  already in range short-circuit. Releases `u`'s own cell reservation for the
   *  probe (as pathTo does) so its footprint doesn't block its own start. */
  private canReachToAttack(u: SimUnit, t: SimUnit): boolean {
    if (u.flying) return true;
    const reach = this.weaponVs(u, t)?.range ?? 0; // the range of the slot THIS target calls for
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    if (gap <= reach) return true;
    const wasReserved = u.hasReservation;
    this.unsettle(u);
    const start = this.grid.worldToCell(u.x, u.y);
    const blocked = this.clearanceBlocker(u, start);
    const cells = findPath(this.grid, start, this.grid.worldToCell(t.x, t.y), blocked, COMBAT_EXPANSIONS);
    if (wasReserved) this.settle(u);
    if (!cells || cells.length <= 1) return false;
    const [ecx, ecy] = cells[cells.length - 1];
    const [ex, ey] = this.grid.cellToWorld(ecx, ecy);
    const endGap = Math.hypot(t.x - ex, t.y - ey) - u.radius - t.radius;
    return endGap <= reach + PATHING_CELL;
  }

  /** Close to weapon range, then face + swing at the damage point. Shared by
   *  direct Attack orders and attack-move engagements. `noChase` (Hold Position)
   *  makes the unit strike only what's already in range and never pursue. */
  private engage(u: SimUnit, t: SimUnit, noChase = false): void {
    // Ethereal (Banished) units can't swing — cancel any pending strike and hold,
    // never chase (issue #49). Covers the Hold / attack-move callers of engage; the
    // plain "attack" order is stood down in tickAttack.
    if (u.ethereal) {
      this.cancelSwing(u);
      u.inCombat = false;
      this.settle(u);
      return;
    }
    // The slot for THIS target — a Gargoyle's ground claws or its air spit, and each with its
    // own range and cooldown (the Flying Machine's bombs reach 100, its flak 500). Nothing we
    // can hit it with: stand down rather than chase a target we could never strike.
    const w = this.weaponVs(u, t);
    if (!w) {
      this.cancelSwing(u);
      u.inCombat = false;
      this.settle(u);
      return;
    }
    // Committed to a swing: the attack animation is playing toward its damage point,
    // where the strike/projectile fires (a delayed frame WITHIN the animation). A
    // WC3 unit stands still for that whole wind-up — it NEVER walks mid-strike, so
    // don't let a target drifting out of range start a chase now. Hold position and
    // keep facing the swing's target; tickSwing lands the hit at the damage point,
    // and only afterwards (swingLeft back to -1) do we re-check range and give chase.
    if (u.swingLeft >= 0) {
      if (u.moving) this.settle(u);
      u.inCombat = true;
      const st = this.units.get(u.swingTargetId) ?? t;
      u.desiredFacing = Math.atan2(st.y - u.y, st.x - u.x);
      return;
    }
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    // How close is "close enough to plant and swing". For MELEE this is the full
    // strike band (range + ATTACK_LEASH) at all times — the same reach tickSwing
    // actually connects a hit from — so a unit in a crowd stops and attacks the
    // moment it's within striking distance instead of shoving toward a pixel-exact
    // surround slot it can't physically reach through the other bodies (issue #24:
    // the "tries to pass through units, wobbling next to the target without hitting"
    // report). Ranged units keep the tight range (they stand off and don't surround),
    // with the leash only as re-chase hysteresis once already in combat.
    const chaseGap = w.ranged ? (u.inCombat ? w.range + ATTACK_LEASH : w.range) : w.range + ATTACK_LEASH;
    if (gap > chaseGap) {
      u.inCombat = false;
      if (noChase) {
        this.settle(u); // Hold Position: attack in range only, never step forward
        return;
      }
      this.chaseToAttack(u, t);
      return;
    }
    // In range: halt onto a distinct tile (spread, don't cluster — settleSpread), face
    // the target, swing when ready (rotation itself is applied by the shared turning pass).
    this.settleSpread(u, t);
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
    u.swingBroken = false; // a genuine new swing always animates (clears any prior break)
    u.swingTargetId = t.id;
    u.swingWeapon = w; // the strike lands with the slot it was launched from
    // Roll this swing's procs now, before the clip is picked (see swingCrit/swingSlam).
    // Critical Strike is only ever applied by dealDamage, so only a melee swing rolls it —
    // a ranged shooter must not slam for a crit it would never deal. And only against
    // something it may proc on: AOcr's `targs1` is "air,ground,enemy,neutral" — no `friend`
    // — so a force-attack on your own unit never crits (and so never slams).
    u.swingCrit = !w.ranged && this.hostile(u, t) && this.rollCriticalStrike(u);
    // Bash (AHbh) rolls here for the same reason crit does — the Mountain King's
    // "Attack Slam" clip is picked as the swing begins. Unlike crit it is NOT melee-only
    // (the item Bash AIbx sits happily on a ranged hero), but like crit it only procs on
    // something it may target: AHbh's targs1 is "ground,air" with no `friend`, so a
    // force-attack on your own unit never bashes.
    u.swingBash = this.hostile(u, t) && !t.invulnerable && this.rollBash(u);

    // A blow out of Wind Walk shows the same strike: the fade breaks at the damage point
    // (tickSwing) and that blow carries the Backstab Damage, so a swing begun while cloaked
    // is the backstab swing. `cloaked`, not `invisible` — the bonus is owed from the moment
    // the buff lands, transition included, which is the same test breakInvisibility makes.
    u.swingSlam = u.swingCrit || (u.swingBash && !w.ranged) || u.cloaked;
    u.swingSeq++; // renderer restarts the attack animation so the strike lines up
    // EVENT_(PLAYER_)UNIT_ATTACKED fires as the attacker commits a swing at the target.
    if (this.captureAttacks) this.attackEvents.push({ attacked: eventInfo(t), attacker: eventInfo(u) });
  }

  /** Attack-move: fight any hostiles within acquisition range FIRST (chasing +
   *  attacking, and acquiring the next the moment one dies), advancing toward the
   *  destination only when nothing is left to fight nearby (WC3 A-move). */
  private tickAttackMove(u: SimUnit, dt: number): void {
    const acq = this.acquireRange(u); // 0 for a worker — it just walks the route (issue #41)
    // Committed to a swing (see engage): stand still through the wind-up rather than
    // advancing toward the attack-move destination — a target fleeing past acquire
    // range mustn't drag the unit into walking while its strike is still pending.
    if (u.swingLeft >= 0) {
      if (u.moving) this.settle(u);
      u.inCombat = true;
      const st = this.units.get(u.swingTargetId);
      if (st) u.desiredFacing = Math.atan2(st.y - u.y, st.x - u.x);
      return;
    }
    if (acq > 0) {
      const hadTarget = u.targetId !== null;
      let t = hadTarget ? this.units.get(u.targetId!) : undefined;
      // Drop the target if it died, turned friendly, went invulnerable (Divine Shield resets aggro), or fled past the leash.
      if (t && (!this.hostile(u, t) || t.invulnerable || Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > acq)) t = undefined;
      if (!t) {
        if (hadTarget) u.acquireT = 0; // just lost one — re-scan now, don't creep forward
        u.acquireT -= dt;
        if (u.acquireT <= 0) {
          u.acquireT = ACQUIRE_PERIOD;
          // Sight-gated: an attack-moving army engages what it can SEE, not whatever
          // the sim knows is out there in the fog ahead of it (issue #45).
          t = this.nearestEnemy(u, acq, true) ?? undefined;
        }
      }
      if (t) {
        this.setAttackSlot(u, t); // fan out around it, like a direct attack order
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
  private nearestEnemy(u: SimUnit, range: number, needSight = false): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap >= bestGap) continue;
      if (!this.canAttack(u, t)) continue; // nothing in hand that can hit it (air/ground/structure)
      if (needSight && !this.canSee(u, t)) continue;
      bestGap = gap;
      best = t;
    }
    return best;
  }

  /** This unit's sight radius right now: UnitBalance `sight` by day, `nsight` after
   *  dark (the same radii that lift the fog for the player). */
  private sightOf(u: SimUnit): number {
    return (this.isDay ? u.sightDay : u.sightNight) || u.sightDay || 800;
  }

  /** Can `u` actually SEE `t`? Every auto-acquisition asks this; an explicit attack
   *  order and return fire never do (a struck unit always turns on whoever hit it).
   *
   *  Two gates. First the unit's OWN eyes: nothing is acquired beyond its sight radius,
   *  which shrinks at night — that's why an army can slip past a creep camp in the dark
   *  even though the camp's acquisition range hasn't changed (issue #45: creeps were
   *  aggroing through the fog because no creep path consulted sight at all). Then the
   *  player's shared team vision (`visibleToTeam`), so nothing aggros an enemy its own
   *  side hasn't revealed. Non-local teams pass that second gate — only the local team's
   *  fog is modelled — so for creeps this is purely eyes and terrain.
   *
   *  Last and most expensive, LINE OF SIGHT: a treeline or a cliff between the two
   *  blinds the watcher exactly as it blanks the fog map. Ranged creeps were shooting
   *  heroes straight through a forest they could not see over. Ordered last, and after
   *  each caller's range test, so the ray is only cast for a target already worth it. */
  /** Does any living unit on `team` have True Sight covering (x, y)? Detection is shared
   *  across the team, so one Shade or one Sentry Ward uncovers a Wind Walking hero for
   *  every unit that side owns. */
  teamDetects(team: number, x: number, y: number): boolean {
    for (const d of this.units.values()) {
      if (d.team !== team || d.hp <= 0 || d.detectRadius <= 0) continue;
      if (Math.hypot(d.x - x, d.y - y) <= d.detectRadius) return true;
    }
    return false;
  }

  private canSee(u: SimUnit, t: SimUnit): boolean {
    // An invisible unit is INVISIBLE: it draws no aggro. classic.battle.net's invisibility
    // page — "just because you can't see them, it doesn't mean you can't hit them!" — is the
    // other half of this: being unseen stops the automatic paths, not a deliberate blow, and
    // every caller here is an automatic one (idle scan, creep aggro, assist, re-acquire).
    // An explicit attack order goes through issueAttack and never consults canSee.
    //
    // …unless somebody on the watcher's side has TRUE SIGHT over it. Detection is a team
    // property in WC3, not a personal one: the Shade stands at the back and the whole army
    // sees what it uncovers, which is the entire reason the unit exists.
    if (t.invisible && !this.teamDetects(u.team, t.x, t.y)) return false;
    if (Math.hypot(t.x - u.x, t.y - u.y) - t.radius > this.sightOf(u)) return false;
    if (!this.visibleToTeam(u.team, t.x, t.y)) return false;
    return this.lineOfSight(u.x, u.y, t.x, t.y, u.flying || t.flying);
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
      if (!this.canAttack(u, t)) continue; // a ground-only creep ignores the flyer overhead
      if (!this.canSee(u, t)) continue; // a creep aggroes only what it can see (issue #45)
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
    const w = u.swingWeapon;
    if (u.swingLeft < 0 || !w) return;
    u.swingLeft -= dt;
    if (u.swingLeft > 0) return;
    u.swingLeft = -1;
    const t = this.units.get(u.swingTargetId);
    if (!t) return; // target gone before impact — the swing whiffs
    // The swing reached its fire frame: play the attacker's own weapon sound (its
    // model's SND "K" event) regardless of whether a melee strike will connect.
    this.attackSwings.push(u.id);
    // Attacking reveals — at the fire frame, so a ranged shot gives its shooter away when it
    // is loosed and not when it lands. The blow that breaks the fade carries the Backstab
    // Damage; a melee swing that then whiffs still spends it, having already given the unit up.
    const backstab = this.breakInvisibility(u);
    if (w.ranged) {
      this.spawnProjectile(u, t, w, backstab);
    } else {
      // Melee connects if the target is still within the same reach the unit is
      // allowed to swing from (range + the combat-hold leash) — NOT the tighter
      // ARRIVE_EPS, which left a dead band where the attack animation played but
      // the strike whiffed and no damage landed against a target drifting away.
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap <= w.range + ATTACK_LEASH) this.dealDamage(u, t, w, backstab);
    }
  }

  /** Cancel any pending swing (unit re-tasked away from its attack). */
  private cancelSwing(u: SimUnit): void {
    u.swingLeft = -1;
  }

  /**
   * Reveal an invisible unit, and return the Backstab Damage the blow that broke it earns
   * (0 if it wasn't invisible, or for a plain invisibility that carries no bonus).
   *
   * WC3's rule is the same for EVERY source of invisibility — Wind Walk, the Sorceress's
   * Invisibility, a Potion — so this is the one place it lives. classic.battle.net:
   * "Invisible units will reveal themselves if they do anything but move or stop."
   *
   * Breaking ends the whole ABILITY, not just the fade: it drops every buff sharing the
   * invisible buff's group, so a broken Wind Walk takes its Movement Speed Increase with it
   * (liquipedia has the cooldown starting "when Wind Walk breaks" — the ability is over).
   * The group is what scopes that: Wind Walk's speed and invisibility are both "windwalk",
   * while a bare Invisibility only ever drops itself. An ungrouped ("") buff is nobody's
   * sibling, so it must never be swept up by group equality.
   */
  /**
   * Shadow Meld's two extra break conditions, checked every tick because neither one is an
   * EVENT the unit does — they are conditions that stop holding.
   *
   * MOVING. Liquipedia: the meld is lost if the unit "moves, attacks, uses an ability, or
   * casts a spell". The last three already reveal through breakInvisibility (the shared path
   * every invisibility uses), but movement is Shadow Meld's alone — Wind Walk's entire point
   * is that you keep it while you walk. Tested on actual displacement rather than on the
   * order, because an order is an intent: a melded Archer shoved by a collision resolve, or
   * carried along by a settle() snap, has moved whether she meant to or not. `moving` alone
   * would also miss the frame a push happens outside any order.
   *
   * DAY. `[Ashm]` is night-only for units (Liquipedia: "usually disabled during the day"),
   * so dawn ends a meld already in force — it is not merely a bar on casting it.
   *
   * The two columns this does NOT spend are DataB "Day/Night Duration" (2.5) and DataC
   * "Action Duration" (0.5). Their names are from AbilityMetaData/WorldEditStrings, but no
   * source says what either measures — a grace period at dawn, a re-meld lockout after
   * acting, something else. Per CLAUDE.md the number gets implemented when its MEANING is
   * known, not guessed at from its size, so dawn is sharp and re-melding is immediate until
   * somebody measures the real client. DataA "Fade Duration" (1.5) is spent, as the buff's
   * `delay` — Liquipedia names that one outright.
   */
  private tickMeld(u: SimUnit): void {
    if (!u.buffs.some((b) => b.kind === "invisible" && b.meld)) return;
    const moved = u.x !== u.prevX || u.y !== u.prevY;
    if (moved || this.isDay) this.breakInvisibility(u);
  }

  private breakInvisibility(u: SimUnit): number {
    if (!u.cloaked) return 0;
    let bonus = 0;
    const groups = new Set<string>();
    for (const b of u.buffs) {
      if (b.kind !== "invisible") continue;
      bonus = Math.max(bonus, b.value); // Backstab Damage (AOwk DataC: 40/70/100)
      if (b.group) groups.add(b.group);
    }
    u.buffs = u.buffs.filter((b) => b.kind !== "invisible" && !(b.group && groups.has(b.group)));
    this.recomputeStats(u);
    return bonus;
  }

  /** Launch a homing projectile from attacker to target. Damage is rolled now
   *  and applied when it lands (armor is applied at impact). */
  private spawnProjectile(u: SimUnit, t: SimUnit, w: SimWeapon, bonus = 0): void {
    const id = this.nextProjectileId++;
    // Launch from the weapon's model point (local offset rotated by facing), not the
    // unit's feet — e.g. the Archmage's fireball leaves from launchz=66 (his rod).
    const [lx, ly, lz0] = launchPoint(u, w.launchX, w.launchY, w.launchZ);
    // Height off the ground: the weapon's local launch offset PLUS the shooter's
    // flight altitude, so a flyer's missile leaves from the model (not the terrain
    // beneath it). Likewise the missile aims at the target's altitude on impact —
    // a shot at an air unit lands at its height, not on the ground below it.
    const lz = lz0 + u.flyHeight;
    const impactBase = w.impactZ > 0 ? w.impactZ : lz0;
    const proj: SimProjectile = {
      id,
      x: lx,
      y: ly,
      z: lz,
      sourceId: u.id,
      targetId: t.id,
      speed: w.missileSpeed > 0 ? w.missileSpeed : 900,
      damage: this.rollDamage(w) + bonus, // + Backstab Damage if this shot broke a fade
      art: w.missileArt,
      attackType: w.attackType,
      startZ: lz,
      impactZ: impactBase + t.flyHeight,
      startDist: Math.hypot(t.x - lx, t.y - ly),
      spill: w.spillDist > 0 && w.spillRadius > 0
        ? { dist: w.spillDist, radius: w.spillRadius, loss: w.damageLoss, ox: lx, oy: ly }
        : undefined,
    };
    this.projectiles.set(id, proj);
    this.spawnedProjectiles.push({ id, art: proj.art, x: proj.x, y: proj.y, z: proj.z });
  }

  /** Carry a line weapon's hit PAST its target (issue #57). The "spill" fields on a Missile
   *  (Line) / Artillery (Line) weapon describe a corridor that starts at the unit struck and
   *  runs on along the missile's heading for `spillDist`, catching anything within
   *  `spillRadius` of it — thehelper's "the damage will continue beyond the unit you hit".
   *  Both stock users of it are pure upgrades: the Gryphon Rider's hammer and the Glaive
   *  Thrower's bolt already ship the 50-unit radius and the 0.2 falloff and a spill DISTANCE
   *  of 0, so they hit exactly one unit until Storm Hammers / Impaling Bolt (`rasd` = 200)
   *  opens the corridor.
   *
   *  The magnitudes are all data (spillDist1/spillRadius1/damageLoss1). The FALLOFF CURVE is
   *  the one thing no game file states: the Object Editor names "Damage Loss Factor" and stops
   *  there. Hive/thehelper describe it as damage shed per further body down the line, so each
   *  successive unit takes (1 - loss)× the one before — 44 → 35 → 28 for a Gryphon. */
  private applySpill(p: SimProjectile, primary: SimUnit): void {
    const s = p.spill!;
    const dx = primary.x - s.ox;
    const dy = primary.y - s.oy;
    const len = Math.hypot(dx, dy);
    if (len < 1) return; // point-blank — no line to spill along
    const ux = dx / len;
    const uy = dy / len;
    const source = this.units.get(p.sourceId);
    // Everything in the corridor behind the target, nearest first — the hammer loses its bite
    // as it goes, so the order it meets them decides how hard each is hit.
    const hits: Array<{ t: SimUnit; along: number }> = [];
    for (const t of this.units.values()) {
      if (t === primary || t.hp <= 0 || t.invulnerable) continue;
      // Enemies only: the Gryphon's own splashTargs list is "ground,structure,enemy,debris",
      // so a hammer that carries through never mows down the rank of Footmen behind it.
      if (!source || !this.hostile(source, t)) continue;
      if (!this.canAttack(source, t)) continue;
      const along = (t.x - primary.x) * ux + (t.y - primary.y) * uy; // projection onto the line
      if (along <= 0 || along > s.dist) continue; // behind the target, within the spill distance
      const off = Math.abs((t.x - primary.x) * -uy + (t.y - primary.y) * ux); // perpendicular offset
      if (off > s.radius + t.radius) continue;
      hits.push({ t, along });
    }
    hits.sort((a, b) => a.along - b.along);
    let damage = p.damage;
    for (const h of hits) {
      damage *= 1 - s.loss;
      if (damage <= 0) break;
      this.applyDamage(h.t, damage, p.sourceId, p.attackType ?? AttackType.None);
    }
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
        this.projectileImpacts.push({ id: p.id, x: t.x, y: t.y, z: p.impactZ }); // record the hit point
        if (p.spell) {
          // Spell missile (Storm Bolt/Death Coil): run the ability effect on impact.
          // Resolve the exact ability by id (several abilities share a base code).
          const caster = this.units.get(p.sourceId) ?? t; // caster may have died mid-flight
          const def = this.abilities?.get(p.spell.abilityId);
          this.applySpellEffect(p.spell.code, p.spell.rank, caster, { targetId: t.id, x: t.x, y: t.y }, def);
        } else {
          const dealt = this.applyDamage(t, p.damage, p.sourceId, p.attackType ?? AttackType.None);
          if (dealt > 0) this.applyArrowAutocast(this.units.get(p.sourceId), t); // Searing/Frost/Black/Incinerate arrows
          this.applyLiquidFire(this.units.get(p.sourceId), t); // Batrider: burn a struck building
          const shooter = this.units.get(p.sourceId);
          if (shooter) this.applyPillage(shooter, t, dealt); // ranged Pillage (Raider) off a struck building
          if (p.spill) this.applySpill(p, t); // Storm Hammers / Impaling Bolt carry on down the line
        }
        this.removeProjectile(p.id);
      } else {
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        // Straight-line 3D flight: height lerps launch→impact by horizontal progress.
        const prog = p.startDist > 1 ? Math.max(0, Math.min(1, (p.startDist - dist) / p.startDist)) : 1;
        p.z = p.startZ + (p.impactZ - p.startZ) * prog;
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

  /** Head for a target to ATTACK it, aiming at this unit's assigned formation slot
   *  around the target (see assignAttackSlot) rather than its exact centre — so a
   *  group swarming one enemy fans out around it and holds a surround, instead of
   *  lining up behind each other and shoving. The slot is a relative offset, so it
   *  tracks a moving target. A lone attacker (no slot) heads straight in. */
  private chaseToAttack(u: SimUnit, t: SimUnit): void {
    if (u.atkOffTarget === t.id && (u.atkOffX !== 0 || u.atkOffY !== 0)) {
      this.chasePoint(u, t.x + u.atkOffX, t.y + u.atkOffY);
    } else {
      this.chasePoint(u, t.x, t.y);
    }
  }

  /** Follow a leader: trail it at FOLLOW_GAP, parking when close and re-approaching
   *  when it moves off. If the leader dies/vanishes, stop where we stand. A group
   *  told to follow one unit carries a formation offset (followOff*) so each holds a
   *  distinct slot around the leader instead of stacking on its centre and shoving.
   *  Once caught up, a follower GUARDS its leader — it strikes an enemy that comes
   *  within its own acquisition range, then returns to trailing when the fight ends
   *  (issue #32). While still marching up it never peels off, so it doesn't wander. */
  private tickFollow(u: SimUnit, dt: number): void {
    const t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    if (!t) {
      this.stop(u.id);
      return;
    }
    // The point we trail: our formation slot (leader centre + offset) when fanned,
    // else the leader itself at FOLLOW_GAP. `d` is the distance to it (hull gap in the
    // lone case). Hysteresis: while parked, tolerate the leader drifting out by
    // FOLLOW_LEASH before re-chasing, so small leader movement (or the settle snap)
    // doesn't oscillate the walk↔stand clip — the follow-animation "jiggle".
    const slotted = u.followOffX !== 0 || u.followOffY !== 0;
    const ax = slotted ? t.x + u.followOffX : t.x;
    const ay = slotted ? t.y + u.followOffY : t.y;
    const d = slotted
      ? Math.hypot(ax - u.x, ay - u.y)
      : Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    const arrive = slotted
      ? u.moving
        ? FOLLOW_SLOT_ARRIVE
        : FOLLOW_SLOT_ARRIVE + FOLLOW_LEASH
      : u.moving
        ? FOLLOW_GAP
        : FOLLOW_GAP + FOLLOW_LEASH;
    const caughtUp = d <= arrive;
    // Guard the leader: once caught up, peel off to strike the nearest enemy within
    // our OWN acquisition range (a follower still marching up keeps moving instead of
    // wandering off). issueAttack switches us to the attack order and arms the resume;
    // when that fight ends with nothing left in range, reacquireOrStop returns us here.
    const acq = u.isCreep ? 0 : this.acquireRange(u);
    if (caughtUp && acq > 0) {
      u.acquireT -= dt; // throttle the O(units) scan (same period as idle auto-acquire)
      if (u.acquireT <= 0) {
        u.acquireT = ACQUIRE_PERIOD;
        const enemy = this.acquireTarget(u, acq);
        if (enemy) {
          const leaderId = u.targetId; // save: issueAttack overwrites targetId with the enemy
          if (this.issueAttack(u.id, enemy.id)) u.followLeaderId = leaderId; // resume-to-follow
          return;
        }
      }
    }
    if (!caughtUp) {
      if (slotted) this.chasePoint(u, ax, ay);
      else this.chase(u, t); // approach (chasePoint repaths as the leader strays)
    } else {
      if (u.moving) this.settle(u); // caught up — hold position near the leader
      u.desiredFacing = Math.atan2(t.y - u.y, t.x - u.x); // face the leader while parked
    }
  }

  private chasePoint(u: SimUnit, x: number, y: number): void {
    if (u.repathT > 0) return;
    if (u.moving && Math.hypot(x - u.chaseX, y - u.chaseY) < CHASE_REPATH) return;
    // Chasing (an attack target or a follow leader) is LOCAL — the thing is within
    // acquisition/leader range, a couple of dozen cells off. Cap the search low so a
    // blocked/unreachable chase gives up after a small local flood instead of the full
    // 8192-cell map flood (issue #24 perf: 100 melee all probing paths to one crowded
    // target flooded the frame to ~20fps). A best-effort short path is fine here —
    // chasePoint re-runs as the target moves anyway.
    this.pathTo(u, x, y, COMBAT_EXPANSIONS);
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
        this.felled.push(tree); // renderer plays "death" + leaves the stump
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
      } else {
        this.treeHits.push({ x: tree.x, y: tree.y }); // still standing → "stand hit" wobble
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

  /** Land a melee strike. `w` is the slot it was swung with — a Gargoyle's ground claws and
   *  its air spit have different attack types, so the damage table must see the right one. */
  private dealDamage(attacker: SimUnit, target: SimUnit, w: SimWeapon, bonus = 0): void {
    // Critical Strike (Blademaster passive AOcr): a chance to multiply the swing.
    // `bonus` is Wind Walk's Backstab Damage on the blow that broke the fade. It is added
    // AFTER the crit multiply — the two are independent bonuses on the same swing, and
    // nothing we have says a crit doubles the backstab.
    // Bash's Damage Bonus rides this swing. Added AFTER the crit multiply, alongside the
    // backstab: it is a flat bonus on the strike, not something a crit doubles.
    const bashBonus = attacker.swingBash ? this.bashDamageBonus(attacker) : 0;
    const raw = this.applyCriticalStrike(attacker, this.rollDamage(w)) + bonus + bashBonus;
    const dealt = this.applyDamage(target, raw, attacker.id, w.attackType);
    // Cleaving Attack (Pit Lord passive ANca): splash a fraction to nearby enemies.
    if (dealt > 0) this.applyCleave(attacker, target, raw);
    // Vampiric Aura: the attacker heals for a fraction of the melee damage dealt.
    if (attacker.lifesteal > 0 && dealt > 0 && attacker.hp > 0) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + dealt * attacker.lifesteal);
    }
    // Thorns Aura: the target returns a fraction of the damage to the attacker.
    if (target.thorns > 0 && dealt > 0) this.landDamage(attacker, dealt * target.thorns, target.id, false);
    if (dealt > 0) this.applyPulverize(attacker, target); // Tauren passive: chance for a splash
    this.applyPillage(attacker, target, dealt); // Pillage: gold off a struck enemy building
    // Bash: rolled when the swing began (see engage), spent here on the blow that landed.
    if (attacker.swingBash) this.applyBash(attacker, target);
  }

  /** Pillage (Asal): a landed attack on an enemy BUILDING gains its owner gold equal to dataA
   *  (50%) of the damage dealt. Gated on the Pillage upgrade (Ropg) — the ability sits on the
   *  unit from birth but only pays out once researched. */
  private applyPillage(attacker: SimUnit, target: SimUnit, dealt: number): void {
    if (dealt <= 0 || !target.building || !this.hostile(attacker, target)) return;
    const lvl = this.passiveLevelData(attacker, "Asal");
    if (!lvl || !this.tech || this.tech.researchLevel(attacker.owner, "Ropg") <= 0) return;
    this.stashOf(attacker.owner).gold += dealt * this.dataOf(lvl, 0, 0.5);
  }

  /** Pulverize (Tauren passive Awar): dataA% chance that a landed attack also deals dataB
   *  damage to enemies within dataC of the struck target. */
  private applyPulverize(attacker: SimUnit, target: SimUnit): void {
    const lvl = this.passiveLevelData(attacker, "Awar");
    // Pulverize is granted by the Pulverize upgrade (Rows, Awar's Requires) — the ability
    // sits on the Tauren from birth but only splashes once researched.
    if (!lvl || !this.tech || this.tech.researchLevel(attacker.owner, "Rows") <= 0) return;
    const chance = this.dataOf(lvl, 0, 25) / 100; // dataA — % chance
    if (chance <= 0 || this.rng() >= chance) return;
    const dmg = this.dataOf(lvl, 1, 60); // dataB — splash damage
    const radius = this.dataOf(lvl, 2, 250) || 250; // dataC — splash radius
    for (const t of this.unitsInAreaInternal(target.x, target.y, radius)) {
      if (t === attacker || t.building || !this.hostile(attacker, t)) continue;
      this.landDamage(t, dmg, attacker.id, false); // spell-style splash, ignores further armor
    }
  }

  /** Apply already-rolled PHYSICAL damage: reduced by the target's armor value,
   *  plays the weapon-impact SFX. Returns the HP actually removed (0 if immune). */
  /** Autocast attack modifiers that fire on a landed ranged hit: Searing Arrows
   *  (AHfa) / Black Arrow (ANba) / Incinerate (ANia) add bonus fire damage; Cold &
   *  Frost Arrows (AHca) slow the target. Each spends the ability's per-shot mana. */
  /** Liquid Fire (Batrider passive Aliq): a struck BUILDING burns for dataA dps over the
   *  duration, its attack rate cut by dataC, and it cannot be repaired while burning. The
   *  burn refreshes on each hit (re-applied by group), so sustained fire keeps it down. */
  private applyLiquidFire(attacker: SimUnit | undefined, target: SimUnit): void {
    if (!attacker || !target.building || target.hp <= 0) return;
    const lvl = this.passiveLevelData(attacker, "Aliq");
    if (!lvl) return;
    const dur = lvl.duration || 3;
    this.applyBuffInternal(target, { kind: "dot", group: "liquidfire", timeLeft: dur, value: this.dataOf(lvl, 0, 8), sourceId: attacker.id });
    this.applyBuffInternal(target, { kind: "slow", group: "liquidfire-atk", timeLeft: dur, value: 0, value2: this.dataOf(lvl, 2, 0.8), sourceId: attacker.id });
  }

  /** Whether a building is currently burning under Liquid Fire (blocks repair). */
  private hasLiquidFire(u: SimUnit): boolean {
    return u.buffs.some((b) => b.group === "liquidfire");
  }

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

  private applyDamage(target: SimUnit, rawDamage: number, attackerId: number, attackType = AttackType.None): number {
    // A Mirror Image illusion swings, connects, and does nothing: AOmi's DataB ("Damage
    // Dealt (%)") is 0. Its sheet still reads like the Blademaster's — the deception is
    // the whole ability — so this is enforced here, at the blow, not by editing its stats.
    // (Only its ATTACKS need this: an illusion cannot cast, so no spell damage is ever
    // attributed to one. "Damage Taken" lives in landDamage, which spells reach too.)
    //
    // The blow must still LAND: same swing, same weapon-on-armour clang as the real
    // Blademaster, because a silent attacker would give the copy away instantly. So record
    // the hit the way landDamage would and return 0, rather than bailing out before it —
    // bailing early is exactly what left the images swinging in silence.
    const attacker = attackerId ? this.units.get(attackerId) : undefined;
    if (attacker?.isIllusion && attacker.illusionDamageDealt <= 0) {
      if (!target.invulnerable) this.hits.push({ attackerId, targetId: target.id });
      return 0;
    }
    if (attacker?.isIllusion) rawDamage *= attacker.illusionDamageDealt;
    // Evasion (Demon Hunter passive AEev): a chance to dodge a physical attack.
    if (this.tryEvade(target)) return 0;
    // Defend (Adef, granted by the Rhde research): a Footman braced behind his shield turns
    // arrows aside. Straight off the ability's own Ubertip, which spells the whole thing out:
    // "Activate to have a <DataF1>% chance to reflect Piercing attacks upon the source, and to
    // take only <DataA1,%>% of the damage from attacks that are not reflected."
    const defend = attackType === AttackType.Pierce ? this.defendStance(target) : null;
    if (defend) {
      if (this.rng() * 100 < this.dataOf(defend, 5, 30)) {
        // Reflected: the shot goes back down its own flight path. The defender takes nothing.
        if (attacker) this.landDamage(attacker, rawDamage, target.id, false);
        return 0;
      }
      rawDamage *= this.dataOf(defend, 0, 0.5); // dataA — the fraction that gets through
    }
    // WC3 damage table: the weapon's attack type vs the target's armor type scales
    // the hit (Normal +50% vs Medium, Pierce ×2 vs Light/Unarmored, Siege ×1.5 vs
    // Fortified, Magic ×2 vs Heavy, …). Applied before the armor-value reduction;
    // both are multiplicative so order is immaterial.
    let typeMult = damageMultiplier(attackType, target.armorType);
    // Banished (ethereal) targets take a SECOND multiplier by the attacker's type:
    // 0 for every physical type (immune to melee/pierce/siege) and ×1.66 from
    // Magic/Spells (issue #49, EtherealDamageBonus). A physical auto-attack thus
    // lands 0 on a banished unit — the melee simply can't hurt it.
    if (target.ethereal) typeMult *= etherealDamageMultiplier(attackType);
    // Berserk (Absk) and the like: the holder takes a fraction MORE damage from every source.
    let vuln = 0;
    for (const b of target.buffs) if (b.kind === "vuln") vuln = Math.max(vuln, b.value);
    const reduction = armorDamageReduction(target.armor);
    const final = rawDamage * typeMult * (1 + vuln) * (1 - reduction);
    return this.landDamage(target, this.spiritLinkSplit(target, final), attackerId, true);
  }

  /** Spirit Link (Aspl): `linkShare` of a post-armor hit is spread equally across the linked
   *  group (each living member, including the target, takes an equal share); the rest stays
   *  on the target. Returns the reduced amount the target itself should take. */
  private spiritLinkSplit(target: SimUnit, dmg: number): number {
    if (target.linkT <= 0 || target.linkGroup.length < 2 || dmg <= 0) return dmg;
    const members = target.linkGroup.map((id) => this.units.get(id)).filter((u): u is SimUnit => !!u && u.hp > 0);
    if (members.length < 2) return dmg;
    const share = target.linkShare;
    const per = (dmg * share) / members.length; // equal slice for every linked unit
    for (const m of members) {
      if (m === target) continue;
      m.hp -= per; // already post-armor; spirit-shared damage isn't reduced again
      if (m.hp <= 0) this.kill(m);
    }
    return dmg * (1 - share) + per; // target keeps the unshared part + its own slice
  }

  /**
   * Critical Strike (AOcr): roll dataA "Chance to Critical Strike" for a swing about to
   * begin. Rolled at the swing's START, not at the blow, so the strike can animate as one
   * (see swingCrit/swingSlam); dealDamage spends the result via applyCriticalStrike.
   *
   * dataA is a PERCENT, not a fraction: AbilityMetaData.slk gives Ocr1 `data=1` (→ dataA)
   * with `maxVal=100`, and AOcr carries DataA1..4 = 15 — the Blademaster's 15%. Note the
   * sibling field Ocr4 "Chance to Evade" (data=4) has `maxVal=1` and AEev stores 0.1, so
   * the two conventions genuinely differ within one table; read the meta, don't assume.
   */
  private rollCriticalStrike(u: SimUnit): boolean {
    const lvl = this.passiveLevelData(u, "AOcr");
    if (!lvl) return false;
    const chance = this.dataOf(lvl, 0) / 100; // dataA — "Chance to Critical Strike" (%)
    return chance > 0 && this.rng() < chance;
  }

  /** Critical Strike (AOcr): multiply a swing the roll already marked as a crit by dataB
   *  "Damage Multiplier" (AOcr DataB1..4 = 2/3/4/4 — the Blademaster's x2/x3/x4). */
  private applyCriticalStrike(attacker: SimUnit, damage: number): number {
    if (!attacker.swingCrit) return damage;
    const lvl = this.passiveLevelData(attacker, "AOcr");
    if (!lvl) return damage;
    return damage * this.dataOf(lvl, 1, 2); // dataB — damage multiplier
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

  /** An attacker the victim's side cannot see has just hit it: give away where the blow
   *  came from (FOGGED_ATTACK_REVEAL_RADIUS) for FOGGED_ATTACK_REVEAL_TIME, refreshed by
   *  each further blow. The reveal is stamped at the attacker's position AT THE MOMENT of
   *  the hit and stays put — you learn where it shot from, not where it ran to. It also
   *  outlives the attacker by its second, so a killing blow from the dark still points at
   *  the shooter. Attacks the victim's side can already see cost nothing. */
  private revealFoggedAttacker(attackerId: number, target: SimUnit): void {
    const attacker = this.units.get(attackerId);
    if (!attacker || !this.hostile(attacker, target)) return;
    const key = `${attackerId}:${target.team}`;
    // Only a blow from HIDDEN cover opens a reveal. Once one is open, every further blow
    // re-stamps it without re-testing visibility — because the reveal itself is what's
    // making the attacker visible, and re-testing would refuse to refresh it, leaving the
    // attacker to blink out every second while it kept firing.
    if (!this.attackReveals.has(key) && this.visibleToTeam(target.team, attacker.x, attacker.y)) return;
    this.attackReveals.set(key, {
      x: attacker.x,
      y: attacker.y,
      radius: FOGGED_ATTACK_REVEAL_RADIUS,
      team: target.team,
      flying: attacker.flying,
      timeLeft: FOGGED_ATTACK_REVEAL_TIME,
    });
  }

  /** Age out the fogged-attacker reveals (see revealFoggedAttacker). */
  private tickAttackReveals(dt: number): void {
    for (const [key, r] of this.attackReveals) {
      r.timeLeft -= dt;
      if (r.timeLeft <= 0) this.attackReveals.delete(key);
    }
  }

  /** The circles a hidden attacker's blows are currently lighting up, for the fog pass. */
  activeAttackReveals(): Iterable<AttackReveal> {
    return this.attackReveals.values();
  }

  /** Apply FINAL (post-reduction) damage: death, return fire, and (for physical
   *  hits) the impact SFX. Spell damage calls this directly with recordHit=false —
   *  WC3 ability damage ignores the armor value and plays its own effects. Returns
   *  the HP removed (0 if the target was invulnerable). */
  private landDamage(target: SimUnit, amount: number, attackerId: number, recordHit: boolean): number {
    if (target.invulnerable) return 0; // Divine Shield / Avatar: immune to damage
    // A Mirror Image illusion takes AOmi's DataC ("Damage Taken (%)") = 200%, which is why
    // one melts the moment somebody works out which is which. It belongs HERE and not in
    // applyDamage because that is only the ATTACK path: spellDamage lands straight here, and
    // Dispel Magic hitting a summon is exactly the case that has to double.
    if (target.isIllusion) amount *= target.illusionDamageTaken;
    // Sleep (Dreadlord) breaks the instant the sleeper takes damage (WC3).
    if (target.buffs.some((b) => b.kind === "sleep")) target.buffs = target.buffs.filter((b) => b.kind !== "sleep");
    // …and so does a regeneration item. Drinking a Healing Salve and walking into a fight
    // wastes it: the effect is dispelled by a hit worth at least ITEM_REGEN_BREAK damage.
    // That threshold is an engine constant in no data file — it is documented on
    // Liquipedia's Healing Salve page ("dispelled if the target is attacked or damaged by
    // an ability that does at least 20 damage, before the damage is modified") and cannot
    // be confirmed from the MPQ, unlike the amounts and durations above.
    if (amount >= ITEM_REGEN_BREAK && target.buffs.some((b) => b.group?.startsWith(ITEM_REGEN_GROUP))) {
      target.buffs = target.buffs.filter((b) => !b.group?.startsWith(ITEM_REGEN_GROUP));
      this.recomputeStats(target); // the mana half is a stat bonus — drop it now, not next tick
    }
    // Mana Shield (Naga): absorb incoming damage into mana at `value` mana per hp.
    amount = this.absorbWithManaShield(target, amount);
    if (amount <= 0) return 0;
    if (recordHit) this.hits.push({ attackerId, targetId: target.id });
    this.revealFoggedAttacker(attackerId, target);
    // EVENT_UNIT_DAMAGED: the amount that actually landed (after mana shield), with
    // the source. Captured before the hp subtraction so the target snapshot is live.
    if (this.captureDamage) {
      const src = attackerId ? this.units.get(attackerId) : undefined;
      this.damageEvents.push({ target: eventInfo(target), source: src ? eventInfo(src) : null, amount });
    }
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
      target.campHelper = false; // being hit makes it an originator: it may now call for help
    }
    // Retaliate: an armed victim turns on its attacker (WC3 return fire), unless the
    // attacker died mid-flight or the victim is a creep leashing home (it prioritises
    // returning). Fires when the victim is idle, OR is on an attack order but NOT actually
    // in combat — i.e. it's chasing / stalled / holding on a target it can't reach while
    // THIS enemy stands here hitting it (issue #24: "units stand around while enemies
    // attack them, the nearest enemy must always be attacked"). An enemy landing hits on
    // us is by definition adjacent and reachable, a strictly better target than one we
    // can't close on. A unit already trading blows (inCombat) keeps its target; HOLD-
    // position units (order "hold") never leave their post. Workers never return fire —
    // a peasant being cut down just stands there until you order it to fight, and a Ghoul
    // on a lumber trip keeps chopping through the blows (issue #41). The harvest check is
    // belt-and-braces: a harvesting unit isn't "notFighting" today, but the rule belongs
    // next to the one it mirrors in acquireRange.
    const attacker = this.units.get(attackerId);
    const notFighting = target.order === "idle" || (target.order === "attack" && !target.inCombat);
    // A unit under an invisibility effect never returns fire either — the same reason it
    // never picks its own fights in acquireRange. Retaliation reaches issueAttack directly,
    // so it would otherwise be the one automatic path that could give a wind-walking hero
    // away without the player asking for it.
    const passive = target.isPeon || this.harvesting(target) || target.cloaked;
    if (notFighting && target.weapon && !passive && !target.returning && attacker && this.hostile(target, attacker) && attacker.id !== target.targetId) {
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

  /** A summon LEAVES: its duration ran out, or a re-cast dismissed it. Its unsummon
   *  effect takes its place and the unit is simply removed — no death.
   *
   *  This is not the same event as a summon being killed, and must not be routed through
   *  kill(): that plays the unit's Death clip (a Feral Spirit wolf has one, and it looked
   *  like the wolf had been slain when its timer merely expired), grants kill XP, and
   *  fires death triggers. A wolf cut down in a fight still goes through kill() and dies
   *  properly — deathType=0 leaves no corpse and it dissipates (MiscData DissipateTime). */
  private unsummon(u: SimUnit): void {
    if (u.unsummonArt) this.spellEffects.push({ art: u.unsummonArt, x: u.x, y: u.y, targetId: 0, z: 0, sound: true });
    this.removeUnit(u.id); // silent: no corpse, no death XP, no death trigger
  }

  /** `Adda` — "AOE damage upon death": the unit detonates as it dies, damaging everything
   *  around it. The Goblin Land Mine and the Goblin Sapper are the units that carry it
   *  (`Adda` itself, plus `Amnx` and `Amnz` for the small and BIG mine), and the rings are
   *  the same four columns every death blast uses (AbilityMetaData Dda1..Dda4): dataA "Full
   *  Damage Radius", dataB "Full Damage Amount", dataC "Partial Damage Radius", dataD
   *  "Partial Damage Amount".
   *
   *  Chain reactions are real — a mine's blast sets off the mine beside it — but they must
   *  terminate. Two guards do that: a unit blasts at most once (`exploded`), and the blast
   *  skips anything already at zero hp, so the corpse it just made cannot be re-killed into
   *  a second explosion. */
  private exploded = new Set<number>();
  private deathBlast(u: SimUnit): void {
    if (this.exploded.has(u.id) || !this.abilities) return;
    const ab = u.abilities.find((a) => a.code === "Adda" && a.level >= 1);
    if (!ab) return;
    const lvl = this.abilities.get(ab.id)?.levelData[Math.max(0, ab.level - 1)];
    if (!lvl) return;
    this.exploded.add(u.id);
    const num = (i: number) => (lvl.data[i] === undefined || Number.isNaN(lvl.data[i]) ? 0 : lvl.data[i]);
    const fullR = num(0);
    const full = num(1);
    const partR = num(2);
    const part = num(3);
    for (const t of this.units.values()) {
      if (t.id === u.id || t.hp <= 0) continue;
      const dist = Math.hypot(t.x - u.x, t.y - u.y);
      if (dist > Math.max(fullR, partR)) continue;
      const amount = dist <= fullR ? full : part;
      if (amount > 0) this.landDamage(t, amount, u.id, false);
    }
  }

  private kill(u: SimUnit, killerId = 0): void {
    // A Mirror Image illusion that is destroyed does not die — it pops, with BOmi's
    // Specialart (MirrorImageDeathCaster, whose AOMI SND event is MirrorImageDeath.wav).
    // It must not play the Blademaster's death, which would both look wrong and tell the
    // enemy they had found a copy; and it grants no XP, being nothing but a picture.
    if (u.isIllusion) {
      this.unsummon(u);
      return;
    }
    // Reincarnation (Tauren Chieftain / Elder Sage, AOre): a fatal blow instead
    // revives the hero in place, on a long cooldown (stored on the ability).
    if (this.tryReincarnate(u)) return;
    this.deathBlast(u); // `Adda` — goblin land mines and sappers take the neighbours with them
    this.refundPendingBuild(u); // died before its building went up → refund the cost
    this.unsettle(u); // corpses don't block cells
    this.releasePathStamp(u); // …and neither does a collapsed building's footprint
    if (u.inMine) {
      const mine = this.mines.get(u.resId);
      if (mine) mine.busy = false; // don't wedge the mine shut forever
    }
    if (u.constructing) this.detachBuilder(u.id); // free the halted construction
    // Orc Burrow destroyed with peons inside: they die with it (WC3). Kill them first so
    // each death is recorded, then this burrow's own death proceeds.
    if (u.garrison.length) {
      for (const pid of [...u.garrison]) {
        const p = this.units.get(pid);
        if (p) {
          p.inBurrow = false;
          p.garrisonHost = 0;
          this.kill(p, killerId);
        }
      }
      u.garrison = [];
    }
    // Kodo Devour: a Kodo slain mid-digest spits its prey back out alive; a prey unit that
    // dies inside (fully digested, or the whole Map cleared) frees the Kodo's slot.
    if (u.devouring > 0) {
      const prey = this.units.get(u.devouring);
      if (prey && prey.hp > 0) this.freePrey(prey, u);
    }
    if (u.devouredBy > 0) {
      const kodo = this.units.get(u.devouredBy);
      if (kodo) kodo.devouring = 0;
    }
    // A garrisoned peon dying by any other path leaves its host's roster + rescales it.
    if (u.garrisonHost) {
      const host = this.units.get(u.garrisonHost);
      if (host) {
        host.garrison = host.garrison.filter((id) => id !== u.id);
        this.recomputeStats(host);
      }
    }
    this.awardKillXp(u, killerId); // enemy heroes near the kill gain experience
    this.rollCreepDrops(u); // creeps scatter their dropped-item table on death
    this.dropInventory(u); // a dying non-hero inventory-unit drops its held items
    this.spawnCorpse(u); // leave a decaying corpse (targetable by corpse spells)
    this.units.delete(u.id); // Map delete during values() iteration is safe
    this.deaths.push(u.id);
    // Record a death event for the trigger engine (Phase 7 — EVENT_UNIT_DEATH /
    // EVENT_PLAYER_UNIT_DEATH). Only when a script is listening (captureDeaths), so a
    // melee match with no trigger pump doesn't accumulate these. Snapshot both units
    // now — the victim is gone from `units` next tick, and the killer may move/die.
    if (this.captureDeaths) {
      const killer = killerId ? this.units.get(killerId) : undefined;
      this.deathEvents.push({ victim: eventInfo(u), killer: killer ? eventInfo(killer) : null });
    }
    this.unitDrops.delete(u.id);
  }

  // === items ================================================================

  /** Register a creep's dropped-item table (from war3mapUnits.doo), rolled when it
   *  dies. Called by the game layer as it seeds each Neutral Hostile creep. */
  setUnitDrops(id: number, sets: ItemDropSet[]): void {
    if (sets.length) this.unitDrops.set(id, sets);
  }

  /** Hand this unit's loot back to the map script. The script owns the drop when it watches
   *  the unit's death: the World Editor compiles the .doo drop table into war3map.j, so both
   *  copies describe the SAME loot and rolling both drops it twice. See syncEventCaptures. */
  clearUnitDrops(id: number): void {
    this.unitDrops.delete(id);
  }

  /** Roll a dead unit's drop table and scatter the results on the ground. Each SET
   *  drops at most one item, chosen among its entries by their `chance` percentages
   *  (WC3 dropped-item-set semantics); leftover probability = no drop. */
  private rollCreepDrops(u: SimUnit): void {
    const sets = this.unitDrops.get(u.id);
    if (!sets || !this.itemReg) return;
    let n = 0;
    for (const set of sets) {
      let roll = this.rng() * 100;
      let chosen: string | null = null;
      for (const entry of set.items) {
        if (roll < entry.chance) { chosen = entry.id; break; }
        roll -= entry.chance;
      }
      if (!chosen) continue;
      const def = this.itemReg.resolveDrop(chosen, this.rng);
      if (!def) continue;
      // Fan multiple drops out around the corpse so they don't stack on one spot.
      const ang = (n * 2.399963) % (Math.PI * 2); // golden-angle spread
      const r = n === 0 ? 0 : 48;
      this.spawnGroundItem(def.id, u.x + Math.cos(ang) * r, u.y + Math.sin(ang) * r, def.charges);
      n++;
    }
  }

  /** A dying inventory-holder scatters its held items on the ground. Each one keeps its
   *  entity id (it's the same item, now lying down) and raises DROP_ITEM.
   *
   *  A HERO is the exception, and it is the important one: a dead hero in WC3 keeps its
   *  whole inventory and walks back out of the altar still carrying it. Dropping a hero's
   *  items would hand the killer six free artifacts and is not how the game plays. Only
   *  non-hero inventory units (the `AInv` ability on a normal unit) drop what they carry. */
  private dropInventory(u: SimUnit): void {
    if (u.isHero) return; // items ride with the hero through death and revival
    let n = 0;
    for (let i = 0; i < u.inventory.length; i++) {
      const held = u.inventory[i];
      if (!held) continue;
      u.inventory[i] = null;
      const ang = (n * 2.399963) % (Math.PI * 2);
      this.spawnGroundItem(held.itemId, u.x + Math.cos(ang) * 64, u.y + Math.sin(ang) * 64, held.charges, held.id);
      this.noteItem(u, held, "drop");
      n++;
    }
  }

  /** Create a ground item at a point (queued for the renderer to model). The
   *  position is snapped to a pathing-grid cell centre so items always rest on a
   *  grid slot (WC3 behaviour) rather than at arbitrary sub-cell offsets. `reuseId`
   *  puts an item that already exists as an entity (one dropped from an inventory)
   *  back on the ground AS ITSELF: identity survives the move, so a JASS `item` handle
   *  taken before the drop still refers to it (7.18). */
  private spawnGroundItem(itemId: string, x: number, y: number, charges: number, reuseId = 0): SimItem {
    const [sx, sy] = this.snapItemPos(x, y);
    const it: SimItem = { id: reuseId || this.nextItemId++, itemId, x: sx, y: sy, charges };
    this.items.set(it.id, it);
    this.itemSpawns.push(it);
    return it;
  }

  /** Snap a world point to the centre of its pathing-grid cell. */
  private snapItemPos(x: number, y: number): [number, number] {
    const [ox, oy] = this.grid.origin;
    return [
      ox + (Math.floor((x - ox) / PATHING_CELL) + 0.5) * PATHING_CELL,
      oy + (Math.floor((y - oy) / PATHING_CELL) + 0.5) * PATHING_CELL,
    ];
  }

  /** New ground items since the last drain (renderer creates their models). */
  drainItemSpawns(): SimItem[] {
    if (!this.itemSpawns.length) return this.itemSpawns;
    const out = this.itemSpawns;
    this.itemSpawns = [];
    return out;
  }

  /** Ground items removed since the last drain (renderer drops their models). `died`
   *  asks the renderer to play the model's DEATH clip in place rather than snapping it
   *  out — see removeGroundItem. */
  drainItemRemovals(): Array<{ id: number; died: boolean }> {
    if (!this.itemRemovals.length) return this.itemRemovals;
    const out = this.itemRemovals;
    this.itemRemovals = [];
    return out;
  }

  /** Take a ground item off the world. `died` = it was CONSUMED where it lay, so the
   *  renderer plays the model's Death clip (which is also what spawns the little puff:
   *  every powerup model carries an `SPN…TOBO` → ToonBoom event on its Death track, and
   *  the Chest of Gold an `SPN…GDCR` → GoldCredit one — verified 1.27a). It is NOT set
   *  for the plumbing removals: an item that merely MOVES is removed and re-modelled at
   *  the new spot (see moveItem), and dying there would puff on every reposition. */
  private removeGroundItem(id: number, died = false): void {
    if (this.items.delete(id)) this.itemRemovals.push({ id, died });
  }

  /** The ground item nearest a world point within `radius`, or null (for click-to-
   *  pick-up hit-testing). */
  itemAt(x: number, y: number, radius = 64): SimItem | null {
    let best: SimItem | null = null;
    let bestD = radius;
    for (const it of this.items.values()) {
      const d = Math.hypot(it.x - x, it.y - y);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /** Order a hero to walk to a ground item and pick it up. */
  issueGetItem(unitId: number, itemId: number): boolean {
    const u = this.units.get(unitId);
    const it = this.items.get(itemId);
    if (!u || !it || !u.inventory.length || this.castLocked(u)) return false;
    u.getItemId = itemId;
    u.pendingGive = null;
    u.pendingSell = null;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(unitId);
    if (Math.hypot(it.x - u.x, it.y - u.y) <= u.radius + ITEM_PICKUP_RANGE) {
      this.pickUpItem(u, it);
      this.stop(unitId);
    } else {
      this.pathTo(u, it.x, it.y);
    }
    return true;
  }

  /** Order a hero to walk to another hero and hand over the item in `slot`. */
  /** Order a hero to SELL a held item to `shopId` — WC3's gesture is the same one that drops
   *  an item (right-click it in the inventory, then click the target); clicking a shop instead
   *  of the ground sells it. The hero walks over first: pawning has its own, shorter reach
   *  (PawnItemRange 300) than buying does. False if the shop doesn't deal in items at all. */
  issueSellItem(unitId: number, slot: number, shopId: number): boolean {
    const u = this.units.get(unitId);
    const shop = this.units.get(shopId);
    if (!u || !shop || !u.inventory[slot] || !this.canPawnAt(shop) || this.castLocked(u)) return false;
    const def = this.itemReg?.get(u.inventory[slot]!.itemId);
    if (!def?.pawnable) return false;
    u.pendingSell = { shopId, slot };
    u.pendingGive = null;
    u.pendingDrop = null;
    u.getItemId = 0;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    // Walk to the shop's NEAR EDGE, never its centre — that cell is inside the footprint and
    // unwalkable, so a path to it fails and the hero just stands there holding the item.
    if (!this.inPawnRange(u, shop)) {
      const [ax, ay] = this.shopApproach(u, shop);
      this.pathTo(u, ax, ay);
    }
    return true;
  }

  /** Does this building DEAL IN ITEMS — i.e. may a hero pawn one to it? The data says so
   *  outright: every item shop carries the `Apit` ability ("Shop Purchase Item") — the
   *  Marketplace, the Goblin Merchant, the Arcane Vault, the Tomb of Relics — and the two
   *  shops that trade in UNITS, the Tavern (`ntav`) and the Mercenary Camp (`nmer`), do not.
   *  So you cannot sell a Claws of Attack at a Tavern, and asking the ability rather than the
   *  ware list is what lets you sell to a Marketplace whose shelves are still empty. */
  canPawnAt(shop: SimUnit): boolean {
    if (shop.hp <= 0 || !this.abilities) return false;
    const def = this.unitReg?.get(shop.typeId);
    return !!def?.abilities.some((id) => this.abilities?.get(id)?.code === "Apit");
  }

  private inPawnRange(u: SimUnit, shop: SimUnit): boolean {
    return Math.hypot(u.x - shop.x, u.y - shop.y) <= MISC_GAME.PawnItemRange + shop.radius;
  }

  /** A standing spot on the shop's near side, OUTSIDE its pathing footprint. A building's
   *  collision `radius` is far smaller than the block it actually stamps (the Goblin Merchant's
   *  radius is 50, its footprint several times that), so aiming at centre-plus-radius — as the
   *  depot approach does for a town hall — lands the goal inside solid ground, the path fails,
   *  and the hero stands there holding the item he was told to sell. Pawning reaches 300, so
   *  stopping at the footprint's edge is comfortably close enough to trade. */
  private shopApproach(u: SimUnit, shop: SimUnit): [number, number] {
    const dx = u.x - shop.x;
    const dy = u.y - shop.y;
    const d = Math.hypot(dx, dy) || 1;
    const half = Math.max(shop.radius, ((shop.footprint || 2) * PATHING_CELL) / 2);
    const reach = half + u.radius + PATHING_CELL;
    return [shop.x + (dx / d) * reach, shop.y + (dy / d) * reach];
  }

  issueGiveItem(fromId: number, slot: number, toId: number): boolean {
    const u = this.units.get(fromId);
    const to = this.units.get(toId);
    if (!u || !to || !u.inventory[slot] || !to.inventory.length || this.castLocked(u)) return false;
    u.pendingGive = { toId, slot };
    u.getItemId = 0;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    if (Math.hypot(to.x - u.x, to.y - u.y) <= u.radius + to.radius + ITEM_GIVE_RANGE) {
      this.transferItem(u, slot, to);
      this.stop(fromId);
    } else {
      this.pathTo(u, to.x, to.y);
    }
    return true;
  }

  /** Drive the "getitem" order: walk to the ground item (or target hero) and, once
   *  close enough, pick it up / hand it over. */
  private tickGetItem(u: SimUnit): void {
    if (u.pendingDrop) {
      const { slot, x, y } = u.pendingDrop;
      if (!u.inventory[slot]) { this.stop(u.id); return; } // slot emptied meanwhile
      if (Math.hypot(x - u.x, y - u.y) <= ITEM_DROP_RANGE + u.radius) {
        this.doDropItem(u, slot, x, y);
        this.stop(u.id);
      } else if (!u.moving) {
        this.pathTo(u, x, y);
      }
      return;
    }
    if (u.pendingGive) {
      const to = this.units.get(u.pendingGive.toId);
      if (!to || to.hp <= 0 || !u.inventory[u.pendingGive.slot]) { this.stop(u.id); return; }
      if (Math.hypot(to.x - u.x, to.y - u.y) <= u.radius + to.radius + ITEM_GIVE_RANGE) {
        this.transferItem(u, u.pendingGive.slot, to);
        this.stop(u.id);
      } else if (!u.moving) {
        this.pathTo(u, to.x, to.y);
      }
      return;
    }
    // Walking to a shop to sell (issueSellItem). Pawning reaches only PawnItemRange (300), so
    // the hero closes the distance first — exactly as he walks over to drop an item.
    if (u.pendingSell) {
      const shop = this.units.get(u.pendingSell.shopId);
      if (!shop || shop.hp <= 0 || !u.inventory[u.pendingSell.slot]) { this.stop(u.id); return; }
      if (this.inPawnRange(u, shop)) {
        this.pawnItem(u.id, u.pendingSell.slot, shop.id);
        this.notifyCreepsOfShopUse(shop, u, MISC_GAME.ItemSaleAggroRange); // using a neutral shop is loud
        this.stop(u.id);
      } else if (!u.moving) {
        const [ax, ay] = this.shopApproach(u, shop);
        this.pathTo(u, ax, ay);
      }
      return;
    }
    const it = this.items.get(u.getItemId);
    if (!it) { this.stop(u.id); return; } // item gone (someone else grabbed it)
    if (Math.hypot(it.x - u.x, it.y - u.y) <= u.radius + ITEM_PICKUP_RANGE) {
      this.pickUpItem(u, it);
      this.stop(u.id);
    } else if (!u.moving) {
      this.pathTo(u, it.x, it.y); // arrived-but-not-close (blocked) or needs a repath
    }
  }

  /** Put a ground item into a hero's inventory. `wantSlot` >= 0 demands THAT slot and
   *  fails if it's taken (UnitAddItemToSlotById is exact — it does not fall back to a free
   *  slot); -1 takes the first free one, which is what walking over an item does. Powerups
   *  (tomes, runes, gold) are consumed instantly instead of stored. False if there's no
   *  room. Raises PICKUP_ITEM — a powerup fires it too (WC3 picks the tome up, then
   *  consumes it). */
  private pickUpItem(u: SimUnit, it: SimItem, wantSlot = -1): boolean {
    // A Mirror Image illusion carries no inventory of its own and cannot take anything off
    // the ground — it would be handing the real hero's items to a copy that is about to
    // expire. Blocked here rather than at the order, because every route in (walking over
    // an item, a right-click, a trigger's UnitAddItem) funnels through this one door.
    if (u.isIllusion) return false;
    if (!this.itemReg) return false;
    const def = this.itemReg.get(it.itemId);
    if (!def) { this.removeGroundItem(it.id); return true; }
    if (def.powerup) {
      this.noteItem(u, it, "pickup");
      this.applyPowerup(u, def);
      // A consumed powerup DIES where it lay — it doesn't just vanish. Playing the model's
      // Death clip is what gives the tome its little burst on the ground (the clip carries
      // the ToonBoom spawn event), and it is the reason `died` exists at all.
      this.removeGroundItem(it.id, true);
      return true;
    }
    const slot = wantSlot >= 0
      ? (wantSlot < u.inventory.length && !u.inventory[wantSlot] ? wantSlot : -1)
      : u.inventory.indexOf(null);
    if (slot < 0) return false; // inventory full (or that slot taken) — leave it on the ground
    u.inventory[slot] = { id: it.id, itemId: it.itemId, charges: it.charges, cooldownLeft: 0 };
    this.removeGroundItem(it.id);
    this.noteItem(u, it, "pickup");
    this.recomputeStats(u); // reflect any stat bonus immediately
    return true;
  }

  /** Hand a held item from one hero to another (drops to the ground if the
   *  recipient's inventory is full). WC3 raises BOTH events for a hand-over: the giver
   *  DROPs the item and the receiver PICKs it UP. */
  private transferItem(from: SimUnit, slot: number, to: SimUnit): void {
    // An illusion's inventory is a picture of the original's: it is there to be SEEN and to
    // grant the same stat bonuses, and nothing more. The items are inert copies with no
    // entity behind them (see initIllusion), so letting a copy move one would either
    // duplicate the original's gear or hand out an item that does not exist.
    if (from.isIllusion) return;
    const held = from.inventory[slot];
    if (!held) return;
    const dest = to.inventory.indexOf(null);
    if (dest < 0) { this.spawnGroundItem(held.itemId, to.x, to.y, held.charges, held.id); }
    else { to.inventory[dest] = { id: held.id, itemId: held.itemId, charges: held.charges, cooldownLeft: 0 }; }
    from.inventory[slot] = null;
    from.pendingGive = null;
    from.pendingSell = null;
    this.noteItem(from, held, "drop");
    this.noteItem(to, held, "pickup");
    this.recomputeStats(from);
    this.recomputeStats(to);
  }

  /** Drop a held item onto the ground at a point (WC3 manual item drop). WC3's
   *  "Item Drop Distance" gameplay constant (150) is the reach: a spot within range
   *  drops immediately; a spot further out makes the unit WALK toward it and drop
   *  once the spot comes within range (handled in tickGetItem). */
  dropItem(unitId: number, slot: number, x: number, y: number): boolean {
    const u = this.units.get(unitId);
    if (!u || slot < 0 || slot >= u.inventory.length) return false;
    const held = u.inventory[slot];
    if (!held) return false;
    if (Math.hypot(x - u.x, y - u.y) <= ITEM_DROP_RANGE + u.radius) {
      this.doDropItem(u, slot, x, y);
      return true;
    }
    // Out of reach: walk to the spot and drop it when it comes within drop range.
    u.pendingDrop = { slot, x, y };
    u.getItemId = 0;
    u.pendingGive = null;
    u.pendingSell = null;
    u.order = "getitem";
    u.targetId = null;
    u.inCombat = false;
    u.noCollision = false;
    this.cancelSwing(u);
    this.detachBuilder(unitId);
    this.pathTo(u, x, y);
    return true;
  }

  /** Actually place a slot's item on the ground at (x,y) and clear the slot. The item
   *  keeps its entity id (same item, now on the ground) and raises DROP_ITEM. */
  private doDropItem(u: SimUnit, slot: number, x: number, y: number): void {
    // An illusion's inventory is a picture of the original's: it is there to be SEEN and to
    // grant the same stat bonuses, and nothing more. The items are inert copies with no
    // entity behind them (see initIllusion), so letting a copy move one would either
    // duplicate the original's gear or hand out an item that does not exist.
    if (u.isIllusion) return;
    const held = u.inventory[slot];
    if (!held) return;
    u.inventory[slot] = null;
    u.pendingDrop = null;
    this.spawnGroundItem(held.itemId, x, y, held.charges, held.id);
    this.noteItem(u, held, "drop");
    this.recomputeStats(u);
  }

  /** Swap (or move) two inventory slots on the same unit. */
  swapItems(unitId: number, a: number, b: number): boolean {
    const u = this.units.get(unitId);
    if (u?.isIllusion) return false; // a copy's inventory is a picture — it cannot be rearranged
    if (!u || a === b || a < 0 || b < 0 || a >= u.inventory.length || b >= u.inventory.length) return false;
    const tmp = u.inventory[a];
    u.inventory[a] = u.inventory[b];
    u.inventory[b] = tmp;
    return true;
  }

  /** Use an active item in a slot (potion/scroll). Returns true if it fired (a
   *  charge was consumed / a cooldown started). Dispatches on the granted ability's
   *  base `code`, like spells. */
  useItem(unitId: number, slot: number, _targetId: number, x: number, y: number): boolean {
    // …and a copy cannot USE one either: no potion, no scroll, no charge spent. Its items
    // are not the original's, so drinking one would heal off a bottle nobody owns — and the
    // charge would not come off the real hero's.
    const u = this.units.get(unitId);
    if (!u || u.isIllusion || !this.itemReg || !this.abilities) return false;
    const held = u.inventory[slot];
    if (!held || held.cooldownLeft > 0) return false;
    const def = this.itemReg.get(held.itemId);
    if (!def || !def.usable) return false;
    // The active behaviour is the first granted ability with a code we handle.
    for (const abilId of def.abilities) {
      const ad = this.abilities.get(abilId);
      if (!ad) continue;
      const lvl = ad.levelData[0];
      const d = (i: number) => (lvl?.data[i] === undefined || Number.isNaN(lvl.data[i]) ? 0 : lvl.data[i]);
      let fired = false;
      switch (ad.code) {
        case "AIhe": // Potion of Healing / Health Stone / Scroll of Healing → restore HP
          if (u.hp < u.maxHp) { u.hp = Math.min(u.maxHp, u.hp + d(0)); fired = true; }
          break;
        case "AIma": // Potion of Mana / Scroll of Mana → restore mana
          if (u.mana < u.maxMana) { u.mana = Math.min(u.maxMana, u.mana + d(0)); fired = true; }
          break;
        // Healing Salve / Clarity Potion / Potion & Scroll of Rejuvenation — restore over
        // TIME, not at once. DataA is the total hit points and DataB the total mana the
        // effect is worth across `Dur1`, so the per-second rate is the total over the
        // duration: the Healing Salve's 400 HP / 45s, the greater Clarity Potion's 200 mana
        // / 45s, a Scroll of Rejuvenation's 250 + 100 (1.27a Units\AbilityData.slk).
        //
        // Which buff the unit visibly wears is the ability's own choice among the three it
        // lists (`BuffID1 = BIrg,BIrl,BIrm`): life-and-mana, life alone, mana alone. So the
        // numbers pick it — a salve with no DataB wears BIrl and shows only the green swirl.
        case "AIrg": {
          const seconds = lvl?.duration || 0;
          const hp = d(0);
          const mana = d(1);
          if (seconds <= 0 || (hp <= 0 && mana <= 0)) break;
          // Nothing to restore = nothing to spend. WC3 refuses a salve at full health.
          if (hp > 0 && mana <= 0 && u.hp >= u.maxHp) break;
          if (mana > 0 && hp <= 0 && u.mana >= u.maxMana) break;
          if (hp > 0 && mana > 0 && u.hp >= u.maxHp && u.mana >= u.maxMana) break;
          const buffId = hp > 0 && mana > 0 ? "BIrg" : hp > 0 ? "BIrl" : "BIrm";
          const fx = this.abilities.buffFx(buffId);
          if (hp > 0) {
            this.applyBuffInternal(u, {
              kind: "hot", group: ITEM_REGEN_GROUP, timeLeft: seconds, sourceId: u.id,
              value: hp / seconds, value2: 0, fx,
            });
          }
          if (mana > 0) {
            this.applyBuffInternal(u, {
              kind: "manaRegen", group: `${ITEM_REGEN_GROUP}:mana`, timeLeft: seconds, sourceId: u.id,
              value: mana / seconds, value2: 0, fx: hp > 0 ? [] : fx, // one set of models, not two
            });
          }
          fired = true;
          break;
        }
        case "AIvu": // Potion of Invulnerability → brief invulnerability
          this.applyBuffInternal(u, { kind: "invuln", group: "item:invuln", timeLeft: lvl?.duration || 15, sourceId: u.id, value: 0, value2: 0 });
          fired = true;
          break;
        case "AEbl": { // Kelen's Dagger of Escape → blink to a point within range
          const range = d(0) || 1000;
          const dist = Math.hypot(x - u.x, y - u.y);
          const s = dist > range ? range / dist : 1;
          const tx = u.x + (x - u.x) * s;
          const ty = u.y + (y - u.y) * s;
          this.unsettle(u);
          u.x = tx; u.y = ty;
          u.path = []; u.moving = false; u.waypoint = 0;
          this.settle(u);
          fired = true;
          break;
        }
        default:
          continue; // ability we don't handle — try the next granted ability
      }
      if (!fired) return false; // handled code but nothing to do (already full) — no charge spent
      this.consumeItemUse(u, slot, def, lvl?.cooldown || 0);
      // USE_ITEM is raised AFTER the charge is spent: GetItemCharges inside a use trigger
      // reports what's left, which is what the classic "give the item its charge back to
      // make it infinite" JASS idiom relies on (SetItemCharges(GetManipulatedItem(), n+1)).
      this.noteItem(u, held, "use");
      return true;
    }
    return false;
  }

  /** Spend a charge + start the item's cooldown (shared across its cooldown group,
   *  WC3-style: drinking one potion puts every item in that group on cooldown). */
  private consumeItemUse(u: SimUnit, slot: number, def: ItemDef, cooldown: number): void {
    const held = u.inventory[slot];
    if (!held) return;
    if (def.charges > 0) {
      held.charges -= 1;
      if (held.charges <= 0 && def.perishable) { u.inventory[slot] = null; this.recomputeStats(u); }
    }
    if (cooldown > 0) {
      held.cooldownLeft = Math.max(held.cooldownLeft, cooldown);
      if (def.cooldownGroup && this.itemReg) {
        for (const other of u.inventory) {
          if (!other || other === held) continue;
          const od = this.itemReg.get(other.itemId);
          if (od && od.cooldownGroup === def.cooldownGroup) other.cooldownLeft = Math.max(other.cooldownLeft, cooldown);
        }
      }
    }
  }

  /** Apply a powerup consumed on pickup (tomes, manuals, runes, gold/lumber),
   *  dispatched on its granted ability's base `code`. */
  private applyPowerup(u: SimUnit, def: ItemDef): void {
    if (!this.abilities) return;
    for (const abilId of def.abilities) {
      const ad = this.abilities.get(abilId);
      if (!ad) continue;
      const lvl = ad.levelData[0];
      const dv = (i: number) => (lvl?.data[i] === undefined || Number.isNaN(lvl.data[i]) ? 0 : lvl.data[i]);
      switch (ad.code) {
        // Attribute tomes (dataA=agi, dataB=int, dataC=str) — permanent, so bump the BASE
        // attribute. The HP/mana the new points confer needs no hand-adding here: the
        // recomputeStats below raises the ceiling and carries the current pool up with it in
        // proportion, the same rule every other ceiling move obeys (see recomputeStats).
        case "AIam": case "AIim": case "AIsm": case "AIxm": {
          u.baseAgi += dv(0); u.baseInt += dv(1); u.baseStr += dv(2);
          break;
        }
        case "AImi": u.baseMaxHp += dv(0); break; // Manual of Health (+max HP)
        case "AIem": if (u.isHero) this.gainXp(u, dv(0)); break; // Tome of Experience (+XP)
        case "AIha": u.hp = Math.min(u.maxHp, u.hp + dv(0)); break; // Rune of Healing
        case "AImr": u.mana = Math.min(u.maxMana, u.mana + dv(0)); break; // Rune of Mana
        case "AIra": u.hp = Math.min(u.maxHp, u.hp + dv(0)); u.mana = Math.min(u.maxMana, u.mana + dv(1)); break; // Rune of Restoration
        case "AIgo": this.stashOf(u.owner).gold += dv(0); break; // Gold Coins
        case "AIlu": this.stashOf(u.owner).lumber += dv(0); break; // Bundle of Lumber
      }
      // …and the pickup's LOOK, which is data, not per-code: the ability names a model to
      // play on the unit that took it. Which slot holds it is not consistent in the game's
      // own data — the tomes use `Targetart` (AIsm/AIam/AIim → …\AIsmTarget.mdl et al) but
      // the Tome of Experience, Manual of Health and Chest of Gold use `Casterart` for the
      // very same job — so take whichever is set. Every powerup attaches at `origin`, which
      // is where a unit-targeted effect already plays. (1.27a Units\ItemAbilityFunc.txt.)
      const art = ad.targetArt || ad.casterArt;
      if (art || ad.effectSound) this.powerupPickups.push({ unitId: u.id, art, soundLabel: ad.effectSound });
    }
    this.recomputeStats(u);
  }

  /** PowerUps consumed this frame (renderer plays the effect model + its sound). */
  drainPowerupPickups(): Array<{ unitId: number; art: string; soundLabel: string }> {
    if (!this.powerupPickups.length) return this.powerupPickups;
    const out = this.powerupPickups;
    this.powerupPickups = [];
    return out;
  }

  // === item trigger-effect API (7.18) ======================================
  // What a map's triggers reach for: create an item, give it to a hero, drop it, use
  // it, read/set its charges. Each is a thin wrapper over the item mechanics above, so
  // a trigger-driven pickup goes through exactly the same path (and raises exactly the
  // same events) as a hero walking over the item. The JASS bridge is
  // src/jass/natives/items.ts → EngineHooks; ids are ITEM entity ids (SimItem.id /
  // HeldItem.id), which is what a JASS `item` handle stands for.

  /** CreateItem — put a new item of type `typeId` on the ground. Charges default to the
   *  item's own `uses` (a Potion of Healing is created with its 1 charge). -1 if the
   *  rawcode isn't a known item type. */
  createItem(typeId: string, x: number, y: number, charges = -1): number {
    const def = this.itemReg?.get(typeId);
    if (!def) return -1;
    return this.spawnGroundItem(typeId, x, y, charges >= 0 ? charges : def.charges).id;
  }

  /** Where item `id` is right now — on the ground or in an inventory (7.18). One lookup
   *  for both, because a JASS `item` handle doesn't care which. */
  itemSnapshot(id: number): ItemSnapshot | null {
    const ground = this.items.get(id);
    // PLAYER_NEUTRAL_PASSIVE (common.j player 15) owns everything nobody carries.
    if (ground) return { id, typeId: ground.itemId, charges: ground.charges, x: ground.x, y: ground.y, holder: 0, slot: -1, owner: 15 };
    for (const u of this.units.values()) {
      const slot = u.inventory.findIndex((h) => h?.id === id);
      if (slot >= 0) {
        const held = u.inventory[slot]!;
        return { id, typeId: held.itemId, charges: held.charges, x: u.x, y: u.y, holder: u.id, slot, owner: jassOwnerOf(u) };
      }
    }
    return null;
  }

  /** Every item lying on the ground (EnumItemsInRect scans this — a carried item is not
   *  enumerable, matching WC3). */
  groundItems(): SimItem[] {
    return [...this.items.values()];
  }

  /** RemoveItem — destroy an item wherever it is (ground or inventory). */
  removeItemById(id: number): boolean {
    if (this.items.has(id)) { this.removeGroundItem(id); return true; }
    for (const u of this.units.values()) {
      const slot = u.inventory.findIndex((h) => h?.id === id);
      if (slot >= 0) {
        u.inventory[slot] = null;
        this.recomputeStats(u);
        return true;
      }
    }
    return false;
  }

  /** SetItemCharges. */
  setItemCharges(id: number, charges: number): boolean {
    const n = Math.max(0, Math.trunc(charges));
    const ground = this.items.get(id);
    if (ground) { ground.charges = n; return true; }
    for (const u of this.units.values()) {
      const held = u.inventory.find((h) => h?.id === id);
      if (held) { held.charges = n; return true; }
    }
    return false;
  }

  /** SetItemPosition — move a ground item. WC3 semantics: positioning an item a unit is
   *  CARRYING takes it out of the inventory and puts it on the ground there. */
  setItemPosition(id: number, x: number, y: number): boolean {
    const ground = this.items.get(id);
    if (ground) {
      const [sx, sy] = this.snapItemPos(x, y);
      ground.x = sx;
      ground.y = sy;
      // Re-model at the new spot (the renderer has no "move item"). Never `died` — this
      // is a reposition, and a death clip here would puff the item at its old spot.
      this.itemRemovals.push({ id, died: false });
      this.itemSpawns.push(ground);
      return true;
    }
    for (const u of this.units.values()) {
      const slot = u.inventory.findIndex((h) => h?.id === id);
      if (slot >= 0) { this.doDropItem(u, slot, x, y); return true; }
    }
    return false;
  }

  /** UnitAddItem — give an existing item to a unit (from the ground, or straight out of
   *  another unit's inventory). `wantSlot` >= 0 targets a specific slot
   *  (UnitAddItemToSlotById). False if the item is gone or the inventory is full — the
   *  item then stays exactly where it was, which is what makes blizzard.j's
   *  UnitAddItemByIdSwapped leave it at the hero's feet. */
  unitAddItem(unitId: number, itemId: number, wantSlot = -1): boolean {
    const u = this.units.get(unitId);
    if (!u || !u.inventory.length) return false;
    const ground = this.items.get(itemId);
    if (ground) return this.pickUpItem(u, ground, wantSlot);
    // Held by someone else: hand it over (the giver DROPs, the receiver PICKs UP).
    for (const from of this.units.values()) {
      const slot = from.inventory.findIndex((h) => h?.id === itemId);
      if (slot >= 0) {
        if (from.id === unitId) return true; // already his
        if (u.inventory.indexOf(null) < 0) return false;
        this.transferItem(from, slot, u);
        return true;
      }
    }
    return false;
  }

  /** UnitRemoveItem — take an item off a unit and leave it on the ground at its feet. */
  unitRemoveItem(unitId: number, itemId: number): boolean {
    const u = this.units.get(unitId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || slot < 0) return false;
    this.doDropItem(u, slot, u.x, u.y);
    return true;
  }

  /** UnitRemoveItemFromSlot — the same, by slot; returns the item id (0 = empty slot). */
  unitRemoveItemFromSlot(unitId: number, slot: number): number {
    const u = this.units.get(unitId);
    const held = u?.inventory[slot];
    if (!u || !held) return 0;
    const id = held.id;
    this.doDropItem(u, slot, u.x, u.y);
    return id;
  }

  /** UnitDropItemPoint — a trigger drops the item AT the point immediately (unlike the
   *  player's drop order, which walks the hero over first — see dropItem). */
  unitDropItemPoint(unitId: number, itemId: number, x: number, y: number): boolean {
    const u = this.units.get(unitId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || slot < 0) return false;
    this.doDropItem(u, slot, x, y);
    return true;
  }

  /** UnitDropItemSlot — despite the name, this MOVES the item within the unit's own
   *  inventory (the GUI's "Hero - Give item to slot"): a swap, not a drop. */
  unitDropItemSlot(unitId: number, itemId: number, slot: number): boolean {
    const u = this.units.get(unitId);
    const from = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || from < 0 || slot < 0 || slot >= u.inventory.length) return false;
    return from === slot || this.swapItems(unitId, from, slot);
  }

  /** UnitDropItemTarget — hand the item to another unit (the GUI's "Hero - Give item to
   *  hero"), immediately. */
  unitDropItemTarget(unitId: number, itemId: number, targetId: number): boolean {
    const u = this.units.get(unitId);
    const to = this.units.get(targetId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || !to || slot < 0 || !to.inventory.length) return false;
    this.transferItem(u, slot, to);
    return true;
  }

  /** UnitUseItem / UnitUseItemPoint / UnitUseItemTarget — fire a carried item's active
   *  effect (potion, scroll, dagger). Rides on the same useItem() the HUD's item button
   *  calls, so it spends the charge, starts the cooldown, and raises USE_ITEM. */
  unitUseItem(unitId: number, itemId: number, targetId: number, x: number, y: number): boolean {
    const u = this.units.get(unitId);
    const slot = u?.inventory.findIndex((h) => h?.id === itemId) ?? -1;
    if (!u || slot < 0) return false;
    return this.useItem(unitId, slot, targetId, x, y);
  }

  /** UnitInventorySize — how many slots the unit has (0 = no inventory ability). */
  inventorySizeOf(unitId: number): number {
    return this.units.get(unitId)?.inventory.length ?? 0;
  }

  /** UnitItemInSlot — the item entity id in a slot (0 = empty / no such slot). */
  itemInSlot(unitId: number, slot: number): number {
    return this.units.get(unitId)?.inventory[slot]?.id ?? 0;
  }

  // Idle (or patrolling) armed units scan for the nearest enemy in acquisition
  // range and turn on it. Creeps acquire within their own aggro range (from the
  // map's per-unit target-acquisition, else the weapon's), and never while asleep
  // or leashing home; acquiring rallies the rest of their camp (call-for-help).
  private tickAcquire(u: SimUnit, dt: number): void {
    if (!u.weapon) return;
    if (u.isCreep && (u.asleep || u.returning)) return;
    const range = this.acquireRange(u);
    if (range <= 0) return;
    u.acquireT -= dt;
    if (u.acquireT > 0) return;
    u.acquireT = ACQUIRE_PERIOD;
    // Creeps pick the highest-threat target (enemy units before buildings); other
    // units auto-acquire the nearest VISIBLE enemy, skipping idle creep camps. When
    // nothing's in that unit's own acquisition range, a non-creep also RALLIES to a fight
    // a nearby friend is already in — an enemy just past its own range that's attacking an
    // ally (issue #24: "units stand behind after the first kill; they should help friends
    // fighting nearby"). This is what stops a back-rank unit idling while its group fights
    // a few paces ahead. Creeps keep their own camp cohesion (campFightTarget) instead.
    const best = u.isCreep
      ? this.bestCreepTarget(u, range)
      : this.acquireTarget(u, range) ?? this.assistTarget(u, ASSIST_RANGE);
    if (best) {
      this.issueAttack(u.id, best.id);
      if (u.isCreep) {
        u.campHelper = false; // saw it with its own eyes, inside its own aggro range
        this.alertCamp(u, best);
      }
    } else if (u.isCreep) {
      // Nothing in our own aggro range, but if a camp-mate is still fighting, go
      // help — no creep sits idle at the post while its camp is in a fight.
      const help = this.campFightTarget(u);
      if (help) {
        this.issueAttack(u.id, help.id);
        u.campHelper = true; // answering the shout — don't relay it onward
      }
    }
  }

  /** Drive a Hold-Position unit: strike any hostile that is within weapon range
   *  (fog- and idle-creep-filtered, like normal auto-acquire) but NEVER move to
   *  chase — the unit stays planted where Hold was issued (issue #17). */
  private tickHold(u: SimUnit, dt: number): void {
    const w = u.weapon;
    if (!w || w.range <= 0 || u.isPeon) {
      // A worker holds its ground without swinging at anything: no auto-acquisition,
      // on Hold as anywhere else (issue #41).
      u.inCombat = false;
      this.settle(u);
      return;
    }
    // A committed swing always finishes (a unit never walks mid-strike anyway).
    if (u.swingLeft >= 0) {
      const st = this.units.get(u.swingTargetId);
      if (st) {
        this.engage(u, st, true);
        return;
      }
      this.cancelSwing(u);
    }
    // Hold onto the current target while it's still hostile, alive, and within
    // reach; otherwise re-scan (throttled) for the nearest in-range enemy.
    const reach = w.range + (u.inCombat ? ATTACK_LEASH : 0);
    let t = u.targetId !== null ? this.units.get(u.targetId) : undefined;
    if (t && !this.canAttack(u, t)) t = undefined; // nothing in hand for it (air/ground/structure)
    if (t && (!this.hostile(u, t) || t.invulnerable || Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius > reach)) t = undefined;
    if (!t) {
      u.acquireT -= dt;
      if (u.acquireT <= 0) {
        u.acquireT = ACQUIRE_PERIOD;
        t = this.acquireTarget(u, w.range) ?? undefined; // striking distance only
      }
    }
    if (t) {
      u.targetId = t.id;
      this.engage(u, t, true); // noChase — attack in place
    } else {
      u.targetId = null;
      u.inCombat = false;
      this.settle(u);
    }
  }

  /** Nearest hostile within `range` that an idle/holding non-creep unit will
   *  auto-acquire. Beyond plain hostility it must be (a) VISIBLE to the acquirer's
   *  team — WC3 units never aggro a target hidden in the fog of war — and (b) not
   *  an un-triggered neutral-hostile creep camp: you only pull a camp by attacking
   *  it or walking into its own aggro range, never by an idle unit noticing it. */
  private acquireTarget(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const t of this.units.values()) {
      if (t === u || !this.hostile(u, t)) continue;
      if (t.invulnerable) continue; // invulnerable enemies (goblin merchant, gold mine, Divine Shield, …) aren't attackable (issue #26)
      if (t.isCreep && !this.creepAggroed(t)) continue; // don't wake an idle creep camp
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap >= bestGap) continue;
      if (!this.canAttack(u, t)) continue; // a Footman never turns on the Gryphon overhead
      if (!this.canSee(u, t)) continue; // out of sight (fog, night, or a treeline) → don't aggro
      bestGap = gap;
      best = t;
    }
    return best;
  }

  /** Assist fallback for an idle unit with no enemy in its own acquisition range: rally to
   *  a fight a friend is already in. Scans our own side for allies currently ATTACKING an
   *  enemy and returns the nearest such enemy within the wider ASSIST_RANGE (issue #24:
   *  back-rank units left idle a few paces behind the fight). Keying off "an ally is
   *  attacking it" — rather than "it is attacking an ally" — is what makes this fire even
   *  when the enemy is being focused down and isn't hitting back, and it still can't pull a
   *  peaceful/un-aggroed creep camp (no ally is attacking those). */
  private assistTarget(u: SimUnit, range: number): SimUnit | null {
    let best: SimUnit | null = null;
    let bestGap = range;
    for (const ally of this.units.values()) {
      if (ally === u || ally.team !== u.team) continue; // one of our own army
      if (ally.order !== "attack" || ally.targetId === null) continue; // that is fighting
      const enemy = this.units.get(ally.targetId);
      if (!enemy || !this.hostile(u, enemy)) continue; // attacking an actual enemy of ours
      if (!this.canAttack(u, enemy)) continue; // …that we could actually contribute against
      // Distance to the FRIEND that's fighting, not to its enemy — a unit left behind is
      // near its comrades even when their enemy is farther off, and it should march up to
      // help. It then attacks the enemy that friend is engaging (and re-targets to whatever
      // it can actually reach once it arrives, via the in-strike-range switch in tickAttack).
      const gap = Math.hypot(ally.x - u.x, ally.y - u.y) - u.radius - ally.radius;
      if (gap >= bestGap) continue;
      if (!this.canSee(u, enemy)) continue; // out of sight (fog/night/treeline) → can't join that fight
      bestGap = gap;
      best = enemy;
    }
    return best;
  }

  /** True while a neutral-hostile creep is in its aggroed (fighting) state — it has
   *  a live attack target. An idle/guarding/sleeping/leashing creep is NOT aggroed,
   *  so nearby player units won't auto-attack it until the camp has been triggered. */
  private creepAggroed(c: SimUnit): boolean {
    return c.order === "attack" && c.targetId !== null && this.units.has(c.targetId);
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
          u.campHelper = false; // picked this one out of its own aggro range
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
    if (u.order === "idle" && dist > CREEP_RETURN_TRIGGER && !this.nearestEnemy(u, u.aggroRange, true)) {
      // About to walk home — but if a camp-mate is still fighting, go help instead
      // of standing down while the camp is engaged.
      const help = u.weapon ? this.campFightTarget(u) : null;
      if (help) {
        this.issueAttack(u.id, help.id);
        u.campHelper = true; // answering the shout — don't relay it onward
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
    u.campHelper = false; // out of the fight — back to guarding on its own account
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
   *  creep basics). Leashing camp-mates are left alone.
   *
   *  The call travels exactly ONE hop: everyone it rouses is flagged `campHelper`,
   *  and a helper never calls for help itself. Without that flag the shout relays —
   *  a helper is on an attack order, so the NEXT camp's idle creeps see it through
   *  campFightTarget and join, and theirs after that (issue #55: a creep 2200 units
   *  from the player, four times its own aggro range, charging out of a camp nobody
   *  touched). A creep that acquires a target itself, or that gets hit, becomes an
   *  originator again and may shout — which is the real CallForHelp rule. */
  private alertCamp(u: SimUnit, target: SimUnit): void {
    for (const c of this.units.values()) {
      if (c === u || !c.isCreep || c.hp <= 0 || c.returning) continue;
      if (!this.sameCamp(c, u)) continue;
      c.asleep = false; // rouse the camp
      if (c.order === "idle" && c.weapon && this.hostile(c, target)) {
        this.issueAttack(c.id, target.id);
        c.campHelper = true; // came for a camp-mate's shout — must not relay it
      }
    }
  }

  /** Laying a new foundation notifies the creeps around it (MiscData
   *  BuildingPlacementNotifyRadius = 600) and they come to tear it down. The radius is
   *  measured from the building's edge, and it is quite separate from acquisition range —
   *  a creep that would never have noticed a Peasant walking past at 600 charges the
   *  moment he plants a Town Hall there.
   *
   *  Only "Normal" creeps answer. The map's per-creep targetAcquisition is a two-way flag,
   *  Normal (-1) or Camp (-2), and across every shipped melee map the mapmakers set Normal
   *  on exactly the camps guarding a gold mine and Camp on all the rest. That lines up with
   *  what players observe — "all creeps who protect a gold mine will be aggressive and other
   *  creeps will be passive, so you more safely can build near them" (warcraft3.info,
   *  "Interacting With Creeps") — so we read Camp as "deaf to construction". The split is an
   *  inference from those two facts together, not something any file states outright.
   *
   *  The notified creep is an originator (it was shouted at directly), so it may call its
   *  own camp in — that is how one Peasant's foundation brings the whole mine camp. */
  private notifyCreepsOfPlacement(b: SimUnit): void {
    for (const c of this.units.values()) {
      if (!c.isCreep || c.hp <= 0 || c.returning || c.campGuard || !c.weapon) continue;
      if (!this.hostile(c, b)) continue;
      if (Math.hypot(b.x - c.x, b.y - c.y) - b.radius > BUILDING_PLACEMENT_NOTIFY_RADIUS) continue;
      c.asleep = false;
      c.campHelper = false; // notified in its own right — it may shout for the rest of the camp
      this.issueAttack(c.id, b.id);
      this.alertCamp(c, b);
    }
  }

  /** A hostile currently being fought by a live camp-mate of `u`, or null. Used to
   *  keep the camp committed as one: while any member is engaged, the rest rejoin
   *  rather than idling at the post or peeling off home — even when the fight has
   *  been kited out near the leash limit (the exact case where a lone creep used to
   *  be left fighting while its camp sat back).
   *
   *  Only an ORIGINATOR anchors the camp — one that acquired the enemy inside its own
   *  aggro range or was struck by it. A camp-mate that is itself only answering a shout
   *  (campHelper) is skipped, so the call can't hop from camp to camp (issue #55). */
  private campFightTarget(u: SimUnit): SimUnit | null {
    for (const c of this.units.values()) {
      if (c === u || !c.isCreep || c.hp <= 0 || c.returning || c.campHelper) continue;
      if (c.order !== "attack" || c.targetId === null) continue;
      if (!this.sameCamp(c, u)) continue;
      const t = this.units.get(c.targetId);
      if (t && this.hostile(u, t) && this.canAttack(u, t)) return t;
    }
    return null;
  }

  // --- movement -----------------------------------------------------------

  /** Proactive reroute (issue #6). Every REPATH_POLL seconds a moving ground unit
   *  re-checks the path just ahead; if another unit has stopped and reserved cells
   *  across it since the path was computed, recompute the route toward the same
   *  goal so we steer AROUND the crowd instead of forcing through it. Applies to
   *  every moving footprint unit — player move/attack/patrol orders and creeps
   *  returning home alike — because they all set chaseX/chaseY via pathTo(). Cheap
   *  by design: the lookahead scan runs on the poll tick and only the genuinely-
   *  blocked minority pay for a fresh A*; a moving crowd reserves no cells, so we
   *  never thrash rerouting around our own squadmates. checkStuck() stays the
   *  backstop for the boxed-in case where no better route exists. */
  private repathPoll(u: SimUnit, dt: number): void {
    // Flyers (footprint 0) path straight and ignore ground occupancy; ghosting
    // workers (mining) pass through units, so neither reroutes.
    if (u.footprint <= 0 || u.noCollision) return;
    if (u.repathT > 0) return; // just got blocked — honour the chaser repath cooldown
    u.repollT -= dt;
    if (u.repollT > 0) return;
    u.repollT = REPATH_POLL;
    if (u.waypoint >= u.path.length) return; // nothing left to walk
    if (!this.pathAheadBlocked(u)) return;
    this.pathTo(u, u.chaseX, u.chaseY); // reroute toward the same goal
  }

  /** True when the remaining path — out to REPATH_LOOKAHEAD ahead — now runs
   *  through a cell the mover's footprint no longer fits, i.e. a unit has stopped
   *  and reserved cells across our route. Cheap: a bounded half-cell walk of the
   *  path polyline, no A*. Uses the SAME clearance predicate A* would, so it only
   *  flags obstructions A* would actually route around. */
  private pathAheadBlocked(u: SimUnit): boolean {
    const start = this.grid.worldToCell(u.x, u.y);
    const blocked = this.clearanceBlocker(u, start);
    if (!blocked) return false; // footprint-less mover — nothing to check
    const stepLen = PATHING_CELL * 0.5;
    let remaining = REPATH_LOOKAHEAD;
    let px = u.x;
    let py = u.y;
    for (let i = u.waypoint; i < u.path.length && remaining > 0; i++) {
      const [wx, wy] = u.path[i];
      const segDx = wx - px;
      const segDy = wy - py;
      const segLen = Math.hypot(segDx, segDy);
      if (segLen > 0) {
        const ux = segDx / segLen;
        const uy = segDy / segLen;
        for (let d = stepLen; d <= segLen && remaining > 0; d += stepLen) {
          const [cx, cy] = this.grid.worldToCell(px + ux * d, py + uy * d);
          if (blocked(cx, cy)) return true;
          remaining -= stepLen;
        }
      }
      px = wx;
      py = wy;
    }
    return false;
  }

  /** Set a path toward a world point (straight line for air units). False when
   *  no movement toward the point is possible at all. */
  private pathTo(u: SimUnit, tx: number, ty: number, maxExpansions?: number): boolean {
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
    const blocked = this.clearanceBlocker(u, start);
    const cells = findPath(this.grid, start, this.grid.worldToCell(tx, ty), blocked, maxExpansions);
    // A single-cell (or empty) result means the unit can't get any closer.
    if (!cells || cells.length <= 1) {
      if (wasReserved) this.settle(u);
      return false;
    }
    // String-pull the raw A* staircase into straight runs (same clearance
    // predicate, so it never routes anywhere A* wouldn't). This makes the unit
    // glide straight toward each turn-point instead of stepping cell-to-cell in
    // 45° increments — the per-segment heading (and thus facing) then tracks the
    // real travel direction rather than zig-zagging and snapping on arrival.
    const smoothed = smoothPath(this.grid, cells, blocked);
    // Cell centres as waypoints. When the path actually reaches the target cell
    // (best-effort paths stop short), finish on the footprint-aligned point so
    // the unit settles exactly onto the cells it will reserve.
    const pts = smoothed.slice(1).map(([cx, cy]) => this.grid.cellToWorld(cx, cy)) as Array<[number, number]>;
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

  /** WC3-style clearance test for pathfinding: the mover's own n×n cell footprint
   *  must fit on statically-walkable, unreserved cells at every path node. A
   *  reserved cell is exempt ONLY where it belongs to the unit's OWN starting
   *  footprint — so a unit that spawned overlapping others (or that another unit
   *  settled on top of) can still path out of its own cells, without the exemption
   *  extending to neighbours (a 3×3 margin let a unit hugging a reserved wall route
   *  straight through it — half the "units squeeze through" of issue #24). */
  private clearanceBlocker(
    self: SimUnit,
    start: [number, number],
  ): ((cx: number, cy: number) => boolean) | undefined {
    const n = self.footprint;
    if (n <= 0) return undefined;
    const [sx, sy] = start;
    const half = n >> 1;
    const ownX0 = sx - half; // the unit's own footprint (reservation-exempt) origin
    const ownY0 = sy - half;
    return (cx, cy) => {
      const cx0 = cx - half;
      const cy0 = cy - half;
      for (let y = cy0; y < cy0 + n; y++) {
        for (let x = cx0; x < cx0 + n; x++) {
          if (!this.grid.walkable(x, y)) return true;
          if (this.grid.isReserved(x, y)) {
            const own = x >= ownX0 && x < ownX0 + n && y >= ownY0 && y < ownY0 + n;
            if (!own) return true;
          }
        }
      }
      return false;
    };
  }

  private tickMovement(dt: number): void {
    for (const u of this.units.values()) {
      if (!u.moving) continue;
      // Proactively reroute around units that have stopped across our path since
      // it was computed (issue #6), before we grind into them (checkStuck backstop).
      this.repathPoll(u, dt);
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
        const isLast = u.waypoint === u.path.length - 1;
        const [wx, wy] = u.path[u.waypoint];
        const dx = wx - u.x;
        const dy = wy - u.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= ARRIVE_EPS) {
          u.waypoint++;
          continue;
        }
        const ux = dx / dist;
        const uy = dy / dist;
        const step = Math.min(budget, dist);
        u.x += ux * step;
        u.y += uy * step;
        budget -= step;
        // Steer facing from real travel segments only. pathTo appends a sub-cell
        // "footprint-snap" nudge as the final waypoint (so even-footprint units
        // settle onto their reserved corner without a position pop); that nudge
        // points along an arbitrary axis/diagonal and must NOT hijack the heading
        // on the last ticks — leave desiredFacing on the true approach heading.
        if (!(isLast && dist < PATHING_CELL)) {
          dirX = ux;
          dirY = uy;
        }
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
        // A plain move ends here. An attack-move only ends when it has actually
        // reached its destination — a path that ended mid-chase (or short of the
        // goal) stays an attack-move so tickAttackMove keeps fighting/advancing.
        const arrived =
          u.order === "move" ||
          (u.order === "attackmove" && Math.hypot(u.amDestX - u.x, u.amDestY - u.y) <= PATHING_CELL * 1.5);
        if (arrived) {
          // Flip to idle BEFORE settling so a finished attack-move fans out at its
          // destination exactly like a move does — settle() only spreads onto a free
          // tile for non-combat orders, and while the order still reads "attackmove" it
          // would cram every unit onto the one destination tile instead (issue #24: make
          // attack-move's arrival behave like move). Its en-route fighting is unchanged.
          u.order = "idle";
          this.settle(u); // snaps onto the grid, to a free tile if this one's taken (fan-out)
          // Keep the heading the unit travelled with: pin desiredFacing onto the
          // current facing so the shared turning pass (which keeps rotating even
          // a stopped unit toward desiredFacing) has nothing left to do. Without
          // this a unit that arrived mid-turn would keep swivelling to its last
          // path segment after halting — a visible "snap". u.facing is still last
          // tick's smoothed travel heading here (the turning pass runs later this
          // tick), so it lands facing the way it came — as WC3 units do. Belt-and-
          // suspenders alongside path smoothing + the final-nudge guard above.
          u.desiredFacing = u.facing;
        } else {
          this.settle(u); // attack-move paused mid-chase (or a short move): settle in place
        }
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


  // Fan stopped air units apart (issue #31). Flyers cruise with no collision (they
  // fly over everything), so a moving group is a single point and they stack exactly
  // on top of each other once they arrive or converge on a target. WC3 flyers don't
  // stack: the moment they stop they glide apart until their hulls clear. So this
  // acts on air units that are NOT moving — i.e. those that have reached their
  // destination or are holding position while fighting — and leaves cruising flyers
  // untouched (they still pass freely through the air). Both units in an overlapping
  // pair are stationary, so the correction is split evenly and each drifts out; the
  // per-unit step is capped to a share of its move speed so a clump spreads over a
  // few frames instead of popping. Air-vs-air only; ground collision is separate.
  private resolveAirSeparation(dt: number): void {
    const list: SimUnit[] = [];
    for (const u of this.units.values())
      if (u.flying && u.radius > 0 && !u.moving && !u.noCollision && u.hp > 0) list.push(u);
    if (list.length < 2) return;
    // Accumulate every pair's desired push, then apply once (capped) per unit — so a
    // flyer buried in a stack drifts out smoothly instead of jerking pair-by-pair.
    const pushX = new Float64Array(list.length);
    const pushY = new Float64Array(list.length);
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
          // Exact stack (a group that arrived on one point): split along a
          // deterministic per-unit heading (golden angle, no RNG — the sim is
          // lockstep) so the pile bursts into a ring rather than a single line.
          const ang = a.id * 2.399963;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const half = (min - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        pushX[i] -= nx * half;
        pushY[i] -= ny * half;
        pushX[j] += nx * half;
        pushY[j] += ny * half;
      }
    }
    for (let i = 0; i < list.length; i++) {
      let px = pushX[i];
      let py = pushY[i];
      const mag = Math.hypot(px, py);
      if (mag <= 1e-6) continue;
      const maxStep = list[i].speed * AIR_FANOUT_SPEED * dt;
      if (maxStep > 0 && mag > maxStep) {
        px = (px / mag) * maxStep;
        py = (py / mag) * maxStep;
      }
      list[i].x += px;
      list[i].y += py;
    }
  }

  // Move a unit, but never onto an unwalkable cell (don't push units into walls).
  private nudge(u: SimUnit, dx: number, dy: number): void {
    const nx = u.x + dx;
    const ny = u.y + dy;
    // Collision separation must honour the pathing grid, not brute-force through it
    // (issue #24: "units squeeze through others that don't fit"). A shove may only slide
    // a unit to a spot where its whole FOOTPRINT fits: never onto unwalkable terrain,
    // and never DEEPER into cells another (settled) unit has reserved. Checking only the
    // centre cell's walkability — as this did — let repeated shoves in a crowd walk a
    // unit's centre straight through a standing unit or a gap too small for its body.
    // "Deeper" (not "any overlap") is deliberate: a unit that a settle() reserved on top
    // of can still be pushed OUT, and moving units (which hold no reservation) still
    // separate normally via the circle push — only intrusion into reserved cells is
    // blocked, which is exactly the grid's "this tile isn't reachable for your size".
    if (!this.footprintWalkableAt(u, nx, ny)) return;
    if (this.footprintReservedAt(u, nx, ny) > this.footprintReservedAt(u, u.x, u.y)) return;
    u.x = nx;
    u.y = ny;
  }

  /** True if every cell under `u`'s footprint centred at world (wx,wy) is walkable
   *  terrain. Footprint-less movers (radius 0 / flyers) test just the centre cell. */
  private footprintWalkableAt(u: SimUnit, wx: number, wy: number): boolean {
    const [cx, cy] = this.grid.worldToCell(wx, wy);
    const n = u.footprint;
    if (n <= 0) return this.grid.walkable(cx, cy);
    const half = n >> 1;
    for (let y = cy - half; y < cy - half + n; y++)
      for (let x = cx - half; x < cx - half + n; x++)
        if (!this.grid.walkable(x, y)) return false;
    return true;
  }

  /** How many cells under `u`'s footprint centred at (wx,wy) are reserved by settled
   *  units — the "how far into someone else's space" measure nudge() guards on. */
  private footprintReservedAt(u: SimUnit, wx: number, wy: number): number {
    const n = u.footprint;
    if (n <= 0) return 0;
    const [cx, cy] = this.grid.worldToCell(wx, wy);
    const half = n >> 1;
    let count = 0;
    for (let y = cy - half; y < cy - half + n; y++)
      for (let x = cx - half; x < cx - half + n; x++)
        if (this.grid.isReserved(x, y)) count++;
    return count;
  }
}

// Fallback launch/impact height (units above ground) for missiles whose weapon has
// no launch data — every real ranged unit's impactz is ~60, so this matches the game.
const DEFAULT_MISSILE_HEIGHT = 60;

// World-space launch point for a missile: the unit origin plus the weapon's LOCAL
// (launchX forward, launchY left, launchZ up) offset, rotated by facing. WC3
// UnitWeapons.slk launchx/y/z — e.g. the Archmage's fireball leaves from his rod.
// Returns [worldX, worldY, heightAboveGround].
function launchPoint(u: SimUnit, lx: number, ly: number, lz: number): [number, number, number] {
  const c = Math.cos(u.facing);
  const s = Math.sin(u.facing);
  return [u.x + lx * c - ly * s, u.y + lx * s + ly * c, lz];
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
