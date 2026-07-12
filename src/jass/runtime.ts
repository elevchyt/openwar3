// JASS runtime state (Phase 7 — issue #33; see docs/triggers.md).
//
// Holds everything a running map script needs that isn't the AST: the handle
// table (opaque reference ids → JS objects), the player table + accumulated map
// setup (what config() builds), globals/arrays, the function & native registries,
// a seeded RNG (determinism for future server-authoritative MP — Phase 8), and a
// thin, optional bridge to our actual engine (EngineHooks). The interpreter drives
// this; natives read/write it. Keeping the runtime free of any renderer/vfs import
// is deliberate — the interpreter must stay engine-agnostic (bridge, not fork).

import type { FunctionDecl } from "./ast";
import { type JassValue, JNULL, jHandle } from "./values";

/** A trigger object (CreateTrigger) — its conditions + actions (function names)
 *  and enabled flag. The engine fires it when a registered event occurs (7.4). */
export interface TriggerObj {
  handleId: number;
  actions: string[]; // function names added via TriggerAddAction
  conditions: string[]; // function names wrapped by TriggerAddCondition
  enabled: boolean;
}

/** A `boolexpr` — a condition wrapping a `code` (function ref), from Condition()/
 *  Filter(). We keep only the function name; And/Or/Not compose these later. */
export interface BoolExpr {
  fn: string;
}

/** A floating text tag (CreateTextTag — the "Floating Text" trigger actions). A
 *  live, mutable object the renderer polls (source of truth is this record, not a
 *  one-shot push hook — WC3 renders a text tag continuously as its setters mutate
 *  it, so an eager "emit on SetTextTagText" would snapshot it mid-configuration,
 *  e.g. before CreateTextTagLocBJ has set the position). `height`/`size` are the
 *  screen-relative font height the natives store; the BJ helpers scale from a font
 *  "size" via TextTagSize2Height (size 10 → 0.023). */
export interface TextTagObj {
  handleId: number;
  text: string;
  x: number;
  y: number;
  z: number; // height offset above the terrain/unit
  size: number; // screen-relative font height (SetTextTagText's `height` arg)
  color: number; // 0xAARRGGBB
  visible: boolean;
  permanent: boolean;
  lifespan: number; // seconds (0 = use permanent/engine default)
  age: number;
  velX: number;
  velY: number;
  suspended: boolean;
  followUnit: number; // sim id of the unit it tracks (SetTextTagPosUnit), or -1
  dead: boolean; // DestroyTextTag'd — the renderer should drop it
}

/** A rectangular region (Rect / the World-Editor `gg_rct_*` globals). Its bounds
 *  drive enter/leave-region events: the live pump tests each unit's (x,y) against
 *  every registered rect and fires the trigger on a crossing. */
