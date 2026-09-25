// The INTEGER values the 1.31 unit-field natives speak (`BlzGetUnitIntegerField(u,
// UNIT_IF_DEFENSE_TYPE)`), for the fields whose value a map compares or stores as a literal. Our
// own data keeps these as words (ArmorType "small", armour sound "Flesh", targType "ground"), so
// the two directions live here, shared by the TYPE reader (game/jassHooks.ts) and the per-unit
// field layer (SimWorld.unitField / setUnitField).
//
// Each set is sourced where the numbers are actually written down:
//
//   * DEFENSE type — the damage-table class. Test of Balance's own Damage Engine configuration
//     assigns them (war3map.j 3858–3865): LIGHT 0, MEDIUM 1, HEAVY 2, FORTIFIED 3, NORMAL 4,
//     HERO 5, DIVINE 6, UNARMORED 7 — and saves a unit's value, overrides it for a blow and
//     writes it BACK, so a reader that answered 0 would reset every unit it touched to Light.
//   * ARMOR type — confusingly, the SOUND class a blow makes on the unit: the same file,
//     3851–3856: NONE 0, FLESH 1, METAL 2, WOOD 3, ETHEREAL 4, STONE 5.
//   * TARGETED AS — the engine's target-category BIT mask: "None = 0x1, Ground = 0x2, Air = 0x4,
//     Structure = 0x8, Ward = 0x10, Item = 0x20, Tree = 0x40, Wall = 0x80, Debris = 0x100,
//     Decoration = 0x200, Bridge = 0x400" (Insanity_AI, hiveworkshop 370653). Both rebalance maps
//     write `2` to make their wave creeps plain ground targets.

import { ArmorType, AttackType } from "./enums";

const DEFENSE: ReadonlyArray<ArmorType> = [
  ArmorType.Small, ArmorType.Medium, ArmorType.Large, ArmorType.Fort,
  ArmorType.Normal, ArmorType.Hero, ArmorType.Divine, ArmorType.None,
];

/** A damage-table class → the field's integer (-1 for one the table does not have). */
export function defenseTypeCode(t: ArmorType): number {
  return DEFENSE.indexOf(t);
}
/** …and back; undefined for an integer outside 0..7. */
export function defenseTypeFrom(n: number): ArmorType | undefined {
  return DEFENSE[n];
}

const ARMOR_SOUND = ["", "flesh", "metal", "wood", "ethereal", "stone"];

/** An armour SOUND class (UnitData `armor`: "Flesh", "Metal", …) → the field's integer. */
export function armorSoundCode(sound: string): number {
  return Math.max(0, ARMOR_SOUND.indexOf(sound.trim().toLowerCase()));
}
/** …and back, spelled as the data spells it ("Flesh"); "" for NONE or an unknown integer. */
export function armorSoundFrom(n: number): string {
  const s = ARMOR_SOUND[n] ?? "";
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

const TARGET_BITS: ReadonlyArray<[string, number]> = [
  ["none", 0x1], ["ground", 0x2], ["air", 0x4], ["structure", 0x8], ["ward", 0x10], ["item", 0x20],
  ["tree", 0x40], ["wall", 0x80], ["debris", 0x100], ["decoration", 0x200], ["bridge", 0x400],
];

/** A targType list ("ground", "air,structure") → the bit mask. */
export function targetedAsCode(targType: string): number {
  let mask = 0;
  for (const w of targType.toLowerCase().split(",")) {
    const bit = TARGET_BITS.find(([name]) => name === w.trim())?.[1];
    if (bit) mask |= bit;
  }
  return mask;
}
/** …and back, as the list our targeting reads (`SimUnit.targClass`). */
export function targetedAsFrom(mask: number): string {
  return TARGET_BITS.filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name).join(",");
}

/** common.j's `attacktype` indices → our damage-table rows. ATTACK_TYPE_NORMAL (0) is the
 *  editor's SPELLS row and ATTACK_TYPE_MELEE (1) its NORMAL row (UI\\TriggerData.txt names each
 *  constant beside its editor string — natives/widgets.ts keeps the whole story). The weapon
 *  field `UNIT_WEAPON_IF_ATTACK_ATTACK_TYPE` is taken to use the same numbering: nothing states it,
 *  and it is the only integer encoding of an attack type the API has. */
export const ATTACK_TYPES: readonly AttackType[] = [
  AttackType.Spells, AttackType.Normal, AttackType.Pierce, AttackType.Siege, AttackType.Magic, AttackType.Chaos, AttackType.Hero,
];
