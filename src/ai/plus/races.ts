import type { PlayableRace } from "../../data/races";
import {
  ABOMINATION, ACOLYTE, ANCIENT_LORE, ANCIENT_PROTECT, ANCIENT_WAR, ANCIENT_WIND, ARCHER,
  ANIM_DEAD, ARCHMAGE, AVATAR, AVIARY, BALLISTA, BANISH, BANSHEE, BARRACKS, BASH, BESTIARY,
  BLACKSMITH, BLADE_MASTER, BLADE_STORM, BLINK, BLIZZARD, BLOOD_MAGE, BONEYARD, BRILLIANCE_AURA,
  BURROW, CARRION_SCARAB, CARRION_SWARM, CASTLE, CATAPULT, CHAIN_LIGHTNING, CHIMAERA,
  CHIMAERA_ROOST, CRITICAL_STRIKE, CRYPT, CRYPT_FIEND, CRYPT_LORD, DAMNED_TEMPLE, DARK_RITUAL,
  DEATH_COIL, DEATH_DECAY, DEATH_KNIGHT, DEATH_PACT, DEMON_HUNTER, DEN_OF_WONDERS,
  DEVOTION_AURA, DIVINE_SHIELD, DREAD_LORD, DRUID_CLAW, DRUID_TALON, DRYAD, EARTHQUAKE,
  ELF_ALTAR, ENDURANE_AURA, ENT_ROOTS, EVASION, FAN_KNIVES, FAR_SEER, FAR_SIGHT, FLAME_STRIKE,
  FOOTMAN, FORCE_NATURE, FORGE, FORTRESS, FROST_ARMOR, FROST_NOVA, FROST_WYRM,
  GARGOYLE, GHOUL, GRAVEYARD, GREAT_HALL, GRUNT, GRYPHON, GUARD_TOWER, HEAD_HUNTER, HEALING_WAVE, HEX, HIPPO,
  HOLY_BOLT, HOUSE, HUMAN_ALTAR, HUMAN_DRAGON_HAWK, HUNTERS_HALL, HUNTRESS, IMMOLATION,
  IMPALE, INFERNO, KEEP, KEEPER, KNIGHT, KODO_BEAST, LICH, LOCUST_SWARM, LODGE, LUMBER_MILL,
  MANA_BURN, MASS_TELEPORT, MEAT_WAGON, METAMORPHOSIS, MIRROR_IMAGE, MOON_CHICK, MOON_WELL,
  MORTAR, MOUNTAIN_GIANT, MTN_KING, NECRO, NECROPOLIS_1, NECROPOLIS_2, NECROPOLIS_3,
  ORC_ALTAR, ORC_BARRACKS, ORC_WATCH_TOWER, PALADIN, PEASANT, PEON, PRIEST, RAIDER,
  REINCARNATION, RESURRECTION, RIFLEMAN, SANCTUM, SCOUT, SEARING_ARROWS, SERPENT_WARD,
  SHADOW_HUNTER, SHADOW_TOUCH, SHAMAN, SHOCKWAVE, SIPHON_MANA, SLAUGHTERHOUSE, SLEEP,
  SORCERESS, SPELL_BREAKER, SPIRIT_WOLF, STARFALL, STRONGHOLD, SUMMON_PHOENIX, TAUREN,
  TAUREN_CHIEF, THORNS_AURA, THORNY_SHIELD, THUNDER_BOLT, THUNDER_CLAP, TOTEM, TOWN_HALL,
  TRANQUILITY, TREE_AGES, TREE_ETERNITY, TREE_LIFE, TRUESHOT, UNHOLY_AURA, UPG_ABOLISH,
  UPG_ARMOR, UPG_BANSHEE, UPG_BOWS, UPG_BREEDING, UPG_CR_ARMOR, UPG_CR_ATTACK,
  UPG_DEFEND, UPG_DRUID_CLAW, UPG_DRUID_TALON, UPG_GHOUL_FRENZY, UPG_GUN_RANGE, UPG_HIDES,
  UPG_LEATHER, UPG_MASONRY, UPG_MELEE, UPG_MOON_ARMOR, UPG_NECROS, UPG_ORC_ARMOR,
  UPG_ORC_BERSERKER, UPG_ORC_ENSNARE, UPG_ORC_MELEE, UPG_ORC_PULVERIZE, UPG_ORC_RANGED,
  UPG_ORC_SHAMAN, UPG_ORC_SPIKES, UPG_ORC_WAR_DRUMS, UPG_PRAYING, UPG_RANGED, UPG_SORCERY,
  UPG_STR_MOON, UPG_STR_WILD, UPG_UNHOLY_ARMOR, UPG_UNHOLY_STR, UPG_WOOD, VAMP_AURA,
  VENGEANCE, VOODOO, WAR_STOMP, WARDEN, WATCH_TOWER, WATER_ELEMENTAL, WIND_WALK, WISP,
  WITCH_DOCTOR, WORKSHOP, WYVERN, ZIGGURAT_1, ZIGGURAT_2,
} from "../ids";