export interface RectObj {
  handleId: number;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

/** A region (CreateRegion) — a set of rects (RegionAddRect). Cell-granular adds
 *  (RegionAddCell) are approximated by a 1×1-ish rect around the cell. */
export interface RegionObj {
  handleId: number;
  rects: number[]; // rect handle ids
}

/** A game timer (CreateTimer/TimerStart). Pumped by Interpreter.advanceTime from
 *  the sim tick; on expiry it runs its handler code and fires any trigger
 *  registered on it (TriggerRegisterTimerExpireEvent). */
export interface TimerObj {
  handleId: number;
  timeout: number; // seconds
  periodic: boolean;
  remaining: number; // seconds until next expiry
  running: boolean;
  elapsedTotal: number; // seconds since TimerStart (for TimerGetElapsed)
  handlerFn: string | null; // the `code` passed to TimerStart, run on expiry
}

/** One event→trigger registration (TriggerRegister*Event). `kind` is our internal
 *  event tag; `params` are the extra args (rect, timer, unit, playerunitevent id…)
 *  the dispatcher matches against when the sim raises that event. */
export interface TriggerReg {
  kind: string;
  trigId: number; // handle id of the registered trigger
  params: JassValue[];
  /** Unit-state registrations only (EVENT_UNIT_STATE_LIMIT): did the comparison hold
   *  last time we looked? That event is POLLED (nothing in the sim raises "life changed"),
   *  and it must fire on the rising edge, so we remember the previous truth. Seeded at
   *  REGISTRATION — a unit already past the limit then is not a crossing, but one pushed
   *  past it later in the same tick is. */
  edge?: boolean;
}

/** Apply a common.j `limitop` (a ConvertLimitOp index) to a value/limit pair — the
 *  comparison behind the unit-state / player-state threshold events.
 *  0 LESS_THAN, 1 LESS_THAN_OR_EQUAL, 2 EQUAL, 3 GREATER_THAN_OR_EQUAL, 4 GREATER_THAN,
 *  5 NOT_EQUAL. An unknown op never fires (rather than fire always). */
export function compareLimit(op: number, value: number, limit: number): boolean {
  switch (op) {
    case 0: return value < limit;
    case 1: return value <= limit;
    case 2: return value === limit;
    case 3: return value >= limit;
    case 4: return value > limit;
    case 5: return value !== limit;
    default: return false;
  }
}

/** A player slot as config() fills it in (mirrors the SetPlayer* natives). */
export interface JassPlayer {
  index: number; // 0–15
  handleId: number; // its entry in the handle table
  color: number; // ConvertPlayerColor index (0–11)
  controller: number; // MAP_CONTROL_*: 1 user, 2 computer, 3 rescuable, 4 neutral
  race: number; // RACE_PREF_* index
  raceSelectable: boolean;
  team: number; // SetPlayerTeam (defaults to own index)
  startLocation: number; // SetPlayerStartLocation index (-1 = unset)
  forcedStartLocation: boolean;
  name?: string; // SetPlayerName; GetPlayerName defaults to "Player N" (see playerName)
  /** GetPlayerSlotState — a `playerslotstate` index: 0 EMPTY, 1 PLAYING, 2 LEFT. The
   *  map script can't know this (it's the lobby's answer), so the host supplies it via
   *  applyLobby. blizzard.j's whole melee library gates on it: MeleeStartingResources /
   *  MeleeClearExcessUnits / MeleeStartingUnits each skip a slot that isn't PLAYING. */
  slotState: number;
  /** GetPlayerRace — a `race` index (common.j ConvertRace): 1 HUMAN, 2 ORC, 3 UNDEAD,
   *  4 NIGHTELF. NOT the same enum as `race` above, which is the map's RACE_PREF_*
   *  preference; this is the race the player actually plays (a lobby "random" already
   *  resolved), and it's what MeleeStartingUnits branches on. */
  raceIndex: number;
}

/** One playing slot as the host's lobby resolved it — the handoff into the script
 *  (Runtime.applyLobby). Everything blizzard.j's melee library needs to know about a
 *  slot that config() can't tell it: is it actually being played, by whom, as what. */
export interface LobbySlot {
  index: number; // player slot 0–11
  /** Resolved race (a "random" pick is already made): common.j ConvertRace index. */
  raceIndex: number;
  controller: number; // MAP_CONTROL_*: 1 user, 2 computer
  team: number;
  startLocation: number;
}

/** A unit created by the script (CreateUnit). Kept so main()/CreateAllUnits can be
 *  cross-checked against war3mapUnits.doo (the 7.2 oracle) even with no engine
 *  attached, and so bridge lookups can map a unit handle back to our sim id. */
export interface JassUnit {
  handleId: number;
  player: number;
  typeId: string; // 4-char rawcode (e.g. "hfoo")
  x: number;
  y: number;
  facing: number;
  simId: number; // our engine's sim id, or -1 when running headless
  /** SetUnitUserData / GetUnitUserData — the "custom value" every unit carries. Pure
   *  script state (the engine never reads it), so it lives on the handle. */
  userData?: number;
}

/** A minimal live view of a sim unit the engine feeds the interpreter: the event
 *  pumps (enter-region, death, …) and group enumeration (EngineHooks.enumUnits). */
export interface UnitSnapshot {
  id: number;
  typeId: string;
  owner: number;
  x: number;
  y: number;
  facing: number;
}

/** An item created by the script (CreateItem) or minted for one the sim already has
 *  (a creep drop a trigger picks up). A JASS `item` is ONE entity whether it lies on
 *  the ground or sits in a hero's inventory, so the handle keeps only its identity —
 *  everything mutable (charges, where it is, who holds it) is read live through the
 *  bridge (EngineHooks.itemInfo), exactly as a unit handle reads GetUnitX (7.18). */
export interface JassItem {
  handleId: number;
  simId: number; // item entity id in the sim (-1 = headless, no engine attached)
  typeId: string; // 4-char item rawcode
  /** Last-known charges/position — the fallback when there's no bridge (headless). */
  charges: number;
  x: number;
  y: number;
  /** SetItemUserData — pure script state (the engine never reads it), like a unit's. */
  userData?: number;
  /** Per-instance flags WC3 keeps on the item itself. Our sim models none of them (an
   *  item on the ground is neither hideable nor destructible here), so they live on the
   *  handle: set and read back faithfully, but only the script observes them (the
   *  `IsItem…` readers and CheckItemStatus, which the GUI conditions ride on). */
  visible?: boolean;
  invulnerable?: boolean;
  droppable?: boolean;
  pawnable?: boolean;
}

/** Where an item is right now — the bridge's answer for a JASS `item` handle. Mirrors
 *  SimWorld.ItemSnapshot (structural, so the interpreter needn't import the sim). */
export interface ItemSnapshot {
  id: number;
  typeId: string;
  charges: number;
  x: number;
  y: number;
  holder: number; // sim id of the unit carrying it (0 = lying on the ground)
  slot: number; // inventory slot when carried, else -1
  owner: number; // GetItemPlayer — the holder's slot, or 15 (Neutral Passive) on the ground
}

/** An item TYPE's data (our ItemRegistry) — what GetItemLevel / GetItemType /
 *  IsItemPowerup / IsItemSellable ask about the item's *class*, not the instance. */
export interface ItemTypeInfo {
  name: string;
  level: number;
  classType: string; // ItemData.slk `class`: Permanent/Charged/PowerUp/Artifact/…
  powerup: boolean;
  sellable: boolean;
  pawnable: boolean;
}

/** What config() (and the setup natives) accumulate — the map's declared player
 *  setup + start locations. Cross-checked against war3map.w3i (the free oracle). */
export interface MapSetup {
  mapName: string;
  mapDescription: string;
  numPlayers: number;
  numTeams: number;
  placement: number; // MAP_PLACEMENT_*
  startLocations: Map<number, { x: number; y: number }>;
  players: Map<number, JassPlayer>;
}

/** The engine operations JASS natives call into. Implemented by src/jass/bridge.ts
 *  over SimWorld/RtsController; every method is optional so the interpreter runs
 *  headlessly (config-only, or corpus tests) with no engine attached. `typeId` is
 *  the 4-char rawcode string (e.g. "hfoo"); unit ids are our engine's sim ids. */
export interface EngineHooks {
  createUnit?(player: number, typeId: string, x: number, y: number, facing: number): number;
  setResourceAmount?(unitId: number, amount: number): void;
  setUnitAcquireRange?(unitId: number, range: number): void;
  setUnitState?(unitId: number, whichState: number, value: number): void;
  getUnitState?(unitId: number, whichState: number): number; // GetUnitState (life/mana/…)
  setUnitColor?(unitId: number, color: number): void; // SetUnitColor — team-colour tint
  removeUnit?(unitId: number): void; // RemoveUnit — no death/corpse
  killUnit?(unitId: number): void; // KillUnit — death animation + corpse
  hideUnit?(unitId: number, hidden: boolean): void;
  // --- unit-mutation effects (7.7 cont. — a trigger visibly moves/alters a unit) ---
  setUnitPosition?(unitId: number, x: number, y: number): void; // SetUnitPosition/X/Y/Loc (teleport)
  setUnitFacing?(unitId: number, facingRad: number, instant: boolean): void; // SetUnitFacing[Timed]
  setUnitOwner?(unitId: number, player: number, changeColor: boolean): void; // SetUnitOwner
  pauseUnit?(unitId: number, flag: boolean): void; // PauseUnit
  isUnitPaused?(unitId: number): boolean; // IsUnitPaused
  setUnitScale?(unitId: number, scale: number): void; // SetUnitScale (render)
  setUnitVertexColor?(unitId: number, r: number, g: number, b: number, a: number): void; // SetUnitVertexColor (0–1)
  setUnitFlyHeight?(unitId: number, height: number): void; // SetUnitFlyHeight
  getUnitFlyHeight?(unitId: number): number; // GetUnitFlyHeight
  setUnitMoveSpeed?(unitId: number, speed: number): void; // SetUnitMoveSpeed
  getUnitMoveSpeed?(unitId: number): number; // GetUnitMoveSpeed
  setUnitTurnSpeed?(unitId: number, turn: number): void; // SetUnitTurnSpeed
  setUnitTimeScale?(unitId: number, scale: number): void; // SetUnitTimeScale (animation rate)
  // Live position/facing reads — a script-created unit's JASS handle otherwise keeps
  // its spawn-time values, so route Get* through the sim when a sim id is attached.
  getUnitX?(unitId: number): number;
  getUnitY?(unitId: number): number;
  getUnitFacing?(unitId: number): number;
  // --- orders (7.14): IssueXOrder → sim; GetUnitCurrentOrder ← sim ---
  /** Issue{Immediate,Point,Target}Order — order id + target kind → the matching sim
   *  command (a trigger-issued unit marches/attacks/casts). Returns whether the order
   *  took. `order` is the order STRING ("attack", "holybolt"): an ABILITY order is cast
   *  by name (the engine's numeric ids for those aren't in any data file), so the bridge
   *  matches it against the unit's abilities' own order strings. */
  issueUnitOrder?(unitId: number, orderId: number, order: string, kind: "immediate" | "point" | "target", x: number, y: number, targetId: number): boolean;
  /** GetUnitCurrentOrder — the unit's active sim order as a generic order id (0 = none). */
  getUnitCurrentOrder?(unitId: number): number;
  // --- unit groups (7.16): enumeration + the classification a group filter asks about ---
  /** Every unit currently in the sim — what GroupEnumUnitsInRect/InRange/OfPlayer/… scan. */
  enumUnits?(): ReadonlyArray<UnitSnapshot>;
  /** The units `player` currently has selected (GroupEnumUnitsSelected). */
  selectedUnits?(player: number): number[];
  /** IsUnitType — a unittype classification by its common.j ConvertUnitType index
   *  (0 HERO, 1 DEAD, 2 STRUCTURE, 3 FLYING, …); the workhorse of "matching" filters.
   *  `typeId` is the unit's rawcode, so a unit that has already left the sim (a corpse —
   *  what GetDyingUnit hands a death trigger) can still be classified from its type. */
  isUnitType?(unitId: number, unitType: number, typeId?: string): boolean;
  /** IsUnitAlly/IsUnitEnemy — is the unit allied to `player` (same team)? */
  isUnitAlly?(unitId: number, player: number): boolean;
  /** IsPlayerAlly/IsPlayerEnemy — are two player slots on the same team? */
  isPlayerAlly?(player: number, other: number): boolean;
  // --- abilities + heroes (7.17): a trigger grants a spell, levels a hero ---
  /** UnitAddAbility / UnitRemoveAbility — `abilityId` is the 4-char ability rawcode. */
  unitAddAbility?(unitId: number, abilityId: string): boolean;
  unitRemoveAbility?(unitId: number, abilityId: string): boolean;
  /** GetUnitAbilityLevel — the unit's rank in an ability (0 = it doesn't have it). */
  getUnitAbilityLevel?(unitId: number, abilityId: string): number;
  /** SetUnitAbilityLevel / Inc / Dec — set the rank; returns the resulting rank. */
  setUnitAbilityLevel?(unitId: number, abilityId: string, level: number): number;
  /** SelectHeroSkill — learn a hero ability, spending a skill point. */
  selectHeroSkill?(unitId: number, abilityId: string): boolean;
  /** UnitResetCooldown — clear every ability cooldown on the unit. */
  resetUnitCooldown?(unitId: number): void;
  /** GetHeroLevel / GetUnitLevel — a hero's level (0 for a non-hero). */
  getUnitLevel?(unitId: number): number;
  /** SetHeroLevel — level the hero up to `level` (WC3 never levels one down). */
  setHeroLevel?(unitId: number, level: number): void;
  /** GetHeroXP / SetHeroXP / AddHeroXP — the hero's experience. */
  getHeroXp?(unitId: number): number;
  setHeroXp?(unitId: number, xp: number): void;
  addHeroXp?(unitId: number, xp: number): void;
  /** GetHeroSkillPoints / UnitModifySkillPoints — unspent skill points. */
  getHeroSkillPoints?(unitId: number): number;
  modifySkillPoints?(unitId: number, delta: number): boolean;
  // --- items (7.18): the trigger surface for items + the item events ---
  /** CreateItem — a new item of type `typeId` on the ground; returns its entity id (-1
   *  if the rawcode isn't a known item). Its model appears through the sim's normal
   *  ground-item spawn queue, so a trigger-created item looks like any other. */
  createItem?(typeId: string, x: number, y: number): number;
  /** RemoveItem — destroy it, wherever it is (ground or inventory). */
  removeItem?(itemId: number): void;
  /** Where the item is + what's left of it (null once it's gone). The live read behind
   *  GetItemX/Y/Charges/TypeId, IsItemOwned, GetItemPlayer. */
  itemInfo?(itemId: number): ItemSnapshot | null;
  setItemCharges?(itemId: number, charges: number): void;
  /** SetItemPosition — move a ground item; on a CARRIED item WC3 drops it there. */
  setItemPosition?(itemId: number, x: number, y: number): void;
  /** The item TYPE's data (GetItemLevel / GetItemType / IsItemIdPowerup / …). */
  itemTypeInfo?(typeId: string): ItemTypeInfo | null;
  /** UnitAddItem (+ …ToSlotById): give an existing item to a unit — `slot` < 0 = first
   *  free. False if the inventory is full, which is what leaves a UnitAddItemById item
   *  lying at the hero's feet (blizzard.j creates it there first, then adds it). */
  unitAddItem?(unitId: number, itemId: number, slot: number): boolean;
  unitRemoveItem?(unitId: number, itemId: number): boolean; // → the ground at the unit
  unitRemoveItemFromSlot?(unitId: number, slot: number): number; // → item id (0 = empty)
  unitDropItemPoint?(unitId: number, itemId: number, x: number, y: number): boolean;
  /** UnitDropItemSlot — MOVES the item to another slot of the same unit (not a drop). */
  unitDropItemSlot?(unitId: number, itemId: number, slot: number): boolean;
  unitDropItemTarget?(unitId: number, itemId: number, targetId: number): boolean; // hand over
  /** UnitUseItem[Point|Target] — fire the item's active effect (potion/scroll/dagger). */
  unitUseItem?(unitId: number, itemId: number, targetId: number, x: number, y: number): boolean;
  unitInventorySize?(unitId: number): number;
  unitItemInSlot?(unitId: number, slot: number): number; // → item id (0 = empty slot)
  /** EnumItemsInRect — every item lying on the ground (a carried one isn't enumerable). */
  enumItems?(): ReadonlyArray<ItemSnapshot>;
  /** ChooseRandomItem(Ex) — a random item rawcode of a class + level ("" = none). */
  chooseRandomItem?(classType: string | null, level: number): string;
  // --- per-unit flags / animation (7.17) ---
  setUnitInvulnerable?(unitId: number, flag: boolean): void; // SetUnitInvulnerable
  setUnitPathing?(unitId: number, flag: boolean): void; // SetUnitPathing (false = ghost)
  /** SetUnitAnimation / ResetUnitAnimation — play the named clip ("" resets to stand). */
  setUnitAnimation?(unitId: number, animation: string): void;
  /** Player resource / state: SetPlayerState & GetPlayerState. `state` is the raw
   *  playerstate index (1 = gold, 2 = lumber, 4 = food cap, 5 = food used). */
  setPlayerState?(player: number, state: number, value: number): void;
  getPlayerState?(player: number, state: number): number;
  /** On-screen chat/message line (DisplayTextToPlayer & the timed variant). `duration`
   *  is seconds for the timed native, or < 0 for the untimed one (host default). Only
   *  the local player's messages should reach the HUD (the BJ force helpers gate that). */
  displayText?(player: number, msg: string, duration: number): void;
  /** Clear the on-screen messages (ClearTextMessages / the BJ force variant). */
  clearText?(player: number): void;
  /** Resolve a unit's display name (GetUnitName / GetHeroProperName) from our data
   *  tables — the interpreter only knows the rawcode, the engine knows the name. */
  unitName?(unitId: number): string | undefined;
  /** Resolve an object (unit/ability/…) name from its rawcode (GetObjectName). */
  objectName?(typeId: string): string | undefined;
  // --- melee from the script (7.3) — what blizzard.j's Melee* library reaches for ---
  /** Set/get the game clock (SetFloatGameState(GAME_STATE_TIME_OF_DAY) — and the
   *  Set/GetTimeOfDay BJs that ride on it). A melee game opens at 08:00
   *  (bj_MELEE_STARTING_TOD), which is MeleeStartingVisibility's whole job. */
  setTimeOfDay?(hour: number): void;
  getTimeOfDay?(): number;
  /** SetCameraPosition / SetCameraQuickPosition (via the …ForPlayer BJs, which gate on
   *  GetLocalPlayer). MeleeStartingUnits* centres the view on the starting workers. */
  setCameraPosition?(x: number, y: number): void;
  /** GetResourceAmount — a gold mine's remaining gold. */
  getResourceAmount?(unitId: number): number;
  /** CreateBlightedGoldmine — the Undead start "replaces" the nearest gold mine with a
   *  haunted one (BlightGoldMineForPlayerBJ removes the mine, then creates this at the
   *  same spot). Returns the sim id of the mine that now stands there. */
  createBlightedGoldMine?(player: number, x: number, y: number, facing: number): number;
  /** GetPlayerStructureCount / GetPlayerUnitCount — melee defeat is "my team owns no
   *  structures", so these decide who has lost (MeleeCheckForLosersAndVictors). */
  playerStructureCount?(player: number, includeIncomplete: boolean): number;
  playerUnitCount?(player: number, includeIncomplete: boolean): number;
  /** GetPlayerTypedUnitCount — count a player's units of one internal TYPE name (the
   *  `name` column of UnitUI.slk: "townhall", "greathall", …). Melee asks for the four
   *  main halls: owning none while still holding structures is what "crippled" means. */
  playerTypedUnitCount?(player: number, typeName: string, includeIncomplete: boolean, includeUpgrades: boolean): number;
}

/** Opaque handle store: integer ids → backing JS objects, with interning so
 *  stable references (players, enum constants like PLAYER_COLOR_RED) return the
 *  same id every time — which makes JASS `==` on them work by id equality. */
class HandleTable {
  private nextId = 1;
  private table = new Map<number, unknown>();
  private interned = new Map<string, number>();

