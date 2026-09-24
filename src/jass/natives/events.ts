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

import { playerStateHolds, ThreadAbort, unitStateHolds, type BoolExpr, type NativeCtx, type Runtime, type TimerObj, type TriggerObj, type TriggerReg } from "../runtime";
import { asNum, jBool, jHandle, jInt, JNULL, jReal, type JassValue } from "../values";
import { ATTACK_TYPES } from "../../data/unitFieldCodes";
import type { AttackType } from "../../data/enums";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const trig = (c: NativeCtx, v: JassValue): TriggerObj | undefined => c.rt.data<TriggerObj>(v);
const timer = (c: NativeCtx, v: JassValue): TimerObj | undefined => c.rt.data<TimerObj>(v);

/** common.j's WEAPON_TYPE_* constants, read off the runtime's own globals, as data-spelled sound
 *  names ("MetalMediumSlice") both ways. Built once per runtime. */
const weaponTypeCache = new WeakMap<Runtime, { bySound: Map<string, number>; byIndex: Map<number, string> }>();
export function weaponTypes(c: NativeCtx): { bySound: Map<string, number>; byIndex: Map<number, string> } {
  let t = weaponTypeCache.get(c.rt);
  if (!t) {
    t = { bySound: new Map(), byIndex: new Map() };
    for (const [name, v] of c.rt.globals) {
      if (!name.startsWith("WEAPON_TYPE_") || v.k !== "handle") continue;
      const sound = name.slice("WEAPON_TYPE_".length).toLowerCase().split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
      const index = c.rt.enumIndex(v);
      if (sound === "Whoknows") continue; // WEAPON_TYPE_WHOKNOWS — no sound at all
      t.bySound.set(sound.toLowerCase(), index);
      t.byIndex.set(index, sound);
    }
    weaponTypeCache.set(c.rt, t);
  }
  return t;
}

