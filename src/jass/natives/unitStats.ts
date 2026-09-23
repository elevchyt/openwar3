// The `BlzGetUnit…` / `BlzSetUnit…` stat accessors (docs/map-compatibility.md pass 3).
//
// These are 1.30.4 natives — every one is declared in the install's own `common.j` — and the
// reason a downloaded map reaches for them is that they are how a map REBALANCES a unit at run
// time: Test of Balance and Balanced Hero Survival are made of little else, and with no answer
// they boot and are inert. What each stat MEANS (a total, or the weapon's own column) is written
// down once, on `SimWorld.unitStat`; this file is the JASS boundary, and its one job beyond
// argument unpacking is the weapon INDEX.
//
// **The weapon index is counted from 0 or from 1 depending on the MAP.** "In 1.30 or lower, the
// function is 1-indexed, but in 1.31 and newer, it is 0-indexed" (hiveworkshop 319334). Our own
// 1.30.4 counts from 1, and a map saved by a 1.31+ editor — which only ever ran on a 1.31+
// client — counts from 0; `Runtime.weaponIndexBase` carries which, set at the map door off the
// map's own editor build. Read the wrong way round and `BlzSetUnitBaseDamage(u, d, 0)` on a
// Reforged-era map writes nothing at all (there is no weapon "0" in 1-based counting), which is
// what three quarters of the corpus's calls would have done.

import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, jBool, jInt, jReal, JNULL, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const simOf = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};
/** The map's weapon index → the type's weapon SLOT (0-based). */
const slotOf = (c: NativeCtx, v: JassValue | undefined): number => asInt(v ?? JNULL) - c.rt.weaponIndexBase;

const get = (c: NativeCtx, unitV: JassValue, stat: string, slot = 0): number | boolean | undefined => {
  const id = simOf(c, unitV);
  return id === undefined ? undefined : c.rt.hooks?.unitStat?.(id, stat, slot);
};
const set = (c: NativeCtx, unitV: JassValue, stat: string, value: number, slot = 0): void => {
  const id = simOf(c, unitV);
  if (id !== undefined) c.rt.hooks?.setUnitStat?.(id, stat, value, slot);
};
const num = (v: number | boolean | undefined): number => (typeof v === "number" ? v : 0);

export function registerUnitStatNatives(rt: Runtime): void {
  // --- the unit's own totals: max life, max mana, armour ---
  // Integer natives for the pools (common.j: `BlzSetUnitMaxHP takes unit, integer hp`), a real
  // for armour — which can be fractional, and is the one the corpus reads most.
  def(rt, "BlzGetUnitMaxHP", (c, a) => jInt(Math.round(num(get(c, a[0], "maxHp")))));
  def(rt, "BlzSetUnitMaxHP", (c, a) => (set(c, a[0], "maxHp", asInt(a[1])), JNULL));
  def(rt, "BlzGetUnitMaxMana", (c, a) => jInt(Math.round(num(get(c, a[0], "maxMana")))));
  def(rt, "BlzSetUnitMaxMana", (c, a) => (set(c, a[0], "maxMana", asInt(a[1])), JNULL));
  def(rt, "BlzGetUnitArmor", (c, a) => jReal(num(get(c, a[0], "armor"))));
  def(rt, "BlzSetUnitArmor", (c, a) => (set(c, a[0], "armor", asNum(a[1])), JNULL));
  // Read-only. 275 call sites — the single most-called of the family — and the easiest: it is
  // the same flag the sim keeps in step every tick (Divine Shield, Avatar, `SetUnitInvulnerable`).
  def(rt, "BlzIsUnitInvulnerable", (c, a) => jBool(get(c, a[0], "invulnerable") === true));

  // --- a weapon's own columns ---
  def(rt, "BlzGetUnitBaseDamage", (c, a) => jInt(Math.round(num(get(c, a[0], "baseDamage", slotOf(c, a[1]))))));
  def(rt, "BlzSetUnitBaseDamage", (c, a) => (set(c, a[0], "baseDamage", asInt(a[1]), slotOf(c, a[2])), JNULL));
  def(rt, "BlzGetUnitAttackCooldown", (c, a) => jReal(num(get(c, a[0], "attackCooldown", slotOf(c, a[1])))));
  def(rt, "BlzSetUnitAttackCooldown", (c, a) => (set(c, a[0], "attackCooldown", asNum(a[1]), slotOf(c, a[2])), JNULL));
  def(rt, "BlzGetUnitDiceNumber", (c, a) => jInt(num(get(c, a[0], "diceNumber", slotOf(c, a[1])))));
  def(rt, "BlzSetUnitDiceNumber", (c, a) => (set(c, a[0], "diceNumber", asInt(a[1]), slotOf(c, a[2])), JNULL));
  def(rt, "BlzGetUnitDiceSides", (c, a) => jInt(num(get(c, a[0], "diceSides", slotOf(c, a[1])))));
  def(rt, "BlzSetUnitDiceSides", (c, a) => (set(c, a[0], "diceSides", asInt(a[1]), slotOf(c, a[2])), JNULL));
}
