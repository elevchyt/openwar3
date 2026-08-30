import type { PlayableRace } from "../../data/races";
import {
  ARCANE_VAULT, VOODOO_LOUNGE, TOMB_OF_RELICS, DEN_OF_WONDERS,
  ABOMINATION, ACOLYTE, ANCIENT_LORE, ANCIENT_PROTECT, ANCIENT_WAR, ANCIENT_WIND, ANIM_DEAD,
  ARCHER, ARCHMAGE, AVATAR, AVIARY, BALLISTA, BANISH, BANSHEE, BARRACKS, BASH, BATRIDER,
  BESTIARY, BLACKSMITH, BLADE_MASTER, BLADE_STORM, BLINK, BLIZZARD, BLOOD_MAGE, BONEYARD,
  BRILLIANCE_AURA, BURROW, CARRION_SCARAB, CARRION_SWARM, CASTLE, CATAPULT, CHAIN_LIGHTNING,
  CHIMAERA, CHIMAERA_ROOST, COPTER, CRITICAL_STRIKE, CRYPT, CRYPT_FIEND, CRYPT_LORD,
  DAMNED_TEMPLE, DARK_RITUAL, DEATH_COIL, DEATH_DECAY, DEATH_KNIGHT, DEATH_PACT, DEMON_HUNTER,
  DEVOTION_AURA, DIVINE_SHIELD, DREAD_LORD, DRUID_CLAW, DRUID_TALON, DRYAD, EARTHQUAKE,
  ELF_ALTAR, ENDURANE_AURA, ENT_ROOTS, EVASION, FAERIE_DRAGON, FAN_KNIVES, FAR_SEER, FAR_SIGHT,
  FLAME_STRIKE, FOOTMAN, FORCE_NATURE, FORGE, FORTRESS, FROST_ARMOR, FROST_NOVA, FROST_WYRM,
  GARGOYLE, GHOUL, GRAVEYARD, GREAT_HALL, GRUNT, GRYPHON, GUARD_TOWER, HEAD_HUNTER,
  HEALING_WAVE, HEX, HIPPO, HOLY_BOLT, HOUSE, HUMAN_ALTAR, HUMAN_DRAGON_HAWK, HUNTERS_HALL,
  HUNTRESS, IMMOLATION, IMPALE, INFERNO, KEEP, KEEPER, KNIGHT, KODO_BEAST, LICH, LOCUST_SWARM,
  LODGE, LUMBER_MILL, MANA_BURN, MASS_TELEPORT, MEAT_WAGON, METAMORPHOSIS, MIRROR_IMAGE,
  MOON_CHICK, MOON_WELL, MORTAR, MOUNTAIN_GIANT, MTN_KING, NECRO, NECROPOLIS_1, NECROPOLIS_2,
  NECROPOLIS_3, OBSIDIAN_STATUE, ORC_ALTAR, ORC_BARRACKS, ORC_WATCH_TOWER, PALADIN, PEASANT,
  PEON, PRIEST, RAIDER, REINCARNATION, RESURRECTION, RIFLEMAN, SANCTUM, SCOUT, SEARING_ARROWS,
  SERPENT_WARD, SHADOW_HUNTER, SHADOW_TOUCH, SHAMAN, SHOCKWAVE, SIPHON_MANA, SLAUGHTERHOUSE,
  SLEEP, SORCERESS, SPELL_BREAKER, SPIRIT_WOLF, STARFALL, STRONGHOLD, SUMMON_PHOENIX, TAUREN,
  TAUREN_CHIEF, THORNS_AURA, THORNY_SHIELD, THUNDER_BOLT, THUNDER_CLAP, TOTEM, TOWN_HALL,
  TRANQUILITY, TREE_AGES, TREE_ETERNITY, TREE_LIFE, TRUESHOT, UNHOLY_AURA, UPG_ABOLISH,
  UPG_ARMOR, UPG_BANSHEE, UPG_BOWS, UPG_BREEDING, UPG_CHIM_ACID, UPG_CLOUD, UPG_CR_ARMOR,
  UPG_CR_ATTACK, UPG_DEFEND, UPG_DRUID_CLAW, UPG_DRUID_TALON, UPG_GHOUL_FRENZY, UPG_GUN_RANGE,
  UPG_HAMMERS, UPG_HIDES, UPG_LEATHER, UPG_MASONRY, UPG_MELEE, UPG_MOON_ARMOR, UPG_NECROS,
  UPG_ORC_ARMOR, UPG_ORC_BERSERKER, UPG_ORC_ENSNARE, UPG_ORC_MELEE, UPG_ORC_PULVERIZE,
  UPG_ORC_RANGED, UPG_ORC_SHAMAN, UPG_ORC_SPIKES, UPG_ORC_WAR_DRUMS, UPG_PRAYING, UPG_RANGED,
  UPG_SORCERY, UPG_STR_MOON, UPG_STR_WILD, UPG_UNHOLY_ARMOR, UPG_UNHOLY_STR, UPG_WOOD,
  UNDEAD_ALTAR, VAMP_AURA, VENGEANCE, VOODOO, WAR_STOMP, WARDEN, WATCH_TOWER, WATER_ELEMENTAL,
  WIND_WALK, WISP,
  WITCH_DOCTOR, WORKSHOP, WYVERN, ZIGGURAT_1, ZIGGURAT_2,
} from "../ids";

