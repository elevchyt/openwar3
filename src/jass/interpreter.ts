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

import type { Expr, FunctionDecl, JassProgram, Stmt, VarDecl } from "./ast";
import { Runtime, JassArray, ThreadAbort, type BoolExpr, type JassPlayer, type NativeCtx, type RectObj, type RegionObj, type TimerObj, type TriggerObj, type TriggerReg } from "./runtime";
import {
  asInt, asNum, asStr, defaultForType, jassEquals, jBool, jHandle, jInt, jReal, jStr, JNULL, truthy, type JassValue,
} from "./values";

/** A minimal live view of a sim unit the engine feeds the region pump each tick. */
export interface UnitSnapshot {
  id: number;
  typeId: string;
  owner: number;
  x: number;
  y: number;
  facing: number;
}

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
}

// common.j event enum indices (ConvertUnitEvent/ConvertPlayerUnitEvent values).
const EVENT_UNIT_DEATH = 53;
const EVENT_PLAYER_UNIT_DEATH = 20;
const EVENT_UNIT_DAMAGED = 52;
const EVENT_PLAYER_UNIT_ATTACKED = 18;
const EVENT_UNIT_ATTACKED = 62;
// Issued-order events: no-target (38/75), point-target (39/76), unit-target (40/77).
const EVENT_PLAYER_UNIT_ISSUED_ORDER = 38;
const EVENT_PLAYER_UNIT_ISSUED_POINT_ORDER = 39;
const EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER = 40;
const EVENT_UNIT_ISSUED_ORDER = 75;
const EVENT_UNIT_ISSUED_POINT_ORDER = 76;
const EVENT_UNIT_ISSUED_TARGET_ORDER = 77;

const isRect = (o: unknown): o is RectObj =>
  !!o && typeof (o as RectObj).minx === "number" && typeof (o as RectObj).maxx === "number";
const isRegion = (o: unknown): o is RegionObj => !!o && Array.isArray((o as RegionObj).rects);

class ReturnSignal {
  constructor(readonly value: JassValue) {}
}

/** A function call frame: local variables + local arrays. Parameters live in the
 *  same var map (JASS has no separate parameter scope). */
