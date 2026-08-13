// Closed value domains from the WC3 data tables (plan §4). Every enum here is a
// field the SLKs actually store as a short lowercase token — `atkType1`, `defType`,
// `weapTp1`, `movetp`, `primary` — so the enum's *values* are the literal strings
// the MPQ ships and its *members* are the World Editor's own names for them
// (Units\UnitEditorData.txt + UI\WorldEditStrings.txt WESTRING_UE_*).
//
// Why enums and not bare strings: these types flow from the data loader through the
// sim (damage table, melee/ranged, flying) into the HUD (info-card icons). Typing
// them stops a typo'd "peirce" or a forgotten .toLowerCase() from silently degrading
// to a 1.0 damage multiplier. Parse once at the SLK boundary (`toAttackType(...)`),
// then it's a compile-time-checked value everywhere downstream.

/** UnitWeapons.slk `atkType1`/`atkType2` — picks the row of the damage table
 *  (Units\MiscGame.txt DamageBonus*). "" = the unit has no weapon (SLK "-"). */
export enum AttackType {
  None = "",
  Normal = "normal",
  Pierce = "pierce",
  Siege = "siege",
  Magic = "magic",
  Chaos = "chaos",
  Hero = "hero",
  Spells = "spells",
}

/** UnitBalance.slk `defType` — picks the column of the damage table. The World
 *  Editor renames three of these in its UI: Small = "Light", Large = "Heavy",
 *  None = "Unarmored". `Normal` armour exists in the table but no stock unit
 *  carries it. Unknown = a row with no defType at all (no damage-table entry). */
export enum ArmorType {
  Unknown = "",
  None = "none",
  Small = "small",
  Medium = "medium",
  Large = "large",
  Fort = "fort",
  Normal = "normal",
  Hero = "hero",
  Divine = "divine",
}

/** UnitWeapons.slk `weapTp1` — how the weapon delivers its damage, and the one column
 *  that decides whether the unit's `Missileart` is ever seen. Three families:
 *    - `normal`   — MELEE. Strikes instantly at contact range and shows NO missile art.
 *    - `instant`  — RANGED hitscan. Damage lands the moment the swing fires, with no
 *                   projectile in flight; the art is a one-shot burst at the target.
 *    - the rest   — fly a projectile (see launchesMissile). */
export enum WeaponType {
  None = "",
  Normal = "normal",
  Instant = "instant",
  Missile = "missile",
  MissileSplash = "msplash",
  MissileBounce = "mbounce",
  MissileLine = "mline",
  Artillery = "artillery",
  ArtilleryLine = "aline",
}

/** UnitData.slk `movetp` — "" for buildings and other immovable units. */
export enum MoveType {
  None = "",
  Foot = "foot",
  Horse = "horse",
  Fly = "fly",
  Hover = "hover",
  Float = "float",
  Amphibious = "amph",
}

/** UnitBalance.slk `regenType` — WHEN the unit's own `regenHP` applies. This one
 *  column is the whole of WC3's racial hit-point-regeneration rule, and every stock
 *  row uses exactly one of these four tokens (verified against the 1.27a
 *  Units\UnitBalance.slk: 502 `always`, 242 `none`, 51 `night`, 41 `blight`):
 *
 *    always  Human and Orc units, all creeps, and the heroes of those races.
 *    night   Night elf — they heal after dark and not at all in the sun.
 *    blight  Undead — only while standing on the blight their buildings spread.
 *    none    Every non-elf building (which is why they need a worker to repair).
 */
export enum RegenType {
  None = "none",
  Always = "always",
  Night = "night",
  Blight = "blight",
}

/** UnitBalance.slk `primary` — a hero's primary attribute ("" = not a hero). */
export enum PrimaryAttribute {
  None = "",
  Strength = "STR",
  Agility = "AGI",
  Intelligence = "INT",
}

