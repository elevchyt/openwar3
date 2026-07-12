// World bring-up natives (Phase 7 — issue #33; see docs/triggers.md).
//
// The natives main() → CreateAllUnits() calls to place every pre-placed unit
// (CreateUnit is called ~25k times across the bundled corpus), plus the resource/
// state setters and unit queries. Each one that changes the world calls through the
// optional EngineHooks bridge; with no bridge attached (headless tests) they still
// record into the runtime so CreateAllUnits can be counted against war3mapUnits.doo.
// (The text actions — floating text + on-screen messages — moved to natives/text.ts.)

import { intToRawcode, rawcodeToInt } from "../lexer";
import { orderIdToString, orderStringToId } from "../orders";
import type { EngineHooks, JassPlayer, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, jBool, jHandle, jInt, JNULL, jStr, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const unit = (ctx: NativeCtx, v: JassValue): JassUnit | undefined => ctx.rt.data<JassUnit>(v);

/** Create a unit and hand back a `unit` handle. player is a handle, typeId an int
 *  rawcode; we convert it to the 4-char string the engine bridge expects. */
function createUnit(ctx: NativeCtx, playerV: JassValue, typeInt: number, x: number, y: number, facing: number): JassValue {
  const rt = ctx.rt;
  const playerIdx = rt.data<JassPlayer>(playerV)?.index ?? asInt(playerV);
  const typeId = intToRawcode(typeInt);
  const simId = rt.hooks?.createUnit?.(playerIdx, typeId, x, y, facing) ?? -1;
  const u: JassUnit = { handleId: 0, player: playerIdx, typeId, x, y, facing, simId };
  u.handleId = rt.handles.alloc(u);
  rt.units.push(u);
  rt.bindSimUnit(u); // one sim unit = one handle: a later group enum/event pump reuses THIS one
  return jHandle(u.handleId, "unit");
}

export function registerWorldNatives(rt: Runtime): void {
  // --- unit creation ---
  def(rt, "CreateUnit", (c, a) => createUnit(c, a[0], asInt(a[1]), asNum(a[2]), asNum(a[3]), asNum(a[4])));
  // CreateUnitAtLoc takes a location handle {x,y}; degrade gracefully if unresolved.
  def(rt, "CreateUnitAtLoc", (c, a) => {
    const loc = c.rt.data<{ x: number; y: number }>(a[2]);
    return createUnit(c, a[0], asInt(a[1]), loc?.x ?? 0, loc?.y ?? 0, asNum(a[3]));
  });

  // --- unit setters (route through the bridge when present) ---
  def(rt, "SetResourceAmount", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setResourceAmount?.(u.simId, asInt(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitAcquireRange", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitAcquireRange?.(u.simId, asNum(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitState", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitState?.(u.simId, c.rt.enumIndex(a[1]), asNum(a[2]));
    return JNULL;
  });
  def(rt, "GetUnitState", (c, a) => {
    const u = unit(c, a[0]);
    return { k: "real", n: u && u.simId >= 0 ? c.rt.hooks?.getUnitState?.(u.simId, c.rt.enumIndex(a[1])) ?? 0 : 0 };
  });
  def(rt, "SetUnitColor", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitColor?.(u.simId, c.rt.enumIndex(a[1]));
    return JNULL;
  });
  def(rt, "ShowUnit", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.hideUnit?.(u.simId, !(a[1].k === "bool" && a[1].b));
    return JNULL;
  });
  def(rt, "RemoveUnit", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.removeUnit?.(u.simId);
    return JNULL;
  });
  def(rt, "KillUnit", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.killUnit?.(u.simId);
    return JNULL;
  });

  // --- unit-mutation effects (7.7 cont.): a trigger visibly moves/alters a unit ---
  // Keep the JassUnit handle's own x/y/facing in step with the sim write so a headless
  // run (no bridge) still reflects it, and GetUnit* has a fallback.
  const DEG = Math.PI / 180; // JASS facing/angles are in degrees; the sim uses radians.
  // The unit's live (x,y) — sim value when attached, else the handle's last-known.
  const posOf = (c: NativeCtx, u: JassUnit): [number, number] => [
    u.simId >= 0 ? c.rt.hooks?.getUnitX?.(u.simId) ?? u.x : u.x,
    u.simId >= 0 ? c.rt.hooks?.getUnitY?.(u.simId) ?? u.y : u.y,
  ];
  const move = (c: NativeCtx, u: JassUnit, x: number, y: number): void => {
    u.x = x;
    u.y = y;
    if (u.simId >= 0) c.rt.hooks?.setUnitPosition?.(u.simId, x, y);
  };
  def(rt, "SetUnitX", (c, a) => (unit(c, a[0]) && move(c, unit(c, a[0])!, asNum(a[1]), posOf(c, unit(c, a[0])!)[1]), JNULL));
  def(rt, "SetUnitY", (c, a) => (unit(c, a[0]) && move(c, unit(c, a[0])!, posOf(c, unit(c, a[0])!)[0], asNum(a[1])), JNULL));
  def(rt, "SetUnitPosition", (c, a) => (unit(c, a[0]) && move(c, unit(c, a[0])!, asNum(a[1]), asNum(a[2])), JNULL));
  def(rt, "SetUnitPositionLoc", (c, a) => {
    const u = unit(c, a[0]);
    const loc = c.rt.data<{ x: number; y: number }>(a[1]);
    if (u && loc) move(c, u, loc.x, loc.y);
    return JNULL;
  });
  const face = (c: NativeCtx, u: JassUnit, deg: number, instant: boolean): void => {
    if (instant) u.facing = deg;
    if (u.simId >= 0) c.rt.hooks?.setUnitFacing?.(u.simId, deg * DEG, instant);
  };
  def(rt, "SetUnitFacing", (c, a) => (unit(c, a[0]) && face(c, unit(c, a[0])!, asNum(a[1]), true), JNULL));
  def(rt, "SetUnitFacingTimed", (c, a) => (unit(c, a[0]) && face(c, unit(c, a[0])!, asNum(a[1]), false), JNULL));

  def(rt, "SetUnitOwner", (c, a) => {
    const u = unit(c, a[0]);
    if (!u) return JNULL;
    const newOwner = c.rt.data<JassPlayer>(a[1])?.index ?? asInt(a[1]);
    const changeColor = a[2]?.k === "bool" && a[2].b;
    const prev = u.player;
    u.player = newOwner;
    if (u.simId >= 0) c.rt.hooks?.setUnitOwner?.(u.simId, newOwner, changeColor);
    // EVENT_PLAYER_UNIT_CHANGE_OWNER = ConvertPlayerUnitEvent(270). Fire it for the
    // losing player's registration (the common "any unit" reg covers every slot).
    if (prev !== newOwner) {
      const resp = new Map<string, JassValue>([
        ["ChangingUnit", a[0]],
        ["TriggerUnit", a[0]],
        ["ChangingUnitPrevOwner", c.rt.playerHandle(prev)],
        ["TriggerPlayer", c.rt.playerHandle(prev)],
      ]);
      c.fireEvent?.("playerUnitEvent", resp, (p) => c.rt.enumIndex(p[1] ?? JNULL) === 270 && c.rt.data<JassPlayer>(p[0])?.index === prev);
    }
    return JNULL;
  });

  def(rt, "PauseUnit", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.pauseUnit?.(u.simId, a[1]?.k === "bool" && a[1].b);
    return JNULL;
  });
  def(rt, "IsUnitPaused", (c, a) => {
    const u = unit(c, a[0]);
    return jBool(u && u.simId >= 0 ? c.rt.hooks?.isUnitPaused?.(u.simId) ?? false : false);
  });

  def(rt, "SetUnitScale", (c, a) => {
    // WC3 scales the model uniformly by scaleX (scaleY/scaleZ are ignored on ground models).
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitScale?.(u.simId, asNum(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitVertexColor", (c, a) => {
    // JASS passes 0–255 per channel; the render tint is 0–1.
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitVertexColor?.(u.simId, asInt(a[1]) / 255, asInt(a[2]) / 255, asInt(a[3]) / 255, asInt(a[4]) / 255);
    return JNULL;
  });
  def(rt, "SetUnitTimeScale", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitTimeScale?.(u.simId, asNum(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitFlyHeight", (c, a) => {
    // takes unit, real newHeight, real rate — we apply instantly (rate ignored).
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitFlyHeight?.(u.simId, asNum(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitMoveSpeed", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitMoveSpeed?.(u.simId, asNum(a[1]));
    return JNULL;
  });
  def(rt, "SetUnitTurnSpeed", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitTurnSpeed?.(u.simId, asNum(a[1]));
    return JNULL;
  });

  // --- orders (7.14): a trigger tells a unit what to do; the sim carries it out ---
  // Route an order (generic id + target kind) through the bridge to the sim's issue*
  // commands. IssueXOrder returns true when the order took. A no-sim / unknown unit → false.
  // The order STRING travels alongside the id: an ability order ("holybolt") has no id
  // we can know, so the sim resolves the cast by matching the string against the unit's
  // abilities (see rts.issueUnitOrder). An *ById* caller gives us only the number — we
  // recover the string from the vocabulary (which minted it), so both spellings work.
  const orderStr = (v: JassValue): string => (v.k === "string" ? v.s.trim().toLowerCase() : "");
  const issue = (c: NativeCtx, unitV: JassValue, order: string, orderId: number, kind: "immediate" | "point" | "target", x: number, y: number, targetV: JassValue): JassValue => {
    const u = unit(c, unitV);
    if (!u || u.simId < 0) return jBool(false);
    const t = kind === "target" ? unit(c, targetV) : undefined;
    return jBool(c.rt.hooks?.issueUnitOrder?.(u.simId, orderId, order, kind, x, y, t?.simId ?? 0) ?? false);
  };
  const byName = (c: NativeCtx, unitV: JassValue, orderV: JassValue, kind: "immediate" | "point" | "target", x: number, y: number, targetV: JassValue): JassValue => {
    const order = orderStr(orderV);
    return issue(c, unitV, order, orderStringToId(order), kind, x, y, targetV);
  };
  const byId = (c: NativeCtx, unitV: JassValue, idV: JassValue, kind: "immediate" | "point" | "target", x: number, y: number, targetV: JassValue): JassValue => {
    const id = asInt(idV);
    return issue(c, unitV, orderIdToString(id), id, kind, x, y, targetV);
  };
  def(rt, "IssueImmediateOrder", (c, a) => byName(c, a[0], a[1], "immediate", 0, 0, JNULL));
  def(rt, "IssueImmediateOrderById", (c, a) => byId(c, a[0], a[1], "immediate", 0, 0, JNULL));
  def(rt, "IssuePointOrder", (c, a) => byName(c, a[0], a[1], "point", asNum(a[2]), asNum(a[3]), JNULL));
  def(rt, "IssuePointOrderById", (c, a) => byId(c, a[0], a[1], "point", asNum(a[2]), asNum(a[3]), JNULL));
  def(rt, "IssuePointOrderLoc", (c, a) => {
    const loc = c.rt.data<{ x: number; y: number }>(a[2]);
    return byName(c, a[0], a[1], "point", loc?.x ?? 0, loc?.y ?? 0, JNULL);
  });
  def(rt, "IssuePointOrderByIdLoc", (c, a) => {
    const loc = c.rt.data<{ x: number; y: number }>(a[2]);
    return byId(c, a[0], a[1], "point", loc?.x ?? 0, loc?.y ?? 0, JNULL);
  });
  def(rt, "IssueTargetOrder", (c, a) => byName(c, a[0], a[1], "target", 0, 0, a[2]));
  def(rt, "IssueTargetOrderById", (c, a) => byId(c, a[0], a[1], "target", 0, 0, a[2]));

  // Order id ↔ string vocabulary (OrderId/String2OrderId → int, OrderId2String → string).
  def(rt, "OrderId", (_c, a) => jInt(orderStringToId(orderStr(a[0]))));
  def(rt, "String2OrderId", (_c, a) => jInt(orderStringToId(orderStr(a[0]))));
  def(rt, "OrderId2String", (_c, a) => jStr(orderIdToString(asInt(a[0]))));
  def(rt, "GetUnitCurrentOrder", (c, a) => {
    const u = unit(c, a[0]);
    return jInt(u && u.simId >= 0 ? c.rt.hooks?.getUnitCurrentOrder?.(u.simId) ?? 0 : 0);
  });

  // --- unit queries ---
  // Prefer the sim's live value when a bridge is attached; fall back to the handle's
  // last-known field (the only value available headlessly / before any pump).
  const liveNum = (c: NativeCtx, u: JassUnit | undefined, fromHook: (h: EngineHooks, id: number) => number | undefined, fromHandle: (u: JassUnit) => number): number => {
    if (!u) return 0;
    if (u.simId >= 0 && c.rt.hooks) {
      const v = fromHook(c.rt.hooks, u.simId);
      if (v !== undefined) return v;
    }
    return fromHandle(u);
  };
  const rad2deg = (r: number | undefined): number | undefined => (r === undefined ? undefined : (r * 180) / Math.PI);
  def(rt, "GetUnitTypeId", (c, a) => jInt(unit(c, a[0]) ? rawcodeToInt(unit(c, a[0])!.typeId) : 0));
  def(rt, "GetOwningPlayer", (c, a) => c.rt.playerHandle(unit(c, a[0])?.player ?? 15));
  // Position/facing prefer the live sim value (a script-created unit's handle keeps its
  // spawn-time x/y/facing; an adopted unit's is only refreshed on the event pump).
  def(rt, "GetUnitX", (c, a) => ({ k: "real", n: liveNum(c, unit(c, a[0]), (h, id) => h.getUnitX?.(id), (u) => u.x) }));
  def(rt, "GetUnitY", (c, a) => ({ k: "real", n: liveNum(c, unit(c, a[0]), (h, id) => h.getUnitY?.(id), (u) => u.y) }));
  def(rt, "GetUnitFacing", (c, a) => ({ k: "real", n: liveNum(c, unit(c, a[0]), (h, id) => rad2deg(h.getUnitFacing?.(id)), (u) => u.facing) }));
  def(rt, "GetUnitMoveSpeed", (c, a) => ({ k: "real", n: liveNum(c, unit(c, a[0]), (h, id) => h.getUnitMoveSpeed?.(id), () => 0) }));
  def(rt, "GetUnitFlyHeight", (c, a) => ({ k: "real", n: liveNum(c, unit(c, a[0]), (h, id) => h.getUnitFlyHeight?.(id), () => 0) }));
  // A `location` handle for the unit's LIVE position. Locations are the currency of the
  // BJ layer: "pick every unit within 600 of <unit>" compiles to
  // GetUnitsInRangeOfLocMatching(600, GetUnitLoc(u), filter) — so without GetUnitLoc the
  // whole enum scans a null point and finds nobody (measured on ExtremeCandyWar, whose
  // script called GroupEnumUnitsInRangeOfLoc 168× in a few seconds, every one empty).
  const location = (c: NativeCtx, x: number, y: number): JassValue => {
    const l = { handleId: 0, x, y };
    l.handleId = c.rt.handles.alloc(l);
    return jHandle(l.handleId, "location");
  };
  def(rt, "GetUnitLoc", (c, a) => {
    const u = unit(c, a[0]);
    const [x, y] = u ? posOf(c, u) : [0, 0];
    return location(c, x, y);
  });

  // Alliance — the other half of a group filter ("matching unit belongs to an enemy of
  // Player 1"). Team-based: the sim's unit team vs the player's, so neutral hostile
  // (team -1) is nobody's ally. Enemy is simply "not allied".
  const allied = (c: NativeCtx, unitV: JassValue, playerV: JassValue): boolean => {
    const u = unit(c, unitV);
    if (!u) return false;
    const p = c.rt.data<JassPlayer>(playerV)?.index ?? asInt(playerV);
    if (u.simId < 0 || !c.rt.hooks?.isUnitAlly) return u.player === p; // headless: same owner
    return c.rt.hooks.isUnitAlly(u.simId, p);
  };
  def(rt, "IsUnitAlly", (c, a) => jBool(allied(c, a[0], a[1])));
  def(rt, "IsUnitEnemy", (c, a) => jBool(!allied(c, a[0], a[1])));
  // Player-vs-player alliance (same team). A player is his own ally.
  const playerIdx = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? asInt(v);
  const playersAllied = (c: NativeCtx, a: JassValue[]): boolean => {
    const p = playerIdx(c, a[0]);
    const q = playerIdx(c, a[1]);
    if (p === q) return true;
    return c.rt.hooks?.isPlayerAlly?.(p, q) ?? c.rt.ensurePlayer(p).team === c.rt.ensurePlayer(q).team;
  };
  def(rt, "IsPlayerAlly", (c, a) => jBool(playersAllied(c, a)));
  def(rt, "IsPlayerEnemy", (c, a) => jBool(!playersAllied(c, a)));

  // --- per-unit flags + animation (7.17) ---
  def(rt, "SetUnitInvulnerable", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitInvulnerable?.(u.simId, a[1]?.k === "bool" && a[1].b);
    return JNULL;
  });
  // SetUnitPathing(u, false) makes a unit ignore collision (the classic "ghost" for
  // cinematics and for parking a unit inside a base).
  def(rt, "SetUnitPathing", (c, a) => {
    const u = unit(c, a[0]);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitPathing?.(u.simId, a[1]?.k === "bool" && a[1].b);
    return JNULL;
  });
  // SetUnitAnimation plays a named clip ("attack", "stand victory", "birth"); the name
  // is matched against the model's own sequence names. QueueUnitAnimation has no queue
  // here — it plays the clip the same way; ResetUnitAnimation returns to the idle stand.
  const anim = (c: NativeCtx, unitV: JassValue, name: string): JassValue => {
    const u = unit(c, unitV);
    if (u && u.simId >= 0) c.rt.hooks?.setUnitAnimation?.(u.simId, name);
    return JNULL;
  };
  def(rt, "SetUnitAnimation", (c, a) => anim(c, a[0], a[1].k === "string" ? a[1].s : ""));
  def(rt, "QueueUnitAnimation", (c, a) => anim(c, a[0], a[1].k === "string" ? a[1].s : ""));
  def(rt, "ResetUnitAnimation", (c, a) => anim(c, a[0], ""));

  // The unit's "custom value" — pure script state (the engine never reads it), the
  // spine of every JASS unit-indexing library. It lives on the handle.
  def(rt, "SetUnitUserData", (c, a) => {
    const u = unit(c, a[0]);
    if (u) u.userData = asInt(a[1]);
    return JNULL;
  });
  def(rt, "GetUnitUserData", (c, a) => jInt(unit(c, a[0])?.userData ?? 0));

  def(rt, "IsUnitHidden", () => jBool(false));
  // IsUnitType(u, UNIT_TYPE_*) — the classification half of every "matching unit"
  // filter ("is A structure", "is alive", "is A Hero"). The unittype is a
  // ConvertUnitType index (0 HERO, 1 DEAD, 2 STRUCTURE, …); the bridge answers it from
  // the sim unit's own flags, and any classification we hold no data for reads false.
  def(rt, "IsUnitType", (c, a) => {
    const u = unit(c, a[0]);
    return jBool(u && u.simId >= 0 ? c.rt.hooks?.isUnitType?.(u.simId, c.rt.enumIndex(a[1])) ?? false : false);
  });
  // Floating text tags + on-screen messages (the "text actions") live in
  // natives/text.ts alongside the string/name text-logic natives.
}