  alloc(obj: unknown): number {
    const id = this.nextId++;
    this.table.set(id, obj);
    return id;
  }
  get(id: number): unknown {
    return this.table.get(id);
  }
  free(id: number): void {
    this.table.delete(id);
  }
  intern(key: string, make: () => unknown): number {
    const existing = this.interned.get(key);
    if (existing !== undefined) return existing;
    const id = this.alloc(make());
    this.interned.set(key, id);
    return id;
  }
}

/** Thrown when `TriggerSleepAction` is reached somewhere it cannot park the caller —
 *  a condition, a boolexpr filter, a `ForGroup`/`ForForce` callback, or a function called
 *  from an expression. WC3 doesn't support a wait in those places either. We must not
 *  simply ignore it: blizzard.j's `PolledWait` loops until its timer drains, so a no-op
 *  wait would busy-loop to the iteration cap. Aborting that one callback is the safe
 *  answer — the interpreter catches this at the synchronous-call boundary (runSync). */
export class ThreadAbort {}

/** A boxed JASS array (fixed 8192 slots in the real engine — JASS_MAX_ARRAY_SIZE).
 *  Sparse map + a per-type default so unset slots read as 0/0.0/false/null. */
export class JassArray {
  private data = new Map<number, JassValue>();
  constructor(public readonly elemType: string, private makeDefault: () => JassValue) {}
  get(i: number): JassValue {
    return this.data.get(i) ?? this.makeDefault();
  }
  set(i: number, v: JassValue): void {
    this.data.set(i, v);
  }
}

/** mulberry32 — a tiny deterministic PRNG. JASS GetRandomInt/Real must be
 *  reproducible for replays / server-authoritative sync, so we never use
 *  Math.random(). Seed is fixed unless the host overrides it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Runtime {
  readonly handles = new HandleTable();
  readonly setup: MapSetup = {
    mapName: "",
    mapDescription: "",
    numPlayers: 0,
    numTeams: 0,
    placement: 0,
    startLocations: new Map(),
    players: new Map(),
  };
  /** Global variables (name → value) and arrays (name → JassArray). */
  readonly globals = new Map<string, JassValue>();
  readonly globalArrays = new Map<string, JassArray>();
  /** User functions and engine natives, by name. */
  readonly functions = new Map<string, FunctionDecl>();
  readonly natives = new Map<string, (ctx: NativeCtx, args: JassValue[]) => JassValue>();
  /** A native's declared return type (from common.j) — so an unimplemented native
   *  can still return a correctly-typed default instead of undefined. */
  readonly nativeReturns = new Map<string, string>();
  private warned = new Set<string>();

