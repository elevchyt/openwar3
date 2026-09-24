// The 1.31 object-FIELD constants, and what each one reads (docs/map-compatibility.md).
//
// `BlzGetUnitIntegerField(u, UNIT_IF_PRIMARY_ATTRIBUTE)` is how a map saved after 2019 asks the
// engine for a column of its own object data at run time. None of it exists in a 1.30.4
// `common.j`, so our compat prelude declares it — and this file is the ONE place the list
// lives, because the prelude's constants and the native's switch have to agree exactly and
// nothing would catch them drifting apart.
//
// **The numbers are ours.** A `ConvertUnitIntegerField(n)` index never appears in a map FILE:
// the map writes the constant's NAME, the compiler resolves it through our declaration, and our
// own native compares the same index back. So the index is simply this array's position, and
// adding a field means adding a row.
//
// **What a field READS is the unit's TYPE row**, out of the same registry the rest of the engine
// reads (`UnitDef`). That is what the getter half of the family means, and it is right for every
// field a map asks about here: a Blademaster's `UNIT_RF_STRENGTH_PER_LEVEL` is a property of
// Blademasters. The SETTER half is not implemented and says so: `BlzSetUnitRealField` changes
// ONE unit, while our routing writes the TYPE (`UNIT_SETTERS` in data/objectData.ts), and
// bridging that means a per-unit override table in the sim — which is exactly the intrusion the
// compatibility layer must not make (src/compat/README.md). A setter therefore logs once and
// answers false, which is what a 2003 map gets from any native we have not written.
//
// A row with a null `reads` is DECLARED and not answered: the map compiles and runs, the read
// logs once and returns the typed default. That is deliberate — a constant a map mentions is
// better declared than missing, because an undefined global in Lua is a hard error and in JASS
// is a silent null.

/** What the engine side is asked for. Each is a field of `UnitDef` unless the comment says
 *  otherwise; `null` means we have nothing to answer with yet. */
export type UnitFieldKey =
  | "primaryAttribute" | "level" | "defenseType" | "armorType" | "targetedAs"
  | "goldBountyBase" | "goldBountyDice" | "goldBountySides"
  | "lumberBountyBase" | "lumberBountyDice" | "lumberBountySides"
  | "foodUsed" | "foodProduced" | "goldCost" | "lumberCost" | "buildTime"
  | "strengthPerLevel" | "agilityPerLevel" | "intelligencePerLevel"
  | "startingStrength" | "startingAgility" | "startingIntelligence"
  | "scalingValue" | "selectionScale" | "animationRunSpeed" | "animationWalkSpeed"
  | "acquisitionRange" | "turnRate" | "deathTime" | "castPoint" | "castBackswing"
  | "attackRange" | "attackCooldown" | "attackDamageBase" | "attackDice" | "attackSides"
  | "collisionSize" | "speed" | "sightRadiusDay" | "sightRadiusNight"
  | "hitPointsMaximum" | "manaMaximum" | "manaInitial" | "manaRegeneration"
  | "hitPointsRegeneration" | "defense" | "isBuilding" | "canSleep" | "isHero";

export interface BlzFieldDef {
  /** The constant a map writes. */
  name: string;
  /** The `UnitDef` property this answers with, or null for "declared, not answered". */
  reads: UnitFieldKey | null;
}

/**
 * The INTEGER unit fields (`unitintegerfield`, `BlzGetUnitIntegerField`).
 *
 * `UNIT_IF_PRIMARY_ATTRIBUTE` is the one whose VALUES are not ours, because a map compares
 * against them as literals. Balanced Hero Survival v0.70 settles it in its own trait trigger,
 * where each branch modifies the attribute it has just tested for:
 *
 *     if (BlzGetUnitIntegerField(u, UNIT_IF_PRIMARY_ATTRIBUTE) == 1) → bj_HEROSTAT_STR
 *     if (… == 2) → bj_HEROSTAT_INT
 *     if (… == 3) → bj_HEROSTAT_AGI
 *
 * so **1 = strength, 2 = intelligence, 3 = agility**, and 0 for a unit with no primary
 * attribute at all. Note that this is NOT the order the World Editor lists them in —
 * `UI\UnitEditorData.txt` `[attributeType]` is `00=AGI, 01=INT, 02=STR`, which is the
 * DROPDOWN's order and a different thing from the value the native answers with. Test of
 * Balance v1.24 uses the same three values on the same field, which corroborates the set
 * without disambiguating it.
 */