// Computer+ — the four races as DATA (issue #124).
//
// The classic melee AI is four ~650-line scripts, one per race, because that is what Blizzard
// shipped and `src/ai/human.ts` and its siblings are transcriptions of them. Computer+ has no
// script to transcribe, so it is written the other way round: ONE build routine (plus/plan.ts)
// reading four tables. Every race then plays the same game — workers, food, hero, an army in a
// fixed mix, tech, upgrades, expand — and differs only in what it names, which is the honest
// shape of a melee opening and about a fifth of the code.
//
// **These are our numbers, not the game's.** The ids are Blizzard's (src/ai/ids.ts is
// common.ai's own globals block) and so is every research location below — `Researches=` in
// `Units\<Race>UnitFunc.txt`, which is why `UPG_MASONRY` says LUMBER_MILL and `UPG_DEFEND`
// says BARRACKS. What is OURS is the composition: which units, in what proportion, in what
// order. They follow the standard ladder openings for each race (a Footman/Rifleman line into
// Knights, Grunts into Raiders, Ghouls into Crypt Fiends, Archers into Huntresses) rather than
// anything the install describes. See docs/computer-plus.md.

/** One unit in the army mix. */
export interface ArmyRow {
  unit: string;
  /** The producer that must be STANDING and finished before this row is asked for. Nothing is
   *  ever asked for without it: `OneBuildLoop` reserves a row's gold whether or not the row
   *  could start (see AiPlayer.runBuildLoop), so a row for a unit we cannot make yet starves
   *  everything below it. */
  from: string;
  /** …and anything else the unit's own tech requires, so the same rule holds: a Knight needs
   *  a Lumber Mill and a Blacksmith standing, not just a Castle. */
  needs?: readonly string[];
  /** The hall tier this row waits for (1 Town Hall / 2 Keep / 3 Castle, and each race's
   *  equivalents). Also what `PlusProfile.techTier` caps. */
  tier: number;
  /** Its share of the army. Relative within a race — the plan normalises whatever is
   *  currently available and spends the food budget down the mix. */
  weight: number;
  /** Counts as SIEGE for the attack ladder — what lets a wave commit to a base rather than
   *  bouncing off the towers. */
  siege?: boolean;
  /** Counts as AIR: it can cross a cliff, and it makes air creep camps fair game. */
  air?: boolean;
}

/** A support building worth putting up once the tier and the army allow. */
export interface TechRow {
  build: string;
  tier: number;
  needs?: readonly string[];
  /** Army food that must already be fielded. Teching with nothing on the field is how an AI
   *  dies to the first six Footmen it meets, so every support building waits for a floor. */
  after?: number;
}

/** An upgrade, and how far up it is worth going. */
export interface UpgradeRow {
  id: string;
  /** The building that researches it — `Researches=` in the race's own UnitFunc.txt. Purely a
   *  gate: `AiPlayer.setUpgrade` finds the building itself. */
  from: string;
  /** Ranks worth taking (armour/weapons are 3, a one-shot is 1). Capped again by
   *  `PlusProfile.upgradeRank`. */
  ranks: number;
  /** Army food that must be fielded first: you upgrade an army you HAVE. */
  after?: number;
}

