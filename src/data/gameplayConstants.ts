import { ArmorType, AttackType } from "./enums";

// WC3's "Gameplay Constants" — the numbers the engine reads out of two INI files
// rather than out of any unit/ability row. This module is their single transcription:
//
//   MISC_GAME  ← Units\MiscGame.txt [Misc]   (combat, XP, hero attributes, refunds)
//   MISC_DATA  ← Units\MiscData.txt [Misc]   (timing, ranges, day/night, decay)
//   MELEE      ← Scripts\Blizzard.j bj_*     (melee-game setup: gold, lumber, radii)
//
// All three are read straight from the real 1.27a MPQs (War3.mpq / War3x.mpq /
// War3Patch.mpq — the patch layer wins). The World Editor exposes MiscGame/MiscData
// under Advanced → Gameplay Constants; each key below keeps its **exact file name**
// so a value can be checked against the game in one grep, and `pnpm data:verify`
// re-checks every one of them against the unpacked archives (tools/verify-gameplay
// -constants.mjs). Keys are verbatim; anything derived from them lives at the bottom
// of this file, computed rather than re-typed, so the two can never drift apart.
//
// Not every key in the two files is here — MiscGame.txt was audited key-by-key
// (issue #56) and the remainder are deliberately deferred until the systems they
// govern exist, so a stray constant never reads as "implemented" when it isn't:
//   • ability-system toggles — the ~20 `CanDeactivate*`, the `Illusions*` block,
//     `MagicImmunesResist*`, the `Drain*`/`*Cluster`/`Morph*` behaviour flags;
//   • hero altar/tavern economics — `HeroMaxAwakenCost*`, `Awaken*Factor`,
//     `HeroRevive*`/`HeroAwaken*` start-life/mana factors (no altar revival yet);
//   • misc combat flags — `DefendDeflection`, `AbolishMagicDispelSmart`,
//     `UnitSaleAggroRange`, `RelativeUpgradeCost`, `DisplayEnemyInventory`.
// Everything the sim, renderer, or HUD reads should live here rather than as a
// literal in place.