export function registerEventNatives(rt: Runtime): void {
  // --- triggers ---
  def(rt, "CreateTrigger", (c) => {
    const t: TriggerObj = { handleId: 0, actions: [], conditions: [], enabled: true, evals: 0, execs: 0 };
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
  // A real handle, not a shared dummy. The handle IS the return value's whole purpose: it is
  // what `TriggerRemoveAction` takes, and with every action sharing `jHandle(0, …)` the remover
  // could not be written at all — one call would have had to remove all of them or none.
  def(rt, "TriggerAddAction", (c, a) => {
    const t = trig(c, a[0]);
    if (!t || a[1].k !== "code") return jHandle(0, "triggeraction");
    const entry = { id: 0, fn: a[1].fn };
    entry.id = c.rt.handles.alloc(entry);
    t.actions.push(entry);
    return jHandle(entry.id, "triggeraction");
  });
  def(rt, "TriggerAddCondition", (c, a) => {
    const t = trig(c, a[0]);
    const be = c.rt.data<BoolExpr>(a[1]);
    if (!t || !be) return jHandle(0, "triggercondition");
    const entry = { id: 0, fn: be.fn };
    entry.id = c.rt.handles.alloc(entry);
    t.conditions.push(entry);
    return jHandle(entry.id, "triggercondition");
  });
  // …and the removers they exist for. `TriggerRemoveAction(trigger, action)` / `TriggerRemoveCondition(trigger, condition)` —
  // common.j passes BOTH, the trigger first. Removal is by the entry's HANDLE, so a map that
  // added the same function twice and removes it once keeps the other copy.
  const removeEntry = (c: NativeCtx, trigV: JassValue, v: JassValue, which: "actions" | "conditions"): void => {
    const t = trig(c, trigV);
    if (!t || v?.k !== "handle") return;
    const i = t[which].findIndex((e) => e.id === v.h);
    if (i < 0) return;
    t[which].splice(i, 1);
    c.rt.handles.free(v.h);
  };
  def(rt, "TriggerRemoveAction", (c, a) => (removeEntry(c, a[0], a[1], "actions"), JNULL));
  def(rt, "TriggerRemoveCondition", (c, a) => (removeEntry(c, a[0], a[1], "conditions"), JNULL));
  // `ResetTrigger` — zero the two counters. It does NOT clear actions or conditions
  // (`TriggerClearActions` is that), which is why it is here and not an alias of one.
  def(rt, "ResetTrigger", (c, a) => {
    const t = trig(c, a[0]);
    if (t) { t.evals = 0; t.execs = 0; }
    return JNULL;
  });
  def(rt, "GetTriggerEvalCount", (c, a) => jInt(trig(c, a[0])?.evals ?? 0));
  def(rt, "GetTriggerExecCount", (c, a) => jInt(trig(c, a[0])?.execs ?? 0));
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
    // TriggerRegisterUnitInRange(trigger, unit whichUnit, real range, boolexpr filter) — an
    // enter-region whose region is a CIRCLE that walks around with `whichUnit`. Polled beside
    // the rect pump for exactly that reason (Interpreter.pumpRegions). Blizzard.j's
    // `TriggerRegisterUnitInRangeSimple(trig, range, whichUnit)` reorders the two and passes
    // no filter, and that wrapper is what the campaign scripts actually call.
    TriggerRegisterUnitInRange: "unitInRange",
    TriggerRegisterUnitEvent: "unitEvent",
    TriggerRegisterPlayerUnitEvent: "playerUnitEvent",
    TriggerRegisterPlayerEvent: "playerEvent",
    TriggerRegisterDeathEvent: "unitDeath",
    TriggerRegisterUnitStateEvent: "unitState",
    TriggerRegisterGameEvent: "gameEvent",
    TriggerRegisterGameStateEvent: "gameStateEvent",
    TriggerRegisterDialogEvent: "dialogEvent",
    // TriggerRegisterPlayerChatEvent(trigger, player, chatString, exactMatchOnly) — how every
    // map that takes typed commands takes them ("-ap", "-random", "-ii"). The params are kept
    // raw and judged at dispatch (Interpreter.firePlayerChat), because the match depends on
    // what was actually said and `exactMatchOnly` decides whether it is equality or a prefix.
    TriggerRegisterPlayerChatEvent: "playerChat",
  };
  for (const [name, kind] of Object.entries(REG_KINDS)) def(rt, name, (c, a) => register(c, kind, a));
  // TriggerRegisterUnitStateEvent needs one extra step: EVENT_UNIT_STATE_LIMIT is the one
  // event we POLL (nothing in the sim announces "life changed"), and it fires on a
  // CROSSING — so the comparison's truth has to be sampled the moment the trigger is
  // registered. Without that seed, a unit wounded in the same tick as the registration
  // would look like it had "always" been below the limit and never fire.
  def(rt, "TriggerRegisterUnitStateEvent", (c, a) => {
    const t = trig(c, a[0]);
    if (!t) return jHandle(0, "event");
    const reg: TriggerReg = { kind: "unitState", trigId: t.handleId, params: a.slice(1) };
    reg.edge = unitStateHolds(c.rt, reg);
    c.rt.triggerRegs.push(reg);
    return jHandle(0, "event");
  });
  // TriggerRegisterPlayerStateEvent — EVENT_PLAYER_STATE_LIMIT, the player-scoped twin of the
  // above and polled for the same reason (nothing in the sim announces "food used changed").
  // Seeding the edge at registration matters even more here than for a unit: a map registers
  // "Player(10)'s food used EQUALS 0" during init, when it trivially already holds, so without
  // the seed the trigger would fire once at map start — a tower defence would run its round-1
  // countdown before its own opening timer ever spawned anything.
  def(rt, "TriggerRegisterPlayerStateEvent", (c, a) => {
    const t = trig(c, a[0]);
    if (!t) return jHandle(0, "event");
    const reg: TriggerReg = { kind: "playerState", trigId: t.handleId, params: a.slice(1) };
    reg.edge = playerStateHolds(c.rt, reg);
    c.rt.triggerRegs.push(reg);
    return jHandle(0, "event");
  });
  // TriggerRegisterVariableEvent — EVENT_GAME_VARIABLE_LIMIT, "Value Of Real Variable": raised
  // by the write itself (Interpreter.fireVariableEvent says when). "This only works for
  // non-array variables of type 'Real'" (UI\TriggerStrings.txt's own hint), so anything else —
  // an integer, an array, a name no global has — registers nothing. Asked of the DECLARED type:
  // a real global holds an int after the editor's own `set udg_X=0`.
  def(rt, "TriggerRegisterVariableEvent", (c, a) => {
    const t = trig(c, a[0]);
    const name = a[1]?.k === "string" ? a[1].s : "";
    if (!t || c.rt.globalTypes.get(name) !== "real") return jHandle(0, "event");
    c.rt.triggerRegs.push({ kind: "variable", trigId: t.handleId, params: [a[1], a[2], a[3]] });
    c.rt.watchedGlobals.add(name);
    return jHandle(0, "event");
  });
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
  // `GetTriggerEventId` — the constant of the REGISTRATION that matched (Interpreter.eventIdOf),
  // so a trigger registered on EVENT_UNIT_DEATH and EVENT_UNIT_DAMAGED can tell which one this
  // is. Null when nothing fired it (a `TriggerExecute` has no event), as in the game.
  def(rt, "GetTriggerEventId", (c) => resp(c, "TriggerEventId"));
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
  // A destructible's own death response. `TriggerRegisterDeathEvent` takes a WIDGET, so a
  // gate raises this pair where a unit raises GetDyingUnit (see pumpDestructableDeaths).
  def(rt, "GetDyingDestructable", (c) => resp(c, "DyingDestructable"));
  // EVENT_(PLAYER_)UNIT_LOADED — the passenger and the carrier it climbed into.
  def(rt, "GetLoadedUnit", (c) => resp(c, "LoadedUnit"));
  def(rt, "GetTransportUnit", (c) => resp(c, "TransportUnit"));
  def(rt, "GetFilterUnit", (c) => resp(c, "FilterUnit")); // set during enter/enum boolexpr filters
  def(rt, "GetEventDamageSource", (c) => resp(c, "EventDamageSource")); // EVENT_UNIT_DAMAGED
  // EVENT_(PLAYER_)UNIT_SUMMON — the new unit, and the one that spawned it (Interpreter.pumpSummonEvents).
  def(rt, "GetSummonedUnit", (c) => resp(c, "SummonedUnit"));
  def(rt, "GetSummoningUnit", (c) => resp(c, "SummoningUnit"));
  // 1.31's other half of the same event (declared in src/compat/prelude.ts). The unit that was
  // HIT is already the triggering unit — a damage event is raised on it — so this is that same
  // response under the name a later map knows it by, and not a second thing to keep in step.
  def(rt, "BlzGetEventDamageTarget", (c) => resp(c, "TriggerUnit"));
  // The whole line that was typed, and the part of it the registration asked for. A map that
  // registers "-kick " and reads both is how "-kick 3" gets its argument: the matched half is
  // sliced off the front and the rest is the parameter.
  def(rt, "GetEventPlayerChatString", (c) => resp(c, "EventPlayerChatString"));
  def(rt, "GetEventPlayerChatStringMatched", (c) => resp(c, "EventPlayerChatStringMatched"));
  def(rt, "GetEventDamage", (c) => {
    const v = resp(c, "EventDamage");
    // Inside a damage event raised WHILE the blow is dealt (Interpreter.fireDamagePhase), the
    // live amount — so a handler reads back what it (or one before it) set: "calling
    // GetEventDamage after you set it with this function will return the value you set" (jassbot).
    const live = c.rt.damageStack[c.rt.damageStack.length - 1];
    if (live && v.k === "real") return jReal(live.blow.amount);
    return v.k === "real" ? v : jReal(0);
  });

  // --- changing the blow (1.29 BlzSetEventDamage, 1.31 the types) ---
  // Only a blow still being dealt can be changed: the sim hands it over synchronously for a map
  // that uses these (SimWorld.damageHook), and a handler past a wait has nothing left to change.
  // The TYPES "can be only used … before armor reduction" (jassbot, BlzSetEventAttackType) — in
  // the DAMAGING phase — and answer false otherwise.
  const blow = (c: NativeCtx) => c.rt.damageStack[c.rt.damageStack.length - 1];
  def(rt, "BlzSetEventDamage", (c, a) => {
    const b = blow(c);
    if (b) b.blow.amount = asNum(a[0] ?? JNULL);
    return JNULL;
  });
  def(rt, "BlzGetEventAttackType", (c) => {
    const b = blow(c);
    return b ? c.rt.enumHandle("AttackType", Math.max(0, ATTACK_TYPES.indexOf(b.blow.attackType as AttackType))) : JNULL;
  });
  def(rt, "BlzSetEventAttackType", (c, a) => {
    const b = blow(c);
    const t = ATTACK_TYPES[c.rt.enumIndex(a[0] ?? JNULL)];
    if (!b || b.phase !== "damaging" || !t) return jBool(false);
    b.blow.attackType = t;
    return jBool(true);
  });
  def(rt, "BlzGetEventDamageType", (c) => {
    const b = blow(c);
    return b ? c.rt.enumHandle("DamageType", b.blow.damageType) : JNULL;
  });
  def(rt, "BlzSetEventDamageType", (c, a) => {
    const b = blow(c);
    const i = c.rt.enumIndex(a[0] ?? JNULL);
    if (!b || b.phase !== "damaging" || i < 0) return jBool(false);
    b.blow.damageType = i;
    return jBool(true);
  });
  // The weapon type is the SOUND of the blow ("Can be used to modify the sound of impact" —
  // jassbot). Our blows carry it as the data spells it ("MetalMediumSlice"), and common.j's own
  // constant for it is WEAPON_TYPE_METAL_MEDIUM_SLICE, so the two are joined by name, off the
  // running common.j's globals rather than a table typed here.
  def(rt, "BlzGetEventWeaponType", (c) => {
    const b = blow(c);
    return b ? c.rt.enumHandle("WeaponType", weaponTypes(c).bySound.get(b.blow.weaponSound.toLowerCase()) ?? 0) : JNULL;
  });
  def(rt, "BlzSetEventWeaponType", (c, a) => {
    const b = blow(c);
    if (!b || b.phase !== "damaging") return jBool(false);
    b.blow.weaponSound = weaponTypes(c).byIndex.get(c.rt.enumIndex(a[0] ?? JNULL)) ?? "";
    return jBool(true);
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
  def(rt, "GetOrderedUnit", (c) => resp(c, "OrderedUnit"));

  // Spell responses (EVENT_(PLAYER_)UNIT_SPELL_* — 7.17). GetSpellAbilityId is the
  // ability's rawcode as an int; GetSpellAbility (the `ability` handle) has no object
  // behind it in our engine, so it stays null rather than fake one.
  def(rt, "GetSpellAbilityUnit", (c) => resp(c, "SpellAbilityUnit"));
  def(rt, "GetSpellAbilityId", (c) => {
    const v = resp(c, "SpellAbilityId");
    return v.k === "int" ? v : jInt(0);
  });
  def(rt, "GetSpellAbility", () => JNULL);
  def(rt, "GetSpellTargetUnit", (c) => resp(c, "SpellTargetUnit"));
  def(rt, "GetSpellTargetX", (c) => {
    const v = resp(c, "SpellTargetX");
    return v.k === "real" ? v : jReal(0);
  });
  def(rt, "GetSpellTargetY", (c) => {
    const v = resp(c, "SpellTargetY");
    return v.k === "real" ? v : jReal(0);
  });
  def(rt, "GetSpellTargetLoc", (c) => {
    const x = resp(c, "SpellTargetX");
    const y = resp(c, "SpellTargetY");
    const l = { handleId: 0, x: x.k === "real" ? x.n : 0, y: y.k === "real" ? y.n : 0 };
    l.handleId = c.rt.handles.alloc(l);
    return jHandle(l.handleId, "location");
  });

  // Construction / training responses (7.17).
  def(rt, "GetConstructingStructure", (c) => resp(c, "ConstructingStructure")); // CONSTRUCT_START
  def(rt, "GetCancelledStructure", (c) => resp(c, "CancelledStructure")); // CONSTRUCT_CANCEL
  def(rt, "GetConstructedStructure", (c) => resp(c, "ConstructedStructure")); // CONSTRUCT_FINISH
  def(rt, "GetTrainedUnit", (c) => resp(c, "TrainedUnit")); // TRAIN_FINISH (the new unit)
  def(rt, "GetTrainedUnitType", (c) => {
    const v = resp(c, "TrainedUnitType");
    return v.k === "int" ? v : jInt(0);
  });

  // Item responses (EVENT_(PLAYER_)UNIT_PICKUP/DROP/USE/SELL_ITEM — 7.18). One pair
  // covers all four: the item that moved (GetManipulatedItem) and the unit that moved it
  // (GetManipulatingUnit — also GetTriggerUnit). A SALE additionally names the shop
  // (GetSellingUnit) and the buyer (GetBuyingUnit = the manipulating unit); GetSoldItem is
  // the sold item. GetSoldUnit is the *unit*-sale response — a Tavern hero, a Mercenary Camp's
  // ogre — raised by EVENT_(PLAYER_)UNIT_SELL (269/286; see Interpreter.pumpSellUnitEvents),
  // which is a different event from the SELL_ITEM above.
  def(rt, "GetManipulatedItem", (c) => resp(c, "ManipulatedItem"));
  def(rt, "GetManipulatingUnit", (c) => resp(c, "ManipulatingUnit"));
  def(rt, "GetSoldItem", (c) => resp(c, "ManipulatedItem"));
  def(rt, "GetSellingUnit", (c) => resp(c, "SellingUnit"));
  def(rt, "GetBuyingUnit", (c) => resp(c, "ManipulatingUnit"));
  def(rt, "GetSoldUnit", (c) => resp(c, "SoldUnit"));
  // Set while an EnumItemsInRect filter / action callback runs (natives/items.ts).
  def(rt, "GetEnumItem", (c) => resp(c, "EnumItem"));
  def(rt, "GetFilterItem", (c) => resp(c, "FilterItem"));

  // Hero responses (EVENT_PLAYER_HERO_LEVEL / _SKILL — 7.17).
  def(rt, "GetLevelingUnit", (c) => resp(c, "LevelingUnit"));
  def(rt, "GetLearningUnit", (c) => resp(c, "LearningUnit"));
  def(rt, "GetLearnedSkill", (c) => {
    const v = resp(c, "LearnedSkill");
    return v.k === "int" ? v : jInt(0);
  });
  def(rt, "GetLearnedSkillLevel", (c) => {
    const v = resp(c, "LearnedSkillLevel");
    return v.k === "int" ? v : jInt(0);
  });

  // --- run a trigger from script (used by RunInitializationTriggers etc.) ---
  //
  // **A trigger run from script is still "the triggering trigger".** `GetTriggeringTrigger`
  // answers for a TriggerExecute/TriggerEvaluate the same way it answers for an event —
  // that is precisely what lets a trigger refer to itself without a global — and the World
  // Editor generates code that depends on it in every map it writes:
  //
  //     function Trig_Quest_Main_Illidan_Create_Conditions takes nothing returns boolean
  //         if ( not ( IsTriggerEnabled(GetTriggeringTrigger()) == true ) ) then
  //             return false
  //         endif
  //         return true
  //     endfunction
  //     function Trig_Quest_Main_Illidan_Create_Actions takes nothing returns nothing
  //         call DisableTrigger( GetTriggeringTrigger() )
  //         …
  //
  // That pair — "run me only once, and mark myself spent" — is the editor's own run-once
  // idiom, and it is on the Create trigger of every quest in the campaign. Running the
  // callbacks with no `TriggeringTrigger` on the stack made `GetTriggeringTrigger()` null,
  // so `IsTriggerEnabled(null)` was false and the condition refused: Rise of the Naga's four
  // quests were never created and its log came up empty. The same idiom guards cinematics,
  // ambushes and one-shot spawns, and each of them was failing the same way — where it was
  // only the DisableTrigger half, the trigger silently stopped being one-shot instead.
  //
  // Pushed as its OWN stack frame rather than merged, because `eventResponse` searches the
  // stack downwards: the executed trigger overrides who "the trigger" is and inherits every
  // other response from the event that called it, which is exactly WC3's rule.
  const asTrigger = <T,>(c: NativeCtx, t: TriggerObj, run: () => T): T => {
    c.rt.eventStack.push(new Map([["TriggeringTrigger", jHandle(t.handleId, "trigger")]]));
    try {
      return run();
    } finally {
      c.rt.eventStack.pop();
    }
  };
  const conditionsPass = (c: NativeCtx, t: TriggerObj): boolean => {
    t.evals++; // GetTriggerEvalCount — see TriggerObj
    return t.conditions.every(({ fn }) => {
      const r = c.call(fn, []);
      return r.k === "bool" ? r.b : true;
    });
  };
  const runActions = (c: NativeCtx, t: TriggerObj): void => {
    t.execs++; // GetTriggerExecCount — the actions RAN
    for (const { fn } of [...t.actions]) {
      try {
        c.call(fn, []);
      } catch (err) {
        c.rt.warnOnce(fn, `trigger action threw: ${(err as Error).message}`);
      }
    }
  };
  def(rt, "ConditionalTriggerExecute", (c, a) => {
    const t = trig(c, a[0]);
    if (t && t.enabled) asTrigger(c, t, () => conditionsPass(c, t) && (runActions(c, t), true));
    return JNULL;
  });
  def(rt, "TriggerExecute", (c, a) => {
    const t = trig(c, a[0]);
    if (t) asTrigger(c, t, () => runActions(c, t));
    return JNULL;
  });
  def(rt, "TriggerEvaluate", (c, a) => {
    const t = trig(c, a[0]);
    return jBool(t ? asTrigger(c, t, () => conditionsPass(c, t)) : false);
  });
  def(rt, "ExecuteFunc", (c, a) => (a[0].k === "string" ? c.call(a[0].s, []) : JNULL));
  def(rt, "DoNothing", () => JNULL);

  // TriggerSleepAction — the GUI's "Wait" action, and what blizzard.j's PolledWait loops
  // on. It SUSPENDS the running trigger thread, which a native (a plain JS function) can't
  // do, so the interpreter intercepts it at the call site (Interpreter.execThreadNative)
  // and yields to the thread scheduler. This impl is only reached when there's no thread to
  // park — a condition/filter/enum callback, where WC3 can't wait either: abandon that
  // callback rather than let PolledWait's poll loop spin (see ThreadAbort).
  def(rt, "TriggerSleepAction", () => {
    throw new ThreadAbort();
  });

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
