// The unit natives common.j declares that had no implementation (issue #313).
//
// Each of these was answered by the interpreter's typed default — null, 0 or false — so the map
// ran on and silently lost what the call was for. They are grouped here by what they touch:
//
//   * the PICTURE  — an animation chosen by index or by rarity, the "special minimap icon";
//   * the WORLD    — vision lent per unit, a body that does not rot, construction moved along,
//                    alarms, day-sleepers, rescue, timed life, the propulsion window;
//   * ORDERS       — a build order by type, the "instant" order pair, a player's whole army
//                    handed to another, a unit made by its type NAME.
//
// Three families are deliberately NOT behaviour, and say so where they are registered rather
// than being left to the default:
//
//   * `SetUnitLookAt` / `ResetUnitLookAt` / `SetUnitBlendTime` turn a BONE toward a target and
//     set how long two clips cross-fade. Neither exists in the model viewer we draw with, and
//     neither changes anything a script can read back.
//   * `SetUnitFog` — "Unknown, unused" (jassdoc); common.j gives it five unnamed reals.
//   * `GetUnitRallyDestructable` — a rally flag in this engine rests on a point, a unit or a
//     gold mine (BuildingState.rallyKind); one planted on a tree keeps the point.
//
// Sources: the install's own `Scripts\common.j` for every signature, `Scripts\Blizzard.j` for how
// the game itself calls them (line numbers beside each), and jassdoc (github.com/lep/jassdoc,
// the annotated common.j) for behaviour no file states.

import { intToRawcode, rawcodeToInt } from "../lexer";
import { orderIdToString, orderStringToId } from "../orders";
import type { JassPlayer, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jReal, JNULL, truthy, type JassValue } from "../values";
import { issueTargetOrder } from "./orderTarget";
import { createUnit } from "./world";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const unit = (c: NativeCtx, v: JassValue): JassUnit | undefined => c.rt.data<JassUnit>(v);
/** The sim id behind a unit handle, or -1 (no handle, or a handle with no unit in the world). */
const simOf = (c: NativeCtx, v: JassValue): number => {
  const u = unit(c, v);
  return u && u.simId >= 0 ? u.simId : -1;
};
const playerOf = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? -1;