/** `Units\MiscGame.txt` [Misc]. Combat, experience, hero attributes, refund rates. */
export const MISC_GAME = {
  // --- combat -------------------------------------------------------------
  /** Each point of armour absorbs this share of the incoming hit, with diminishing
   *  returns — WE: "Combat - Armor Damage Reduction Multiplier". See armorDamageReduction. */
  DefenseArmor: 0.06,
  /** How far a unit's cry for help reaches (an attacked unit's allies come running). */
  CallForHelp: 600,
  /** Same, for Neutral Hostile: one creep aggroes → the whole camp joins. */
  CreepCallForHelp: 600,
  /** A missed attack still deals this fraction of its damage. */
  MissDamageReduction: 0.5,

  // Damage bonus lists, in the file's own column order (see ARMOR_TYPE_ORDER):
  //   SMALL, MEDIUM, LARGE, FORT, NORMAL, HERO, DIVINE, NONE
  // These ARE in the MPQ — no need for the classic battle.net chart, which agrees
  // with them exactly (and which Reforged 2.x has since diverged from).
  DamageBonusNormal: [1.0, 1.5, 1.0, 0.7, 1.0, 1.0, 0.05, 1.0],
  DamageBonusPierce: [2.0, 0.75, 1.0, 0.35, 1.0, 0.5, 0.05, 1.5],
  DamageBonusSiege: [1.0, 0.5, 1.0, 1.5, 1.0, 0.5, 0.05, 1.5],
  DamageBonusMagic: [1.25, 0.75, 2.0, 0.35, 1.0, 0.5, 0.05, 1.0],
  DamageBonusChaos: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  DamageBonusSpells: [1.0, 1.0, 1.0, 1.0, 1.0, 0.7, 0.05, 1.0],
  DamageBonusHero: [1.0, 1.0, 1.0, 0.5, 1.0, 1.0, 0.05, 1.0],

  // --- ethereal (Banish) ---------------------------------------------------
  // A banished/ethereal unit's incoming damage is scaled by this per the ATTACKER's
  // attack type — a SECOND multiplier on top of DamageBonus*. The file's own column
  // order is different from the DamageBonus rows (no target-armour axis): it is keyed
  // by attack type — NORMAL, PIERCE, SIEGE, MAGIC, CHAOS, SPELLS, HERO (see
  // ETHEREAL_ATTACK_ORDER). 0 → immune (every physical type), 1.66 → +66% (Magic &
  // Spells only). This is why Banish makes a unit untouchable by melee/piercing but
  // fragile to spellcasters. `EtherealHealBonus` scales healing landed on it the same
  // ×1.66 way. See etherealDamageMultiplier / ETHEREAL_HEAL_BONUS below.
  EtherealDamageBonus: [0, 0, 0, 1.66, 0, 1.66, 0],
  EtherealHealBonus: 1.66,

  // --- creep guard / leash ------------------------------------------------
  // The file's own comment: "After a unit has strayed 'GuardDistance' from where it
  // started, that unit begins thinking about heading back to its start position. If
  // the unit has moved 'GuardDistance' away from home at any time and spends
  // 'GuardReturnTime' seconds chasing a target without getting attacked by anyone,
  // the unit indeed turns around and heads home. If a creep goes beyond
  // 'MaxGuardDistance' then it always returns home regardless of who's attacking it."
  GuardDistance: 600,
  MaxGuardDistance: 1000,
  GuardReturnTime: 5.0,

  // --- experience & levels -------------------------------------------------
  /** XP is shared with the killer's heroes anywhere on the map when none is in range. */
  GlobalExperience: 1,
  /** A max-level hero still claims a share of the pool (which it then discards),
   *  shrinking what its lower-level team-mates get. Real behaviour, not a bug. */
  MaxLevelHeroesDrainExp: 1,
  /** Killing a structure grants no XP. */
  BuildingKillsGiveExp: 0,
  /** Heroes within this distance of a kill split its XP; beyond it, GlobalExperience. */
  HeroExpRange: 1200,
  MaxHeroLevel: 10,
  MaxUnitLevel: 20,
  /** A summoned victim is worth this fraction of its level's payout. */
  SummonedKillFactor: 0.5,

  // The three XP tables + their extrapolation formulas. The file's own comment:
  //   "Formula constants for hero levels beyond the tables... f(x) = A*f(x-1) + B*x + C"
  // NeedHeroXP is the CUMULATIVE xp to reach a level (its single entry is level 2);
  // the Grant tables are indexed by the *victim's* level.
  NeedHeroXP: [200],
  NeedHeroXPFormulaA: 1,
  NeedHeroXPFormulaB: 100,
  NeedHeroXPFormulaC: 0,
  GrantHeroXP: [100, 120, 160, 220, 300],
  GrantHeroXPFormulaA: 1,
  GrantHeroXPFormulaB: 0,
  GrantHeroXPFormulaC: 100,
  GrantNormalXP: [25],
  GrantNormalXPFormulaA: 1,
  GrantNormalXPFormulaB: 5,
  GrantNormalXPFormulaC: 5,
  /** Percent of a creep kill's XP a hero of level 1..5 keeps; 0 from level 5 on, so
   *  a grown hero cannot farm camps. No formula — beyond the table it stays at 0. */
  HeroFactorXP: [80, 70, 60, 50, 0],

  // --- hero attributes ------------------------------------------------------
  StrAttackBonus: 1.0,
  StrHitPointBonus: 25,
  StrRegenBonus: 0.05, // hp/sec per point of Strength
  IntManaBonus: 15,
  IntRegenBonus: 0.05, // mana/sec per point of Intelligence
  AgiDefenseBonus: 0.3,
  AgiDefenseBase: -2,
  AgiMoveBonus: 0,
  AgiAttackSpeedBonus: 0.02,

  /** Required hero level for ability level N is `baseReq + HeroAbilityLevelSkip*N`. */
  HeroAbilityLevelSkip: 2,

  // --- movement speed clamps ------------------------------------------------
  // "Maps saved with a Reign of Chaos version of the editor will use 25 for the min
  //  unit speed value since it wasn't increased to 150 until Frozen Throne."
  MinUnitSpeed: 150,
  MaxUnitSpeed: 400,
  MinBldgSpeed: 25,
  MaxBldgSpeed: 400,

  // --- frost (Frost Armor, Frost Attack) ------------------------------------
  FrostMoveSpeedDecrease: 0.5,
  FrostAttackSpeedDecrease: 0.25,

  // --- hero inventory ranges -------------------------------------------------
  /** WE: "Inventory - Drop Item Range" — how close a hero must be to the spot it
   *  was told to drop an item on. NB this is SHORTER than the pickup range. */
  DropItemRange: 100,
  /** WE: "Inventory - Give Item Range" — reach to hand an item to another hero. */
  GiveItemRange: 150,
  /** WE: "Inventory - Pick Up Item Range" — reach to grab an item off the ground. */
  PickupItemRange: 150,
  /** WE: "Inventory - Sell Item Range" — reach to pawn an item at a shop. */
  PawnItemRange: 300,
  PawnItemRate: 0.5,

  // --- refunds --------------------------------------------------------------
  ConstructionRefundRate: 0.75, // cancelled construction
  ResearchRefundRate: 1.0, // cancelled research
  ReviveRefundRate: 1.0, // cancelled hero revival
  TrainRefundRate: 1.0, // cancelled training, anywhere in the queue
  UpgradeRefundRate: 0.75, // cancelled structure upgrade
  ConstructionLifeDrainRate: 10.0, // hp/sec drained while construction is halted

  // --- hero revival ----------------------------------------------------------
  // goldRevivalCost = originalCost * (ReviveBaseFactor + ReviveLevelFactor*(level-1)),
  //   capped at originalCost * ReviveMaxFactor
  // revivalTime = originalTime * level * ReviveTimeFactor, capped at
  //   originalTime * ReviveMaxTimeFactor
  HeroMaxReviveCostGold: 700,
  HeroMaxReviveCostLumber: 0,
  HeroMaxReviveTime: 150,
  ReviveBaseFactor: 0.4,
  ReviveLevelFactor: 0.1,
  ReviveMaxFactor: 4.0,
  ReviveTimeFactor: 0.65,
  ReviveMaxTimeFactor: 2.0,
} as const;