// Computer+ — the four races, and the STRATEGIES each of them plays (issues #124).
//
// The classic melee AI is four ~650-line Blizzard scripts with ONE build order each, and the
// first version of Computer+ was the same shape with the script replaced by a table: one army
// mix per race, played every game. Two computers on one map opened identically, every time.
//
// **What AMAI taught us, and what we did with it.** AMAI (github.com/SMUnlimited/AMAI, GPL —
// STUDIED, never copied; see the legal boundary in CLAUDE.md) organises the same problem far
// better, and its `TFT/<Race>/Strategy.txt` is where the idea is legible: a race owns a TABLE
// of named strategies — "I'm going gryphon riders", "I'm going mass crypt fiends", "I'm going
// raiders and spirit walkers" — and each row carries the units it wants, the tier it aims at,
// a weight for being rolled, and, crucially, **its own expansion timing**. That last column is
// the thing worth stealing outright as an idea: in AMAI an orc Raider build expands at ten
// minutes and a night-elf Ancient-of-Lore mix expands at two and a half, because *when you take
// a second mine is part of the build order*, not a property of how good the player is.
//
// Everything below is our own: our unit lists, our weights, our timings. What is AMAI's is the
// SHAPE — a weighted table of named builds, each owning its expansion clock.
//
// **Where we deliberately differ.** AMAI hangs a "profile" on top (Hunter, Crazy_Rusher, Xerox,
// each with a name, a taunt rate and an expansion offset). Issue #124 rules those out in as many
// words, so a Computer+ player is anonymous: the strategy decides the build and nothing decides
// a personality. AMAI also SWITCHES strategy mid-game once `strat_minimum_time` has passed; we
// roll once, at seat time, and hold it — a mid-game switch abandons half-built production, and
// nothing here yet measures whether the switch was worth it.
//
// **The one structural improvement over the reference.** AMAI names each strategy's key
// buildings by hand (`key_building1`, `key_building2`), which can disagree with the units it
// actually asks for. Here a strategy names UNITS and weights only: the buildings it needs are
// derived from the catalogue (`UnitRow.from` / `needs`), and the upgrades it takes are whatever
// the buildings it ended up with can research. A strategy cannot be inconsistent with itself.

/** One unit in a race's catalogue: where it comes from and what it counts as. */
export interface UnitRow {
  /** The producer that must be STANDING and finished before the unit is asked for. Nothing is
   *  ever asked for without it: `OneBuildLoop` reserves a row's gold whether or not the row
   *  could start, so a row for a unit we cannot make yet starves everything below it. */
  from: string;
  /** …and anything else its own tech requires — a Knight needs a Lumber Mill and a Blacksmith
   *  standing, not just a Castle. Derived tech puts these up too. */
  needs?: readonly string[];
  /** The hall tier this unit waits for (1/2/3). Also what `PlusProfile.techTier` caps. */
  tier: number;
  /** Counts as SIEGE for the attack ladder — what lets a wave commit to a base rather than
   *  bouncing off the towers. */
  siege?: boolean;
  /** Counts as AIR: it crosses cliffs, and it makes air creep camps fair game. */
  air?: boolean;
}

/** An upgrade, and how far up it is worth going. */
export interface UpgradeRow {
  id: string;
  /** The building that researches it — `Researches=` in the race's own UnitFunc.txt. It is
   *  also the STRATEGY filter: an Aviary upgrade is only taken by a build that has an Aviary,
   *  which is why no strategy has to list its upgrades. */
  from: string;
  /** Ranks worth taking (armour/weapons are 3, a one-shot is 1). Capped again by
   *  `PlusProfile.upgradeRank`. */
  ranks: number;
  /** Army food that must be fielded first: you upgrade an army you HAVE. */
  after?: number;
}

/** A support building every build of this race wants, whatever its mix. */
export interface SupportRow {
  build: string;
  tier: number;
  /** Army food that must already be fielded. Teching with nothing on the field is how a
   *  computer dies to the first six Footmen it meets. */
  after: number;
}

/**
 * One named build order.
 *
 * A strategy is a WEIGHTED UNIT MIX plus the two clocks that make it a plan rather than a
 * shopping list — when it takes a second town and when it takes a third.
 */
export interface PlusStrategy {
  readonly id: string;
  /** What it is, in the words a player would use. Not shown in the UI (issue #124 wants the
   *  computers anonymous); it is here so a log line and a reader can tell the builds apart. */
  readonly name: string;
  /** Unit id → its share of the army. Relative within the strategy; `plan.ts` normalises
   *  whatever is currently producible and spends the food budget down it. */
  readonly mix: Readonly<Record<string, number>>;
  /** The hall tier this build aims at. A difficulty whose `techTier` is lower cannot roll it —
   *  which is how an easy computer ends up with only the simple builds. */
  readonly tier: number;
  /** Relative chance of being rolled at seat time. */
  readonly weight: number;
  /**
   * When this build takes a SECOND town, and a third, in seconds.
   *
   * The point of the whole file. Expanding is part of a build order: a ranged/defensive opening
   * takes its second mine early because it can hold ground, a hero-and-raiders build takes it
   * late because it intends to be somewhere else, and a tier-3 air build takes it later still.
   * It is NOT a difficulty setting — see `PlusProfile.expandDelay`, which is the only thing
   * difficulty contributes here.
   */
  readonly expandAt: number;
  readonly expandAgainAt: number;
  /** The hero order this build wants, when it wants a particular one. Falls back to the race's. */
  readonly heroes?: readonly string[];
}