/** war3mapUnits.doo / JASS `Player(n)` owner slots. 0–11 are the playable slots
 *  (bj_MAX_PLAYERS = 12); 12–15 are the four fixed neutral players. Verified
 *  against Scripts\Blizzard.j (bj_PLAYER_NEUTRAL_VICTIM = 13, _EXTRA = 14). */
export enum PlayerSlot {
  /** Creeps. JASS PLAYER_NEUTRAL_AGGRESSIVE. */
  NeutralHostile = 12,
  NeutralVictim = 13,
  NeutralExtra = 14,
  /** Shops, taverns, labs, fountains, critters. JASS PLAYER_NEUTRAL_PASSIVE. */
  NeutralPassive = 15,
}

/** The first neutral slot — anything at or above it is owned by a neutral player. */
export const FIRST_NEUTRAL_SLOT = PlayerSlot.NeutralHostile;

// --- SLK-token parsers ------------------------------------------------------
// The SLK cells are already lowercase in the stock tables, but custom object data
// (and our own `-` → "" normalisation) can hand us anything: fold case and fall
// back to the enum's None member rather than leaking an unmapped string.

const attackTypes = new Set<string>(Object.values(AttackType));
const armorTypes = new Set<string>(Object.values(ArmorType));
const weaponTypes = new Set<string>(Object.values(WeaponType));
const moveTypes = new Set<string>(Object.values(MoveType));
const regenTypes = new Set<string>(Object.values(RegenType));

export function toAttackType(v: string): AttackType {
  const s = v.toLowerCase();
  return attackTypes.has(s) ? (s as AttackType) : AttackType.None;
}

export function toArmorType(v: string): ArmorType {
  const s = v.toLowerCase();
  return armorTypes.has(s) ? (s as ArmorType) : ArmorType.Unknown;
}

export function toWeaponType(v: string): WeaponType {
  const s = v.toLowerCase();
  return weaponTypes.has(s) ? (s as WeaponType) : WeaponType.None;
}

export function toMoveType(v: string): MoveType {
  const s = v.toLowerCase();
  return moveTypes.has(s) ? (s as MoveType) : MoveType.None;
}

export function toRegenType(v: string): RegenType {
  const s = v.toLowerCase();
  return regenTypes.has(s) ? (s as RegenType) : RegenType.None;
}

export function toPrimaryAttribute(v: string): PrimaryAttribute {
  const s = v.toUpperCase(); // the SLK stores these UPPERCASE, unlike every other token
  return s === "STR" || s === "AGI" || s === "INT" ? (s as PrimaryAttribute) : PrimaryAttribute.None;
}

/** Weapon kinds that fire a travelling projectile — the ONLY kinds whose `Missileart`
 *  is a flying model. Verified against the install: every one of the six stock `instant`
 *  slots (hrif, hgyr, hmtt, hrtt, zhyd, zmar) names a `*Impact.mdx` whose SEQS chunk holds
 *  a lone "Birth" — no "Stand" to loop in flight and no "Death" to end on — while every
 *  real missile (ArrowMissile, WardenMissile, GyroCopterMissile) carries Stand + Death. */
const MISSILE_WEAPONS = new Set<WeaponType>([
  WeaponType.Missile,
  WeaponType.MissileSplash,
  WeaponType.MissileBounce,
  WeaponType.MissileLine,
  WeaponType.Artillery,
  WeaponType.ArtilleryLine,
]);

export function launchesMissile(t: WeaponType): boolean {
  return MISSILE_WEAPONS.has(t);
}

/** Whether the weapon strikes from a distance rather than at contact. `instant` counts:
 *  the Rifleman's weapTp1 is `instant` at 400 range — he shoots, the shot just doesn't fly
 *  (thehelper: "he attacks, and immediately the target will be hit […] without any flying
 *  thing"). Only `normal` (and an absent slot) is melee. */
export function isRangedWeapon(t: WeaponType): boolean {
  return MISSILE_WEAPONS.has(t) || t === WeaponType.Instant;
}