export const UNIT_INTEGER_FIELDS: ReadonlyArray<BlzFieldDef> = [
  { name: "UNIT_IF_PRIMARY_ATTRIBUTE", reads: "primaryAttribute" },
  { name: "UNIT_IF_LEVEL", reads: "level" },
  { name: "UNIT_IF_DEFENSE_TYPE", reads: "defenseType" },
  { name: "UNIT_IF_ARMOR_TYPE", reads: "armorType" },
  { name: "UNIT_IF_TARGETED_AS", reads: "targetedAs" },
  { name: "UNIT_IF_GOLD_BOUNTY_AWARDED_BASE", reads: "goldBountyBase" },
  { name: "UNIT_IF_GOLD_BOUNTY_AWARDED_NUMBER_OF_DICE", reads: "goldBountyDice" },
  { name: "UNIT_IF_GOLD_BOUNTY_AWARDED_SIDES_PER_DIE", reads: "goldBountySides" },
  { name: "UNIT_IF_LUMBER_BOUNTY_AWARDED_BASE", reads: "lumberBountyBase" },
  { name: "UNIT_IF_LUMBER_BOUNTY_AWARDED_NUMBER_OF_DICE", reads: "lumberBountyDice" },
  { name: "UNIT_IF_LUMBER_BOUNTY_AWARDED_SIDES_PER_DIE", reads: "lumberBountySides" },
  { name: "UNIT_IF_FOOD_USED", reads: "foodUsed" },
  { name: "UNIT_IF_FOOD_PRODUCED", reads: "foodProduced" },
  { name: "UNIT_IF_GOLD_COST", reads: "goldCost" },
  { name: "UNIT_IF_LUMBER_COST", reads: "lumberCost" },
  { name: "UNIT_IF_HIT_POINTS_MAXIMUM", reads: "hitPointsMaximum" },
  { name: "UNIT_IF_MANA_MAXIMUM", reads: "manaMaximum" },
  { name: "UNIT_IF_MANA_INITIAL_AMOUNT", reads: "manaInitial" },
  { name: "UNIT_IF_DEFENSE", reads: "defense" },
  { name: "UNIT_IF_SIGHT_RADIUS_DAY", reads: "sightRadiusDay" },
  { name: "UNIT_IF_SIGHT_RADIUS_NIGHT", reads: "sightRadiusNight" },
  { name: "UNIT_IF_STRENGTH_PER_LEVEL", reads: null }, // a real on our side; see the real list
  { name: "UNIT_IF_AGILITY_PER_LEVEL", reads: null },
  { name: "UNIT_IF_INTELLIGENCE_PER_LEVEL", reads: null },
  { name: "UNIT_IF_POINT_VALUE", reads: null },
  { name: "UNIT_IF_FORMATION_RANK", reads: null },
  { name: "UNIT_IF_ORIENTATION_INTERPOLATION", reads: null },
  { name: "UNIT_IF_ELEVATION_SAMPLE_POINTS", reads: null },
  { name: "UNIT_IF_TINTING_COLOR_RED", reads: null },
  { name: "UNIT_IF_TINTING_COLOR_GREEN", reads: null },
  { name: "UNIT_IF_TINTING_COLOR_BLUE", reads: null },
  { name: "UNIT_IF_TINTING_COLOR_ALPHA", reads: null },
  { name: "UNIT_IF_MOVE_TYPE", reads: null },
  { name: "UNIT_IF_TARGETED_AS_2", reads: null },
  { name: "UNIT_IF_UPGRADES_USED", reads: null },
];

/** The REAL unit fields (`unitrealfield`, `BlzGetUnitRealField`). */
export const UNIT_REAL_FIELDS: ReadonlyArray<BlzFieldDef> = [
  { name: "UNIT_RF_STRENGTH_PER_LEVEL", reads: "strengthPerLevel" },
  { name: "UNIT_RF_AGILITY_PER_LEVEL", reads: "agilityPerLevel" },
  { name: "UNIT_RF_INTELLIGENCE_PER_LEVEL", reads: "intelligencePerLevel" },
  { name: "UNIT_RF_SCALING_VALUE", reads: "scalingValue" },
  { name: "UNIT_RF_SELECTION_SCALE", reads: "selectionScale" },
  { name: "UNIT_RF_ANIMATION_RUN_SPEED", reads: "animationRunSpeed" },
  { name: "UNIT_RF_ANIMATION_WALK_SPEED", reads: "animationWalkSpeed" },
  { name: "UNIT_RF_ACQUISITION_RANGE", reads: "acquisitionRange" },
  { name: "UNIT_RF_TURN_RATE", reads: "turnRate" },
  { name: "UNIT_RF_DEATH_TIME", reads: "deathTime" },
  { name: "UNIT_RF_CAST_POINT", reads: "castPoint" },
  { name: "UNIT_RF_CAST_BACK_SWING", reads: "castBackswing" },
  { name: "UNIT_RF_SPEED", reads: "speed" },
  { name: "UNIT_RF_COLLISION_SIZE", reads: "collisionSize" },
  { name: "UNIT_RF_HIT_POINTS_REGENERATION_RATE", reads: "hitPointsRegeneration" },
  { name: "UNIT_RF_MANA_REGENERATION", reads: "manaRegeneration" },
  { name: "UNIT_RF_BUILD_TIME", reads: "buildTime" },
  { name: "UNIT_RF_MINIMUM_ATTACK_RANGE", reads: null },
  { name: "UNIT_RF_OCCLUSION_HEIGHT", reads: null },
  { name: "UNIT_RF_FLY_HEIGHT", reads: null },
  { name: "UNIT_RF_ELEVATION_SAMPLE_RADIUS", reads: null },
  { name: "UNIT_RF_MAXIMUM_PITCH_ANGLE_DEGREES", reads: null },
  { name: "UNIT_RF_MAXIMUM_ROLL_ANGLE_DEGREES", reads: null },
  { name: "UNIT_RF_SHADOW_IMAGE_HEIGHT", reads: null },
  { name: "UNIT_RF_SHADOW_IMAGE_WIDTH", reads: null },
  { name: "UNIT_RF_SHADOW_IMAGE_CENTER_X", reads: null },
  { name: "UNIT_RF_SHADOW_IMAGE_CENTER_Y", reads: null },
  { name: "UNIT_RF_PRIORITY", reads: null },
];

