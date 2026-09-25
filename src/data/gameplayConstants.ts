import { isRoc, mapDataSet } from "./edition";
import { ArmorType, AttackType } from "./enums";

// WC3's "Gameplay Constants" — the numbers the engine reads out of two INI files
// rather than out of any unit/ability row. This module is their single transcription:
//
//   MISC_GAME  ← Units\MiscGame.txt [Misc]   (combat, XP, hero attributes, refunds)
//   MISC_DATA  ← Units\MiscData.txt [Misc]   (timing, ranges, day/night, decay)
//   MELEE      ← Scripts\Blizzard.j bj_*     (melee-game setup: gold, lumber, radii)
//
// All three are read straight from the real game data (War3.mpq / War3x.mpq /
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
//   • misc combat flags — `DefendDeflection`, `RelativeUpgradeCost`.
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
  /** What a shop pays for an item you sell back: HALF its gold value. Note this is 0.50 in
   *  the real data, not the 60% widely quoted online (that figure is from a later
   *  patch / Reforged). The MPQ wins. */
  PawnItemRate: 0.5,

  // --- shop sale aggro -------------------------------------------------------
  // How far a purchase carries to nearby creeps. Buying an item is silent; hiring a unit
  // from a Mercenary Camp is emphatically not. Distinct from MiscData's
  // NeutralUseNotifyRadius (900), which merely WAKES creeps in earshot — these two make
  // them charge. See notifyCreepsOfShopUse in src/sim/world.ts.
  ItemSaleAggroRange: 0,
  UnitSaleAggroRange: 600,
  AbilSaleAggroRange: 0,

  // --- dispels ---------------------------------------------------------------
  /**
   * **Abolish Magic's AUTOCAST is a SMART dispel** — 1, i.e. on.
   *
   * The one flag in the file that describes an autocast's judgement rather than a number, and
   * it is what tells a Dryad's automatic press apart from the player's own: on autocast she
   * takes a BUFF off — a negative one off an ally, a positive one off an enemy — and nothing
   * else. A SUMMON is the manual press's business, because killing one is a decision about the
   * fight (a Water Elemental is worth 75 mana, a Wand of Illusion's doubles are not) rather
   * than the housekeeping the toggle is for. Read by `worthDispelling`, whose `auto` half is
   * this flag; with it off the autocast goes back to hunting summons too.
   */
  AbolishMagicDispelSmart: 1,

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
  ReviveBaseLumberFactor: 0,
  ReviveLumberLevelFactor: 0,
  ReviveMaxFactor: 4.0,
  ReviveTimeFactor: 0.65,
  ReviveMaxTimeFactor: 2.0,

  // …and the TAVERN's, which is the same arithmetic at twice the rate and no timer at all
  // ("Awaken"). The two ladders are what make the choice a choice: the altar is cheap and
  // slow, the tavern is instant and costs about double — and charges LUMBER, which the altar
  // never does (ReviveBaseLumberFactor is 0 and the altar's lumber cap is 0 with it).
  HeroMaxAwakenCostGold: 1400,
  HeroMaxAwakenCostLumber: 350,
  AwakenBaseFactor: 0.8,
  AwakenLevelFactor: 0.2,
  AwakenBaseLumberFactor: 0.8,
  AwakenLumberLevelFactor: 0.2,
  AwakenMaxFactor: 8.0,

  // What a hero comes BACK with. `*ManaStart` scales the unit type's own starting mana
  // (`manaN`) and `*ManaFactor` its maximum, so an altar hero returns at full health and its
  // opening 100 mana while a tavern one returns at half health with none — which is exactly
  // how the classic manual states it ("restored to full hit points and 100 Mana" / "brought
  // back to life with 0 mana and 50% health").
  HeroReviveManaStart: 1,
  HeroReviveManaFactor: 0.0,
  HeroReviveLifeFactor: 1.0,
  HeroAwakenManaStart: 0,
  HeroAwakenManaFactor: 0.0,
  HeroAwakenLifeFactor: 0.5,

  /** Whether an ENEMY building's status — its construction timer and its production queue —
   *  is shown when you click it. Zero, and it is the whole of the rule: what a structure is
   *  making, and how many seconds it has left, is the owner's business. Its neighbour
   *  `DisplayEnemyInventory` is 1, which is the same question answered the other way for a
   *  hero's items, and the pair is why neither is a guess. */
  DisplayBuildingStatus: 0,
  DisplayEnemyInventory: 1,
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

  // --- item shadows (issue #60) -------------------------------------------------
  // "// item shadow data" in the file. Unlike a unit — whose blob is sized per row in
  // Units\UnitUI.slk (unitShadow/shadowW/H/X/Y) — EVERY item on the ground shares this
  // one global shadow: the same ReplaceableTextures\Shadows\Shadow.blp, 120×120 world
  // units, min corner at (item − 50, item − 50) so the blob centres +10,+10 (the game's
  // fixed top-right cast). See src/render/mapViewer.ts updateShadowBatch.
  /** Texture stem under ReplaceableTextures\Shadows\ (no extension). */
  ItemShadowFile: "Shadow",
  ItemShadowSize: [120, 120],
  ItemShadowOffset: [50, 50],

  AttackNotifyDelay: 30.0,
  AttackNotifyRange: 1250,
  TradingIncSmall: 100,
  TradingIncLarge: 200,
} as const;

/**
 * `Melee_V0\Units\MiscGame.txt` [Misc] — REIGN OF CHAOS's copy of the file above, for the rows it
 * disagrees on (docs/editions.md). Only the differences are restated; every other key is the
 * same in both files, and `miscGame()` falls back to MISC_GAME for it. `pnpm data:verify` checks
 * this block against the RoC file exactly as it checks MISC_GAME against the live one.
 *
 * Most of what made Reign of Chaos play differently is here rather than in the unit tables: its
 * damage table (Normal hits SMALL for 150 %, Magic hits MEDIUM for 200 %), creep XP that never
 * tapers (`HeroFactorXP=100`), experience that is shared only by heroes in range
 * (`GlobalExperience=0`), and buildings that pay experience when razed.
 */