export interface PlusRaceTable {
  readonly race: PlayableRace;
  readonly worker: string;
  /** Tier 1 / 2 / 3 halls. Asking for a higher one is an UPGRADE of the lower — see
   *  `AiPlayer.setProduce`, which tries the upgrade route first. */
  readonly halls: readonly [string, string, string];
  readonly farm: string;
  readonly altar: string;
  /** The building the opening is built around — the first thing that makes a soldier. */
  readonly barracks: string;
  /** Put up whatever the mix is: every race has a smith its whole army wants. */
  readonly support: readonly SupportRow[];
  /**
   * The race's own SHOP — Arcane Vault, Voodoo Lounge, Ancient of Wonders, Tomb of Relics.
   *
   * Without one the AI has nowhere to buy anything, and for most of a match that means nothing
   * to press: a map's Goblin Merchant is shared, often far from home, and on plenty of maps not
   * there at all. Measured on Echo Isles: a Normal orc reached ten minutes with a level-3 hero,
   * no Town Portal and no Healing Salve — not because it would not buy them, but because the
   * build order never put up a Voodoo Lounge for it to buy them at.
   *
   * All four sell the same three staples (`phea`, `pman`, `stwp` — read off `Makeitems`), so
   * this is a shop in the sense the AI cares about whatever the race.
   */
  readonly shop: string;
  /** The defensive structure, and the upgrade of it worth taking when there is one (a Human
   *  Guard Tower and an undead Spirit Tower are both upgrades of something already standing). */
  readonly tower: string;
  readonly towerUpgrade?: string;
  /**
   * The unit that CHOPS, when this race's worker cannot — the undead's Ghoul, and nobody
   * else's anything.
   *
   * Three races harvest both resources with one worker and leave this unset. The undead's
   * Acolyte only ever kneels at a mine (`uaco` `lumber: false`, docs/undead.md), so its lumber
   * has to be produced as a UNIT rather than as more workers — which is also why an undead
   * player wants exactly a mine's crew of Acolytes and not one more (see `plan.ts` `workers`).
   */
  readonly lumberUnit?: string;
  /**
   * Units this race wants NO MATTER WHICH BUILD it rolled — the support every strategy needs
   * and none of them should have to list.
   *
   * There is exactly one today and it is the undead's **Obsidian Statue**. A statue is not part
   * of an army composition at all: it is the race's only healer, it is what lets an undead army
   * fight twice without going home, and a build that left it out (three of the five do) fielded
   * an army that had to walk back to base after every engagement. See UNDEAD below for the
   * detail, and note the row also drags its own producer up with it — `mixBuildings` reads
   * this list as well as the strategy's mix, so a Slaughterhouse goes up for it.
   */
  readonly always?: readonly { unit: string; count: number }[];
  /** Every unit this race's strategies may name. */
  readonly units: Readonly<Record<string, UnitRow>>;
  /** The race's whole upgrade list. A build takes the ones its own buildings can research. */
  readonly upgrades: readonly UpgradeRow[];
  /** The builds it knows, and the default hero order for the ones that express no preference. */
  readonly strategies: readonly PlusStrategy[];
  readonly heroes: readonly string[];
  /**
   * Each hero's SKILL BUILDS — a list of them, one rolled per match (`pickHeroes`).
   *
   * A build is the ten levels in the shape `AiPlayer.setSkillArray` reads: index 0 is hero
   * level 1, index 5 is the ultimate (hero level 6). They all take the same shape, and it is
   * the shape the hero-level rules force rather than a style: **A B A B A · ultimate · B ·
   * C C C**, because a rank costs hero level 2n−1 (rank 2 at 3, rank 3 at 5) and the ultimate
   * unlocks at 6. So the first two entries name the pair the hero actually plays with, and
   * everything from index 7 is the skill it left behind.
   *
   * A LIST rather than one build because half of these heroes have more than one real answer
   * and every Computer+ orc was giving the same one: a Blademaster is Wind Walk *or* Mirror
   * Image beside Critical Strike, a Tauren Chieftain is Shock Wave *or* War Stomp beside
   * Endurance Aura, a Demon Hunter is Mana Burn beside Immolation *or* Evasion, and a Mountain
   * King picks two of Storm Bolt / Thunder Clap / Bash. The other heroes have one build each
   * and say so by carrying a list of one, so there is a single shape to read and no second
   * field to keep in step. Which one a seat gets is rolled off the AI's own random stream, like
   * the build order and the hero order.
   */
  readonly skills: Readonly<Record<string, readonly (readonly string[])[]>>;
}

// --------------------------------------------------------------------------------------
//  HUMAN
// --------------------------------------------------------------------------------------

