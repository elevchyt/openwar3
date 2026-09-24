// What a script paints on the WORLD rather than on a unit (docs/map-compatibility.md pass 10):
// ubersplats, images, the terrain's tiles and the water's tint. All of them are in the install's own
// 1.30.4 common.j (lines 2071, 2434, 2445-2465), and the documentation for each is one page
// of lep.nrw/jassbot, quoted where it decides something.
//
// UBERSPLATS (`CreateUbersplat`, 11 call sites in DotA) are the SAME decals a Thunder Clap
// scorches and a building stands on — a row of `Splats\UberSplatData.slk` with its own
// Birth → Pause → Decay colour envelope. `forcePaused` holds it in the pause phase until the
// script destroys it; `noBirthTime` starts it there. `SetUbersplatRenderAlways(true)` lifts
// the fog rule: a spell's splat "created in fog … is also invisible to you" (hiveworkshop
// 235035), and DotA sets the flag only when the caster is visible to the local player.
// `ResetUbersplat` and `FinishUbersplat` do nothing in the real game ("bug: Does nothing"),
// and are registered as exactly that.
//
// IMAGES (`CreateImage`) are a texture laid on the ground, `sizeX × sizeY`, with (posX, posY)
// its bottom-left corner moved by -origin. A new image is not drawn until BOTH
// `SetImageRenderAlways` and `ShowImage` say so — "SetImageRenderAlways, which has to be set to
// true in order for the image to actually be visible … ShowImage, which also has to be true"
// (hiveworkshop 235035) — and `SetImageRender` "does not work" (jassbot), so it is a no-op.
// imageType 0 "causes CreateImage to return image(-1)"; any other outside 1–4 is created but
// never shown.
//
// TERRAIN TILES (`GetTerrainType` / `GetTerrainVariance` / `SetTerrainType` — Bleach vs One
// Piece reaches the setter 20-odd times through SetTerrainTypeBJ). What an area and a shape
// cover, and what a -1 variation picks, is render/terrainBrush.ts. A tile the map's palette
// does not have is LOADED: "A texture is loaded if it is used in the map's tileset or the first
// time a trigger places it in the world", at most 16 (hiveworkshop 339901).
//
// THE SKY (`SetSkyModel`, "Environment - Set Sky") is a model drawn around the eye behind the
// world, "" (the GUI's `SkyModelNone`, its default) for none — render/sky.ts says how.
//
// Not here, for want of anything that says what they do: SetUbersplatRender (no documentation
// at all) and SetImageAboveWater ("doesn't seem to do much"). Neither is called in the corpus.

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jHandle, jInt, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

interface EngineObj {
  handleId: number;
  engineId: number;
}

/** Mint a handle for an engine id, or hand back null for a refusal (-1 / no engine). */
function mint(c: NativeCtx, engineId: number | undefined, type: string): JassValue {
  if (engineId === undefined || engineId < 0) return JNULL;
  const o: EngineObj = { handleId: 0, engineId };
  o.handleId = c.rt.handles.alloc(o);
  return jHandle(o.handleId, type);
}

const clamp255 = (v: JassValue | undefined): number => Math.max(0, Math.min(255, asInt(v ?? JNULL)));