export interface PlusRaceTable {
  readonly race: PlayableRace;
  readonly worker: string;
  /** Tier 1 / 2 / 3 halls. Asking for a higher one is an UPGRADE of the lower — see
   *  `AiPlayer.setProduce`, which tries the upgrade route first. */
  readonly halls: readonly [string, string, string];
  /** The food building. */
  readonly farm: string;
  readonly altar: string;
  /** The building the opening is built around — the first thing that makes a soldier. */
  readonly barracks: string;
  /** Which of the army buildings are worth a SECOND copy once the bank is deep. */
  readonly factories: readonly string[];
  /** The defensive structure, and the upgrade of it worth taking when there is one (a Human
   *  Guard Tower and an undead Spirit Tower are both upgrades of something already standing). */
  readonly tower: string;
  readonly towerUpgrade?: string;
  readonly army: readonly ArmyRow[];
  readonly tech: readonly TechRow[];
  readonly upgrades: readonly UpgradeRow[];
  /** Heroes in the order a ladder player reaches for them; `PlusPlan` takes as many as the
   *  profile allows, first one first. Unlike `PickMeleeHero` (which draws three at random —
   *  common.ai's own behaviour, ported in AiPlayer) this is a PREFERENCE, because a human
   *  opening with an Archmage is not rolling dice. */
  readonly heroes: readonly string[];
  /** Each hero's ten levels. Ours, in the shape `AiPlayer.setSkillArray` reads: index 0 is
   *  level 1, index 5 is the ultimate (hero level 6). */
  readonly skills: Readonly<Record<string, readonly string[]>>;
}

// --------------------------------------------------------------------------------------
//  HUMAN — Footmen into Riflemen, Keep, casters, Knights
// --------------------------------------------------------------------------------------

const HUMAN: PlusRaceTable = {
  race: "human",
  worker: PEASANT,
  halls: [TOWN_HALL, KEEP, CASTLE],
  farm: HOUSE,
  altar: HUMAN_ALTAR,
  barracks: BARRACKS,
  factories: [BARRACKS, SANCTUM],
  tower: WATCH_TOWER,
  towerUpgrade: GUARD_TOWER,
  army: [
    { unit: FOOTMAN, from: BARRACKS, tier: 1, weight: 3 },
    { unit: RIFLEMAN, from: BARRACKS, needs: [BLACKSMITH], tier: 1, weight: 2 },
    { unit: PRIEST, from: SANCTUM, tier: 2, weight: 1.5 },
    { unit: SORCERESS, from: SANCTUM, tier: 2, weight: 1 },
    { unit: MORTAR, from: WORKSHOP, tier: 2, weight: 1, siege: true },
    { unit: KNIGHT, from: BARRACKS, needs: [LUMBER_MILL, BLACKSMITH], tier: 3, weight: 2.5 },
    { unit: SPELL_BREAKER, from: SANCTUM, tier: 3, weight: 1 },
    { unit: GRYPHON, from: AVIARY, tier: 3, weight: 1.5, air: true },
    { unit: HUMAN_DRAGON_HAWK, from: AVIARY, tier: 3, weight: 0.5, air: true },
  ],
  tech: [
    { build: BLACKSMITH, tier: 1, after: 6 },
    { build: LUMBER_MILL, tier: 1, after: 8 },
    { build: SANCTUM, tier: 2 },
    { build: WORKSHOP, tier: 2, after: 14 },
    { build: AVIARY, tier: 3, after: 24 },
  ],
  upgrades: [
    { id: UPG_DEFEND, from: BARRACKS, ranks: 1, after: 6 },
    { id: UPG_MELEE, from: BLACKSMITH, ranks: 3, after: 8 },
    { id: UPG_ARMOR, from: BLACKSMITH, ranks: 3, after: 8 },
    { id: UPG_RANGED, from: BLACKSMITH, ranks: 3, after: 12 },
    { id: UPG_LEATHER, from: BLACKSMITH, ranks: 3, after: 16 },
    { id: UPG_MASONRY, from: LUMBER_MILL, ranks: 3, after: 16 },
    { id: UPG_WOOD, from: LUMBER_MILL, ranks: 2, after: 12 },
    { id: UPG_GUN_RANGE, from: BARRACKS, ranks: 1, after: 16 },
    { id: UPG_BREEDING, from: BARRACKS, ranks: 1, after: 24 },
    { id: UPG_PRAYING, from: SANCTUM, ranks: 2, after: 20 },
    { id: UPG_SORCERY, from: SANCTUM, ranks: 2, after: 20 },
  ],
  heroes: [ARCHMAGE, PALADIN, MTN_KING, BLOOD_MAGE],
  skills: {
    // Water Elemental first and maxed: a summoned unit every fight is what makes the Archmage
    // the standard opener, and it is the one hero skill an AI can spend well without micro.
    [ARCHMAGE]: [WATER_ELEMENTAL, BRILLIANCE_AURA, WATER_ELEMENTAL, BRILLIANCE_AURA,
      WATER_ELEMENTAL, MASS_TELEPORT, BRILLIANCE_AURA, BLIZZARD, BLIZZARD, BLIZZARD],
    [PALADIN]: [HOLY_BOLT, DEVOTION_AURA, HOLY_BOLT, DEVOTION_AURA, HOLY_BOLT, RESURRECTION,
      DEVOTION_AURA, DIVINE_SHIELD, DIVINE_SHIELD, DIVINE_SHIELD],
    [MTN_KING]: [THUNDER_BOLT, THUNDER_CLAP, THUNDER_BOLT, THUNDER_CLAP, THUNDER_BOLT, AVATAR,
      THUNDER_CLAP, BASH, BASH, BASH],
    [BLOOD_MAGE]: [FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE,
      SUMMON_PHOENIX, SIPHON_MANA, BANISH, BANISH, BANISH],
  },
};

