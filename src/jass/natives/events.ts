// Trigger / event / timer natives (Phase 7 milestone 7.4 — issue #33).
//
// WC3's trigger model is Event-Condition-Action (ECA): a script creates a trigger,
// registers it on an event (TriggerRegister*Event), and adds conditions/actions.
// When the event fires the engine sets thread-local "event responses"
// (GetTriggerUnit, GetEnteringUnit, GetExpiredTimer, …) that the actions read.
//
// This module owns:
//   • the trigger objects + Condition/Filter/And/Or/Not boolexprs,
//   • event REGISTRATION (recorded into runtime.triggerRegs for the dispatcher),
//   • the event-RESPONSE reader natives (read from runtime's event-response stack),
//   • game timers (CreateTimer/TimerStart/…), pumped by Interpreter.advanceTime.
// The actual FIRING (condition eval + action run, event-response push/pop) lives on
// the interpreter (it needs to call user functions) — see Interpreter.fireTrigger /
// advanceTime. Registration here + firing there keeps natives free of the eval loop.

import type { BoolExpr, NativeCtx, Runtime, TimerObj, TriggerObj } from "../runtime";
import { asNum, jBool, jHandle, jInt, JNULL, jReal, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const trig = (c: NativeCtx, v: JassValue): TriggerObj | undefined => c.rt.data<TriggerObj>(v);
const timer = (c: NativeCtx, v: JassValue): TimerObj | undefined => c.rt.data<TimerObj>(v);

export function registerEventNatives(rt: Runtime): void {
  // --- triggers ---
  def(rt, "CreateTrigger", (c) => {
    const t: TriggerObj = { handleId: 0, actions: [], conditions: [], enabled: true };
    t.handleId = c.rt.handles.alloc(t);
    return jHandle(t.handleId, "trigger");
  });
  def(rt, "DestroyTrigger", (c, a) => {
    if (a[0].k === "handle") {
      c.rt.handles.free(a[0].h);
      // Drop its registrations so the dispatcher stops scanning a dead trigger.
      for (let i = c.rt.triggerRegs.length - 1; i >= 0; i--) if (c.rt.triggerRegs[i].trigId === a[0].h) c.rt.triggerRegs.splice(i, 1);
    }
    return JNULL;
  });
  def(rt, "EnableTrigger", (c, a) => (trig(c, a[0]) && (trig(c, a[0])!.enabled = true), JNULL));
  def(rt, "DisableTrigger", (c, a) => (trig(c, a[0]) && (trig(c, a[0])!.enabled = false), JNULL));
  def(rt, "IsTriggerEnabled", (c, a) => jBool(trig(c, a[0])?.enabled ?? false));
  def(rt, "TriggerAddAction", (c, a) => {
    const t = trig(c, a[0]);
    if (t && a[1].k === "code") t.actions.push(a[1].fn);
    return jHandle(0, "triggeraction");
  });
  def(rt, "TriggerAddCondition", (c, a) => {
    const t = trig(c, a[0]);
    const be = c.rt.data<BoolExpr>(a[1]);
    if (t && be) t.conditions.push(be.fn);
    return jHandle(0, "triggercondition");
  });
  def(rt, "TriggerClearActions", (c, a) => (trig(c, a[0]) && (trig(c, a[0])!.actions = []), JNULL));
  def(rt, "TriggerClearConditions", (c, a) => (trig(c, a[0]) && (trig(c, a[0])!.conditions = []), JNULL));

  // --- boolexpr constructors ---
  def(rt, "Condition", (c, a) => (a[0].k === "code" ? jHandle(c.rt.handles.alloc({ fn: a[0].fn } as BoolExpr), "boolexpr") : JNULL));
  def(rt, "Filter", (c, a) => (a[0].k === "code" ? jHandle(c.rt.handles.alloc({ fn: a[0].fn } as BoolExpr), "boolexpr") : JNULL));
  def(rt, "And", (_c, a) => a[0] ?? JNULL);
  def(rt, "Or", (_c, a) => a[0] ?? JNULL);
  def(rt, "Not", (_c, a) => a[0] ?? JNULL);
  def(rt, "DestroyBoolExpr", () => JNULL);
  def(rt, "DestroyCondition", () => JNULL);
  def(rt, "DestroyFilter", () => JNULL);

  // --- event registration → recorded for the dispatcher (runtime.triggerRegs) ---
  const register = (c: NativeCtx, kind: string, a: JassValue[]): JassValue => {
    const t = trig(c, a[0]);
    if (t) c.rt.triggerRegs.push({ kind, trigId: t.handleId, params: a.slice(1) });
    return jHandle(0, "event");
  };
  // Map each register native to an internal event kind the dispatcher understands.
  const REG_KINDS: Record<string, string> = {
    TriggerRegisterTimerExpireEvent: "timerExpire",
    TriggerRegisterEnterRectSimple: "enterRegion",
    TriggerRegisterEnterRegion: "enterRegion",
    TriggerRegisterLeaveRectSimple: "leaveRegion",
    TriggerRegisterLeaveRegion: "leaveRegion",
    TriggerRegisterUnitEvent: "unitEvent",
    TriggerRegisterPlayerUnitEvent: "playerUnitEvent",
    TriggerRegisterPlayerEvent: "playerEvent",
    TriggerRegisterDeathEvent: "unitDeath",
    TriggerRegisterUnitStateEvent: "unitState",
    TriggerRegisterGameEvent: "gameEvent",
    TriggerRegisterGameStateEvent: "gameStateEvent",
    TriggerRegisterDialogEvent: "dialogEvent",
  };
  for (const [name, kind] of Object.entries(REG_KINDS)) def(rt, name, (c, a) => register(c, kind, a));
  // TriggerRegisterTimerEvent creates its OWN one-shot/periodic timer + a timerExpire
  // registration bound to it (common.j: takes trigger, real timeout, boolean periodic).
  def(rt, "TriggerRegisterTimerEvent", (c, a) => {
    const t = trig(c, a[0]);
    if (!t) return jHandle(0, "event");
    const tm = makeTimer(c.rt, asNum(a[1]), a[2].k === "bool" && a[2].b, null);
    tm.running = true;
    c.rt.triggerRegs.push({ kind: "timerExpire", trigId: t.handleId, params: [jHandle(tm.handleId, "timer")] });
    return jHandle(0, "event");
  });

  // --- event responses (read the current event's thread-local values) ---
  const resp = (c: NativeCtx, key: string): JassValue => c.rt.eventResponse(key);
  def(rt, "GetTriggeringTrigger", (c) => resp(c, "TriggeringTrigger"));
  def(rt, "GetTriggerUnit", (c) => resp(c, "TriggerUnit"));
  def(rt, "GetEnteringUnit", (c) => resp(c, "EnteringUnit"));
  def(rt, "GetLeavingUnit", (c) => resp(c, "LeavingUnit"));
  def(rt, "GetDyingUnit", (c) => resp(c, "DyingUnit"));
  def(rt, "GetKillingUnit", (c) => resp(c, "KillingUnit"));
  def(rt, "GetAttacker", (c) => resp(c, "Attacker"));
  def(rt, "GetTriggerPlayer", (c) => resp(c, "TriggerPlayer"));
  def(rt, "GetChangingUnit", (c) => resp(c, "ChangingUnit")); // EVENT_PLAYER_UNIT_CHANGE_OWNER
  def(rt, "GetChangingUnitPrevOwner", (c) => resp(c, "ChangingUnitPrevOwner"));
  def(rt, "GetExpiredTimer", (c) => resp(c, "ExpiredTimer"));
  def(rt, "GetTriggerWidget", (c) => resp(c, "TriggerWidget"));
  def(rt, "GetFilterUnit", (c) => resp(c, "FilterUnit")); // set during enter/enum boolexpr filters
  def(rt, "GetEventDamageSource", (c) => resp(c, "EventDamageSource")); // EVENT_UNIT_DAMAGED
  def(rt, "GetEventDamage", (c) => {
    const v = resp(c, "EventDamage");
    return v.k === "real" ? v : jReal(0);
  });
  // Issued-order responses (EVENT_..._ISSUED_ORDER/POINT/TARGET — 7.14).
  def(rt, "GetIssuedOrderId", (c) => {
    const v = resp(c, "IssuedOrderId");
    return v.k === "int" ? v : jInt(0);
  });
  def(rt, "GetOrderPointX", (c) => {
    const v = resp(c, "OrderPointX");
    return v.k === "real" ? v : jReal(0);
  });
  def(rt, "GetOrderPointY", (c) => {
    const v = resp(c, "OrderPointY");
    return v.k === "real" ? v : jReal(0);
  });
  def(rt, "GetOrderPointLoc", (c) => {
    const x = resp(c, "OrderPointX");
    const y = resp(c, "OrderPointY");
    const l = { handleId: 0, x: x.k === "real" ? x.n : 0, y: y.k === "real" ? y.n : 0 };
    l.handleId = c.rt.handles.alloc(l);
    return jHandle(l.handleId, "location");
  });
  def(rt, "GetOrderTarget", (c) => resp(c, "OrderTargetUnit")); // widget = the ordered unit target
  def(rt, "GetOrderTargetUnit", (c) => resp(c, "OrderTargetUnit"));

  // --- run a trigger from script (used by RunInitializationTriggers etc.) ---
  const conditionsPass = (c: NativeCtx, t: TriggerObj): boolean =>
    t.conditions.every((fn) => {
      const r = c.call(fn, []);
      return r.k === "bool" ? r.b : true;
    });
  const runActions = (c: NativeCtx, t: TriggerObj): void => {
    for (const fn of t.actions) {
      try {
        c.call(fn, []);
      } catch (err) {
        c.rt.warnOnce(fn, `trigger action threw: ${(err as Error).message}`);
      }
    }
  };
  def(rt, "ConditionalTriggerExecute", (c, a) => {
    const t = trig(c, a[0]);
    if (t && t.enabled && conditionsPass(c, t)) runActions(c, t);
    return JNULL;
  });
  def(rt, "TriggerExecute", (c, a) => {
    const t = trig(c, a[0]);
    if (t) runActions(c, t);
    return JNULL;
  });
  def(rt, "TriggerEvaluate", (c, a) => {
    const t = trig(c, a[0]);
    return jBool(t ? conditionsPass(c, t) : false);
  });
  def(rt, "ExecuteFunc", (c, a) => (a[0].k === "string" ? c.call(a[0].s, []) : JNULL));
  def(rt, "DoNothing", () => JNULL);

  // --- timers ---
  def(rt, "CreateTimer", (c) => jHandle(makeTimer(c.rt, 0, false, null).handleId, "timer"));
  def(rt, "DestroyTimer", (c, a) => {
    const tm = timer(c, a[0]);
    if (tm) {
      tm.running = false;
      const i = c.rt.timers.indexOf(tm);
      if (i >= 0) c.rt.timers.splice(i, 1);
      c.rt.handles.free(tm.handleId);
    }
    return JNULL;
  });
  def(rt, "TimerStart", (c, a) => {
    const tm = timer(c, a[0]);
    if (tm) {
      tm.timeout = asNum(a[1]);
      tm.periodic = a[2].k === "bool" && a[2].b;
      tm.remaining = tm.timeout;
      tm.elapsedTotal = 0;
      tm.running = true;
      tm.handlerFn = a[3].k === "code" ? a[3].fn : null;
    }
    return JNULL;
  });
  def(rt, "PauseTimer", (c, a) => (timer(c, a[0]) && (timer(c, a[0])!.running = false), JNULL));
  def(rt, "ResumeTimer", (c, a) => (timer(c, a[0]) && (timer(c, a[0])!.running = true), JNULL));
  def(rt, "TimerGetElapsed", (c, a) => jReal(timer(c, a[0])?.elapsedTotal ?? 0));
  def(rt, "TimerGetRemaining", (c, a) => jReal(timer(c, a[0])?.remaining ?? 0));
  def(rt, "TimerGetTimeout", (c, a) => jReal(timer(c, a[0])?.timeout ?? 0));
}

/** Allocate a timer object + its handle, registered with the runtime so
 *  advanceTime() pumps it. */
function makeTimer(rt: Runtime, timeout: number, periodic: boolean, handlerFn: string | null): TimerObj {
  const tm: TimerObj = { handleId: 0, timeout, periodic, remaining: timeout, running: false, elapsedTotal: 0, handlerFn };
  tm.handleId = rt.handles.alloc(tm);
  rt.timers.push(tm);
  return tm;
}
