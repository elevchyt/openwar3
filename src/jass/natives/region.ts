// Region / rect / location natives (Phase 7 milestone 7.4b — issue #33).
//
// Rects are the geometry behind enter/leave-region events: the World Editor's
// "Unit enters (region)" GUI action compiles to
//   set gg_rct_Foo = Rect( minx, miny, maxx, maxy )   // in CreateRegions()
//   call TriggerRegisterEnterRectSimple( gg_trg_Bar, gg_rct_Foo )
// so a rect must carry real bounds for the live pump (Interpreter.pumpRegions) to
// test a unit's position against. Regions are sets of rects; locations are (x,y)
// points many BJs pass around (RectFromLoc, CreateUnitAtLoc, …).

import type { NativeCtx, RectObj, RegionObj, Runtime } from "../runtime";
import { asNum, jHandle, JNULL, jReal, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

interface LocationObj {
  handleId: number;
  x: number;
  y: number;
}

const rect = (c: NativeCtx, v: JassValue): RectObj | undefined => c.rt.data<RectObj>(v);
const region = (c: NativeCtx, v: JassValue): RegionObj | undefined => c.rt.data<RegionObj>(v);
const loc = (c: NativeCtx, v: JassValue): LocationObj | undefined => c.rt.data<LocationObj>(v);

function makeRect(rt: Runtime, minx: number, miny: number, maxx: number, maxy: number): JassValue {
  // Normalise so min<=max even if a script passes them swapped.
  const r: RectObj = { handleId: 0, minx: Math.min(minx, maxx), miny: Math.min(miny, maxy), maxx: Math.max(minx, maxx), maxy: Math.max(miny, maxy) };
  r.handleId = rt.handles.alloc(r);
  return jHandle(r.handleId, "rect");
}

export function registerRegionNatives(rt: Runtime): void {
  // --- rects ---
  def(rt, "Rect", (c, a) => makeRect(c.rt, asNum(a[0]), asNum(a[1]), asNum(a[2]), asNum(a[3])));
  def(rt, "RectFromLoc", (c, a) => {
    const min = loc(c, a[0]), max = loc(c, a[1]);
    return makeRect(c.rt, min?.x ?? 0, min?.y ?? 0, max?.x ?? 0, max?.y ?? 0);
  });
  def(rt, "RemoveRect", (c, a) => (a[0].k === "handle" && c.rt.handles.free(a[0].h), JNULL));
  def(rt, "SetRect", (c, a) => {
    const r = rect(c, a[0]);
    if (r) {
      r.minx = Math.min(asNum(a[1]), asNum(a[3]));
      r.miny = Math.min(asNum(a[2]), asNum(a[4]));
      r.maxx = Math.max(asNum(a[1]), asNum(a[3]));
      r.maxy = Math.max(asNum(a[2]), asNum(a[4]));
    }
    return JNULL;
  });
  const moveRectTo = (r: RectObj | undefined, cx: number, cy: number): void => {
    if (!r) return;
    const hw = (r.maxx - r.minx) / 2, hh = (r.maxy - r.miny) / 2;
    r.minx = cx - hw;
    r.maxx = cx + hw;
    r.miny = cy - hh;
    r.maxy = cy + hh;
  };
  def(rt, "MoveRectTo", (c, a) => (moveRectTo(rect(c, a[0]), asNum(a[1]), asNum(a[2])), JNULL));
  def(rt, "MoveRectToLoc", (c, a) => {
    const l = loc(c, a[1]);
    moveRectTo(rect(c, a[0]), l?.x ?? 0, l?.y ?? 0);
    return JNULL;
  });
  def(rt, "GetRectMinX", (c, a) => jReal(rect(c, a[0])?.minx ?? 0));
  def(rt, "GetRectMinY", (c, a) => jReal(rect(c, a[0])?.miny ?? 0));
  def(rt, "GetRectMaxX", (c, a) => jReal(rect(c, a[0])?.maxx ?? 0));
  def(rt, "GetRectMaxY", (c, a) => jReal(rect(c, a[0])?.maxy ?? 0));
  def(rt, "GetRectCenterX", (c, a) => { const r = rect(c, a[0]); return jReal(r ? (r.minx + r.maxx) / 2 : 0); });
  def(rt, "GetRectCenterY", (c, a) => { const r = rect(c, a[0]); return jReal(r ? (r.miny + r.maxy) / 2 : 0); });

  // --- regions (sets of rects) ---
  def(rt, "CreateRegion", (c) => {
    const rg: RegionObj = { handleId: 0, rects: [] };
    rg.handleId = c.rt.handles.alloc(rg);
    return jHandle(rg.handleId, "region");
  });
  def(rt, "RemoveRegion", (c, a) => (a[0].k === "handle" && c.rt.handles.free(a[0].h), JNULL));
  def(rt, "RegionAddRect", (c, a) => {
    const rg = region(c, a[0]);
    if (rg && a[1].k === "handle" && !rg.rects.includes(a[1].h)) rg.rects.push(a[1].h);
    return JNULL;
  });
  def(rt, "RegionClearRect", (c, a) => {
    const rg = region(c, a[0]);
    if (rg && a[1].k === "handle") {
      const h = a[1].h;
      rg.rects = rg.rects.filter((x) => x !== h);
    }
    return JNULL;
  });
  // Cell adds: model each 128×128 WC3 cell as a small rect so containment still works.
  def(rt, "RegionAddCell", (c, a) => {
    const rg = region(c, a[0]);
    if (rg) {
      const cx = asNum(a[1]), cy = asNum(a[2]);
      const r = c.rt.data<RectObj>(makeRect(c.rt, cx - 64, cy - 64, cx + 64, cy + 64));
      if (r) rg.rects.push(r.handleId);
    }
    return JNULL;
  });

  // --- locations (x,y points) ---
  def(rt, "Location", (c, a) => {
    const l: LocationObj = { handleId: 0, x: asNum(a[0]), y: asNum(a[1]) };
    l.handleId = c.rt.handles.alloc(l);
    return jHandle(l.handleId, "location");
  });
  def(rt, "RemoveLocation", (c, a) => (a[0].k === "handle" && c.rt.handles.free(a[0].h), JNULL));
  def(rt, "MoveLocation", (c, a) => {
    const l = loc(c, a[0]);
    if (l) {
      l.x = asNum(a[1]);
      l.y = asNum(a[2]);
    }
    return JNULL;
  });
  // The map's start locations, as a location (config() recorded them via
  // DefineStartLocation) — "spawn a wave at Player N's start" leans on this.
  def(rt, "GetStartLocationLoc", (c, a) => {
    const s = c.rt.setup.startLocations.get(asNum(a[0]));
    const l: LocationObj = { handleId: 0, x: s?.x ?? 0, y: s?.y ?? 0 };
    l.handleId = c.rt.handles.alloc(l);
    return jHandle(l.handleId, "location");
  });
  def(rt, "GetStartLocationX", (c, a) => jReal(c.rt.setup.startLocations.get(asNum(a[0]))?.x ?? 0));
  def(rt, "GetStartLocationY", (c, a) => jReal(c.rt.setup.startLocations.get(asNum(a[0]))?.y ?? 0));

  def(rt, "GetLocationX", (c, a) => jReal(loc(c, a[0])?.x ?? 0));
  def(rt, "GetLocationY", (c, a) => jReal(loc(c, a[0])?.y ?? 0));
  def(rt, "GetLocationZ", () => jReal(0)); // terrain height — needs the sim; 0 for now
}
