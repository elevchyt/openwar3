import { unitFieldAt, type UnitFieldKey } from "../../compat/blzFields";
import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, jBool, jInt, jReal, jStr, JNULL, truthy, type JassValue } from "../values";

// The 1.31 object-FIELD accessors (docs/map-compatibility.md; the table is src/compat/blzFields.ts).
//
// `BlzGetUnitIntegerField(u, UNIT_IF_PRIMARY_ATTRIBUTE)` is how a map written after 2019 asks
// for a column of object data at run time, and a map that cannot get an answer branches wrongly
// rather than failing: Balanced Hero Survival reads the primary attribute twelve times to decide
// which attribute a trait bonus goes into, so a flat 0 puts every bonus in the same place.
//
// The GETTERS read the unit's TYPE row, through the same registry the rest of the engine reads
// (`EngineHooks.unitTypeField` → game/jassHooks.ts). That is the right answer for every field a
// map asks about here — a Blademaster's strength per level is a property of Blademasters.
//
// A GETTER asks for THIS unit's value first (SimWorld.unitField — a script's own write, or the
// per-unit state the engine already keeps) and falls back to the type row. The SETTERS write that
// per-unit layer (SimWorld.setUnitField); see the note above them for why they were once refused.

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** The sim id behind a `unit` handle, or undefined. */
const simOf = (c: NativeCtx, v: JassValue): number | undefined => {
  const u = c.rt.data<JassUnit>(v);
  return u && u.simId >= 0 ? u.simId : undefined;
};

/** Read one field of a unit's type row, or undefined when we have no answer for it. */
function read(c: NativeCtx, unitV: JassValue, convert: string, fieldV: JassValue, native: string): number | boolean | string | undefined {
  const id = simOf(c, unitV);
  if (id === undefined) return undefined;
  const field = unitFieldAt(convert, c.rt.enumIndex(fieldV));
  if (!field) return undefined;
  if (!field.reads) {
    // Declared so the map compiles, and honestly unanswered — the same shape as a native
    // common.j declares and we have not written.
    c.rt.warnOnce(`${native}:${field.name}`, "this engine has no value for that field — default");
    return undefined;
  }
  return c.rt.hooks?.unitTypeField?.(id, field.reads as UnitFieldKey);
}