const HUMAN: PlusRaceTable = {
  race: "human",
  worker: PEASANT,
  halls: [TOWN_HALL, KEEP, CASTLE],
  farm: HOUSE,
  altar: HUMAN_ALTAR,
  barracks: BARRACKS,
  support: [{ build: BLACKSMITH, tier: 1, after: 6 }, { build: LUMBER_MILL, tier: 1, after: 12 }],
  shop: ARCANE_VAULT,
  tower: WATCH_TOWER,
  towerUpgrade: GUARD_TOWER,
  units: {
    [FOOTMAN]: { from: BARRACKS, tier: 1 },
    [RIFLEMAN]: { from: BARRACKS, needs: [BLACKSMITH], tier: 1 },
    [KNIGHT]: { from: BARRACKS, needs: [LUMBER_MILL, BLACKSMITH], tier: 3 },
    [PRIEST]: { from: SANCTUM, tier: 2 },
    [SORCERESS]: { from: SANCTUM, tier: 2 },
    [SPELL_BREAKER]: { from: SANCTUM, tier: 3 },
    [MORTAR]: { from: WORKSHOP, tier: 2, siege: true },
    [COPTER]: { from: WORKSHOP, tier: 2, air: true },
    [GRYPHON]: { from: AVIARY, tier: 3, air: true },
    [HUMAN_DRAGON_HAWK]: { from: AVIARY, tier: 3, air: true },
  },
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
    { id: UPG_HAMMERS, from: AVIARY, ranks: 1, after: 24 },
    { id: UPG_CLOUD, from: AVIARY, ranks: 1, after: 30 },
  ],
  strategies: [
    { id: "footmen", name: "Footmen and Riflemen", tier: 2, weight: 30, expandAt: 300, expandAgainAt: 720,
      mix: { [FOOTMAN]: 3, [RIFLEMAN]: 2, [PRIEST]: 1.5, [SORCERESS]: 1 } },
    // A ranged line holds ground, so it takes its second mine early — AMAI's own reading of
    // the same build (its Rifle/BarrackMix rows carry the earliest expansion times it has).
    { id: "rifles", name: "Riflemen and Mortars", tier: 2, weight: 24, expandAt: 240, expandAgainAt: 660,
      mix: { [RIFLEMAN]: 3, [FOOTMAN]: 1.5, [MORTAR]: 1.5, [PRIEST]: 1 } },
    { id: "knights", name: "Knights", tier: 3, weight: 22, expandAt: 420, expandAgainAt: 840,
      heroes: [PALADIN, ARCHMAGE, MTN_KING, BLOOD_MAGE],
      mix: { [KNIGHT]: 3, [FOOTMAN]: 2, [PRIEST]: 1.5, [SORCERESS]: 1, [SPELL_BREAKER]: 1 } },
    { id: "casters", name: "Sorceresses and Spell Breakers", tier: 3, weight: 18, expandAt: 360, expandAgainAt: 780,
      heroes: [ARCHMAGE, BLOOD_MAGE, PALADIN, MTN_KING],
      mix: { [SORCERESS]: 2.5, [PRIEST]: 2, [SPELL_BREAKER]: 1.5, [FOOTMAN]: 2 } },
    // Air is the slowest build to come online, so it is the last to look up from its own base.
    { id: "gryphons", name: "Gryphon Riders", tier: 3, weight: 16, expandAt: 480, expandAgainAt: 900,
      mix: { [GRYPHON]: 3, [HUMAN_DRAGON_HAWK]: 1, [RIFLEMAN]: 1.5, [PRIEST]: 1 } },
  ],
  heroes: [ARCHMAGE, PALADIN, MTN_KING, BLOOD_MAGE],
  skills: {
    // Water Elemental first and maxed: a summoned unit every fight is what makes the Archmage
    // the standard opener, and it is the one hero skill an AI can spend well without micro.
    [ARCHMAGE]: [[WATER_ELEMENTAL, BRILLIANCE_AURA, WATER_ELEMENTAL, BRILLIANCE_AURA,
      WATER_ELEMENTAL, MASS_TELEPORT, BRILLIANCE_AURA, BLIZZARD, BLIZZARD, BLIZZARD]],
    [PALADIN]: [[HOLY_BOLT, DEVOTION_AURA, HOLY_BOLT, DEVOTION_AURA, HOLY_BOLT, RESURRECTION,
      DEVOTION_AURA, DIVINE_SHIELD, DIVINE_SHIELD, DIVINE_SHIELD]],
    // THREE builds, because the Mountain King's card is three good skills and a player takes
    // two of them. Storm Bolt + Thunder Clap is the caster's read (a stun and an area slow);
    // Storm Bolt + Bash is the duellist's, spending the levels on the one target it wants
    // dead; Thunder Clap + Bash is the front-line one, which is what a Mountain King leading
    // Footmen actually looks like.
    [MTN_KING]: [
      [THUNDER_BOLT, THUNDER_CLAP, THUNDER_BOLT, THUNDER_CLAP, THUNDER_BOLT, AVATAR,
        THUNDER_CLAP, BASH, BASH, BASH],
      [THUNDER_BOLT, BASH, THUNDER_BOLT, BASH, THUNDER_BOLT, AVATAR,
        BASH, THUNDER_CLAP, THUNDER_CLAP, THUNDER_CLAP],
      [THUNDER_CLAP, BASH, THUNDER_CLAP, BASH, THUNDER_CLAP, AVATAR,
        BASH, THUNDER_BOLT, THUNDER_BOLT, THUNDER_BOLT],
    ],
    [BLOOD_MAGE]: [[FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE,
      SUMMON_PHOENIX, SIPHON_MANA, BANISH, BANISH, BANISH]],
  },
};

// --------------------------------------------------------------------------------------
//  ORC
// --------------------------------------------------------------------------------------