export const MISC_GAME_V0 = {
  DamageBonusNormal: [1.5, 1.0, 1.0, 0.5, 1.0, 1.0, 0.05, 1.0],
  DamageBonusPierce: [0.75, 1.0, 1.5, 0.35, 1.0, 0.5, 0.05, 1.5],
  DamageBonusSiege: [0.5, 1.0, 1.0, 1.5, 1.0, 0.5, 0.05, 1.5],
  DamageBonusMagic: [1.0, 2.0, 1.0, 0.35, 1.0, 0.5, 0.05, 1.0],
  DamageBonusSpells: [1.0, 1.0, 1.0, 1.0, 1.0, 0.75, 0.05, 1.0],
  GlobalExperience: 0,
  MaxLevelHeroesDrainExp: 0,
  BuildingKillsGiveExp: 1,
  HeroFactorXP: [100],
  MinUnitSpeed: 10,
  MinBldgSpeed: 10,
  DisplayEnemyInventory: 0,
} as const;

/**
 * `Custom_V<n>\Units\MiscGame.txt` [Misc] — what a CUSTOM map's copy of the file says, for the
 * rows it disagrees with its own edition's MELEE copy about (docs/editions.md).
 *
 * The data set is a 2×2 — (edition × map kind) — and this is the second axis of it for the one
 * file the VFS overlay cannot reach, because these constants are compiled in. A campaign
 * chapter, a scenario and every custom map read it; a melee game does not.
 *
 * **One block serves both editions on purpose, and that is a checked claim, not a shortcut.**
 * Compared key by key against the install, every row modelled in `MISC_GAME` that a custom copy
 * states differently is stated the SAME by `Custom_V0` and `Custom_V1` — so there is one
 * "custom" answer rather than two, and `pnpm data:verify` checks this block against BOTH files.
 * (The rows where the two custom copies DO diverge — `CycloneStasis`, `MorphLandClosest`, the
 * four `*Cluster` rows — are ones `MISC_GAME` does not model at all; Reign of Chaos's custom
 * copy is the older snapshot there.)
 *
 * Three rows, and the damage one is why this exists: **Spells hitting HERO armour is 0.70 on the
 * expansion's melee tables and 0.75 everywhere else**, so a chapter graded by the melee number
 * was quietly taking five percentage points off every spell aimed at a hero.
 *
 * `ItemSaleAggroRange` is NOT here even though it looks like it should be: `Custom_V0` spells it
 * `ItemSaleAggroRanges`, with an s, and both copies say 0 — which is what `MISC_GAME` says too.
 */
export const MISC_GAME_CUSTOM = {
  // …,0.75,… against the live file's 0.70 in the SPELLS-vs-Hero cell (ARMOR_TYPE_ORDER index 5).
  DamageBonusSpells: [1.0, 1.0, 1.0, 1.0, 1.0, 0.75, 0.05, 1.0],
  // Abolish Magic's autocast is a PLAIN dispel on a custom map — it will take a summon off the
  // field rather than holding off for a buff to strip (sim/spells.ts).
  AbolishMagicDispelSmart: 0,
  // Hiring from a shop is SILENT on a custom map: 600 is the melee file's, and it is the radius
  // within which creeps hear the transaction (SimWorld.notifyCreepsOfShopUse).
  UnitSaleAggroRange: 0,
} as const;

/** The engine's food ceiling for the edition the client is on — 100, or Reign of Chaos's 90. */
export function engineFoodCeiling(): number {
  return isRoc() ? MISC_ENGINE.FoodCeiling_V0 : MISC_ENGINE.FoodCeiling;
}

/**
 * The `[Misc]` row `key` for the data set this match is on — the edition AND the map kind
 * (data/edition.ts, docs/editions.md).
 *
 * The MAP KIND is asked first because it is the narrower statement: `MISC_GAME_CUSTOM` holds
 * only rows whose custom copy differs from its own edition's melee copy, so anything in it is
 * already an answer for both editions, while `MISC_GAME_V0` is the answer for a Reign of Chaos
 * copy of whichever kind. The two blocks overlap on exactly one row (`DamageBonusSpells`) and
 * agree about it, so the order is a statement of intent rather than a tie-break.
 */
export function miscGame<K extends keyof typeof MISC_GAME>(key: K): (typeof MISC_GAME)[K] | number | readonly number[] {
  const own = mapValue(key, MISC_GAME[key]);
  if (own !== undefined) return own;
  if (mapDataSet() === "custom" && key in MISC_GAME_CUSTOM) return MISC_GAME_CUSTOM[key as keyof typeof MISC_GAME_CUSTOM];
  if (isRoc() && key in MISC_GAME_V0) return MISC_GAME_V0[key as keyof typeof MISC_GAME_V0];
  return MISC_GAME[key];
}

/** `Units\MiscData.txt`'s row `key` for this match — the MAP's own value when its
 *  war3mapMisc.txt states one (MiscData has no edition or map-kind copies). */
export function miscData<K extends keyof typeof MISC_DATA>(key: K): (typeof MISC_DATA)[K] | number | readonly number[] {
  const own = mapValue(key, MISC_DATA[key]);
  return own !== undefined ? own : MISC_DATA[key];
}

// --- A MAP's own constants: war3mapMisc.txt (docs/map-compatibility.md pass 11) -------------
//
// The World Editor's Gameplay Constants dialog writes a map's edits out under the SAME key the
// base file uses (Units\MiscMetaData.slk gives each its `field` name), so a map's `[Misc]` block
// is simply the top layer of the chain `miscGame` already walks: the map's own statement, then
// the custom-map copy, then Reign of Chaos's, then the file. MiscData keys ride the same block —
// DotA's DayLength and every map's BoneDecayTime are MiscData rows — and read through
// `miscData`.
//
// Set at the map door (`setMapMiscOverlay`, before a table is parsed or a unit made) and taken
// down on the way out, exactly as the data set's map kind is (data/edition.ts). Each value is
// PARSED ONCE into the shape of the row it replaces — a comma list for a list row, one number
// otherwise — because some of these are read per unit per tick (the attribute bonuses in
// recomputeStats), and a value that does not parse is ignored rather than read as 0.

