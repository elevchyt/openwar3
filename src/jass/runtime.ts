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
   *  command (a trigger-issued unit marches/attacks). Returns whether the order took. */
  issueUnitOrder?(unitId: number, orderId: number, kind: "immediate" | "point" | "target", x: number, y: number, targetId: number): boolean;
  /** GetUnitCurrentOrder — the unit's active sim order as a generic order id (0 = none). */
  getUnitCurrentOrder?(unitId: number): number;
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

  /** The selected game type (common.j ConvertGameType index): 1 = MELEE,
   *  4 = USE_MAP_SETTINGS (custom). Drives blizzard.j InitGenericPlayerSlots and
   *  GetGameTypeSelected — the host sets it from the map's melee flag. */
  gameType = 4;

  readonly random: () => number;
  hooks: EngineHooks | null = null;

  constructor(seed = 0x9e3779b9) {
    this.random = mulberry32(seed);
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
      };
      this.setup.players.set(index, p);
    }
    return p;
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