/** The BOOLEAN unit fields (`unitbooleanfield`, `BlzGetUnitBooleanField`). */
export const UNIT_BOOLEAN_FIELDS: ReadonlyArray<BlzFieldDef> = [
  { name: "UNIT_BF_IS_A_BUILDING", reads: "isBuilding" },
  { name: "UNIT_BF_SLEEPS", reads: "canSleep" },
  { name: "UNIT_BF_IS_A_HERO_UNIT", reads: "isHero" },
  { name: "UNIT_BF_RAISABLE", reads: null },
  { name: "UNIT_BF_DECAYABLE", reads: null },
  { name: "UNIT_BF_CAN_BE_BUILT_ON", reads: null },
  { name: "UNIT_BF_CAN_BUILD_ON", reads: null },
  { name: "UNIT_BF_CAN_FLEE", reads: null },
  { name: "UNIT_BF_HIDE_HERO_BAR", reads: null },
  { name: "UNIT_BF_HIDE_HERO_MINIMAP_DISPLAY", reads: null },
  { name: "UNIT_BF_HIDE_HERO_DEATH_MESSAGE", reads: null },
  { name: "UNIT_BF_HIDE_MINIMAP_DISPLAY", reads: null },
  { name: "UNIT_BF_USE_EXTENDED_LINE_OF_SIGHT", reads: null },
  { name: "UNIT_BF_NEUTRAL_BUILDING_SHOWS_MINIMAP_ICON", reads: null },
  { name: "UNIT_BF_HERO_HIDE_HERO_INTERFACE_ICON", reads: null },
];

/** The STRING unit fields (`unitstringfield`, `BlzGetUnitStringField`). */
export const UNIT_STRING_FIELDS: ReadonlyArray<BlzFieldDef> = [
  { name: "UNIT_SF_NAME", reads: null }, // `BlzGetUnitName` already answers this
  { name: "UNIT_SF_PROPER_NAMES", reads: null },
  { name: "UNIT_SF_GROUND_TEXTURE", reads: null },
  { name: "UNIT_SF_SHADOW_IMAGE_UNIT", reads: null },
];

/** Every family, in the order their `Convert*` natives are declared. */
export const UNIT_FIELD_FAMILIES = [
  { convert: "ConvertUnitIntegerField", type: "unitintegerfield", fields: UNIT_INTEGER_FIELDS },
  { convert: "ConvertUnitRealField", type: "unitrealfield", fields: UNIT_REAL_FIELDS },
  { convert: "ConvertUnitBooleanField", type: "unitbooleanfield", fields: UNIT_BOOLEAN_FIELDS },
  { convert: "ConvertUnitStringField", type: "unitstringfield", fields: UNIT_STRING_FIELDS },
] as const;

/**
 * The ABILITY fields (`abilityintegerlevelfield` and its seven siblings — the 1.31 ability-field
 * API, which reads and rewrites ONE unit's or ONE item's ability; natives/abilityFields.ts).
 *
 * Unlike the unit fields these carry no index of ours: each one's value is its column's own id
 * in `Units\AbilityMetaData.slk` as a rawcode, because that id is how the engine already routes a
 * field — the World Editor writes it into a map's w3a for the same column, and
 * data/objectData.ts writeAbilityField takes it straight through applyAbilityMods. The name's
 * suffix IS that id where the name has one (`_REJ1` → `Rej1`); where it has none the id is the
 * meta row whose column and `useSpecific` abilities match what the maps apply it to (a Claws of
 * Attack's `Iatt`, a Sobi Mask's `Imrp`, `acdn` for the "Cool" column).
 *
 * Only what a map in the corpus names is declared — a name we cannot check against anything is
 * better left undeclared than declared wrongly (`tools/jass-ability-fields-test.cjs` asserts every
 * id is a real meta row).
 */