class Frame {
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
const THREAD_NATIVES = new Set(["TriggerSleepAction", "TriggerExecute", "ConditionalTriggerExecute", "ExecuteFunc"]);

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
interface JassThread {
  id: number;
  label: string; // for warnings, e.g. "trigger#12"
  gen: ThreadGen;
  stack: Array<Map<string, JassValue>>; // its event-response frames (thread-local in WC3)
  depth: number; // its call depth, saved across the suspension
  wakeAt: number; // rt.gameTime at which it may resume
  lastTick: number; // the pump it last ran on (one resume per thread per tick)
  done: boolean;
  result: JassValue; // its return value, if it ran to completion
}

export class Interpreter {
  private depth = 0;
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
    };
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
        this.rt.globalArrays.set(g.name, new JassArray(g.type, () => defaultForType(g.type)));
      } else {
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
  callFunction(name: string, args: JassValue[]): JassValue {
    const nat = this.rt.natives.get(name);
    if (nat) return this.callNative(name, nat, args); // natives are synchronous — no generator needed
    const fn = this.rt.functions.get(name);
    if (fn) return this.runSync(this.callUserG(fn, args), name);
    return this.missing(name);
  }

  /** The same resolution, as a generator — used from a thread, where a user function
   *  (a trigger action, `PolledWait`, …) may suspend on a wait. */
  private *callFunctionG(name: string, args: JassValue[]): ThreadGen {
    const nat = this.rt.natives.get(name);
    if (nat) return this.callNative(name, nat, args);
    const fn = this.rt.functions.get(name);
    if (fn) return yield* this.callUserG(fn, args);
    return this.missing(name);
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

  /** Drive a generator to completion on the caller's stack (no suspension possible).
   *  A wait inside throws ThreadAbort, which we catch here: that callback is abandoned
   *  (logged once) rather than left to spin — blizzard.j's `PolledWait` loops until its
   *  timer drains, so a no-op wait would busy-loop to the iteration cap. */
  private runSync(gen: ThreadGen, label: string): JassValue {
    this.syncDepth++;
    try {
      const r = gen.next();
      if (r.done) return r.value;
      this.rt.warnOnce(label, "wait outside a trigger thread — ignored");
      return JNULL;
    } catch (err) {
      if (err instanceof ThreadAbort) {
        this.rt.warnOnce(label, "TriggerSleepAction outside a trigger thread — callback abandoned");
        return JNULL;
      }
      throw err;
    } finally {
      this.syncDepth--;
    }
  }

  private *callUserG(fn: FunctionDecl, args: JassValue[]): ThreadGen {
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      this.rt.warnOnce(fn.name, "call depth exceeded");
      return defaultForType(fn.returns);
    }
    const frame = new Frame();
    for (let i = 0; i < fn.params.length; i++) {
      frame.vars.set(fn.params[i].name, args[i] ?? defaultForType(fn.params[i].type));
    }
    for (const loc of fn.locals) {
      if (loc.isArray) frame.arrays.set(loc.name, new JassArray(loc.type, () => defaultForType(loc.type)));
      else frame.vars.set(loc.name, loc.init ? this.eval(loc.init, frame) : defaultForType(loc.type));
    }
    try {
      yield* this.execBlockG(fn.body, frame);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.depth--;
        return e.value;
      }
      this.depth--;
      throw e;
    }
    this.depth--;
    return defaultForType(fn.returns);
  }

  private *execBlockG(stmts: Stmt[], frame: Frame): ThreadGen {
    for (const s of stmts) yield* this.exec(s, frame);
    return JNULL;
  }

  private *exec(s: Stmt, frame: Frame): ThreadGen {
    switch (s.kind) {
      case "call": {
        // The thread-aware natives, intercepted here so a wait inside them can suspend
        // the *calling* thread (a native impl is a plain JS function — it cannot yield).
        // Same precedence as callFunction: the engine's meaning wins over a same-named
        // script function. Everything else can't suspend, so it goes through the sync path.
        const args = s.args.map((a) => this.eval(a, frame));
        if (THREAD_NATIVES.has(s.name)) {
          yield* this.execThreadNative(s.name, args);
          return JNULL;
        }
        const nat = this.rt.natives.get(s.name);
        if (nat) {
          this.callNative(s.name, nat, args);
          return JNULL;
        }
        const fn = this.rt.functions.get(s.name);
        if (fn) {
          yield* this.callUserG(fn, args); // a user function may wait (PolledWait, a spawn loop, …)
          return JNULL;
        }
        this.missing(s.name);
        return JNULL;
      }
      case "set": {
        const value = this.eval(s.value, frame);
        if (s.index !== undefined) {
          const idx = asInt(this.eval(s.index, frame));
          this.arrayFor(s.name, frame).set(idx, value);
        } else if (frame.vars.has(s.name)) {
          frame.vars.set(s.name, value);
        } else {
          this.rt.globals.set(s.name, value);
        }
        return JNULL;
      }
      case "return":
        throw new ReturnSignal(s.value ? this.eval(s.value, frame) : JNULL);
      case "if": {
        for (const b of s.branches) {
          if (truthy(this.eval(b.cond, frame))) {
            yield* this.execBlockG(b.body, frame);
            return JNULL;
          }
        }
        if (s.elseBody) yield* this.execBlockG(s.elseBody, frame);
        return JNULL;
      }
      case "loop": {
        let iters = 0;
        while (true) {
          if (++iters > MAX_LOOP_ITERS) {
            this.rt.warnOnce("<loop>", "iteration cap hit");
            return JNULL;
          }
          try {
            for (const st of s.body) yield* this.exec(st, frame);
          } catch (e) {
            if (e instanceof ExitLoop) return JNULL;
            throw e;
          }
        }
      }
      case "exitwhen":
        if (truthy(this.eval(s.cond, frame))) throw EXIT_LOOP;
        return JNULL;
    }
  }

  /** The four natives the thread layer owns (intercepted in `exec`): each either
   *  suspends the calling thread or runs more JASS *on* it, which a plain native — a
   *  synchronous JS function — cannot do. All four return `nothing`, so they can only
   *  ever appear as a statement, which is why intercepting statement calls is enough.
   *
   *  They still have ordinary native impls in natives/events.ts for the synchronous
   *  path (a `ForGroup` callback that calls `TriggerExecute`, say). */
  private *execThreadNative(name: string, args: JassValue[]): ThreadGen {
    if (name === "TriggerSleepAction") {
      // THE suspension point. `TriggerSleepAction(n)` parks this thread for n seconds of
      // GAME time (blizzard.j's PolledWait loops on it, so "Wait" in the GUI lands here).
      const secs = Math.max(0, asNum(args[0] ?? jReal(0)));
      if (this.currentThread && this.syncDepth === 0) {
        yield secs;
        return JNULL;
      }
      throw new ThreadAbort(); // no thread to park (a condition/filter/enum callback)
    }
    // ExecuteFunc takes a function NAME, not a trigger — run it on this thread.
    if (name === "ExecuteFunc") return args[0]?.k === "string" ? yield* this.callFunctionG(args[0].s, []) : JNULL;

    // TriggerExecute runs the trigger's actions on the CALLING thread (so a wait inside
    // blocks the caller — this is how a map-init trigger's Wait delays the init after it);
    // ConditionalTriggerExecute gates that on the trigger's conditions first.
    const t = this.rt.data<TriggerObj>(args[0] ?? JNULL);
    if (!t) return JNULL;
    if (name === "ConditionalTriggerExecute" && !(t.enabled && this.conditionsPass(t))) return JNULL;
    yield* this.runActionsG(t);
    return JNULL;
  }

  /** Run a trigger's action functions in order, on the current thread. One throwing
   *  action is logged and skipped — the rest still run (one bad trigger ≠ dead map). */
  private *runActionsG(trig: TriggerObj): ThreadGen {
    for (const fn of trig.actions) {
      try {
        yield* this.callFunctionG(fn, []);
      } catch (err) {
        if (err instanceof ThreadAbort) throw err;
        if (!(err instanceof ReturnSignal)) this.rt.warnOnce(fn, `trigger action threw: ${(err as Error).message}`);
      }
    }
    return JNULL;
  }

  /** Evaluate a trigger's conditions (synchronously — WC3 can't wait in a condition). */
  private conditionsPass(trig: TriggerObj): boolean {
    return trig.conditions.every((fn) => truthy(this.callFunction(fn, [])));
  }

  private arrayFor(name: string, frame: Frame | null): JassArray {
    const local = frame?.arrays.get(name);
    if (local) return local;
    let g = this.rt.globalArrays.get(name);
    if (!g) {
      g = new JassArray("integer", () => jInt(0)); // tolerate an undeclared array target
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
        if (frame?.vars.has(e.name)) return frame.vars.get(e.name)!;
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
        return this.callFunction(e.name, e.args.map((a) => this.eval(a, frame)));
      case "unary":
        return this.evalUnary(e.op, this.eval(e.expr, frame));
      case "binary":
        return this.evalBinary(e, frame);
    }
  }

  private evalUnary(op: "-" | "not" | "+", v: JassValue): JassValue {
    if (op === "not") return jBool(!truthy(v));
    if (op === "+") return v;
    return v.k === "real" ? jReal(-v.n) : jInt(-asInt(v)); // negate, preserving kind
  }

  private evalBinary(e: Extract<Expr, { kind: "binary" }>, frame: Frame | null): JassValue {
    // and/or: JASS evaluates BOTH sides (no short-circuit) — do the same.
    if (e.op === "and") return jBool(truthy(this.eval(e.left, frame)) && truthy(this.eval(e.right, frame)));
    if (e.op === "or") return jBool(truthy(this.eval(e.left, frame)) || truthy(this.eval(e.right, frame)));

    const l = this.eval(e.left, frame);
    const r = this.eval(e.right, frame);
    switch (e.op) {
      case "==":
        return jBool(jassEquals(l, r));
      case "!=":
        return jBool(!jassEquals(l, r));
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
        return this.arith(l, r, (a, b) => a + b);
      case "-":
        return this.arith(l, r, (a, b) => a - b);
      case "*":
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
    return this.startThread(fnName, this.callFunctionG(fnName, args)).result;
  }

  // --- trigger threads (milestone 7.15) -------------------------------------

  /** Start a thread and run it **immediately**, up to its first wait (WC3 runs trigger
   *  actions the moment the event fires — the wait is what defers the rest). It only
   *  joins the scheduler if it actually suspended. */
  private startThread(label: string, gen: ThreadGen, responses?: Map<string, JassValue>): JassThread {
    const t: JassThread = {
      id: this.nextThreadId++,
      label,
      gen,
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
      if (!(err instanceof ReturnSignal) && !(err instanceof ThreadAbort)) {
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
    if (pass) this.startThread(`trigger#${trig.handleId}`, this.runActionsG(trig), responses);
  }

  /** Dispatch a sim-raised event to every trigger registered for `kind` whose
   *  registration `params` match (the caller supplies both the event responses and
   *  the matcher). Used by the bridge to raise unit-death / enter-region / … from
   *  the sim tick. Registrations are indexed by kind in runtime.triggerRegs. */
  fireEvent(kind: string, responses: Map<string, JassValue>, matches?: (params: JassValue[]) => boolean): void {
    // Snapshot: an action may add/remove registrations mid-dispatch.
    const regs = this.rt.triggerRegs.filter((r) => r.kind === kind && (!matches || matches(r.params)));
    for (const reg of regs) {
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (trig) this.fireTrigger(trig, this.withTrigger(responses, trig));
    }
  }

  /** Advance game time by `dt` seconds (pumped from the sim tick): expire timers, then
   *  resume any trigger thread whose `TriggerSleepAction` has run out (7.15). An expired
   *  timer runs its TimerStart handler code and fires any trigger registered on it
   *  (TriggerRegisterTimerExpireEvent); periodic timers re-arm. The inner guard
   *  stops a zero/negative-timeout periodic timer from looping forever in one tick. */
  advanceTime(dt: number): void {
    this.rt.gameTime += dt;
    for (const t of this.rt.timers) {
      if (!t.running) continue;
      t.remaining -= dt;
      t.elapsedTotal += dt;
      let guard = 0;
      while (t.running && t.remaining <= 0 && guard++ < 10000) {
        this.expireTimer(t);
        if (t.periodic && t.timeout > 0) t.remaining += t.timeout;
        else {
          t.running = false;
          break;
        }
      }
    }
    this.pumpThreads(); // waits come due AFTER the clock moved (so a 0s wait costs one tick)
  }

  private expireTimer(t: TimerObj): void {
    const responses = new Map<string, JassValue>([["ExpiredTimer", jHandle(t.handleId, "timer")]]);
    // A timer handler runs on its own thread — WC3 lets one TriggerSleepAction (and the
    // periodic re-arm keeps ticking while it sleeps).
    if (t.handlerFn) this.startThread(`timer#${t.handleId}`, this.callFunctionG(t.handlerFn, []), responses);
    for (const reg of this.rt.triggerRegs) {
      if (reg.kind !== "timerExpire") continue;
      if (reg.params[0]?.k === "handle" && reg.params[0].h === t.handleId) {
        const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
        if (trig) this.fireTrigger(trig, responses);
      }
    }
  }

  /** Add the standard GetTriggeringTrigger response for the trigger being fired. */
  private withTrigger(responses: Map<string, JassValue>, trig: TriggerObj): Map<string, JassValue> {
    const m = new Map(responses);
    m.set("TriggeringTrigger", jHandle(trig.handleId, "trigger"));
    return m;
  }

  // --- live enter/leave-region pump (milestone 7.4b) -------------------------

  /** Which sim units were inside each enter/leave registration's rect(s) last pump.
   *  Keyed by the registration object (stable across ticks) so a crossing is a
   *  set-difference, not a re-scan. */
  private readonly regionMembers = new Map<TriggerReg, Set<number>>();

  /** Pump enter/leave-region events from the sim tick: for every enter/leave
   *  registration, diff the set of units currently inside its rect(s) against last
   *  tick and fire the trigger on each crossing (GetTriggerUnit + GetEnteringUnit /
   *  GetLeavingUnit set to the crossing unit). Units already inside when a trigger
   *  is registered do NOT fire — the first pump for a registration seeds a silent
   *  baseline, matching WC3. Cheap: O(regs × units) containment checks per tick. */
  pumpRegions(units: ReadonlyArray<UnitSnapshot>): void {
    for (const reg of this.rt.triggerRegs) {
      const entering = reg.kind === "enterRegion";
      if (!entering && reg.kind !== "leaveRegion") continue;
      const rects = this.rectsOf(reg.params[0]);
      if (!rects.length) continue;

      const cur = new Set<number>();
      for (const u of units) {
        for (const r of rects) {
          if (u.x >= r.minx && u.x <= r.maxx && u.y >= r.miny && u.y <= r.maxy) {
            cur.add(u.id);
            break;
          }
        }
      }
      const prev = this.regionMembers.get(reg);
      this.regionMembers.set(reg, cur);
      if (!prev) continue; // baseline tick: seed membership without firing

      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (!trig || !trig.enabled) continue;
      if (entering) {
        for (const u of units) if (cur.has(u.id) && !prev.has(u.id)) this.fireRegionCrossing(reg, trig, u, "EnteringUnit");
      } else {
        for (const id of prev) {
          if (!cur.has(id)) {
            const u = units.find((x) => x.id === id);
            if (u) this.fireRegionCrossing(reg, trig, u, "LeavingUnit");
          }
        }
      }
    }
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
   *  trigger with the right event responses. */
  private fireRegionCrossing(reg: TriggerReg, trig: TriggerObj, u: UnitSnapshot, respKey: string): void {
    const handle = this.rt.unitForSim(u);
    if (!this.eventFilterPasses(reg.params[1], handle)) return;
    const responses = new Map<string, JassValue>([["TriggerUnit", handle], [respKey, handle]]);
    this.fireTrigger(trig, this.withTrigger(responses, trig));
  }

  /** Evaluate an event registration's boolexpr filter (enter-region's 3rd arg, a
   *  player-unit-event's filter, …) with the subject unit exposed as GetFilterUnit.
   *  A missing/empty filter passes. */
  private eventFilterPasses(filter: JassValue | undefined, unit: JassValue): boolean {
    if (!filter || filter.k !== "handle") return true;
    const be = this.rt.handles.get(filter.h) as BoolExpr | undefined;
    if (!be?.fn) return true;
    this.rt.eventStack.push(new Map([["FilterUnit", unit]]));
    try {
      return truthy(this.callFunction(be.fn, []));
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
      this.dispatchToRegs(responses, (reg) =>
        (reg.kind === "unitDeath" && this.paramUnitIs(reg, victim)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_DEATH) && this.paramUnitIs(reg, victim)) ||
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, EVENT_PLAYER_UNIT_DEATH, d.victim.owner, victim)));
    }
  }

  /** Pump damage events (7.4c) — EVENT_UNIT_DAMAGED on the struck unit, with
   *  GetEventDamage / GetEventDamageSource. (1.27 has no per-player damage event.) */
  pumpDamageEvents(events: ReadonlyArray<DamageEvent>): void {
    for (const e of events) {
      const target = this.rt.unitForSim(e.target);
      const source = e.source ? this.rt.unitForSim(e.source) : JNULL;
      const responses = new Map<string, JassValue>([["TriggerUnit", target], ["EventDamageSource", source], ["EventDamage", jReal(e.amount)]]);
      this.dispatchToRegs(responses, (reg) => reg.kind === "unitEvent" && this.unitEventIs(reg, EVENT_UNIT_DAMAGED) && this.paramUnitIs(reg, target));
    }
  }

  /** Pump attack events (7.4c) — EVENT_UNIT_ATTACKED (specific unit) + the common
   *  EVENT_PLAYER_UNIT_ATTACKED (per player), with GetAttacker. */
  pumpAttackEvents(events: ReadonlyArray<AttackEvent>): void {
    for (const e of events) {
      const attacked = this.rt.unitForSim(e.attacked);
      const attacker = this.rt.unitForSim(e.attacker);
      const responses = new Map<string, JassValue>([["TriggerUnit", attacked], ["Attacker", attacker]]);
      this.dispatchToRegs(responses, (reg) =>
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
      ]);
      const playerEvt = e.kind === "immediate" ? EVENT_PLAYER_UNIT_ISSUED_ORDER : e.kind === "point" ? EVENT_PLAYER_UNIT_ISSUED_POINT_ORDER : EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER;
      const unitEvt = e.kind === "immediate" ? EVENT_UNIT_ISSUED_ORDER : e.kind === "point" ? EVENT_UNIT_ISSUED_POINT_ORDER : EVENT_UNIT_ISSUED_TARGET_ORDER;
      this.dispatchToRegs(responses, (reg) =>
        (reg.kind === "playerUnitEvent" && this.playerUnitEventMatches(reg, playerEvt, e.unit.owner, unit)) ||
        (reg.kind === "unitEvent" && this.unitEventIs(reg, unitEvt) && this.paramUnitIs(reg, unit)));
    }
  }

  /** Fire every registration matching `pred` with the given responses. Snapshots the
   *  reg list first — an action may register/destroy triggers mid-dispatch. */
  private dispatchToRegs(responses: Map<string, JassValue>, pred: (reg: TriggerReg) => boolean): void {
    for (const reg of [...this.rt.triggerRegs]) {
      if (!pred(reg)) continue;
      const trig = this.rt.handles.get(reg.trigId) as TriggerObj | undefined;
      if (trig) this.fireTrigger(trig, this.withTrigger(responses, trig));
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
   *  and its optional boolexpr filter (params[2]) passes. */
  private playerUnitEventMatches(reg: TriggerReg, eventIndex: number, owner: number, unit: JassValue): boolean {
    return this.rt.enumIndex(reg.params[1] ?? JNULL) === eventIndex
      && this.rt.data<JassPlayer>(reg.params[0])?.index === owner
      && this.eventFilterPasses(reg.params[2], unit);
  }
}

/** Non-error control-flow token for `exitwhen` (thrown to unwind out of loop body). */
class ExitLoop {}
const EXIT_LOOP = new ExitLoop();
