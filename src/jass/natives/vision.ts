// Vision + fog natives (7.22 — issue #33; see docs/triggers.md).
//
// Three families that all answer "what can a player SEE", plus one that only sounds
// like it belongs here. Keeping them in one file is deliberate: the thing most likely
// to go wrong with this surface is confusing the two fogs.
//
//  1. ALLIANCES — SetPlayerAlliance / GetPlayerAlliance / CripplePlayer. A directed
//     per-pair matrix (see src/sim/alliances.ts). ALLIANCE_SHARED_VISION is what lends
//     one player another's sight; ALLIANCE_PASSIVE is what stops them shooting. The
//     whole GUI "Player - Make X treat Y as an Ally" family is blizzard.j code
//     (SetPlayerAllianceStateBJ) riding on the single native, so implementing it
//     implements all eight bj_ALLIANCE_* states for free.
//
//  2. FOG OF WAR — CreateFogModifier* / FogModifierStart|Stop / DestroyFogModifier /
//     SetFogState* / FogEnable / FogMaskEnable. A script-placed area held at
//     FOG_OF_WAR_MASKED (black) / _FOGGED (grey) / _VISIBLE (lit) for one player.
//     This is our VisionMap.
//
//  3. TERRAIN FOG — SetTerrainFogEx / ResetTerrainFog. NOT the fog of war at all: the
//     atmospheric distance haze the terrain fades into, which is `scene.distFog`
//     (src/render/fog.ts) and is otherwise driven from the map's w3i. A map that calls
//     SetTerrainFogEx is re-tinting its horizon, not revealing anything.
//
// The one thing every fog-modifier snippet in the wild gets right and a naive reading
// of common.j does not: **CreateFogModifier* does NOT start the modifier.** It hands
// back a stopped one and `FogModifierStart` runs it — which is why blizzard.j's BJ has
// to do both:
//
//   function CreateFogModifierRectBJ takes boolean enabled, player whichPlayer, fogstate whichFogState, rect r returns fogmodifier
//       set bj_lastCreatedFogModifier = CreateFogModifierRect(whichPlayer, whichFogState, r, true, false)
//       if enabled then
//           call FogModifierStart(bj_lastCreatedFogModifier)
//       endif
//       return bj_lastCreatedFogModifier
//   endfunction
//
// (Same shape as CreateTimerDialogBJ in 7.21: the BJ shows it, the native doesn't.)

