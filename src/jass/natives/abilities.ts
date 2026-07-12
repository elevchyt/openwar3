// Ability + hero natives (Phase 7 milestone 7.17 — issue #33; see docs/triggers.md).
//
// The effect family a custom map reaches for once its units exist: grant/strip an
// ability, read or set its rank, and drive a hero's level / XP / skill points. All of
// it routes through EngineHooks to the sim's trigger-effect API (SimWorld.addAbility,
// setHeroLevel, …); with no bridge attached (headless) each is a safe no-op returning
// a typed default, per the "never hard-crash the map" rule.
//
// Ability ids are 4-char rawcodes on the JASS side (an integer — 'AHtb'), and our
// AbilityRegistry keys off the same rawcode string (the object-data ALIAS, which is
// what a custom map's A000 is). So the boundary conversion is just intToRawcode.

import { intToRawcode } from "../lexer";
import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, jBool, jInt, JNULL, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** The sim unit behind a `unit` handle (undefined when it has no sim unit — headless,
 *  or a handle whose unit is gone). */
const simOf = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};

export function registerAbilityNatives(rt: Runtime): void {
  // --- abilities on a unit ---
  def(rt, "UnitAddAbility", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id === undefined ? false : c.rt.hooks?.unitAddAbility?.(id, intToRawcode(asInt(a[1]))) ?? false);
  });
  def(rt, "UnitRemoveAbility", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id === undefined ? false : c.rt.hooks?.unitRemoveAbility?.(id, intToRawcode(asInt(a[1]))) ?? false);
  });
  // "Permanent" only matters for morphing units (an ability kept across the morph),
  // which we don't model — the ability is already added, so report success.
  def(rt, "UnitMakeAbilityPermanent", (c, a) => jBool(simOf(c, a[0]) !== undefined));

  def(rt, "GetUnitAbilityLevel", (c, a) => {
    const id = simOf(c, a[0]);
    return jInt(id === undefined ? 0 : c.rt.hooks?.getUnitAbilityLevel?.(id, intToRawcode(asInt(a[1]))) ?? 0);
  });
  const setLevel = (c: NativeCtx, unitV: JassValue, abilInt: number, level: number): JassValue => {
    const id = simOf(c, unitV);
    return jInt(id === undefined ? 0 : c.rt.hooks?.setUnitAbilityLevel?.(id, intToRawcode(abilInt), level) ?? 0);
  };
  def(rt, "SetUnitAbilityLevel", (c, a) => setLevel(c, a[0], asInt(a[1]), asInt(a[2])));
  // Inc/Dec ride on the same setter, off the CURRENT rank (both return the new one).
  def(rt, "IncUnitAbilityLevel", (c, a) => {
    const id = simOf(c, a[0]);
    if (id === undefined) return jInt(0);
    const cur = c.rt.hooks?.getUnitAbilityLevel?.(id, intToRawcode(asInt(a[1]))) ?? 0;
    return setLevel(c, a[0], asInt(a[1]), cur + 1);
  });
  def(rt, "DecUnitAbilityLevel", (c, a) => {
    const id = simOf(c, a[0]);
    if (id === undefined) return jInt(0);
    const cur = c.rt.hooks?.getUnitAbilityLevel?.(id, intToRawcode(asInt(a[1]))) ?? 0;
    return setLevel(c, a[0], asInt(a[1]), cur - 1);
  });
  def(rt, "UnitResetCooldown", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.resetUnitCooldown?.(id);
    return JNULL;
  });

  // --- heroes: level, XP, skill points ---
  // GetHeroLevel and GetUnitLevel are the same read in 1.27 (a non-hero is level 0/1
  // from its data; the sim keeps `level` for both).
  const level = (c: NativeCtx, v: JassValue): JassValue => {
    const id = simOf(c, v);
    return jInt(id === undefined ? 0 : c.rt.hooks?.getUnitLevel?.(id) ?? 0);
  };
  def(rt, "GetHeroLevel", (c, a) => level(c, a[0]));
  def(rt, "GetUnitLevel", (c, a) => level(c, a[0]));
  // SetHeroLevel(hero, level, showEyeCandy) — the eye-candy flag is the level-up nova,
  // which our sim plays on every level-up anyway (drainLevelUps), so it's not a knob.
  def(rt, "SetHeroLevel", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.setHeroLevel?.(id, asInt(a[1]));
    return JNULL;
  });
  def(rt, "GetHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    return jInt(id === undefined ? 0 : Math.floor(c.rt.hooks?.getHeroXp?.(id) ?? 0));
  });
  def(rt, "SetHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.setHeroXp?.(id, asInt(a[1]));
    return JNULL;
  });
  def(rt, "AddHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.addHeroXp?.(id, asInt(a[1]));
    return JNULL;
  });
  def(rt, "GetHeroSkillPoints", (c, a) => {
    const id = simOf(c, a[0]);
    return jInt(id === undefined ? 0 : c.rt.hooks?.getHeroSkillPoints?.(id) ?? 0);
  });
  def(rt, "UnitModifySkillPoints", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id === undefined ? false : c.rt.hooks?.modifySkillPoints?.(id, asInt(a[1])) ?? false);
  });
  // SelectHeroSkill — what the learn-skill button does: spend a point on the next rank
  // (the sim enforces the hero-level requirement and the max rank).
  def(rt, "SelectHeroSkill", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.selectHeroSkill?.(id, intToRawcode(asInt(a[1])));
    return JNULL;
  });
}