const ORC: PlusRaceTable = {
  race: "orc",
  worker: PEON,
  halls: [GREAT_HALL, STRONGHOLD, FORTRESS],
  farm: BURROW,
  altar: ORC_ALTAR,
  barracks: ORC_BARRACKS,
  support: [{ build: FORGE, tier: 1, after: 6 }],
  shop: VOODOO_LOUNGE,
  tower: ORC_WATCH_TOWER,
  units: {
    [GRUNT]: { from: ORC_BARRACKS, tier: 1 },
    [HEAD_HUNTER]: { from: ORC_BARRACKS, tier: 1 },
    [CATAPULT]: { from: ORC_BARRACKS, needs: [BESTIARY], tier: 2, siege: true },
    [SHAMAN]: { from: LODGE, tier: 2 },
    [WITCH_DOCTOR]: { from: LODGE, tier: 2 },
    [RAIDER]: { from: BESTIARY, tier: 2 },
    [KODO_BEAST]: { from: BESTIARY, tier: 2 },
    [BATRIDER]: { from: BESTIARY, tier: 2, air: true },
    [WYVERN]: { from: BESTIARY, tier: 3, air: true },
    [TAUREN]: { from: TOTEM, tier: 3 },
  },
  upgrades: [
    { id: UPG_ORC_MELEE, from: FORGE, ranks: 3, after: 8 },
    { id: UPG_ORC_ARMOR, from: FORGE, ranks: 3, after: 8 },
    { id: UPG_ORC_RANGED, from: FORGE, ranks: 3, after: 12 },
    { id: UPG_ORC_SPIKES, from: FORGE, ranks: 1, after: 16 },
    { id: UPG_ORC_BERSERKER, from: ORC_BARRACKS, ranks: 1, after: 12 },
    { id: UPG_ORC_WAR_DRUMS, from: BESTIARY, ranks: 3, after: 20 },
    { id: UPG_ORC_ENSNARE, from: BESTIARY, ranks: 1, after: 16 },
    { id: UPG_ORC_SHAMAN, from: LODGE, ranks: 2, after: 20 },
    { id: UPG_ORC_PULVERIZE, from: TOTEM, ranks: 1, after: 30 },
  ],
  strategies: [
    { id: "grunts", name: "Grunts and Shamans", tier: 2, weight: 30, expandAt: 330, expandAgainAt: 750,
      mix: { [GRUNT]: 3, [HEAD_HUNTER]: 1.5, [SHAMAN]: 1.5, [WITCH_DOCTOR]: 1 } },
    { id: "headhunters", name: "Head Hunters", tier: 1, weight: 26, expandAt: 240, expandAgainAt: 660,
      mix: { [HEAD_HUNTER]: 3, [GRUNT]: 1.5, [WITCH_DOCTOR]: 1 } },
    // Raiders are for being somewhere the enemy is not, so the second mine comes late — the
    // same reading AMAI's own Raider row takes.
    { id: "raiders", name: "Raiders and Kodos", tier: 2, weight: 22, expandAt: 480, expandAgainAt: 900,
      heroes: [BLADE_MASTER, FAR_SEER, SHADOW_HUNTER, TAUREN_CHIEF],
      mix: { [RAIDER]: 3, [GRUNT]: 1.5, [KODO_BEAST]: 0.7, [SHAMAN]: 1 } },
    { id: "taurens", name: "Taurens and Shamans", tier: 3, weight: 20, expandAt: 420, expandAgainAt: 840,
      heroes: [TAUREN_CHIEF, FAR_SEER, BLADE_MASTER, SHADOW_HUNTER],
      mix: { [TAUREN]: 3, [GRUNT]: 1.5, [SHAMAN]: 2, [WITCH_DOCTOR]: 1 } },
    { id: "wyverns", name: "Wyverns and Batriders", tier: 3, weight: 18, expandAt: 450, expandAgainAt: 870,
      mix: { [WYVERN]: 3, [BATRIDER]: 1, [HEAD_HUNTER]: 1.5, [SHAMAN]: 1 } },
  ],
  heroes: [BLADE_MASTER, FAR_SEER, TAUREN_CHIEF, SHADOW_HUNTER],
  skills: {
    // Both of the Blademaster's real openings, beside the Critical Strike that is never in
    // question. Wind Walk is the harassing one — the backstab, and an exit (plus/casting.ts
    // `windWalkRole` plays it as both); Mirror Image is the creeping one, three more bodies
    // for the camp to swing at.
    [BLADE_MASTER]: [
      [WIND_WALK, CRITICAL_STRIKE, WIND_WALK, CRITICAL_STRIKE, WIND_WALK,
        BLADE_STORM, CRITICAL_STRIKE, MIRROR_IMAGE, MIRROR_IMAGE, MIRROR_IMAGE],
      [MIRROR_IMAGE, CRITICAL_STRIKE, MIRROR_IMAGE, CRITICAL_STRIKE, MIRROR_IMAGE,
        BLADE_STORM, CRITICAL_STRIKE, WIND_WALK, WIND_WALK, WIND_WALK],
    ],
    [FAR_SEER]: [[CHAIN_LIGHTNING, SPIRIT_WOLF, CHAIN_LIGHTNING, SPIRIT_WOLF, CHAIN_LIGHTNING,
      EARTHQUAKE, SPIRIT_WOLF, FAR_SIGHT, FAR_SIGHT, FAR_SIGHT]],
    // Endurance Aura is the constant; the damage skill is the choice. Shock Wave is the wave
    // through a creep camp, War Stomp the stun that holds a line together.
    [TAUREN_CHIEF]: [
      [SHOCKWAVE, ENDURANE_AURA, SHOCKWAVE, ENDURANE_AURA, SHOCKWAVE,
        REINCARNATION, ENDURANE_AURA, WAR_STOMP, WAR_STOMP, WAR_STOMP],
      [WAR_STOMP, ENDURANE_AURA, WAR_STOMP, ENDURANE_AURA, WAR_STOMP,
        REINCARNATION, ENDURANE_AURA, SHOCKWAVE, SHOCKWAVE, SHOCKWAVE],
    ],
    [SHADOW_HUNTER]: [[HEALING_WAVE, SERPENT_WARD, HEALING_WAVE, SERPENT_WARD, HEALING_WAVE,
      VOODOO, SERPENT_WARD, HEX, HEX, HEX]],
  },
};

