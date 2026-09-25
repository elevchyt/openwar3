// The 1.31 ability-FIELD API (docs/map-compatibility.md): an ability INSTANCE, and its object-data
// columns read and rewritten at run time.
//
//   BlzGetUnitAbility(u, 'A0PD')        → THIS unit's copy of the ability
//   BlzGetItemAbilityByIndex(item, 0)   → THIS item's copy of its first ability
//   BlzSetAbilityRealLevelField(ability, ABILITY_RLF_HIT_POINTS_GAINED_REJ1, level, 300.0)
//
// A write changes that one instance and nothing else — the sim gives the instance its own copy
// of the row the first time (SimWorld.ownAbilityDef) and every reader asks through the instance.
// That is how a later-format map builds whole systems: Test of Balance's items STACK (each
// charge rewrites the item's own Claws of Attack), its cooldown rewards shorten one hero's
// `acdn`, and its pillar's heal grows every wave.
//
// A field is named by its `Units\AbilityMetaData.slk` id, which the field constant carries
// (src/compat/blzFields.ts ABILITY_FIELDS) — the id a map's w3a names the same column by, so a
// script's write and an object-editor edit go through ONE routing (objectData.ts
// writeAbilityField → applyAbilityMods). A LEVEL is the map's own count
// (`Runtime.blzIndexBase`: "0-indexed level (since 1.31.1). Index=0 means level=1" — jassbot),
// handed to the engine 1-based.
//
// The handle is INTERNED per instance: `BlzGetUnitAbility(u, a) == BlzGetUnitAbility(u, a)` is
// true, as it is in the game, where the handle IS the instance.