  /** Event-response stack (thread-local in the real engine): each fired trigger
   *  pushes a frame so GetTriggerUnit/GetEnteringUnit/… read the current event. */
  readonly eventStack: Array<Map<string, JassValue>> = [];

  /** Event→trigger registrations (TriggerRegister*Event) the dispatcher scans when
   *  the sim raises an event, and the live timers advanceTime() pumps. */
  readonly triggerRegs: TriggerReg[] = [];
  readonly timers: TimerObj[] = [];
  /** Live floating text tags (CreateTextTag). The renderer polls this list; dead
   *  entries (DestroyTextTag) are flagged so it can drop them. */
  readonly textTags: TextTagObj[] = [];
  /** Seconds of game time elapsed (advanced from the sim tick). */
  gameTime = 0;

  /** Units the script has created (CreateUnit), in creation order. */
  readonly units: JassUnit[] = [];

  /** war3map.wts trigger-string table (id → text). The compiled script refers to
   *  authored strings by placeholder ("TRIGSTR_019"); resolveTrigStr swaps them in. */
  readonly trigStrings = new Map<number, string>();

  /** A stable JASS `unit` handle for one of our SIM units (sim id → handle id), so
   *  the live event pump can hand a trigger a usable GetTriggerUnit/GetEnteringUnit.
   *  Interned so the same sim unit is always the same handle (JASS `==` works). */
  private readonly simUnitHandles = new Map<number, number>();