// --------------------------------------------------------------------------------------
//  UNDEAD
// --------------------------------------------------------------------------------------

const UNDEAD: PlusRaceTable = {
  race: "undead",
  worker: ACOLYTE,
  halls: [NECROPOLIS_1, NECROPOLIS_2, NECROPOLIS_3],
  farm: ZIGGURAT_1,
  // `uaod` Altar of Darkness — NOT `utod`, the Temple of the Damned, which is the CASTER
  // building (Necromancers and Banshees) and is what this row used to name. The two read alike
  // in English and the mistake is invisible from here, but it cost the undead its whole hero
  // game: `basics` put up a Temple of the Damned as "the altar", `firstHero` saw one standing
  // and asked for a Death Knight, `SetProduce` had no altar to make one at — and because a hero
  // row HALTS the build loop while the AI saves for it (plus/plan.ts), every row below it
  // starved for the rest of the match. Measured: an undead Computer+ at nineteen minutes with
  // thirty-eight Acolytes, no altar, no hero and no army.
  altar: UNDEAD_ALTAR,
  barracks: CRYPT,
  support: [{ build: GRAVEYARD, tier: 1, after: 6 }],
  // The Spirit Tower is an UPGRADE of a Ziggurat, which is also the food building — so the
  // undead's towers are paid for out of supply it was going to build anyway. There is no
  // separate base to raise, which is why `tower` names the upgraded form directly.
  shop: TOMB_OF_RELICS,
  tower: ZIGGURAT_2,
  // THE GHOUL IS THE UNDEAD'S LUMBERJACK, and it is the only such row in the file. An Acolyte
  // cannot chop (`uaco` `lumber: false` — docs/undead.md), so an undead player who builds only
  // workers builds a race that never sees a stick of lumber; `undead.ai` itself opens with
  // ghouls in the forest and splits them between the trees and the wave by hand (`AG`/`WG`,
  // undead.ai 205-219). `plan.ts` puts up the forest's crew off this row, and
  // `ComputerPlusAi.lumberCrew` decides how many of them the wave may take back.
  lumberUnit: GHOUL,
  // TWO OBSIDIAN STATUES, in every undead build there is.
  //
  // The statue is the undead's ONLY healer — `Arpl` Essence of Blight restores 10 hit points a
  // second and `Arpm` Spirit Touch restores mana (UndeadAbilityFunc, and see UnitAbilities
  // `uobs` = "Arpl,Arpm,Aave") — and unlike a Moon Well it walks with the army. Without one an
  // undead force has to go home between fights, which on a melee map is the fight.
  //
  // Two, because the two abilities are separate autocasts on separate mana bars: one statue
  // pours life and one pours mana, which is exactly how the race is played and is why this is a
  // count rather than a boolean. `ComputerPlusAi.statuePass` is the half that arms them, and it
  // gives LIFE to the first — Essence of Blight is what keeps an army alive, where Spirit Touch
  // only shortens the wait for the next spell.
  //
  // Its producer comes up with it: `mixBuildings` reads this list, so a Slaughterhouse is put
  // up at tier 2 by every undead build whether or not its mix names a Meat Wagon.
  always: [{ unit: OBSIDIAN_STATUE, count: 2 }],
  units: {
    [GHOUL]: { from: CRYPT, tier: 1 },
    [CRYPT_FIEND]: { from: CRYPT, tier: 2 },
    [GARGOYLE]: { from: CRYPT, tier: 3, air: true },
    [NECRO]: { from: DAMNED_TEMPLE, tier: 2 },
    [BANSHEE]: { from: DAMNED_TEMPLE, tier: 2 },
    [MEAT_WAGON]: { from: SLAUGHTERHOUSE, tier: 2, siege: true },
    [ABOMINATION]: { from: SLAUGHTERHOUSE, tier: 3 },
    // TIER TWO, and its own requirement is the TOMB OF RELICS. Both are straight off
    // UndeadUnitFunc: `[uslh] Requires=unp1,ugrv` — a Slaughterhouse needs a Halls of the Dead
    // (tier 2) and a Graveyard, which this race's `support` row already puts up — and
    // `[uobs] Requires=utom`, the Tomb of Relics, which is also its SHOP and so is going up
    // anyway. The row said tier 3, and that alone kept the statue out of almost every match:
    // the undead's own tier-3 clock is past ten minutes, so the race's only healer arrived
    // after the game had been decided.
    [OBSIDIAN_STATUE]: { from: SLAUGHTERHOUSE, needs: [TOMB_OF_RELICS], tier: 2 },
    [FROST_WYRM]: { from: BONEYARD, tier: 3, air: true },
  },
  upgrades: [
    { id: UPG_UNHOLY_STR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_UNHOLY_ARMOR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_CR_ATTACK, from: GRAVEYARD, ranks: 3, after: 12 },
    { id: UPG_CR_ARMOR, from: GRAVEYARD, ranks: 3, after: 16 },
    { id: UPG_GHOUL_FRENZY, from: CRYPT, ranks: 1, after: 12 },
    { id: UPG_NECROS, from: DAMNED_TEMPLE, ranks: 2, after: 20 },
    { id: UPG_BANSHEE, from: DAMNED_TEMPLE, ranks: 2, after: 24 },
  ],
  strategies: [
    { id: "ghouls", name: "Ghouls and Crypt Fiends", tier: 2, weight: 30, expandAt: 270, expandAgainAt: 690,
      mix: { [GHOUL]: 3, [CRYPT_FIEND]: 2, [NECRO]: 1 } },
    { id: "fiends", name: "Crypt Fiends and Statues", tier: 2, weight: 26, expandAt: 300, expandAgainAt: 720,
      mix: { [CRYPT_FIEND]: 3, [GHOUL]: 1.5, [MEAT_WAGON]: 1, [OBSIDIAN_STATUE]: 1 } },
    { id: "necros", name: "Necromancers and Banshees", tier: 2, weight: 20, expandAt: 330, expandAgainAt: 750,
      heroes: [LICH, DEATH_KNIGHT, DREAD_LORD, CRYPT_LORD],
      mix: { [NECRO]: 2.5, [BANSHEE]: 1.5, [GHOUL]: 2, [CRYPT_FIEND]: 1 } },
    { id: "aboms", name: "Abominations and Meat Wagons", tier: 3, weight: 20, expandAt: 420, expandAgainAt: 840,
      heroes: [CRYPT_LORD, DEATH_KNIGHT, LICH, DREAD_LORD],
      mix: { [ABOMINATION]: 3, [MEAT_WAGON]: 1.5, [NECRO]: 1, [OBSIDIAN_STATUE]: 1 } },
    { id: "gargoyles", name: "Gargoyles and Frost Wyrms", tier: 3, weight: 18, expandAt: 450, expandAgainAt: 870,
      mix: { [GARGOYLE]: 3, [FROST_WYRM]: 1, [CRYPT_FIEND]: 1.5, [OBSIDIAN_STATUE]: 1 } },
  ],
  heroes: [DEATH_KNIGHT, LICH, DREAD_LORD, CRYPT_LORD],
  skills: {
    [DEATH_KNIGHT]: [[DEATH_COIL, UNHOLY_AURA, DEATH_COIL, UNHOLY_AURA, DEATH_COIL, ANIM_DEAD,
      UNHOLY_AURA, DEATH_PACT, DEATH_PACT, DEATH_PACT]],
    [LICH]: [[FROST_NOVA, DARK_RITUAL, FROST_NOVA, DARK_RITUAL, FROST_NOVA, DEATH_DECAY,
      DARK_RITUAL, FROST_ARMOR, FROST_ARMOR, FROST_ARMOR]],
    [DREAD_LORD]: [[CARRION_SWARM, VAMP_AURA, CARRION_SWARM, VAMP_AURA, CARRION_SWARM, INFERNO,
      VAMP_AURA, SLEEP, SLEEP, SLEEP]],
    [CRYPT_LORD]: [[IMPALE, CARRION_SCARAB, IMPALE, CARRION_SCARAB, IMPALE, LOCUST_SWARM,
      CARRION_SCARAB, THORNY_SHIELD, THORNY_SHIELD, THORNY_SHIELD]],
  },
};