/** `Units\MiscData.txt` [Misc]. Timing, ranges, day/night, decay, gold mines. */
export const MISC_DATA = {
  /** Range around a selected ground area to search for a target. */
  CloseEnoughRange: 100,
  BuildingUnblightRadius: 350,
  BuildingPlacementNotifyRadius: 600,
  NeutralUseNotifyRadius: 900,

  /** The angle (degrees) structures face when placed. */
  BuildingAngle: 270,
  RootAngle: 250,

  /** Half-angle (radians) a unit must be within to count as facing its target. */
  AttackHalfAngle: 0.5,
  /** Landing an attack from inside your victim's fog reveals a circle this wide
   *  around you — to the victim's side only. Shooting from the dark gives you away. */
  FoggedAttackRevealRadius: 200.0,
  DyingRevealRadius: 500.0,

  // "death and decay impact gameplay, so duration is specified"
  /** Full corpse lifetime from the moment of death (Death → Decay Flesh → Decay Bone). */
  BoneDecayTime: 88,
  StructureDecayTime: 30,
  DecayTime: 2,
  DissipateTime: 3,
  CancelTime: 6,
  BulletDeathTime: 5,
  EffectDeathTime: 5,
  FogFlashTime: 3,
  CreepCampPathingCellDistance: 26,

  // follow ranges
  FollowRange: 300,
  StructureFollowRange: 100,
  FollowItemRange: 1000,

  /** How far a target may move between the start of a cast and its effect. */
  SpellCastRangeBuffer: 300,
  /** Largest possible collision radius for any widget. */
  MaxCollisionRadius: 200,
  /** Rally-point vertical offset when set on something other than a unit. */
  RallyZOffset: 200,
  /** Duration of art animations that get scaled. */
  ScaledAnimTime: 60,
  /** Max random reaction delay (seconds). */
  ReactionDelay: 0.25,
  /** A missile's chance to miss a moving target, or one on high ground. */
  ChanceToMiss: 0.25,
  MissDamageReduction: 0.5,

  // --- day/night -------------------------------------------------------------
  /** Real seconds per game-day. With DayHours = 24 that is 20 real sec per game hour. */
  DayLength: 480,
  Dawn: 6,
  Dusk: 18,
  /** "earth has a 24 hour day, how many does Azeroth have" */
  DayHours: 24,

  // --- gold mines --------------------------------------------------------------
  GoldMineMaxGold: 1000000,
  /** Below this the mine reads as "low on gold". */
  LowGoldAmount: 1500,
  /** Seconds a mine stays "owned" after its last worker leaves. */
  GoldMineOwnDuration: 2.0,

  /** How fast units change visibility (smaller = "cloak" slower). */
  InvisSpeed: 0.4,
  /** Added to every selection circle's z coordinate. */
  SelectionCircleBaseZ: 16,

  AttackNotifyDelay: 30.0,
  AttackNotifyRange: 1250,
  TradingIncSmall: 100,
  TradingIncLarge: 200,
} as const;

