// World bring-up natives (Phase 7 — issue #33; see docs/triggers.md).
//
// The natives main() → CreateAllUnits() calls to place every pre-placed unit
// (CreateUnit is called ~25k times across the bundled corpus), plus the resource/
// state setters and unit queries. Each one that changes the world calls through the
// optional EngineHooks bridge; with no bridge attached (headless tests) they still
// record into the runtime so CreateAllUnits can be counted against war3mapUnits.doo.
// (The text actions — floating text + on-screen messages — moved to natives/text.ts.)

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { JassPlayer, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, jBool, jHandle, jInt, JNULL, type JassValue } from "../values";

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

  // --- unit queries ---
  def(rt, "GetUnitTypeId", (c, a) => jInt(unit(c, a[0]) ? rawcodeToInt(unit(c, a[0])!.typeId) : 0));
  def(rt, "GetOwningPlayer", (c, a) => c.rt.playerHandle(unit(c, a[0])?.player ?? 15));
  def(rt, "GetUnitX", (c, a) => ({ k: "real", n: unit(c, a[0])?.x ?? 0 }));
  def(rt, "GetUnitY", (c, a) => ({ k: "real", n: unit(c, a[0])?.y ?? 0 }));
  def(rt, "IsUnitHidden", () => jBool(false));
  def(rt, "IsUnitType", () => jBool(false));
  // Floating text tags + on-screen messages (the "text actions") live in
  // natives/text.ts alongside the string/name text-logic natives.
}
