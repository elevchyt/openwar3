// Weather natives (7.23 — issue #33; see docs/triggers.md).
//
// The map's atmosphere. Small surface, big reach: **40 of the 165 bundled maps** call these,
// mostly plain MELEE maps, because the World Editor compiles a placed "weather effect"
// region straight into the map's own script —
//
//     set we = AddWeatherEffect( gg_rct_Region_000, 'SNls' )   // (6)UpperKingdom, verbatim
//     call EnableWeatherEffect( we, true )
//
// — inside `CreateRegions()`. All three natives were explicit no-ops, so 40 maps have been
// running with their rain, snow and fog silently switched off.
//
// The effect itself is a data-driven particle emitter (`TerrainArt\Weather.slk` →
// src/data/weather.ts, drawn by src/render/weather.ts); these natives only create, switch
// and destroy one.
//
// Note the shape, which is the same one the fog modifiers had in 7.22: **`AddWeatherEffect`
// does not start the effect.** The editor emits `EnableWeatherEffect(we, true)` on the very
// next line, which would be pointless if it did — so a created effect sits inert until it is
// enabled.

import type { NativeCtx, Runtime } from "../runtime";
import { asInt, jHandle, JNULL, truthy, type JassValue } from "../values";
import { intToRawcode } from "../lexer";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A `weathereffect` handle — the engine's id for the effect it created. */
interface WeatherObj {
  handleId: number;
  engineId: number;
}

/** A rect handle, as natives/region.ts stores it. */
interface RectObj {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export function registerWeatherNatives(rt: Runtime): void {
  // common.j: `native AddWeatherEffect takes rect where, integer effectID returns weathereffect`
  // — the effectID is a RAWCODE integer ('SNls'), which is the key into Weather.slk.
  def(rt, "AddWeatherEffect", (c, a) => {
    const r = c.rt.data<RectObj>(a[0]);
    if (!r) return JNULL;
    const id = c.rt.hooks?.addWeatherEffect?.(intToRawcode(asInt(a[1])), {
      minX: r.minx,
      minY: r.miny,
      maxX: r.maxx,
      maxY: r.maxy,
    }) ?? -1;
    if (id < 0) return JNULL; // unknown weather id, or no engine attached (headless)
    const w: WeatherObj = { handleId: 0, engineId: id };
    w.handleId = c.rt.handles.alloc(w);
    return jHandle(w.handleId, "weathereffect");
  });
  def(rt, "EnableWeatherEffect", (c, a) => {
    const w = c.rt.data<WeatherObj>(a[0]);
    if (w) c.rt.hooks?.enableWeatherEffect?.(w.engineId, truthy(a[1]));
    return JNULL;
  });
  def(rt, "RemoveWeatherEffect", (c, a) => {
    const w = c.rt.data<WeatherObj>(a[0]);
    if (w) c.rt.hooks?.removeWeatherEffect?.(w.engineId);
    return JNULL;
  });
  // TerrainDeformation* sculpt the terrain MESH itself (a Thunder Clap crater, a ripple) —
  // the other "environment effect" family, and a genuinely different system from weather. We
  // don't deform terrain, so they are explicit no-ops here rather than unimplemented natives:
  // same behaviour, no log noise, and it documents what we deliberately don't model.
  for (const name of [
    "TerrainDeformCrater", "TerrainDeformRipple", "TerrainDeformWave", "TerrainDeformRandom",
    "TerrainDeformStop", "TerrainDeformStopAll",
  ]) {
    if (!rt.natives.has(name)) def(rt, name, () => JNULL);
  }
}