/** `UI\MiscData.txt` [Minimap] + [FogOfWar]. The minimap's own palette: how a creep
 *  camp's marker is coloured and sized by the camp's combined level, and the colour
 *  every non-player unit's dot is drawn in. Colours are the file's own **ARGB**.
 *
 *  Confirmed against the real 1.27a client (a fresh melee game on Booty Bay): the
 *  creep marker is a flat ellipse in `MinimapWeakCampColor` and the creep / neutral
 *  dots sample as exactly `#000032` — `FogColorCreepNormal` with its alpha dropped.
 *  `MinimapCampPulseScale` (the marker's idle pulse) is not modelled. */
export const MINIMAP = {
  /** Combined camp level at which the marker turns orange, then red. */
  MinimapMiddleCampThreshold: 10,
  MinimapToughCampThreshold: 20,
  /** Middle and tough camps draw their marker this much larger than a weak one. */
  MinimapMiddleCampScale: 1.3,
  MinimapWeakCampColor: [255, 0, 200, 0],
  MinimapMiddleCampColor: [255, 255, 128, 0],
  MinimapToughCampColor: [255, 220, 0, 0],
  /** Minimap dot colour for Neutral Hostile creeps — and, in the client, for every
   *  other unowned unit (gold mines, shops, critters) too. */
  FogColorCreepNormal: [255, 0, 0, 50],
} as const;

/** `Scripts\Blizzard.j` `bj_*` constants (the `bj_` prefix dropped). Blizzard's own
 *  JASS melee template — the ground truth for how a melee game is set up. `_V1` is
 *  the Frozen Throne value; `_V0` is the Reign of Chaos one it replaced. */