// --------------------------------------------------------------------------------------
//  ORC — Grunts, Burrows for food, Raiders and Shamans off a Stronghold
// --------------------------------------------------------------------------------------

const ORC: PlusRaceTable = {
  race: "orc",
  worker: PEON,
  halls: [GREAT_HALL, STRONGHOLD, FORTRESS],
  farm: BURROW,
  altar: ORC_ALTAR,
  barracks: ORC_BARRACKS,
  factories: [ORC_BARRACKS, LODGE],
  tower: ORC_WATCH_TOWER,
  army: [
    { unit: GRUNT, from: ORC_BARRACKS, tier: 1, weight: 3 },
    { unit: HEAD_HUNTER, from: ORC_BARRACKS, tier: 1, weight: 1.5 },
    { unit: SHAMAN, from: LODGE, tier: 2, weight: 1.5 },
    { unit: WITCH_DOCTOR, from: LODGE, tier: 2, weight: 1 },
    { unit: RAIDER, from: BESTIARY, tier: 2, weight: 2 },
    { unit: CATAPULT, from: ORC_BARRACKS, needs: [BESTIARY], tier: 2, weight: 1, siege: true },
    { unit: KODO_BEAST, from: BESTIARY, tier: 2, weight: 0.5 },
    { unit: TAUREN, from: TOTEM, tier: 3, weight: 2 },
    { unit: WYVERN, from: BESTIARY, tier: 3, weight: 1.5, air: true },
  ],
  tech: [
    { build: FORGE, tier: 1, after: 6 },
    { build: LODGE, tier: 2 },
    { build: BESTIARY, tier: 2, after: 14 },
    { build: TOTEM, tier: 3, after: 24 },
  ],
  upgrades: [
    { id: UPG_ORC_MELEE, from: FORGE, ranks: 3, after: 8 },
    { id: UPG_ORC_ARMOR, from: FORGE, ranks: 3, after: 8 },
    { id: UPG_ORC_RANGED, from: FORGE, ranks: 3, after: 12 },
    { id: UPG_ORC_BERSERKER, from: ORC_BARRACKS, ranks: 1, after: 12 },
    { id: UPG_ORC_SPIKES, from: FORGE, ranks: 1, after: 16 },
    { id: UPG_ORC_WAR_DRUMS, from: BESTIARY, ranks: 3, after: 20 },
    { id: UPG_ORC_ENSNARE, from: BESTIARY, ranks: 1, after: 16 },
    { id: UPG_ORC_SHAMAN, from: LODGE, ranks: 2, after: 20 },
    { id: UPG_ORC_PULVERIZE, from: TOTEM, ranks: 1, after: 30 },
  ],
  heroes: [BLADE_MASTER, FAR_SEER, TAUREN_CHIEF, SHADOW_HUNTER],
  skills: {
    [BLADE_MASTER]: [WIND_WALK, CRITICAL_STRIKE, WIND_WALK, CRITICAL_STRIKE, WIND_WALK,
      BLADE_STORM, CRITICAL_STRIKE, MIRROR_IMAGE, MIRROR_IMAGE, MIRROR_IMAGE],
    [FAR_SEER]: [CHAIN_LIGHTNING, SPIRIT_WOLF, CHAIN_LIGHTNING, SPIRIT_WOLF, CHAIN_LIGHTNING,
      EARTHQUAKE, SPIRIT_WOLF, FAR_SIGHT, FAR_SIGHT, FAR_SIGHT],
    [TAUREN_CHIEF]: [SHOCKWAVE, ENDURANE_AURA, SHOCKWAVE, ENDURANE_AURA, SHOCKWAVE,
      REINCARNATION, ENDURANE_AURA, WAR_STOMP, WAR_STOMP, WAR_STOMP],
    [SHADOW_HUNTER]: [HEALING_WAVE, SERPENT_WARD, HEALING_WAVE, SERPENT_WARD, HEALING_WAVE,
      VOODOO, SERPENT_WARD, HEX, HEX, HEX],
  },
};

