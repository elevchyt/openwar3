// Cinematic natives (7.24 — issue #33; see docs/triggers.md).
//
// The other half of a cinematic: the letterbox, the fade, and the talking head. The camera
// (natives/camera.ts) moves the shot; this file is everything the player SEES around it.
//
// **Do not register a `…BJ` name here.** `CinematicModeBJ` is a blizzard.j FUNCTION, not a
// native, and the interpreter resolves natives BEFORE user functions — so defining one would
// silently shadow Blizzard's own code and swallow the whole family. Implement the natives
// underneath and let the real BJ run. `CinematicModeExBJ` IS the specification, and it reads
// as a checklist of exactly those natives:
//
//     call ClearTextMessages()                 // 7.6
//     call ShowInterface(false, interfaceFadeTime)   ─┐ this file
//     call EnableUserControl(false)                   │
//     call EnableOcclusion(false)                    ─┘
//     call SetCineModeVolumeGroupsBJ()         // 7.20 — the 8 volume groups duck
//     call SetGameSpeed(bj_CINEMODE_GAMESPEED) ─┐
//     call SetMapFlag(MAP_LOCK_SPEED, true)     │ this file
//     call FogMaskEnable(false) / FogEnable(false)   // 7.22
//     call EnableWorldFogBoundary(false)        │
//     call EnableDawnDusk(false)               ─┘
//     call SetRandomSeed(0)                    // runtime.setRandomSeed — really re-seeds
//
// …and on the way out restores each one from the value it SAVED on the way in
// (bj_cineModePriorSpeed / PriorFogSetting / PriorMaskSetting / PriorDawnDusk). That is why
// the getters below — GetGameSpeed, IsFogEnabled, IsFogMaskEnabled, IsDawnDuskEnabled — have
// to answer honestly rather than return a stub: a lying getter doesn't break the cinematic,
// it breaks the GAME the cinematic hands back.
//
// The panel itself is the game's own — `UI\FrameDef\UI\CinematicPanel.fdf`, sitting right
// beside the LeaderBoard/MultiBoard/TimerDialog FDFs we already mount (src/ui/cinematicPanel.ts).

