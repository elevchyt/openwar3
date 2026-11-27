// JASS tree-walking interpreter (Phase 7 — issue #33; see docs/triggers.md).
//
// Evaluates a loaded JassProgram: initialises globals, then runs functions on
// demand (config(), main(), trigger callbacks). Design rules that matter:
//   • int vs real arithmetic is type-directed (integer/ integer truncates) — see
//     values.ts. This is why we track the value kind rather than using JS numbers.
//   • JASS `and`/`or` DO NOT short-circuit — both operands are always evaluated
//     (a well-known JASS gotcha; it's why generated GUI code nests `if`s instead
//     of using `and`). We match that so side-effecting operands behave correctly.
//   • never hard-crash the map: an unknown function/variable or a failed native
//     logs once and yields a typed default (CLAUDE.md "safe default" rule). A
//     runaway loop/recursion is capped rather than hanging the browser.
//   • trigger actions run on a THREAD that `TriggerSleepAction` can suspend (7.15).
//     That's why the statement/call layer is written as generators: a wait can occur
//     anywhere inside a trigger's actions, so every enclosing call must be resumable.
//     Expressions stay synchronous (see JassThread + runSync below).

import type { BinOp, Expr, FunctionDecl, JassProgram, Stmt, VarDecl } from "./ast";
import { rawcodeToInt } from "./lexer";
import { Runtime, JassArray, compareLimit, evalBoolExpr, playerStateHolds, triggerConditionsPass, ThreadAbort, unitStateHolds, type BoolExpr, type HostFunction, type JassPlayer, type JassUnit, type NativeCtx, type RectObj, type RegionObj, type SoundObj, type TimerObj, type TriggerObj, type TriggerReg, type UnitSnapshot } from "./runtime";
import {
  asInt, asNum, asStr, defaultForType, jassEquals, jassNotEquals, jBool, jHandle, jInt, jReal, jStr, JNULL, truthy, type JassValue,
} from "./values";

// The sim's live view of a unit (what the pumps and group enumeration are fed) lives in
// runtime.ts, alongside the EngineHooks that carry it. Re-exported: the engine side has
// always imported it from here.
export type { UnitSnapshot };

/** One unit death fed to the death pump: the victim + its killer (null if none). */
export interface DeathEvent {
  victim: UnitSnapshot;
  killer: UnitSnapshot | null;
}
/** One damage instance: the unit hit, the damaging unit (null = environment), amount. */
export interface DamageEvent {
  target: UnitSnapshot;
  source: UnitSnapshot | null;
  amount: number;
}
/** One attack committed: the unit attacked + its attacker. */
export interface AttackEvent {
  attacked: UnitSnapshot;
  attacker: UnitSnapshot;
}
/** One issued order: the ordered unit, the order id, its kind (immediate/point/target),
 *  the point (point orders), and the target unit (target orders, else null). */
export interface OrderEvent {
  unit: UnitSnapshot;
  orderId: number;
  kind: "immediate" | "point" | "target";
  x: number;
  y: number;
  target: UnitSnapshot | null;
  /** The ITEM the order was aimed at (`GetOrderTargetItem`), when it was aimed at one. */
  item?: { id: number; typeId: string; charges: number; x: number; y: number } | null;
}
/** One spell event (7.17): the caster, the ability rawcode, which phase of the cast,
 *  and what it was aimed at. Mirrors SimWorld's SpellEvent (the sim raises it). */
export interface SpellEvent {
  caster: UnitSnapshot;
  abilityId: string; // 4-char rawcode
  phase: "channel" | "cast" | "effect" | "finish" | "endcast";
  target: UnitSnapshot | null;
  x: number;
  y: number;
  /** GetSpellTargetItem — an item-aimed cast's item (SimWorld.castItemTarget). */
  item?: { id: number; typeId: string; charges: number; x: number; y: number } | null;
}
/** A construction milestone (7.17): the structure + which phase. */
export interface ConstructEvent {
  structure: UnitSnapshot;
  phase: "start" | "cancel" | "finish";
}
/** A training milestone (7.17): the training building, the unit type, and — on
 *  "finish" — the unit that just walked out. */
export interface TrainEvent {
  building: UnitSnapshot;
  unitTypeId: string;
  trained: UnitSnapshot | null;
  phase: "start" | "cancel" | "finish";
}
/** A research milestone (EVENT_(PLAYER_)UNIT_RESEARCH_*): the researching building
 *  (GetResearchingUnit) and the upgrade's rawcode (GetResearched). */
export interface ResearchEvent {
  building: UnitSnapshot;
  techId: string;
  phase: "start" | "cancel" | "finish";
}
/** A unit BOUGHT from a shop — EVENT_(PLAYER_)UNIT_SELL. `shop` is GetSellingUnit (and the
 *  subject a unit-scoped registration watches, as with a sold ITEM), `sold` is GetSoldUnit. */
export interface SellUnitEvent {
  shop: UnitSnapshot;
  sold: UnitSnapshot;
  /** GetBuyingUnit: the buyer's unit that stood at the shop, when the shop asks for one. */
  buyer?: UnitSnapshot | null;
}
/** A unit spawned a summoned unit (EVENT_(PLAYER_)UNIT_SUMMON). */
export interface SummonEvent {
  summoner: UnitSnapshot;
  summoned: UnitSnapshot;
}
/** A hero levelling up or learning a skill (7.17). */
export interface HeroEvent {
  hero: UnitSnapshot;
  phase: "level" | "skill";
  level: number; // the new hero level, or the rank learned
  abilityId: string; // "skill" only
}
/** A unit manipulating an item (7.18) — picked up, dropped, used, or bought. The item is
 *  a SNAPSHOT: by the time the event is drained it may be gone (a tome is consumed on
 *  pickup; a potion's last charge destroys it), and GetManipulatedItem must still resolve. */
export interface ItemEvent {
  unit: UnitSnapshot;
  item: { id: number; typeId: string; charges: number };
  phase: "pickup" | "drop" | "use" | "sell";
  /** GetSellingUnit — the shop, on a "sell" (see the sim's ItemEvent). */
  seller?: UnitSnapshot;
}
/** A unit that climbed into a transport or a burrow — EVENT_UNIT_LOADED (88) and its player
 *  twin (51). `unit` is the passenger, `transport` the carrier. */
export interface LoadEvent {
  unit: UnitSnapshot;
  transport: UnitSnapshot;
}
/** A unit entering or leaving a player's SELECTION (24/25 player, 57/58 unit). `player` is
 *  who selected it, which is NOT the unit's owner — see pumpSelectionEvents. */
export interface SelectionEvent {
  unit: UnitSnapshot;
  player: number;
  selected: boolean;
}

/** common.j `constant playerevent EVENT_PLAYER_END_CINEMATIC = ConvertPlayerEvent(17)` — ESC
 *  pressed while a cinematic is playing. Exported because the RAISER is the engine side
 *  (render/mapViewer.ts owns the keyboard); see `Interpreter.firePlayerEvent`. */
export const EVENT_PLAYER_END_CINEMATIC = 17;

/**
 * common.j `constant playerevent EVENT_PLAYER_LEAVE = ConvertPlayerEvent(15)` — this player's
 * game is over because they walked away from it, rather than because they were beaten.
 *
 * A melee map registers it for every playing slot inside `MeleeInitVictoryDefeat`, and its
 * action (`MeleeTriggerActionPlayerLeft`) is the whole meaning of leaving: the leaver's units
 * are shared with a surviving ally or handed to Neutral Passive — never destroyed — then
 * `MeleeDoLeave` ends their game and `MeleeCheckForLosersAndVictors` decides whether that ends
 * everyone's. Raised for a Computer+ player that has conceded (src/ai/plus/, issue #124).
 */
export const EVENT_PLAYER_LEAVE = 15;

// common.j event enum indices (ConvertUnitEvent/ConvertPlayerUnitEvent values).
/** The registration kinds whose registrar IS the event — no constant is passed, so
 *  `GetTriggerEventId` names it by the `common.j` constant it corresponds to, looked up by NAME
 *  in the runtime's globals so no index is retyped (see Interpreter.eventIdOf). */
const IMPLIED_EVENT: Readonly<Record<string, string>> = {
  timerExpire: "EVENT_GAME_TIMER_EXPIRED",
  enterRegion: "EVENT_GAME_ENTER_REGION",
  leaveRegion: "EVENT_GAME_LEAVE_REGION",
  gameStateEvent: "EVENT_GAME_STATE_LIMIT",
  unitDeath: "EVENT_WIDGET_DEATH", // TriggerRegisterDeathEvent takes a WIDGET
  unitState: "EVENT_UNIT_STATE_LIMIT",
  playerState: "EVENT_PLAYER_STATE_LIMIT",
  playerChat: "EVENT_PLAYER_CHAT",
  dialogButton: "EVENT_DIALOG_BUTTON_CLICK",
  dialogEvent: "EVENT_DIALOG_CLICK",
  variable: "EVENT_GAME_VARIABLE_LIMIT",
  playerAllianceChange: "EVENT_PLAYER_ALLIANCE_CHANGED",
  playerKey: "EVENT_PLAYER_KEY",
  playerSync: "EVENT_PLAYER_SYNC_DATA",
  trackableHit: "EVENT_GAME_TRACKABLE_HIT",
  trackableTrack: "EVENT_GAME_TRACKABLE_TRACK",
};
const EVENT_UNIT_DEATH = 53;
const EVENT_PLAYER_UNIT_DEATH = 20;
/** common.j: `constant fgamestate GAME_STATE_TIME_OF_DAY = ConvertFGameState(2)`. */
const GAME_STATE_TIME_OF_DAY = 2;
const EVENT_UNIT_DAMAGED = 52;
/** The sim's EventUnitInfo, as much of it as the damage raise reads. */
interface EventUnitInfoLike {
  id: number;
  owner: number;
}
/** …and all of it: what `Runtime.unitForSim` needs to mint or find the unit's handle. */
type SimUnitRef = Parameters<Runtime["unitForSim"]>[0];
// 1.31's per-PLAYER damage event, which a modern map registers ONCE instead of once per unit.
// The index is OURS, not the file's: 1.30.4's common.j does not carry the constant at all, so
// it is declared in our own compat prelude (src/compat/prelude.ts) and the two must agree —
// the number never appears in a map file, only the name does. Its twin EVENT_PLAYER_UNIT_
// DAMAGING (315) fires BEFORE the reduction and lets a script change the amount, which the sim
// has no seam for; it is declared so the registration compiles and is never raised.
const EVENT_PLAYER_UNIT_DAMAGED = 308;
// …and the two raised BEFORE the resistances — ours to number, like 308 (src/compat/prelude.ts).
const EVENT_PLAYER_UNIT_DAMAGING = 315;
const EVENT_UNIT_DAMAGING = 314;
const EVENT_PLAYER_UNIT_ATTACKED = 18;
const EVENT_UNIT_ATTACKED = 62;
// Issued-order events: no-target (38/75), point-target (39/76), unit-target (40/77).
const EVENT_PLAYER_UNIT_ISSUED_ORDER = 38;
const EVENT_PLAYER_UNIT_ISSUED_POINT_ORDER = 39;
const EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER = 40;
const EVENT_UNIT_ISSUED_ORDER = 75;
const EVENT_UNIT_ISSUED_POINT_ORDER = 76;
const EVENT_UNIT_ISSUED_TARGET_ORDER = 77;
// 7.17 — construction (26–28 player / 64–65 unit: common.j has NO unit CONSTRUCT_START),
// training (32–34 / 69–71), hero level + skill (41/42 / 78/79), the unit-state threshold
// (59), and the five spell phases (272–276 player / 289–293 unit).
const EVENT_PLAYER_UNIT_CONSTRUCT_START = 26;
const EVENT_PLAYER_UNIT_CONSTRUCT_CANCEL = 27;
const EVENT_PLAYER_UNIT_CONSTRUCT_FINISH = 28;
const EVENT_UNIT_CONSTRUCT_CANCEL = 64;
const EVENT_UNIT_CONSTRUCT_FINISH = 65;
const EVENT_PLAYER_UNIT_TRAIN_START = 32;
const EVENT_PLAYER_UNIT_TRAIN_CANCEL = 33;
const EVENT_PLAYER_UNIT_TRAIN_FINISH = 34;
const EVENT_UNIT_TRAIN_START = 69;
const EVENT_UNIT_TRAIN_CANCEL = 70;
const EVENT_UNIT_TRAIN_FINISH = 71;
// Research (common.j 35–37 player / 72–74 unit) — the block right after training's.
const EVENT_PLAYER_UNIT_RESEARCH_START = 35;
const EVENT_PLAYER_UNIT_RESEARCH_CANCEL = 36;
const EVENT_PLAYER_UNIT_RESEARCH_FINISH = 37;
const EVENT_UNIT_RESEARCH_START = 72;
const EVENT_UNIT_RESEARCH_CANCEL = 73;
const EVENT_UNIT_RESEARCH_FINISH = 74;
const EVENT_PLAYER_HERO_LEVEL = 41;
const EVENT_PLAYER_HERO_SKILL = 42;
const EVENT_UNIT_HERO_LEVEL = 78;
const EVENT_UNIT_HERO_SKILL = 79;
// EVENT_UNIT_STATE_LIMIT (59) needs no constant here: it can only be registered through
// TriggerRegisterUnitStateEvent (the limit + op live in the registration), so the
// dispatcher matches on that registration kind — see pumpUnitStates.
const EVENT_PLAYER_UNIT_SPELL_CHANNEL = 272; // …CAST 273, EFFECT 274, FINISH 275, ENDCAST 276
const EVENT_UNIT_SPELL_CHANNEL = 289; // …CAST 290, EFFECT 291, FINISH 292, ENDCAST 293
/** The five spell phases, in the order common.j numbers them (both event blocks are
 *  contiguous, so phase index + the block's base = the event id). */
const SPELL_PHASES = ["channel", "cast", "effect", "finish", "endcast"] as const;
// 7.18 — items. DROP/PICKUP/USE are a contiguous block in both event families (48–50
// player / 85–87 unit); SELL_ITEM sits on its own (271 / 288), added in a later patch.
const EVENT_PLAYER_UNIT_DROP_ITEM = 48;
const EVENT_UNIT_DROP_ITEM = 85;
const EVENT_PLAYER_UNIT_SELL_ITEM = 271;
const EVENT_UNIT_SELL_ITEM = 288;
// A unit BOUGHT from a shop — a Tavern hero, a Mercenary Camp's ogre (common.j 269 player /
// 286 unit). One event id apart from SELL_ITEM and a different event: this one hands the
// script GetSoldUnit, and blizzard.j's melee opening is its headline caller
// (MeleeGrantHeroItems registers it on Player(PLAYER_NEUTRAL_PASSIVE) so a hired hero gets
// the same Scroll of Town Portal a trained one does).
const EVENT_PLAYER_UNIT_SELL = 269;
const EVENT_UNIT_SELL = 286;
const EVENT_PLAYER_UNIT_SUMMON = 47;
const EVENT_UNIT_SUMMON = 84;
/** The three contiguous item phases, in common.j's order (phase index + base = event id). */
const ITEM_PHASES = ["drop", "pickup", "use"] as const;
// A unit loaded into a transport / burrow (common.j 51 player, 88 unit).
const EVENT_PLAYER_UNIT_LOADED = 51;
const EVENT_PLAYER_UNIT_RESCUED = 19;
const EVENT_PLAYER_UNIT_DECAY = 21;
const EVENT_UNIT_DECAY = 54;
const EVENT_UNIT_RESCUED = 63;
const EVENT_UNIT_LOADED = 88;
// Selection (common.j 24/25 player, 57/58 unit) — what TriggerRegisterPlayerSelectionEventBJ
// compiles to. See pumpSelectionEvents.
const EVENT_PLAYER_UNIT_SELECTED = 24;
const EVENT_PLAYER_UNIT_DESELECTED = 25;
const EVENT_UNIT_SELECTED = 57;
const EVENT_UNIT_DESELECTED = 58;

const isRect = (o: unknown): o is RectObj =>
  !!o && typeof (o as RectObj).minx === "number" && typeof (o as RectObj).maxx === "number";
const isRegion = (o: unknown): o is RegionObj => !!o && Array.isArray((o as RegionObj).rects);
/** Is the point in a cell `RegionClearCell` took out of a region? Cells are half-open. */
export const inRegionHole = (holes: NonNullable<RegionObj["holes"]>, x: number, y: number): boolean =>
  holes.some((h) => x >= h.minx && x < h.maxx && y >= h.miny && y < h.maxy);

/** The region pump's incremental re-test (Interpreter.pumpRegions). On, unless a test turns it
 *  off to compare it against re-testing every unit (tools/jass-region-pump-test.cjs). */
export const RegionDiff = { enabled: true };

/** An enter/leave registration's region, resolved for the pump (Interpreter.regionShape). */
interface RegionShape {
  rects: RectObj[];
  holes: RegionObj["holes"];
  sig: number[];
}
/** Is (x, y) inside the region: in one of its rects, edges included, and in none of its holes
 *  (RegionClearCell). */