// --------------------------------------------------------------------------------------
//  UNDEAD — Ghouls that chop and fight, Crypt Fiends off a Halls of the Dead
// --------------------------------------------------------------------------------------

const UNDEAD: PlusRaceTable = {
  race: "undead",
  worker: ACOLYTE,
  halls: [NECROPOLIS_1, NECROPOLIS_2, NECROPOLIS_3],
  farm: ZIGGURAT_1,
  altar: DAMNED_TEMPLE,
  barracks: CRYPT,
  factories: [CRYPT, DAMNED_TEMPLE],
  // The Spirit Tower is an UPGRADE of a Ziggurat, which is also the food building — so the
  // undead's towers are paid for out of supply it was going to build anyway. There is no
  // separate base to raise, which is why `tower` names the upgraded form directly.
  tower: ZIGGURAT_2,
  army: [
    { unit: GHOUL, from: CRYPT, tier: 1, weight: 3 },
    { unit: CRYPT_FIEND, from: CRYPT, tier: 2, weight: 2.5 },
    { unit: NECRO, from: DAMNED_TEMPLE, tier: 2, weight: 1.5 },
    { unit: BANSHEE, from: DAMNED_TEMPLE, tier: 2, weight: 1 },
    { unit: MEAT_WAGON, from: SLAUGHTERHOUSE, tier: 2, weight: 1, siege: true },
    { unit: ABOMINATION, from: SLAUGHTERHOUSE, tier: 3, weight: 2 },
    { unit: GARGOYLE, from: CRYPT, tier: 3, weight: 1.5, air: true },
    { unit: FROST_WYRM, from: BONEYARD, tier: 3, weight: 1, air: true },
  ],
  tech: [
    { build: GRAVEYARD, tier: 1, after: 6 },
    { build: DAMNED_TEMPLE, tier: 2 },
    { build: SLAUGHTERHOUSE, tier: 2, after: 16 },
    { build: BONEYARD, tier: 3, after: 26 },
  ],
  upgrades: [
    { id: UPG_UNHOLY_STR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_UNHOLY_ARMOR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_CR_ATTACK, from: GRAVEYARD, ranks: 3, after: 12 },
    { id: UPG_CR_ARMOR, from: GRAVEYARD, ranks: 3, after: 16 },
    { id: UPG_GHOUL_FRENZY, from: CRYPT, ranks: 1, after: 12 },
    { id: UPG_NECROS, from: DAMNED_TEMPLE, ranks: 2, after: 20 },
    { id: UPG_BANSHEE, from: DAMNED_TEMPLE, ranks: 2, after: 24 },
  ],
  heroes: [DEATH_KNIGHT, LICH, DREAD_LORD, CRYPT_LORD],
  skills: {
    [DEATH_KNIGHT]: [DEATH_COIL, UNHOLY_AURA, DEATH_COIL, UNHOLY_AURA, DEATH_COIL, ANIM_DEAD,
      UNHOLY_AURA, DEATH_PACT, DEATH_PACT, DEATH_PACT],
    [LICH]: [FROST_NOVA, DARK_RITUAL, FROST_NOVA, DARK_RITUAL, FROST_NOVA, DEATH_DECAY, DARK_RITUAL,
      FROST_ARMOR, FROST_ARMOR, FROST_ARMOR],
    [DREAD_LORD]: [CARRION_SWARM, VAMP_AURA, CARRION_SWARM, VAMP_AURA, CARRION_SWARM, INFERNO,
      VAMP_AURA, SLEEP, SLEEP, SLEEP],
    [CRYPT_LORD]: [IMPALE, CARRION_SCARAB, IMPALE, CARRION_SCARAB, IMPALE, LOCUST_SWARM,
      CARRION_SCARAB, THORNY_SHIELD, THORNY_SHIELD, THORNY_SHIELD],
  },
};

// --------------------------------------------------------------------------------------
//  NIGHT ELF — Archers into Huntresses, Moon Wells for food, Bear Form off the Ancient of Lore
// --------------------------------------------------------------------------------------

