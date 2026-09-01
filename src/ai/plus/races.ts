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
  UPG_CR_ATTACK, UPG_DEFEND, UPG_DRUID_CLAW, UPG_DRUID_TALON, UPG_FIEND_WEB, UPG_GHOUL_FRENZY,
  UPG_GUN_RANGE,
  UPG_HAMMERS, UPG_HIDES, UPG_LEATHER, UPG_MASONRY, UPG_MELEE, UPG_MOON_ARMOR, UPG_NECROS,
  UPG_ORC_ARMOR, UPG_ORC_BERSERKER, UPG_ORC_ENSNARE, UPG_ORC_MELEE, UPG_ORC_PULVERIZE,
  UPG_ORC_RANGED, UPG_ORC_SHAMAN, UPG_ORC_SPIKES, UPG_ORC_WAR_DRUMS, UPG_PRAYING, UPG_RANGED,
  UPG_SORCERY, UPG_STR_MOON, UPG_STR_WILD, UPG_UNHOLY_ARMOR, UPG_UNHOLY_STR, UPG_WOOD,
  UNDEAD_ALTAR, UNDEAD_MINE, VAMP_AURA, VENGEANCE, VOODOO, WAR_STOMP, WARDEN, WATCH_TOWER, WATER_ELEMENTAL,
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
// nothing here yet measures whether the switch was worth it. What a build MAY carry is a
// `thenAt3`: the build it grows into when a tier-3 hall lands, named by the rolled build itself
// and fired by the one event a real player transitions on too. That is a clause of the build
// order, not a change of mind about it.
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
  /**
   * Counts as a SPELLCASTER — a Shaman, a Priest, a Necromancer, a Druid of the Talon.
   *
   * It is a SHARE of the army rather than a member of it, and `plan.ts` (`CASTER_SHARE`) caps it
   * as one. The developer's report is the whole reason the flag exists: "there is no true
   * strategy that has ONLY shamans — usually shamans are mixed with actual army units". No build
   * below asks for that, and it is still reachable, because the counter re-weighting can only
   * push one way — plus/counter.ts leaves a weaponless caster at a flat 1.0 (the damage table
   * says nothing about a spell) while it pushes everything with a weapon around it, so a bad
   * matchup quietly PROMOTES the casters it could not judge. The cap is the backstop under that
   * rather than a rebalancing: a double-Arcane-Sanctum build is genuinely half casters and is
   * left exactly where its own weights put it.
   */
  caster?: boolean;
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
  /**
   * Producers this build wants MORE THAN ONE of — "two Arcane Sanctums", "two Ancient of
   * Lores", "two Crypts".
   *
   * The only thing in this file that names a building at all, and rule 2 still holds: `plan.ts`
   * honours a row here only for a building the mix ALREADY implies, so this can say *how many*
   * and never *which*. What it adds is the half a unit list cannot express — how fast the army
   * arrives — and for three of the builds here that is the build's identity rather than a
   * luxury: one Sanctum makes one caster at a time, so a build whose army IS casters arrives at
   * half speed with one of them.
   *
   * `techBuildings`'s own `FACTORY_GOLD` rule is a different question with a similar answer: that
   * one is a RICH player buying another Barracks with gold it cannot otherwise spend.
   */
  readonly factories?: Readonly<Record<string, number>>;
  /**
   * The build this one GROWS INTO once a tier-3 hall is standing — the id of another strategy in
   * the same race's table.
   *
   * "Tier 3 Knights, Priests, Mortars, Flying Machines… can be transitioned into from other
   * builds when tier 3 is reached" (the developer's own words). It is deliberately NOT the
   * mid-game strategy switch this file rejects above: AMAI re-rolls a different plan on a timer,
   * having measured nothing; this is one clause of the build order the seat rolled at the start,
   * fired by the one event a real player also transitions on. The rolled build keeps its clocks
   * and its heroes — what changes is what comes out of the buildings.
   */
  readonly thenAt3?: string;
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
   * The unit this race answers AIR with, and how many of it — the Flying Machine, the Troll
   * Batrider, the Gargoyle, the Hippogryph.
   *
   * "If they see the enemy getting a lot of air units, the Computer+ AI must transition into 1
   * workshop and train Flying Machines to counter enemy air — this can be done on top of
   * whatever is the current strategy (no full commitment to anti-air), and this should be true
   * for other races' anti-air units."
   *
   * A RACE row and not a strategy one, because the answer to air does not depend on which build
   * was rolled and has to be reachable from a build that names no flyer at all. `plan.ts`
   * (`antiAir`) is the only row in the whole ladder that puts up a producer the build order
   * never asked for, and it is bounded on purpose — a handful of one unit on top of the mix,
   * rather than a switch to an anti-air army.
   *
   * All four name the race's DEDICATED answer rather than its best flyer: a Flying Machine and a
   * Hippogryph shoot air and nothing else, which is exactly what makes them safe to bolt onto
   * any build. The counts are OURS — nothing in the install describes an improved AI.
   */
  readonly antiAir?: { readonly unit: string; readonly count: number };
  /**
   * The building this race raises ON a gold mine to make it a mine at all — the undead's
   * **Haunted Gold Mine** (`ugol`), and nobody else's anything.
   *
   * The one row without which an undead expansion is a Necropolis standing beside a rock.
   * Three races walk into the shaft and need nothing but a depot in haul range; the undead's
   * Acolytes kneel in a RING that does not exist until the mine is haunted — `issueGoldWork`
   * refuses a gold order outright while `hauntedMine` is null ([Errors] `Blightminefirst` =
   * "Must haunt gold mine first.", docs/undead.md). So a second town whose hall went up and
   * whose mine was never haunted crews nobody, earns nothing, and reads to every gate above
   * it (`townHasHall`, `minesOwned`) as a working expansion.
   *
   * The night elf's equivalent is NOT here and must not be: an Entangled Gold Mine is what
   * the `Aent` CAST creates rather than something a worker builds, and it is issued from the
   * library layer both AIs share (`AiPlayer.entangleMines`, docs/night-elf.md).
   */
  readonly mineBuilding?: string;
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
  // THE FLYING MACHINE, off one Workshop — the developer's own example of the rule
  // (`PlusRaceTable.antiAir`). It is the human's dedicated answer: `hgyr` shoots air and nothing
  // else, so four of them are worth bolting onto a Knight build and cost it no plan.
  antiAir: { unit: COPTER, count: 4 },
  tower: WATCH_TOWER,
  towerUpgrade: GUARD_TOWER,
  units: {
    [FOOTMAN]: { from: BARRACKS, tier: 1 },
    // `[hrif] Requires=hbla` — the Rifleman is a TIER-1 unit that waits on a Blacksmith, which
    // is what makes "riflemen instead of footmen" a build ORDER rather than a tier-2 plan.
    [RIFLEMAN]: { from: BARRACKS, needs: [BLACKSMITH], tier: 1 },
    [KNIGHT]: { from: BARRACKS, needs: [LUMBER_MILL, BLACKSMITH], tier: 3 }, // `[hkni] Requires=hlum,hcas,hbla`
    [PRIEST]: { from: SANCTUM, tier: 2, caster: true },
    [SORCERESS]: { from: SANCTUM, tier: 2, caster: true },
    // TIER TWO, and its other requirement is the ARCANE VAULT — `[hspt] Requires=hvlt,hkee`
    // (HumanUnitFunc). The row said tier 3, and the Spell Breaker is the double-Sanctum build's
    // MAIN combat unit, so that put a Castle in front of a build that is played at the Keep.
    // Not a `caster` for the same reason: a Spell Breaker fights in the line.
    [SPELL_BREAKER]: { from: SANCTUM, needs: [ARCANE_VAULT], tier: 2 },
    // The Workshop is `[harm] Requires=hkee,hbla`, so both of its units carry the Blacksmith.
    [MORTAR]: { from: WORKSHOP, needs: [BLACKSMITH], tier: 2, siege: true },
    [COPTER]: { from: WORKSHOP, needs: [BLACKSMITH], tier: 2, air: true },
    // The Aviary is `[hgra] Requires=hkee,hlum`; the Gryphon then waits for the Castle
    // (`[hgry] Requires=hcas`) and the Dragonhawk for the Arcane Vault (`[hdhw] Requires=hvlt`)
    // — which makes the Dragonhawk a TIER-2 flyer, the human's other answer to air.
    [GRYPHON]: { from: AVIARY, needs: [LUMBER_MILL], tier: 3, air: true },
    [HUMAN_DRAGON_HAWK]: { from: AVIARY, needs: [LUMBER_MILL, ARCANE_VAULT], tier: 2, air: true },
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
    // THE RIFLE BUILD, and it is a tier-1 build order as much as a tier-2 one: `[hrif]
    // Requires=hbla`, so it opens on a Blacksmith and Riflemen where every other human build
    // opens on Footmen. Paladin first, then the Blood Mage or the Mountain King — which is what
    // `pickHeroes` does with the rest of this list anyway (it swaps the second and third).
    // A ranged line holds ground, so it takes its second mine early.
    { id: "rifles", name: "Riflemen, Priests and Mortars", tier: 2, weight: 26, expandAt: 240, expandAgainAt: 660,
      heroes: [PALADIN, BLOOD_MAGE, MTN_KING, ARCHMAGE], thenAt3: "knights",
      mix: { [RIFLEMAN]: 3, [PRIEST]: 1.2, [MORTAR]: 0.8 } },
    // THE DOUBLE ARCANE SANCTUM. Footmen at tier 1, and at tier 2 a SECOND Sanctum pouring out
    // the three units that come out of it — the Spell Breaker being the army and the other two
    // the support. The second building IS the build: one Sanctum makes one caster at a time.
    { id: "sanctums", name: "Double Arcane Sanctum", tier: 2, weight: 24, expandAt: 330, expandAgainAt: 750,
      heroes: [ARCHMAGE, MTN_KING, PALADIN, BLOOD_MAGE],
      factories: { [SANCTUM]: 2 },
      mix: { [FOOTMAN]: 2, [SPELL_BREAKER]: 2, [SORCERESS]: 1.5, [PRIEST]: 1.5 } },
    // RIFLES AND PRIESTS — the same opening as `rifles`, with the Sanctum rather than the
    // Workshop behind it and the Riflemen never stopping.
    { id: "riflecaster", name: "Riflemen and Priests", tier: 2, weight: 22, expandAt: 270, expandAgainAt: 690,
      heroes: [ARCHMAGE, MTN_KING, PALADIN, BLOOD_MAGE], thenAt3: "knights",
      mix: { [RIFLEMAN]: 3, [PRIEST]: 1.5, [SORCERESS]: 0.5 } },
    // THE CLASSIC TIER-3 ARMY, and the build both rifle openings GROW INTO (`thenAt3`): Knights,
    // Priests, Mortar Teams and a few Flying Machines. Rollable on its own too, in which case
    // the Footman row is what it plays until the Castle lands.
    { id: "knights", name: "Knights, Priests and Mortars", tier: 3, weight: 20, expandAt: 420, expandAgainAt: 840,
      heroes: [PALADIN, ARCHMAGE, MTN_KING, BLOOD_MAGE],
      mix: { [KNIGHT]: 3, [FOOTMAN]: 1, [PRIEST]: 1.5, [MORTAR]: 0.8, [COPTER]: 0.5 } },
    // Air is the slowest build to come online, so it is the last to look up from its own base.
    { id: "gryphons", name: "Gryphon Riders", tier: 3, weight: 12, expandAt: 480, expandAgainAt: 900,
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
  // THE BATS. `[otbr] Requires=ovln` — the Voodoo Lounge, which is also `shop` and is going up
  // for the hero's belt anyway, so the orc's anti-air costs it a Beastiary it may not have had.
  antiAir: { unit: BATRIDER, count: 4 },
  tower: ORC_WATCH_TOWER,
  units: {
    [GRUNT]: { from: ORC_BARRACKS, tier: 1 },
    // `[ohun] Requires=ofor` — the Head Hunter waits on the WAR MILL, which is why "Far Seer and
    // head hunters" is a build order (the mill first) and not just a barracks full of them.
    [HEAD_HUNTER]: { from: ORC_BARRACKS, needs: [FORGE], tier: 1 },
    // The Demolisher is trained at the BARRACKS (`[obar] Trains=ogru,ohun,otbk,ocat`) and needs
    // the War Mill and the Stronghold (`[ocat] Requires=ofor,ostr`). The row named the Beastiary,
    // which is neither its producer nor its requirement — so a build that asked for one put up a
    // building it did not need and waited on a requirement nothing had asked for.
    [CATAPULT]: { from: ORC_BARRACKS, needs: [FORGE], tier: 2, siege: true },
    [SHAMAN]: { from: LODGE, tier: 2, caster: true },
    [WITCH_DOCTOR]: { from: LODGE, tier: 2, caster: true },
    [RAIDER]: { from: BESTIARY, tier: 2 },
    [KODO_BEAST]: { from: BESTIARY, needs: [FORGE], tier: 2 }, // `[okod] Requires=ofor`
    [BATRIDER]: { from: BESTIARY, needs: [VOODOO_LOUNGE], tier: 2, air: true }, // `[otbr] Requires=ovln`
    // TIER TWO. The Beastiary is `[obea] Requires=ostr` and the Wind Rider states no requirement
    // of its own, so it lands with the Stronghold exactly like the Raider beside it. At tier 3
    // the orc's whole tier-2 transition had no air unit in it at all.
    [WYVERN]: { from: BESTIARY, tier: 2, air: true },
    [TAUREN]: { from: TOTEM, needs: [FORGE], tier: 3 }, // `[otau] Requires=ofor,ofrt`
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
    // FAR SEER AND HEAD HUNTERS — a tier-1 build (the War Mill, then the hunters) that is KEPT
    // and enriched at tier 2 rather than replaced: the Spirit Lodge and the Beastiary go up
    // behind the same hunters. Feral Spirit is what makes it the creeping opening, and the
    // second hero is the Shadow Hunter or the Tauren Chieftain.
    { id: "headhunters", name: "Head Hunters, Shamans and Kodos", tier: 2, weight: 28, expandAt: 270, expandAgainAt: 690,
      heroes: [FAR_SEER, SHADOW_HUNTER, TAUREN_CHIEF, BLADE_MASTER],
      mix: { [HEAD_HUNTER]: 3, [SHAMAN]: 1.2, [KODO_BEAST]: 0.8, [WITCH_DOCTOR]: 0.6 } },
    // BLADEMASTER, GRUNTS AND HEAD HUNTERS, enriched at tier 2 with the whole Beastiary —
    // Raiders, a Kodo, Wind Riders — and the Shamans behind them. Always the Shadow Hunter
    // second. Raiders want to be somewhere the enemy is not, so the second mine comes later.
    { id: "grunts", name: "Grunts, Head Hunters and Raiders", tier: 2, weight: 26, expandAt: 330, expandAgainAt: 750,
      heroes: [BLADE_MASTER, SHADOW_HUNTER, FAR_SEER, TAUREN_CHIEF],
      mix: { [GRUNT]: 3, [HEAD_HUNTER]: 1.5, [RAIDER]: 1.5, [SHAMAN]: 1, [KODO_BEAST]: 0.6, [WYVERN]: 0.8 } },
    // TAUREN CHIEFTAIN AND MASS GRUNTS — the simple one, and the one that grows into the Tauren
    // build proper when the Fortress lands (`thenAt3`). At tier 2 the Beastiary adds the Kodo,
    // the Wind Riders and the bats.
    { id: "massgrunts", name: "Grunts, Kodos and Wind Riders", tier: 2, weight: 22, expandAt: 300, expandAgainAt: 720,
      heroes: [TAUREN_CHIEF, SHADOW_HUNTER, FAR_SEER, BLADE_MASTER], thenAt3: "taurens",
      mix: { [GRUNT]: 3.5, [KODO_BEAST]: 0.8, [WYVERN]: 1, [BATRIDER]: 0.5, [SHAMAN]: 0.8 } },
    { id: "taurens", name: "Taurens, Shamans and Wind Riders", tier: 3, weight: 18, expandAt: 420, expandAgainAt: 840,
      heroes: [TAUREN_CHIEF, FAR_SEER, BLADE_MASTER, SHADOW_HUNTER],
      mix: { [TAUREN]: 3, [GRUNT]: 1.5, [SHAMAN]: 1.2, [WYVERN]: 1, [WITCH_DOCTOR]: 0.6 } },
    { id: "wyverns", name: "Wind Riders and Batriders", tier: 3, weight: 12, expandAt: 450, expandAgainAt: 870,
      mix: { [WYVERN]: 3, [BATRIDER]: 0.8, [HEAD_HUNTER]: 1.5, [SHAMAN]: 1 } },
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
  // …and the building that makes a mine a mine for this race alone — see `mineBuilding`.
  mineBuilding: UNDEAD_MINE,
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
  // THE GARGOYLE — out of the CRYPT, which every undead build already owns, so this is the one
  // race whose answer to air is a unit row and no building at all (`[ugar] Requires=ugrv,unp1`).
  antiAir: { unit: GARGOYLE, count: 4 },
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
    // TIER ONE, with a GRAVEYARD standing: `[ucry] Requires=ugrv` and nothing else
    // (UndeadUnitFunc) — the Crypt already makes it under a plain Necropolis. The row said tier
    // 2, so the ghouls-and-fiends opening every undead player writes down could not be played
    // until the Halls of the Dead landed, and the race opened on Ghouls alone.
    [CRYPT_FIEND]: { from: CRYPT, needs: [GRAVEYARD], tier: 1 },
    // …and the Gargoyle is TIER TWO — `[ugar] Requires=ugrv,unp1`, the Graveyard and the Halls
    // of the Dead. At tier 3 the race's own answer to air arrived after the game was decided.
    [GARGOYLE]: { from: CRYPT, needs: [GRAVEYARD], tier: 2, air: true },
    [NECRO]: { from: DAMNED_TEMPLE, tier: 2, caster: true },
    [BANSHEE]: { from: DAMNED_TEMPLE, tier: 2, caster: true },
    [MEAT_WAGON]: { from: SLAUGHTERHOUSE, tier: 2, siege: true },
    [ABOMINATION]: { from: SLAUGHTERHOUSE, tier: 3 }, // `[uabo] Requires=unp2`
    // TIER TWO, and its own requirement is the TOMB OF RELICS. Both are straight off
    // UndeadUnitFunc: `[uslh] Requires=unp1,ugrv` — a Slaughterhouse needs a Halls of the Dead
    // (tier 2) and a Graveyard, which this race's `support` row already puts up — and
    // `[uobs] Requires=utom`, the Tomb of Relics, which is also its SHOP and so is going up
    // anyway. The row said tier 3, and that alone kept the statue out of almost every match:
    // the undead's own tier-3 clock is past ten minutes, so the race's only healer arrived
    // after the game had been decided.
    [OBSIDIAN_STATUE]: { from: SLAUGHTERHOUSE, needs: [TOMB_OF_RELICS], tier: 2 },
    [FROST_WYRM]: { from: BONEYARD, tier: 3, air: true }, // `[ubon] Requires=unp2,usap`
  },
  upgrades: [
    { id: UPG_UNHOLY_STR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_UNHOLY_ARMOR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_CR_ATTACK, from: GRAVEYARD, ranks: 3, after: 12 },
    { id: UPG_CR_ARMOR, from: GRAVEYARD, ranks: 3, after: 16 },
    { id: UPG_GHOUL_FRENZY, from: CRYPT, ranks: 1, after: 12 },
    // WEB, and every fiend build wants it the moment tier 2 lands — it is what lets a GROUND
    // army answer air at all, which for the undead is most of what a Crypt Fiend is for.
    // `[usep] Researches=Ruac,Ruwb,Rugf,Rusf,Rubu` and `[Ruwb] Requires=ugrv,unp1`.
    { id: UPG_FIEND_WEB, from: CRYPT, ranks: 1, after: 10 },
    { id: UPG_NECROS, from: DAMNED_TEMPLE, ranks: 2, after: 20 },
    { id: UPG_BANSHEE, from: DAMNED_TEMPLE, ranks: 2, after: 24 },
  ],
  strategies: [
    // DEATH KNIGHT, GHOULS AND FIENDS — the standard one. The Lich comes with tier 2, WEB comes
    // off the Crypt the moment the Halls of the Dead land (`Ruwb`, in `upgrades` above), and the
    // Banshees are what it adds once there are fiends to stand in front of them. Both Obsidian
    // Statues are the race's rather than the build's — see `always`.
    { id: "fiends", name: "Ghouls and Crypt Fiends", tier: 2, weight: 30, expandAt: 300, expandAgainAt: 720,
      heroes: [DEATH_KNIGHT, LICH, CRYPT_LORD, DREAD_LORD],
      mix: { [CRYPT_FIEND]: 3, [GHOUL]: 2.5, [BANSHEE]: 1 } },
    // CRYPT LORD, and the widest mix the race has: ghouls and fiends from the opening, then Meat
    // Wagons and Necromancers at tier 2. The Death Knight is the SECOND hero here rather than the
    // first — he heals the Crypt Lord, who is already the one that can be stood in front.
    { id: "meatwagons", name: "Fiends, Meat Wagons and Necromancers", tier: 2, weight: 24, expandAt: 330, expandAgainAt: 750,
      heroes: [CRYPT_LORD, DEATH_KNIGHT, LICH, DREAD_LORD],
      mix: { [CRYPT_FIEND]: 2.5, [GHOUL]: 2, [MEAT_WAGON]: 1, [NECRO]: 1.2 } },
    // DREAD LORD MASS GHOULS — the fast one. Vampiric Aura is what makes those ghouls farm, so it
    // expands early, and it is the one undead build that names its SECOND CRYPT: a ghoul army is
    // only as fast as the buildings making it. Gargoyles come with tier 2, and the Death Knight
    // is the second hero (a Death Coil on a ghoul is the same aura read from the other end).
    { id: "ghouls", name: "Mass Ghouls and Gargoyles", tier: 2, weight: 22, expandAt: 240, expandAgainAt: 640,
      heroes: [DREAD_LORD, DEATH_KNIGHT, LICH, CRYPT_LORD],
      factories: { [CRYPT]: 2 },
      mix: { [GHOUL]: 4, [GARGOYLE]: 1.5, [CRYPT_FIEND]: 1 } },
    { id: "aboms", name: "Abominations and Meat Wagons", tier: 3, weight: 16, expandAt: 420, expandAgainAt: 840,
      heroes: [CRYPT_LORD, DEATH_KNIGHT, LICH, DREAD_LORD],
      mix: { [ABOMINATION]: 3, [CRYPT_FIEND]: 1.5, [MEAT_WAGON]: 1.2, [NECRO]: 1 } },
    { id: "frostwyrms", name: "Gargoyles and Frost Wyrms", tier: 3, weight: 12, expandAt: 450, expandAgainAt: 870,
      mix: { [GARGOYLE]: 2.5, [FROST_WYRM]: 1, [CRYPT_FIEND]: 1.5, [NECRO]: 0.8 } },
  ],
  heroes: [DEATH_KNIGHT, LICH, DREAD_LORD, CRYPT_LORD],
  skills: {
    [DEATH_KNIGHT]: [[DEATH_COIL, UNHOLY_AURA, DEATH_COIL, UNHOLY_AURA, DEATH_COIL, ANIM_DEAD,
      UNHOLY_AURA, DEATH_PACT, DEATH_PACT, DEATH_PACT]],
    [LICH]: [[FROST_NOVA, DARK_RITUAL, FROST_NOVA, DARK_RITUAL, FROST_NOVA, DEATH_DECAY,
      DARK_RITUAL, FROST_ARMOR, FROST_ARMOR, FROST_ARMOR]],
    // TWO builds. Carrion Swarm first is the damage one; VAMPIRIC AURA first is what the mass
    // ghoul build is played for — the aura is why those ghouls can creep and farm without going
    // home, so it is maxed rather than merely taken (`ghouls`, above).
    [DREAD_LORD]: [
      [CARRION_SWARM, VAMP_AURA, CARRION_SWARM, VAMP_AURA, CARRION_SWARM, INFERNO,
        VAMP_AURA, SLEEP, SLEEP, SLEEP],
      [VAMP_AURA, CARRION_SWARM, VAMP_AURA, CARRION_SWARM, VAMP_AURA, INFERNO,
        CARRION_SWARM, SLEEP, SLEEP, SLEEP],
    ],
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
  // THE HIPPOGRYPH, off an Ancient of Wind. Like the Flying Machine it is a dedicated anti-air
  // unit, which is what makes it safe to bolt onto a Dryad or a Huntress build.
  antiAir: { unit: HIPPO, count: 4 },
  tower: ANCIENT_PROTECT,
  units: {
    [ARCHER]: { from: ANCIENT_WAR, tier: 1 },
    [HUNTRESS]: { from: ANCIENT_WAR, needs: [HUNTERS_HALL], tier: 1 }, // `[esen] Requires=edob`
    // TIER ONE with a Hunter's Hall, like the Huntress beside it — `[ebal] Requires=edob` and
    // nothing more (NightElfUnitFunc).
    [BALLISTA]: { from: ANCIENT_WAR, needs: [HUNTERS_HALL], tier: 1, siege: true },
    [DRYAD]: { from: ANCIENT_LORE, tier: 2 },
    // TIER TWO — `[edoc] Requires=etoa`, the Tree of Ages. What waits for tier 3 is BEAR FORM,
    // which is `Redc` rank 2 (`[Redc] Requirescount=2 Requires1=etoe`): the build's power spike
    // is an UPGRADE, not the unit, and at tier 3 the unit could not be fielded before it.
    [DRUID_CLAW]: { from: ANCIENT_LORE, tier: 2 },
    [MOUNTAIN_GIANT]: { from: ANCIENT_LORE, needs: [DEN_OF_WONDERS], tier: 2 }, // `[emtg] Requires=etoa,eden`
    [DRUID_TALON]: { from: ANCIENT_WIND, tier: 2, caster: true },
    // The Ancient of Wind is `[eaow] Requires=etoa`, so the Hippogryph is a tier-2 flyer; the
    // Faerie Dragon adds the Den of Wonders (`[efdr] Requires=eden`).
    [HIPPO]: { from: ANCIENT_WIND, tier: 2, air: true },
    [FAERIE_DRAGON]: { from: ANCIENT_WIND, needs: [DEN_OF_WONDERS], tier: 2, air: true },
    [CHIMAERA]: { from: CHIMAERA_ROOST, tier: 3, air: true }, // `[edos] Requires=etoe`
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
    // DEMON HUNTER AND FOUR ARCHERS into the creep camps, then TWO Ancient of Lores at tier 2
    // pouring out Dryads and Druids of the Claw — with `Resi` (Abolish Magic) and `Redc` off the
    // same buildings, and `Redc` rank 2 is what puts Bear Form on the Druid at tier 3. That is
    // the build's power spike, and it is why this one build is worth two Lores.
    { id: "bears", name: "Dryads and Druids of the Claw", tier: 2, weight: 26, expandAt: 330, expandAgainAt: 750,
      heroes: [DEMON_HUNTER, KEEPER, MOON_CHICK, WARDEN],
      factories: { [ANCIENT_LORE]: 2 },
      mix: { [DRUID_CLAW]: 2.5, [DRYAD]: 2, [ARCHER]: 1.5 } },
    // KEEPER OF THE GROVE, ARCHERS AND HUNTRESSES — committed to from tier 1 (the Hunter's Hall
    // is what decides it), with the Priestess of the Moon as the second hero.
    { id: "huntresses", name: "Archers and Huntresses", tier: 1, weight: 26, expandAt: 240, expandAgainAt: 660,
      heroes: [KEEPER, MOON_CHICK, DEMON_HUNTER, WARDEN],
      mix: { [ARCHER]: 2.5, [HUNTRESS]: 2.5, [DRYAD]: 1 } },
    // …the same opening, massing DRYADS out of both Lores instead. Abolish Magic is the upgrade
    // that makes it, and the second hero is the ranged damage the Dryads do not have.
    { id: "dryads", name: "Mass Dryads", tier: 2, weight: 22, expandAt: 300, expandAgainAt: 720,
      heroes: [DEMON_HUNTER, MOON_CHICK, KEEPER, WARDEN],
      factories: { [ANCIENT_LORE]: 2 },
      mix: { [DRYAD]: 3.5, [ARCHER]: 1.5 } },
    // …and the same opening again, teching to the WIND instead: Druids of the Talon behind
    // Archers that never stop, with `Reib` (Improved Bows) off the Ancient of War.
    { id: "talons", name: "Archers and Druids of the Talon", tier: 2, weight: 20, expandAt: 270, expandAgainAt: 690,
      heroes: [DEMON_HUNTER, MOON_CHICK, KEEPER, WARDEN],
      mix: { [ARCHER]: 3, [DRUID_TALON]: 1.2, [DRYAD]: 1 } },
    { id: "chimaeras", name: "Chimaeras and Dryads", tier: 3, weight: 12, expandAt: 480, expandAgainAt: 900,
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
 * Falls back to the LOWEST-TIER builds if a ceiling excludes everything, so this can never
 * answer "no strategy" — and to all of them that share that tier rather than to one, or an easy
 * computer of a race whose builds all aim at tier 2 would open identically in every match it
 * ever played. Its `techTier` still caps the MIX at tier 1, so what it actually fields is the
 * tier-1 half of whichever of them it drew.
 */
export function rollStrategy(table: PlusRaceTable, techTier: number, roll: (lo: number, hi: number) => number): PlusStrategy {
  const eligible = table.strategies.filter((s) => s.tier <= techTier);
  const lowest = Math.min(...table.strategies.map((s) => s.tier));
  const pool = eligible.length ? eligible : table.strategies.filter((s) => s.tier === lowest);
  const total = pool.reduce((n, s) => n + s.weight, 0);
  let pick = roll(1, Math.max(1, total));
  for (const s of pool) {
    pick -= s.weight;
    if (pick <= 0) return s;
  }
  return pool[pool.length - 1];
}