  /** The same, for ITEM entities (sim item id → `item` handle id) — see itemForSim. */
  private readonly simItemHandles = new Map<number, number>();

  /** The selected game type (common.j ConvertGameType index): 1 = MELEE,
   *  4 = USE_MAP_SETTINGS (custom). Drives blizzard.j InitGenericPlayerSlots and
   *  GetGameTypeSelected — the host sets it from the map's melee flag. */
  gameType = 4;

  /** Which slot the human at this machine is playing (GetLocalPlayer). Everything
   *  "for me" is gated on it: the BJ text helpers (IsPlayerInForce(GetLocalPlayer())),
   *  SetCameraPositionForPlayer, the local selection. The lobby's user slot isn't
   *  always 0, so the host sets this with applyLobby. */
  localPlayer = 0;

  /** Functions whose `CreateUnit` calls must be RECORDED, not spawned (7.3). The map's
   *  pre-placed units are already on the map — the viewer renders war3mapUnits.doo and
   *  the engine adopts those widgets — so re-running the script's CreateAllUnits would
   *  double every creep, shop and mine. The gate is scoped to the CALL (spawnDepth,
   *  bumped in Interpreter.callUserG), not to main(): the melee-init trigger runs inside
   *  main() too, and MeleeStartingUnits' town hall and workers must spawn for real. */
  readonly recordOnlySpawnFns = new Set(["CreateAllUnits"]);
  spawnDepth = 0;
  get spawnSuppressed(): boolean {
    return this.spawnDepth > 0;
  }