type Shaped = number | readonly number[];
let mapStated: ReadonlyMap<string, string> | null = null;
const mapParsed = new Map<string, Shaped | null>();
/** Bumped every time the overlay changes, so a table DERIVED from these rows (the damage table,
 *  the XP curves) can tell that its cached copy is stale. */
let overlayEpoch = 0;

/** Install a map's war3mapMisc.txt `[Misc]` values (data/mapMisc.ts), or take them down with
 *  null. Keys match case-insensitively, as the game's own INI lookups do. */
export function setMapMiscOverlay(values: ReadonlyMap<string, string> | null): void {
  mapStated = values && values.size ? new Map([...values].map(([k, v]) => [k.toLowerCase(), v])) : null;
  mapParsed.clear();
  overlayEpoch++;
}

/** The overlay's generation — see `overlayEpoch`. */
export function mapMiscEpoch(): number {
  return overlayEpoch;
}

/** The map's statement of `key`, shaped like `base`; undefined when it states none (or states
 *  something that does not read as the row's shape). */
function mapValue(key: string, base: unknown): Shaped | undefined {
  if (!mapStated) return undefined;
  const lower = key.toLowerCase();
  let v = mapParsed.get(lower);
  if (v === undefined) {
    const raw = mapStated.get(lower);
    v = raw === undefined ? null : parseLike(raw, base);
    mapParsed.set(lower, v);
  }
  return v ?? undefined;
}

function parseLike(raw: string, base: unknown): Shaped | null {
  const fields = raw.split(",").map((f) => Number.parseFloat(f.trim()));
  if (Array.isArray(base)) return fields.length && fields.every(Number.isFinite) ? fields : null;
  if (typeof base === "number") return Number.isFinite(fields[0]) ? fields[0] : null;
  return null; // a string row (ItemShadowFile) is not the map's to restate here
}

/**
 * Rows this module DECLARES that no code reads yet — each names a system that does not exist
 * (trading, a miss chance, a building's decay after death, the follow ranges, …) or one that
 * reads its own number instead. A map restating one changes nothing, and the map door's log
 * says so rather than reporting it applied. `tools/sim-map-misc-test.cjs` re-derives this list
 * from the source, so a row that gains a reader must leave it (and one that loses its reader
 * must join it) or the test fails.
 */
export const MISC_UNREAD: ReadonlySet<string> = new Set([
  "AbilSaleAggroRange", "AgiMoveBonus", "ConstructionLifeDrainRate", "DisplayEnemyInventory",
  "AttackHalfAngle", "BuildingAngle", "BuildingUnblightRadius", "BulletDeathTime", "CancelTime",
  "ChanceToMiss", "CloseEnoughRange", "CreepCampPathingCellDistance", "DecayTime", "EffectDeathTime",
  "FogFlashTime", "FollowItemRange", "FollowRange", "GoldMineMaxGold", "GoldMineOwnDuration",
  "InvisSpeed", "MaxCollisionRadius", "MissDamageReduction", "RallyZOffset", "ReactionDelay",
  "RootAngle", "ScaledAnimTime", "SelectionCircleBaseZ", "SpellCastRangeBuffer", "StructureDecayTime",
  "StructureFollowRange", "TradingIncLarge", "TradingIncSmall",
]);

/** Does a map stating `key` change anything this engine reads? A row we hold and read. */
export function miscKeyIsRead(key: string): boolean {
  const lower = key.toLowerCase();
  return [MISC_GAME, MISC_DATA, MISC_ENGINE].some((t) =>
    Object.keys(t).some((k) => k.toLowerCase() === lower && !MISC_UNREAD.has(k)));
}

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
type ListKey<T> = { [K in keyof T]: T[K] extends readonly number[] ? K : never }[keyof T];

/** A number row of MiscGame.txt for this match (the map's, the data set's, or the file's). */
export function gameNum(key: NumKey<typeof MISC_GAME>): number {
  return miscGame(key) as number;
}
/** A list row of MiscGame.txt for this match. */
export function gameList(key: ListKey<typeof MISC_GAME>): readonly number[] {
  return miscGame(key) as readonly number[];
}
/** A number row of MiscData.txt for this match. */
export function dataNum(key: NumKey<typeof MISC_DATA>): number {
  return miscData(key) as number;
}

/**
 * `Misc` gameplay constants whose base value the ENGINE holds — keys the World Editor's
 * Gameplay Constants dialog exposes and a map may state in its own `war3mapMisc.txt`
 * (src/data/mapMisc.ts), but which no shipped `MiscGame.txt` / `MiscData.txt` row carries. They
 * are named here rather than at their use site so that "every number the game keeps in Misc is
 * in this file" stays true, and so `pnpm data:verify` — which checks each block against the
 * file it claims — is not asked to look for a row that does not exist.
 */
export const MISC_ENGINE = {
  /**
   * `FoodCeiling` (`fcap` in Units\MiscMetaData.slk: section "Misc", int, 1..999) — the ceiling
   * a player's supply cap is clamped to. **100**, the food limit everybody knows off the melee
   * HUD, and the engine's rather than a melee rule: Blizzard.j never writes
   * `PLAYER_STATE_FOOD_CAP_CEILING` anywhere.
   *
   * A map moves it either way — TFT's HumanX04 ships a war3mapMisc.txt whose entire content is
   * `[Misc] FoodCeiling=30`, and WTii's Unit Tester raises it from its script — which is why
   * that map writes the ceiling FIRST and the cap second: at the stock 100 the 300 it wants
   * would be clamped straight back off.
   */
  FoodCeiling: 100,
  /**
   * …and Reign of Chaos's, **90** — the food limit the original shipped with and the expansion
   * raised (docs/editions.md). Like the 100 it is in no file: RoC's own MiscMetaData caps the
   * editor field at 300 and says nothing of the default.
   */
  FoodCeiling_V0: 90,
  /**
   * `UpkeepUsage` (`upku`, section "Misc", intList) and `UpkeepGoldTax` (`upkg`, unrealList) —
   * the upkeep bands: the FOOD USED past which each band starts, and the share of mined gold
   * each takes. Named in Units\MiscMetaData.slk and stated in no file, so these are the
   * engine's own numbers as the official basics page gives them: "No Upkeep (0-50 Food: 100%
   * income)", "Low Upkeep (51-80 Food: 70% income)", "High Upkeep (81-100 Food: 40% income)"
   * (classic.battle.net/war3/basics/upkeep.shtml). A map restates either in war3mapMisc.txt
   * (Test of Balance's `UpkeepGoldTax=0.00` turns the tax off at every band).
   */
  UpkeepUsage: [50, 80],
  UpkeepGoldTax: [0.3, 0.6],
  /** …and Reign of Chaos's bands, ten food lower — "In Reign of Chaos, the Upkeep levels are
   *  decreased by 10 (No Upkeep is 0-40, Low is 41-70, High is 71-90)" (warcraft.wiki.gg,
   *  Upkeep) — at the same two rates ("you'll only get to keep seven of it … down to four
   *  gold per trip", RomRom's Reign of Chaos strategy guide, GameFAQs). */
  UpkeepUsage_V0: [40, 70],
} as const;

