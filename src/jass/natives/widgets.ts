// WIDGET natives + trigger-dealt damage (docs/map-compatibility.md pass 2).
//
// A `widget` is common.j's base type for "a thing on the map with hit points" — a unit, a
// destructible or an item — and a custom map reaches for one exactly when it does not want to
// care which it has. `GetWidgetLife` is called 137 times across the eleven maps in the install's
// own `Maps\Download` and `SetWidgetLife` 19 more; with no answer, every "is this thing still
// alive / how hurt is it" branch in those maps read zero, which for most of them means DEAD.
//
// There is no widget HOOK and there should not be one: the dispatch is a question about the
// HANDLE, which only this side can answer, and both destinations already exist —
// `getUnitState`/`setUnitState` for a unit and the destructible pair for a destructible. So the
// whole file is a router, and adding a widget kind later means adding a branch here rather than
// a new seam through the engine.

import { ATTACK_TYPES } from "../../data/unitFieldCodes";
import type { JassDestructable } from "./destructables";
import { weaponTypes } from "./events";
import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { AttackType } from "../../data/enums";
import { asNum, jBool, jReal, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** `UNIT_STATE_LIFE` — common.j's `ConvertUnitState(0)`. The unit half of a widget's life is
 *  the state natives' job already; this is the index they take. */
const UNIT_STATE_LIFE = 0;

/** A trigger blow's options off the natives' shared tail — `attack, ranged, attacktype,
 *  damagetype, weapontype` starting at argument `at`. The damage and weapon types are handed on
 *  as well as read, so a DAMAGING handler sees them (BlzGetEventDamageType / WeaponType). */
function triggerBlow(c: NativeCtx, a: JassValue[], at: number) {
  const damageType = c.rt.enumIndex(a[at + 3] ?? JNULL);
  return {
    attack: truthy(a[at]),
    ranged: truthy(a[at + 1]),
    attackType: ATTACK_TYPES[c.rt.enumIndex(a[at + 2] ?? JNULL)] ?? AttackType.Spells,
    magic: damageType === DAMAGE_TYPE_MAGIC,
    universal: damageType === DAMAGE_TYPE_UNIVERSAL,
    damageType,
    weaponSound: weaponTypes(c).byIndex.get(c.rt.enumIndex(a[at + 4] ?? JNULL)) ?? "",
  };
}

/** The sim unit behind a `unit` handle, or undefined. */
const simOf = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};

/**
 * common.j's `attacktype` index → our damage-table column (`AttackType`).
 *
 * **The first two are crossed over, and it is the install's own file that says so.**
 * `UI\TriggerData.txt` names each constant with the string the World Editor prints beside it:
 *
 *     AttackTypeNormal=1,attacktype,ATTACK_TYPE_NORMAL,WESTRING_UE_ATTACKTYPE_SPELLS
 *     AttackTypeMelee =1,attacktype,ATTACK_TYPE_MELEE, WESTRING_UE_ATTACKTYPE_NORMAL
 *
 * So JASS's `ATTACK_TYPE_NORMAL` is the editor's **Spells** row and `ATTACK_TYPE_MELEE` is the
 * editor's **Normal** row. Read them the obvious way round and a map's trigger damage is graded
 * by the wrong column of `MiscGame.txt`'s table for every blow: Spells is flat 1.0 against
 * everything but Fortified, Normal is +50 % against Medium and −30 % against Heavy, so the two
 * are never the same number. A map dealing "pure" trigger damage passes ATTACK_TYPE_NORMAL and
 * means the flat column — which is what makes this the wrong trap to get wrong.
 */
// (The table itself lives in data/unitFieldCodes.ts, shared with the weapon-field natives.)

/** common.j `damagetype` indices we have to tell apart. The enum has twenty-odd values and they
 *  are almost all flavour (DAMAGE_TYPE_FIRE, _SONIC, _POISON …) that differ in nothing the sim
 *  models; the two that CHANGE the arithmetic are these. */
const DAMAGE_TYPE_MAGIC = 14;
const DAMAGE_TYPE_UNIVERSAL = 26;

