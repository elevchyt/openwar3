// Native registry (Phase 7 — issue #33; see docs/triggers.md).
//
// Registers every JS-implemented native into the runtime. Grouped by subsystem
// (config/player, world bring-up, plus the enum constructors, trigger core, and
// cheap utility natives here). An UNimplemented native is not an error — the
// interpreter falls back to a typed default from the native's common.j return type
// (CLAUDE.md "never hard-crash the map"). Grow coverage with tools/native-coverage.mjs.

import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, jReal, jStr, JNULL, type JassValue } from "../values";
import { registerConfigNatives } from "./config";
import { registerWorldNatives } from "./world";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

// Every `native ConvertX(...)` in common.j wraps an integer into a typed handle
// (playercolor, race, mapcontrol, gametype, …). We model each as an interned enum
// handle keyed by (kind, index), so JASS `==` on two of the same constant is true.
const CONVERT_NATIVES = [
  "ConvertAIDifficulty", "ConvertAllianceType", "ConvertAttackType", "ConvertBlendMode",
  "ConvertCameraField", "ConvertDamageType", "ConvertDialogEvent", "ConvertEffectType",
  "ConvertFGameState", "ConvertFogState", "ConvertGameDifficulty", "ConvertGameEvent",
  "ConvertGameSpeed", "ConvertGameType", "ConvertIGameState", "ConvertItemType",
  "ConvertLimitOp", "ConvertMapControl", "ConvertMapDensity", "ConvertMapFlag",
  "ConvertMapSetting", "ConvertMapVisibility", "ConvertPathingType", "ConvertPlacement",
  "ConvertPlayerColor", "ConvertPlayerEvent", "ConvertPlayerGameResult", "ConvertPlayerScore",
  "ConvertPlayerSlotState", "ConvertPlayerState", "ConvertPlayerUnitEvent", "ConvertRace",
  "ConvertRacePref", "ConvertRarityControl", "ConvertSoundType", "ConvertStartLocPrio",
  "ConvertTexMapFlags", "ConvertUnitEvent", "ConvertUnitState", "ConvertUnitType",
  "ConvertVersion", "ConvertVolumeGroup", "ConvertWeaponType", "ConvertWidgetEvent",
];

/** A minimal trigger object. This session records events/conditions/actions but
 *  does not yet pump runtime events (that's milestone 7.4) — enough to run a map's
 *  InitCustomTriggers + RunInitializationTriggers without crashing, and to fire an
 *  init trigger's actions (the melee library, victory setup, …) via
 *  ConditionalTriggerExecute. */
interface Trigger {
  actions: string[]; // function names added via TriggerAddAction
  conditions: string[]; // function names wrapped by TriggerAddCondition
  events: unknown[]; // recorded registrations (unpumped for now)
  enabled: boolean;
}
interface BoolExpr {
  fn: string;
}

function registerTriggerNatives(rt: Runtime): void {
  const trig = (c: NativeCtx, v: JassValue): Trigger | undefined => c.rt.data<Trigger>(v);
  def(rt, "CreateTrigger", (c) =>
    jHandle(c.rt.handles.alloc({ actions: [], conditions: [], events: [], enabled: true } as Trigger), "trigger"));
  def(rt, "DestroyTrigger", (c, a) => (a[0].k === "handle" ? c.rt.handles.free(a[0].h) : void 0, JNULL));
  def(rt, "EnableTrigger", (c, a) => ((trig(c, a[0]) ?? { enabled: true }).enabled = true, JNULL));
  def(rt, "DisableTrigger", (c, a) => (trig(c, a[0]) && (trig(c, a[0])!.enabled = false), JNULL));
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
  // Condition/Filter wrap a `code` into a boolexpr; And/Or/Not are boolexpr combinators.
  def(rt, "Condition", (c, a) => (a[0].k === "code" ? jHandle(c.rt.handles.alloc({ fn: a[0].fn } as BoolExpr), "boolexpr") : JNULL));
  def(rt, "Filter", (c, a) => (a[0].k === "code" ? jHandle(c.rt.handles.alloc({ fn: a[0].fn } as BoolExpr), "boolexpr") : JNULL));
  def(rt, "And", (_c, a) => a[0] ?? JNULL);
  def(rt, "Or", (_c, a) => a[0] ?? JNULL);
  def(rt, "Not", (_c, a) => a[0] ?? JNULL);
  def(rt, "DestroyBoolExpr", () => JNULL);
  // Event registrations — recorded only (7.4 will pump them from the sim tick).
  for (const name of [
    "TriggerRegisterUnitEvent", "TriggerRegisterPlayerEvent", "TriggerRegisterPlayerUnitEvent",
    "TriggerRegisterEnterRectSimple", "TriggerRegisterLeaveRectSimple", "TriggerRegisterEnterRegion",
    "TriggerRegisterLeaveRegion", "TriggerRegisterTimerEvent", "TriggerRegisterTimerExpireEvent",
    "TriggerRegisterGameEvent", "TriggerRegisterDialogEvent", "TriggerRegisterDeathEvent",
    "TriggerRegisterUnitStateEvent", "TriggerRegisterGameStateEvent",
  ]) {
    def(rt, name, (c, a) => {
      const t = trig(c, a[0]);
      if (t) t.events.push(a.slice(1));
      return jHandle(0, "event");
    });
  }
  // Fire a trigger's actions now (used by RunInitializationTriggers). Evaluate its
  // conditions first (ConditionalTriggerExecute); TriggerExecute skips them.
  const runActions = (c: NativeCtx, t: Trigger): void => {
    for (const fn of t.actions) {
      try {
        c.call(fn, []);
      } catch (err) {
        c.rt.warnOnce(fn, `trigger action threw: ${(err as Error).message}`);
      }
    }
  };
  const conditionsPass = (c: NativeCtx, t: Trigger): boolean =>
    t.conditions.every((fn) => {
      const r = c.call(fn, []);
      return r.k === "bool" ? r.b : true;
    });
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
}

