// The `Blz…` ABILITY natives (docs/map-compatibility.md pass 9): a unit's ability switched off
// or hidden, its clock read or ended, an ability type's cost and cooldown read, and its words and
// icon rewritten at run time. All of them are in the install's own 1.30.4 `common.j`.
//
// Two things are decided elsewhere and only obeyed here:
//
//   * A LEVEL is counted from 0 or 1 depending on the MAP (`Runtime.blzIndexBase`), for the same
//     reason and in the same patch as a weapon index: 1.31's `BlzSetAbility…` family "require
//     0-indexed levels instead of 1-indexed" (hiveworkshop 316163). The corpus proves which it
//     uses — every later-format map here passes `GetUnitAbilityLevel(u, a) - 1`, and sets the
//     first rank's tooltip at level 0.
//   * `BlzUnitDisableAbility`/`BlzUnitHideAbility` are COUNTERS, and what each stops is on
//     SimAbility.disableCount / SimWorld.scriptDisabled.
//
// Not here, deliberately: `BlzSetUnitAbilityCooldown` / `BlzSetUnitAbilityManaCost`. They are
// per-UNIT overrides of a per-TYPE value — a second place the cast cost and the cooldown would
// have to be read from — and no map in the corpus calls either, so their unit-level GETTERS
// answer the type's value, which is exactly right while nothing can have changed it.

import { intToRawcode } from "../lexer";
import type { JassItem, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asStr, jInt, jReal, jStr, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const simOf = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};
const abil = (v: JassValue | undefined): string => intToRawcode(asInt(v ?? JNULL));
/** The map's level → a 0-based rank. */
const rankOf = (c: NativeCtx, v: JassValue | undefined): number => asInt(v ?? JNULL) - c.rt.blzIndexBase;

export function registerAbilityBlzNatives(rt: Runtime): void {
  // --- one unit's ability: off, hidden, and its clock ---
  def(rt, "BlzUnitDisableAbility", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.unitDisableAbility?.(id, abil(a[1]), truthy(a[2]), truthy(a[3]));
    return JNULL;
  });
  def(rt, "BlzUnitHideAbility", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.unitHideAbility?.(id, abil(a[1]), truthy(a[2]));
    return JNULL;
  });
  // 240 call sites — the second most-called of all that were left — and a plain read: the entry's
  // own clock, which the sim already runs down every tick.
  def(rt, "BlzGetUnitAbilityCooldownRemaining", (c, a) => {
    const id = simOf(c, a[0]);
    return jReal(id === undefined ? 0 : c.rt.hooks?.unitAbilityCooldownLeft?.(id, abil(a[1])) ?? 0);
  });
  def(rt, "BlzEndUnitAbilityCooldown", (c, a) => {
    const id = simOf(c, a[0]);
    if (id !== undefined) c.rt.hooks?.endUnitAbilityCooldown?.(id, abil(a[1]));
    return JNULL;
  });

  // --- an ability TYPE's numbers, by rank ---
  const rank = (c: NativeCtx, abilV: JassValue, levelV: JassValue) => c.rt.hooks?.abilityRankData?.(abil(abilV), rankOf(c, levelV));
  def(rt, "BlzGetAbilityManaCost", (c, a) => jInt(rank(c, a[0], a[1])?.cost ?? 0));
  def(rt, "BlzGetAbilityCooldown", (c, a) => jReal(rank(c, a[0], a[1])?.cooldown ?? 0));
  // The unit-level readers answer the type — see the note at the top for why that is exact.
  def(rt, "BlzGetUnitAbilityManaCost", (c, a) => jInt(rank(c, a[1], a[2])?.cost ?? 0));
  def(rt, "BlzGetUnitAbilityCooldown", (c, a) => jReal(rank(c, a[1], a[2])?.cooldown ?? 0));

  // --- an ability TYPE's words and art ---
  // Presentation: the hooks are the renderer's half, so a map may call these inside a
  // `GetLocalPlayer` block to give one player their own tooltip (RtsController, abilityText).
  def(rt, "BlzGetAbilityTooltip", (c, a) => jStr(c.rt.hooks?.abilityText?.(abil(a[0]), rankOf(c, a[1]), false) ?? ""));
  def(rt, "BlzGetAbilityExtendedTooltip", (c, a) => jStr(c.rt.hooks?.abilityText?.(abil(a[0]), rankOf(c, a[1]), true) ?? ""));
  def(rt, "BlzSetAbilityTooltip", (c, a) => (c.rt.hooks?.setAbilityText?.(abil(a[0]), rankOf(c, a[2]), asStr(a[1]), false), JNULL));
  def(rt, "BlzSetAbilityExtendedTooltip", (c, a) => (c.rt.hooks?.setAbilityText?.(abil(a[0]), rankOf(c, a[2]), asStr(a[1]), true), JNULL));
  def(rt, "BlzGetAbilityIcon", (c, a) => jStr(c.rt.hooks?.abilityIcon?.(abil(a[0])) ?? ""));
  def(rt, "BlzSetAbilityIcon", (c, a) => (c.rt.hooks?.setAbilityIcon?.(abil(a[0]), asStr(a[1])), JNULL));
  // …and ONE item's long description (its entity, not its type).
  def(rt, "BlzSetItemExtendedTooltip", (c, a) => {
    const it = c.rt.data<JassItem>(a[0]);
    if (it && it.simId >= 0) c.rt.hooks?.setItemExtendedTooltip?.(it.simId, asStr(a[1]));
    return JNULL;
  });
}