export const MELEE = {
  MAX_INVENTORY: 6,
  MAX_PLAYERS: 12,
  MAX_PLAYER_SLOTS: 16,

  /** Time of day a melee game opens at (08:00). */
  MELEE_STARTING_TOD: 8.0,
  MELEE_STARTING_GOLD_V0: 750,
  MELEE_STARTING_GOLD_V1: 500,
  MELEE_STARTING_LUMBER_V0: 200,
  MELEE_STARTING_LUMBER_V1: 150,
  MELEE_STARTING_HERO_TOKENS: 1,
  /** At most 3 heroes per player (altars + tavern combined), 1 of each type. */
  MELEE_HERO_LIMIT: 3,
  MELEE_HERO_TYPE_LIMIT: 1,
  /** How far from a start location MeleeFindNearestMine looks for a gold mine. */
  MELEE_MINE_SEARCH_RADIUS: 2000,
  /** MeleeClearExcessUnits: creeps this close to a used start location are removed. */
  MELEE_CLEAR_UNITS_RADIUS: 1500,
  /** Delay between a creep's death and the moment it may drop an item. */
  CREEP_ITEM_DELAY: 0.5,
  /** `unitSpacing` in MeleeStartingUnits*: the grid step of the starting-worker clump. */
  MELEE_UNIT_SPACING: 64,
  /** bj_UNIT_FACING — the facing every melee starting unit is created with (degrees). */
  UNIT_FACING: 270,
} as const;

/** `Scripts\Blizzard.j` `bj_CAMERA_DEFAULT_*` — the shape of the camera a game opens on,
 *  and the one `ResetToGameCamera` comes home to. FIELD_OF_VIEW is the angle we actually
 *  render with; see docs/camera.md before touching any of these. */
export const CAMERA = {
  /** bj_CAMERA_DEFAULT_DISTANCE — eye-to-focus distance. */
  DEFAULT_DISTANCE: 1650,
  /** bj_CAMERA_DEFAULT_FOV — vertical field of view, in degrees. */
  DEFAULT_FOV: 70,
  /** bj_CAMERA_DEFAULT_AOA — angle of attack, 304 = -56° (the view tilts down). */
  DEFAULT_AOA: 304,
  /** bj_CAMERA_DEFAULT_ROTATION — 90° = looking north (+Y), which is why units, facing
   *  270° by default, face the viewer. */
  DEFAULT_ROTATION: 90,
  /** bj_CAMERA_DEFAULT_FARZ — far clip plane. */
  DEFAULT_FARZ: 5000,
} as const;

// ---------------------------------------------------------------------------
// Derived tables. Computed from the raw values above so a fix to one is a fix to
// all — never hand-transcribe a number that the game itself derives.
// ---------------------------------------------------------------------------

/** The column order of every `DamageBonus*` list, per MiscGame.txt's own comment. */
export const ARMOR_TYPE_ORDER: readonly ArmorType[] = [
  ArmorType.Small,
  ArmorType.Medium,
  ArmorType.Large,
  ArmorType.Fort,
  ArmorType.Normal,
  ArmorType.Hero,
  ArmorType.Divine,
  ArmorType.None,
];

const DAMAGE_BONUS_ROWS: ReadonlyArray<readonly [AttackType, readonly number[]]> = [
  [AttackType.Normal, MISC_GAME.DamageBonusNormal],
  [AttackType.Pierce, MISC_GAME.DamageBonusPierce],
  [AttackType.Siege, MISC_GAME.DamageBonusSiege],
  [AttackType.Magic, MISC_GAME.DamageBonusMagic],
  [AttackType.Chaos, MISC_GAME.DamageBonusChaos],
  [AttackType.Spells, MISC_GAME.DamageBonusSpells],
  [AttackType.Hero, MISC_GAME.DamageBonusHero],
];

/** attack type → armor type → damage multiplier, unpacked from the `DamageBonus*` lists. */
export const DAMAGE_TABLE: Readonly<Record<string, Readonly<Record<string, number>>>> =
  Object.fromEntries(
    DAMAGE_BONUS_ROWS.map(([attack, bonuses]) => [
      attack,
      Object.fromEntries(ARMOR_TYPE_ORDER.map((armor, i) => [armor, bonuses[i]])),
    ]),
  );