import type { JassFogArea, JassPlayer, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, jBool, jHandle, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const playerIndex = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? asInt(v);

/** A `fogmodifier` handle — the id the engine bridge gave it, so Start/Stop/Destroy
 *  can find it again. */
interface FogModifierObj {
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

const rectArea = (c: NativeCtx, v: JassValue): JassFogArea | null => {
  const r = c.rt.data<RectObj>(v);
  return r ? { kind: "rect", minX: r.minx, minY: r.miny, maxX: r.maxx, maxY: r.maxy } : null;
};
const circleArea = (x: number, y: number, radius: number): JassFogArea => ({ kind: "circle", x, y, radius });
const locArea = (c: NativeCtx, v: JassValue, radius: number): JassFogArea => {
  const loc = c.rt.data<{ x: number; y: number }>(v);
  return circleArea(loc?.x ?? 0, loc?.y ?? 0, radius);
};

/** Create + intern a fogmodifier handle around the engine's id. */
function makeFogModifier(c: NativeCtx, player: number, state: number, area: JassFogArea | null): JassValue {
  if (!area) return JNULL;
  const engineId = c.rt.hooks?.createFogModifier?.(player, state, area) ?? -1;
  const m: FogModifierObj = { handleId: 0, engineId };
  m.handleId = c.rt.handles.alloc(m);
  return jHandle(m.handleId, "fogmodifier");
}

export function registerVisionNatives(rt: Runtime): void {
  // --- alliances -----------------------------------------------------------
  // NOTE the argument order — SetPlayerAlliance is (source, other, setting, value) but
  // the BJ that fronts it, SetPlayerAllianceBJ, is (source, SETTING, VALUE, other). The
  // BJ is blizzard.j's, so it re-orders for us; only the native's order matters here.
  def(rt, "SetPlayerAlliance", (c, a) => {
    c.rt.hooks?.setPlayerAlliance?.(playerIndex(c, a[0]), playerIndex(c, a[1]), c.rt.enumIndex(a[2]), truthy(a[3]));
    return JNULL;
  });
  def(rt, "GetPlayerAlliance", (c, a) =>
    jBool(c.rt.hooks?.getPlayerAlliance?.(playerIndex(c, a[0]), playerIndex(c, a[1]), c.rt.enumIndex(a[2])) ?? false),
  );
  // CripplePlayer(whichPlayer, toWhichPlayers, flag) — reveal a player's units to a
  // force. MeleeExposePlayer calls it TWICE: once with an empty force and `false` to
  // clear any previous exposure, then with the force of every non-co-allied player and
  // the real flag. So an empty-force call must be honoured, not skipped as a no-op.
  def(rt, "CripplePlayer", (c, a) => {
    const f = c.rt.data<{ players: Set<number> }>(a[1]);
    c.rt.hooks?.cripplePlayer?.(playerIndex(c, a[0]), [...(f?.players ?? [])], truthy(a[2]));
    return JNULL;
  });

  // --- fog of war: modifiers -----------------------------------------------
  // `useSharedVision` (and `afterUnits`) are engine render-ordering details we don't
  // model — our modifiers are stamped over the units' own vision every rebuild, which is
  // the behaviour `afterUnits = true` describes anyway.
  def(rt, "CreateFogModifierRect", (c, a) =>
    makeFogModifier(c, playerIndex(c, a[0]), c.rt.enumIndex(a[1]), rectArea(c, a[2])),
  );
  def(rt, "CreateFogModifierRadius", (c, a) =>
    makeFogModifier(c, playerIndex(c, a[0]), c.rt.enumIndex(a[1]), circleArea(asNum(a[2]), asNum(a[3]), asNum(a[4]))),
  );
  def(rt, "CreateFogModifierRadiusLoc", (c, a) =>
    makeFogModifier(c, playerIndex(c, a[0]), c.rt.enumIndex(a[1]), locArea(c, a[2], asNum(a[3]))),
  );
  const modifier = (c: NativeCtx, v: JassValue): FogModifierObj | undefined => c.rt.data<FogModifierObj>(v);
  def(rt, "FogModifierStart", (c, a) => {
    const m = modifier(c, a[0]);
    if (m) c.rt.hooks?.fogModifierStart?.(m.engineId);
    return JNULL;
  });
  def(rt, "FogModifierStop", (c, a) => {
    const m = modifier(c, a[0]);
    if (m) c.rt.hooks?.fogModifierStop?.(m.engineId);
    return JNULL;
  });
  def(rt, "DestroyFogModifier", (c, a) => {
    const m = modifier(c, a[0]);
    if (m) c.rt.hooks?.destroyFogModifier?.(m.engineId);
    return JNULL;
  });

  // --- fog of war: one-shot state changes + the global switches ---------------
  def(rt, "SetFogStateRect", (c, a) => {
    const area = rectArea(c, a[2]);
    if (area) c.rt.hooks?.setFogState?.(playerIndex(c, a[0]), c.rt.enumIndex(a[1]), area);
    return JNULL;
  });
  def(rt, "SetFogStateRadius", (c, a) => {
    c.rt.hooks?.setFogState?.(
      playerIndex(c, a[0]), c.rt.enumIndex(a[1]),
      circleArea(asNum(a[2]), asNum(a[3]), asNum(a[4])),
    );
    return JNULL;
  });
  def(rt, "SetFogStateRadiusLoc", (c, a) => {
    c.rt.hooks?.setFogState?.(playerIndex(c, a[0]), c.rt.enumIndex(a[1]), locArea(c, a[2], asNum(a[3])));
    return JNULL;
  });
  def(rt, "FogEnable", (c, a) => (c.rt.hooks?.fogEnable?.(truthy(a[0])), JNULL));
  def(rt, "FogMaskEnable", (c, a) => (c.rt.hooks?.fogMaskEnable?.(truthy(a[0])), JNULL));
  // IsFogEnabled/IsFogMaskEnabled report the *map's* fog settings (the w3i flags), which
  // we always honour — so both are true.
  def(rt, "IsFogEnabled", () => jBool(true));
  def(rt, "IsFogMaskEnabled", () => jBool(true));

  // --- terrain fog (the atmospheric haze — NOT the fog of war) ----------------
  // SetTerrainFogEx(style, zstart, zend, density, red, green, blue), rgb in 0–1. The
  // GUI's SetTerrainFogExBJ takes 0–100 and multiplies by 0.01 before calling this, so
  // the native is the 0–1 form and a hand-written script passes 0–1 directly.
  //
  // `style` is the fog falloff: 0 linear, 1 exponential, 2 exponential-squared. Our
  // shader (src/render/fog.ts + the mdx-m3-viewer patch) is LINEAR, which turns out to
  // be exactly enough: every one of the 12 SetTerrainFogEx calls across the 165 bundled
  // maps passes style 0. (`density` only bites on the exponential styles, so a linear
  // fog ignores it — which is why the corpus happily passes anything from 0.0 to 16.9.)
  def(rt, "SetTerrainFogEx", (c, a) => {
    c.rt.hooks?.setTerrainFog?.(
      asInt(a[0]), asNum(a[1]), asNum(a[2]), asNum(a[3]), asNum(a[4]), asNum(a[5]), asNum(a[6]),
    );
    return JNULL;
  });
  def(rt, "ResetTerrainFog", (c) => (c.rt.hooks?.resetTerrainFog?.(), JNULL));
  // `native SetTerrainFog takes real a, real b, real c, real d, real e returns nothing`
  // — Blizzard did not even name its five parameters in common.j, no reference documents
  // them, and NO map in the 165-map corpus calls it. Rather than guess a mapping onto our
  // fog and silently mis-tint someone's horizon, it stays an explicit no-op (CLAUDE.md:
  // don't invent values). SetTerrainFogEx is the one maps actually use.
  def(rt, "SetTerrainFog", () => JNULL);
}
