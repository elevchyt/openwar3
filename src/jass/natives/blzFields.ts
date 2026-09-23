import { unitFieldAt, type UnitFieldKey } from "../../compat/blzFields";
import type { JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, jBool, jInt, jReal, jStr, JNULL, type JassValue } from "../values";

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
// The SETTERS are NOT implemented and say so once: `BlzSetUnitRealField` changes ONE unit, while
// our object-data routing writes the TYPE (`UNIT_SETTERS`, data/objectData.ts). Bridging that
// wants a per-unit override table in the sim, which is a change to the standard build rather
// than to the compatibility layer, so it is deliberately left for its own pass. A setter answers
// FALSE, which is the honest report that nothing was written.

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

  // The setters, refused in one place (see the note at the top). Named individually rather
  // than looped so `tools/native-coverage.mjs` still sees them.
  //
  // They were looked at again when the NAMED accessors landed (natives/unitStats.ts, pass 3),
  // and deliberately left refused — read this before routing one of them onto those writes:
  //
  //   * They do not mean the same thing. `BlzSetUnitMaxHP`/`BlzSetUnitArmor` set the unit's
  //     TOTAL (the engine solves the base); these fields are the object editor's BASE columns
  //     (`uhpm` "Hit Points Maximum (Base)", `udef` "Combat - Defense Base", `umpm`). For a hero
  //     that base cannot be recovered: the sim's bases are the data's own pre-folded `realhp` /
  //     `realdef` / `realm` columns, starting attributes and the hero armour constant included,
  //     and the raw `hp`/`def` columns are not carried.
  //   * Nothing asks. Across the eleven maps in `Maps\Download` these three are set ZERO times.
  //   * The two that ARE set — `UNIT_IF_ARMOR_TYPE` / `UNIT_IF_DEFENSE_TYPE`, 8 calls, every one
  //     Bribe's Damage Engine — are a save/override/RESTORE round-trip inside the pre-damage
  //     event, and their getter reads the damage-table class for BOTH (a string, so it answers
  //     0). Routing the setter before fixing that getter would write 0 back after every hit and
  //     corrupt the unit's armour class. The refusal is what protects it.
  for (const name of [
    "BlzSetUnitIntegerField", "BlzSetUnitRealField", "BlzSetUnitBooleanField", "BlzSetUnitStringField",
  ]) {
    def(rt, name, (c) => {
      c.rt.warnOnce(name, "a per-unit field write — this engine's object data is per TYPE (docs/map-compatibility.md)");
      return jBool(false);
    });
  }

  // `BlzGetUnitWeaponRealField` and friends take an extra weapon INDEX. The weapon rows are on
  // the same type row, but which of a unit's two weapons a map means is a second question we do
  // not answer yet; refused with the rest so the log names the right thing.
  for (const name of [
    "BlzGetUnitWeaponIntegerField", "BlzGetUnitWeaponRealField", "BlzGetUnitWeaponBooleanField", "BlzGetUnitWeaponStringField",
  ]) {
    def(rt, name, (c) => {
      c.rt.warnOnce(name, "per-weapon fields are not read yet — default");
      return name.includes("Boolean") ? jBool(false) : name.includes("String") ? jStr("") : name.includes("Integer") ? jInt(0) : jReal(0);
    });
  }
  for (const name of [
    "BlzSetUnitWeaponIntegerField", "BlzSetUnitWeaponRealField", "BlzSetUnitWeaponBooleanField", "BlzSetUnitWeaponStringField",
  ]) {
    def(rt, name, (c) => {
      c.rt.warnOnce(name, "a per-unit field write — this engine's object data is per TYPE (docs/map-compatibility.md)");
      return jBool(false);
    });
  }

  // `ConvertUnitIntegerField(7)` and friends: the interned enum handles the constants above are
  // built from. Registered here rather than with the other Convert* natives because the FIELD
  // families are ours (src/compat/blzFields.ts) and this is where their indices are read back.
  for (const kind of ["ConvertUnitIntegerField", "ConvertUnitRealField", "ConvertUnitBooleanField", "ConvertUnitStringField"]) {
    def(rt, kind, (c, a) => c.rt.enumHandle(kind, asInt(a[0])));
  }
}