export function registerUnitExtraNatives(rt: Runtime): void {
  // --- the picture ------------------------------------------------------------------------
  // SetUnitAnimationByIndex(u, n) — the model's Nth sequence, counted as the MDX lists them.
  // The most-called native that was still missing (88 call sites): a map whose dummy model has
  // no usefully NAMED clips ("Stand - 3") reaches them this way.
  def(rt, "SetUnitAnimationByIndex", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUnitAnimationByIndex?.(id, asInt(a[1]));
    return JNULL;
  });
  // SetUnitAnimationWithRarity(u, name, rarity) — RARITY_FREQUENT (0) / RARITY_RARE (1), common.j
  // 868–869. A model may carry a clip twice, one of them marked with a Rarity (the idle a unit
  // only sometimes plays); this picks which.
  def(rt, "SetUnitAnimationWithRarity", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUnitAnimationWithRarity?.(id, asStr(a[1]), c.rt.enumIndex(a[2]) === 1);
    return JNULL;
  });
  // See the header: bone look-at and clip blending have nothing behind them in our renderer.
  for (const name of ["SetUnitLookAt", "ResetUnitLookAt", "SetUnitBlendTime", "SetUnitFog"]) def(rt, name, () => JNULL);

  // The "special minimap icon" (UI\TriggerStrings.txt: "Turn Special Minimap Icon On/Off" and
  // "Change Special Minimap Icon" — "must be exactly 16x16 pixels"). ONE icon for the whole
  // game, worn by every unit that has it switched on.
  def(rt, "UnitSetUsesAltIcon", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUnitAltIcon?.(id, truthy(a[1]));
    return JNULL;
  });
  def(rt, "SetAltMinimapIcon", (c, a) => (c.rt.hooks?.setAltMinimapIcon?.(asStr(a[0])), JNULL));

  // --- the world --------------------------------------------------------------------------
  // UnitShareVision(u, player, share) — Blizzard.j 3634 (UnitShareVisionBJ). 43 call sites.
  def(rt, "UnitShareVision", (c, a) => {
    const id = simOf(c, a[0]);
    const p = playerOf(c, a[1]);
    if (id >= 0 && p >= 0) c.rt.hooks?.shareUnitVision?.(id, p, truthy(a[2]));
    return JNULL;
  });
  // UnitSuspendDecay(u, suspend) — Blizzard.j 3119, and CreatePermanentCorpseLocBJ (3136/3150),
  // which is how a map leaves a body lying for good.
  def(rt, "UnitSuspendDecay", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.suspendDecay?.(id, truthy(a[1]));
    return JNULL;
  });
  def(rt, "UnitSetConstructionProgress", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setConstructionProgress?.(id, asInt(a[1]));
    return JNULL;
  });
  def(rt, "UnitSetUpgradeProgress", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUpgradeProgress?.(id, asInt(a[1]));
    return JNULL;
  });
  // UnitIgnoreAlarm(u, flag) / UnitIgnoreAlarmToggled(u) — Blizzard.j 3570/3575 names the pair
  // for what it is: `UnitGenerateAlarms(u, generate)` is `UnitIgnoreAlarm(u, not generate)`.
  def(rt, "UnitIgnoreAlarm", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && (c.rt.hooks?.setUnitIgnoreAlarm?.(id, truthy(a[1])) ?? false));
  });
  def(rt, "UnitIgnoreAlarmToggled", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && (c.rt.hooks?.unitIgnoresAlarm?.(id) ?? false));
  });
  // UnitAddSleepPerm / UnitCanSleepPerm — the day-and-night twin of UnitAddSleep. The install
  // words the two apart: "Make Unit Sleep … when unprovoked" against UnitSetCanSleepBJ's "… when
  // unprovoked at night" (UI\TriggerStrings.txt).
  def(rt, "UnitAddSleepPerm", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUnitSleepPerm?.(id, truthy(a[1]));
    return JNULL;
  });
  def(rt, "UnitCanSleepPerm", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && (c.rt.hooks?.unitSleepPerm?.(id) ?? false));
  });
  // Rescue (Blizzard.j 6714–6806). The engine's share is the EVENT; what a rescue does is
  // RescueUnitBJ's. See SimWorld.tickRescue.
  def(rt, "SetUnitRescuable", (c, a) => {
    const id = simOf(c, a[0]);
    const p = playerOf(c, a[1]);
    if (id >= 0 && p >= 0) c.rt.hooks?.setUnitRescuable?.(id, p, truthy(a[2]));
    return JNULL;
  });
  def(rt, "SetUnitRescueRange", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUnitRescueRange?.(id, asNum(a[1]));
    return JNULL;
  });
  // The propulsion window. An ASYMMETRIC trio, and the install shows it: Blizzard.j 3493–3512
  // converts degrees→radians before SetUnitPropWindow and radians→degrees after
  // GetUnitPropWindow, but passes GetUnitDefaultPropWindow straight through — so the default is
  // already in DEGREES (UnitData `propWin`), "the odd case in the asymmetric prop window API"
  // (jassdoc).
  def(rt, "SetUnitPropWindow", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.setUnitPropWindow?.(id, asNum(a[1]));
    return JNULL;
  });
  def(rt, "GetUnitPropWindow", (c, a) => {
    const u = unit(c, a[0]);
    if (!u) return jReal(0);
    const live = u.simId >= 0 ? c.rt.hooks?.getUnitPropWindow?.(u.simId) : undefined;
    return jReal(live ?? ((c.rt.hooks?.unitTypePropWindow?.(u.typeId) ?? 0) * Math.PI) / 180);
  });
  def(rt, "GetUnitDefaultPropWindow", (c, a) => {
    const u = unit(c, a[0]);
    return jReal(u ? c.rt.hooks?.unitTypePropWindow?.(u.typeId) ?? 0 : 0);
  });
  def(rt, "BlzGetUnitCollisionSize", (c, a) => {
    const id = simOf(c, a[0]);
    return jReal(id >= 0 ? c.rt.hooks?.unitCollisionSize?.(id) ?? 0 : 0);
  });
  def(rt, "BlzIsUnitSelectable", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && (c.rt.hooks?.isUnitSelectable?.(id) ?? true));
  });
  def(rt, "BlzUnitCancelTimedLife", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.cancelTimedLife?.(id);
    return JNULL;
  });
  def(rt, "BlzUnitInterruptAttack", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.interruptAttack?.(id);
    return JNULL;
  });
  def(rt, "GetUnitRallyDestructable", () => JNULL); // see the header

  // --- orders -----------------------------------------------------------------------------
  // IssueBuildOrderById(peon, unitId, x, y) — Blizzard.j 3458 (IssueBuildOrderByIdLocBJ, the
  // GUI's "Unit - Issue Build Order"). The by-NAME form takes the type's internal name, UnitId's
  // vocabulary ("farm"), exactly as `UnitId` reads it.
  const build = (c: NativeCtx, peonV: JassValue, typeId: string, x: number, y: number): JassValue => {
    const id = simOf(c, peonV);
    return jBool(id >= 0 && !!typeId && (c.rt.hooks?.issueBuildOrder?.(id, typeId, x, y) ?? false));
  };
  def(rt, "IssueBuildOrderById", (c, a) => build(c, a[0], intToRawcode(asInt(a[1])), asNum(a[2]), asNum(a[3])));
  def(rt, "IssueBuildOrder", (c, a) => build(c, a[0], c.rt.hooks?.unitTypeByName?.(asStr(a[1])) ?? "", asNum(a[2]), asNum(a[3])));

  // The "instant" orders carry a SECOND widget (`instantTargetWidget`) beside the ordinary
  // target. No source says what the engine does with it — jassdoc documents the four with a
  // patch number and nothing else, and no map in the install calls one — so the order itself is
  // issued and the extra widget is not used. That much is certain to be wanted; the rest is not
  // guessed at.
  const orderStr = (v: JassValue): string => (v.k === "string" ? v.s.trim().toLowerCase() : "");
  const instantPoint = (c: NativeCtx, a: JassValue[], order: string, orderId: number): JassValue => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && (c.rt.hooks?.issueUnitOrder?.(id, orderId, order, "point", asNum(a[2]), asNum(a[3]), 0) ?? false));
  };
  const instantTarget = (c: NativeCtx, a: JassValue[], order: string, orderId: number): JassValue => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && issueTargetOrder(c, id, orderId, order, a[2] ?? JNULL));
  };
  def(rt, "IssueInstantPointOrder", (c, a) => instantPoint(c, a, orderStr(a[1]), orderStringToId(orderStr(a[1]))));
  def(rt, "IssueInstantPointOrderById", (c, a) => instantPoint(c, a, orderIdToString(asInt(a[1])), asInt(a[1])));
  def(rt, "IssueInstantTargetOrder", (c, a) => instantTarget(c, a, orderStr(a[1]), orderStringToId(orderStr(a[1]))));
  def(rt, "IssueInstantTargetOrderById", (c, a) => instantTarget(c, a, orderIdToString(asInt(a[1])), asInt(a[1])));

  // CreateUnitByName / CreateUnitAtLocByName — CreateUnit, with the type given by its internal
  // name (`UnitId`'s vocabulary). An unknown name creates nothing.
  const byName = (c: NativeCtx, playerV: JassValue, name: string, x: number, y: number, facing: number): JassValue => {
    const typeId = c.rt.hooks?.unitTypeByName?.(name) ?? "";
    if (!typeId) return JNULL;
    return createUnit(c, playerV, rawcodeToInt(typeId), x, y, facing);
  };
  def(rt, "CreateUnitByName", (c, a) => byName(c, a[0], asStr(a[1]), asNum(a[2]), asNum(a[3]), asNum(a[4])));
  def(rt, "CreateUnitAtLocByName", (c, a) => {
    const loc = c.rt.data<{ x: number; y: number }>(a[2]);
    return byName(c, a[0], asStr(a[1]), loc?.x ?? 0, loc?.y ?? 0, asNum(a[3]));
  });

  // SetPlayerUnitsOwner(player, newOwner) — every unit one player has, handed to another. Note
  // the second argument: an INTEGER player index, not a player handle (common.j 1068). Each unit
  // leaves through the same door `SetUnitOwner` uses, so the model is re-tinted with it.
  def(rt, "SetPlayerUnitsOwner", (c, a) => {
    const from = playerOf(c, a[0]);
    const to = asInt(a[1]);
    if (from < 0 || to < 0 || from === to) return JNULL;
    const moved = new Set(c.rt.hooks?.unitsOwnedBy?.(from) ?? []);
    for (const id of moved) c.rt.hooks?.setUnitOwner?.(id, to, true);
    // …and the handles a script already holds follow, as SetUnitOwner's own does.
    for (const u of c.rt.units) if (moved.has(u.simId)) u.player = to;
    return JNULL;
  });
}