/** Damage multiplier for `attack` striking `armor`. An unknown pair (a weaponless
 *  attacker, a unit with no defType) scales by 1.0 rather than vanishing. */
export function damageMultiplier(attack: AttackType, armor: ArmorType): number {
  return DAMAGE_TABLE[attack]?.[armor] ?? 1;
}

/** The attack-type order of the `EtherealDamageBonus` list, per MiscGame.txt's own
 *  comment ("NORMAL, PIERCE, SIEGE, MAGIC, CHAOS, SPELLS, HERO"). Unlike the
 *  DamageBonus rows there is no None/target-armour axis — the list is indexed by the
 *  attacker's attack type alone. */
const ETHEREAL_ATTACK_ORDER: readonly AttackType[] = [
  AttackType.Normal,
  AttackType.Pierce,
  AttackType.Siege,
  AttackType.Magic,
  AttackType.Chaos,
  AttackType.Spells,
  AttackType.Hero,
];

const ETHEREAL_DAMAGE_TABLE: Readonly<Record<string, number>> = Object.fromEntries(
  ETHEREAL_ATTACK_ORDER.map((atk, i) => [atk, MISC_GAME.EtherealDamageBonus[i]]),
);

/** Extra multiplier a BANISHED (ethereal) target takes from `attack`, on top of the
 *  normal damage table: 0 for every physical type (immune to melee/pierce/siege) and
 *  1.66 for Magic & Spells (+66%). An attack type not in the file's list — most
 *  notably `None`, used by untyped ability damage — defaults to 1.0 so the hit is
 *  unchanged (untyped spell damage is boosted explicitly via ETHEREAL_SPELL_BONUS). */
export function etherealDamageMultiplier(attack: AttackType): number {
  return ETHEREAL_DAMAGE_TABLE[attack] ?? 1;
}

/** The multiplier untyped ability damage (`spellDamage`, dealt as AttackType.None)
 *  applies to an ethereal target — the file's Spells column, ×1.66. */
export const ETHEREAL_SPELL_BONUS = ETHEREAL_DAMAGE_TABLE[AttackType.Spells];

/** Healing landed on an ethereal target is amplified the same ×1.66 (EtherealHealBonus). */
export const ETHEREAL_HEAL_BONUS = MISC_GAME.EtherealHealBonus;

/** The share of a hit that `armor` points of armour absorb: `n·k / (1 + k·n)`, with
 *  k = DefenseArmor. Diminishing returns, so armour never reaches 100%. Negative
 *  armour (Acid Bomb, Faerie Fire) falls out of the same formula as extra damage. */
export function armorDamageReduction(armor: number): number {
  const k = MISC_GAME.DefenseArmor;
  return (armor * k) / (1 + k * Math.max(0, armor));
}

/** Expand one of the `f(x) = A·f(x-1) + B·x + C` tables out to `maxLevel`, where the
 *  table's entry `i` is the value for level `i + firstLevel`. Index 0 of the result is
 *  a level-0 placeholder (0) so callers can index it by level directly. */
function expandLevelTable(
  table: readonly number[],
  a: number,
  b: number,
  c: number,
  maxLevel: number,
  firstLevel = 1,
): number[] {
  const out: number[] = [0];
  for (let level = 1; level <= maxLevel; level++) {
    if (level < firstLevel) out.push(0);
    else if (level - firstLevel < table.length) out.push(table[level - firstLevel]);
    else out.push(a * out[level - 1] + b * level + c);
  }
  return out;
}

/** XP a kill grants, indexed by the VICTIM's level. Normal units follow GrantNormalXP
 *  (25/40/60/85/115/…); enemy heroes the far richer GrantHeroXP (100/120/160/220/300/
 *  400/…). Buildings grant none at all — BuildingKillsGiveExp = 0. */
