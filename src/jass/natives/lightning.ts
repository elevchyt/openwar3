// Lightning — a SCRIPT's bolt (docs/map-compatibility.md pass 10).
//
// common.j's lightning API (lines 2414-2423, all in the install's own 1.30.4 file):
//
//     native AddLightning       takes string codeName, boolean checkVisibility, real x1, real y1, real x2, real y2 returns lightning
//     native AddLightningEx     takes string codeName, boolean checkVisibility, real x1, real y1, real z1, real x2, real y2, real z2 returns lightning
//     native DestroyLightning   takes lightning whichBolt returns boolean
//     native MoveLightning[Ex]  takes lightning whichBolt, boolean checkVisibility, <the same points> returns boolean
//     native GetLightningColorA/R/G/B takes lightning whichBolt returns real
//     native SetLightningColor  takes lightning whichBolt, real r, real g, real b, real a returns boolean
//
// The same ribbons a Chain Lightning strings (render/lightningOverlay.ts, the rows of
// `Splats\LightningData.slk`), but the SCRIPT owns them: no lifetime, no fade, two POINTS for
// ends rather than two units, moved by hand every tick of a map's own timer — DotA re-strings
// its tethers that way. 70 call sites across four downloaded maps.
//
// Three things are settled by sources rather than by the look of it:
//   * HEIGHT. Plain `AddLightning` "only takes x and y as a parameter. This is why they 'attach'
//     to the ground" (hiveworkshop 278746). The Ex form's z is ABSOLUTE: blizzard.j's own
//     `AddLightningLoc` passes `GetLocationZ(where)` straight through, and every tutorial adds
//     the terrain height itself (hiveworkshop 220370, 196314).
//   * `checkVisibility`: "type true and the lightning will not appear through the fog of war and
//     black mask, type false and it will" (hiveworkshop 220370).
//   * COLOUR is 0..1 with alpha (`SetLightningColor(l, 0, .7, 1, 1)` in the corpus).

import type { NativeCtx, Runtime } from "../runtime";
import { asNum, asStr, jBool, jHandle, jReal, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A `lightning` handle — the engine's id for the bolt. */
interface LightningObj {
  handleId: number;
  engineId: number;
}

const bolt = (c: NativeCtx, v: JassValue | undefined): LightningObj | undefined => c.rt.data<LightningObj>(v ?? JNULL);

export function registerLightningNatives(rt: Runtime): void {
  // A row the table does not have (or no engine at all — headless) hands back a NULL handle,
  // and every native below answers false/0 for one, so the map runs on (never hard-crash it).
  const add = (c: NativeCtx, a: JassValue[], absZ: boolean): JassValue => {
    const n = (i: number) => asNum(a[i]);
    const id = absZ
      ? c.rt.hooks?.addLightning?.(asStr(a[0]), truthy(a[1]), n(2), n(3), n(4), n(5), n(6), n(7), true)
      : c.rt.hooks?.addLightning?.(asStr(a[0]), truthy(a[1]), n(2), n(3), 0, n(4), n(5), 0, false);
    if (id === undefined || id < 0) return JNULL;
    const l: LightningObj = { handleId: 0, engineId: id };
    l.handleId = c.rt.handles.alloc(l);
    return jHandle(l.handleId, "lightning");
  };
  def(rt, "AddLightning", (c, a) => add(c, a, false));
  def(rt, "AddLightningEx", (c, a) => add(c, a, true));

  const move = (c: NativeCtx, a: JassValue[], absZ: boolean): JassValue => {
    const l = bolt(c, a[0]);
    if (!l) return jBool(false);
    const n = (i: number) => asNum(a[i]);
    const ok = absZ
      ? c.rt.hooks?.moveLightning?.(l.engineId, truthy(a[1]), n(2), n(3), n(4), n(5), n(6), n(7), true)
      : c.rt.hooks?.moveLightning?.(l.engineId, truthy(a[1]), n(2), n(3), 0, n(4), n(5), 0, false);
    return jBool(ok ?? false);
  };
  def(rt, "MoveLightning", (c, a) => move(c, a, false));
  def(rt, "MoveLightningEx", (c, a) => move(c, a, true));

  def(rt, "DestroyLightning", (c, a) => {
    const l = bolt(c, a[0]);
    if (!l) return jBool(false); // destroying a null bolt is legal and common
    const ok = c.rt.hooks?.destroyLightning?.(l.engineId) ?? false;
    c.rt.handles.free(l.handleId);
    return jBool(ok);
  });

  def(rt, "SetLightningColor", (c, a) => {
    const l = bolt(c, a[0]);
    if (!l) return jBool(false);
    return jBool(c.rt.hooks?.setLightningColor?.(l.engineId, asNum(a[1]), asNum(a[2]), asNum(a[3]), asNum(a[4])) ?? false);
  });
  const channel = (i: number): NativeFn => (c, a) => {
    const l = bolt(c, a[0]);
    return jReal(l ? c.rt.hooks?.lightningColor?.(l.engineId)?.[i] ?? 0 : 0);
  };
  def(rt, "GetLightningColorR", channel(0));
  def(rt, "GetLightningColorG", channel(1));
  def(rt, "GetLightningColorB", channel(2));
  def(rt, "GetLightningColorA", channel(3));
}