// --------------------------------------------------------------------------------------
//  NIGHT ELF
// --------------------------------------------------------------------------------------

const NIGHT_ELF: PlusRaceTable = {
  race: "nightelf",
  worker: WISP,
  halls: [TREE_LIFE, TREE_AGES, TREE_ETERNITY],
  farm: MOON_WELL,
  altar: ELF_ALTAR,
  barracks: ANCIENT_WAR,
  support: [{ build: HUNTERS_HALL, tier: 1, after: 4 }],
  shop: DEN_OF_WONDERS,
  tower: ANCIENT_PROTECT,
  units: {
    [ARCHER]: { from: ANCIENT_WAR, tier: 1 },
    [HUNTRESS]: { from: ANCIENT_WAR, needs: [HUNTERS_HALL], tier: 1 },
    [BALLISTA]: { from: ANCIENT_WAR, tier: 2, siege: true },
    [DRYAD]: { from: ANCIENT_LORE, tier: 2 },
    [DRUID_CLAW]: { from: ANCIENT_LORE, tier: 3 },
    [MOUNTAIN_GIANT]: { from: ANCIENT_LORE, tier: 3 },
    [DRUID_TALON]: { from: ANCIENT_WIND, tier: 2 },
    [HIPPO]: { from: ANCIENT_WIND, tier: 3, air: true },
    [FAERIE_DRAGON]: { from: ANCIENT_WIND, tier: 3, air: true },
    [CHIMAERA]: { from: CHIMAERA_ROOST, tier: 3, air: true },
  },
  upgrades: [
    { id: UPG_STR_MOON, from: HUNTERS_HALL, ranks: 3, after: 8 },
    { id: UPG_MOON_ARMOR, from: HUNTERS_HALL, ranks: 3, after: 8 },
    { id: UPG_STR_WILD, from: HUNTERS_HALL, ranks: 3, after: 16 },
    { id: UPG_HIDES, from: HUNTERS_HALL, ranks: 3, after: 16 },
    { id: UPG_BOWS, from: ANCIENT_WAR, ranks: 1, after: 10 },
    // `Redc` rank TWO is what puts Bear Form on the Druid of the Claw at all
    // (`[Abrf] Requires=Redc Requiresamount=2`), which is why the "bears" build exists and why
    // this row is worth two ranks — see the Computer+ caster.
    { id: UPG_DRUID_CLAW, from: ANCIENT_LORE, ranks: 2, after: 18 },
    { id: UPG_ABOLISH, from: ANCIENT_LORE, ranks: 1, after: 18 },
    { id: UPG_DRUID_TALON, from: ANCIENT_WIND, ranks: 2, after: 20 },
    { id: UPG_CHIM_ACID, from: CHIMAERA_ROOST, ranks: 1, after: 30 },
  ],
  strategies: [
    { id: "archers", name: "Archers and Huntresses", tier: 1, weight: 28, expandAt: 240, expandAgainAt: 660,
      heroes: [MOON_CHICK, DEMON_HUNTER, KEEPER, WARDEN],
      mix: { [ARCHER]: 3, [HUNTRESS]: 2, [DRYAD]: 1 } },
    { id: "huntresses", name: "Huntresses and Dryads", tier: 2, weight: 26, expandAt: 300, expandAgainAt: 720,
      mix: { [HUNTRESS]: 3, [DRYAD]: 2, [ARCHER]: 1, [BALLISTA]: 1 } },
    // The Bear Form build. `Redc` rank 2 is what grants `[Abrf]` at all, so this is the one
    // strategy that makes issue #124's named ability reachable in a normal game.
    { id: "bears", name: "Dryads and Druids of the Claw", tier: 3, weight: 24, expandAt: 420, expandAgainAt: 840,
      heroes: [KEEPER, DEMON_HUNTER, MOON_CHICK, WARDEN],
      mix: { [DRUID_CLAW]: 3, [DRYAD]: 2, [HUNTRESS]: 1.5, [MOUNTAIN_GIANT]: 1 } },
    { id: "talons", name: "Druids of the Talon and Hippogryphs", tier: 3, weight: 18, expandAt: 450, expandAgainAt: 870,
      mix: { [DRUID_TALON]: 2.5, [HIPPO]: 2, [ARCHER]: 1.5, [DRYAD]: 1 } },
    { id: "chimaeras", name: "Chimaeras and Dryads", tier: 3, weight: 16, expandAt: 480, expandAgainAt: 900,
      mix: { [CHIMAERA]: 3, [DRYAD]: 2, [HUNTRESS]: 1.5, [FAERIE_DRAGON]: 0.5 } },
  ],
  heroes: [DEMON_HUNTER, KEEPER, MOON_CHICK, WARDEN],
  skills: {
    // Mana Burn is not the choice — the second skill is. Immolation is the creeping build (it
    // clears a camp on its own, and plus/casting.ts now puts it out again afterwards rather
    // than draining the bar); Evasion is the fighting one, which is what a Demon Hunter that
    // means to stand in a line takes instead.
    [DEMON_HUNTER]: [
      [MANA_BURN, IMMOLATION, MANA_BURN, IMMOLATION, MANA_BURN, METAMORPHOSIS,
        IMMOLATION, EVASION, EVASION, EVASION],
      [MANA_BURN, EVASION, MANA_BURN, EVASION, MANA_BURN, METAMORPHOSIS,
        EVASION, IMMOLATION, IMMOLATION, IMMOLATION],
    ],
    [KEEPER]: [[ENT_ROOTS, FORCE_NATURE, ENT_ROOTS, FORCE_NATURE, ENT_ROOTS, TRANQUILITY,
      FORCE_NATURE, THORNS_AURA, THORNS_AURA, THORNS_AURA]],
    [MOON_CHICK]: [[SEARING_ARROWS, TRUESHOT, SEARING_ARROWS, TRUESHOT, SEARING_ARROWS,
      STARFALL, TRUESHOT, SCOUT, SCOUT, SCOUT]],
    [WARDEN]: [[SHADOW_TOUCH, FAN_KNIVES, SHADOW_TOUCH, FAN_KNIVES, SHADOW_TOUCH, VENGEANCE,
      FAN_KNIVES, BLINK, BLINK, BLINK]],
  },
};

