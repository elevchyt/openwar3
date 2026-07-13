import { PATHING_CELL, footprintCells, type PathingGrid } from "./pathing";
import { findPath, smoothPath } from "./pathfind";
import { type AbilityRegistry, type AbilityDef, type AbilityLevel, requiredHeroLevel } from "../data/abilities";
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
import { SPELL_HANDLERS, AURA_BUFFS, waveSchedule, WAVE_FIELDS, type SpellApi, type SimBuffInit, type SpellFieldInit } from "./spells";

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
  range: number; // measured between collision hulls, WC3-style
  // Pre-upgrade baselines, straight off this slot's UnitWeapons columns.
  baseDamage: number;
  baseDice: number;
  baseRange: number;
  baseCooldown: number;
  baseDamagePoint: number;
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
      range: s.range,
      baseDamage: s.damage,
      baseDice: s.dice,
      baseRange: s.range,
      baseCooldown: s.cooldown,
      baseDamagePoint: s.damagePoint,
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

export type SimOrder = "idle" | "move" | "attackmove" | "patrol" | "hold" | "attack" | "follow" | "harvest" | "return" | "repair" | "cast" | "getitem";

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
  | "root" // value = move-slow fraction (Entangling Roots pins to 1.0); can still attack
  | "ethereal"; // Banish: value = move-slow fraction; can't attack, immune to physical
  //            damage but takes +66% from Magic/Spells (see u.ethereal, EtherealDamageBonus)

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
  private itemRemovals: number[] = []; // ground items picked up/destroyed (drop their model)
  // Per-unit creep drop tables, seeded at spawn (map .doo), rolled on death.
  private unitDrops = new Map<number, ItemDropSet[]>();
  // --- spell / ability event channels drained by the renderer each frame ---
  // Spell effect models to play at a unit/point (targetArt/casterArt/areaArt).
  private spellEffects: Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean }> = [];
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
  private summonRequests: Array<{ unitId: string; x: number; y: number; facing: number; owner: number; team: number; summonLeft: number; sourceId: number }> = [];

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

  /** How far from a shop a patron may stand — the shop ability's "Activation Radius"
   *  (AbilityData.slk DataA). WC3 puts it on the ability, not the building: `Aall`
   *  ("Shop Sharing, Allied Bldg", on the Arcane Vault and the other race shops) is 600,
   *  while the neutral `Aneu`/`Ane2` ("Select Hero"/"Select Unit", on the Goblin Merchant,
   *  Tavern, Mercenary Camp) is 450. Note this is NOT MiscData's NeutralUseNotifyRadius=900,
   *  which is the radius the shop SHOUTS to nearby creeps when used — a different thing that
   *  we honour separately in notifyCreepsOfShopUse(). */
  private shopRadius(typeId: string): number {
    const def = this.unitReg?.get(typeId);
    if (!def || !this.abilities) return DEFAULT_SHOP_RADIUS;
    for (const abilId of def.abilities) {
      const a = this.abilities.get(abilId);
      if (!a) continue;
      if (a.code === "Aall" || a.code === "Aneu") {
        const r = a.levelData[0]?.data[0];
        if (r && !Number.isNaN(r)) return r;
      }
    }
    return DEFAULT_SHOP_RADIUS;
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
          } else if (job.kind === "upgrade") {
            this.morphBuilding(u, job.unitId);
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
  private morphBuilding(u: SimUnit, toTypeId: string): void {
    const def = this.unitReg?.get(toTypeId);
    if (!def) return;
    const frac = u.maxHp > 0 ? Math.min(1, u.hp / u.maxHp) : 1;
    const from = u.typeId;
    u.typeId = toTypeId;
    u.baseMaxHp = def.hitPoints;
    u.baseArmor = def.armor;
    u.baseSightDay = def.sightDay;
    u.baseSightNight = def.sightNight;
    // What it produces is a property of the TYPE, so re-derive it: a structure that only gains
    // a training list on upgrade would otherwise never get a rally point.
    if (u.building && this.techReg) {
      const t = this.techReg.get(toTypeId);
      u.building.producesUnits = t.trains.length > 0 || t.sellunits.length > 0;
    }
    this.recomputeStats(u); // maxHp now reflects the new type (+ any Masonry already researched)
    u.hp = Math.max(1, u.maxHp * frac);
    this.tech?.invalidate(); // a Keep satisfies requirements a Town Hall does not
    this.morphs.push({ unitId: u.id, from, to: toTypeId });
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
    if (u.building) for (const bid of [...u.building.builderIds]) this.detachBuilder(bid);
    if (u.constructing) this.detachBuilder(u.id);
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
      | "invulnerable"
      | "baseInvulnerable"
      | "mechanical"
      | "isPeon"
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
      invulnerable: !!opts?.baseInvulnerable, // recomputeStats keeps this in sync each tick
      baseInvulnerable: !!opts?.baseInvulnerable,
      mechanical: !!opts?.mechanical,
      isPeon: !!opts?.isPeon,
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
    speed: number; maxHp: number;
  } {
    const b = { str: 0, agi: 0, int: 0, damage: 0, armor: 0, attackSpeed: 0, manaRegen: 0, lifesteal: 0, speed: 0, maxHp: 0 };
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
      else if (b.kind === "invuln") invuln = true;
    }
    // Masonry-style `rhpo` is a PERCENTAGE of the base pool, applied before the flat `rhpx`
    // adds (Animal War Training's +150). Current HP is not topped up — researching Masonry
    // raises a damaged building's ceiling, it does not heal it.
    u.maxHp = (u.baseMaxHp + HP_PER_STR * dStr) * (1 + upg.hpPct) + upg.hp + item.maxHp;
    u.maxMana = u.baseMaxMana + MANA_PER_INT * dInt + upg.mana;
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
    // Attack speed scales cooldown AND damage point together (verified: thehelper
    // "attack speed animations" thread — agility/haste divides both by the same
    // factor, so the strike lands proportionally sooner as the unit swings faster).
    // Item attack-speed (Gloves of Haste) adds to the haste side.
    const speedFactor = (1 + slowAttack) / (1 + hasteAttack + item.attackSpeed + upg.attackSpeed);
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
      w.cooldown = w.baseCooldown * speedFactor;
      w.damagePoint = w.baseDamagePoint * speedFactor;
      w.spillDist = w.baseSpillDist + upg.spillDist; // Storm Hammers — see the spill fields on SimWeapon
      w.spillRadius = w.baseSpillRadius + upg.spillRadius;
    }
    // Re-pick the primary: an upgrade may have just switched the unit's first live slot.
    u.weapon = u.weapons.find((w) => w.enabled) ?? null;
    if (u.weapon) u.bonusDamage = u.weapon.damage - (u.weapon.baseDamage + primaryDelta); // the buff/aura/item portion
    if (u.worker) u.worker.lumberCapacity = u.worker.baseLumberCapacity + upg.lumber; // Improved/Advanced Lumber Harvesting
    u.sightDay = u.baseSightDay + upg.sight;
    u.sightNight = u.baseSightNight + upg.sight;
    u.speed = Math.max(0, (u.baseSpeed + upg.speed + item.speed) * (1 - slowMove) * (1 + hasteMove));
    u.manaRegen = (u.isHero ? REGEN_PER_INT * u.int : u.baseMaxMana > 0 ? UNIT_MANA_REGEN : 0) + manaRegenBonus + item.manaRegen + upg.manaRegen;
    u.hpRegen = (u.isHero ? REGEN_PER_STR * u.str : 0) + hpRegenBonus;
    u.lifesteal = Math.max(lifesteal, item.lifesteal);
    // Spiked Carapace also returns a fraction of melee damage (dataA), like Thorns.
    u.thorns = Math.max(thorns, carapace ? this.dataOf(carapace, 0) : 0);
    u.stunned = stun;
    u.silenced = silence;
    u.ethereal = ethereal; // Banish: weapon disabled + physical immunity (see applyDamage, issueAttack)
    u.invulnerable = invuln || u.baseInvulnerable; // buffs (Divine Shield/Avatar) OR the unit type's Avul (issue #26)
    // Item attribute contribution (shown as green "+N" / red "-N" beside the stat).
    u.bonusStr = item.str;
    u.bonusAgi = item.agi;
    u.bonusInt = item.int;
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
      this.clearCast(u); // interrupted mid-cast → SPELL_ENDCAST
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
    if (this.castLocked(u)) return false; // already committed to a spell — see castLocked
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
      committed: false,
      fired: false,
      channelLeft: 0,
      backLeft: 0,
      ended: false,
      resume,
    };
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
      if (!t || !this.castableTarget(u, t, def.targetFlags)) {
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
    this.recomputeStats(hero); // new maxHp/maxMana/attributes
    hero.hp = hero.maxHp; // WC3: leveling fully restores HP and mana
    hero.mana = hero.maxMana;
    this.levelUps.push({ unitId: hero.id, level: hero.level }); // renderer: level-up nova
    // EVENT_(PLAYER_)HERO_LEVEL for the trigger engine (7.17) — a separate queue from
    // the renderer's, since each side drains its own.
    if (this.captureHeroEvents) this.heroEvents.push({ hero: eventInfo(hero), phase: "level", level: hero.level, abilityId: "" });
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
    // Untyped ability damage ignores armor; a Banished (ethereal) target takes +66%
    // (ETHEREAL_SPELL_BONUS — the file's Spells column), the flip side of its physical
    // immunity (issue #49).
    spellDamage: (t, amount, src) => this.landDamage(t, t.ethereal ? amount * ETHEREAL_SPELL_BONUS : amount, src, false),
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
    emitEffect: (art, x, y, targetId, life) => {
      if (art) this.spellEffects.push({ art, x, y, targetId, z: 0, life });
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
  getUnitX(id: number): number {
    return this.units.get(id)?.x ?? 0;
  }
  getUnitY(id: number): number {
    return this.units.get(id)?.y ?? 0;
  }
  getUnitFacing(id: number): number {
    return this.units.get(id)?.facing ?? 0;
  }
  getUnitMoveSpeed(id: number): number {
    return this.units.get(id)?.speed ?? 0;
  }
  getUnitFlyHeight(id: number): number {
    return this.units.get(id)?.flyHeight ?? 0;
  }

  // === drains (renderer pulls these each frame) =============================

  /** Repeating area fields running RIGHT NOW (Blizzard, Rain of Fire, …). Unlike the
   *  drain* channels this is a live view, not a one-shot queue: the renderer polls it
   *  each frame to sustain a channel's looping bed and to stop it the moment the field
   *  ends — whether it exhausted its waves or the caster was interrupted. */
  activeSpellFields(): Array<{ code: string; x: number; y: number }> {
    return this.spellFields.map((f) => ({ code: f.code, x: f.x, y: f.y }));
  }

  /** Spell/effect models to play this frame (targetId>0 = follow that unit). */
  drainSpellEffects(): Array<{ art: string; x: number; y: number; targetId: number; z: number; life?: number; sound?: boolean }> {
    if (!this.spellEffects.length) return this.spellEffects;
    const out = this.spellEffects;
    this.spellEffects = [];
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
  drainSummonRequests(): Array<{ unitId: string; x: number; y: number; facing: number; owner: number; team: number; summonLeft: number; sourceId: number }> {
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
    this.applyAuras(); // refresh aura buffs on in-range allies (before recompute)
    for (const u of this.units.values()) {
      if (this.tickBuffs(u, dt)) continue; // decay timed effects (a DoT may kill)
      this.recomputeStats(u); // derive armour/speed/damage/regen/stun/invuln
      this.tickRegen(u, dt); // mana + (hero) hp regeneration
      if (u.cooldownLeft > 0) u.cooldownLeft -= dt;
      if (u.repathT > 0) u.repathT -= dt;
      for (const a of u.abilities) if (a.cooldownLeft > 0) a.cooldownLeft -= dt;
      for (const it of u.inventory) if (it && it.cooldownLeft > 0) it.cooldownLeft -= dt;
      if (u.summonLeft > 0) {
        u.summonLeft -= dt;
        if (u.summonLeft <= 0) {
          this.kill(u); // temporary summon (Water Elemental) expired
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
  private canSee(u: SimUnit, t: SimUnit): boolean {
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
    if (w.ranged) {
      this.spawnProjectile(u, t, w);
    } else {
      // Melee connects if the target is still within the same reach the unit is
      // allowed to swing from (range + the combat-hold leash) — NOT the tighter
      // ARRIVE_EPS, which left a dead band where the attack animation played but
      // the strike whiffed and no damage landed against a target drifting away.
      const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
      if (gap <= w.range + ATTACK_LEASH) this.dealDamage(u, t, w);
    }
  }

  /** Cancel any pending swing (unit re-tasked away from its attack). */
  private cancelSwing(u: SimUnit): void {
    u.swingLeft = -1;
  }

  /** Launch a homing projectile from attacker to target. Damage is rolled now
   *  and applied when it lands (armor is applied at impact). */
  private spawnProjectile(u: SimUnit, t: SimUnit, w: SimWeapon): void {
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
      damage: this.rollDamage(w),
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
  private dealDamage(attacker: SimUnit, target: SimUnit, w: SimWeapon): void {
    // Critical Strike (Blademaster passive AOcr): a chance to multiply the swing.
    const raw = this.applyCriticalStrike(attacker, this.rollDamage(w));
    const dealt = this.applyDamage(target, raw, attacker.id, w.attackType);
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

  private applyDamage(target: SimUnit, rawDamage: number, attackerId: number, attackType = AttackType.None): number {
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
        const attacker = this.units.get(attackerId);
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
    const reduction = armorDamageReduction(target.armor);
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
    // Sleep (Dreadlord) breaks the instant the sleeper takes damage (WC3).
    if (target.buffs.some((b) => b.kind === "sleep")) target.buffs = target.buffs.filter((b) => b.kind !== "sleep");
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
    const passive = target.isPeon || this.harvesting(target);
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
    this.rollCreepDrops(u); // creeps scatter their dropped-item table on death
    this.dropInventory(u); // a dying hero/inventory-unit drops its held items
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

  /** A dying inventory-holder (a hero) scatters its held items on the ground. Each one
   *  keeps its entity id (it's the same item, now lying down) and raises DROP_ITEM —
   *  WC3 fires the drop event for a dying hero's inventory too. */
  private dropInventory(u: SimUnit): void {
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

  /** Ground items removed since the last drain (renderer drops their models). */
  drainItemRemovals(): number[] {
    if (!this.itemRemovals.length) return this.itemRemovals;
    const out = this.itemRemovals;
    this.itemRemovals = [];
    return out;
  }

  private removeGroundItem(id: number): void {
    if (this.items.delete(id)) this.itemRemovals.push(id);
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
    if (!this.itemReg) return false;
    const def = this.itemReg.get(it.itemId);
    if (!def) { this.removeGroundItem(it.id); return true; }
    if (def.powerup) {
      this.noteItem(u, it, "pickup");
      this.applyPowerup(u, def);
      this.removeGroundItem(it.id);
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
    const u = this.units.get(unitId);
    if (!u || !this.itemReg || !this.abilities) return false;
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
        // Attribute tomes (dataA=agi, dataB=int, dataC=str) — permanent, so bump the
        // BASE attribute + gain the HP/mana the new points confer.
        case "AIam": case "AIim": case "AIsm": case "AIxm": {
          const dAgi = dv(0), dInt = dv(1), dStr = dv(2);
          u.baseAgi += dAgi; u.baseInt += dInt; u.baseStr += dStr;
          u.hp += HP_PER_STR * dStr; u.mana += MANA_PER_INT * dInt;
          break;
        }
        case "AImi": u.baseMaxHp += dv(0); u.hp += dv(0); break; // Manual of Health (+max HP)
        case "AIem": if (u.isHero) this.gainXp(u, dv(0)); break; // Tome of Experience (+XP)
        case "AIha": u.hp = Math.min(u.maxHp, u.hp + dv(0)); break; // Rune of Healing
        case "AImr": u.mana = Math.min(u.maxMana, u.mana + dv(0)); break; // Rune of Mana
        case "AIra": u.hp = Math.min(u.maxHp, u.hp + dv(0)); u.mana = Math.min(u.maxMana, u.mana + dv(1)); break; // Rune of Restoration
        case "AIgo": this.stashOf(u.owner).gold += dv(0); break; // Gold Coins
        case "AIlu": this.stashOf(u.owner).lumber += dv(0); break; // Bundle of Lumber
      }
    }
    this.recomputeStats(u);
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
      this.itemRemovals.push(id); // re-model at the new spot (the renderer has no "move item")
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