function inShape(s: RegionShape, x: number, y: number): boolean {
  if (s.holes && inRegionHole(s.holes, x, y)) return false;
  for (const r of s.rects) if (x >= r.minx && x <= r.maxx && y >= r.miny && y <= r.maxy) return true;
  return false;
}
function sameShape(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * How a `return` and an `exitwhen` leave the statements they are in: as a MARK the statement
 * hands back, which every enclosing block passes up unread until the function (a return) or the
 * loop (an exit) that it belongs to takes it. They used to be THROWN — `ReturnSignal` and
 * `ExitLoop` — and a throw unwinding a stack of generators is the most expensive thing a
 * statement could do: on a script that returns a value from a small function in a loop, it was
 * most of the time spent running JASS at all (issue #388). The returned VALUE waits in
 * `Interpreter.returned`: it is written by the `return` and taken by the function it leaves with
 * no wait and no JASS in between (only the enclosing blocks' `finally`s run), so one register is
 * enough and a saved thread never holds one in flight — TRANSIENT, game/save/classes.ts. Never a
 * value a script can see: nothing but a statement returns these.
 */
const RETURN_MARK: JassValue = Object.freeze({ k: "null" }) as JassValue;
const EXIT_MARK: JassValue = Object.freeze({ k: "null" }) as JassValue;

/** A function call frame: local variables + local arrays. Parameters live in the
 *  same var map (JASS has no separate parameter scope). */
export class Frame {
  readonly vars = new Map<string, JassValue>();
  readonly arrays = new Map<string, JassArray>();
}

const MAX_CALL_DEPTH = 3000; // deep enough for blizzard.j; a backstop against runaway recursion
const MAX_LOOP_ITERS = 2_000_000; // init loops are tiny; this only guards a pathological script
const MAX_THREADS = 4096; // live (sleeping) trigger threads — a backstop against runaway spawning

/** What a running thread yields when it wants to sleep: seconds of game time. */
type ThreadGen = Generator<number, JassValue, void>;

/** Natives the thread layer must handle itself, because each one either suspends the
 *  calling thread or runs more JASS on it — neither of which a plain (synchronous) native
 *  impl can do. Intercepted at statement-call sites; see Interpreter.execThreadNative. */
/** How many frames `TriggerWaitForSound` will wait for a clip to start playing before giving
 *  up on it (see the native). Two seconds at 60 Hz — well past any archive read, and short
 *  enough that a clip which never arrives costs a beat rather than the whole cinematic. */
const WAIT_FOR_SOUND_SPINS = 120;

const THREAD_NATIVES = new Set(["TriggerSleepAction", "TriggerWaitForSound", "TriggerExecute", "ConditionalTriggerExecute", "ExecuteFunc"]);
/** …and the two `common.ai` adds, which only an AI script's VM knows (`Interpreter.aiScript`):
 *  `Sleep(seconds)` parks the calling AI thread, `StartThread(function f)` starts another. A
 *  map's own script never sees them as thread natives — `common.j` declares neither, and a map
 *  is free to name a function of its own `Sleep`. */
const AI_THREAD_NATIVES = new Set(["Sleep", "StartThread"]);

/** A **trigger thread** (7.15). WC3 runs a trigger's actions — and `main()`, and timer
 *  handlers — on a thread that `TriggerSleepAction` can suspend mid-way; the engine
 *  resumes it N seconds of game time later. Crucially the thread keeps its **event
 *  responses** across the wait (`GetTriggerUnit()` still reads the same unit after a
 *  `Wait 5 seconds`), so each thread carries its own slice of the (globally-stacked)
 *  event-response frames, and its call depth, restored on resume.
 *
 *  We model a thread as a JS generator that yields the seconds it wants to sleep.
 *  `pumpThreads` (driven from the sim tick, alongside the timers) resumes it when its
 *  wake time arrives — at most **once per tick**, so a `TriggerSleepAction(0)` in a loop
 *  costs a frame instead of hanging one. */
/**
 * WHERE a thread is, as data (issue #159, docs/save-games.md).
 *
 * A thread is a chain of JS generators, and a generator cannot be written down: its position and
 * its locals live inside the engine. So every generator on a thread's path keeps one of these
 * records while it runs — the statement it is on, the arguments already evaluated, the branch it
 * took, its local variables — on the thread's `Trace`. A suspended thread's trace therefore says
 * exactly where each frame of it is waiting, in plain data, and a saved game writes that.
 *
 * To LOAD one, the same generators are started again with the saved trace as their `resume`:
 * each one, on entry, takes its own record back instead of starting fresh and skips straight to
 * where it was — the block to its statement, the call to the function it was inside, and the
 * innermost record, the wait itself, simply returns as if the wait had run out. From there the
 * thread runs on exactly as the one that was saved would have. (The real game's JASS VM is a
 * bytecode machine with an explicit stack, which is why a `.w3z` can carry its threads; this is
 * the same idea with the AST walker kept.)
 *
 * A level that has no state of its own (`return`, `exitwhen`, an array index) keeps no record:
 * capture and resume walk the same tree, so they agree on which levels do.
 */
export type TraceRec =
  /** `callFunctionG` — a thread's ROOT when it was started on a function by name. */
  | { k: "cf"; name: string }
  /** `callUserG`: the frame, and whether the locals are still being initialised (`li` the next). */
  | { k: "user"; fn: string; frame: Frame; ph: 0 | 1; li: number }
  | { k: "block"; i: number }
  /** A `call` statement: the arguments evaluated so far (`ph` 0), then the call itself (1). */
  | { k: "call"; args: JassValue[]; ph: 0 | 1 }
  | { k: "set"; ph: 0 | 1; value: JassValue }
  /** An `if`: conditions (0, `bi` the branch being asked), the taken body (1, `bi` = -1 for
   *  else, -2 for none), and the audience fan-out (2) — see `exec`. */
  | { k: "if"; ph: 0 | 1 | 2; bi: number; before: number; dep: boolean; ps: number[]; pi: number; pt: number; prevAudience: number | null; prevGuard: boolean }
  | { k: "loop"; iters: number; j: number; mid: boolean }
  | { k: "ecall"; args: JassValue[]; ph: 0 | 1 }
  | { k: "bin"; ph: 0 | 1; l: JassValue }
  /** `runActionsG`: the trigger's actions as they were when it started, and the one running. */
  | { k: "acts"; trig: number; fns: string[]; i: number }
  /** A thread native that WAITS (`execThreadNative`): `ph` 1 = the final wait, 0 = still
   *  spinning on a sound that has not started (`spins` so far). */
  | { k: "tn"; ph: 0 | 1; spins: number };

/** A thread's trace — see `TraceRec`. */
export class Trace {
  readonly recs: TraceRec[] = [];
  /** The saved trace being resumed, until its innermost record has been taken back. */
  resume: TraceRec[] | null = null;
  at = 0;
  /** > 0 while the thread is inside code that is not JASS (a Lua map's coroutine), whose
   *  position no trace can describe — a thread suspended there cannot be saved. */
  opaque = 0;

  /** The saved record for the generator entering now, if this is a resume — else undefined, and
   *  the generator starts fresh. */
  take<K extends TraceRec["k"]>(k: K): Extract<TraceRec, { k: K }> | undefined {
    const r = this.resume;
    if (!r) return undefined;
    const rec = r[this.at++];
    if (!rec || rec.k !== k) throw new Error(`save: a thread's saved trace does not fit its script (wanted ${k}, found ${rec?.k ?? "nothing"})`);
    if (this.at >= r.length) this.resume = null;
    return rec as Extract<TraceRec, { k: K }>;
  }
}

/** A thread as a saved game writes it: everything but the generator, which `restoreThreads`
 *  rebuilds from the trace. */
export interface SavedThread {
  id: number;
  label: string;
  recs: TraceRec[];
  stack: Array<Map<string, JassValue>>;
  wakeAt: number;
  lastTick: number;
}

export interface SavedThreads {
  threads: SavedThread[];
  nextThreadId: number;
  pumpTick: number;
}

interface JassThread {
  id: number;
  label: string; // for warnings, e.g. "trigger#12"
  gen: ThreadGen;
  /** Where its generators are (see `Trace`). */
  ts: Trace;
  stack: Array<Map<string, JassValue>>; // its event-response frames (thread-local in WC3)
  depth: number; // its call depth, saved across the suspension
  wakeAt: number; // rt.gameTime at which it may resume
  lastTick: number; // the pump it last ran on (one resume per thread per tick)
  done: boolean;
  result: JassValue; // its return value, if it ran to completion
}

/** One script input, as `Interpreter.inputTap` reports it. */
export type ScriptInput =
  | { k: "dlg"; p: number; button: number; dialog: number }
  | { k: "frame"; p: number; frame: number; ev: number }
  | { k: "pev"; p: number; ev: number }
  | { k: "key"; p: number; key: number; meta: number; down: boolean };

export class Interpreter {
  /**
   * What the map's script hears from a PLAYER rather than from the match — a dialog button, a
   * frame event, a player event (leaving, ESC through a cinematic). The replay recorder's tap
   * (game/replay.ts): these are inputs, and a replay hands them back through the same methods.
   */
  inputTap: ((e: ScriptInput) => void) | null = null;

  private depth = 0;
  /** This VM runs a computer player's `.ai` script (src/ai/scriptAi.ts) rather than a map: it
   *  owns `common.ai`'s `Sleep` and `StartThread` as thread natives (AI_THREAD_NATIVES). */
  aiScript = false;
  private globalDecls: VarDecl[] = [];
  private readonly ctx: NativeCtx;

  /** Suspended trigger threads, in creation order (deterministic resume order). */
  private threads: JassThread[] = [];
  private nextThreadId = 1;
  private pumpTick = 0;
  /** The thread currently executing, and how deep we are inside a SYNCHRONOUS drive
   *  (runSync — a condition, a boolexpr filter, a ForGroup/ForForce callback, or a
   *  function called from an expression). A wait can only suspend when we're on a
   *  thread and NOT inside a sync drive — the same places WC3 supports one. */
  private currentThread: JassThread | null = null;
  private syncDepth = 0;

  constructor(public readonly rt: Runtime) {
    this.ctx = {
      rt,
      call: (name, args) => this.callFunction(name, args),
      fireEvent: (kind, responses, matches) => this.fireEvent(kind, responses, matches),
      flushHeroEvents: () => {
        const events = this.rt.hooks?.drainHeroEvents?.();
        if (events?.length) this.pumpHeroEvents(events as HeroEvent[]);
      },
      flushItemEvents: () => {
        const events = this.rt.hooks?.drainItemEvents?.();
        if (events?.length) this.pumpItemEvents(events as ItemEvent[]);
      },
    };
    rt.onWatchedGlobal = (name, before, after) => this.fireVariableEvent(name, before, after);
  }

  /** Register a program's natives/functions and collect its global declarations
   *  (initialisers run later, in initGlobals, once every unit is loaded). */
  load(prog: JassProgram): void {
    for (const n of prog.natives) this.rt.nativeReturns.set(n.name, n.returns);
    for (const f of prog.functions) this.rt.functions.set(f.name, f);
    this.globalDecls.push(...prog.globals);
  }

  /** Evaluate all collected global initialisers, in load order (common.j, then
   *  blizzard.j, then war3map.j) — after native impls are registered, so an
   *  initialiser like `PLAYER_COLOR_RED = ConvertPlayerColor(0)` resolves. */
  initGlobals(): void {
    for (const g of this.globalDecls) {
      if (g.isArray) {
        this.rt.globalArrays.set(g.name, new JassArray(g.type));
      } else {
        this.rt.globalTypes.set(g.name, g.type);
        this.rt.globals.set(g.name, g.init ? this.eval(g.init, null) : defaultForType(g.type));
      }
    }
  }

  /** Call a function by name **synchronously** — the entry point for everything that
   *  cannot suspend: conditions, boolexpr filters, enum callbacks (`ForGroup`/`ForForce`),
   *  natives calling back through `NativeCtx.call`, and functions invoked from an
   *  *expression*. A `TriggerSleepAction` reached from here can't yield (there's no
   *  thread to park), so it aborts that callback — see runSync. WC3 doesn't support a
   *  wait in any of these places either.
   *
   *  Resolution order: native impl → user function → declared-but-unimplemented native
   *  (typed default) → unknown (null). Never throws for a missing target. */
  callFunction(name: string, args: JassValue[], adoptWaits = false): JassValue {
    const nat = this.rt.natives.get(name);
    if (nat) return this.callNative(name, nat, args); // natives are synchronous — no generator needed
    // A HOST function (a Lua map's own — src/compat/lua/) is the map's code and outranks
    // blizzard.j's, exactly as a JASS map's own definition of a BJ would. It is looked up
    // before `functions` for that reason and after the natives, which are the engine's.
    const host = this.rt.hostFunctions.get(name);
    if (host) return this.callHost(name, host, args);
    const fn = this.rt.functions.get(name);
    if (fn) {
      const ts = new Trace();
      return this.runSync(this.callUserG(fn, args, ts), name, adoptWaits, ts);
    }
    return this.missing(name);
  }

  /** A host function on the caller's stack. Its own `call` decides what a wait means there —
   *  for Lua that is the same answer JASS gives: the callback is abandoned and said so once. */
  private callHost(name: string, host: HostFunction, args: JassValue[]): JassValue {
    try {
      return host.call(args);
    } catch (err) {
      if (err instanceof ThreadAbort) throw err;
      this.rt.warnOnce(name, `threw: ${(err as Error).message}`);
      return JNULL;
    }
  }

  /** The same resolution, as a generator — used from a thread, where a user function
   *  (a trigger action, `PolledWait`, …) may suspend on a wait. */
  private *callFunctionG(name: string, args: JassValue[], ts: Trace): ThreadGen {
    const nat = this.rt.natives.get(name);
    if (nat) return this.callNative(name, nat, args);
    // …and from a thread the host's generator form, so a Lua trigger action's wait parks the
    // thread instead of abandoning the callback. Same protocol: a yielded number is seconds.
    // A Lua coroutine's position is not something a trace can describe, so the thread is
    // marked unsaveable for as long as it is in there (`Trace.opaque`).
    const host = this.rt.hostFunctions.get(name);
    if (host) {
      ts.opaque++;
      try {
        return yield* host.run(args);
      } finally {
        ts.opaque--;
      }
    }
    const fn = this.rt.functions.get(name);
    if (!fn) return this.missing(name);
    const r = ts.take("cf") ?? { k: "cf" as const, name };
    ts.recs.push(r);
    try {
      return yield* this.callUserG(fn, args, ts);
    } finally {
      ts.recs.pop();
    }
  }

  /** Invoke a native. A throwing native is logged once and yields its typed default —
   *  except a ThreadAbort (a wait with nowhere to park), which must reach its runSync. */
  private callNative(name: string, nat: (ctx: NativeCtx, args: JassValue[]) => JassValue, args: JassValue[]): JassValue {
    try {
      return nat(this.ctx, args);
    } catch (err) {
      if (err instanceof ThreadAbort) throw err;
      this.rt.warnOnce(name, `threw: ${(err as Error).message}`);
      return defaultForType(this.rt.nativeReturns.get(name) ?? "nothing");
    }
  }

  /** A call with no target: a declared-but-unimplemented native returns its typed
   *  default; a genuinely unknown name returns null. Both log once. */
  private missing(name: string): JassValue {
    const ret = this.rt.nativeReturns.get(name);
    if (ret !== undefined) {
      this.rt.warnOnce(name);
      return defaultForType(ret);
    }
    this.rt.warnOnce(name, "unknown function");
    return JNULL;
  }

  /**
   * Drive a generator on the caller's stack, where JavaScript cannot suspend: a condition,
   * a boolexpr filter, a `ForGroup`/`ForForce` callback, or a function reached from an
   * EXPRESSION (`if TriggerExecuteBJ(...) then`).
   *
   * If it runs to completion — the normal case — its value is the call's value. If it hits a
   * `TriggerSleepAction`, what happens next depends on WHERE the call came from:
   *
   *   • from an EXPRESSION (`adoptWaits`), the rest of it is adopted by the scheduler as a
   *     thread of its own and the caller carries on with a null result. WC3 would suspend the
   *     caller's whole thread right there; we cannot suspend a JS expression, so the choice is
   *     between running the rest late and not running it at all. It used to be the latter, and
   *     blizzard.j is exactly where that hurt: `QueuedTriggerAttemptExec` runs the whole trigger
   *     QUEUE from inside an `if`, so every queued trigger died at its first wait. Campaign
   *     cinematics are queued triggers — Terror of the Tides opens faded to black and waits, and
   *     the map sat black forever with the fade-in abandoned mid-cinematic.
   *   • from a CONDITION, a boolexpr filter or an enum callback, it is abandoned (logged once).
   *     WC3 does not allow a wait there either, and resuming one would fire trigger actions out
   *     of a context that no longer exists.
   */
  private runSync(gen: ThreadGen, label: string, adoptWaits: boolean, ts: Trace): JassValue {
    this.syncDepth++;
    try {
      const r = gen.next();
      if (r.done) return r.value;
      if (adoptWaits) this.adoptSuspended(label, gen, typeof r.value === "number" ? r.value : 0, ts);
      else this.rt.warnOnce(label, "wait outside a trigger thread — callback abandoned");
      return JNULL;
    } catch (err) {
      if (err instanceof ThreadAbort) return JNULL; // a wait that could not even be adopted
      throw err;
    } finally {
      this.syncDepth--;
    }
  }

  /**
   * Hand an already-suspended generator to the scheduler, waking `secs` of game time from now.
   *
   * It does not carry the shared stack's FRAMES off — those belong to the thread that called
   * into us and will be popped by it — but it does take a flat COPY of what they currently
   * say. WC3's event responses survive a wait inside the same trigger, and the editor's own
   * generated code leans on it right after one:
   *
   *     call TriggerSleepAction( bj_QUEUE_DELAY_QUEST )
   *     call QueuedTriggerRemoveBJ( GetTriggeringTrigger() )
   *
   * Starting empty made that `GetTriggeringTrigger()` null, so a queued trigger never took
   * itself back OUT of blizzard.j's queue — and the queue is strictly serial, so everything
   * behind it (the campaign's voice lines, its cinematics, its quest banners) waited on a
   * trigger that had already finished. A copy rather than the frames themselves, so nothing
   * this thread writes later can reach back into the caller's context.
   */
  private adoptSuspended(label: string, gen: ThreadGen, secs: number, ts: Trace): void {
    if (this.threads.length >= MAX_THREADS) {
      this.rt.warnOnce("<threads>", `thread cap (${MAX_THREADS}) hit — trigger thread dropped`);
      return;
    }
    const inherited = new Map<string, JassValue>();
    for (const frame of this.rt.eventStack) for (const [k, v] of frame) inherited.set(k, v);
    this.threads.push({
      id: this.nextThreadId++,
      label,
      gen,
      ts,
      stack: inherited.size ? [inherited] : [],
      depth: 0,
      wakeAt: this.rt.gameTime + Math.max(0, secs),
      lastTick: this.pumpTick,
      done: false,
      result: JNULL,
    });
  }

  /** The value of the `return` on its way out of its function (RETURN_MARK). */
  private returned: JassValue = JNULL;

  private *callUserG(fn: FunctionDecl, args: JassValue[], ts: Trace): ThreadGen {
    // On a RESUME the frame comes back from the saved trace, so `args` are not looked at; the
    // depth and the record-only scope are re-entered exactly as the first time (a restored
    // thread's own depth starts at zero for that reason — see restoreThreads).
    const resumed = ts.take("user");
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      this.rt.warnOnce(fn.name, "call depth exceeded");
      return defaultForType(fn.returns);
    }
    // CreateAllUnits (and everything it calls) only RECORDS its CreateUnit rows — the
    // map's pre-placed units are already on the map, adopted from war3mapUnits.doo (7.3).
    // Scoped to this call, so the melee-init trigger — which runs inside main() too —
    // still spawns MeleeStartingUnits' town hall and workers for real.
    const recordOnly = this.rt.recordOnlySpawnFns.has(fn.name);
    if (recordOnly) this.rt.spawnDepth++;
    let r = resumed;
    if (!r) {
      const frame = new Frame();
      for (let i = 0; i < fn.params.length; i++) {
        frame.vars.set(fn.params[i].name, args[i] ?? defaultForType(fn.params[i].type));
      }
      r = { k: "user", fn: fn.name, frame, ph: 0, li: 0 };
    }
    ts.recs.push(r);
    try {
      const frame = r.frame;
      if (r.ph === 0) {
        for (; r.li < fn.locals.length; r.li++) {
          const loc = fn.locals[r.li];
          if (loc.isArray) frame.arrays.set(loc.name, new JassArray(loc.type));
          else frame.vars.set(loc.name, loc.init ? yield* this.evalG(loc.init, frame, ts) : defaultForType(loc.type));
        }
        r.ph = 1;
      }
      if ((yield* this.execBlockG(fn.body, frame, ts)) === RETURN_MARK) return this.returned;
    } finally {
      ts.recs.pop();
      this.depth--;
      if (recordOnly) this.rt.spawnDepth--;
    }
    return defaultForType(fn.returns);
  }

  private *execBlockG(stmts: Stmt[], frame: Frame, ts: Trace): ThreadGen {
    const r = ts.take("block") ?? { k: "block" as const, i: 0 };
    ts.recs.push(r);
    try {
      for (; r.i < stmts.length; r.i++) {
        const v = yield* this.exec(stmts[r.i], frame, ts);
        if (v === RETURN_MARK || v === EXIT_MARK) return v; // …up to the function or the loop it leaves
      }
    } finally {
      ts.recs.pop();
    }
    return JNULL;
  }

  private *exec(s: Stmt, frame: Frame, ts: Trace): ThreadGen {
    switch (s.kind) {
      case "call": {
        // The thread-aware natives, intercepted here so a wait inside them can suspend
        // the *calling* thread (a native impl is a plain JS function — it cannot yield).
        // Same precedence as callFunction: the engine's meaning wins over a same-named
        // script function. Everything else can't suspend, so it goes through the sync path.
        const thread = THREAD_NATIVES.has(s.name) || (this.aiScript && AI_THREAD_NATIVES.has(s.name));
        const nat = thread ? undefined : this.rt.natives.get(s.name);
        // A plain native over arguments that cannot wait never suspends, so it keeps no record
        // (nearly every statement there is — see TraceRec on which levels keep one).
        if (nat && !this.argsMayWait(s)) {
          this.callNative(s.name, nat, s.args.map((a) => this.eval(a, frame)));
          return JNULL;
        }
        const r = ts.take("call") ?? { k: "call" as const, args: [] as JassValue[], ph: 0 as 0 | 1 };
        ts.recs.push(r);
        try {
          if (r.ph === 0) {
            while (r.args.length < s.args.length) {
              const v = yield* this.evalG(s.args[r.args.length], frame, ts);
              r.args.push(v);
            }
            r.ph = 1;
          }
          const args = r.args;
          if (thread) {
            yield* this.execThreadNative(s.name, args, ts);
            return JNULL;
          }
          if (nat) {
            this.callNative(s.name, nat, args);
            return JNULL;
          }
          const fn = this.rt.functions.get(s.name);
          if (fn) {
            yield* this.callUserG(fn, args, ts); // a user function may wait (PolledWait, a spawn loop, …)
            return JNULL;
          }
          this.missing(s.name);
          return JNULL;
        } finally {
          ts.recs.pop();
        }
      }
      case "set": {
        if (!this.mayWait(s.value) && !(s.index !== undefined && this.mayWait(s.index))) {
          this.assign(s, this.eval(s.value, frame), s.index !== undefined ? asInt(this.eval(s.index, frame)) : 0, frame);
          return JNULL;
        }
        const r = ts.take("set") ?? { k: "set" as const, ph: 0 as 0 | 1, value: JNULL as JassValue };
        ts.recs.push(r);
        try {
          if (r.ph === 0) {
            r.value = yield* this.evalG(s.value, frame, ts);
            r.ph = 1;
          }
          const idx = s.index !== undefined ? asInt(yield* this.evalG(s.index, frame, ts)) : 0;
          this.assign(s, r.value, idx, frame);
        } finally {
          ts.recs.pop();
        }
        return JNULL;
      }
      case "return":
        this.returned = s.value ? yield* this.evalG(s.value, frame, ts) : JNULL;
        return RETURN_MARK;
      case "if": {
        const resumed = ts.take("if");
        const r = resumed ?? {
          k: "if" as const, ph: 0 as 0 | 1 | 2, bi: 0, before: this.rt.localViewerReads, dep: false,
          ps: [] as number[], pi: 0, pt: -2, prevAudience: null as number | null, prevGuard: false,
        };
        ts.recs.push(r);
        try {
          // An AI VM has no audience (nothing in it is presentation) and its conditions may
          // SLEEP — `if not PrepSuicideOnPlayer(seconds) then` is common.ai's own wave loop.
          // The map's own pass below is the same statement, plus the audience fan-out.
          if (r.ph === 0) {
            // evalG: a condition that calls a script function may WAIT, and the thread waits
            // with it (`if not Buy(hero, item) then` — see evalG).
            for (; r.bi < s.branches.length; r.bi++) {
              if (truthy(yield* this.evalG(s.branches[r.bi].cond, frame, ts))) break;
            }
            if (r.bi >= s.branches.length) r.bi = s.elseBody ? -1 : -2;
            // Did the branch we chose depend on WHO IS WATCHING? The probe answers that without
            // the parser having to recognise a shape: any route to `GetLocalPlayer` counts, direct
            // or through a BJ wrapper. It sees only the CONDITIONS — reads inside the body are the
            // body's business, and a later branch's condition that was never reached is genuinely
            // unknown rather than assumed (stated because it is the honest limit of the probe).
            r.dep = this.rt.localViewerReads !== r.before;
            r.ph = 1;
          }
          if (r.ph === 1) {
            const left = r.bi >= 0 ? yield* this.execBlockG(s.branches[r.bi].body, frame, ts)
              : r.bi === -1 ? yield* this.execBlockG(s.elseBody!, frame, ts) : JNULL;
            if (left === RETURN_MARK || left === EXIT_MARK) return left;
            if (this.aiScript) return JNULL;
            // (The HOST's own pass above is the statement exactly as it has always run —
            // docs/multiplayer.md Phase E item 7b.)
            // Only the OUTERMOST such statement fans out. Inside a `forAudience` the runtime has
            // already resolved who is watching, so `GetLocalPlayer` is answering correctly and a
            // second fan-out would be N² passes of the same block for the same person.
            if (!r.dep || this.rt.audience !== null) return JNULL;
            r.ps = [...this.rt.viewers()].filter((p) => p !== this.rt.localPlayer); // the local one already ran, as itself, with writes allowed
            r.pi = 0;
            r.pt = -2;
            r.ph = 2;
          }
          for (; r.pi < r.ps.length; r.pi++) {
            const p = r.ps[r.pi];
            if (!(resumed && r.pt !== -2)) {
              r.prevAudience = this.rt.audience;
              r.prevGuard = this.rt.presentationOnly;
            }
            this.rt.audience = p;
            this.rt.presentationOnly = true; // world writes refused for the extra passes only
            try {
              if (r.pt === -2) {
                let t = -3;
                for (let i = 0; i < s.branches.length; i++) {
                  if (truthy(this.eval(s.branches[i].cond, frame))) { t = i; break; }
                }
                r.pt = t >= 0 ? t : s.elseBody ? -1 : -3;
              }
              const left = r.pt >= 0 ? yield* this.execBlockG(s.branches[r.pt].body, frame, ts)
                : r.pt === -1 ? yield* this.execBlockG(s.elseBody!, frame, ts) : JNULL;
              if (left === RETURN_MARK || left === EXIT_MARK) return left;
            } finally {
              // Restored even if the block throws, or the runtime answers `GetLocalPlayer` as
              // somebody else for the rest of the match — the same care `forAudience` takes.
              this.rt.audience = r.prevAudience;
              this.rt.presentationOnly = r.prevGuard;
            }
            r.pt = -2;
          }
          return JNULL;
        } finally {
          ts.recs.pop();
        }
      }
      case "loop": {
        const r = ts.take("loop") ?? { k: "loop" as const, iters: 0, j: 0, mid: false };
        ts.recs.push(r);
        try {
          while (true) {
            if (!r.mid) {
              if (++r.iters > MAX_LOOP_ITERS) {
                this.rt.warnOnce("<loop>", "iteration cap hit");
                return JNULL;
              }
              r.mid = true;
            }
            for (; r.j < s.body.length; r.j++) {
              const v = yield* this.exec(s.body[r.j], frame, ts);
              if (v === EXIT_MARK) return JNULL; // this loop's exitwhen
              if (v === RETURN_MARK) return v;
            }
            r.j = 0;
            r.mid = false;
          }
        } finally {
          ts.recs.pop();
        }
      }
      case "exitwhen":
        return truthy(yield* this.evalG(s.cond, frame, ts)) ? EXIT_MARK : JNULL;
    }
  }

  /** The write of a `set` statement, once its value (and index) are known. */
  private assign(s: Extract<Stmt, { kind: "set" }>, value: JassValue, idx: number, frame: Frame): void {
    if (s.index !== undefined) {
      this.arrayFor(s.name, frame).set(idx, value);
    } else if (frame.vars.has(s.name)) {
      frame.vars.set(s.name, value);
    } else {
      this.rt.assignGlobal(s.name, value); // may raise a variable event, synchronously
    }
  }

  /** The four natives the thread layer owns (intercepted in `exec`): each either
   *  suspends the calling thread or runs more JASS *on* it, which a plain native — a
   *  synchronous JS function — cannot do. All four return `nothing`, so they can only
   *  ever appear as a statement, which is why intercepting statement calls is enough.
   *
   *  They still have ordinary native impls in natives/events.ts for the synchronous
   *  path (a `ForGroup` callback that calls `TriggerExecute`, say). */
  private *execThreadNative(name: string, args: JassValue[], ts: Trace): ThreadGen {
    // common.ai's two (AI_THREAD_NATIVES). `Sleep` is TriggerSleepAction under the AI's name —
    // game seconds, parked on the scheduler. `StartThread` starts the function as a thread of
    // its own, run at once up to its first `Sleep` exactly as a trigger thread is
    // (`startThread`); the caller carries on, which is how `main()` gets past
    // `StartThread(function WorkerAssignment)` — a function that never returns — to the next line.
    if (name === "Sleep") {
      // A resumed thread's innermost record is the wait itself, and the wait has run out.
      if (ts.take("tn")) return JNULL;
      ts.recs.push({ k: "tn", ph: 1, spins: 0 });
      try {
        yield Math.max(0, asNum(args[0] ?? jReal(0)));
      } finally {
        ts.recs.pop();
      }
      return JNULL;
    }
    if (name === "StartThread") {
      const code = args[0];
      if (code?.k === "code") {
        const t = new Trace();
        this.startThread(`StartThread:${code.fn}`, this.callFunctionG(code.fn, [], t), t);
      }
      return JNULL;
    }
    if (name === "TriggerSleepAction") {
      // THE suspension point. `TriggerSleepAction(n)` parks this thread for n seconds of
      // GAME time (blizzard.j's PolledWait loops on it, so "Wait" in the GUI lands here).
      // Yield whether or not there is a thread to park. On a trigger thread that parks it,
      // which is the whole point; driven from a SYNC context (a condition, a filter, or a
      // function called from an expression) the yield surfaces at that context's `runSync`,
      // which adopts the rest of the callback as a thread rather than dropping it on the
      // floor. See runSync — the campaign trigger queue is why.
      const secs = Math.max(0, asNum(args[0] ?? jReal(0)));
      if (ts.take("tn")) return JNULL; // resumed: this is where it slept, and the time is up
      ts.recs.push({ k: "tn", ph: 1, spins: 0 });
      try {
        yield secs;
      } finally {
        ts.recs.pop();
      }
      return JNULL;
    }
    if (name === "TriggerWaitForSound") {
      // `TriggerWaitForSound(snd, offset)` — park until the line has played out, less
      // `offset` seconds. It is a SECOND suspension point, and it was missing: unimplemented,
      // it fell through to the safe default and returned instantly.
      //
      // That is not a small silence. blizzard.j's `WaitForSoundBJ` is its only caller, and
      // every campaign cinematic paces itself with it — NightElfX01's intro is
      //
      //     call TransmissionFromUnitWithNameBJ( …, udg_Huntress02, …, gg_snd_S01WatcherOne03, … )
      //     call WaitForSoundBJ( gg_snd_S01WatcherOne03, 0.00 )
      //     call TransmissionFromUnitWithNameBJ( …, udg_Maiev, … )
      //
      // — so with the wait gone, Maiev's line arrived in the SAME MILLISECOND as the
      // Watcher's, and the two transmissions raced each other through the panel (that race
      // is what left the wrong bust under the wrong name). `WaitTransmissionDuration` also
      // routes its bj_TIMETYPE_SUB case here.
      //
      // The length is the sound's own baked `SetSoundDuration` (ms — the World Editor writes
      // the file's real length into the script), measured from the last `StartSound`, so a
      // line already half spoken waits only the half that is left. A sound that never
      // started, or that carries no duration, waits not at all — there is nothing to wait for.
      const snd = this.rt.data<SoundObj>(args[0] ?? JNULL);
      const offset = asNum(args[1] ?? jReal(0));
      const resumed = ts.take("tn");
      if (resumed?.ph === 1) return JNULL; // resumed after its last wait: the line has played out
      const r = resumed ?? { k: "tn" as const, ph: 0 as 0 | 1, spins: 0 };
      ts.recs.push(r);
      try {
        // Never started (or no handle) → nothing is playing, so there is nothing to wait OUT.
        // Deliberately not "wait the clip's length anyway": a map that forgot to start its
        // sound would then hang its cinematic on a line nobody can hear.
        if (!snd || snd.startedAt < 0) {
          if (resumed) return JNULL;
          r.ph = 1;
          yield 0;
          return JNULL;
        }
        // Wait for the line to actually BEGIN first. `StartSound` only asks; the engine still
        // has to read the clip out of the archive and decode it, and every millisecond of that
        // is a millisecond this wait would otherwise finish early — which lands on the NEXT
        // line, and is what the player hears as two people talking over each other. One frame
        // per poll, capped so a clip that never arrives costs a beat rather than the cinematic
        // (`pending` is undefined when nothing is going to play at all).
        while (snd.pending && r.spins < WAIT_FOR_SOUND_SPINS) {
          r.spins++;
          yield 0;
        }
        const left = snd.duration / 1000 - offset - (this.rt.gameTime - snd.startedAt);
        r.ph = 1;
        yield Math.max(0, left);
      } finally {
        ts.recs.pop();
      }
      return JNULL;
    }
    // ExecuteFunc takes a function NAME, not a trigger. WC3 starts a thread for it (that is
    // why `TriggerSleepAction` works inside one at all), so it runs INLINE until it waits and
    // then detaches — the same rule as TriggerExecute below, and for the same reason.
    if (name === "ExecuteFunc") {
      if (args[0]?.k === "string") {
        const t = new Trace();
        this.runSync(this.callFunctionG(args[0].s, [], t), `ExecuteFunc:${args[0].s}`, true, t);
      }
      return JNULL;
    }

    // TriggerExecute runs the trigger's actions INLINE on the calling thread — until they hit
    // a wait, at which point the rest of them becomes a thread of its own and **the caller
    // carries straight on**. ConditionalTriggerExecute gates that on the trigger's conditions.
    //
    // We used to block the caller through the wait, which is the intuitive reading and is
    // wrong. Three things say so, and the first is decisive:
    //
    //  • It is TESTED. A Hive thread on exactly this question ("TriggerSleepAction inside
    //    TriggerEvaluate/TriggerExecute", hiveworkshop.com/threads/…275707) reports the
    //    experiment: a sleep inside `TriggerEvaluate` KILLS the thread and it never resumes;
    //    a sleep inside `TriggerExecute` RETURNS CONTROL to the calling thread; and
    //    `TriggerExecuteWait` does the same thing as `TriggerExecute`. We already had the
    //    first of those right.
    //  • blizzard.j's own TRIGGER QUEUE cannot work any other way. `QueuedTriggerAttemptExec`
    //    runs a queued trigger with `TriggerExecuteBJ`, then **arms a timeout timer** and
    //    waits for the trigger to call `QueuedTriggerDoneBJ` on its way out. If the call had
    //    blocked until the trigger finished, there would be nothing for either to do.
    //  • And it is what map scripts assume. Extreme Candy War's hero picker is
    //
    //        call AddSpecialEffectTargetUnitBJ( "overhead", GetTriggerUnit(), "…HolyBolt…" )
    //        call TriggerExecute( gg_trg_Special_Effect_Destruction )   // PolledWait(7) inside
    //        set udg_Has_Picked[…] = true                               // …then hand over the hero
    //
    //    — a fire-and-forget cleanup, which blocking turned into a seven-second stare at the
    //    costume you had just double-clicked before your hero appeared.
    //
    // **And the trigger it runs becomes "the triggering trigger" for the duration.** That is
    // WC3's rule for an executed trigger as much as for an evented one, and the World Editor
    // writes code that cannot work without it — its run-once idiom is a matched pair,
    //
    //     if ( not ( IsTriggerEnabled(GetTriggeringTrigger()) == true ) ) then   // condition
    //     call DisableTrigger( GetTriggeringTrigger() )                          // first action
    //
    // and both halves read the same response. Without the frame the condition asked
    // `IsTriggerEnabled(null)` and refused: every quest in Rise of the Naga is created by
    // exactly that pair, and the chapter's log came up empty. Where only the DisableTrigger
    // half was involved, the trigger quietly stopped being run-once instead — worse, because
    // nothing looks broken until it fires twice.
    //
    // The frame is pushed on the SHARED stack and popped here, which is right either way: the
    // actions run inline under it, and a detached remainder took a flat COPY of the stack on
    // its way out (adoptSuspended) — so `GetTriggeringTrigger()` still answers after the wait,
    // which the editor's own post-wait `QueuedTriggerRemoveBJ(GetTriggeringTrigger())` needs.
    const t = this.rt.data<TriggerObj>(args[0] ?? JNULL);
    if (!t) return JNULL;
    this.rt.eventStack.push(new Map([["TriggeringTrigger", jHandle(t.handleId, "trigger")]]));
    try {
      // Blizzard.j's body is `if TriggerEvaluate(trig) then call TriggerExecute(trig)`: the
      // conditions and nothing else. A DISABLED trigger still runs — disabling stops events.
      if (name === "ConditionalTriggerExecute" && !this.conditionsPass(t)) return JNULL;
      // `adoptWaits` is the whole rule: run it here, and hand the rest to the scheduler if it
      // sleeps. Note this makes the statement form behave exactly like the EXPRESSION form
      // (`if TriggerExecuteBJ(…)`), which has adopted since the campaign trigger queue needed
      // it — the two were never meant to differ.
      const tr = new Trace();
      this.runSync(this.runActionsG(t, tr), `trigger#${t.handleId}`, true, tr);
    } finally {
      // Pop OUR frame specifically. A suspension inside the actions is resumed by
      // `resumeThread`, which restores the same frames in the same order, so the top of the
      // stack is ours again by the time this runs.
      const top = this.rt.eventStack[this.rt.eventStack.length - 1];
      if (top && top.size === 1 && top.has("TriggeringTrigger")) this.rt.eventStack.pop();
    }
    return JNULL;
  }

  /** Run a trigger's action functions in order, on the current thread. One throwing
   *  action is logged and skipped — the rest still run (one bad trigger ≠ dead map). */
  private *runActionsG(trig: TriggerObj | undefined, ts: Trace): ThreadGen {
    let r = ts.take("acts");
    if (!r) {
      if (!trig) return JNULL;
      // `GetTriggerExecCount` counts the times the actions actually RAN, which is here and not
      // at the fire — a trigger whose conditions refused it was evaluated, not executed.
      trig.execs++;
      // Iterate a SNAPSHOT: an action may `TriggerRemoveAction` (its own, commonly) mid-run, and
      // splicing the array a live `for…of` is walking makes it skip the next one.
      r = { k: "acts", trig: trig.handleId, fns: trig.actions.map((a) => a.fn), i: 0 };
    }
    ts.recs.push(r);
    try {
      for (; r.i < r.fns.length; r.i++) {
        const fn = r.fns[r.i];
        try {
          yield* this.callFunctionG(fn, [], ts);
        } catch (err) {
          if (err instanceof ThreadAbort) throw err;
          this.rt.warnOnce(fn, `trigger action threw: ${(err as Error).message}`);
        }
      }
    } finally {
      ts.recs.pop();
    }
    return JNULL;
  }

  /** Evaluate a trigger's conditions (synchronously — WC3 can't wait in a condition). */
  private conditionsPass(trig: TriggerObj): boolean {
    trig.evals++; // GetTriggerEvalCount — every weighing, passed or not
    return triggerConditionsPass(trig, (fn) => this.callFunction(fn, []));
  }

  private arrayFor(name: string, frame: Frame | null): JassArray {
    const local = frame?.arrays.get(name);
    if (local) return local;
    let g = this.rt.globalArrays.get(name);
    if (!g) {
      g = new JassArray("integer"); // tolerate an undeclared array target
      this.rt.globalArrays.set(name, g);
    }
    return g;
  }

  private eval(e: Expr, frame: Frame | null): JassValue {
    switch (e.kind) {
      case "int":
        return jInt(e.value);
      case "real":
        return jReal(e.value);
      case "string":
        // Resolve World-Editor "TRIGSTR_nnn" placeholders from war3map.wts (no-op
        // for ordinary strings / when no table is loaded).
        return jStr(this.rt.resolveTrigStr(e.value));
      case "bool":
        return jBool(e.value);
      case "null":
        return JNULL;
      case "code":
        return { k: "code", fn: e.name };
      case "var": {
        // One lookup a scope: a stored value is never `undefined`, so a miss is the answer.
        const l = frame?.vars.get(e.name);
        if (l !== undefined) return l;
        const g = this.rt.globals.get(e.name);
        if (g !== undefined) return g;
        this.rt.warnOnce(e.name, "undefined variable");
        return JNULL;
      }
      case "index": {
        const idx = asInt(this.eval(e.index, frame));
        return this.arrayFor(e.name, frame).get(idx);
      }
      case "call":
        // A function called from an EXPRESSION may legitimately wait in WC3 — the whole
        // thread blocks there — so if it does, the rest of it is adopted rather than dropped
        // (runSync). A condition, a filter or an enum callback is a different matter: WC3
        // forbids a wait in those, and they keep the strict behaviour.
        return this.callFunction(e.name, e.args.map((a) => this.eval(a, frame)), true);
      case "unary":
        return this.evalUnary(e.op, this.eval(e.expr, frame));
      case "binary":
        return this.evalBinary(e, frame);
    }
  }

  /**
   * `eval` for a THREAD, where an expression may suspend.
   *
   * The real JASS VM is a bytecode machine: a function called from inside an expression can
   * wait, and the whole thread waits there with it. `eval` cannot suspend (it is plain JS), so
   * an expression that reaches a SCRIPT function is evaluated here instead, as a generator,
   * and the wait travels up to whatever is driving the thread. Anything that calls no script
   * function takes `eval` unchanged, which is nearly every expression there is.
   *
   * Two scripts are why, one per VM:
   *
   *  • common.ai's wave loop is `if not PrepSuicideOnPlayer(seconds) then`, `exitwhen
   *    SuicidePlayer(p, …)` and `set have = WaitForSignal()`, each of which sleeps for minutes.
   *    Handed a null at once, every campaign wave "failed" and the next began in the same
   *    instant, until the loop cap.
   *  • a MAP's own AI does the same thing. DotA AI buys an item with `return RGE(…)` /
   *    `set ok = RGE(…)`, and `RGE` creates the item, hands it to the hero and then polls a
   *    per-player flag its own pickup trigger sets (`TriggerSleepAction(0.1)` in a loop). This
   *    used to be an AI-VM-only path: a map's VM adopted the rest of such a call as a thread of
   *    its own and told the caller "false" (runSync). So the shopping list ran on at once
   *    with the first purchase still in flight, every later one reset the flag the earlier
   *    ones were waiting on, the gold was spent and the buyers never woke — heroes kept the
   *    six items they started with for the rest of the match.
   *
   * Where the thread CANNOT wait — a condition, a filter, an enum callback, all driven by
   * `runSync` — the wait still ends the callback there, as it does in the game.
   */
  private *evalG(e: Expr, frame: Frame, ts: Trace): ThreadGen {
    if (!this.mayWait(e)) return this.eval(e, frame);
    switch (e.kind) {
      case "index": {
        const idx = asInt(yield* this.evalG(e.index, frame, ts));
        return this.arrayFor(e.name, frame).get(idx);
      }
      case "call": {
        const r = ts.take("ecall") ?? { k: "ecall" as const, args: [] as JassValue[], ph: 0 as 0 | 1 };
        ts.recs.push(r);
        try {
          if (r.ph === 0) {
            while (r.args.length < e.args.length) {
              const v = yield* this.evalG(e.args[r.args.length], frame, ts);
              r.args.push(v);
            }
            r.ph = 1;
          }
          return yield* this.callFunctionG(e.name, r.args, ts);
        } finally {
          ts.recs.pop();
        }
      }
      case "unary":
        return this.evalUnary(e.op, yield* this.evalG(e.expr, frame, ts));
      case "binary": {
        // Left first, and `and`/`or` stop where `evalBinary` stops — the two evaluators must
        // not disagree about whether the right-hand side of `u != null and Ready(u)` runs.
        const r = ts.take("bin") ?? { k: "bin" as const, ph: 0 as 0 | 1, l: JNULL as JassValue };
        ts.recs.push(r);
        try {
          if (r.ph === 0) {
            r.l = yield* this.evalG(e.left, frame, ts);
            if (e.op === "and" && !truthy(r.l)) return jBool(false);
            if (e.op === "or" && truthy(r.l)) return jBool(true);
            r.ph = 1;
          }
          const rv = yield* this.evalG(e.right, frame, ts);
          return this.binaryOf(e.op, r.l, rv);
        } finally {
          ts.recs.pop();
        }
      }
      default:
        return this.eval(e, frame);
    }
  }

  /** Does this expression call a SCRIPT function anywhere (the only thing that can sleep)?
   *  A property of the tree, so it is worked out once per node. */
  private mayWait(e: Expr): boolean {
    const hit = this.waitCache.get(e);
    if (hit !== undefined) return hit;
    let r = false;
    switch (e.kind) {
      case "index": r = this.mayWait(e.index); break;
      case "call": r = (!this.rt.natives.has(e.name) && this.rt.functions.has(e.name)) || e.args.some((a) => this.mayWait(a)); break;
      case "unary": r = this.mayWait(e.expr); break;
      case "binary": r = this.mayWait(e.left) || this.mayWait(e.right); break;
    }
    this.waitCache.set(e, r);
    return r;
  }
  private readonly waitCache = new WeakMap<Expr, boolean>();

  /** Can any argument of this CALL STATEMENT wait — `mayWait` over its arguments, kept per
   *  statement as `mayWait` is per expression, since a native call statement asks it every time
   *  it runs. */
  private argsMayWait(s: Extract<Stmt, { kind: "call" }>): boolean {
    let hit = this.stmtWaitCache.get(s);
    if (hit === undefined) {
      hit = false;
      for (const a of s.args) if (this.mayWait(a)) { hit = true; break; }
      this.stmtWaitCache.set(s, hit);
    }
    return hit;
  }
  private readonly stmtWaitCache = new WeakMap<Stmt, boolean>();

  private evalUnary(op: "-" | "not" | "+", v: JassValue): JassValue {
    if (op === "not") return jBool(!truthy(v));
    if (op === "+") return v;
    return v.k === "real" ? jReal(-v.n) : jInt(-asInt(v)); // negate, preserving kind
  }

  private evalBinary(e: Extract<Expr, { kind: "binary" }>, frame: Frame | null): JassValue {
    // and/or stop at the side that decides them (JS `&&`/`||` below), as JASS does.
    if (e.op === "and") return jBool(truthy(this.eval(e.left, frame)) && truthy(this.eval(e.right, frame)));
    if (e.op === "or") return jBool(truthy(this.eval(e.left, frame)) || truthy(this.eval(e.right, frame)));

    return this.binaryOf(e.op, this.eval(e.left, frame), this.eval(e.right, frame));
  }

  private binaryOf(op: BinOp, l: JassValue, r: JassValue): JassValue {
    switch (op) {
      case "and":
        return jBool(truthy(l) && truthy(r));
      case "or":
        return jBool(truthy(l) || truthy(r));
      case "==":
        return jBool(jassEquals(l, r));
      case "!=":
        return jBool(jassNotEquals(l, r));
      case "<":
        return jBool(asNum(l) < asNum(r));
      case ">":
        return jBool(asNum(l) > asNum(r));
      case "<=":
        return jBool(asNum(l) <= asNum(r));
      case ">=":
        return jBool(asNum(l) >= asNum(r));
      case "+":
        if (l.k === "string" || r.k === "string") return jStr(asStr(l) + asStr(r));
        // Two NULL operands can only be two strings — a number is never null and a handle
        // cannot be added — now that an unset string is null (values.ts `defaultForType`).
        if (l.k === "null" && r.k === "null") return jStr("");
        return this.arith(l, r, (a, b) => a + b);
      case "-":
        return this.arith(l, r, (a, b) => a - b);
      case "*":
        // integer * integer WRAPS at 32 bits, as the game's VM does. The product of two int32s
        // can reach 2^62, past the 2^53 a double holds exactly, so `(a * b) | 0` drops the low
        // bits it is meant to keep (1103515245 * 2147483647 came out 1043968512, not
        // 1043968403) — and the low bits are the whole of a map's LCG, string hash or save code.
        if (l.k === "int" && r.k === "int") return jInt(Math.imul(l.n, r.n));
        return this.arith(l, r, (a, b) => a * b);
      case "/":
        return this.divide(l, r);
    }
  }

  /** +,-,* : integer if BOTH operands are integers, else real (JASS widening). */
  private arith(l: JassValue, r: JassValue, f: (a: number, b: number) => number): JassValue {
    const bothInt = l.k === "int" && r.k === "int";
    const val = f(asNum(l), asNum(r));
    return bothInt ? jInt(val) : jReal(val);
  }

  /** `/` : integer/integer is TRUNCATING integer division; any real operand makes
   *  it real division. Divide-by-zero yields 0 (JASS doesn't propagate Inf/NaN). */
  private divide(l: JassValue, r: JassValue): JassValue {
    const b = asNum(r);
    if (l.k === "int" && r.k === "int") return jInt(b === 0 ? 0 : Math.trunc(asNum(l) / b));
    return jReal(b === 0 ? 0 : asNum(l) / b);
  }

  /** Run a top-level function by name (config, main, or any trigger callback) on its
   *  own trigger thread. Returns its value if it ran to completion — the normal case —
   *  or null if it suspended on a wait (a map-init trigger with a `Wait`), in which case
   *  the pump resumes it. WC3 runs `main()` on a thread too, for exactly this reason. */
  run(fnName: string, args: JassValue[] = []): JassValue {
    const ts = new Trace();
    return this.startThread(fnName, this.callFunctionG(fnName, args, ts), ts).result;
  }

  // --- trigger threads (milestone 7.15) -------------------------------------

  /** Start a thread and run it **immediately**, up to its first wait (WC3 runs trigger
   *  actions the moment the event fires — the wait is what defers the rest). It only
   *  joins the scheduler if it actually suspended. */
  private startThread(label: string, gen: ThreadGen, ts: Trace, responses?: Map<string, JassValue>): JassThread {
    const t: JassThread = {
      id: this.nextThreadId++,
      label,
      gen,
      ts,
      stack: responses ? [responses] : [],
      depth: 0,
      wakeAt: this.rt.gameTime,
      lastTick: this.pumpTick,
      done: false,
      result: JNULL,
    };
    if (this.threads.length >= MAX_THREADS) {
      this.rt.warnOnce("<threads>", `thread cap (${MAX_THREADS}) hit — trigger thread dropped`);
      t.done = true;
      return t;
    }
    this.resumeThread(t);
    if (!t.done) this.threads.push(t);
    return t;
  }

  /** Resume (or first-run) a thread: make its saved context current — event-response
   *  frames, call depth, and a clean sync depth (a thread is a fresh execution context
   *  even when spawned from inside a native) — step the generator, then save whatever
   *  it left behind for next time. A thread that throws is logged and dies; it never
   *  takes the frame down with it. */
  private resumeThread(t: JassThread): void {
    const savedDepth = this.depth;
    const savedSync = this.syncDepth;
    const savedThread = this.currentThread;
    const base = this.rt.eventStack.length;
    this.depth = t.depth;
    this.syncDepth = 0;
    this.currentThread = t;
    for (const f of t.stack) this.rt.eventStack.push(f);
    try {
      const r = t.gen.next();
      if (r.done) {
        t.done = true;
        t.result = typeof r.value === "object" ? r.value : JNULL;
      } else {
        t.wakeAt = this.rt.gameTime + Math.max(0, typeof r.value === "number" ? r.value : 0);
      }
    } catch (err) {
      if (!(err instanceof ThreadAbort)) {
        this.rt.warnOnce(t.label, `trigger thread threw: ${(err as Error).message}`);
      }
      t.done = true;
    } finally {
      // Whatever frames the thread pushed and hasn't popped are ITS event responses —
      // lift them off the shared stack and carry them to the next resume.
      t.stack = this.rt.eventStack.splice(base);
      t.depth = this.depth;
      t.lastTick = this.pumpTick;
      this.depth = savedDepth;
      this.syncDepth = savedSync;
      this.currentThread = savedThread;
    }
  }

  /**
   * The map's OWN pause (`PauseGame(true)`) stops the world and every timer, but NOT a
   * `TriggerSleepAction`: jassbot's TriggerSleepAction notes that it keeps counting while the
   * game is paused with PauseGame (unlike a timer), and does NOT count while a PLAYER has paused.
   * The frame loop calls this, one SIM_DT at a time, for as long as the script's pause is the
   * only thing stopping the world. Nothing else moves: `rt.gameTime` stays where it is (a timer
   * and `PolledWait`, which is a timer underneath, hold), so the sleepers are brought nearer
   * their wake time instead of the clock being moved past it.
   *
   * Without it, "pause the game, wait 5 s, unpause" — World of Angel Arena's whole "-ar" — was
   * a pause nothing could ever lift: the thread that would lift it waited on a clock the pause
   * had stopped. Shifting `wakeAt` rather than keeping a second clock keeps a saved game's
   * threads (written with absolute `wakeAt`s) meaning what they meant.
   */
  advanceWaitsOnly(dt: number): void {
    for (const t of this.threads) if (!t.done) t.wakeAt -= dt;
    this.pumpThreads();
  }

  /** Resume every thread whose wake time has come (pumped from the sim tick, after the
   *  timers). A thread resumes at most **once per pump**: that's what makes a wait cost
   *  at least a frame, so `loop / TriggerSleepAction(0) / endloop` can't hang the tick. */
  private pumpThreads(): void {
    this.pumpTick++;
    if (!this.threads.length) return;
    for (const t of [...this.threads]) {
      if (t.done || t.lastTick >= this.pumpTick || t.wakeAt > this.rt.gameTime) continue;
      this.resumeThread(t);
    }
    if (this.threads.some((t) => t.done)) this.threads = this.threads.filter((t) => !t.done);
  }

  /** How many threads are parked on a wait (diagnostics / tests). */
  /**
   * Why this VM cannot be saved right now, or null when it can (docs/save-games.md). A save is
   * taken BETWEEN steps, when every thread is parked on a wait — never in the middle of one —
   * and a thread parked inside a Lua coroutine cannot be described (`Trace.opaque`).
   */
  unsaveable(): string | null {
    if (this.currentThread || this.syncDepth > 0 || this.depth > 0) return "the script is running";
    if (this.threads.some((t) => !t.done && t.ts.opaque > 0)) return "a Lua thread is waiting";
    return null;
  }

  /** Every parked thread, as data — its trace, its event responses and its wake time. The
   *  generator itself is not written: `restoreThreads` rebuilds it from the trace. */
  captureThreads(): SavedThreads {
    const why = this.unsaveable();
    if (why) throw new Error(`save: ${why}`);
    return {
      threads: this.threads.filter((t) => !t.done).map((t) => ({
        // A thread loaded from a save and not yet woken is still holding its saved trace in
        // `resume` (the generators take it back only when they run) — that IS where it is, so a
        // game saved straight after a load writes the same thread it read.
        id: t.id, label: t.label, recs: t.ts.resume && t.ts.at === 0 ? t.ts.resume : t.ts.recs, stack: t.stack, wakeAt: t.wakeAt, lastTick: t.lastTick,
      })),
      nextThreadId: this.nextThreadId,
      pumpTick: this.pumpTick,
    };
  }

  /**
   * Put a saved game's threads back on this VM — which must hold the SAME script, already
   * restored to the saved runtime (the handles a trace's `acts` record names must exist).
   *
   * Each thread's generator chain is started again on its saved trace: nothing runs now; when
   * the pump next resumes it, every generator takes its own record back and the innermost wait
   * returns, and the thread carries on from where the saved one was parked.
   */
  restoreThreads(saved: SavedThreads): void {
    this.threads = [];
    let recordOnlyFrames = 0;
    for (const st of saved.threads) {
      const ts = new Trace();
      ts.resume = st.recs.length ? st.recs : null;
      const root = st.recs[0];
      let gen: ThreadGen;
      if (root?.k === "cf") gen = this.callFunctionG(root.name, [], ts);
      else if (root?.k === "user") {
        const fn = this.rt.functions.get(root.fn);
        if (!fn) throw new Error(`save: a saved thread runs ${root.fn}, which this script does not have`);
        gen = this.callUserG(fn, [], ts);
      } else if (root?.k === "acts") gen = this.runActionsG(this.rt.handles.get(root.trig) as TriggerObj | undefined, ts);
      else throw new Error(`save: a saved thread (${st.label}) starts on a ${root?.k ?? "nothing"} record`);
      for (const r of st.recs) if (r.k === "user" && this.rt.recordOnlySpawnFns.has(r.fn)) recordOnlyFrames++;
      this.threads.push({
        id: st.id, label: st.label, gen, ts, stack: st.stack,
        // Zero, not the saved depth: every frame on the trace counts itself back in as the chain
        // re-enters it (callUserG), which is how the saved depth was reached in the first place.
        depth: 0,
        wakeAt: st.wakeAt, lastTick: st.lastTick, done: false, result: JNULL,
      });
    }
    this.nextThreadId = saved.nextThreadId;
    this.pumpTick = saved.pumpTick;
    // …and the record-only scope likewise: the saved runtime's count includes the frames of
    // parked threads, which re-enter it on resume.
    this.rt.spawnDepth = Math.max(0, this.rt.spawnDepth - recordOnlyFrames);
  }

  get sleepingThreads(): number {
    return this.threads.length;
  }

  // --- event runtime (milestone 7.4) ----------------------------------------

  /** Fire a trigger: evaluate its conditions with the event responses in scope, then —
   *  if they pass — run its actions on a **thread** (7.15), which starts immediately but
   *  can suspend on a `TriggerSleepAction` and resume later with those same responses
   *  still readable (`GetTriggerUnit` after a wait). This is the ECA execution the whole
   *  event model routes through (timers here; sim events via fireEvent). */
  fireTrigger(trig: TriggerObj, responses: Map<string, JassValue>): void {
    if (!trig.enabled) return;
    this.rt.eventStack.push(responses);
    let pass: boolean;
    try {
      pass = this.conditionsPass(trig);
    } finally {
      this.rt.eventStack.pop();
    }
    if (pass) {
      const ts = new Trace();
      this.startThread(`trigger#${trig.handleId}`, this.runActionsG(trig, ts), ts, responses);
    }
  }

  /**
   * `TriggerRegisterVariableEvent` — "Value Of Real Variable": `<Variable> becomes <Operation>
   * <Value>` (UI\TriggerStrings.txt). Raised by the WRITE itself, synchronously: the trigger's
   * conditions run and its actions start before the statement after the `set` does, and a
   * variable event raised from inside another one's actions runs to its first wait before the
   * outer dispatch goes on (hiveworkshop 370527 — Dr Super Good on why "the last onDeath
   * function will never be called" when handlers nest; that is this order, not a bug in it).
   *
   * An assignment that does not CHANGE the value raises nothing: "If the function is called
   * twice before it can be set to 0, the second event won't fire because you set variable with
   * value 1 to 1 again which doesn't trigger the event" (hiveworkshop 201641, GUI Unit Event) —
   * which is why every such library resets its variable to 0 between events. What no source we
   * found settles is a write that changes the value while the condition ALREADY held (1 → 2
   * under "greater than 0"); we raise it, on the reading that the comparison is made at each
   * write. The GUI's "becomes" is the only hint the other way. Every map in the corpus compares
   * with EQUAL, where the two readings are the same.
   */
  private fireVariableEvent(name: string, before: JassValue, after: JassValue): void {
    const was = asNum(before);
    const now = asNum(after);
    if (was === now) return;
    const regs = this.rt.regsFor("variable").filter((r) => r.params[0]?.k === "string" && r.params[0].s === name);
    for (const reg of regs) {
      if (!compareLimit(this.rt.enumIndex(reg.params[1] ?? JNULL), now, asNum(reg.params[2] ?? JNULL))) continue;
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (trig) this.fireTrigger(trig, this.withTrigger(new Map(), trig, reg));
    }
  }

  /** Dispatch a sim-raised event to every trigger registered for `kind` whose
   *  registration `params` match (the caller supplies both the event responses and
   *  the matcher). Used by the bridge to raise unit-death / enter-region / … from
   *  the sim tick. Registrations are bucketed by kind (Runtime.regsFor). */
  fireEvent(kind: string, responses: Map<string, JassValue>, matches?: (params: JassValue[]) => boolean): void {
    // Snapshot: an action may add/remove registrations mid-dispatch.
    const regs = this.rt.regsFor(kind).filter((r) => !matches || matches(r.params));
    for (const reg of regs) {
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (trig) this.fireTrigger(trig, this.withTrigger(responses, trig, reg));
    }
  }

  /** Advance game time by `dt` seconds (pumped from the sim tick): expire timers, then
   *  resume any trigger thread whose `TriggerSleepAction` has run out (7.15). An expired
   *  timer runs its TimerStart handler code and fires any trigger registered on it
   *  (TriggerRegisterTimerExpireEvent); periodic timers re-arm. The inner guard
   *  stops a zero/negative-timeout periodic timer from looping forever in one tick. */
  advanceTime(dt: number): void {
    this.rt.gameTime += dt;
    // Iterate a SNAPSHOT. An expiring timer's handler routinely mutates rt.timers — the
    // one-shot idiom is `CreateTimer` … `DestroyTimer(GetExpiredTimer())`, and blizzard.j's
    // own MarkGameStarted destroys `bj_gameStartedTimer` from inside its handler — and
    // DestroyTimer SPLICES the list. Splicing during a live `for…of` makes the iterator skip
    // the very next element, so the timer registered after the self-destroying one silently
    // lost that tick, every time. (It cost the whole map: MarkGameStarted fires 0.01 s in,
    // and the next timer created after it never advanced again.) DestroyTimer clears
    // `running` before it splices, so the guard below still drops anything removed mid-pump.
    for (const t of [...this.rt.timers]) {
      if (!t.running) continue;
      t.remaining -= dt;
      t.elapsedTotal += dt;
      let guard = 0;
      while (t.running && t.remaining <= 0 && guard++ < 10000) {
        // The timer's own state is settled BEFORE its handler runs, because the handler reads
        // and writes it. A ONE-SHOT is spent at exactly zero: the step's overshoot is our
        // clock's granularity, not time the timer has left, and `TimerGetRemaining == 0` is how
        // a map asks "has it run out" — DotA's game start is `if TimerGetRemaining(PL4)==0`
        // polled every 0.25 s, so a remainder of −0.0067 meant no game, no creep waves, ever.
        // And it is switched off FIRST so the handler may re-arm it: `TimerStart(GetExpiredTimer(),
        // …)` inside its own callback is a standard idiom, and clearing `running` afterwards
        // stopped the timer the handler had just started.
        const periodic = t.periodic && t.timeout > 0;
        if (periodic) t.remaining += t.timeout;
        else {
          t.elapsedTotal = t.timeout; // …and its elapsed stops at its timeout, not past it
          t.remaining = 0;
          t.running = false;
        }
        this.expireTimer(t);
        if (!periodic) break;
      }
    }
    this.pumpThreads(); // waits come due AFTER the clock moved (so a 0s wait costs one tick)
    // Floating text ages on GAME time too (7.19), so tags freeze with a paused game and
    // drift in step with the timers that spawned them — never with the render clock.
    this.rt.advanceTextTags(dt);
  }

  private expireTimer(t: TimerObj): void {
    const responses = new Map<string, JassValue>([["ExpiredTimer", jHandle(t.handleId, "timer")]]);
    // A timer handler runs on its own thread — WC3 lets one TriggerSleepAction (and the
    // periodic re-arm keeps ticking while it sleeps).
    if (t.handlerFn) {
      const ts = new Trace();
      this.startThread(`timer#${t.handleId}`, this.callFunctionG(t.handlerFn, [], ts), ts, responses);
    }
    // Only THIS timer's registrations (Runtime.regsFor) — this loop used to walk every
    // registration in the map once per expiry, of every timer.
    for (const reg of this.rt.regsFor(`timerExpire#${t.handleId}`)) {
      if (reg.params[0]?.k === "handle" && reg.params[0].h === t.handleId) {
        const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
        // …`withTrigger` like every other dispatch: a timer event is an event, so
        // `GetTriggeringTrigger()` answers with the trigger it is firing. This was the ONE
        // fireTrigger call site without it, and the editor's run-once idiom on a periodic
        // time event is where it shows: Human01's "Ledger Quest" is a 0.5 s periodic trigger
        // whose first action is `DisableTrigger( GetTriggeringTrigger() )`, so with a null
        // response it never turned itself off and re-queued Gerard's quest for ever — every
        // half-second Arthas stood in the rect (and a queued trigger still runs disabled:
        // `TriggerExecuteBJ` gates on TriggerEvaluate, not on the enabled flag).
        if (trig) this.fireTrigger(trig, this.withTrigger(responses, trig, reg));
      }
    }
  }

  /** Add the standard responses for the trigger being fired: `GetTriggeringTrigger`, and —
   *  when the dispatch knows which REGISTRATION matched — `GetTriggerEventId`. */
  private withTrigger(responses: Map<string, JassValue>, trig: TriggerObj, reg?: TriggerReg): Map<string, JassValue> {
    const m = new Map(responses);
    m.set("TriggeringTrigger", jHandle(trig.handleId, "trigger"));
    // GetTriggerPlayer on an EVENT_PLAYER_UNIT_* event is the player the registration was made
    // FOR — the unit's owner, which is what `playerUnitEventMatches` already matched it on. No
    // pump of those events (train, death, construct, research, sell, spell…) put it in its
    // responses, so it answered null, and a null player is Player 0: (2)SunhoofMesa_v1.4_ATR's
    // `CreateUnit(GetTriggerPlayer(), udg_HeroType[…])` handed every hero a COMPUTER's altar
    // made to the person in seat 0, and its tech swap went to them too. "Triggering Player" is
    // one of the GUI's commonest responses, so this was every such trigger on every map.
    if (reg?.kind === "playerUnitEvent" && !m.has("TriggerPlayer") && reg.params[0]) m.set("TriggerPlayer", reg.params[0]);
    const id = reg ? this.eventIdOf(reg) : undefined;
    if (id) m.set("TriggerEventId", id);
    return m;
  }

  /**
   * `GetTriggerEventId` — WHICH event fired this trigger, as the very constant the map compares
   * it against (docs/map-compatibility.md pass 5).
   *
   * It is a fact about the REGISTRATION, not the trigger, and the maps that call it are the
   * proof: they register one trigger on several events and branch on which one arrived. Across
   * the later-format corpus the commonest comparisons are `EVENT_UNIT_DEATH` (114) and
   * `EVENT_UNIT_DAMAGED` (72) — typically both registered on the SAME trigger — so an id
   * stored per trigger would answer the last one registered for every event it received.
   *
   * Two ways a registration names its event, and both hand back the handle the map already
   * holds, so `GetTriggerEventId() == EVENT_UNIT_DEATH` is plain handle identity:
   *
   *   * EXPLICITLY — `TriggerRegisterUnitEvent(t, u, EVENT_UNIT_DEATH)` and its player, game and
   *     player-unit siblings carry the constant in their params. Enum handles are interned by
   *     `(Convert…, index)`, so the param IS the global. Found by type rather than by position,
   *     because the position differs between the four registrars.
   *   * IMPLICITLY — a timer, a region, a death on a widget, a state limit, a chat line, a
   *     dialog: the registrar's NAME is the event and no constant is passed. Those are resolved
   *     by NAME against the runtime's own globals, i.e. against `common.j` as the install ships
   *     it, so no index is retyped here. A kind with no constant in 1.30.4 — the unit-in-range
   *     circle has none — gets no id, and the native answers null, which is what a map comparing
   *     against nothing would get anyway.
   */
  private eventIdOf(reg: TriggerReg): JassValue | undefined {
    for (const p of reg.params) if (p?.k === "handle" && p.ty.endsWith("Event")) return p;
    const name = IMPLIED_EVENT[reg.kind];
    return name ? this.rt.globals.get(name) : undefined;
  }

  // --- live enter/leave-region pump (milestone 7.4b) -------------------------

  /** Which sim units were inside each enter/leave registration's rect(s) — or inside a
   *  `unitInRange` registration's circle — last pump. Keyed by the registration object
   *  (stable across ticks) so a crossing is a set-difference, not a re-scan. */
  private readonly regionMembers = new Map<TriggerReg, Set<number>>();

  /** Pump enter/leave-region events from the sim tick: for every enter/leave
   *  registration, diff the set of units currently inside its rect(s) against last
   *  tick and fire the trigger on each crossing (GetTriggerUnit + GetEnteringUnit /
   *  GetLeavingUnit set to the crossing unit). Units already inside when a trigger
   *  is registered do NOT fire — the first pump for a registration seeds a silent
   *  baseline, matching WC3. Cheap: O(regs × units) containment checks per tick.
   *
   * `TriggerRegisterUnitInRange` rides the same pump under `unitInRange`: it is an
   * enter-region whose region is a CIRCLE centred on a unit, so the only thing that
   * differs is how membership is computed — the baseline, the filter and the responses
   * are the rect event's. See `inRangeMembers`. */
  pumpRegions(units: ReadonlyArray<UnitSnapshot>): void {
    const gen = ++this.regionGen;
    // Which units MOVED since the last pump (a unit new to the pump counts as moved), and which
    // are GONE. A rect registration whose rects are as they were, and which was pumped last
    // time too, then re-tests only those (issue #387): a unit standing still is in exactly the
    // regions it was in. On a custom map that was every registration × every unit × 60 Hz.
    const moved = this.regionMoved;
    moved.length = 0;
    const pos = this.regionPos;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const p = pos.get(u.id);
      if (!p) {
        pos.set(u.id, [u.x, u.y, gen]);
        moved.push(i);
      } else {
        if (p[0] !== u.x || p[1] !== u.y) {
          p[0] = u.x;
          p[1] = u.y;
          moved.push(i);
        }
        p[2] = gen;
      }
    }
    const gone = this.regionGone;
    gone.length = 0;
    if (pos.size > units.length) {
      for (const [id, p] of pos) if (p[2] !== gen) { gone.push(id); pos.delete(id); }
    }
    let byId: Map<number, UnitSnapshot> | null = null; // the circle's centre, looked up once a pump

    for (const reg of this.rt.regsFor("enterRegion", "leaveRegion", "unitInRange")) {
      const inRange = reg.kind === "unitInRange";
      const entering = inRange || reg.kind === "enterRegion"; // a circle only has an "in"
      if (!entering && reg.kind !== "leaveRegion") continue;
      const prev = this.regionMembers.get(reg);
      // A circle's centre walks, so a circle is always measured whole.
      if (inRange) {
        byId ??= new Map(units.map((u) => [u.id, u]));
        const cur = this.inRangeMembers(reg, units, byId);
        this.regionSeen.delete(reg);
        if (!cur) continue; // no region to be inside (the centre unit is gone)
        this.regionMembers.set(reg, cur);
        if (prev) this.fireRegionDiff(reg, units, prev, cur, entering);
        continue;
      }
      const shape = this.regionShape(reg);
      if (!shape) {
        this.regionSeen.delete(reg);
        continue; // no region to be inside (an unresolvable rect)
      }
      const seen = this.regionSeen.get(reg);
      const same = RegionDiff.enabled && !!prev && !!seen && seen.gen === gen - 1 && sameShape(seen.sig, shape.sig);
      this.regionSeen.set(reg, { gen, sig: shape.sig });
      if (!same) {
        const cur = new Set<number>();
        for (const u of units) if (inShape(shape, u.x, u.y)) cur.add(u.id);
        this.regionMembers.set(reg, cur);
        if (prev) this.fireRegionDiff(reg, units, prev, cur, entering);
        continue; // …and with no `prev` this was the baseline: seeded without firing
      }
      // Incremental: the crossings are among the moved, in the snapshot's order — the order the
      // whole-set diff found them in.
      const members = prev!;
      for (const id of gone) members.delete(id);
      let crossed: number[] | null = null;
      for (const i of moved) {
        const u = units[i];
        if (inShape(shape, u.x, u.y) !== members.has(u.id)) (crossed ??= []).push(i);
      }
      if (!crossed) continue;
      for (const i of crossed) {
        const id = units[i].id;
        if (members.has(id)) members.delete(id);
        else members.add(id);
      }
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (!trig || !trig.enabled) continue;
      for (const i of crossed) {
        const u = units[i];
        if (members.has(u.id) === entering) this.fireRegionCrossing(reg, trig, u, entering ? "EnteringUnit" : "LeavingUnit");
      }
    }
  }

  /** Fire the crossings between two whole memberships of one registration: entering in the
   *  snapshot's order, and so is leaving — a unit no longer in the world left nothing. */
  private fireRegionDiff(reg: TriggerReg, units: ReadonlyArray<UnitSnapshot>, prev: Set<number>, cur: Set<number>, entering: boolean): void {
    const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
    if (!trig || !trig.enabled) return;
    for (const u of units) {
      if (entering ? cur.has(u.id) && !prev.has(u.id) : prev.has(u.id) && !cur.has(u.id)) {
        this.fireRegionCrossing(reg, trig, u, entering ? "EnteringUnit" : "LeavingUnit");
      }
    }
  }

  /** The pump's bookkeeping beside `regionMembers` — all of it cache, rebuilt by a whole
   *  re-test (TRANSIENT in game/save/classes.ts). `regionPos`: each unit's position at the last
   *  pump and that pump's number; `regionSeen`: the pump a rect registration was last measured
   *  on and the shape it was measured against. */
  private regionGen = 0;
  private regionPos = new Map<number, [number, number, number]>();
  private regionSeen = new Map<TriggerReg, { gen: number; sig: number[] }>();
  private regionMoved: number[] = [];
  private regionGone: number[] = [];

  /** A rect registration's region as the pump tests it, with a SIGNATURE of everything the
   *  test reads (each rect's bounds, the holes) — two equal signatures are the same region.
   *  Null when it names no resolvable rect. */
  private regionShape(reg: TriggerReg): RegionShape | null {
    const rects = this.rectsOf(reg.params[0]);
    if (!rects.length) return null;
    const region = reg.params[0]?.k === "handle" ? this.rt.handles.get(reg.params[0].h) : undefined;
    const holes = isRegion(region) ? region.holes : undefined;
    const sig: number[] = [rects.length];
    for (const r of rects) sig.push(r.minx, r.miny, r.maxx, r.maxy);
    if (holes) for (const h of holes) sig.push(h.minx, h.miny, h.maxx, h.maxy);
    return { rects, holes, sig };
  }


  /**
   * Which units are inside a `TriggerRegisterUnitInRange(trigger, whichUnit, range, filter)`
   * circle right now — the moving region the rect pump's set-difference then reads exactly as
   * it reads a rect's.
   *
   * The centre is read out of the SNAPSHOT rather than off the `unit` handle, because the
   * snapshot is this tick's truth for both ends of the measurement and the handle is only as
   * fresh as the last thing that refreshed it. A centre that is no longer in the snapshot —
   * the villager died, the unit was removed — answers null: the circle does not exist, so
   * nobody is in it and nobody LEFT it either (the membership is dropped rather than emptied,
   * so a unit still standing there when the centre comes back is not a fresh crossing).
   *
   * Distance is centre-to-centre, the measure `DistanceBetweenUnits` and every `Rng`/`Area`
   * column in the game's data use. The registered unit is left out of its own circle: it sits
   * at distance 0 for ever, so it could never be a crossing anyway — this only says so out
   * loud instead of leaning on the baseline to hide it.
   */
  private inRangeMembers(reg: TriggerReg, units: ReadonlyArray<UnitSnapshot>, byId: ReadonlyMap<number, UnitSnapshot>): Set<number> | null {
    const watched = this.rt.data<JassUnit>(reg.params[0] ?? JNULL);
    if (!watched || watched.simId < 0) return null;
    const centre = byId.get(watched.simId);
    if (!centre) return null;
    const range = asNum(reg.params[1] ?? JNULL);
    const r2 = range * range;
    const cur = new Set<number>();
    for (const u of units) {
      if (u.id === centre.id) continue;
      const dx = u.x - centre.x, dy = u.y - centre.y;
      if (dx * dx + dy * dy <= r2) cur.add(u.id);
    }
    return cur;
  }

  /** Resolve a registration's region param to its rect bounds (a bare rect, or a
   *  region's member rects). */
  private rectsOf(param: JassValue | undefined): RectObj[] {
    if (!param || param.k !== "handle") return [];
    const obj = this.rt.handles.get(param.h);
    if (isRect(obj)) return [obj];
    if (isRegion(obj)) return obj.rects.map((h) => this.rt.handles.get(h)).filter(isRect);
    return [];
  }

  /** Fire one enter/leave crossing: mint the unit handle, honour a boolexpr filter
   *  (TriggerRegisterEnterRegion's 3rd arg — exposed as GetFilterUnit), then run the
   *  trigger with the right event responses.
   *
   * The crossing unit is BOTH `GetTriggerUnit` and `GetEnteringUnit`, for the circle event as
   * much as for the rect one — Human01's own villager triggers are the proof, since each
   * tests `GetTriggerUnit() == udg_Arthas` and then turns the villager to face
   * `GetEnteringUnit()`. Neither response is the unit the circle is centred ON; the script
   * already holds that one in the global it registered with. The filter's index does differ:
   * the rect event's is its 3rd argument, the circle's its 4th. */
  private fireRegionCrossing(reg: TriggerReg, trig: TriggerObj, u: UnitSnapshot, respKey: string): void {
    const handle = this.rt.unitForSim(u);
    if (!this.eventFilterPasses(reg.params[reg.kind === "unitInRange" ? 2 : 1], handle)) return;
    const responses = new Map<string, JassValue>([["TriggerUnit", handle], [respKey, handle]]);
    // GetTriggeringRegion — the region the registration was made on (not the circle of a
    // unit-in-range event, which has none).
    if (reg.kind !== "unitInRange" && reg.params[0]) responses.set("TriggeringRegion", reg.params[0]);
    this.fireTrigger(trig, this.withTrigger(responses, trig, reg));
  }

  /** Evaluate an event registration's boolexpr filter (enter-region's 3rd arg, a
   *  player-unit-event's filter, …) with the subject unit exposed as GetFilterUnit.
   *  A missing/empty filter passes. */
  private eventFilterPasses(filter: JassValue | undefined, unit: JassValue): boolean {
    if (!filter || filter.k !== "handle") return true;
    const be = this.rt.handles.get(filter.h) as BoolExpr | undefined;
    if (!be) return true;
    this.rt.eventStack.push(new Map([["FilterUnit", unit]]));
    try {
      return evalBoolExpr(be, (fn) => this.callFunction(fn, []));
    } finally {
      this.rt.eventStack.pop();
    }
  }

  /** Pump unit-death events from the sim tick (milestone 7.4c). For each death, mint
   *  the victim + killer handles (GetDyingUnit/GetTriggerUnit/GetKillingUnit) and fire
   *  every matching registration: a specific-unit `TriggerRegisterDeathEvent`, a
   *  `TriggerRegisterUnitEvent(unit, EVENT_UNIT_DEATH)`, or the common
   *  `TriggerRegisterPlayerUnitEvent(player, EVENT_PLAYER_UNIT_DEATH)` (which "a unit
   *  dies" compiles to, one per player) matched by the victim's owner. */
  pumpUnitDeaths(deaths: ReadonlyArray<DeathEvent>): void {
    for (const d of deaths) {
      const victim = this.rt.unitForSim(d.victim);
      const killer = d.killer ? this.rt.unitForSim(d.killer) : JNULL;
      const responses = new Map<string, JassValue>([["DyingUnit", victim], ["TriggerUnit", victim], ["KillingUnit", killer]]);
      this.dispatchToRegs(responses, this.rt.regsFor("unitDeath", `unitEvent#${EVENT_UNIT_DEATH}`, `playerUnitEvent#${EVENT_PLAYER_UNIT_DEATH}`), (reg) =>
        (reg.kind === "unitDeath" && this.paramUnitIs(reg, victim)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_DEATH) && this.paramUnitIs(reg, victim)) ||
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_DEATH, d.victim.owner, victim)));
    }
  }

  /**
   * Pump DESTRUCTIBLE deaths — a gate broken, a crate smashed, a barricade felled.
   *
   * `TriggerRegisterDeathEvent` takes a **widget**, not a unit (`Scripts\common.j`:
   * `native TriggerRegisterDeathEvent takes trigger whichTrigger, widget whichWidget`), and a
   * destructable is a widget exactly as a unit is. We only ever pumped units, so every
   * registration whose subject was a gate sat there forever — and a campaign map hangs whole
   * sequences off exactly that. Rise of the Naga has three:
   *
   *     call TriggerRegisterDeathEvent( gg_trg_Harbor_Cinematic,   gg_dest_ATg4_0111 )
   *     call TriggerRegisterDeathEvent( gg_trg_Village_Razed_Line, gg_dest_LTe1_1140 )
   *     call TriggerRegisterDeathEvent( gg_trg_Shared_Vision,      gg_dest_LTe1_1140 )
   *
   * The first of those is the harbour: breaking the demon gate is what starts the sequence
   * that gives the burning ships their attackers, opens the Save the Ships quest and clears
   * the harbour. Without the event the chapter simply never got to its second act.
   *
   * Matched by the record's MAP id rather than by handle identity, because the handle is
   * interned per map record (natives/destructables.ts) and every route to one — a `gg_dest_*`
   * set in main(), an `EnumDestructablesInRect` hand-out — resolves to the same object anyway.
   * Responses are WC3's: `GetDyingDestructable` and the generic `GetTriggerWidget`.
   */
  pumpDestructableDeaths(mapIds: ReadonlyArray<number>): void {
    for (const mapId of mapIds) {
      for (const reg of this.rt.regsFor("unitDeath")) {
        if (reg.kind !== "unitDeath") continue;
        const subject = reg.params[0];
        if (!subject || this.rt.data<{ mapId?: number }>(subject)?.mapId !== mapId) continue;
        const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
        if (!trig) continue;
        const responses = new Map<string, JassValue>([["DyingDestructable", subject], ["TriggerWidget", subject]]);
        this.fireTrigger(trig, this.withTrigger(responses, trig, reg));
      }
    }
  }

  /** Pump damage events (7.4c) — EVENT_UNIT_DAMAGED on the struck unit, with
   *  GetEventDamage / GetEventDamageSource. (WC3 has no per-player damage event.) */
  pumpDamageEvents(events: ReadonlyArray<DamageEvent>): void {
    for (const e of events) {
      const target = this.rt.unitForSim(e.target);
      const source = e.source ? this.rt.unitForSim(e.source) : JNULL;
      const responses = new Map<string, JassValue>([["TriggerUnit", target], ["EventDamageSource", source], ["EventDamage", jReal(e.amount)]]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_DAMAGED, EVENT_PLAYER_UNIT_DAMAGED), (reg) =>
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_DAMAGED) && this.paramUnitIs(reg, target)) ||
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_DAMAGED, e.target.owner, target)));
    }
  }

  /**
   * Raise one phase of a blow to the script, SYNCHRONOUSLY, while the sim is dealing it (the sim's
   * `damageHook`, set only for a map that can change a blow). The handlers run to their first wait
   * right here, and whatever they wrote into the blow through the natives is what the sim reads
   * back when this returns (runtime.damageStack). DAMAGING goes to EVENT_UNIT_DAMAGING /
   * EVENT_PLAYER_UNIT_DAMAGING, DAMAGED to the two classic damage events.
   */
  fireDamagePhase(phase: "damaging" | "damaged", blow: { target: EventUnitInfoLike; source: EventUnitInfoLike | null; amount: number; attackType: string; damageType: number; weaponSound: string }): void {
    const target = this.rt.unitForSim(blow.target as never);
    const source = blow.source ? this.rt.unitForSim(blow.source as never) : JNULL;
    const responses = new Map<string, JassValue>([["TriggerUnit", target], ["EventDamageSource", source], ["EventDamage", jReal(blow.amount)]]);
    const unitEvt = phase === "damaging" ? EVENT_UNIT_DAMAGING : EVENT_UNIT_DAMAGED;
    const playerEvt = phase === "damaging" ? EVENT_PLAYER_UNIT_DAMAGING : EVENT_PLAYER_UNIT_DAMAGED;
    this.rt.damageStack.push({ phase, blow });
    try {
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, target)) ||
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, blow.target.owner, target)));
    } finally {
      this.rt.damageStack.pop();
    }
  }

  /** Can this script change a blow? — calls a damage-event setter anywhere, which is what makes
   *  it need the synchronous path (SimWorld.damageHook). Asked of the loaded functions once. */
  scriptModifiesDamage(): boolean {
    if (this.modifiesDamage === undefined) {
      const setters = new Set(["BlzSetEventDamage", "BlzSetEventAttackType", "BlzSetEventDamageType", "BlzSetEventWeaponType"]);
      const inExpr = (e: Expr | undefined): boolean => {
        if (!e) return false;
        switch (e.kind) {
          case "call": return setters.has(e.name) || e.args.some(inExpr);
          case "index": return inExpr(e.index);
          case "unary": return inExpr(e.expr);
          case "binary": return inExpr(e.left) || inExpr(e.right);
          default: return false;
        }
      };
      const inStmts = (ss: Stmt[]): boolean => ss.some((s) => {
        switch (s.kind) {
          case "call": return setters.has(s.name) || s.args.some(inExpr);
          case "set": return inExpr(s.value) || inExpr(s.index);
          case "if": return s.branches.some((b) => inExpr(b.cond) || inStmts(b.body)) || (!!s.elseBody && inStmts(s.elseBody));
          case "loop": return inStmts(s.body);
          case "exitwhen": return inExpr(s.cond);
          case "return": return inExpr(s.value);
          default: return false;
        }
      });
      this.modifiesDamage = [...this.rt.functions.values()].some((f) => f.locals.some((l) => inExpr(l.init)) || inStmts(f.body));
    }
    return this.modifiesDamage;
  }
  private modifiesDamage: boolean | undefined;

  /** Pump attack events (7.4c) — EVENT_UNIT_ATTACKED (specific unit) + the common
   *  EVENT_PLAYER_UNIT_ATTACKED (per player), with GetAttacker. */
  pumpAttackEvents(events: ReadonlyArray<AttackEvent>): void {
    for (const e of events) {
      const attacked = this.rt.unitForSim(e.attacked);
      const attacker = this.rt.unitForSim(e.attacker);
      const responses = new Map<string, JassValue>([["TriggerUnit", attacked], ["Attacker", attacker]]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_ATTACKED, EVENT_PLAYER_UNIT_ATTACKED), (reg) =>
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_ATTACKED) && this.paramUnitIs(reg, attacked)) ||
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_ATTACKED, e.attacked.owner, attacked)));
    }
  }

  /** Pump issued-order events (7.14) — EVENT_(PLAYER_)UNIT_ISSUED_ORDER (no target, 38/75),
   *  _POINT_ORDER (point, 39/76), or _TARGET_ORDER (unit, 40/77), matched by the ordered
   *  unit's owner (player events) or the subject unit (unit events). Sets GetIssuedOrderId
   *  + GetOrderPointX/Y (point) / GetOrderTargetUnit (target). Fed by both the trigger
   *  IssueXOrder natives and the player command router. */
  pumpOrderEvents(events: ReadonlyArray<OrderEvent>): void {
    for (const e of events) {
      const unit = this.rt.unitForSim(e.unit);
      const target = e.target ? this.rt.unitForSim(e.target) : JNULL;
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", unit],
        ["OrderedUnit", unit],
        ["IssuedOrderId", jInt(e.orderId)],
        ["OrderPointX", jReal(e.x)],
        ["OrderPointY", jReal(e.y)],
        ["OrderTargetUnit", target],
        ["OrderTargetItem", e.item ? this.rt.itemForSim(e.item) : JNULL],
      ]);
      const playerEvt = e.kind === "immediate" ? EVENT_PLAYER_UNIT_ISSUED_ORDER : e.kind === "point" ? EVENT_PLAYER_UNIT_ISSUED_POINT_ORDER : EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER;
      const unitEvt = e.kind === "immediate" ? EVENT_UNIT_ISSUED_ORDER : e.kind === "point" ? EVENT_UNIT_ISSUED_POINT_ORDER : EVENT_UNIT_ISSUED_TARGET_ORDER;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.unit.owner, unit)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, unit)));
    }
  }

  /** Pump spell events (7.17) — the five phases of a cast. WC3 raises CHANNEL and CAST
   *  as the caster begins, EFFECT when the spell goes off (the phase nearly every GUI
   *  trigger listens for), FINISH + ENDCAST when it's over, and ENDCAST alone when a
   *  cast is interrupted. Responses: GetSpellAbilityId/GetSpellAbilityUnit/
   *  GetSpellTargetUnit/GetSpellTargetX/Y (+ GetTriggerUnit = the caster). */
  pumpSpellEvents(events: ReadonlyArray<SpellEvent>): void {
    for (const e of events) {
      const caster = this.rt.unitForSim(e.caster);
      const target = e.target ? this.rt.unitForSim(e.target) : JNULL;
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", caster],
        ["SpellAbilityUnit", caster],
        ["SpellAbilityId", jInt(rawcodeToInt(e.abilityId))],
        ["SpellTargetUnit", target],
        ["SpellTargetItem", e.item ? this.rt.itemForSim(e.item) : JNULL],
        ["SpellTargetX", jReal(e.x)],
        ["SpellTargetY", jReal(e.y)],
      ]);
      const phase = SPELL_PHASES.indexOf(e.phase);
      if (phase < 0) continue;
      const playerEvt = EVENT_PLAYER_UNIT_SPELL_CHANNEL + phase;
      const unitEvt = EVENT_UNIT_SPELL_CHANNEL + phase;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.caster.owner, caster)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, caster)));
    }
  }

  /** Pump construction events (7.17) — the foundation laid / build cancelled / building
   *  finished, matched by the structure's owner. Responses: GetConstructingStructure /
   *  GetCancelledStructure / GetConstructedStructure (+ GetTriggerUnit = the structure). */
  pumpConstructEvents(events: ReadonlyArray<ConstructEvent>): void {
    for (const e of events) {
      const s = this.rt.unitForSim(e.structure);
      const key = e.phase === "start" ? "ConstructingStructure" : e.phase === "cancel" ? "CancelledStructure" : "ConstructedStructure";
      const responses = new Map<string, JassValue>([["TriggerUnit", s], [key, s]]);
      const playerEvt = e.phase === "start" ? EVENT_PLAYER_UNIT_CONSTRUCT_START : e.phase === "cancel" ? EVENT_PLAYER_UNIT_CONSTRUCT_CANCEL : EVENT_PLAYER_UNIT_CONSTRUCT_FINISH;
      // common.j declares no unit-scoped CONSTRUCT_START (only 64/65) — so a "start"
      // matches player registrations only.
      const unitEvt = e.phase === "cancel" ? EVENT_UNIT_CONSTRUCT_CANCEL : e.phase === "finish" ? EVENT_UNIT_CONSTRUCT_FINISH : -1;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.structure.owner, s)) ||
        (unitEvt >= 0 && reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, s)));
    }
  }

  /** Pump training events (7.17). The subject unit is the TRAINING BUILDING (that's what
   *  GetTriggerUnit is on a train event, and what a unit-scoped registration watches);
   *  the finished unit is GetTrainedUnit, its type GetTrainedUnitType. */
  pumpTrainEvents(events: ReadonlyArray<TrainEvent>): void {
    for (const e of events) {
      const b = this.rt.unitForSim(e.building);
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", b],
        ["TrainedUnit", e.trained ? this.rt.unitForSim(e.trained) : JNULL],
        ["TrainedUnitType", jInt(rawcodeToInt(e.unitTypeId))],
      ]);
      const playerEvt = e.phase === "start" ? EVENT_PLAYER_UNIT_TRAIN_START : e.phase === "cancel" ? EVENT_PLAYER_UNIT_TRAIN_CANCEL : EVENT_PLAYER_UNIT_TRAIN_FINISH;
      const unitEvt = e.phase === "start" ? EVENT_UNIT_TRAIN_START : e.phase === "cancel" ? EVENT_UNIT_TRAIN_CANCEL : EVENT_UNIT_TRAIN_FINISH;
      // The registration's FILTER, though, is asked about the unit that walked out — not
      // about the building. blizzard.j is the proof: MeleeGrantHeroItems registers
      // TRAIN_FINISH with `filterMeleeTrainedUnitIsHeroBJ`, whose whole body is
      // `IsUnitType(GetFilterUnit(), UNIT_TYPE_HERO)`. Ask that of a Barracks and it is never
      // true, so no melee hero was ever handed its Scroll of Town Portal; ask it of the unit
      // that finished and the game's own rule falls out — heroes get one, footmen don't.
      // A start/cancel has no trained unit yet (only a type), so there the building stands.
      const filterSubject = e.trained ? (responses.get("TrainedUnit") as JassValue) : b;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.building.owner, b, filterSubject)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, b)));
    }
  }

  /** Pump research events — an upgrade queued / cancelled / finished at a building. The
   *  subject is the RESEARCHING BUILDING: it is GetTriggerUnit and GetResearchingUnit, the
   *  unit a unit-scoped registration watches and what a registration's filter is asked
   *  about (there is no second unit, unlike a training's finish). GetResearched is the
   *  upgrade's rawcode — common.j declares both responses under these three events. */
  pumpResearchEvents(events: ReadonlyArray<ResearchEvent>): void {
    for (const e of events) {
      const b = this.rt.unitForSim(e.building);
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", b],
        ["ResearchingUnit", b],
        ["Researched", jInt(rawcodeToInt(e.techId))],
      ]);
      const playerEvt = e.phase === "start" ? EVENT_PLAYER_UNIT_RESEARCH_START : e.phase === "cancel" ? EVENT_PLAYER_UNIT_RESEARCH_CANCEL : EVENT_PLAYER_UNIT_RESEARCH_FINISH;
      const unitEvt = e.phase === "start" ? EVENT_UNIT_RESEARCH_START : e.phase === "cancel" ? EVENT_UNIT_RESEARCH_CANCEL : EVENT_UNIT_RESEARCH_FINISH;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.building.owner, b)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, b)));
    }
  }

  /** Pump hero events (7.17) — a hero gained a level (GetLevelingUnit) or learned a
   *  skill (GetLearningUnit/GetLearnedSkill/GetLearnedSkillLevel). */
  pumpHeroEvents(events: ReadonlyArray<HeroEvent>): void {
    for (const e of events) {
      const hero = this.rt.unitForSim(e.hero);
      const levelling = e.phase === "level";
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", hero],
        [levelling ? "LevelingUnit" : "LearningUnit", hero],
        ["LearnedSkill", jInt(e.abilityId ? rawcodeToInt(e.abilityId) : 0)],
        ["LearnedSkillLevel", jInt(e.level)],
      ]);
      const playerEvt = levelling ? EVENT_PLAYER_HERO_LEVEL : EVENT_PLAYER_HERO_SKILL;
      const unitEvt = levelling ? EVENT_UNIT_HERO_LEVEL : EVENT_UNIT_HERO_SKILL;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.hero.owner, hero)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, hero)));
    }
  }

  /** Pump item events (7.18) — a unit picked up / dropped / used / bought an item:
   *  EVENT_(PLAYER_)UNIT_PICKUP_ITEM (49/86), _DROP_ITEM (48/85), _USE_ITEM (50/87) and
   *  _SELL_ITEM (271/288), matched by the manipulating unit's owner (player events) or the
   *  unit itself (unit events). Responses: GetManipulatedItem (also GetSoldItem) +
   *  GetManipulatingUnit (also GetBuyingUnit, and GetTriggerUnit).
   *
   *  The item handle is minted from the event's SNAPSHOT, not from a live lookup: a tome
   *  is consumed the moment it's picked up and a potion's last charge destroys it, so by
   *  the time we drain the event the item may no longer exist — yet WC3 hands the trigger
   *  a usable item (GetItemTypeId(GetManipulatedItem()) is THE line every "what did they
   *  pick up?" trigger opens with). Same problem, same answer as GetDyingUnit's corpse. */
  pumpItemEvents(events: ReadonlyArray<ItemEvent>): void {
    for (const e of events) {
      const unit = this.rt.unitForSim(e.unit);
      const item = this.rt.itemForSim({ ...e.item, x: e.unit.x, y: e.unit.y });
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", unit],
        ["ManipulatingUnit", unit],
        ["ManipulatedItem", item],
      ]);
      // On a sale the SHOP answers GetSellingUnit — which is the only handle Blizzard.j's
      // RemovePurchasedItem has to take the sold item back off the shelf with.
      if (e.seller) responses.set("SellingUnit", this.rt.unitForSim(e.seller));
      const phase = ITEM_PHASES.indexOf(e.phase as (typeof ITEM_PHASES)[number]);
      const playerEvt = phase < 0 ? EVENT_PLAYER_UNIT_SELL_ITEM : EVENT_PLAYER_UNIT_DROP_ITEM + phase;
      const unitEvt = phase < 0 ? EVENT_UNIT_SELL_ITEM : EVENT_UNIT_DROP_ITEM + phase;
      // A SELL_ITEM event belongs to the SHOP, not to the buyer: Blizzard.j registers
      // RemovePurchasedItem on Player(PLAYER_NEUTRAL_PASSIVE) — the Marketplace's owner —
      // and a Human buying there is nobody's neutral-passive unit. Match on the seller.
      const owner = e.seller ? e.seller.owner : e.unit.owner;
      const subject = e.seller ? (responses.get("SellingUnit") as JassValue) : unit;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, owner, subject)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, subject)));
    }
  }

  /**
   * Pump unit SALES — a hero hired at a Tavern, an ogre at a Mercenary Camp, a zeppelin at a
   * Goblin Laboratory: EVENT_PLAYER_UNIT_SELL (269) / EVENT_UNIT_SELL (286).
   *
   * The event belongs to the SHOP, exactly as a sold ITEM's does: blizzard.j registers it on
   * `Player(PLAYER_NEUTRAL_PASSIVE)` — a Tavern's owner — and the human who just paid 425 gold
   * is nobody's neutral-passive unit. So the owner matched, the subject a unit-scoped
   * registration watches and GetTriggerUnit are all the shop; what the sale is ABOUT — the
   * unit that was bought, and what the registration's filter is asked about — is GetSoldUnit.
   *
   * This is the second half of MeleeGrantHeroItems: a melee player's first hero carries a
   * Scroll of Town Portal whether it was trained at an Altar or woken at a Tavern.
   */
  /**
   * Pump summon events — a unit SPAWNED a summoned unit.
   *
   * The SUMMONER is the subject, and the install says so in the event's own words: "When
   * responding to a 'Spawns A Summoned Unit' unit event" (`UI\TriggerStrings.txt`, the hints for
   * `GetSummonedUnit`/`GetSummoningUnit`) — the unit that spawns is the "A unit", which is the
   * triggering unit (hiveworkshop 264641). So `GetTriggerUnit` is the summoner, a unit-scoped
   * registration matches the summoner, and the player event is filed under the summoner's owner.
   */
  pumpSummonEvents(events: ReadonlyArray<SummonEvent>): void {
    for (const e of events) {
      const summoner = this.rt.unitForSim(e.summoner);
      const summoned = this.rt.unitForSim(e.summoned);
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", summoner],
        ["SummoningUnit", summoner],
        ["SummonedUnit", summoned],
      ]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_SUMMON, EVENT_PLAYER_UNIT_SUMMON), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_SUMMON, e.summoner.owner, summoner)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_SUMMON) && this.paramUnitIs(reg, summoner)));
    }
  }

  pumpSellUnitEvents(events: ReadonlyArray<SellUnitEvent>): void {
    for (const e of events) {
      const shop = this.rt.unitForSim(e.shop);
      const sold = this.rt.unitForSim(e.sold);
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", shop],
        ["SellingUnit", shop],
        ["SoldUnit", sold],
        // GetBuyingUnit — the buyer's unit standing in the shop's reach, which a shop with an
        // interact ability requires of a unit sale as of an item's (SimWorld.unitSalePatron).
        // Null for a shop that asks for nobody.
        ["BuyingUnit", e.buyer ? this.rt.unitForSim(e.buyer) : JNULL],
      ]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_SELL, EVENT_PLAYER_UNIT_SELL), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_SELL, e.shop.owner, shop, sold)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_SELL) && this.paramUnitIs(reg, shop)));
    }
  }

  /**
   * Pump cargo-load events — a unit that just climbed into a transport or a burrow.
   *
   * The SUBJECT is the PASSENGER, and the campaign is what settles that: Rise of the Naga
   * registers `EVENT_UNIT_LOADED` on Illidan, not on the ship he boards, and sails the ship
   * from that trigger. So a unit-scoped registration matches the loaded unit, and the player
   * event is filed under the loaded unit's owner. Responses: GetLoadedUnit (the passenger,
   * also GetTriggerUnit) and GetTransportUnit (the carrier).
   */
  pumpLoadEvents(events: ReadonlyArray<LoadEvent>): void {
    for (const e of events) {
      const passenger = this.rt.unitForSim(e.unit);
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", passenger],
        ["LoadedUnit", passenger],
        ["TransportUnit", this.rt.unitForSim(e.transport)],
      ]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_LOADED, EVENT_PLAYER_UNIT_LOADED), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_LOADED, e.unit.owner, passenger)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_LOADED) && this.paramUnitIs(reg, passenger)));
    }
  }

  /**
   * Pump DECAY events — `EVENT_PLAYER_UNIT_DECAY` (21) / `EVENT_UNIT_DECAY` (54): a dead unit's
   * death clip has played out and its body has begun to rot (SimWorld.tickCorpses says when).
   * The unit is gone from the world by then, so its handle is the one its death left behind;
   * `GetDecayingUnit` and `GetTriggerUnit` both answer it.
   */
  pumpDecayEvents(events: ReadonlyArray<SimUnitRef>): void {
    for (const e of events) {
      const unit = this.rt.unitForSim(e);
      const responses = new Map<string, JassValue>([["TriggerUnit", unit], ["DecayingUnit", unit]]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_DECAY, EVENT_PLAYER_UNIT_DECAY), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_DECAY, e.owner, unit)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_DECAY) && this.paramUnitIs(reg, unit)));
    }
  }

  /**
   * Pump RESCUE events — `EVENT_PLAYER_UNIT_RESCUED` (19) / `EVENT_UNIT_RESCUED` (63).
   *
   * Filed under the RESCUED unit's owner, and Blizzard.j is what settles that:
   * `TryInitRescuableTriggersBJ` registers the event for every player and its action hands
   * `GetTriggerUnit()` to `GetOwningPlayer(GetRescuer())` — so the triggering unit is the one
   * being rescued, still its old owner's at that moment, and `GetRescuer` is the unit that
   * walked up to it (Blizzard.j 6735–6761).
   */
  pumpRescueEvents(events: ReadonlyArray<{ unit: SimUnitRef; rescuer: SimUnitRef }>): void {
    for (const e of events) {
      const unit = this.rt.unitForSim(e.unit);
      const responses = new Map<string, JassValue>([["TriggerUnit", unit], ["Rescuer", this.rt.unitForSim(e.rescuer)]]);
      this.dispatchToRegs(responses, this.unitEventRegs(EVENT_UNIT_RESCUED, EVENT_PLAYER_UNIT_RESCUED), (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_RESCUED, e.unit.owner, unit)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_RESCUED) && this.paramUnitIs(reg, unit)));
    }
  }

  /**
   * Pump SELECTION events — `EVENT_PLAYER_UNIT_SELECTED` / `_DESELECTED` (24/25), and their
   * unit-scoped twins (57/58).
   *
   * These are the one event family matched by a player who is NOT the subject's owner.
   * `TriggerRegisterPlayerSelectionEventBJ(t, Player(0), true)` asks "when player 0 selects
   * ANY unit", and the unit is routinely somebody else's — Extreme Candy War's hero costumes
   * stand on slots 5 and 11, which nobody plays, and the trigger reads
   * `GetOwningPlayer(GetTriggerUnit())` itself to check that's where the click landed. So the
   * registration's player is compared against the SELECTOR (`GetTriggerPlayer`) here, not
   * against the owner the way every other player-unit event does.
   */
  pumpSelectionEvents(events: ReadonlyArray<SelectionEvent>): void {
    for (const e of events) {
      const unit = this.rt.unitForSim(e.unit);
      const responses = new Map<string, JassValue>([
        ["TriggerUnit", unit],
        ["TriggerPlayer", this.rt.playerHandle(e.player)],
      ]);
      const playerEvt = e.selected ? EVENT_PLAYER_UNIT_SELECTED : EVENT_PLAYER_UNIT_DESELECTED;
      const unitEvt = e.selected ? EVENT_UNIT_SELECTED : EVENT_UNIT_DESELECTED;
      this.dispatchToRegs(responses, this.unitEventRegs(unitEvt, playerEvt), (reg) =>
        (reg.kind === "playerUnitEvent"
          && this.rt.enumIndex(reg.params[1] ?? JNULL) === playerEvt
          && this.rt.data<JassPlayer>(reg.params[0])?.index === e.player
          && this.eventFilterPasses(reg.params[2], unit))
        || (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, unit)));
    }
  }

  /** Pump unit-state threshold events (7.17) — `TriggerRegisterUnitStateEvent(trig, u,
   *  UNIT_STATE_LIFE, LESS_THAN, 100)`, i.e. EVENT_UNIT_STATE_LIMIT. Unlike the other
   *  events this one isn't raised by the sim: it's a POLL of the watched unit's state each
   *  tick (nothing in the sim announces "life changed"), fired on the rising edge — so
   *  "life drops below 100" fires once per crossing, not every tick it sits below. The
   *  edge is seeded at REGISTRATION (unitStateNow in natives/events.ts), so a unit already
   *  under the limit when the trigger is created doesn't fire, but one damaged a moment
   *  later — even in that same tick — does. */
  pumpUnitStates(): void {
    for (const reg of this.rt.regsFor("unitState")) {
      if (reg.kind !== "unitState") continue;
      const now = unitStateHolds(this.rt, reg);
      const was = reg.edge ?? now;
      reg.edge = now;
      if (!now || was) continue; // not a fresh crossing
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      const u = this.rt.data<JassUnit>(reg.params[0] ?? JNULL);
      if (!trig || !u) continue;
      const handle = jHandle(u.handleId, "unit");
      // GetEventUnitState — the state the registration watches (its 2nd argument).
      this.fireTrigger(trig, this.withTrigger(new Map([["TriggerUnit", handle], ["EventUnitState", reg.params[1] ?? JNULL]]), trig, reg));
    }
  }

  /** Pump player-state threshold events — `TriggerRegisterPlayerStateEvent(trig, p,
   *  PLAYER_STATE_RESOURCE_FOOD_USED, EQUAL, 0)`, i.e. EVENT_PLAYER_STATE_LIMIT. The
   *  player-scoped twin of `pumpUnitStates` in every respect: polled per tick because nothing
   *  in the sim announces "this player's food changed", fired on the RISING EDGE so it fires
   *  once per crossing, and seeded at registration so a comparison that already holds when the
   *  trigger is created is not news.
   *
   *  The edge is what makes it usable as a wave clock. Azure Tower Defense hangs its whole
   *  round loop on "Player(10)'s food used == 0" — every creep dead — and that is true for the
   *  entire gap between waves too, so a level-triggered version would re-run the round trigger
   *  every tick of the countdown it just started. (The map guards that case itself with a
   *  `udg_Spawner` flag, which is the tell that Blizzard's own designers expected an edge.) */
  pumpPlayerStates(): void {
    for (const reg of this.rt.regsFor("playerState")) {
      if (reg.kind !== "playerState") continue;
      const now = playerStateHolds(this.rt, reg);
      const was = reg.edge ?? now;
      reg.edge = now;
      if (!now || was) continue; // not a fresh crossing
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      const p = this.rt.data<JassPlayer>(reg.params[0] ?? JNULL);
      if (!trig || !p) continue;
      // GetEventPlayerState — the state the registration watches (its 2nd argument).
      this.fireTrigger(trig, this.withTrigger(new Map([["TriggerPlayer", this.rt.playerHandle(p.index)], ["EventPlayerState", reg.params[1] ?? JNULL]]), trig, reg));
    }
  }

  /** Pump GAME-state threshold events — `TriggerRegisterGameStateEvent(trig,
   *  GAME_STATE_TIME_OF_DAY, EQUAL, 6.00)`, i.e. EVENT_GAME_STATE_LIMIT ("Game - The in-game
   *  time of day becomes Equal to 6.00"). A scenario keys its day on it: a hero picker gives a hero
   *  for anyone still undecided at dawn, and turns a Werewolf-ring wearer at 18:00. Polled, as
   *  the unit and player thresholds are; `clock` is the time of day now and at the previous
   *  pump.
   *
   *  The clock is CONTINUOUS, so "equal" is a crossing: the comparison holds the moment the
   *  clock passes the value — between the two readings, midnight wrap included — and never
   *  while it merely sits near it. The other comparisons fire on their rising edge, like
   *  the other thresholds. A clock the script SET (a jump of more than an hour, either way)
   *  crosses nothing on its way: only landing exactly on the value counts — and only ARRIVING
   *  there. A clock the script stopped (`SuspendTimeOfDay`) exactly on the value has not
   *  crossed it again on every pump; read that way, `SetTimeOfDay(18)` + a suspended clock
   *  howled Blizzard.j's own dusk wolf (InitDNCSounds) sixty times a second.
   *
   *  Only GAME_STATE_TIME_OF_DAY is a clock. The two other game states common.j declares
   *  (`GAME_STATE_DIVINE_INTERVENTION`, `GAME_STATE_DISCONNECTED`) are integer states this
   *  pump does not read, and a registration on one is not compared against the hour. */
  pumpGameStates(prev: number, now: number): void {
    const forward = now >= prev ? now - prev : now + 24 - prev;
    const ticked = forward > 0 && forward < 1;
    const crossed = (limit: number): boolean => {
      if (now === limit) return prev !== limit;
      if (!ticked) return false;
      return now >= prev ? prev < limit && limit <= now : limit > prev || limit <= now;
    };
    for (const reg of this.rt.regsFor("gameStateEvent")) {
      if (reg.kind !== "gameStateEvent") continue;
      if (this.rt.enumIndex(reg.params[0] ?? JNULL) !== GAME_STATE_TIME_OF_DAY) continue;
      const op = this.rt.enumIndex(reg.params[1] ?? JNULL);
      const limit = asNum(reg.params[2] ?? JNULL);
      let fire: boolean;
      if (op === 2) fire = crossed(limit); // EQUAL
      else {
        const holds = compareLimit(op, now, limit);
        const was = reg.edge ?? holds;
        reg.edge = holds;
        fire = holds && !was;
      }
      if (!fire) continue;
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      // GetEventGameState — the state the registration watches (its 1st argument).
      if (trig) this.fireTrigger(trig, this.withTrigger(new Map([["EventGameState", reg.params[0] ?? JNULL]]), trig, reg));
    }
  }

  /** The player clicked a dialog button (7.19). Fires the triggers the script registered
   *  on that button (TriggerRegisterDialogButtonEvent) and on its dialog
   *  (TriggerRegisterDialogEvent), with GetClickedButton / GetClickedDialog / GetTriggerPlayer
   *  in scope. Raised by the UI, which owns the click — and which also closes the dialog and,
   *  for a quit button, ends the game, because in WC3 those two are the ENGINE's doing, not
   *  the script's: MeleeVictoryDialogBJ registers a trigger on its quit button and never adds
   *  an action to it. */
  fireDialogClick(buttonHandleId: number, dialogHandleId: number, player: number): void {
    this.inputTap?.({ k: "dlg", p: player, button: buttonHandleId, dialog: dialogHandleId });
    const responses = new Map<string, JassValue>([
      ["ClickedButton", jHandle(buttonHandleId, "button")],
      ["ClickedDialog", jHandle(dialogHandleId, "dialog")],
      ["TriggerPlayer", this.rt.playerHandle(player)],
    ]);
    this.dispatchToRegs(responses, this.rt.regsFor("dialogButton", "dialogEvent"), (reg) =>
      (reg.kind === "dialogButton" && reg.params[0]?.k === "handle" && reg.params[0].h === buttonHandleId) ||
      (reg.kind === "dialogEvent" && reg.params[0]?.k === "handle" && reg.params[0].h === dialogHandleId));
  }

  /** The player did something to one of the map's own FRAMES (compat/frames.ts) — clicked a
   *  button, moved the mouse onto one. Fires every `BlzTriggerRegisterFrameEvent` that named
   *  that frame and that event, with `BlzGetTriggerFrame` / `BlzGetTriggerFrameEvent` /
   *  `GetTriggerPlayer` in scope. Raised by the drawing, which owns the mouse — as a dialog
   *  button's click is (`fireDialogClick`). */
  fireFrameEvent(frameHandleId: number, eventIndex: number, player: number): void {
    this.inputTap?.({ k: "frame", p: player, frame: frameHandleId, ev: eventIndex });
    const responses = new Map<string, JassValue>([
      ["TriggerFrame", jHandle(frameHandleId, "framehandle")],
      ["TriggerFrameEvent", this.rt.enumHandle("FrameEventType", eventIndex)],
      ["TriggerPlayer", this.rt.playerHandle(player)],
    ]);
    this.dispatchToRegs(responses, this.rt.regsFor("frameEvent"), (reg) =>
      reg.kind === "frameEvent" && reg.params[0]?.k === "handle" && reg.params[0].h === frameHandleId &&
      this.rt.enumIndex(reg.params[1] ?? JNULL) === eventIndex);
  }

  /**
   * A `playerevent` happened to `player` — fire every `TriggerRegisterPlayerEvent` that named
   * both that player and that event.
   *
   * The one this exists for is **EVENT_PLAYER_END_CINEMATIC**, i.e. ESC pressed during a
   * cinematic. The engine's whole job there is to raise the event; what "skip" MEANS is the
   * map's, and every campaign chapter writes it out longhand. NightElfX01 (Rise of the Naga):
   *
   *     call DisableTrigger( gg_trg_Intro_Skipped )
   *     call TriggerRegisterPlayerEventEndCinematic( gg_trg_Intro_Skipped, Player(0) )
   *
   * — created DISABLED, enabled by the intro trigger and disabled again by its cleanup, so the
   * map itself decides when a cinematic is skippable. Its action then fades out, runs the
   * cleanup trigger, leaves cinematic mode and starts the gameplay trigger. So a registration
   * that is off must not fire, which `fireTrigger` already honours (`trig.enabled`).
   *
   * `TriggerRegisterPlayerEventEndCinematic` is blizzard.j's one-liner over
   * `TriggerRegisterPlayerEvent(trig, whichPlayer, EVENT_PLAYER_END_CINEMATIC)`, so nothing
   * has to know about the BJ — matching the registration's player and event enum is enough.
   */
  firePlayerEvent(player: number, eventIndex: number): void {
    this.inputTap?.({ k: "pev", p: player, ev: eventIndex });
    const responses = new Map<string, JassValue>([["TriggerPlayer", this.rt.playerHandle(player)]]);
    this.dispatchToRegs(responses, this.rt.regsFor("playerEvent"), (reg) => this.matchesPlayerEvent(reg, player, eventIndex));
  }

  /**
   * A key went down or came up — `BlzTriggerRegisterPlayerKeyEvent(trigger, player, key, metaKey,
   * keyDown)` (1.31). `key` is the virtual-key code an `oskeytype` wraps, `meta` the modifier
   * bits held (METAKEY_SHIFT 1, CTRL 2, ALT 4, META 8). A registration matches its player, its
   * key, its direction and its meta set EXACTLY: "metaKey … the key combination must match
   * exactly" (jassdoc) — a trigger on plain A does not fire for Shift+A.
   *
   * A script INPUT, tapped like the rest (game/replay.ts): what the map hears from a player.
   */
  firePlayerKey(player: number, key: number, meta: number, down: boolean): void {
    this.inputTap?.({ k: "key", p: player, key, meta, down });
    const responses = new Map<string, JassValue>([
      ["TriggerPlayer", this.rt.playerHandle(player)],
      ["TriggerPlayerKey", this.rt.enumHandle("OsKeyType", key)],
      ["TriggerPlayerMetaKey", jInt(meta)],
      ["TriggerPlayerIsKeyDown", jBool(down)],
    ]);
    this.dispatchToRegs(responses, this.rt.regsFor("playerKey"), (reg) => reg.kind === "playerKey"
      && this.rt.data<JassPlayer>(reg.params[0])?.index === player
      && this.rt.enumIndex(reg.params[1] ?? JNULL) === key
      && asInt(reg.params[2] ?? JNULL) === meta
      && truthy(reg.params[3] ?? JNULL) === down);
  }
  /** Is any key event registered at all? The host only listens to the keyboard when one is. */
  watchesKeys(): boolean {
    return this.rt.regsFor("playerKey").length > 0;
  }

  /**
   * Will `firePlayerEvent` reach anything — is there a registration for this player and this
   * event on a trigger that is switched ON?
   *
   * Asked BEFORE the event, for the one case where the engine has to do something of its own
   * around it: ESC during a cinematic fades the screen out before the skip lands
   * (`MapViewerScene.beginCinematicSkip`), and a fade for a press that the map is going to
   * ignore would be a black screen for nothing. It is the same predicate the dispatch uses,
   * plus the `enabled` test `fireTrigger` applies — which is exactly the switch a chapter
   * uses to say when its cinematic is skippable (see `firePlayerEvent`).
   */
  playerEventAnswered(player: number, eventIndex: number): boolean {
    return this.rt.regsFor("playerEvent").some((reg) => {
      if (!this.matchesPlayerEvent(reg, player, eventIndex)) return false;
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      return !!trig?.enabled;
    });
  }

  private matchesPlayerEvent(reg: TriggerReg, player: number, eventIndex: number): boolean {
    return reg.kind === "playerEvent"
      && this.rt.data<JassPlayer>(reg.params[0])?.index === player
      && this.rt.enumIndex(reg.params[1] ?? JNULL) === eventIndex;
  }

  /**
   * A player said something — fire every `TriggerRegisterPlayerChatEvent` that wanted it.
   *
   * This is how a custom map takes typed commands, and the match rule is the whole of it.
   * `TriggerRegisterPlayerChatEvent(t, p, chatString, exactMatchOnly)`:
   *
   *   • `exactMatchOnly` true  → the message must EQUAL `chatString`. "-ap" and nothing else.
   *   • `exactMatchOnly` false → `chatString` may stand ANYWHERE in the message — the GUI
   *     words this choice "as A Substring" (`UI\TriggerData.txt` ChatMatchTypeSubstring), and
   *     a map's command can carry its argument on either side: "-kick 3" works as before,
   *     and a map's cheats may be typed number first ("5000gold", "10level" against "gold",
   *     "level"). `GetEventPlayerChatStringMatched` hands back the registered string so the
   *     action can cut it out and keep the parameter.
   *
   * An EMPTY `chatString` with exactMatchOnly false is in every message, so it catches
   * everything the player says — the documented idiom for "give me all of this player's chat".
   *
   * The comparison is case-SENSITIVE, as WC3's is: a map registering "-ap" is not answered by
   * "-AP", and maps that want both register both.
   */
  firePlayerChat(player: number, message: string): void {
    const responses = new Map<string, JassValue>([
      ["TriggerPlayer", this.rt.playerHandle(player)],
      ["EventPlayerChatString", { k: "string", s: message }],
    ]);
    for (const reg of this.rt.regsFor("playerChat")) {
      if (reg.kind !== "playerChat") continue;
      // params: [player, chatString, exactMatchOnly] — everything after the trigger itself.
      // A registration names WHICH player it listens to. A map that wants everybody's chat
      // registers one trigger per player (blizzard.j's own ForForce loop does exactly that).
      const who = reg.params[0];
      if (who?.k === "handle" && (this.rt.data<JassPlayer>(who)?.index ?? -1) !== player) continue;
      const pattern = reg.params[1]?.k === "string" ? reg.params[1].s : "";
      const exact = reg.params[2]?.k === "bool" && reg.params[2].b;
      if (exact ? message !== pattern : !message.includes(pattern)) continue;
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (!trig) continue;
      // The MATCHED string is per-registration, so it is added here rather than above.
      const own = new Map(responses);
      own.set("EventPlayerChatStringMatched", { k: "string", s: pattern });
      this.fireTrigger(trig, this.withTrigger(own, trig, reg));
    }
  }

  /** The registrations a UNIT event can reach: `TriggerRegisterUnitEvent` of that unit event,
   *  `TriggerRegisterPlayerUnitEvent` of its player twin (a negative index names neither). */
  private unitEventRegs(unitEvt: number, playerEvt: number): readonly TriggerReg[] {
    return this.rt.regsFor(`unitEvent#${unitEvt}`, `playerUnitEvent#${playerEvt}`);
  }

  /** Fire every registration in `regs` matching `pred` with the given responses. `regs` is the
   *  event's own bucket(s) out of `Runtime.regsFor` — a pre-filter, with `pred` still the test —
   *  and a bucket is a snapshot: an action may register/destroy triggers mid-dispatch. */
  private dispatchToRegs(responses: Map<string, JassValue>, regs: readonly TriggerReg[], pred: (reg: TriggerReg) => boolean): void {
    for (const reg of regs) {
      if (!pred(reg)) continue;
      // `TriggerRegisterFilterUnitEvent` is a unit event with a boolexpr on the end (params[2]);
      // the plain `TriggerRegisterUnitEvent` has none, so this asks nothing of it.
      if (reg.kind === "unitEvent" && reg.params[2] && !this.eventFilterPasses(reg.params[2], responses.get("TriggerUnit") ?? JNULL)) continue;
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (trig) this.fireTrigger(trig, this.withTrigger(responses, trig, reg));
    }
  }

  /** A registration's subject unit (params[0]) is the given handle. */
  private paramUnitIs(reg: TriggerReg, unit: JassValue): boolean {
    return reg.params[0]?.k === "handle" && unit.k === "handle" && reg.params[0].h === unit.h;
  }
  /** A registration's event enum (params[1]) has the given ConvertUnitEvent index. */
  private unitEventIs(reg: TriggerReg, index: number): boolean {
    return this.rt.enumIndex(reg.params[1] ?? JNULL) === index;
  }
  /** A player-unit-event registration matches: right event index, the subject's owner,
   *  and its optional boolexpr filter (params[2]) passes.
   *
   *  `filterUnit` is what GetFilterUnit answers inside that boolexpr, and it is NOT always
   *  `unit`: an event filed under a building's owner can still be ABOUT the unit that left it
   *  (a trained hero, a hired mercenary). Defaults to the subject, which is right everywhere
   *  the two are the same thing. */
  private playerUnitEventMatches(reg: TriggerReg, eventIndex: number, owner: number, unit: JassValue, filterUnit: JassValue = unit): boolean {
    return this.rt.enumIndex(reg.params[1] ?? JNULL) === eventIndex
      && this.rt.data<JassPlayer>(reg.params[0])?.index === owner
      && this.eventFilterPasses(reg.params[2], filterUnit);
  }
}
