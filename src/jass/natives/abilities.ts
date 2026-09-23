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
import { asInt, asNum, jBool, jInt, JNULL, truthy, type JassValue } from "../values";

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
  // GetHeroLevel and GetUnitLevel are the same read in WC3 (a non-hero is level 0/1
  // from its data; the sim keeps `level` for both).
  const level = (c: NativeCtx, v: JassValue): JassValue => {
    const id = simOf(c, v);
    return jInt(id === undefined ? 0 : c.rt.hooks?.getUnitLevel?.(id) ?? 0);
  };
  def(rt, "GetHeroLevel", (c, a) => level(c, a[0]));
  def(rt, "GetUnitLevel", (c, a) => level(c, a[0]));
  // SetHeroLevel(hero, level, showEyeCandy) — the eye-candy flag is the level-up NOVA
  // (Levelupcaster.mdx and its fanfare), and it is a real knob: a map that seats a hero at
  // the level the story says he is passes FALSE and the reference client plays nothing.
  // Human01 opens with `SetHeroLevel( gg_unit_Huth_0024, 10, false )` — Uther arriving at
  // Strahnbrad already a level-10 paladin — and ignoring it flashed the nova over him in the
  // middle of the cinematic.
  def(rt, "SetHeroLevel", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.setHeroLevel?.(id, asInt(a[1]), truthy(a[2]));
    return JNULL;
  });
  def(rt, "GetHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    return jInt(id === undefined ? 0 : Math.floor(c.rt.hooks?.getHeroXp?.(id) ?? 0));
  });
  def(rt, "SetHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.setHeroXp?.(id, asInt(a[1]), truthy(a[2]));
    return JNULL;
  });
  def(rt, "AddHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.addHeroXp?.(id, asInt(a[1]), truthy(a[2]));
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

  // --- hero ATTRIBUTES: the stat system every arena and RPG map is built on ---
  //
  // `GetHeroStr(h, includeBonuses)` / `SetHeroStr(h, newStr, permanent)` and their Agi/Int
  // twins. Six natives that are one pair three times over, so they are registered from a table
  // rather than written out six times — the only thing that differs between them is which of
  // the three attributes they name.
  //
  // This is the single most-called family a downloaded map uses that we had no answer for:
  // ~450 call sites across the eleven maps in the install's own `Maps\Download`, of which
  // Angel Arena Allstars alone is 295. With no answer, `GetHeroStr` returned nothing and every
  // stat-shop price, every attribute-scaled spell and every "is this hero strong enough yet"
  // branch read zero.
  //
  // The `permanent` flag and the `includeBonuses` flag are both real and both explained where
  // they are obeyed (SimWorld.heroAttribute / setHeroAttribute).
  const ATTRS = [["Str", "str"], ["Agi", "agi"], ["Int", "int"]] as const;
  for (const [suffix, attr] of ATTRS) {
    def(rt, `GetHero${suffix}`, (c, a) => {
      const id = simOf(c, a[0]);
      return jInt(id === undefined ? 0 : Math.floor(c.rt.hooks?.getHeroAttribute?.(id, attr, truthy(a[1])) ?? 0));
    });
    def(rt, `SetHero${suffix}`, (c, a) => {
      const id = simOf(c, a[0]);
      if (id !== undefined) c.rt.hooks?.setHeroAttribute?.(id, attr, asInt(a[1]), truthy(a[2]));
      return JNULL;
    });
  }
  // ReviveHero(h, x, y, doEyecandy) / ReviveHeroLoc(h, loc, doEyecandy) — a fallen hero back,
  // instantly, where the script says. The handle is the one the map took while the hero lived:
  // it revives under the same id (RtsController.reviveHeroByScript), so it is the hero again.
  const revive = (c: NativeCtx, heroV: JassValue, x: number, y: number, eyeCandy: boolean): JassValue => {
    const u = c.rt.data<JassUnit>(heroV);
    if (!u || u.simId < 0) return jBool(false);
    return jBool(c.rt.hooks?.reviveHero?.(u.simId, x, y, eyeCandy) ?? false);
  };
  def(rt, "ReviveHero", (c, a) => revive(c, a[0], asNum(a[1]), asNum(a[2]), truthy(a[3])));
  def(rt, "ReviveHeroLoc", (c, a) => {
    const p = c.rt.data<{ x: number; y: number }>(a[1]);
    return revive(c, a[0], p?.x ?? 0, p?.y ?? 0, truthy(a[2]));
  });
  // SuspendHeroXP(h, flag) — TRUE stops the hero banking experience. Note the polarity: the
  // flag says SUSPENDED, so `SuspendHeroXP(h, false)` is the one that lets him earn again.
  def(rt, "SuspendHeroXP", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.suspendHeroXp?.(id, truthy(a[1]));
    return JNULL;
  });
}