  /** Time-of-day scale (SetTimeOfDayScale) — kept here; the sim owns the clock itself. */
  timeOfDayScale = 1;
  /** SetPlayerTechMaxAllowed / GetPlayerTechMaxAllowed — "player:tech" → cap. We have no
   *  tech-limit system yet (MeleeStartingHeroLimit sets the 3-hero + 1-per-type caps), so
   *  this just records what the script asked for; -1 means "no limit", as in WC3. */
  readonly techMaxAllowed = new Map<string, number>();

  readonly random: () => number;
  hooks: EngineHooks | null = null;

  constructor(seed = 0x9e3779b9) {
    this.random = mulberry32(seed);
  }

  /** Hand the lobby's resolved slots to the script (7.3), between config() and main().
   *  config() declares what the MAP allows (slots, races, start locations); the lobby
   *  decides who is actually PLAYING, as which race, on which team — and blizzard.j's
   *  melee library reads exactly that through GetPlayerSlotState / GetPlayerRace /
   *  GetPlayerStartLocation. Slots the lobby didn't fill are marked EMPTY, so they get
   *  no starting units, no resources, and keep the creep camp on their start location. */
  applyLobby(slots: ReadonlyArray<LobbySlot>, localPlayer: number): void {
    this.localPlayer = localPlayer;
    for (let i = 0; i < 12; i++) this.ensurePlayer(i).slotState = 0; // PLAYER_SLOT_STATE_EMPTY
    for (const s of slots) {
      const p = this.ensurePlayer(s.index);
      p.slotState = 1; // PLAYER_SLOT_STATE_PLAYING
      p.raceIndex = s.raceIndex;
      p.controller = s.controller;
      p.team = s.team;
      if (s.startLocation >= 0) p.startLocation = s.startLocation;
    }
  }