/** Cheap, pure utility natives (string/number conversions, RNG, camera/env
 *  no-ops). Safe to run anywhere; they make blizzard.j run more faithfully and cut
 *  down "safe default" log noise. */
function registerUtilNatives(rt: Runtime): void {
  def(rt, "I2S", (_c, a) => jStr(String(asInt(a[0]))));
  def(rt, "R2S", (_c, a) => jStr(asNum(a[0]).toFixed(3)));
  def(rt, "R2SW", (_c, a) => jStr(asNum(a[0]).toFixed(Math.max(0, asInt(a[2])))));
  def(rt, "I2R", (_c, a) => jReal(asInt(a[0])));
  def(rt, "R2I", (_c, a) => jInt(Math.trunc(asNum(a[0]))));
  def(rt, "S2I", (_c, a) => jInt(parseInt(asStr(a[0]), 10) || 0));
  def(rt, "S2R", (_c, a) => jReal(parseFloat(asStr(a[0])) || 0));
  def(rt, "SubString", (_c, a) => jStr(asStr(a[0]).substring(asInt(a[1]), asInt(a[2]))));
  def(rt, "StringLength", (_c, a) => jInt(asStr(a[0]).length));
  def(rt, "StringCase", (_c, a) => jStr(a[1].k === "bool" && a[1].b ? asStr(a[0]).toUpperCase() : asStr(a[0]).toLowerCase()));
  def(rt, "StringHash", () => jInt(0));
  def(rt, "GetHandleId", (_c, a) => jInt(a[0].k === "handle" ? a[0].h : 0));
  def(rt, "GetRandomInt", (c, a) => {
    const lo = asInt(a[0]), hi = asInt(a[1]);
    return jInt(hi < lo ? lo : lo + Math.floor(c.rt.random() * (hi - lo + 1)));
  });
  def(rt, "GetRandomReal", (c, a) => {
    const lo = asNum(a[0]), hi = asNum(a[1]);
    return jReal(lo + c.rt.random() * (hi - lo));
  });
  def(rt, "SetRandomSeed", () => JNULL);

  // Camera / environment natives every main() calls — we set these up ourselves in
  // the renderer, so here they are safe no-ops (GetCameraMargin returns 0.0).
  def(rt, "GetCameraMargin", () => jReal(0));
  for (const name of [
    "SetCameraBounds", "SetDayNightModels", "NewSoundEnvironment", "SetAmbientDaySound",
    "SetAmbientNightSound", "SetMapMusic", "PlayMusic", "SetMapFlag", "StartSound",
    "StopSound", "SetMapName", "EnableWeatherEffect", "AddWeatherEffect",
  ]) {
    if (!rt.natives.has(name)) def(rt, name, () => JNULL);
  }
}

/** Register the whole implemented native surface into a fresh runtime. */
export function registerNatives(rt: Runtime): void {
  for (const name of CONVERT_NATIVES) {
    const kind = name.slice("Convert".length);
    def(rt, name, (c, a) => c.rt.enumHandle(kind, asInt(a[0])));
  }
  registerConfigNatives(rt);
  registerWorldNatives(rt);
  registerTriggerNatives(rt);
  registerUtilNatives(rt);
}