/** One upkeep band as a player meets it: the food it covers and the share of mined gold kept. */
export interface UpkeepBand {
  from: number;
  to: number;
  /** Percent of mined gold that reaches the bank. */
  income: number;
}

/**
 * The upkeep bands for this match — the map's `UpkeepUsage`/`UpkeepGoldTax` where its
 * war3mapMisc.txt states them, else the edition's (MISC_ENGINE). The last band runs to the food
 * ceiling (the map's `FoodCeiling`, else the engine's). A tax list shorter than the bands
 * repeats its last rate, which is how a map's single `0.00` reads as "no tax anywhere".
 */
export function upkeepBands(): UpkeepBand[] {
  const usage = (mapValue("UpkeepUsage", MISC_ENGINE.UpkeepUsage) as readonly number[] | undefined)
    ?? (isRoc() ? MISC_ENGINE.UpkeepUsage_V0 : MISC_ENGINE.UpkeepUsage);
  const tax = (mapValue("UpkeepGoldTax", MISC_ENGINE.UpkeepGoldTax) as readonly number[] | undefined) ?? MISC_ENGINE.UpkeepGoldTax;
  const ceiling = (mapValue("FoodCeiling", MISC_ENGINE.FoodCeiling) as number | undefined) ?? engineFoodCeiling();
  const bands: UpkeepBand[] = [{ from: 0, to: usage[0] ?? ceiling, income: 100 }];
  for (let i = 0; i < usage.length; i++) {
    const rate = tax.length ? tax[Math.min(i, tax.length - 1)] : 0;
    bands.push({ from: usage[i] + 1, to: usage[i + 1] ?? ceiling, income: Math.round((1 - rate) * 100) });
  }
  return bands;
}

/** Which band a food count falls in (an index into `upkeepBands()`). */
export function upkeepBandIndex(foodUsed: number, bands: readonly UpkeepBand[] = upkeepBands()): number {
  let i = 0;
  while (i + 1 < bands.length && foodUsed >= bands[i + 1].from) i++;
  return i;
}

/** `UI\MiscData.txt` [Minimap] + [FogOfWar]. The minimap's own palette: how a creep
 *  camp's marker is coloured and sized by the camp's combined level, and the colour
 *  every non-player unit's dot is drawn in. Colours are the file's own **ARGB**.
 *
 *  Confirmed against the real client (a fresh melee game on Booty Bay): the
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
  /**
   * The minimap's FRIEND-OR-FOE palette, and the reason the ally-colour tooltip can leave
   * "You" out of its Mode 2 line: **your own units are white on your own minimap in every
   * mode** — the row is right here, beside the creep colour the dots already come from, and
   * it is not part of the filter at all. (Confirmed in the real client by the developer.)
   *
   * `FogColorAlly` / `FogColorEnemy` ARE the filter: they are what modes 2 and 3 paint
   * everyone else in, which is why the minimap's teal (0,255,210) is its own colour rather
   * than the player-colour teal a unit wears in the world. See game/allyColor.ts.
   *
   * The rest of the family is the same palette for things that are not players
   * (`FogColorResource`, `-Item`, `-Hero`, `-Destructable`) — we draw glyphs for those
   * instead (minimapView.minimapIcons), so they are not transcribed here.
   */
  FogColorPlayer: [255, 255, 255, 255],
  FogColorAlly: [255, 0, 255, 210],
  FogColorEnemy: [255, 255, 0, 0],
} as const;

/**
 * `UI\MiscData.txt` [FogOfWar] — the veils the game lays over the world, as **ARGB**.
 *
 * Two axes, not one. The first is what the player KNOWS about a spot: never seen
 * (`BlackMasked*`), seen and remembered (`Fogged*`), or in sight now (no veil at all). The
 * second is whether the spot is part of the map at all — the UNPLAYABLE area, the black
 * border every map carries plus any "Nothing" tile painted inside it (issue #117). That is
 * a separate mask with its own pair of rows, and its existence in THIS section is the
 * statement that WC3 treats the boundary as a kind of fog: the JASS native that turns it
 * off is `EnableWorldFogBoundary`, which `TriggerStrings.txt` names "Enable/Disable
 * **Boundary Tinting**" and Blizzard.j drops for the length of a cinematic.
 *
 * What the pair says: a boundary tile IN SIGHT is not shown — it takes `BoundaryTerrain`,
 * black at 230/255, so a sliver of shape survives and nothing else. A boundary tile that is
 * merely fogged takes the ORDINARY fog tint (`FoggedBoundaryTerrain` is `FoggedTerrain` to
 * the byte), because fog is already the stronger statement. So the boundary is a FLOOR on
 * darkness, never a ceiling — which is exactly how src/render/fogOverlay.ts applies it.
 *
 * The `*Object` twin is the same rule for the things standing on the ground rather than the
 * ground itself, and it is harsher: a unit or doodad inside the boundary is a full-alpha
 * black silhouette.
 */