export const PLUS_RACES: Record<PlayableRace, PlusRaceTable> = {
  human: HUMAN,
  orc: ORC,
  undead: UNDEAD,
  nightelf: NIGHT_ELF,
};

/**
 * Roll one of a race's strategies.
 *
 * Weighted, off the AI's own stream (never `SimWorld.random` — see `AiPlayer`'s constructor),
 * and filtered by the difficulty's tech ceiling: a build that aims at tier 3 is not a build an
 * easy computer can play, so it never rolls one. That filter is the whole interaction between
 * difficulty and strategy — everything else about a strategy is the same at every rung.
 *
 * Falls back to the lowest-tier build if a ceiling somehow excludes everything, so this can
 * never answer "no strategy".
 */
export function rollStrategy(table: PlusRaceTable, techTier: number, roll: (lo: number, hi: number) => number): PlusStrategy {
  const eligible = table.strategies.filter((s) => s.tier <= techTier);
  const pool = eligible.length ? eligible : [[...table.strategies].sort((a, b) => a.tier - b.tier)[0]];
  const total = pool.reduce((n, s) => n + s.weight, 0);
  let pick = roll(1, Math.max(1, total));
  for (const s of pool) {
    pick -= s.weight;
    if (pick <= 0) return s;
  }
  return pool[pool.length - 1];
}