import { intToRawcode, rawcodeToInt } from "../lexer";
import type { AbilityInstanceRef, JassItem, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, jReal, jStr, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** An `ability` handle's payload. */
interface JassAbility extends AbilityInstanceRef {
  handleId: number;
}

const interned = new WeakMap<Runtime, Map<string, number>>();

/** The one handle for an instance (minted on first ask). */
function abilityHandle(c: NativeCtx, ref: AbilityInstanceRef): JassValue {
  let byKey = interned.get(c.rt);
  if (!byKey) interned.set(c.rt, (byKey = new Map()));
  const key = `${ref.kind}:${ref.owner}:${ref.abilId}`;
  let h = byKey.get(key);
  if (h === undefined) {
    const obj: JassAbility = { handleId: 0, ...ref };
    h = obj.handleId = c.rt.handles.alloc(obj);
    byKey.set(key, h);
  }
  return jHandle(h, "ability");
}

const unitSim = (c: NativeCtx, v: JassValue | undefined): number | undefined => {
  const u = c.rt.data<JassUnit>(v ?? JNULL);
  return u && u.simId >= 0 ? u.simId : undefined;
};
const itemSim = (c: NativeCtx, v: JassValue | undefined): number | undefined => {
  const it = c.rt.data<JassItem>(v ?? JNULL);
  return it && it.simId >= 0 ? it.simId : undefined;
};
const abilCode = (v: JassValue | undefined): string => intToRawcode(asInt(v ?? JNULL));
const refOf = (c: NativeCtx, v: JassValue | undefined): AbilityInstanceRef | undefined => {
  const a = c.rt.data<JassAbility>(v ?? JNULL);
  return a ? { kind: a.kind, owner: a.owner, abilId: a.abilId } : undefined;
};
/** The field constant's metadata id (its Convert… index is that id as a rawcode). */
const fieldId = (c: NativeCtx, v: JassValue | undefined): string => intToRawcode(c.rt.enumIndex(v ?? JNULL));
/** The map's level → the engine's 1-based rank. */
const levelOf = (c: NativeCtx, v: JassValue | undefined): number => asInt(v ?? JNULL) - c.rt.blzIndexBase + 1;

export function registerAbilityFieldNatives(rt: Runtime): void {
  // --- the instance handles ---
  def(rt, "BlzGetUnitAbility", (c, a) => {
    const id = unitSim(c, a[0]);
    const abil = abilCode(a[1]);
    return id !== undefined && c.rt.hooks?.unitHasAbility?.(id, abil) ? abilityHandle(c, { kind: "unit", owner: id, abilId: abil }) : JNULL;
  });
  def(rt, "BlzGetUnitAbilityByIndex", (c, a) => {
    const id = unitSim(c, a[0]);
    const abil = id === undefined ? undefined : c.rt.hooks?.unitAbilityAt?.(id, asInt(a[1] ?? JNULL));
    return id !== undefined && abil ? abilityHandle(c, { kind: "unit", owner: id, abilId: abil }) : JNULL;
  });
  def(rt, "BlzGetItemAbility", (c, a) => {
    const id = itemSim(c, a[0]);
    const abil = abilCode(a[1]);
    return id !== undefined && c.rt.hooks?.itemAbilityIds?.(id).includes(abil) ? abilityHandle(c, { kind: "item", owner: id, abilId: abil }) : JNULL;
  });
  // "which ability is considered the 'default' one … is unspecified" (jassbot) — the row's own
  // order is the one we have, and every call in the corpus is on a single-ability item or asks
  // for index 0 and 1 of a two-ability one it wrote itself.
  def(rt, "BlzGetItemAbilityByIndex", (c, a) => {
    const id = itemSim(c, a[0]);
    const abil = id === undefined ? undefined : c.rt.hooks?.itemAbilityIds?.(id)[asInt(a[1] ?? JNULL)];
    return id !== undefined && abil ? abilityHandle(c, { kind: "item", owner: id, abilId: abil }) : JNULL;
  });
  def(rt, "BlzGetAbilityId", (c, a) => {
    const ref = refOf(c, a[0]);
    return jInt(ref ? rawcodeToInt(ref.abilId) : 0);
  });

  // --- the fields: eight families, two shapes (with a level, and without) ---
  const read = (c: NativeCtx, a: JassValue[], levelled: boolean) => {
    const ref = refOf(c, a[0]);
    return ref ? c.rt.hooks?.abilityField?.(ref, fieldId(c, a[1]), levelled ? levelOf(c, a[2]) : 1) : undefined;
  };
  const write = (c: NativeCtx, a: JassValue[], levelled: boolean, value: string | number): JassValue => {
    const ref = refOf(c, a[0]);
    return jBool(!!ref && (c.rt.hooks?.setAbilityField?.(ref, fieldId(c, a[1]), levelled ? levelOf(c, a[2]) : 1, value) ?? false));
  };
  const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v) || 0);
  for (const levelled of [false, true]) {
    const L = levelled ? "Level" : "";
    const vi = levelled ? 3 : 2; // where the value sits
    def(rt, `BlzGetAbilityInteger${L}Field`, (c, a) => jInt(Math.round(num(read(c, a, levelled)))));
    def(rt, `BlzGetAbilityReal${L}Field`, (c, a) => jReal(num(read(c, a, levelled))));
    def(rt, `BlzGetAbilityBoolean${L}Field`, (c, a) => {
      const v = read(c, a, levelled);
      return jBool(typeof v === "boolean" ? v : num(v) !== 0);
    });
    def(rt, `BlzGetAbilityString${L}Field`, (c, a) => {
      const v = read(c, a, levelled);
      return jStr(v === undefined ? "" : String(v));
    });
    def(rt, `BlzSetAbilityInteger${L}Field`, (c, a) => write(c, a, levelled, asInt(a[vi] ?? JNULL)));
    def(rt, `BlzSetAbilityReal${L}Field`, (c, a) => write(c, a, levelled, asNum(a[vi] ?? JNULL)));
    def(rt, `BlzSetAbilityBoolean${L}Field`, (c, a) => write(c, a, levelled, truthy(a[vi] ?? JNULL) ? 1 : 0));
    def(rt, `BlzSetAbilityString${L}Field`, (c, a) => write(c, a, levelled, asStr(a[vi] ?? JNULL)));
  }

  // --- one unit's ability clock and numbers ---
  def(rt, "BlzStartUnitAbilityCooldown", (c, a) => {
    const id = unitSim(c, a[0]);
    if (id !== undefined) c.rt.hooks?.startUnitAbilityCooldown?.(id, abilCode(a[1]), asNum(a[2] ?? JNULL));
    return JNULL;
  });
  // The unit-level readers answer the unit's OWN instance (natives/abilityBlz.ts registered the
  // type-level answer they gave before an instance could differ from its type).
  // An engine with no instances to ask (or a unit without the ability) answers the TYPE's row.
  const unitRank = (c: NativeCtx, a: JassValue[]) => {
    const id = unitSim(c, a[0]);
    const abil = abilCode(a[1]);
    const rank = levelOf(c, a[2]) - 1;
    return (id === undefined ? undefined : c.rt.hooks?.unitAbilityRankData?.(id, abil, rank)) ?? c.rt.hooks?.abilityRankData?.(abil, rank);
  };
  def(rt, "BlzGetUnitAbilityCooldown", (c, a) => jReal(unitRank(c, a)?.cooldown ?? 0));
  def(rt, "BlzGetUnitAbilityManaCost", (c, a) => jInt(unitRank(c, a)?.cost ?? 0));
  // …and their setters, which are the same write as the field natives' onto the Cool / Cost
  // columns (AbilityMetaData `acdn` / `amcs`).
  const setUnit = (metaId: string, value: (a: JassValue[]) => number): NativeFn => (c, a) => {
    const id = unitSim(c, a[0]);
    if (id !== undefined) c.rt.hooks?.setAbilityField?.({ kind: "unit", owner: id, abilId: abilCode(a[1]) }, metaId, levelOf(c, a[2]), value(a));
    return JNULL;
  };
  def(rt, "BlzSetUnitAbilityCooldown", setUnit("acdn", (a) => asNum(a[3] ?? JNULL)));
  def(rt, "BlzSetUnitAbilityManaCost", setUnit("amcs", (a) => asInt(a[3] ?? JNULL)));

  // --- ParseTags (1.32) ---
  // jassbot documents its signature and nothing else, and every call in the corpus hands it text
  // with no tag in it (Test of Balance: `ParseTags(R2S(x))`, then reads single digits back out),
  // which must come back UNCHANGED. What it does to a string that does carry a tag is not known
  // here, so it is not guessed at: the text is returned as it came.
  def(rt, "ParseTags", (_c, a) => jStr(asStr(a[0] ?? JNULL)));
}