export const FOG_OF_WAR = {
  /** Explored, not currently seen — the blue-grey veil over remembered ground. */
  FoggedTerrain: [170, 16, 16, 32],
  /** Never explored. */
  BlackMaskedTerrain: [255, 0, 0, 0],
  DarkMaskedTerrain: [230, 0, 0, 0],
  /** Unplayable ground the player can see: black, but not QUITE opaque. */
  BoundaryTerrain: [230, 0, 0, 0],
  /** …and unplayable ground under fog, which is just fog. */
  FoggedBoundaryTerrain: [170, 16, 16, 32],
  FoggedObject: [255, 64, 64, 96],
  BlackMaskedObject: [255, 0, 0, 0],
  DarkMaskedObject: [255, 32, 32, 48],
  /** A unit or doodad standing in the unplayable area: a black silhouette. */
  BoundaryObject: [255, 0, 0, 0],
  FoggedBoundaryObject: [255, 64, 64, 96],
} as const;

/** `UI\MiscData.txt` — the glue (menu) screens' own constants. Not gameplay: this is the
 *  file the MENU reads, which is why the keys live under their real section names.
 *
 *  `[BattleNetCustomFilter]` is where the game keeps the Small/Medium/Large map buckets,
 *  and it buckets a map by its PLAYER COUNT, not by its dimensions — which is why the
 *  1v1 Booty Bay reads "Small" on the Custom Game screen even though it is not a small
 *  piece of terrain. Each range is an inclusive `min,max` player count. */
export const GLUE = {
  /** `[BattleNetCustomFilter]` — the map-size buckets, by suggested player count. */
  SmallMapRange: [2, 4],
  MediumMapRange: [5, 8],
  LargeMapRange: [9, 12],
} as const;

/**
 * `UI\MiscData.txt` [InfoPanel] — the words the info panel's Damage and Armor hover slabs print
 * for a unit's RANGE and its two SPEEDS. The game does not show the numbers: a 100-range weapon
 * is "Melee", a 320 walk is "Fast", a 1.77 s swing is "Average", and these are the bands.
 *
 * The file's own comments settle which way each end is open: `SpeedVerySlow` is a LOWER bound
 * ("everything below this is very slow") and `SpeedFast` an UPPER one ("everything above this
 * is very fast"); the attack rungs run the other way round, since a longer cooldown is a SLOWER
 * attack. The cooldown banded is the live one, agility and haste already divided in — which is
 * why a Death Knight's 2.2 s `cool1` reads "Average" at 12 Agility and not "Slow".
 */
export const INFO_PANEL = {
  /** A weapon reaching this far or less is "Melee" rather than a number. */
  MeleeRangeMax: 128,
  SpeedVerySlow: 175,
  SpeedSlow: 220,
  SpeedAverage: 280,
  SpeedFast: 350,
  AttackVerySlow: 3,
  AttackSlow: 2,
  AttackAverage: 1.5,
  AttackFast: 1,
} as const;

/** The five-rung speed word as a `GlobalStrings.fdf` key — `MOVESPEEDVERYSLOW` … `MOVESPEEDVERYFAST`,
 *  the only rungs of that vocabulary the game ships, so the attack line borrows them too. */
export type SpeedRung = "MOVESPEEDVERYSLOW" | "MOVESPEEDSLOW" | "MOVESPEEDAVERAGE" | "MOVESPEEDFAST" | "MOVESPEEDVERYFAST";

/** A move speed's rung, off `INFO_PANEL.Speed*`. */
export function moveSpeedRung(speed: number): SpeedRung {
  if (speed < INFO_PANEL.SpeedVerySlow) return "MOVESPEEDVERYSLOW";
  if (speed < INFO_PANEL.SpeedSlow) return "MOVESPEEDSLOW";
  if (speed < INFO_PANEL.SpeedAverage) return "MOVESPEEDAVERAGE";
  if (speed <= INFO_PANEL.SpeedFast) return "MOVESPEEDFAST";
  return "MOVESPEEDVERYFAST";
}

/** An attack cooldown's rung, off `INFO_PANEL.Attack*` (seconds between swings). */
export function attackSpeedRung(cooldown: number): SpeedRung {
  if (cooldown > INFO_PANEL.AttackVerySlow) return "MOVESPEEDVERYSLOW";
  if (cooldown >= INFO_PANEL.AttackSlow) return "MOVESPEEDSLOW";
  if (cooldown >= INFO_PANEL.AttackAverage) return "MOVESPEEDAVERAGE";
  if (cooldown >= INFO_PANEL.AttackFast) return "MOVESPEEDFAST";
  return "MOVESPEEDVERYFAST";
}

/**
 * `UI\MiscData.txt` [Misc] — the ENGINE's own floating text tags, one spec per kind.
 *
 * The game does not eyeball these: it keeps a colour, a drift, a lifetime and a fade point
 * for every number it floats over the world — `GoldText*`, `LumberText*`, `BountyText*`,
 * `MissText*`, `CriticalStrikeText*`, `ShadowStrikeText*`, `ManaBurnText*`, `BashText*` —
 * and the matching `…TextHeight` in `UI\MiscUI.txt` (see MISC_UI). Only the ones a system
 * here actually raises are transcribed; the rest wait for the systems that raise them.
 *
 * Colours are the file's own **ARGB**, like MINIMAP's. `LumberTextColor = 255,0,200,80` is
 * what proves the order — lumber is green, and read as RGBA that would be a red.
 *
 * A velocity is `x,y,?`: the drift in SCREEN units per second, with a third field that is
 * 100 in every row in the file and is transcribed rather than guessed at. The drift is
 * screen-relative like the height (see TEXT_TAG_SCALE) — a rising number climbs the SCREEN,
 * it does not travel north through the world and shrink into the distance.
 */
export const TEXT_TAG = {
  /** "// gold text data" — the "+N" the engine floats when it CREDITS a player gold: a worker
   *  delivering a load from the mine, a shop buying an item back, Transmute's payout. Distinct
   *  from `BountyText*` (a creep's bounty), which lives three seconds rather than two. */
  GoldTextColor: [255, 255, 220, 0],
  GoldTextVelocity: [0, 0.03, 100],
  GoldTextLifetime: 2,
  GoldTextFadeStart: 1,

  /** "// lumber text data" — the same tag for the other resource, and the one that settles the
   *  channel order (see above): lumber is GREEN, so `0,200,80` can only be the RGB of an ARGB.
   *  It is emphatically not gold-coloured; the two credits are told apart by their colour. */
  LumberTextColor: [255, 0, 200, 80],
  LumberTextVelocity: [0, 0.03, 100],
  LumberTextLifetime: 2,
  LumberTextFadeStart: 1,

  /** "// bounty text data" — the "+N" a slain creep leaves behind. Same gold as `GoldText*`
   *  down to the byte (it is the same money), but it hangs around half again as long — three
   *  seconds, fading from two — because a bounty is raised in a fight and has to survive it. */
  BountyTextColor: [255, 255, 220, 0],
  BountyTextVelocity: [0, 0.03, 100],
  BountyTextLifetime: 3,
  BountyTextFadeStart: 2,
} as const;

