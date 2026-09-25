// Native registry (Phase 7 — issue #33; see docs/triggers.md).
//
// Registers every JS-implemented native into the runtime. Grouped by subsystem
// (config/player, world bring-up, plus the enum constructors, trigger core, and
// cheap utility natives here). An UNimplemented native is not an error — the
// interpreter falls back to a typed default from the native's common.j return type
// (CLAUDE.md "never hard-crash the map"). Grow coverage with tools/native-coverage.mjs.

import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jInt, jReal, jStr, JNULL, type JassValue } from "../values";
import { registerAbilityNatives } from "./abilities";
import { registerCameraNatives } from "./camera";
import { registerCinematicNatives } from "./cinematic";
import { registerConfigNatives } from "./config";
import { registerDestructableNatives } from "./destructables";
import { registerDialogNatives } from "./dialogs";
import { registerEffectNatives } from "./effects";
import { registerLightningNatives } from "./lightning";
import { registerImageryNatives } from "./imagery";
import { registerEventNatives } from "./events";
import { registerLeaderboardNatives } from "./leaderboard";
import { registerForceNatives } from "./forces";
import { registerGameCacheNatives } from "./gamecache";
import { registerGroupNatives } from "./groups";
import { registerHashtableNatives } from "./hashtable";
// A NAMED SEAM into the compatibility layer (src/compat/README.md): the 1.31 frame API is
// declared by our own prelude and answered there, because none of it exists in 1.30.4.
import { registerFrameNatives } from "../../compat/frames";
import { registerFieldNatives } from "./blzFields";
import { registerItemNatives } from "./items";
import { registerMeleeNatives } from "./melee";
import { registerMultiboardNatives } from "./multiboard";
import { registerQuestNatives } from "./quests";
import { registerRegionNatives } from "./region";
import { registerSoundNatives } from "./sound";
import { registerStockNatives } from "./stock";
import { registerTextNatives } from "./text";
import { registerTimerDialogNatives } from "./timerdialog";
import { registerVisionNatives } from "./vision";
import { registerWeatherNatives } from "./weather";
import { registerPredicateNatives } from "./predicates";
import { registerUnitStatNatives } from "./unitStats";
import { registerAbilityBlzNatives } from "./abilityBlz";
import { registerAbilityFieldNatives } from "./abilityFields";
import { registerWidgetNatives } from "./widgets";
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
  // …and the three our own compat prelude declares, for the 1.31 frame API's enums
  // (src/compat/prelude.ts). Interned exactly like the rest, so `==` on two of the same
  // constant is true and a frame point can be told from a frame event. The four
  // `ConvertUnit*Field` families are NOT here: natives/blzFields.ts registers them beside the
  // table whose indices they carry.
  "ConvertOriginFrameType", "ConvertFramePointType", "ConvertFrameEventType",
  // …and the two the special-effect animation natives take (natives/effects.ts). Both are in
  // the install's own 1.30.4 common.j; without them every ANIM_TYPE_/SUBANIM_TYPE_ constant
  // was null and BlzPlaySpecialEffect could not be told which clip to play.
  "ConvertAnimType", "ConvertSubAnimType",
  // …and the mouse button (common.j 146; its three MOUSE_BUTTON_TYPE_ constants at 299-301 are
  // initialised by EVERY map's globals, so its absence was a "not implemented" line on each one).
  "ConvertMouseButtonType",
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
  // GetHandleId. A `Convert…` constant (an attack type, a damage type, a player state …) is not
  // an object with an id of its own in the game: its handle id IS the integer it was converted
  // from. Scripts lean on it — the Damage Engine both rebalance maps run reads
  // `GetHandleId(BlzGetEventAttackType())` and tests `== 0` for a spell and
  // `== udg_DAMAGE_TYPE_NORMAL` (which its own config sets to the literal 4) for "armour applies"
  // (Test of Balance, war3map.j 980–981 and 1170–1172). Answered with our interned id instead,
  // every blow read as a non-spell of no known type. Every other handle keeps its own id.
  def(rt, "GetHandleId", (c, a) => {
    if (a[0].k !== "handle") return jInt(0);
    const obj = c.rt.handles.get(a[0].h) as { constant?: boolean; index?: number } | undefined;
    return jInt(obj?.constant ? obj.index ?? 0 : a[0].h);
  });
  def(rt, "GetRandomInt", (c, a) => {
    const lo = asInt(a[0]), hi = asInt(a[1]);
    return jInt(hi < lo ? lo : lo + Math.floor(c.rt.random() * (hi - lo + 1)));
  });
  def(rt, "GetRandomReal", (c, a) => {
    const lo = asNum(a[0]), hi = asNum(a[1]);
    return jReal(lo + c.rt.random() * (hi - lo));
  });
  // SetRandomSeed lives in natives/cinematic.ts and really re-seeds the stream — cinematic
  // mode fixes the seed to 0 and restores it afterwards, so a no-op would break the map's
  // randomness contract, not just the cinematic's.

  // Math (common.j's MathAPI). Not decoration: blizzard.j's DistanceBetweenPoints —
  // which every "unit within X of point" GUI condition rides on — is
  // `SquareRoot(dx*dx + dy*dy)`, so without SquareRoot every distance in the BJ layer
  // measured 0. common.j's own rules: SquareRoot(x <= 0) = 0, Atan2(0,0) = 0,
  // Pow(x=0, y<0) = 0, and Asin/Acos return 0 outside [-1, 1].
  def(rt, "Deg2Rad", (_c, a) => jReal((asNum(a[0]) * Math.PI) / 180));
  def(rt, "Rad2Deg", (_c, a) => jReal((asNum(a[0]) * 180) / Math.PI));
  def(rt, "Sin", (_c, a) => jReal(Math.sin(asNum(a[0]))));
  def(rt, "Cos", (_c, a) => jReal(Math.cos(asNum(a[0]))));
  def(rt, "Tan", (_c, a) => jReal(Math.tan(asNum(a[0]))));
  def(rt, "Asin", (_c, a) => jReal(Math.abs(asNum(a[0])) > 1 ? 0 : Math.asin(asNum(a[0]))));
  def(rt, "Acos", (_c, a) => jReal(Math.abs(asNum(a[0])) > 1 ? 0 : Math.acos(asNum(a[0]))));
  def(rt, "Atan", (_c, a) => jReal(Math.atan(asNum(a[0]))));
  def(rt, "Atan2", (_c, a) => jReal(asNum(a[0]) === 0 && asNum(a[1]) === 0 ? 0 : Math.atan2(asNum(a[0]), asNum(a[1]))));
  def(rt, "SquareRoot", (_c, a) => jReal(asNum(a[0]) <= 0 ? 0 : Math.sqrt(asNum(a[0]))));
  def(rt, "Pow", (_c, a) => {
    const x = asNum(a[0]), y = asNum(a[1]);
    if (y === 0) return jReal(1);
    if (x === 0 && y < 0) return jReal(0);
    return jReal(Math.pow(x, y));
  });

  // Environment natives every main() calls that the renderer sets up for itself.
  // (Sound + music used to sit in this list; they are real now — see natives/sound.ts.
  // AddWeatherEffect/EnableWeatherEffect sat here too, and that is why 40 maps ran with
  // their rain and snow silently switched off — they are real now, see natives/weather.ts.
  // SetCameraBounds/GetCameraMargin sat here too, and the whole camera + cinematic surface
  // behind them: real now, see natives/camera.ts + natives/cinematic.ts.
  // SetAmbientDay/NightSound stay: they name a MIDI ambience bed we don't synthesize.)
  for (const name of [
    "SetDayNightModels", "SetAmbientDaySound", "SetAmbientNightSound",
    "SetMapFlag", "SetMapName",
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
  registerAbilityNatives(rt); // abilities + heroes (7.17)
  registerWidgetNatives(rt); // a widget's life, and damage dealt by a trigger (docs/map-compatibility.md)
  registerPredicateNatives(rt); // the `Is…` conditions a custom map gates on (ditto)
  registerUnitStatNatives(rt); // BlzGet/SetUnit… — a map rebalancing a unit at run time (ditto)
  registerAbilityBlzNatives(rt); // Blz… abilities: off/hidden per unit, clocks, costs, words (ditto)
  registerAbilityFieldNatives(rt); // the 1.31 ability INSTANCES and their fields (docs/map-compatibility.md)
  registerCameraNatives(rt); // camera setups + the camera-move family (7.24)
  registerCinematicNatives(rt); // letterbox, fade, transmissions, minimap pings (7.24)
  registerDialogNatives(rt); // dialogs + the victory/defeat screen (7.19)
  registerEffectNatives(rt); // the trigger puts a model in the world (7.26 — issue #68)
  registerLightningNatives(rt); // a script's own bolts (docs/map-compatibility.md pass 10)
  registerImageryNatives(rt); // ubersplats, images, water tint, sky (ditto)
  registerEventNatives(rt);
  registerLeaderboardNatives(rt); // the scoreboard every TD/AoS shows (7.19)
  registerForceNatives(rt);
  registerGameCacheNatives(rt); // the campaign's memory between chapters (docs/campaigns.md)
  registerGroupNatives(rt);
  registerHashtableNatives(rt); // InitHashtable & co — what every modern map keeps its state in
  registerFrameNatives(rt); // the 1.31 custom-UI frame API (src/compat/frames.ts)
  registerFieldNatives(rt); // the 1.31 object-FIELD accessors (src/compat/blzFields.ts)
  registerItemNatives(rt); // items + the item events (7.18)
  registerDestructableNatives(rt); // destructibles: gates open by dying (issue #85)
  registerMeleeNatives(rt); // what blizzard.j's Melee* library stands on (7.3)
  registerMultiboardNatives(rt); // the grid scoreboard — what DotA puts on screen (7.22)
  registerQuestNatives(rt); // the F9 quest log's script side (issue #33)
  registerRegionNatives(rt);
  registerSoundNatives(rt); // the sound handle family + music (7.20)
  registerStockNatives(rt); // neutral-building stock — the Marketplace (issue #57)
  registerTextNatives(rt); // after config: its real SetPlayerName overrides config's setup stub
  registerTimerDialogNatives(rt); // the countdown windows (7.21)
  registerVisionNatives(rt); // alliances/shared vision + BOTH fogs (7.22)
  registerWeatherNatives(rt); // the map's atmosphere — rain/snow/fog particles (7.23)
  registerUtilNatives(rt);
}