export function registerFieldNatives(rt: Runtime): void {
  def(rt, "BlzGetUnitIntegerField", (c, a) => {
    const v = read(c, a[0], "ConvertUnitIntegerField", a[1] ?? JNULL, "BlzGetUnitIntegerField");
    return jInt(typeof v === "number" ? Math.round(v) : typeof v === "boolean" ? (v ? 1 : 0) : 0);
  });
  def(rt, "BlzGetUnitRealField", (c, a) => {
    const v = read(c, a[0], "ConvertUnitRealField", a[1] ?? JNULL, "BlzGetUnitRealField");
    return jReal(typeof v === "number" ? v : 0);
  });
  def(rt, "BlzGetUnitBooleanField", (c, a) => {
    const v = read(c, a[0], "ConvertUnitBooleanField", a[1] ?? JNULL, "BlzGetUnitBooleanField");
    return jBool(typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : false);
  });
  def(rt, "BlzGetUnitStringField", (c, a) => {
    const v = read(c, a[0], "ConvertUnitStringField", a[1] ?? JNULL, "BlzGetUnitStringField");
    return jStr(typeof v === "string" ? v : "");
  });

  // The SETTERS — ONE unit's own value (SimWorld.setUnitField says where each lands). They were
  // refused through pass 3 for two reasons, and both are gone: the per-unit layer now exists, and
  // the DEFENSE/ARMOR type getter that would have made the Damage Engine's save-override-restore
  // write 0 back into every unit it touched now answers the real integer (data/unitFieldCodes.ts,
  // whose encodings the map's own Damage Engine configuration states). A field we cannot write
  // still answers false, which is the honest report that nothing changed.
  const set = (convert: string, native: string, value: (v: JassValue) => number): NativeFn => (c, a) => {
    const id = simOf(c, a[0]);
    const field = unitFieldAt(convert, c.rt.enumIndex(a[1] ?? JNULL));
    if (id === undefined || !field) return jBool(false);
    if (!field.reads) {
      c.rt.warnOnce(`${native}:${field.name}`, "this engine has nowhere to put that field — nothing written");
      return jBool(false);
    }
    return jBool(c.rt.hooks?.setUnitField?.(id, field.reads, value(a[2] ?? JNULL)) ?? false);
  };
  def(rt, "BlzSetUnitIntegerField", set("ConvertUnitIntegerField", "BlzSetUnitIntegerField", (v) => asInt(v)));
  def(rt, "BlzSetUnitRealField", set("ConvertUnitRealField", "BlzSetUnitRealField", (v) => asNum(v)));
  def(rt, "BlzSetUnitBooleanField", set("ConvertUnitBooleanField", "BlzSetUnitBooleanField", (v) => (truthy(v) ? 1 : 0)));
  // No string field has anywhere to land yet (a unit's NAME is BlzSetUnitName's).
  def(rt, "BlzSetUnitStringField", (c) => {
    c.rt.warnOnce("BlzSetUnitStringField", "no string unit field is writable — nothing written");
    return jBool(false);
  });

  // The WEAPON fields: the same, with a weapon INDEX in the map's own count (`blzIndexBase` — "in
  // 1.31 and newer, it is 0-indexed", hiveworkshop 319334), handed to the engine as a 0-based slot.
  const weaponRead = (c: NativeCtx, a: JassValue[], convert: string, native: string) => {
    const id = simOf(c, a[0]);
    const field = unitFieldAt(convert, c.rt.enumIndex(a[1] ?? JNULL));
    if (id === undefined || !field?.reads) {
      if (field && !field.reads) c.rt.warnOnce(`${native}:${field.name}`, "this engine has no value for that field — default");
      return undefined;
    }
    return c.rt.hooks?.unitTypeField?.(id, field.reads, asInt(a[2] ?? JNULL) - c.rt.blzIndexBase);
  };
  const weaponWrite = (convert: string, value: (v: JassValue) => number): NativeFn => (c, a) => {
    const id = simOf(c, a[0]);
    const field = unitFieldAt(convert, c.rt.enumIndex(a[1] ?? JNULL));
    if (id === undefined || !field?.reads) return jBool(false);
    return jBool(c.rt.hooks?.setUnitField?.(id, field.reads, value(a[3] ?? JNULL), asInt(a[2] ?? JNULL) - c.rt.blzIndexBase) ?? false);
  };
  const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0);
  def(rt, "BlzGetUnitWeaponRealField", (c, a) => jReal(num(weaponRead(c, a, "ConvertUnitWeaponRealField", "BlzGetUnitWeaponRealField"))));
  def(rt, "BlzGetUnitWeaponIntegerField", (c, a) => jInt(Math.round(num(weaponRead(c, a, "ConvertUnitWeaponIntegerField", "BlzGetUnitWeaponIntegerField")))));
  def(rt, "BlzGetUnitWeaponBooleanField", (c, a) => jBool(num(weaponRead(c, a, "ConvertUnitWeaponBooleanField", "BlzGetUnitWeaponBooleanField")) !== 0));
  def(rt, "BlzGetUnitWeaponStringField", (c) => {
    c.rt.warnOnce("BlzGetUnitWeaponStringField", "no string weapon field is read yet — default");
    return jStr("");
  });
  def(rt, "BlzSetUnitWeaponRealField", weaponWrite("ConvertUnitWeaponRealField", (v) => asNum(v)));
  def(rt, "BlzSetUnitWeaponIntegerField", weaponWrite("ConvertUnitWeaponIntegerField", (v) => asInt(v)));
  def(rt, "BlzSetUnitWeaponBooleanField", weaponWrite("ConvertUnitWeaponBooleanField", (v) => (truthy(v) ? 1 : 0)));
  def(rt, "BlzSetUnitWeaponStringField", (c) => {
    c.rt.warnOnce("BlzSetUnitWeaponStringField", "no string weapon field is writable — nothing written");
    return jBool(false);
  });

  // `ConvertUnitIntegerField(7)` and friends: the interned enum handles the constants above are
  // built from. Registered here rather than with the other Convert* natives because the FIELD
  // families are ours (src/compat/blzFields.ts) and this is where their indices are read back.
  for (const kind of ["ConvertUnitIntegerField", "ConvertUnitRealField", "ConvertUnitBooleanField", "ConvertUnitStringField"]) {
    def(rt, kind, (c, a) => c.rt.enumHandle(kind, asInt(a[0])));
  }
  // …and every other field family the prelude declares — the weapon, item and ABILITY fields,
  // whose index is the column's AbilityMetaData id as a rawcode (compat/blzFields.ts
  // ABILITY_FIELDS; natives/abilityFields.ts reads it back). Unregistered, each of their
  // constants was null and every ability-field write asked about no field at all.
  for (const kind of [
    "ConvertUnitWeaponIntegerField", "ConvertUnitWeaponRealField", "ConvertUnitWeaponBooleanField", "ConvertUnitWeaponStringField",
    "ConvertItemIntegerField", "ConvertItemRealField", "ConvertItemBooleanField", "ConvertItemStringField",
    "ConvertAbilityIntegerField", "ConvertAbilityRealField", "ConvertAbilityBooleanField", "ConvertAbilityStringField",
    "ConvertAbilityIntegerLevelField", "ConvertAbilityRealLevelField", "ConvertAbilityBooleanLevelField", "ConvertAbilityStringLevelField",
  ]) {
    def(rt, kind, (c, a) => c.rt.enumHandle(kind, asInt(a[0])));
  }
}