/**
 * `UI\MiscUI.txt` [Misc] — the heights of those same text tags.
 *
 * They live in the OTHER Misc file because they are font sizes, and the file says what the
 * unit is: "All font heights are in Frame screen units." For a text TAG that is the 0..1
 * screen, not the 0.8x0.6 FDF box the panels are laid out in — a tag of height 1 fills the
 * screen top to bottom (see TEXT_TAG_SCALE, and Blizzard.j's `TextTagSize2Height`, which
 * puts the GUI's "font size 10" at 0.023 — a hair under the 0.024 the engine uses here).
 */
export const MISC_UI = {
  GoldTextHeight: 0.024,
  LumberTextHeight: 0.024,
  BountyTextHeight: 0.024,
} as const;

/** The word the Custom Game screen puts against "Map Size", from `GLUE.*MapRange`. */
export function mapSizeLabel(players: number): string {
  if (players <= GLUE.SmallMapRange[1]) return "Small";
  if (players <= GLUE.MediumMapRange[1]) return "Medium";
  return "Large";
}

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

  // Neutral-building stock — the Marketplace's rotating shelves. Blizzard.j runs the whole
  // thing itself (InitNeutralBuildings → StartStockUpdates → PerformStockUpdates), so these
  // are here for the natives it stands on rather than for a reimplementation of the loop.
  /** bj_MAX_STOCK_ITEM_SLOTS — distinct ITEM types one shop may hold at once. */
  MAX_STOCK_ITEM_SLOTS: 11,
  /** bj_MAX_STOCK_UNIT_SLOTS — distinct UNIT types one shop may hold at once. */
  MAX_STOCK_UNIT_SLOTS: 11,
  /** bj_STOCK_RESTOCK_INITIAL_DELAY — seconds before the first stock update runs. */
  STOCK_RESTOCK_INITIAL_DELAY: 120,
  /** bj_STOCK_RESTOCK_INTERVAL — seconds between stock updates thereafter. */
  STOCK_RESTOCK_INTERVAL: 30,
  /** bj_STOCK_MAX_ITERATIONS — tries to roll a sellable item before giving up on a slot. */
  STOCK_MAX_ITERATIONS: 20,
} as const;

/** `Scripts\Blizzard.j` `bj_CAMERA_DEFAULT_*` — the shape of the camera a game opens on,
 *  and the one `ResetToGameCamera` comes home to. DEFAULT_FOV is the FIELD, which is NOT the
 *  angle the client renders with (that is ~32°, measured); see docs/camera.md before touching
 *  any of these. */