  /** A stable, interned player handle for slot `index` (Player(i) returns the same
   *  handle every call). The backing object is its JassPlayer setup record. */
  playerHandle(index: number): JassValue {
    const id = this.handles.intern(`player:${index}`, () => this.ensurePlayer(index));
    return jHandle(id, "player");
  }
  ensurePlayer(index: number): JassPlayer {
    let p = this.setup.players.get(index);
    if (!p) {
      p = {
        index,
        handleId: 0,
        color: index,
        controller: 4, // default neutral until config sets it
        race: 0,
        raceSelectable: false,
        team: index,
        startLocation: -1,
        forcedStartLocation: false,
        slotState: 0, // PLAYER_SLOT_STATE_EMPTY until the lobby says otherwise
        raceIndex: 0,
      };
      this.setup.players.set(index, p);
    }
    return p;
  }

  /** Bind a script-created unit (CreateUnit) to its sim id, so a later enumeration or
   *  event pump (unitForSim) hands back the SAME handle instead of minting a second one
   *  for the same unit — JASS `==`, IsUnitInGroup and GetTriggerUnit all compare by
   *  handle id, so one sim unit must mean exactly one handle. */
  bindSimUnit(u: JassUnit): void {
    if (u.simId >= 0) this.simUnitHandles.set(u.simId, u.handleId);
  }

  /** Intern (or refresh) a JASS `unit` handle backing sim unit `u`. The handle's
   *  fields (position/owner/facing) are kept live so GetUnitX/GetOwningPlayer read
   *  the current value. Used by the live enter/leave-region pump — these sim units
   *  weren't created through the interpreter's CreateUnit (they're .doo-adopted). */
  unitForSim(u: { id: number; typeId: string; owner: number; x: number; y: number; facing: number }): JassValue {
    let hid = this.simUnitHandles.get(u.id);
    if (hid === undefined) {
      const ju: JassUnit = { handleId: 0, player: u.owner, typeId: u.typeId, x: u.x, y: u.y, facing: u.facing, simId: u.id };
      ju.handleId = this.handles.alloc(ju);
      this.simUnitHandles.set(u.id, (hid = ju.handleId));
    } else {
      const ju = this.handles.get(hid) as JassUnit;
      ju.x = u.x;
      ju.y = u.y;
      ju.facing = u.facing;
      ju.player = u.owner;
    }
    return jHandle(hid, "unit");
  }

