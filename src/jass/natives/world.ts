// World bring-up natives (Phase 7 — issue #33; see docs/triggers.md).
//
// The natives main() → CreateAllUnits() calls to place every pre-placed unit
// (CreateUnit is called ~25k times across the bundled corpus), plus resource/state
// setters and the floating-text natives (the issue's "start with simple stuff like
// floating text" example). Each one that changes the world calls through the
// optional EngineHooks bridge; with no bridge attached (headless tests) they still
// record into the runtime so CreateAllUnits can be counted against war3mapUnits.doo.

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { JassPlayer, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, JNULL, type JassValue } from "../values";

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
    if (u && u.simId >= 0) c.rt.hooks?.removeUnit?.(u.simId);
    return JNULL;
  });

  // --- unit queries ---
  def(rt, "GetUnitTypeId", (c, a) => jInt(unit(c, a[0]) ? rawcodeToInt(unit(c, a[0])!.typeId) : 0));
  def(rt, "GetOwningPlayer", (c, a) => c.rt.playerHandle(unit(c, a[0])?.player ?? 15));
  def(rt, "GetUnitX", (c, a) => ({ k: "real", n: unit(c, a[0])?.x ?? 0 }));
  def(rt, "GetUnitY", (c, a) => ({ k: "real", n: unit(c, a[0])?.y ?? 0 }));
  def(rt, "IsUnitHidden", () => jBool(false));
  def(rt, "IsUnitType", () => jBool(false));

  // --- floating text (text tags) — the issue's starter example ---
  interface TextTag {
    text: string;
    x: number;
    y: number;
    z: number;
    color: number;
    visible: boolean;
  }
  const emit = (c: NativeCtx, tt: TextTag): void => {
    if (tt.visible && tt.text) c.rt.hooks?.createTextTag?.(tt.text, tt.x, tt.y, tt.z, tt.color);
  };
  def(rt, "CreateTextTag", (c) => {
    const tt: TextTag = { text: "", x: 0, y: 0, z: 0, color: 0xffffffff, visible: true };
    return jHandle(c.rt.handles.alloc(tt), "texttag");
  });
  def(rt, "SetTextTagText", (c, a) => {
    const tt = c.rt.data<TextTag>(a[0]);
    if (tt) {
      tt.text = asStr(a[1]);
      emit(c, tt);
    }
    return JNULL;
  });
  def(rt, "SetTextTagPos", (c, a) => {
    const tt = c.rt.data<TextTag>(a[0]);
    if (tt) {
      tt.x = asNum(a[1]);
      tt.y = asNum(a[2]);
      tt.z = asNum(a[3]);
    }
    return JNULL;
  });
  def(rt, "SetTextTagPosUnit", () => JNULL);
  def(rt, "SetTextTagColor", (c, a) => {
    const tt = c.rt.data<TextTag>(a[0]);
    if (tt) {
      const r = asInt(a[1]) & 0xff, g = asInt(a[2]) & 0xff, b = asInt(a[3]) & 0xff, al = asInt(a[4]) & 0xff;
      tt.color = ((al << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
    return JNULL;
  });
  def(rt, "SetTextTagVisibility", (c, a) => {
    const tt = c.rt.data<TextTag>(a[0]);
    if (tt) {
      tt.visible = a[1].k === "bool" && a[1].b;
      emit(c, tt);
    }
    return JNULL;
  });
  def(rt, "DestroyTextTag", () => JNULL);

  // --- on-screen messages (DisplayTextToPlayer family) ---
  def(rt, "DisplayTextToPlayer", (c, a) => {
    c.rt.hooks?.displayText?.(c.rt.data<JassPlayer>(a[0])?.index ?? 0, asStr(a[3]));
    return JNULL;
  });
  def(rt, "DisplayTimedTextToPlayer", (c, a) => {
    c.rt.hooks?.displayText?.(c.rt.data<JassPlayer>(a[0])?.index ?? 0, asStr(a[4]));
    return JNULL;
  });
}