export interface AbilityFieldDef {
  name: string;
  /** Which of the eight families — the JASS type and its `Convert…` native. */
  family: "boolean" | "string" | "integerlevel" | "reallevel" | "stringlevel";
  /** The `AbilityMetaData.slk` id. */
  id: string;
}

export const ABILITY_FAMILIES = {
  boolean: { type: "abilitybooleanfield", convert: "ConvertAbilityBooleanField" },
  string: { type: "abilitystringfield", convert: "ConvertAbilityStringField" },
  integerlevel: { type: "abilityintegerlevelfield", convert: "ConvertAbilityIntegerLevelField" },
  reallevel: { type: "abilityreallevelfield", convert: "ConvertAbilityRealLevelField" },
  stringlevel: { type: "abilitystringlevelfield", convert: "ConvertAbilityStringLevelField" },
} as const;

export const ABILITY_FIELDS: ReadonlyArray<AbilityFieldDef> = [
  // "Stats - Item Ability" / "Stats - Hero Ability" — AbilityMetaData `aite` / `aher`.
  { name: "ABILITY_BF_ITEM_ABILITY", family: "boolean", id: "aite" },
  // The item stat columns (Test of Balance's stacking items rewrite these per charge).
  { name: "ABILITY_ILF_ATTACK_BONUS", family: "integerlevel", id: "Iatt" },
  { name: "ABILITY_ILF_AGILITY_BONUS", family: "integerlevel", id: "Iagi" },
  { name: "ABILITY_ILF_INTELLIGENCE_BONUS", family: "integerlevel", id: "Iint" },
  { name: "ABILITY_ILF_STRENGTH_BONUS_ISTR", family: "integerlevel", id: "Istr" },
  { name: "ABILITY_ILF_DEFENSE_BONUS_IDEF", family: "integerlevel", id: "Idef" },
  { name: "ABILITY_ILF_HIT_POINTS_GAINED_IHPG", family: "integerlevel", id: "Ihpg" },
  { name: "ABILITY_ILF_MANA_POINTS_GAINED_IMPG", family: "integerlevel", id: "Impg" },
  { name: "ABILITY_RLF_ATTACK_SPEED_INCREASE_ISX1", family: "reallevel", id: "Isx1" },
  { name: "ABILITY_RLF_MANA_REGENERATION_BONUS_AS_FRACTION_OF_NORMAL", family: "reallevel", id: "Imrp" },
  { name: "ABILITY_RLF_ATTACK_DAMAGE_INCREASE_CAC1", family: "reallevel", id: "Cac1" },
  // Chain Lightning's two (an item's `AIcl` is `code = AOcl`, whose rows these are).
  { name: "ABILITY_RLF_DAMAGE_PER_TARGET_OCL1", family: "reallevel", id: "Ocl1" },
  { name: "ABILITY_ILF_NUMBER_OF_TARGETS_HIT", family: "integerlevel", id: "Ocl2" },
  // Rejuvenation's heal (Test of Balance's pillar grows it each wave).
  { name: "ABILITY_RLF_HIT_POINTS_GAINED_REJ1", family: "reallevel", id: "Rej1" },
  // The generic per-level columns.
  { name: "ABILITY_RLF_COOLDOWN", family: "reallevel", id: "acdn" },
  { name: "ABILITY_SLF_TOOLTIP_NORMAL_EXTENDED", family: "stringlevel", id: "aub1" },
];

/** A metadata id as the rawcode integer a `Convert…Field(n)` carries (and back, in the native). */
function rawcode(id: string): number {
  let v = 0;
  for (let i = 0; i < 4; i++) v = (v * 256 + id.charCodeAt(i)) | 0;
  return v;
}

/** The JASS `globals` block that declares every constant above — generated, so the prelude and
 *  the native can never disagree about an index. */
export function fieldConstantsJass(): string {
  const lines = ["globals"];
  for (const family of UNIT_FIELD_FAMILIES) {
    for (const [i, f] of family.fields.entries()) {
      lines.push(`    constant ${family.type} ${f.name} = ${family.convert}(${i})`);
    }
  }
  for (const f of ABILITY_FIELDS) {
    const fam = ABILITY_FAMILIES[f.family];
    lines.push(`    constant ${fam.type} ${f.name} = ${fam.convert}(${rawcode(f.id)}) // '${f.id}'`);
  }
  lines.push("endglobals");
  return lines.join("\n");
}

/** The field a given family's index names, for the native's side of the same table. */
export function unitFieldAt(convert: string, index: number): BlzFieldDef | undefined {
  return UNIT_FIELD_FAMILIES.find((f) => f.convert === convert)?.fields[index];
}
