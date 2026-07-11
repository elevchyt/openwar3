// Native registry (Phase 7 — issue #33; see docs/triggers.md).
//
// Registers every JS-implemented native into the runtime. Grouped by subsystem
// (config/player, world bring-up, plus the enum constructors, trigger core, and
// cheap utility natives here). An UNimplemented native is not an error — the
// interpreter falls back to a typed default from the native's common.j return type
// (CLAUDE.md "never hard-crash the map"). Grow coverage with tools/native-coverage.mjs.

import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jInt, jReal, jStr, JNULL, type JassValue } from "../values";
import { registerConfigNatives } from "./config";
import { registerEventNatives } from "./events";
import { registerForceNatives } from "./forces";
import { registerRegionNatives } from "./region";
import { registerTextNatives } from "./text";
import { registerWorldNatives } from "./world";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

// Every `native ConvertX(...)` in common.j wraps an integer into a typed handle
// (playercolor, race, mapcontrol, gametype, …). We model each as an interned enum
// handle keyed by (kind, index), so JASS `==` on two of the same constant is true.
const CONVERT_NATIVES = [
  "ConvertAIDifficulty", "ConvertAllianceType", "ConvertAttackType", "ConvertBlendMode",
  "ConvertCameraField", "ConvertDamageType", "ConvertDialogEvent", "ConvertEffectType",
  "ConvertFGameState", "ConvertFogState", "ConvertGameDifficulty", "ConvertGameEvent",
  "ConvertGameSpeed", "ConvertGameType", "ConvertIGameState", "ConvertItemType",
  "ConvertLimitOp", "ConvertMapControl", "ConvertMapDensity", "ConvertMapFlag",
  "ConvertMapSetting", "ConvertMapVisibility", "ConvertPathingType", "ConvertPlacement",
  "ConvertPlayerColor", "ConvertPlayerEvent", "ConvertPlayerGameResult", "ConvertPlayerScore",
  "ConvertPlayerSlotState", "ConvertPlayerState", "ConvertPlayerUnitEvent", "ConvertRace",
  "ConvertRacePref", "ConvertRarityControl", "ConvertSoundType", "ConvertStartLocPrio",
  "ConvertTexMapFlags", "ConvertUnitEvent", "ConvertUnitState", "ConvertUnitType",
  "ConvertVersion", "ConvertVolumeGroup", "ConvertWeaponType", "ConvertWidgetEvent",
];

/** Cheap, pure utility natives (string/number conversions, RNG, camera/env
 *  no-ops). Safe to run anywhere; they make blizzard.j run more faithfully and cut
 *  down "safe default" log noise. */
function registerUtilNatives(rt: Runtime): void {
  def(rt, "I2S", (_c, a) => jStr(String(asInt(a[0]))));
  def(rt, "R2S", (_c, a) => jStr(asNum(a[0]).toFixed(3)));
  def(rt, "R2SW", (_c, a) => jStr(asNum(a[0]).toFixed(Math.max(0, asInt(a[2])))));
  def(rt, "I2R", (_c, a) => jReal(asInt(a[0])));
  def(rt, "R2I", (_c, a) => jInt(Math.trunc(asNum(a[0]))));
  def(rt, "S2I", (_c, a) => jInt(parseInt(asStr(a[0]), 10) || 0));
  def(rt, "S2R", (_c, a) => jReal(parseFloat(asStr(a[0])) || 0));
  def(rt, "SubString", (_c, a) => jStr(asStr(a[0]).substring(asInt(a[1]), asInt(a[2]))));
  def(rt, "StringLength", (_c, a) => jInt(asStr(a[0]).length));
  def(rt, "StringCase", (_c, a) => jStr(a[1].k === "bool" && a[1].b ? asStr(a[0]).toUpperCase() : asStr(a[0]).toLowerCase()));
  // StringHash lives in natives/text.ts (a real 32-bit hash, not a 0 stub).
  def(rt, "GetHandleId", (_c, a) => jInt(a[0].k === "handle" ? a[0].h : 0));
  def(rt, "GetRandomInt", (c, a) => {
    const lo = asInt(a[0]), hi = asInt(a[1]);
    return jInt(hi < lo ? lo : lo + Math.floor(c.rt.random() * (hi - lo + 1)));
  });
  def(rt, "GetRandomReal", (c, a) => {
    const lo = asNum(a[0]), hi = asNum(a[1]);
    return jReal(lo + c.rt.random() * (hi - lo));
  });
  def(rt, "SetRandomSeed", () => JNULL);

  // Camera / environment natives every main() calls — we set these up ourselves in
  // the renderer, so here they are safe no-ops (GetCameraMargin returns 0.0).
  def(rt, "GetCameraMargin", () => jReal(0));
  for (const name of [
    "SetCameraBounds", "SetDayNightModels", "NewSoundEnvironment", "SetAmbientDaySound",
    "SetAmbientNightSound", "SetMapMusic", "PlayMusic", "SetMapFlag", "StartSound",
    "StopSound", "SetMapName", "EnableWeatherEffect", "AddWeatherEffect",
  ]) {
    if (!rt.natives.has(name)) def(rt, name, () => JNULL);
  }
}

/** Register the whole implemented native surface into a fresh runtime. */
export function registerNatives(rt: Runtime): void {
  for (const name of CONVERT_NATIVES) {
    const kind = name.slice("Convert".length);
    def(rt, name, (c, a) => c.rt.enumHandle(kind, asInt(a[0])));
  }
  registerConfigNatives(rt);
  registerWorldNatives(rt);
  registerEventNatives(rt);
  registerForceNatives(rt);
  registerRegionNatives(rt);
  registerTextNatives(rt); // after config: its real SetPlayerName overrides config's setup stub
  registerUtilNatives(rt);
}