  /** Intern (or refresh) a JASS `item` handle for sim item `id` — the item counterpart of
   *  unitForSim. One item entity = one handle, so an item a trigger created, then a hero
   *  picked up, is the SAME handle in `GetManipulatedItem()` (JASS `==`, UnitHasItem and
   *  GetItemTypeId all compare/read by handle). Items the script never created (a creep
   *  drop) get their handle minted here on first sight. */
  itemForSim(it: { id: number; typeId: string; charges: number; x: number; y: number }): JassValue {
    let hid = this.simItemHandles.get(it.id);
    if (hid === undefined) {
      const ji: JassItem = { handleId: 0, simId: it.id, typeId: it.typeId, charges: it.charges, x: it.x, y: it.y };
      ji.handleId = this.handles.alloc(ji);
      this.simItemHandles.set(it.id, (hid = ji.handleId));
    } else {
      const ji = this.handles.get(hid) as JassItem;
      ji.charges = it.charges;
      ji.x = it.x;
      ji.y = it.y;
    }
    return jHandle(hid, "item");
  }

  /** Bind a script-created item (CreateItem) to its sim id, so the pickup/drop/use event
   *  pump hands back the same handle rather than minting a second one for one item. */
  bindSimItem(it: JassItem): void {
    if (it.simId >= 0) this.simItemHandles.set(it.simId, it.handleId);
  }

  /** Resolve a "TRIGSTR_nnn" placeholder to its war3map.wts text (the World Editor
   *  refers to authored strings by id). Non-placeholder strings pass through, as do
   *  ids with no table entry (best-effort — keep the raw string rather than blank). */
  resolveTrigStr(s: string): string {
    if (this.trigStrings.size === 0 || !s.startsWith("TRIGSTR_")) return s;
    const id = parseInt(s.slice("TRIGSTR_".length), 10);
    return Number.isNaN(id) ? s : this.trigStrings.get(id) ?? s;
  }

  /** A player's display name: SetPlayerName's value, else WC3's "Player N" default
   *  (1-based, so slot 0 → "Player 1"). Used by GetPlayerName. */
  playerName(index: number): string {
    return this.setup.players.get(index)?.name ?? `Player ${index + 1}`;
  }

  /** An interned handle for an enum-like constant (playercolor, race, mapcontrol,
   *  …). `index` is the constant's integer value; equality then works by id. */
  enumHandle(kind: string, index: number): JassValue {
    const id = this.handles.intern(`${kind}:${index}`, () => ({ kind, index }));
    return jHandle(id, kind);
  }
  /** Read the integer index out of an enum-like handle (or -1). */
  enumIndex(v: JassValue): number {
    if (v.k !== "handle") return -1;
    const obj = this.handles.get(v.h) as { index?: number } | undefined;
    return obj?.index ?? -1;
  }

  /** Resolve a handle value to its backing JS object (or undefined). */
  data<T>(v: JassValue): T | undefined {
    return v.k === "handle" ? (this.handles.get(v.h) as T | undefined) : undefined;
  }

  /** Log an unimplemented/failed native once (never spam; never crash the map). With no
   *  `detail` this is the plain "native we haven't written yet" case; with one it's a real
   *  diagnostic (a throwing action, an abandoned wait) and says so instead. */
  warnOnce(name: string, detail?: string): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    console.info(detail ? `[jass] '${name}' — ${detail}` : `[jass] native '${name}' not implemented — safe default`);
  }

  /** The current event-response value (top frame), or null. */
  eventResponse(key: string): JassValue {
    for (let i = this.eventStack.length - 1; i >= 0; i--) {
      const v = this.eventStack[i].get(key);
      if (v) return v;
    }
    return JNULL;
  }
}

/** Does a unit-state registration's comparison hold RIGHT NOW? (`TriggerRegisterUnitStateEvent`
 *  params: unit, unitstate, limitop, limitval.) Reads the live sim through the bridge; a unit
 *  with no sim unit (headless, or already dead) reads false. Shared by the registration
 *  (which seeds the edge) and the poll that fires on a crossing. */
export function unitStateHolds(rt: Runtime, reg: TriggerReg): boolean {
  const u = rt.data<JassUnit>(reg.params[0] ?? JNULL);
  if (!u || u.simId < 0) return false;
  const value = rt.hooks?.getUnitState?.(u.simId, rt.enumIndex(reg.params[1] ?? JNULL)) ?? 0;
  const limit = reg.params[3] ?? JNULL;
  return compareLimit(rt.enumIndex(reg.params[2] ?? JNULL), value, limit.k === "real" || limit.k === "int" ? limit.n : 0);
}

/** Context handed to every native: the runtime plus a way to call back into JASS
 *  (needed by ConditionalTriggerExecute, ForForce, TriggerEvaluate, Filter, …). */
export interface NativeCtx {
  rt: Runtime;
  call(fnName: string, args: JassValue[]): JassValue;
  /** Fire a sim-style event to matching registrations right now (synchronously),
   *  from inside a native — used by SetUnitOwner to raise EVENT_PLAYER_UNIT_CHANGE_OWNER
   *  the moment the owner changes. Provided by the interpreter; absent when a native
   *  runs with no interpreter attached (safe no-op). */
  fireEvent?(kind: string, responses: Map<string, JassValue>, matches?: (params: JassValue[]) => boolean): void;
}