import type { CinematicScene, NativeCtx, Runtime } from "../runtime";
import { intToRawcode } from "../lexer";
import { asInt, asNum, asStr, jBool, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

export function registerCinematicNatives(rt: Runtime): void {
  // --- cinematic mode: what CinematicModeExBJ actually switches ----------------------
  // ShowInterface(false, fade) is the letterbox: the console fades out and the black bars
  // slide in over `fadeDuration` seconds (bj_CINEMODE_INTERFACEFADE = 0.5).
  def(rt, "ShowInterface", (c, a) => (c.rt.hooks?.showInterface?.(truthy(a[0]), asNum(a[1])), JNULL));
  def(rt, "EnableUserControl", (c, a) => (c.rt.hooks?.enableUserControl?.(truthy(a[0])), JNULL));
  def(rt, "EnableDawnDusk", (c, a) => (c.rt.hooks?.setDawnDusk?.(truthy(a[0])), JNULL));
  def(rt, "IsDawnDuskEnabled", (c) => jBool(c.rt.hooks?.isDawnDuskEnabled?.() ?? true));
  def(rt, "SetGameSpeed", (c, a) => (c.rt.hooks?.setGameSpeed?.(c.rt.enumIndex(a[0])), JNULL));
  def(rt, "GetGameSpeed", (c) => c.rt.enumHandle("GameSpeed", c.rt.hooks?.getGameSpeed?.() ?? 2));
  def(rt, "SetRandomSeed", (c, a) => (c.rt.setRandomSeed(asInt(a[0])), JNULL));
  // EnableOcclusion draws the "unit behind a cliff" x-ray silhouettes and EnableWorldFogBoundary
  // the black wall at the map edge — two things we don't render at all. Explicit no-ops: the
  // behaviour is identical to an unimplemented native, but it says so out loud and keeps the
  // cinematic path free of "not implemented" noise.
  def(rt, "EnableOcclusion", () => JNULL);
  def(rt, "EnableWorldFogBoundary", () => JNULL);
  // ForceCinematicSubtitles(true) forces subtitles on even when the player has them off in
  // Options. We have no such option — subtitles always show — so this is already true.
  def(rt, "ForceCinematicSubtitles", () => JNULL);

  // --- the fade (the cinematic filter) -------------------------------------------------
  // The filter is configured across SEVEN natives and only COMMITTED by DisplayCineFilter —
  // so it is one live object the script mutates (rt.cineFilter), exactly like a `sound`
  // (7.20), not a push per setter. blizzard.j's CinematicFadeCommonBJ writes all of it first:
  //
  //     call SetCineFilterTexture(tex) / BlendMode / TexMapFlags / StartUV / EndUV
  //     call SetCineFilterStartColor(…, PercentTo255(100-startTrans))
  //     call SetCineFilterEndColor  (…, PercentTo255(100-endTrans))
  //     call SetCineFilterDuration(duration)
  //     call DisplayCineFilter(true)
  //
  // A fade OUT is therefore alpha 0 → 255 (startTrans 100 → endTrans 0) and a fade IN the
  // reverse: the "transparency" the GUI asks for is the INVERSE of the alpha we draw.
  const filter = (c: NativeCtx) => c.rt.cineFilter;
  def(rt, "SetCineFilterTexture", (c, a) => ((filter(c).texture = asStr(a[0])), JNULL));
  def(rt, "SetCineFilterBlendMode", (c, a) => ((filter(c).blendMode = c.rt.enumIndex(a[0])), JNULL));
  def(rt, "SetCineFilterDuration", (c, a) => ((filter(c).duration = asNum(a[0])), JNULL));
  def(rt, "SetCineFilterStartColor", (c, a) => {
    filter(c).start = { r: asInt(a[0]), g: asInt(a[1]), b: asInt(a[2]), a: asInt(a[3]) };
    return JNULL;
  });
  def(rt, "SetCineFilterEndColor", (c, a) => {
    filter(c).end = { r: asInt(a[0]), g: asInt(a[1]), b: asInt(a[2]), a: asInt(a[3]) };
    return JNULL;
  });
  // The UV rect and the texture-map flags matter only for a filter that SCROLLS its texture
  // (a campaign dream-sequence ripple). Every fade in the bundled corpus passes the whole
  // (0,0)–(1,1) rect and TEXMAP_FLAG_NONE, so we accept and ignore them rather than pretend.
  def(rt, "SetCineFilterStartUV", () => JNULL);
  def(rt, "SetCineFilterEndUV", () => JNULL);
  def(rt, "SetCineFilterTexMapFlags", () => JNULL);
  def(rt, "DisplayCineFilter", (c, a) => {
    const f = filter(c);
    f.displayed = truthy(a[0]);
    // A committed filter is a SNAPSHOT — the script is free to reconfigure the live one for
    // the next fade the moment this one is on screen (CinematicFadeBJ's fade-out-then-in does
    // exactly that, from a timer), and that must not rewrite the fade already running.
    c.rt.hooks?.displayCineFilter?.(
      f.displayed
        ? { texture: f.texture, blendMode: f.blendMode, start: { ...f.start }, end: { ...f.end }, duration: f.duration }
        : null,
    );
    return JNULL;
  });
  def(rt, "IsCineFilterDisplayed", (c) => jBool(filter(c).displayed));

  // --- the transmission (the cinematic scene) ------------------------------------------
  // SetCinematicScene(portraitUnitId, color, speakerTitle, text, sceneDuration, voiceoverDuration).
  // The unit id is a rawcode INTEGER of the unit TYPE — a transmission shows the speaker's
  // portrait model, not the speaker. 0 means "no portrait" (DoTransmissionBasicsXYBJ passes 0
  // when the speaking unit is null, and skips the minimap ping too).
  def(rt, "SetCinematicScene", (c, a) => {
    const typeId = asInt(a[0]);
    const scene: CinematicScene = {
      portraitUnitId: typeId === 0 ? "" : intToRawcode(typeId),
      playerColor: c.rt.enumIndex(a[1]),
      speaker: asStr(a[2]),
      text: asStr(a[3]),
      sceneDuration: asNum(a[4]),
      voiceoverDuration: asNum(a[5]),
    };
    c.rt.hooks?.setCinematicScene?.(scene);
    return JNULL;
  });
  def(rt, "EndCinematicScene", (c) => (c.rt.hooks?.setCinematicScene?.(null), JNULL));

  // --- minimap pings --------------------------------------------------------------------
  // The plain PingMinimap is WC3 yellow-white; PingMinimapEx carries a colour and the
  // "extraEffects" flag, which is the flashy (bouncing-arrow) ping. blizzard.j's
  // PingMinimapForForceEx converts its 0–100 percentages with PercentTo255 first, and
  // refuses a pure-red flashy ping (that colour is reserved for the "under attack" ping).
  def(rt, "PingMinimap", (c, a) => {
    c.rt.hooks?.pingMinimap?.({ x: asNum(a[0]), y: asNum(a[1]), duration: asNum(a[2]), r: 255, g: 255, b: 60, extraEffects: false });
    return JNULL;
  });
  def(rt, "PingMinimapEx", (c, a) => {
    c.rt.hooks?.pingMinimap?.({
      x: asNum(a[0]),
      y: asNum(a[1]),
      duration: asNum(a[2]),
      r: asInt(a[3]),
      g: asInt(a[4]),
      b: asInt(a[5]),
      extraEffects: truthy(a[6]),
    });
    return JNULL;
  });

  // PlayCinematic/PlayModelCinematic play a prerendered .avi / a full-screen model — the
  // campaign's between-mission movies. Nothing a melee or scenario map uses, and nothing we
  // render: explicit no-ops.
  def(rt, "PlayCinematic", () => JNULL);
  def(rt, "PlayModelCinematic", () => JNULL);
}
