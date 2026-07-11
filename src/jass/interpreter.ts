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

import type { Expr, FunctionDecl, JassProgram, Stmt, VarDecl } from "./ast";
import { Runtime, JassArray, type BoolExpr, type JassPlayer, type NativeCtx, type RectObj, type RegionObj, type TimerObj, type TriggerObj, type TriggerReg } from "./runtime";
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

// common.j event enum indices (ConvertUnitEvent/ConvertPlayerUnitEvent values).
const EVENT_UNIT_DEATH = 53;
const EVENT_PLAYER_UNIT_DEATH = 20;
const EVENT_UNIT_DAMAGED = 52;
const EVENT_PLAYER_UNIT_ATTACKED = 18;
const EVENT_UNIT_ATTACKED = 62;

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

export class Interpreter {
  private depth = 0;
  private globalDecls: VarDecl[] = [];
  private readonly ctx: NativeCtx;

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

  /** Call a function by name: native impl → user function → declared-but-
   *  unimplemented native (typed default) → unknown (null). Never throws for a
   *  missing target. */
  callFunction(name: string, args: JassValue[]): JassValue {
    const nat = this.rt.natives.get(name);
    if (nat) {
      try {
        return nat(this.ctx, args);
      } catch (err) {
        this.rt.warnOnce(name, `threw: ${(err as Error).message}`);
        return defaultForType(this.rt.nativeReturns.get(name) ?? "nothing");
      }
    }
    const fn = this.rt.functions.get(name);
    if (fn) return this.callUser(fn, args);
    const ret = this.rt.nativeReturns.get(name);
    if (ret !== undefined) {
      this.rt.warnOnce(name);
      return defaultForType(ret);
    }
    this.rt.warnOnce(name, "unknown function");
    return JNULL;
  }

  private callUser(fn: FunctionDecl, args: JassValue[]): JassValue {
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
      this.execBlock(fn.body, frame);
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

  private execBlock(stmts: Stmt[], frame: Frame): void {
    for (const s of stmts) this.exec(s, frame);
  }

  private exec(s: Stmt, frame: Frame): void {
    switch (s.kind) {
      case "call":
        this.callFunction(s.name, s.args.map((a) => this.eval(a, frame)));
        return;
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
        return;
      }
      case "return":
        throw new ReturnSignal(s.value ? this.eval(s.value, frame) : JNULL);
      case "if": {
        for (const b of s.branches) {
          if (truthy(this.eval(b.cond, frame))) {
            this.execBlock(b.body, frame);
            return;
          }
        }
        if (s.elseBody) this.execBlock(s.elseBody, frame);
        return;
      }
      case "loop": {
        let iters = 0;
        while (true) {
          if (++iters > MAX_LOOP_ITERS) {
            this.rt.warnOnce("<loop>", "iteration cap hit");
            return;
          }
          try {
            for (const st of s.body) this.exec(st, frame);
          } catch (e) {
            if (e instanceof ExitLoop) return;
            throw e;
          }
        }
      }
      case "exitwhen":
        if (truthy(this.eval(s.cond, frame))) throw EXIT_LOOP;
        return;
    }
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

  /** Run a top-level function by name (config, main, or any trigger callback). */
  run(fnName: string, args: JassValue[] = []): JassValue {
    return this.callFunction(fnName, args);
  }

  // --- event runtime (milestone 7.4) ----------------------------------------

  /** Fire a trigger: push its event responses (thread-local), evaluate conditions,
   *  and run actions if they pass — then pop. This is the ECA execution the whole
   *  event model routes through (timers here; sim events via fireEvent). A trigger
   *  action that throws is logged, never propagated (one bad trigger ≠ dead map). */
  fireTrigger(trig: TriggerObj, responses: Map<string, JassValue>): void {
    if (!trig.enabled) return;
    this.rt.eventStack.push(responses);
    try {
      const pass = trig.conditions.every((fn) => truthy(this.callFunction(fn, [])));
      if (pass) {
        for (const fn of trig.actions) {
          try {
            this.callFunction(fn, []);
          } catch (err) {
            if (!(err instanceof ReturnSignal)) this.rt.warnOnce(fn, `trigger action threw: ${(err as Error).message}`);
          }
        }
      }
    } finally {
      this.rt.eventStack.pop();
    }
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

  /** Advance game timers by `dt` seconds (pumped from the sim tick). An expired
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
  }

  private expireTimer(t: TimerObj): void {
    const responses = new Map<string, JassValue>([["ExpiredTimer", jHandle(t.handleId, "timer")]]);
    if (t.handlerFn) {
      this.rt.eventStack.push(responses);
      try {
        this.callFunction(t.handlerFn, []);
      } catch (err) {
        if (!(err instanceof ReturnSignal)) this.rt.warnOnce(t.handlerFn, `timer handler threw: ${(err as Error).message}`);
      } finally {
        this.rt.eventStack.pop();
      }
    }
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