export const CAMERA = {
  /** bj_CAMERA_DEFAULT_DISTANCE — eye-to-focus distance. */
  DEFAULT_DISTANCE: 1650,
  /** bj_CAMERA_DEFAULT_FOV — the CAMERA_FIELD_FIELD_OF_VIEW value, in degrees. The lens it
   *  renders as lives in mapViewer's `fovFromWc3`. */
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

type DamageTable = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** attack type → armor type → multiplier, unpacked from one file's `DamageBonus*` lists. */
function unpackDamageTable(misc: Record<string, unknown>): DamageTable {
  const row = (key: string): readonly number[] =>
    (misc[key] ?? (MISC_GAME as Record<string, unknown>)[key]) as readonly number[];
  const rows: ReadonlyArray<readonly [AttackType, readonly number[]]> = [
    [AttackType.Normal, row("DamageBonusNormal")],
    [AttackType.Pierce, row("DamageBonusPierce")],
    [AttackType.Siege, row("DamageBonusSiege")],
    [AttackType.Magic, row("DamageBonusMagic")],
    [AttackType.Chaos, row("DamageBonusChaos")],
    [AttackType.Spells, row("DamageBonusSpells")],
    [AttackType.Hero, row("DamageBonusHero")],
  ];
  return Object.fromEntries(
    rows.map(([attack, bonuses]) => [
      attack,
      Object.fromEntries(ARMOR_TYPE_ORDER.map((armor, i) => [armor, bonuses[i]])),
    ]),
  );
}

/** attack type → armor type → damage multiplier, unpacked from the `DamageBonus*` lists. The
 *  expansion's; `damageTable()` is the one for the edition the client is on. */
export const DAMAGE_TABLE: DamageTable = unpackDamageTable(MISC_GAME);
/** …and Reign of Chaos's, off `Melee_V0\Units\MiscGame.txt`. */
export const DAMAGE_TABLE_V0: DamageTable = unpackDamageTable(MISC_GAME_V0);
/**
 * …and the expansion's CUSTOM one, off `Custom_V1\Units\MiscGame.txt`. It differs from
 * `DAMAGE_TABLE` in a single cell — Spells against Hero armour, 0.75 against 0.70 — because
 * `unpackDamageTable` falls back to `MISC_GAME` for every row `MISC_GAME_CUSTOM` does not
 * restate, and that is the only `DamageBonus*` row a custom copy moves.
 *
 * There is deliberately no fourth table. Reign of Chaos's two copies agree on ALL FIVE
 * `DamageBonus*` rows, so a RoC custom map is graded by `DAMAGE_TABLE_V0` — which is a fact
 * about the install, checked by `pnpm data:verify` rather than assumed here.
 */
export const DAMAGE_TABLE_CUSTOM: DamageTable = unpackDamageTable(MISC_GAME_CUSTOM);

/** The damage table of the data set this match is on — edition, then map kind
 *  (data/edition.ts). */
export function damageTable(): DamageTable {
  const base = isRoc() ? DAMAGE_TABLE_V0 : mapDataSet() === "custom" ? DAMAGE_TABLE_CUSTOM : DAMAGE_TABLE; // RoC states the same five rows in both its copies
  if (!mapStatesAny(DAMAGE_ROWS)) return base;
  // A MAP that restates a DamageBonus row (war3mapMisc.txt — Balanced Hero Survival rewrites
  // all five) grades every blow by its own table. Built from the rows `miscGame` answers, so
  // each row the map left alone still comes from the data set's copy; rebuilt only when the
  // overlay or the data set changes.
  const key = `${overlayEpoch}:${isRoc() ? "v0" : "v1"}:${mapDataSet()}`;
  if (mapTable?.key !== key) {
    mapTable = { key, table: unpackDamageTable(Object.fromEntries(DAMAGE_ROWS.map((r) => [r, miscGame(r as keyof typeof MISC_GAME)]))) };
  }
  return mapTable.table;
}
const DAMAGE_ROWS = ["DamageBonusNormal", "DamageBonusPierce", "DamageBonusSiege", "DamageBonusMagic", "DamageBonusChaos", "DamageBonusSpells", "DamageBonusHero"];
let mapTable: { key: string; table: DamageTable } | null = null;
/** Does the map's overlay state any of these rows? */
function mapStatesAny(keys: readonly string[]): boolean {
  return !!mapStated && keys.some((k) => mapValue(k, MISC_GAME[k as keyof typeof MISC_GAME]) !== undefined);
}

/** Damage multiplier for `attack` striking `armor`. An unknown pair (a weaponless
 *  attacker, a unit with no defType) scales by 1.0 rather than vanishing. */
export function damageMultiplier(attack: AttackType, armor: ArmorType): number {
  return damageTable()[attack]?.[armor] ?? 1;
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



/** Extra multiplier a BANISHED (ethereal) target takes from `attack`, on top of the
 *  normal damage table: 0 for every physical type (immune to melee/pierce/siege) and
 *  1.66 for Magic & Spells (+66%). An attack type not in the file's list — most
 *  notably `None`, used by untyped ability damage — defaults to 1.0 so the hit is
 *  unchanged (untyped spell damage is boosted explicitly via etherealSpellBonus). */
export function etherealDamageMultiplier(attack: AttackType): number {
  const i = ETHEREAL_ATTACK_ORDER.indexOf(attack);
  return i < 0 ? 1 : gameList("EtherealDamageBonus")[i] ?? 1;
}

/** The multiplier untyped ability damage (`spellDamage`, dealt as AttackType.None)
 *  applies to an ethereal target — the file's Spells column, ×1.66. */
export function etherealSpellBonus(): number {
  return etherealDamageMultiplier(AttackType.Spells);
}

/** Healing landed on an ethereal target is amplified the same ×1.66 (EtherealHealBonus). */
export function etherealHealBonus(): number {
  return gameNum("EtherealHealBonus");
}

/** The share of a hit that `armor` points of armour absorb: `n·k / (1 + k·n)`, with
 *  k = DefenseArmor. Diminishing returns, so armour never reaches 100%. Negative
 *  armour (Acid Bomb, Faerie Fire) falls out of the same formula as extra damage. */
export function armorDamageReduction(armor: number): number {
  const k = gameNum("DefenseArmor");
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

/**
 * Where a fallen hero comes back, and what it costs to bring it — the two ladders
 * `Units\MiscGame.txt` writes out in its own comment, in its own words:
 *
 *     goldRevivalCost   = originalCost * (ReviveBaseFactor + (ReviveLevelFactor*(level-1)))
 *         but not exceeding originalCost * ReviveMaxFactor
 *     lumberRevivalCost = originalCost * (ReviveBaseLumberFactor + (ReviveLumberLevelFactor*(level-1)))
 *         but not exceeding originalCost * ReviveMaxFactor
 *     revivalTime       = originalTime * level * ReviveTimeFactor
 *         but not exceeding originalTime * ReviveMaxTimeFactor
 *
 * …plus the flat `HeroMaxRevive*` ceilings on top. Computed rather than transcribed, so the
 * numbers cannot drift from the file: they come out as the reference states them, which is
 * how the reading of the file was CHECKED. An Archmage (425g / 100l / 55s) at level 10 revives
 * for 425 × 1.3 = **552** gold and 0 lumber in 55 × 2.0 = **110** seconds — the classic
 * manual's "maximum cost … 550 Gold and 0 Lumber at an Altar" and "revive time is capped at
 * 110 seconds" — and awakens at a Tavern for 425 × 2.6 = **1105** gold and 100 × 2.6 = **260**
 * lumber, which is that page's "1105 Gold 260 Lumber" to the coin.
 *
 * `mode` is which building is doing it: an **altar** revives (slow, cheap, full health), a
 * **tavern** awakens (instant, dear, half health and no mana). The two differ only in which
 * set of constants they read, which is why one function serves both.
 */
export type ReviveMode = "altar" | "tavern";

export function heroReviveCost(
  mode: ReviveMode,
  goldCost: number,
  lumberCost: number,
  buildTime: number,
  level: number,
): { gold: number; lumber: number; time: number } {
  const lv = Math.max(1, level) - 1;
  if (mode === "tavern") {
    const factor = Math.min(gameNum("AwakenBaseFactor") + gameNum("AwakenLevelFactor") * lv, gameNum("AwakenMaxFactor"));
    const lumberFactor = Math.min(gameNum("AwakenBaseLumberFactor") + gameNum("AwakenLumberLevelFactor") * lv, gameNum("AwakenMaxFactor"));
    return {
      gold: Math.min(Math.floor(goldCost * factor), gameNum("HeroMaxAwakenCostGold")),
      lumber: Math.min(Math.floor(lumberCost * lumberFactor), gameNum("HeroMaxAwakenCostLumber")),
      time: 0, // "you can also use it to INSTANTLY revive your Heroes"
    };
  }
  const factor = Math.min(gameNum("ReviveBaseFactor") + gameNum("ReviveLevelFactor") * lv, gameNum("ReviveMaxFactor"));
  const lumberFactor = Math.min(gameNum("ReviveBaseLumberFactor") + gameNum("ReviveLumberLevelFactor") * lv, gameNum("ReviveMaxFactor"));
  // The TIME ladder is the one that reads differently from the two cost ones: it is
  // `level * ReviveTimeFactor`, not `base + step*(level-1)`, so it starts at 0.65 of the
  // build time rather than at a base factor and reaches its 2.0 ceiling at level 4.
  const timeFactor = Math.min(Math.max(1, level) * gameNum("ReviveTimeFactor"), gameNum("ReviveMaxTimeFactor"));
  return {
    gold: Math.min(Math.floor(goldCost * factor), gameNum("HeroMaxReviveCostGold")),
    lumber: Math.min(Math.floor(lumberCost * lumberFactor), gameNum("HeroMaxReviveCostLumber")),
    time: Math.min(buildTime * timeFactor, gameNum("HeroMaxReviveTime")),
  };
}

/** The health and mana a revived hero stands up with. `manaStart` is the unit type's own
 *  `manaN` (its opening pool), which is what makes an altar hero's 100 mana the game's
 *  number rather than ours — see the constants. */
export function heroReviveVitals(
  mode: ReviveMode,
  maxHp: number,
  maxMana: number,
  manaStart: number,
): { hp: number; mana: number } {
  const tavern = mode === "tavern";
  const life = tavern ? gameNum("HeroAwakenLifeFactor") : gameNum("HeroReviveLifeFactor");
  const start = tavern ? gameNum("HeroAwakenManaStart") : gameNum("HeroReviveManaStart");
  const factor = tavern ? gameNum("HeroAwakenManaFactor") : gameNum("HeroReviveManaFactor");
  return {
    hp: Math.max(1, Math.round(maxHp * life)),
    mana: Math.min(maxMana, Math.round(manaStart * start + maxMana * factor)),
  };
}

/** XP a kill grants, indexed by the VICTIM's level. Normal units follow GrantNormalXP
 *  (25/40/60/85/115/…); enemy heroes the far richer GrantHeroXP (100/120/160/220/300/
 *  400/…). Buildings grant none at all — BuildingKillsGiveExp = 0. */
const grantNormalXp = perOverlay(() => expandLevelTable(
  gameList("GrantNormalXP"),
  gameNum("GrantNormalXPFormulaA"),
  gameNum("GrantNormalXPFormulaB"),
  gameNum("GrantNormalXPFormulaC"),
  gameNum("MaxUnitLevel"),
));

const grantHeroXp = perOverlay(() => expandLevelTable(
  gameList("GrantHeroXP"),
  gameNum("GrantHeroXPFormulaA"),
  gameNum("GrantHeroXPFormulaB"),
  gameNum("GrantHeroXPFormulaC"),
  gameNum("MaxHeroLevel"),
));

/** Total XP a hero needs to REACH each level. NeedHeroXP's single entry (200) is the
 *  cost of level 2; the formula (A=1, B=100, C=0) carries it from there, giving the
 *  familiar closed form 50·(L² + L − 2) → 200/500/900/1400/2000/… Index by level;
 *  level 1 costs nothing. One entry past MaxHeroLevel, for the HUD's "next level" bar. */
const needHeroXp = perOverlay(() => expandLevelTable(
  gameList("NeedHeroXP"),
  gameNum("NeedHeroXPFormulaA"),
  gameNum("NeedHeroXPFormulaB"),
  gameNum("NeedHeroXPFormulaC"),
  gameNum("MaxHeroLevel") + 1,
  2, // the table starts at level 2 — there is no XP cost to "reach" level 1
));

/** A table derived from these rows, rebuilt when a map's overlay moves under it and never
 *  otherwise — the curves are read on every kill. */
function perOverlay<T>(build: () => T): () => T {
  let epoch = -1;
  let value: T;
  return () => {
    if (epoch !== overlayEpoch) {
      value = build();
      epoch = overlayEpoch;
    }
    return value;
  };
}

export function xpToReachLevel(level: number): number {
  const table = needHeroXp();
  return table[Math.max(0, Math.min(level, table.length - 1))] ?? 0;
}

/** XP a kill of `victimLevel` grants, before the summon/creep factors. */
export function grantedXp(victimLevel: number, victimIsHero: boolean): number {
  const table = victimIsHero ? grantHeroXp() : grantNormalXp();
  return table[Math.max(0, Math.min(victimLevel, table.length - 1))] ?? 0;
}

/** The share of a CREEP kill's XP a hero of this level keeps (HeroFactorXP, as a
 *  fraction). 80% at level 1, tapering to nothing from level 5 — high heroes cannot
 *  farm camps. Heroes are always level ≥ 1; level 0 is treated as level 1. */
export function creepXpFactor(heroLevel: number): number {
  // Reign of Chaos's is the one-entry list `100`: a creep pays in full at every level.
  const table = gameList("HeroFactorXP");
  const i = Math.max(1, Math.min(heroLevel, table.length)) - 1;
  return table[i] / 100;
}

/** Game hours elapsed per real second — a 24-hour Azeroth day in 480 real seconds. */
export function gameHoursPerSec(): number {
  return dataNum("DayHours") / dataNum("DayLength"); // DotA's own map runs a 450-second day
}

/** `[a, r, g, b]` → a CSS colour. The alpha in `UI\MiscData.txt` is always 255 for
 *  the entries we use, so it is dropped rather than emitted as `rgba(…)`. */
const cssColor = ([, r, g, b]: readonly number[]): string => `rgb(${r},${g},${b})`;

/** Minimap dot colour for creeps and every other unowned unit. */
export const NEUTRAL_DOT_COLOR = cssColor(MINIMAP.FogColorCreepNormal);

/** Minimap dot colour for YOUR OWN units — white, in every Ally Color Mode (see MINIMAP). */
export const SELF_DOT_COLOR = cssColor(MINIMAP.FogColorPlayer);
/** …and for an ally's / an enemy's, once an ally-colour mode is on. */
export const ALLY_DOT_COLOR = cssColor(MINIMAP.FogColorAlly);
export const ENEMY_DOT_COLOR = cssColor(MINIMAP.FogColorEnemy);

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