export function registerWidgetNatives(rt: Runtime): void {
  // --- a widget's life, whichever kind it is ---
  def(rt, "GetWidgetLife", (c, a) => {
    const w = a[0];
    const id = simOf(c, w);
    if (id !== undefined) return jReal(c.rt.hooks?.getUnitState?.(id, UNIT_STATE_LIFE) ?? 0);
    if (w?.k === "handle" && w.ty === "destructable") {
      const d = c.rt.data<JassDestructable>(w);
      // The live figure when the engine has one, else the handle's own — the same order
      // `GetDestructableLife` reads them in (natives/destructables.ts).
      return jReal((d?.mapId ? c.rt.hooks?.destructableInfo?.(d.mapId)?.life : undefined) ?? d?.life ?? 0);
    }
    // An ITEM is a widget too and we do not model item hit points (a dropped item cannot be
    // attacked here). Say so once rather than silently answering 0 forever.
    if (w?.k === "handle" && w.ty === "item") c.rt.warnOnce("GetWidgetLife:item", "items have no hit points in this engine — 0");
    return jReal(0);
  });
  def(rt, "SetWidgetLife", (c, a) => {
    const w = a[0];
    const life = asNum(a[1]);
    const id = simOf(c, w);
    if (id !== undefined) {
      c.rt.hooks?.setUnitState?.(id, UNIT_STATE_LIFE, life);
      return JNULL;
    }
    if (w?.k === "handle" && w.ty === "destructable") {
      const d = c.rt.data<JassDestructable>(w);
      if (d) {
        d.life = life;
        if (d.mapId > 0) c.rt.hooks?.setDestructableLife?.(d.mapId, life);
      }
    }
    return JNULL;
  });

  // --- where a widget is ---
  // Units answer through the same hooks `GetUnitX/Y` use; a destructible carries its own
  // coordinates on the handle, because a .doo record does not move.
  const widgetXY = (c: NativeCtx, v: JassValue, axis: "x" | "y"): JassValue => {
    const id = simOf(c, v);
    if (id !== undefined) {
      return jReal((axis === "x" ? c.rt.hooks?.getUnitX?.(id) : c.rt.hooks?.getUnitY?.(id)) ?? 0);
    }
    const d = c.rt.data<JassDestructable>(v);
    return jReal((d ? d[axis] : 0) ?? 0);
  };
  def(rt, "GetWidgetX", (c, a) => widgetXY(c, a[0], "x"));
  def(rt, "GetWidgetY", (c, a) => widgetXY(c, a[0], "y"));

  // --- damage dealt by a trigger ---
  //
  // `UnitDamageTarget(source, target, amount, attack, ranged, attacktype, damagetype,
  // weapontype)`. This is how a custom map's spells deal damage AT ALL — a map that rebuilt its
  // spells on unrelated bases does its own arithmetic and then calls this — so unanswered, every
  // such spell hits for nothing. 38 call sites across the corpus, 24 of them DotA's.
  //
  // `weapontype` is the sound of the blow (`WEAPON_TYPE_METAL_HEAVY_SLICE` …) and is dropped:
  // it selects a sound set we do not key trigger damage off. The three arguments that change
  // the arithmetic are read, and what each one means is spelled out on SimWorld.damageTarget.
  def(rt, "UnitDamageTarget", (c, a) => {
    const source = simOf(c, a[0]);
    const target = simOf(c, a[1]);
    if (source === undefined || target === undefined) return jBool(false);
    const dealt = c.rt.hooks?.damageTarget?.(source, target, asNum(a[2]), triggerBlow(c, a, 3)) ?? 0;
    return jBool(dealt > 0);
  });
  // `UnitDamagePoint(source, delay, radius, x, y, amount, attack, ranged, attacktype,
  // damagetype, weapontype)` — the same blow on an AREA, after a delay (blizzard.j's
  // UnitDamagePointLoc; SimWorld.damagePoint says who it reaches). Test of Balance's items and
  // its Nick hero's hotkey spells deal their area damage through it.
  def(rt, "UnitDamagePoint", (c, a) => {
    const source = simOf(c, a[0]);
    if (source === undefined) return jBool(false);
    return jBool(c.rt.hooks?.damagePoint?.(source, asNum(a[1]), asNum(a[2]), asNum(a[3]), asNum(a[4]), asNum(a[5]), triggerBlow(c, a, 6)) ?? false);
  });
  // `ConvertAttackType` / `ConvertDamageType` are NOT registered here — they are in the central
  // CONVERT_NATIVES list (natives/index.ts) with the other forty. What this file owns is what
  // the indices they intern MEAN.
}