const NIGHT_ELF: PlusRaceTable = {
  race: "nightelf",
  worker: WISP,
  halls: [TREE_LIFE, TREE_AGES, TREE_ETERNITY],
  farm: MOON_WELL,
  altar: ELF_ALTAR,
  barracks: ANCIENT_WAR,
  factories: [ANCIENT_WAR, ANCIENT_LORE],
  tower: ANCIENT_PROTECT,
  army: [
    { unit: ARCHER, from: ANCIENT_WAR, tier: 1, weight: 3 },
    { unit: HUNTRESS, from: ANCIENT_WAR, needs: [HUNTERS_HALL], tier: 1, weight: 2.5 },
    { unit: DRYAD, from: ANCIENT_LORE, tier: 2, weight: 1.5 },
    { unit: DRUID_TALON, from: ANCIENT_WIND, tier: 2, weight: 1 },
    { unit: BALLISTA, from: ANCIENT_WAR, tier: 2, weight: 1, siege: true },
    // The Druid of the Claw is why the night elf table names an upgrade twice over: `Redc`
    // rank 2 is what puts Bear Form on him at all (`[Abrf] Requires=Redc Requiresamount=2`),
    // and Bear Form is what the Computer+ caster is FOR (issue #124).
    { unit: DRUID_CLAW, from: ANCIENT_LORE, tier: 3, weight: 2.5 },
    { unit: MOUNTAIN_GIANT, from: ANCIENT_LORE, tier: 3, weight: 1 },
    { unit: HIPPO, from: ANCIENT_WIND, tier: 3, weight: 1, air: true },
    { unit: CHIMAERA, from: CHIMAERA_ROOST, tier: 3, weight: 1, air: true },
  ],
  tech: [
    { build: HUNTERS_HALL, tier: 1, after: 4 },
    { build: ANCIENT_LORE, tier: 2 },
    { build: ANCIENT_WIND, tier: 2, after: 16 },
    { build: DEN_OF_WONDERS, tier: 2, after: 22 },
    { build: CHIMAERA_ROOST, tier: 3, after: 30 },
  ],
  upgrades: [
    { id: UPG_STR_MOON, from: HUNTERS_HALL, ranks: 3, after: 8 },
    { id: UPG_MOON_ARMOR, from: HUNTERS_HALL, ranks: 3, after: 8 },
    { id: UPG_STR_WILD, from: HUNTERS_HALL, ranks: 3, after: 16 },
    { id: UPG_HIDES, from: HUNTERS_HALL, ranks: 3, after: 16 },
    { id: UPG_BOWS, from: ANCIENT_WAR, ranks: 1, after: 10 },
    { id: UPG_DRUID_CLAW, from: ANCIENT_LORE, ranks: 2, after: 20 },
    { id: UPG_DRUID_TALON, from: ANCIENT_WIND, ranks: 2, after: 20 },
    { id: UPG_ABOLISH, from: ANCIENT_LORE, ranks: 1, after: 18 },
  ],
  heroes: [DEMON_HUNTER, KEEPER, MOON_CHICK, WARDEN],
  skills: {
    [DEMON_HUNTER]: [MANA_BURN, IMMOLATION, MANA_BURN, IMMOLATION, MANA_BURN, METAMORPHOSIS,
      IMMOLATION, EVASION, EVASION, EVASION],
    [KEEPER]: [ENT_ROOTS, FORCE_NATURE, ENT_ROOTS, FORCE_NATURE, ENT_ROOTS, TRANQUILITY,
      FORCE_NATURE, THORNS_AURA, THORNS_AURA, THORNS_AURA],
    [MOON_CHICK]: [SEARING_ARROWS, TRUESHOT, SEARING_ARROWS, TRUESHOT, SEARING_ARROWS,
      STARFALL, TRUESHOT, SCOUT, SCOUT, SCOUT],
    [WARDEN]: [SHADOW_TOUCH, FAN_KNIVES, SHADOW_TOUCH, FAN_KNIVES, SHADOW_TOUCH, VENGEANCE,
      FAN_KNIVES, BLINK, BLINK, BLINK],
  },
};

export const PLUS_RACES: Record<PlayableRace, PlusRaceTable> = {
  human: HUMAN,
  orc: ORC,
  undead: UNDEAD,
  nightelf: NIGHT_ELF,
};