export const GRANT_NORMAL_XP: readonly number[] = expandLevelTable(
  MISC_GAME.GrantNormalXP,
  MISC_GAME.GrantNormalXPFormulaA,
  MISC_GAME.GrantNormalXPFormulaB,
  MISC_GAME.GrantNormalXPFormulaC,
  MISC_GAME.MaxUnitLevel,
);

export const GRANT_HERO_XP: readonly number[] = expandLevelTable(
  MISC_GAME.GrantHeroXP,
  MISC_GAME.GrantHeroXPFormulaA,
  MISC_GAME.GrantHeroXPFormulaB,
  MISC_GAME.GrantHeroXPFormulaC,
  MISC_GAME.MaxHeroLevel,
);

/** Total XP a hero needs to REACH each level. NeedHeroXP's single entry (200) is the
 *  cost of level 2; the formula (A=1, B=100, C=0) carries it from there, giving the
 *  familiar closed form 50·(L² + L − 2) → 200/500/900/1400/2000/… Index by level;
 *  level 1 costs nothing. One entry past MaxHeroLevel, for the HUD's "next level" bar. */
const NEED_HERO_XP: readonly number[] = expandLevelTable(
  MISC_GAME.NeedHeroXP,
  MISC_GAME.NeedHeroXPFormulaA,
  MISC_GAME.NeedHeroXPFormulaB,
  MISC_GAME.NeedHeroXPFormulaC,
  MISC_GAME.MaxHeroLevel + 1,
  2, // the table starts at level 2 — there is no XP cost to "reach" level 1
);

export function xpToReachLevel(level: number): number {
  return NEED_HERO_XP[Math.max(0, Math.min(level, NEED_HERO_XP.length - 1))] ?? 0;
}

/** XP a kill of `victimLevel` grants, before the summon/creep factors. */
export function grantedXp(victimLevel: number, victimIsHero: boolean): number {
  const table = victimIsHero ? GRANT_HERO_XP : GRANT_NORMAL_XP;
  return table[Math.max(0, Math.min(victimLevel, table.length - 1))] ?? 0;
}

/** The share of a CREEP kill's XP a hero of this level keeps (HeroFactorXP, as a
 *  fraction). 80% at level 1, tapering to nothing from level 5 — high heroes cannot
 *  farm camps. Heroes are always level ≥ 1; level 0 is treated as level 1. */
export function creepXpFactor(heroLevel: number): number {
  const table = MISC_GAME.HeroFactorXP;
  const i = Math.max(1, Math.min(heroLevel, table.length)) - 1;
  return table[i] / 100;
}

/** Game hours elapsed per real second — a 24-hour Azeroth day in 480 real seconds. */
export const GAME_HOURS_PER_SEC = MISC_DATA.DayHours / MISC_DATA.DayLength;

/** `[a, r, g, b]` → a CSS colour. The alpha in `UI\MiscData.txt` is always 255 for
 *  the entries we use, so it is dropped rather than emitted as `rgba(…)`. */
const cssColor = ([, r, g, b]: readonly number[]): string => `rgb(${r},${g},${b})`;

/** Minimap dot colour for creeps and every other unowned unit. */
export const NEUTRAL_DOT_COLOR = cssColor(MINIMAP.FogColorCreepNormal);

/** A creep camp's minimap marker, from its combined creep level. */
export function campMarker(level: number): { color: string; scale: number } {
  const tough = level >= MINIMAP.MinimapToughCampThreshold;
  const middle = level >= MINIMAP.MinimapMiddleCampThreshold;
  return {
    color: cssColor(
      tough ? MINIMAP.MinimapToughCampColor
      : middle ? MINIMAP.MinimapMiddleCampColor
      : MINIMAP.MinimapWeakCampColor,
    ),
    // "MiddleCampScale" is the one size step the file defines: weak camps draw at
    // 1×, everything from the middle threshold up draws larger.
    scale: middle ? MINIMAP.MinimapMiddleCampScale : 1,
  };
}