export function registerImageryNatives(rt: Runtime): void {
  const obj = (c: NativeCtx, v: JassValue | undefined) => c.rt.data<EngineObj>(v ?? JNULL);
  /** A native acting on an existing handle: nothing for a null one. */
  const on = (name: string, fn: (c: NativeCtx, id: number, a: JassValue[]) => void): void =>
    def(rt, name, (c, a) => {
      const o = obj(c, a[0]);
      if (o) fn(c, o.engineId, a);
      return JNULL;
    });
  const destroy = (name: string, hook: (c: NativeCtx, id: number) => void): void =>
    def(rt, name, (c, a) => {
      const o = obj(c, a[0]);
      if (!o) return JNULL;
      hook(c, o.engineId);
      c.rt.handles.free(o.handleId);
      return JNULL;
    });

  // --- ubersplats ---
  def(rt, "CreateUbersplat", (c, a) =>
    mint(
      c,
      c.rt.hooks?.createUbersplat?.(asNum(a[0]), asNum(a[1]), asStr(a[2]), clamp255(a[3]), clamp255(a[4]), clamp255(a[5]), clamp255(a[6]), truthy(a[7]), truthy(a[8])),
      "ubersplat",
    ),
  );
  destroy("DestroyUbersplat", (c, id) => c.rt.hooks?.destroyUbersplat?.(id));
  on("ShowUbersplat", (c, id, a) => c.rt.hooks?.showUbersplat?.(id, truthy(a[1])));
  on("SetUbersplatRenderAlways", (c, id, a) => c.rt.hooks?.setUbersplatRenderAlways?.(id, truthy(a[1])));
  def(rt, "ResetUbersplat", () => JNULL); // "bug: Does nothing" (jassbot)
  def(rt, "FinishUbersplat", () => JNULL); // "bug: Does nothing" (jassbot)

  // --- images ---
  def(rt, "CreateImage", (c, a) => {
    const n = (i: number) => asNum(a[i]);
    const type = asInt(a[10]);
    if (type === 0) return JNULL; // "Using 0 causes CreateImage to return image(-1)"
    // sizeZ (a[3]) is carried by nothing we draw: an image lies on the ground.
    return mint(c, c.rt.hooks?.createImage?.(asStr(a[0]), n(1), n(2), n(4), n(5), n(6), n(7), n(8), n(9), type), "image");
  });
  destroy("DestroyImage", (c, id) => c.rt.hooks?.destroyImage?.(id));
  on("ShowImage", (c, id, a) => c.rt.hooks?.showImage?.(id, truthy(a[1])));
  on("SetImageRenderAlways", (c, id, a) => c.rt.hooks?.setImageRenderAlways?.(id, truthy(a[1])));
  def(rt, "SetImageRender", () => JNULL); // "bug: Does not work. Use SetImageRenderAlways instead."
  // "Valid values for all channels range from 0 to 255."
  on("SetImageColor", (c, id, a) => c.rt.hooks?.setImageColor?.(id, clamp255(a[1]), clamp255(a[2]), clamp255(a[3]), clamp255(a[4])));
  // "locks the Z position to the given height, if the flag is true … the only function thats
  // able to modify an images Z offset" (jassbot).
  on("SetImageConstantHeight", (c, id, a) => c.rt.hooks?.setImageConstantHeight?.(id, truthy(a[1]), asNum(a[2])));
  on("SetImagePosition", (c, id, a) => c.rt.hooks?.setImagePosition?.(id, asNum(a[1]), asNum(a[2])));
  on("SetImageType", (c, id, a) => c.rt.hooks?.setImageType?.(id, asInt(a[1])));

  // --- the terrain's tiles (render/terrainBrush.ts says what an area and a shape cover) ---
  def(rt, "GetTerrainType", (c, a) => {
    const tile = c.rt.hooks?.terrainTypeAt?.(asNum(a[0]), asNum(a[1])) ?? "";
    return jInt(tile ? rawcodeToInt(tile) : 0);
  });
  def(rt, "GetTerrainCliffLevel", (c, a) => jInt(c.rt.hooks?.terrainCliffLevel?.(asNum(a[0]), asNum(a[1])) ?? 0));
  def(rt, "GetTerrainVariance", (c, a) => jInt(c.rt.hooks?.terrainVarianceAt?.(asNum(a[0]), asNum(a[1])) ?? 0));
  def(rt, "SetTerrainType", (c, a) => {
    c.rt.hooks?.setTerrainType?.(asNum(a[0]), asNum(a[1]), intToRawcode(asInt(a[2])), asInt(a[3]), asInt(a[4]), asInt(a[5]));
    return JNULL;
  });

  // --- the sky ---
  def(rt, "SetSkyModel", (c, a) => {
    c.rt.hooks?.setSkyModel?.(asStr(a[0] ?? JNULL));
    return JNULL;
  });

  // --- the water ---
  // "0-255 … (value mod 256)" for every channel; "The default is 255 for all parameters."
  def(rt, "SetWaterBaseColor", (c, a) => {
    const m = (i: number) => asInt(a[i]) & 255;
    c.rt.hooks?.setWaterBaseColor?.(m(0), m(1), m(2), m(3));
    return JNULL;
  });
}
