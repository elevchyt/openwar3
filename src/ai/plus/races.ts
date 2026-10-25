import type { PlayableRace } from "../../data/races";
import {
  ARCANE_VAULT, VOODOO_LOUNGE, TOMB_OF_RELICS, DEN_OF_WONDERS,
  ABOMINATION, ACOLYTE, ANCIENT_LORE, ARCANE_TOWER, ANCIENT_PROTECT, ANCIENT_WAR, ANCIENT_WIND, ANIM_DEAD,
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
  UPG_ARMOR, UPG_BANSHEE, UPG_BLK_SPHINX, UPG_BOWS, UPG_BREEDING, UPG_CHIM_ACID, UPG_CLOUD, UPG_CR_ARMOR,
  UPG_CR_ATTACK, UPG_DEFEND, UPG_DRUID_CLAW, UPG_MARK_CLAW, UPG_DRUID_TALON, UPG_FIEND_WEB, UPG_GHOUL_FRENZY,
  UPG_GUN_RANGE,
  UPG_HAMMERS, UPG_HIDES, UPG_LEATHER, UPG_MASONRY, UPG_MELEE, UPG_MOON_ARMOR, UPG_NECROS,
  UPG_ORC_ARMOR, UPG_ORC_BERSERKER, UPG_ORC_ENSNARE, UPG_ORC_MELEE, UPG_ORC_PULVERIZE,
  UPG_FLAK, UPG_ORC_RANGED, UPG_ORC_SHAMAN, UPG_ORC_SPIKES, UPG_ORC_WAR_DRUMS, UPG_PRAYING, UPG_RANGED,
  UPG_SORCERY, UPG_STR_MOON, UPG_STR_WILD, UPG_UNHOLY_ARMOR, UPG_UNHOLY_STR, UPG_WOOD,
  UNDEAD_ALTAR, UNDEAD_MINE, VAMP_AURA, VENGEANCE, VOODOO, WAR_STOMP, WARDEN, WATCH_TOWER, WATER_ELEMENTAL,
  WIND_WALK, WISP,
  ALCHEMIST, NAGA_WITCH, PIT_LORD, FIRE_LORD, BEASTMASTER, DARK_RANGER, BREWMASTER,
  BREATH_OF_FIRE, DRUNKEN_HAZE, DRUNKEN_BRAWLER, STORM_EARTH_FIRE,
  HEALING_SPRAY, ACID_BOMB, CHEMICAL_RAGE, TRANSMUTE, FORKED_LIGHTNING, FROST_ARROWS, MANA_SHIELD,
  TORNADO, RAIN_OF_FIRE, HOWL_OF_TERROR, CLEAVING_ATTACK, DOOM, INCINERATE, SOUL_BURN, LAVA_SPAWN,
  VOLCANO, SUMMON_BEAR, SUMMON_QUILBEAST, SUMMON_HAWK, STAMPEDE, SILENCE, BLACK_ARROW, LIFE_DRAIN, CHARM,
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
  /**
   * A condition on what the ENEMY fields, for an upgrade that only answers one thing.
   * `"enemyRanged"`: researched only once `ENEMY_RANGED` piercing units of theirs have been seen
   * (plus/plan.ts `upgrades`, off the scouting read `EnemyRead.pierce`). Defend is the case —
   * the developer's "Defend should be researched if the enemy has a few ranged units, don't
   * research it always by default": it cuts PIERCING damage and nothing else.
   */
  when?: "enemyRanged";
  /**
   * A UNIT-ABILITY UNLOCK — Defend, Web, Ghoul Frenzy, the Berserker Upgrade, Ensnare, Abolish
   * Magic: research that gives a unit a button or a body, rather than a rank of a stat. Bought
   * HIGH in the ladder and SAVED for (plan.ts `abilityUpgrades`, `AiPlayer.setBuildUpgrSaved`),
   * because these are researched in the PRODUCTION buildings the army keeps busy.
   */
  unlock?: boolean;
  /** Researched only while one of this UNIT of ours is on the field (or in a queue) — an upgrade
   *  for a unit the active build may not be making at all (Druid Training under a mass-Dryad
   *  build), so the Ancient of Lore does not spend the army's gold on a body nobody has. */
  forUnit?: string;
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
  /**
   * Other builds this one may grow into at tier 3 INSTEAD of `thenAt3`, one rolled per seat at
   * seat time (`rollTransition`, evenly over `thenAt3` and these) and held for the match. The
   * human's: a rifle or a Sanctum army at the Castle goes on to a FEW Knights or to Gryphon
   * Riders — *"both of these variations are very common no matter the build"* (the developer).
   */
  readonly thenAt3Or?: readonly string[];
  /**
   * The same clause one tier earlier: the build this one grows into once a TIER-2 hall stands
   * (its own `thenAt3` still applies at tier 3, and wins there). For a TIER-1 build whose army
   * is an opening rather than a plan — the night elf's Archers and Huntresses, which the
   * developer calls *"a good strategy early in the game, but later it should go for bears"*.
   */
  readonly thenAt2?: string;
  /**
   * Units of the mix taken ONLY with something to spare — a second mine of ours, a bank the
   * build order is visibly not spending, or the unit's producer already standing (plan.ts
   * `activeStrategy`). The night elf's Chimaera: *"even chimeras if it has the resources (or an
   * expo at least)"* — a 140/190 flyer off a 140/190 Roost is not something a one-mine
   * economy fields beside a druid army.
   */
  readonly affluent?: readonly string[];
  /**
   * An INSANE-ONLY build that is never rolled on its own: it REPLACES the build that was rolled
   * when that build opens on one of `first`, with probability `chance` (`insaneVariant`). Its
   * own `heroes` are ignored — the rolled build's opening hero is kept, which is the point: the
   * developer's rules are stated per opening hero ("if starting with Far Seer…", "starting with
   * Crypt Lord or Dreadlord should change the strategy").
   */
  readonly replaces?: { readonly first: readonly string[]; readonly chance: number };
  /** The SECOND/THIRD hero this build wants, over the race's `combos` — see `HeroCombo`. */
  readonly combo?: HeroCombo;
  /**
   * The tier-2 clock for THIS build, over the race's (`PlusRaceTable.tier2Clock`). A build that
   * names one also refuses the tier-up BEFORE it (plan.ts `tier2`), where every other build will
   * buy the Keep at the bottom of the ladder whenever the gold is left over: that is what a
   * rush or a fast expand IS — the hall's 300 gold spent on soldiers or a second mine instead.
   */
  readonly tier2Clock?: number;
  /** The tier-3 clock for THIS build, over the race's (`PlusRaceTable.tier3Clock`). */
  readonly tier3Clock?: number;
  /** A RUSH: the wave does not wait for the hero's third level in the opening (index.ts
   *  `waveReady`'s `EARLY_GAME` gate) — the whole build is spent before the camps would pay. */
  readonly rush?: boolean;
  /**
   * The build's POWER UNIT, asked for high in the ladder — right under the ability unlocks and
   * ABOVE the expansion, the third hero, the towers and the rest of the army (plan.ts
   * `leadUnits`) — as soon as it can be trained, up to this many. The night elf's late grove:
   * reported *"the bears/druids of the claw are coming in VERY late, even after transitioning to
   * tier 3"*, because the Druid of the Claw was one share of the LAST army row and every row
   * that can halt the ladder sat above it.
   */
  readonly lead?: Readonly<Record<string, number>>;
  /** The build's own POWER SPIKE, over the race's (`PlusRaceTable.powerSpike`). */
  readonly powerSpike?: PowerSpike;
  /**
   * Units of the mix that wait for something ELSE to be true first — the unit is left out of the
   * mix (and its producer is not put up for it) until the condition holds (plan.ts
   * `activeStrategy`). A `PowerSpike` because it is the same kind of question: a research rank,
   * a count of a unit, a tier.
   *
   * The developer's two, both "this unit is the SECOND thing the tier is for": the human's
   * Gryphon Riders *"if too many knights"* (`units: [KNIGHT, n]`), and the orc's Taurens *"after
   * getting berserkers"* (`research: [Robk, 1]`).
   */
  readonly waitFor?: Readonly<Record<string, PowerSpike>>;
  /**
   * The build's CARRY — a hero that is not its opener but is the one the build is played
   * around: the Far Seer opening's Tauren Chieftain, *"basically the carry (similar to demon
   * hunter and blademaster)… its goal must be to gain a lot of levels and items through creep
   * camps and shops"* (the developer). While he is alive he is the army's CAPTAIN (index.ts
   * `squadHero`: the hero the party musters on and creeps behind), and he is served FIRST by the
   * shops and the loot (plus/items.ts `ItemCtx.carry`). An opener needs no such clause — the
   * first hero already is all three.
   */
  readonly carry?: string;
  /**
   * The SECOND town is due the moment this hall tier stands, whatever `expandAt` says, and the
   * row moves up the ladder with it the way a won fight's expansion does (plan.ts `expand`).
   * The Blademaster openings': *"try to harass or expand upon reaching tier 2"*.
   */
  readonly expandWithTier?: number;
  /**
   * Never rolled on INSANE — a build the other difficulties keep (`rollStrategy`). The night elf's
   * Druids of the Talon and mass Dryads: the developer's *"remove the talons and dryads builds of
   * the night elf for Computer+ Insane (keep them for other difficulties)"*, after 48 observed
   * Insane matches had them at 0–4 and 1–5.
   */
  readonly notInsane?: boolean;
}

/**
 * The SECOND and THIRD hero a race fields after a given opening hero — the developer's own
 * hero pairings (issue: "improve the Insane difficulty's hero choice"), applied at EVERY
 * difficulty because the second and third rows simply never come up on Easy (one hero) and the
 * third never on Normal (two).
 *
 *  · `second` — one is rolled, evenly.
 *  · `third` — one OPTION is rolled, evenly, and within it the first hero not already fielded.
 *    That is how "Alchemist, or Tauren Chieftain / Shadow Hunter depending on what's missing"
 *    is written: `[[ALCHEMIST], [TAUREN_CHIEF, SHADOW_HUNTER]]`.
 *  · `skills` — a skill build this pairing needs over the hero's usual list (the Blood Mage's
 *    Siphon Mana is his FIRST skill beside a Paladin, because feeding the Paladin's Holy Light is
 *    what the pair is for — plus/casting.ts `siphonMana`).
 *
 * A TAVERN hero the map cannot sell (no Tavern placed, or a Reign of Chaos data set, which has
 * none of them) is skipped like a taken one, and the race's own order fills the gap
 * (index.ts `pickHeroes`).
 */
/**
 * What a build has to have before an INSANE computer takes its army at the enemy's MAIN base
 * (index.ts `spikeHeld`). Until then a wave goes at an expansion it knows of, or creeps — the
 * developer's: *"the night elf's power spike is when it gets bears with master training, so
 * before that it should kinda avoid hitting the enemy's base until it has its power spike (if
 * the opponent has an expansion it should fight at the expansion though)"*, and of the human
 * Riflemen-and-casters build, *"its power spike is at tier 2 when they reach close to 50 food"*.
 * Every clause given must hold; a clause left out asks nothing.
 */
export interface PowerSpike {
  /** A research at at least this rank (`[id, rank]`). */
  readonly research?: readonly [string, number];
  /** At least this many of a unit, finished. */
  readonly units?: readonly [string, number];
  /** The hall tier standing. */
  readonly tier?: number;
  /** Food of the army that would walk (heroes' five included — index.ts `squadFood`). */
  readonly armyFood?: number;
}

export interface HeroCombo {
  readonly second?: readonly string[];
  /** The SECOND hero of this pairing, whichever is rolled, is the build's CARRY
   *  (`PlusStrategy.carry`, resolved at seat time — index.ts `pickHeroOrder`). */
  readonly carry?: boolean;
  readonly third?: readonly (readonly string[])[];
  readonly skills?: Readonly<Record<string, readonly string[]>>;
}

/** The tavern heroes Computer+ hires — their skill builds, shared by every race that hires them.
 *  The same A B A B A · ultimate · B · C C C shape as the race heroes' (`PlusRaceTable.skills`),
 *  with the skill the developer named FIRST (Healing Spray, Summon Lava Spawn, Black Arrow, a
 *  Beastmaster's Bear or Quilbeast). Skill ids are each hero's `heroAbilList`
 *  (Units\UnitAbilities.slk). */
const TAVERN_SKILLS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  [ALCHEMIST]: [[HEALING_SPRAY, ACID_BOMB, HEALING_SPRAY, ACID_BOMB, HEALING_SPRAY, TRANSMUTE,
    ACID_BOMB, CHEMICAL_RAGE, CHEMICAL_RAGE, CHEMICAL_RAGE]],
  [FIRE_LORD]: [[LAVA_SPAWN, SOUL_BURN, LAVA_SPAWN, SOUL_BURN, LAVA_SPAWN, VOLCANO,
    SOUL_BURN, INCINERATE, INCINERATE, INCINERATE]],
  [BEASTMASTER]: [
    [SUMMON_BEAR, SUMMON_QUILBEAST, SUMMON_BEAR, SUMMON_QUILBEAST, SUMMON_BEAR, STAMPEDE,
      SUMMON_QUILBEAST, SUMMON_HAWK, SUMMON_HAWK, SUMMON_HAWK],
    [SUMMON_QUILBEAST, SUMMON_BEAR, SUMMON_QUILBEAST, SUMMON_BEAR, SUMMON_QUILBEAST, STAMPEDE,
      SUMMON_BEAR, SUMMON_HAWK, SUMMON_HAWK, SUMMON_HAWK],
  ],
  // Frost Arrows FIRST, at every difficulty (the developer's rule): the slow is what a Sea Witch
  // is hired for, and plus/casting.ts arms its autocast against PLAYERS only.
  [NAGA_WITCH]: [[FROST_ARROWS, FORKED_LIGHTNING, FROST_ARROWS, FORKED_LIGHTNING, FORKED_LIGHTNING,
    TORNADO, FROST_ARROWS, MANA_SHIELD, MANA_SHIELD, MANA_SHIELD]],
  [PIT_LORD]: [[RAIN_OF_FIRE, CLEAVING_ATTACK, RAIN_OF_FIRE, CLEAVING_ATTACK, RAIN_OF_FIRE, DOOM,
    CLEAVING_ATTACK, HOWL_OF_TERROR, HOWL_OF_TERROR, HOWL_OF_TERROR]],
  [DARK_RANGER]: [[BLACK_ARROW, LIFE_DRAIN, BLACK_ARROW, LIFE_DRAIN, BLACK_ARROW, CHARM,
    LIFE_DRAIN, SILENCE, SILENCE, SILENCE]],
  // BREATH OF FIRE first and maxed first (the developer's), Drunken Haze beside it: the haze is
  // what makes the breath IGNITE ("Units that have Drunken Haze on them will ignite and burn",
  // NeutralAbilityStrings `[ANbf]`), so the two are one combo and plus/casting.ts throws them in
  // that order. `[Npbm] heroAbilList=ANbf,ANdh,ANdb,ANef`.
  [BREWMASTER]: [[BREATH_OF_FIRE, DRUNKEN_HAZE, BREATH_OF_FIRE, DRUNKEN_HAZE, BREATH_OF_FIRE,
    STORM_EARTH_FIRE, DRUNKEN_HAZE, DRUNKEN_BRAWLER, DRUNKEN_BRAWLER, DRUNKEN_BRAWLER]],
};

/** Every tavern hero Computer+ may hire — what `pickHeroes` asks the map's Tavern about. */
export const TAVERN_HEROES: ReadonlySet<string> = new Set(Object.keys(TAVERN_SKILLS));

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
   * When this race's TIER-UP stops waiting its turn in the ladder, in seconds — `plan.ts`
   * `TIER2_CLOCK`, which is the default (180) and stays the default for three of the four.
   *
   * The human overrides it, and the reason is the race's own shape rather than a difficulty
   * setting: the human's first power spike is the **Arcane Sanctum** — the Priests and
   * Sorceresses that make a Footman or Rifleman line into an army — and there is no cheap half
   * of it to buy early, because a Sanctum is `[hars] Requires=hkee` (HumanUnitFunc) and the
   * whole spike therefore sits BEHIND the Keep. It is also the race whose opening costs the
   * most: two of its five builds open on Riflemen, which are `[hrif] Requires=hbla`, so a human
   * pays for a Blacksmith AND the game's dearest tier-1 soldier before it starts saving at all.
   * Reported from real matches: the Computer+ human tiers far too late for a race whose plan
   * does not begin until it has.
   *
   * Measured over ten headless minutes (tools/ai-plus-ladder-test.cjs), with the core-army hold
   * in `plan.ts` beside it: the Keep landed at 442-487s and the first Arcane Sanctum at
   * 552-581s; they now land at 336-358s and 426-438s, which puts the human FIRST of the four
   * races to its second tier rather than last.
   */
  readonly tier2Clock?: number;
  /**
   * The army this race keeps on the field while it SAVES for its second tier — plan.ts
   * `TIER2_ARMY` (8 food: a hero and one soldier) unless a race says otherwise. It is both the
   * army the tier row insists on before it asks and the army the core row stops growing at
   * once the tier is overdue (`coreArmy`).
   *
   * The human says otherwise, and `tier2Clock` is why: its tier-up is due at TWO minutes, so the
   * hold began before the first Rifleman was out and lasted until the Keep stood at six and a
   * half — the developer's "human not having enough units early". Measured over 48 Insane
   * matches (Echo Isles): two Riflemen at seven minutes, the smallest army of the four races at
   * every checkpoint (4.9 units at 7:00 against 6.7–7.7), and 6 wins in 20 decided games. The
   * other three races hold the same 8 food but either tier at three minutes or field their
   * lumber crew as soldiers (the undead's Ghouls). OURS.
   */
  readonly tier2Army?: number;
  /**
   * The race's TIER-3 clock, if its tier 3 IS its plan: from here the third hall is asked for
   * HIGH in the ladder (plan.ts `tier3Due`), above the tech buildings, the smith's upgrades, the
   * siege, the expansion and the third hero — every row that otherwise spends the gold first.
   * Absent = the race tiers to 3 only out of what the bottom of the ladder has left over.
   *
   * The night elf's, because its whole late game is BEHIND the Tree of Eternity (Bear Form is
   * `[Redc] Requires1=etoe`). Reported: an Insane night elf reached tier 3 at 16–17 minutes,
   * having bought most of the Hunter's Hall's upgrades first, against the 10–12 a player
   * reaches it at. Measured headless (tools/ai-plus-ladder-test.cjs): the Tree of Eternity was
   * asked for at 10:47–17:04 and stood at 13:07–19:24 across the five Insane builds.
   */
  readonly tier3Clock?: number;
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
  /** The defensive structure — and, for the one race whose tower is a BASE for something, what
   *  it is upgraded into. (An undead Spirit Tower is also an upgrade of something standing, but
   *  of the supply building, so `tower` names the upgraded form directly there.) */
  readonly tower: string;
  /**
   * What a standing `tower` becomes, in the order the rows are emitted: `perTown` of each id at
   * every town, and an entry with no `perTown` takes whatever towers the town has left. Each id
   * is gated on its OWN `Requires` at emit time (`AiPlayer.techMeets`), because an upgrade row
   * that cannot be legal is not merely ignored — `startUnit` reserves its price off the running
   * budget before `setProduce` is refused, so it taxes every row under it and buys nothing.
   * That, with the Guard Tower's `Requires=hlum` and a Lumber Mill the human build order only
   * puts up at tier 2, is why a human computer stood behind plain Scout Towers all match.
   */
  readonly towerUpgrades?: ReadonlyArray<{ id: string; perTown?: number }>;
  /** The race's POWER SPIKE (`PowerSpike`), which a build may restate (`PlusStrategy.powerSpike`). */
  readonly powerSpike?: PowerSpike;
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
   * The race's ARTILLERY — the Mortar Team, the Demolisher, the Meat Wagon, the Glaive Thrower —
   * which `plan.ts` (`siegeLine`) keeps `PlusProfile.siegeUnits` of once the second tier is
   * standing, whatever build was rolled. A RACE row for `antiAir`'s reason: a build that names
   * no siege still meets towers, and the answer does not depend on which build it is.
   */
  readonly siegeUnit?: string;
  /**
   * Does the siege row go up AHEAD of the tier-2 tech buildings rather than below the
   * upgrades? The developer's call for the UNDEAD alone: "we must also add the Meat Wagon to the
   * undead's second wave". Its Slaughterhouse is also where the Obsidian Statues (`always`)
   * come from, so it is the undead's second tier-2 building in any case; left in its old place
   * it queued behind the Temple of the Damned and six upgrades for the same scarce lumber and
   * stood at about eleven minutes, after both Normal waves had gone. The human keeps its
   * order — its power spike is the Arcane Sanctum, not a Workshop (see `tier2Clock`).
   */
  readonly siegeEarly?: boolean;
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
   * The hero this race ALWAYS trains second when it did not open with him — `pickHeroes` pins
   * him into `heroId2` after the strategy's order and the second/third coin flip have had their
   * say, so no roll can push him to third (or, with a two-hero cap, out of the match).
   *
   * One race states one: the undead's **Death Knight**, the developer's own rule. He is the
   * race's HEAL (Death Coil is the undead army's only way to mend in the field besides the
   * statues) and Unholy Aura is the speed every undead army is played at, so a Crypt Lord or
   * Dread Lord opening that coin-flipped the Lich into second was fielding a tier-2 army with no
   * sustain at all.
   */
  readonly secondHero?: string;
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
  /** The second and third hero after each OPENING hero — see `HeroCombo`. `"*"` is the race's
   *  rule for an opening hero with no row of its own. */
  readonly combos?: Readonly<Record<string, HeroCombo>>;
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
  // THE BLACKSMITH, THEN — THE MOMENT THE KEEP IS UP — THE ARCANE SANCTUM.
  //
  // A support row is "the building every build of this race wants whatever its mix", and for the
  // human that is genuinely two buildings: all five strategies below name a Priest, a Sorceress
  // or a Spell Breaker, so all five want a Sanctum, and it is the race's power spike besides
  // (`tier2Clock`). Stating it here rather than leaving it to `techBuildings` puts it directly
  // behind the tier row instead of below the second hero and the tech, which is where the human
  // spent an extra hundred seconds getting to the thing its whole plan is waiting on.
  //
  // `after: 0` because the gate is the KEEP, not an army: a tier-2 support row is unreachable
  // until `supportDue`'s own `r.tier <= min(techTier, tier)` lets it through, and by then the
  // `TIER2_ARMY` the tier row demanded is already on the field.
  //
  // THE LUMBER MILL IS TIER 2, and that is a correction rather than a preference. It was a
  // tier-1 support row — the only race with two of those — so 120 gold sat above the tier-up
  // from twelve army food onward for a building NO human tier-2 build needs: the Knight and the
  // Gryphon are `Requires=hlum` and both are tier 3, and the Masonry and Lumber Harvesting
  // upgrades it researches are wanted later still. No human ladder build puts a Lumber Mill in
  // front of its Keep.
  support: [
    { build: BLACKSMITH, tier: 1, after: 6 },
    { build: SANCTUM, tier: 2, after: 0 },
    { build: LUMBER_MILL, tier: 2, after: 12 },
  ],
  // A MINUTE EARLIER THAN THE OTHER THREE — see `PlusRaceTable.tier2Clock`.
  tier2Clock: 120,
  // …and a hero and FOUR soldiers on the field while it saves (5 + 4 × 3 for the Rifleman the
  // three rifle builds field), not a hero and one — see `PlusRaceTable.tier2Army`.
  tier2Army: 17,
  shop: ARCANE_VAULT,
  // THE FLYING MACHINE, off one Workshop — the developer's own example of the rule
  // (`PlusRaceTable.antiAir`). It is the human's dedicated answer: `hgyr` shoots air and nothing
  // else, so four of them are worth bolting onto a Knight build and cost it no plan.
  antiAir: { unit: COPTER, count: 4 },
  siegeUnit: MORTAR,
  tower: WATCH_TOWER,
  // As human.ai takes them: ONE Arcane Tower per town (178–180, 195–198, 240–243) and every
  // other Scout Tower a Guard Tower (284: `countDone(WATCH_TOWER) − count(ARCANE_TOWER)`). The
  // Arcane Tower goes first because it is the one with no requirement (`[hatw] Requires=` is
  // empty; `[hgtw] Requires=hlum`), so it is the upgrade a tier-1 base can actually buy. No
  // Cannon Tower: human.ai never asks for one either, and its `Requires=harm` is a Workshop.
  towerUpgrades: [
    { id: ARCANE_TOWER, perTown: 1 },
    { id: GUARD_TOWER },
  ],
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
  // The UNIT-ABILITY unlocks go FIRST in every race's list — Defend here, Berserker Upgrade and
  // Ensnare for the orc, Web and Ghoul Frenzy for the undead. A research row never reserves gold
  // nor halts the ladder (`AiPlayer.startUpgrade`); it is bought out of what is left, in LIST
  // ORDER, so an unlock listed behind three ranks each of attack and armour waited for all six
  // of them: measured live, an Insane undead's Web arrived at 13:21 (the developer's "make sure
  // each race uses their upgrades like Web and Berserker Strength").
  upgrades: [
    { id: UPG_DEFEND, from: BARRACKS, ranks: 1, after: 6, when: "enemyRanged", unlock: true },
    { id: UPG_MELEE, from: BLACKSMITH, ranks: 3, after: 8 },
    { id: UPG_ARMOR, from: BLACKSMITH, ranks: 3, after: 8 },
    { id: UPG_RANGED, from: BLACKSMITH, ranks: 3, after: 12 },
    { id: UPG_LEATHER, from: BLACKSMITH, ranks: 3, after: 16 },
    { id: UPG_MASONRY, from: LUMBER_MILL, ranks: 3, after: 16 },
    { id: UPG_WOOD, from: LUMBER_MILL, ranks: 2, after: 12 },
    { id: UPG_GUN_RANGE, from: BARRACKS, ranks: 1, after: 16 },
    { id: UPG_BREEDING, from: BARRACKS, ranks: 1, after: 24 },
    // PRIEST TRAINING is an UNLOCK, saved for: rank 1 is Dispel Magic and rank 2 is INNER FIRE
    // (`[Ainf] Requires=Rhpt Requiresamount=2`, HumanAbilityFunc), the buff the developer names
    // beside the Knights and the Gryphons as what tier 3 is for — and rank 2 is `[Rhpt]
    // Requires1=hcas`, so with the rush (profile.ts `tier3Rush`) it is the first thing the Castle
    // buys. As an ordinary row it was bought out of spare change at the bottom of the ladder. The
    // autocast is the sim's (it goes on the ally in the fight); plus/casting.ts arms it.
    { id: UPG_PRAYING, from: SANCTUM, ranks: 2, after: 12, unlock: true, forUnit: PRIEST },
    { id: UPG_SORCERY, from: SANCTUM, ranks: 2, after: 20 },
    // FLAK CANNONS — the Flying Machine's answer to an air ARMY: "an area effect damage attack
    // against air units" (`Aflk`, `Requires=Rhfc`; the sim's splash, world.ts). The human's
    // anti-air row (`antiAir`) is Flying Machines, and against a clump of Gryphons or Frost
    // Wyrms four of them without it are four bodies plinking one target each. An UNLOCK, saved
    // for, and only once a Flying Machine is out (`forUnit`) — which is to say only once air
    // has been seen or the build named one. `[Rhfc] Requires=hkee`, at the Workshop.
    { id: UPG_FLAK, from: WORKSHOP, ranks: 1, after: 0, unlock: true, forUnit: COPTER },
    { id: UPG_HAMMERS, from: AVIARY, ranks: 1, after: 24 },
    { id: UPG_CLOUD, from: AVIARY, ranks: 1, after: 30 },
  ],
  strategies: [
    // THE RIFLE BUILD, and it is a tier-1 build order as much as a tier-2 one: `[hrif]
    // Requires=hbla`, so it opens on a Blacksmith and Riflemen where every other human build
    // opens on Footmen. Paladin first, then the Blood Mage (the race's `combos` row for him).
    // A ranged line holds ground, so it takes its second mine early.
    { id: "rifles", name: "Riflemen, Priests and Mortars", tier: 2, weight: 26, expandAt: 240, expandAgainAt: 660,
      heroes: [PALADIN, BLOOD_MAGE, MTN_KING, ARCHMAGE], thenAt3: "knightpriests",
      mix: { [RIFLEMAN]: 3, [PRIEST]: 1.2, [MORTAR]: 0.8 } },
    // THE DOUBLE ARCANE SANCTUM. Footmen at tier 1, and at tier 2 a SECOND Sanctum pouring out
    // the three units that come out of it — the Spell Breaker being the army and the other two
    // the support. The second building IS the build: one Sanctum makes one caster at a time.
    { id: "sanctums", name: "Double Arcane Sanctum", tier: 2, weight: 24, expandAt: 330, expandAgainAt: 750,
      heroes: [ARCHMAGE, MTN_KING, PALADIN, BLOOD_MAGE],
      factories: { [SANCTUM]: 2 }, thenAt3: "knightpriests",
      mix: { [FOOTMAN]: 2, [SPELL_BREAKER]: 2, [SORCERESS]: 1.5, [PRIEST]: 1.5 } },
    // RIFLES AND PRIESTS — the same opening as `rifles`, with the Sanctum rather than the
    // Workshop behind it and the Riflemen never stopping.
    { id: "riflecaster", name: "Riflemen and Priests", tier: 2, weight: 22, expandAt: 270, expandAgainAt: 690,
      powerSpike: { tier: 2, armyFood: 46 },
      heroes: [ARCHMAGE, MTN_KING, PALADIN, BLOOD_MAGE], thenAt3: "knightpriests",
      mix: { [RIFLEMAN]: 3, [PRIEST]: 1.5, [SORCERESS]: 0.5 } },
    // THE CLASSIC TIER-3 ARMY, and the build both rifle openings GROW INTO (`thenAt3`): Knights,
    // Priests, Mortar Teams and a few Flying Machines. Rollable on its own too, in which case
    // the RIFLEMAN row is what it plays until the Castle lands — it opens on the Paladin, and
    // "when the Human Computer+ AI goes Paladin first, it should get mass riflemen, not
    // footmen" (the developer). It was a Footman row, so a Paladin opening that rolled this
    // build fielded nothing but Footmen for its first ten minutes. At tier 3 the same row is
    // the ranged line the Knights stand in front of, and it is what both rifle builds have
    // massed by the time they grow into this one.
    //
    // At the Castle it grows into the Knight army every human build ends in (`knightpriests`);
    // until then it is the rifle line with its Priests and Mortars.
    { id: "knights", name: "Knights, Riflemen and Priests", tier: 3, weight: 20, expandAt: 420, expandAgainAt: 840,
      heroes: [PALADIN, BLOOD_MAGE, MTN_KING, ARCHMAGE], thenAt3: "knightpriests",
      mix: { [RIFLEMAN]: 3, [PRIEST]: 1.5, [MORTAR]: 0.8 } },
    // Air is the slowest build to come online, so it is the last to look up from its own base.
    { id: "gryphons", name: "Gryphon Riders", tier: 3, weight: 12, expandAt: 480, expandAgainAt: 900,
      mix: { [GRYPHON]: 3, [HUMAN_DRAGON_HAWK]: 1, [RIFLEMAN]: 1.5, [PRIEST]: 1 } },
    // THE HUMAN TIER 3 — never rolled (weight 0), and what every human tier-2 build grows into
    // (`thenAt3`). The developer: *"the tier 3 build that makes humans beat undead is knights +
    // 2-3 flying machines + priests with master training (for inner fire on knights and heroes).
    // if too many knights, gryphon riders can be bought as well. this way, human will be strong
    // in the late game similar to the undead and night elf."*
    //
    //  · KNIGHTS are the army — `[hkni] Requires=hlum,hcas,hbla`, the Castle's own unit;
    //  · PRIESTS behind them, whose Master Training is INNER FIRE (`UPG_PRAYING` rank 2, an unlock
    //    row bought the moment the Castle stands). The autocast is the sim's and lands on whoever
    //    is swinging, which in this army is the Knights and the heroes (world.ts `FIGHTER_BUFFS`);
    //  · THREE FLYING MACHINES as a COUNT and not a share (`lead`), because the developer's number
    //    is a number: a share of a 70-food army is a dozen of them, and a share of a 20-food one
    //    none. They are the army's eyes and its answer to a Gargoyle or a Frost Wyrm;
    //  · and GRYPHON RIDERS once there are already six Knights (`waitFor`) — "if too many
    //    knights", which is to say once the Knights are not what the next 280 gold is short of.
    //    Six is OURS.
    //
    // It replaces four transitions (Riflemen + a few Knights or Gryphons, Sanctum casters + a few
    // Knights or Gryphons) that kept the tier-2 army as the bulk and added the Castle's units on
    // top of it.
    { id: "knightpriests", name: "Knights, Priests and Flying Machines", tier: 3, weight: 0, expandAt: 420, expandAgainAt: 840,
      lead: { [COPTER]: 3 }, waitFor: { [GRYPHON]: { units: [KNIGHT, 6] } },
      mix: { [KNIGHT]: 3, [PRIEST]: 1.5, [GRYPHON]: 1.5 } },
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
    ...TAVERN_SKILLS,
  },
  // The developer's pairings. PALADIN → the Blood Mage, SIPHON MANA FIRST: he drains whatever
  // has mana on the other side and pours it into the Paladin, who spends it on Holy Light
  // (plus/casting.ts `siphonMana`). ARCHMAGE → the Mountain King. The third is the Paladin when
  // there is none yet, else the Alchemist for Healing Spray.
  combos: {
    [PALADIN]: {
      second: [BLOOD_MAGE],
      third: [[PALADIN, ALCHEMIST]],
      skills: {
        [BLOOD_MAGE]: [SIPHON_MANA, FLAME_STRIKE, SIPHON_MANA, FLAME_STRIKE, SIPHON_MANA,
          SUMMON_PHOENIX, FLAME_STRIKE, BANISH, BANISH, BANISH],
      },
    },
    [ARCHMAGE]: { second: [MTN_KING], third: [[PALADIN, ALCHEMIST]] },
    "*": { third: [[PALADIN, ALCHEMIST]] },
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
  siegeUnit: CATAPULT,
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
    // `[Robk] Requires=ofrt,ofor` — a Fortress and a War Mill, so it comes up at tier 3 and is
    // the first thing bought there. Ensnare (`[Roen]`, no requirement) is the Raider's.
    { id: UPG_ORC_BERSERKER, from: ORC_BARRACKS, ranks: 1, after: 12, unlock: true },
    { id: UPG_ORC_ENSNARE, from: BESTIARY, ranks: 1, after: 12, unlock: true },
    { id: UPG_ORC_MELEE, from: FORGE, ranks: 3, after: 8 },
    { id: UPG_ORC_ARMOR, from: FORGE, ranks: 3, after: 8 },
    { id: UPG_ORC_RANGED, from: FORGE, ranks: 3, after: 12 },
    { id: UPG_ORC_SPIKES, from: FORGE, ranks: 1, after: 16 },
    { id: UPG_ORC_WAR_DRUMS, from: BESTIARY, ranks: 3, after: 20 },
    // SHAMAN TRAINING, saved for like Priest Training and for the same reason: rank 2 is
    // BLOODLUST (`[Ablo] Requires=Rost Requiresamount=2`, OrcAbilityFunc), and rank 2 is `[Rost]
    // Requires1=ofrt` — the Fortress the rush buys. The developer's orc tier 3 is "Berserkers,
    // Bloodlust, Taurens".
    { id: UPG_ORC_SHAMAN, from: LODGE, ranks: 2, after: 12, unlock: true, forUnit: SHAMAN },
    { id: UPG_ORC_PULVERIZE, from: TOTEM, ranks: 1, after: 30 },
  ],
  strategies: [
    // THE ORC PLAYS TWO OPENINGS, and each goes one of two ways at tier 2. The developer's:
    // *"the orc basically plays two builds, a blademaster opening (which is similar to night
    // elf's demon hunter opening) and a far seer opening"*, and at tier 2 *"Orc players tend to
    // build two Bestiaries (for pumping out raiders + ensnare along with a single Kodo Beast for
    // its aura), which is an aggressive build that allows the orc to dominate the map during its
    // tier 2 to contest creep camps fast and expand with ease or be aggressive against an
    // opponent's expo OR the more standard build where they build one bestiary for raiders +
    // ensnare + 1 kodo beast and one spirit lodge for shamans and they try to reach tier 3 to get
    // the berserker upgrade along with master training on their shamans"*. So four builds, an
    // opening by a tier-2 plan, and all four grow into the same tier 3 (`taurens`):
    //
    //  · the KODO is a COUNT and not a share (`lead`) — one, for its War Drums aura;
    //  · ENSNARE is an unlock row off the Beastiary (`upgrades`), bought the moment it stands —
    //    *"the orc is still strong when it gets the Ensnare as it can pick off units with its
    //    raiders"*;
    //  · the TWO-BEASTIARY plan is a tier-2 army, so it names its own tier-3 clock (`tier3Clock`,
    //    which a build's own clock holds against the Insane rush — plan.ts `tier3Due`) and takes
    //    its second mine with the Stronghold (`expandWithTier`). 600 s is OURS: about two minutes
    //    of the Stronghold's map control before the Fortress is saved for;
    //  · the STANDARD plan rushes tier 3 like every other Insane build (`PlusProfile.tier3Rush`).
    //
    // The BLADEMASTER openings are played FOR the Blademaster: *"get as many levels as possible
    // on the blademaster and try to harass or expand upon reaching tier 2 (shadow hunter must be
    // trained as fast as possible upon reaching tier 2)"* — so the second mine comes with the
    // Stronghold (`expandWithTier`), and the Shadow Hunter is the second hero (`combos`), whom
    // `tierTwoHero` buys above everything else the Stronghold makes affordable. Grunts at tier 1;
    // the standard plan adds the Head Hunters the Berserker Upgrade is for.
    { id: "bmraiders", name: "Blademaster, Grunts and two Beastiaries", tier: 2, weight: 25, expandAt: 330, expandAgainAt: 750,
      heroes: [BLADE_MASTER, SHADOW_HUNTER, TAUREN_CHIEF, FAR_SEER], expandWithTier: 2, tier3Clock: 600,
      factories: { [BESTIARY]: 2 }, lead: { [KODO_BEAST]: 1 }, thenAt3: "taurens",
      mix: { [GRUNT]: 2, [RAIDER]: 3 } },
    { id: "bmstandard", name: "Blademaster, Grunts, Raiders and Shamans", tier: 2, weight: 25, expandAt: 330, expandAgainAt: 750,
      heroes: [BLADE_MASTER, SHADOW_HUNTER, TAUREN_CHIEF, FAR_SEER], expandWithTier: 2,
      lead: { [KODO_BEAST]: 1 }, thenAt3: "taurens",
      mix: { [GRUNT]: 2, [HEAD_HUNTER]: 1.5, [RAIDER]: 1.5, [SHAMAN]: 1.2 } },
    // The FAR SEER openings are played for the TAUREN CHIEFTAIN: *"for far seer opening, the
    // goal is to get a tauren chieftain as the second hero as soon as tier 2 is reached, and the
    // tauren chieftain is basically the "carry" … its goal must be to gain a lot of levels and
    // items through creep camps and shops"* — `carry`, which makes him the army's captain and the
    // first in line at a shop and at a drop — and *"when going Far Seer the computer+ (iNSANE) AI
    // must focus on mass producing head hunters while also teching up"*: the Head Hunter is the
    // army at every tier (`[ohun] Requires=ofor`, the War Mill the race's support row puts up),
    // and the standard plan pours it out of two Barracks.
    { id: "fsraiders", name: "Far Seer, Head Hunters and two Beastiaries", tier: 2, weight: 25, expandAt: 300, expandAgainAt: 720,
      heroes: [FAR_SEER, TAUREN_CHIEF, SHADOW_HUNTER, BLADE_MASTER], carry: TAUREN_CHIEF, expandWithTier: 2, tier3Clock: 600,
      factories: { [BESTIARY]: 2 }, lead: { [KODO_BEAST]: 1 }, thenAt3: "taurens",
      mix: { [HEAD_HUNTER]: 3, [RAIDER]: 2.5 } },
    { id: "fsstandard", name: "Far Seer, mass Head Hunters, Raiders and Shamans", tier: 2, weight: 25, expandAt: 270, expandAgainAt: 690,
      heroes: [FAR_SEER, TAUREN_CHIEF, SHADOW_HUNTER, BLADE_MASTER], carry: TAUREN_CHIEF,
      factories: { [ORC_BARRACKS]: 2 }, lead: { [KODO_BEAST]: 1 }, thenAt3: "taurens",
      mix: { [HEAD_HUNTER]: 3.5, [RAIDER]: 1.2, [SHAMAN]: 1.2 } },
    // THE ORC TIER 3 — never rolled (weight 0), only grown into. The developer's: *"Taurens can be
    // added on tier 3 after getting berserkers along with shamans with master training for their
    // bloodlust ability"*. So three things and nothing else: the Head Hunters, who ARE the
    // Berserkers — `[Robk]` (an unlock row above, bought the moment the Fortress stands) swaps
    // every `ohun` for an `otbk` and takes `ohun` off the Barracks' shelf, and
    // `AiPlayer.replacedBy` trains the Berserker wherever this row names the Head Hunter; the
    // Shamans, whose Master Training (`Rost` rank 2, also an unlock row) is BLOODLUST, an autocast
    // the sim lays on whoever is swinging (world.ts `FIGHTER_BUFFS`); and the Taurens, which wait
    // for the Berserker Upgrade (`waitFor`) and then go in front. The Berserker is also the answer
    // to air (`ohun`/`otbk` `targs1` include AIR); `antiAir` still adds Batriders against an army
    // that is mostly flyers. What the opening fielded — Grunts, Raiders — still stands; it is just
    // not rebuilt.
    { id: "taurens", name: "Berserkers, Shamans and Taurens", tier: 3, weight: 0, expandAt: 420, expandAgainAt: 840,
      waitFor: { [TAUREN]: { research: [UPG_ORC_BERSERKER, 1] } },
      mix: { [TAUREN]: 3, [HEAD_HUNTER]: 2.5, [SHAMAN]: 1.5 } },
  ],
  heroes: [BLADE_MASTER, FAR_SEER, TAUREN_CHIEF, SHADOW_HUNTER],
  skills: {
    // CRITICAL STRIKE FIRST AND MAXED FIRST, whichever skill goes beside it — the developer's
    // *"the blademaster must always max out/level up Critical Strike first"*. The choice is the
    // second skill: Wind Walk is the harassing one — the backstab, and an exit (plus/casting.ts
    // `windWalkRole` plays it as both); Mirror Image is the creeping one, three more bodies for
    // the camp to swing at.
    [BLADE_MASTER]: [
      [CRITICAL_STRIKE, WIND_WALK, CRITICAL_STRIKE, WIND_WALK, CRITICAL_STRIKE,
        BLADE_STORM, WIND_WALK, MIRROR_IMAGE, MIRROR_IMAGE, MIRROR_IMAGE],
      [CRITICAL_STRIKE, MIRROR_IMAGE, CRITICAL_STRIKE, MIRROR_IMAGE, CRITICAL_STRIKE,
        BLADE_STORM, MIRROR_IMAGE, WIND_WALK, WIND_WALK, WIND_WALK],
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
    // HEX FIRST or HEALING WAVE FIRST — the developer's "shadow hunter must start with either
    // Hex or Healing Wave", and the two are each other's second skill: a Shadow Hunter's whole
    // job is the heal and the one disable (plus/casting.ts aims the Hex at HEROES first).
    [SHADOW_HUNTER]: [
      [HEALING_WAVE, HEX, HEALING_WAVE, HEX, HEALING_WAVE,
        VOODOO, HEX, SERPENT_WARD, SERPENT_WARD, SERPENT_WARD],
      [HEX, HEALING_WAVE, HEX, HEALING_WAVE, HEX,
        VOODOO, HEALING_WAVE, SERPENT_WARD, SERPENT_WARD, SERPENT_WARD],
    ],
    ...TAVERN_SKILLS,
  },
  // BLADEMASTER → ALWAYS the Shadow Hunter, then the Tauren Chieftain. FAR SEER → ALWAYS the
  // Tauren Chieftain (the build's carry), then the Shadow Hunter. The developer's: *"third hero is
  // usually shadow hunter or tauren chieftain depending on which one was bought second (the one
  // or the other)"*.
  combos: {
    [BLADE_MASTER]: { second: [SHADOW_HUNTER], third: [[TAUREN_CHIEF]] },
    [FAR_SEER]: { second: [TAUREN_CHIEF], third: [[SHADOW_HUNTER]] },
    // No build here opens on the Tauren Chieftain any more, but a hero order that does (a
    // reordered build, a later table) still takes the Shadow Hunter beside him and never a
    // Blademaster — two melee heroes and no sustain, "a very wrong build" (the developer).
    [TAUREN_CHIEF]: { second: [SHADOW_HUNTER], third: [[FAR_SEER, SHADOW_HUNTER]] },
    "*": { third: [[TAUREN_CHIEF, SHADOW_HUNTER, FAR_SEER]] },
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
  siegeUnit: MEAT_WAGON,
  siegeEarly: true,
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
    // WEB, and every fiend build wants it the moment tier 2 lands — it is what lets a GROUND
    // army answer air at all, which for the undead is most of what a Crypt Fiend is for.
    // `[usep] Researches=Ruac,Ruwb,Rugf,Rusf,Rubu` and `[Ruwb] Requires=ugrv,unp1`. FIRST, with
    // Ghoul Frenzy (`[Rugf] Requires=ugrv,unp2`) — see the human list's note.
    { id: UPG_FIEND_WEB, from: CRYPT, ranks: 1, after: 6, unlock: true },
    { id: UPG_GHOUL_FRENZY, from: CRYPT, ranks: 1, after: 8, unlock: true },
    { id: UPG_UNHOLY_STR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_UNHOLY_ARMOR, from: GRAVEYARD, ranks: 3, after: 8 },
    { id: UPG_CR_ATTACK, from: GRAVEYARD, ranks: 3, after: 12 },
    { id: UPG_CR_ARMOR, from: GRAVEYARD, ranks: 3, after: 16 },
    { id: UPG_NECROS, from: DAMNED_TEMPLE, ranks: 2, after: 20 },
    { id: UPG_BANSHEE, from: DAMNED_TEMPLE, ranks: 2, after: 24 },
    // DESTROYER FORM, off the Slaughterhouse that already makes both statues (`always`). Without
    // it the statue's third button is dead for the whole match — `[Aave] Requires=Rusp`, and
    // `[Rusp] Requires=unp2,utom` (UndeadUpgradeFunc.txt), so the row waits for the Black
    // Citadel by itself; an upgrade row never halts the ladder (plan.ts `upgrades`). When a
    // statue is worth morphing is the caster's call (plus/casting.ts `destroyerWanted`), and the
    // statue it spends is rebuilt by `always`, which counts `uobs` alone — Liquipedia's own
    // advice: "Morph your low health statues into destroyers and produce new ones to replace
    // them" (Obsidian Statue, Strategy). 75 gold / 150 lumber, 60 seconds.
    { id: UPG_BLK_SPHINX, from: SLAUGHTERHOUSE, ranks: 1, after: 30 },
  ],
  strategies: [
    // DEATH KNIGHT, GHOULS AND FIENDS — the standard one. The Lich comes with tier 2, WEB comes
    // off the Crypt the moment the Halls of the Dead land (`Ruwb`, in `upgrades` above), and the
    // Banshees are what it adds once there are fiends to stand in front of them. Both Obsidian
    // Statues are the race's rather than the build's — see `always`.
    { id: "fiends", name: "Ghouls and Crypt Fiends", tier: 2, weight: 30, expandAt: 300, expandAgainAt: 720,
      heroes: [DEATH_KNIGHT, LICH, CRYPT_LORD, DREAD_LORD], thenAt3: "fiendaboms",
      mix: { [CRYPT_FIEND]: 3, [GHOUL]: 2.5, [BANSHEE]: 1 } },
    // CRYPT LORD, and the widest mix the race has: ghouls and fiends from the opening, then Meat
    // Wagons and Necromancers at tier 2. The Death Knight is the SECOND hero here rather than the
    // first — he heals the Crypt Lord, who is already the one that can be stood in front.
    { id: "meatwagons", name: "Fiends, Meat Wagons and Necromancers", tier: 2, weight: 24, expandAt: 330, expandAgainAt: 750,
      heroes: [CRYPT_LORD, DEATH_KNIGHT, LICH, DREAD_LORD], thenAt3: "aboms",
      mix: { [CRYPT_FIEND]: 2.5, [GHOUL]: 2, [MEAT_WAGON]: 1, [NECRO]: 1.2 } },
    // DREAD LORD MASS GHOULS — the fast one. Vampiric Aura is what makes those ghouls farm, so it
    // expands early, and it is the one undead build that names its SECOND CRYPT: a ghoul army is
    // only as fast as the buildings making it. Gargoyles come with tier 2, and the Death Knight
    // is the second hero (a Death Coil on a ghoul is the same aura read from the other end).
    { id: "ghouls", name: "Mass Ghouls and Gargoyles", tier: 2, weight: 22, expandAt: 240, expandAgainAt: 640,
      heroes: [DREAD_LORD, DEATH_KNIGHT, LICH, CRYPT_LORD],
      factories: { [CRYPT]: 2 }, thenAt3: "ghoulaboms",
      mix: { [GHOUL]: 4, [GARGOYLE]: 1.5, [CRYPT_FIEND]: 1 } },
    { id: "aboms", name: "Abominations and Meat Wagons", tier: 3, weight: 16, expandAt: 420, expandAgainAt: 840,
      heroes: [CRYPT_LORD, DEATH_KNIGHT, LICH, DREAD_LORD],
      mix: { [ABOMINATION]: 3, [CRYPT_FIEND]: 1.5, [MEAT_WAGON]: 1.2, [NECRO]: 1 } },
    { id: "frostwyrms", name: "Gargoyles and Frost Wyrms", tier: 3, weight: 12, expandAt: 450, expandAgainAt: 870,
      mix: { [GARGOYLE]: 2.5, [FROST_WYRM]: 1, [CRYPT_FIEND]: 1.5, [NECRO]: 0.8, [ABOMINATION]: 0.8 } },
    // THE UNDEAD TIER-3 TRANSITIONS — never rolled (weight 0), only grown into (`thenAt3`). The
    // developer's: "Undead Insane AI must get some Abominations as well". Only the Abomination
    // build and the fast expand used to name one, so the three tier-2 openings — four undead
    // matches in five — reached the Black Citadel and went on making exactly what they had made
    // at the Halls of the Dead. Each keeps its own line and puts Abominations in FRONT of it
    // (`[uabo] Requires=unp2`, off the Slaughterhouse `always` already stands): the fiend build's
    // fiends and Banshees behind them, the ghoul build's ghouls and Gargoyles beside them. The
    // Meat Wagon build grows into `aboms` itself, which is its own army with more Abominations.
    { id: "fiendaboms", name: "Crypt Fiends and Abominations", tier: 3, weight: 0, expandAt: 420, expandAgainAt: 840,
      mix: { [CRYPT_FIEND]: 2.5, [ABOMINATION]: 2, [GHOUL]: 1, [BANSHEE]: 0.8 } },
    { id: "ghoulaboms", name: "Ghouls, Abominations and Gargoyles", tier: 3, weight: 0, expandAt: 420, expandAgainAt: 840,
      mix: { [GHOUL]: 2.5, [ABOMINATION]: 2, [GARGOYLE]: 1.2, [CRYPT_FIEND]: 1 } },
    // THE FAST EXPAND — INSANE ONLY, and EVERY Crypt Lord or Dreadlord opening there. The
    // developer's: "a fast expansion with mass ghouls and/or crypt fiends (so it delays its main
    // hall upgrade/tier 2 a bit to keep resources for a bigger early game army and extra
    // acolytes to attempt to get an early gold mine)". The second mine at two and a half minutes
    // (`expandAt` — its Acolytes are the mine crew `plan.ts` hires for every mine it owns), two
    // Crypts of Ghouls and Fiends, and the Halls of the Dead held to five and a half minutes.
    { id: "fastexpand", name: "Fast expansion, Ghouls and Fiends", tier: 2, weight: 0, expandAt: 150, expandAgainAt: 600,
      replaces: { first: [CRYPT_LORD, DREAD_LORD], chance: 1 }, tier2Clock: 330,
      factories: { [CRYPT]: 2 }, thenAt3: "aboms",
      mix: { [GHOUL]: 3, [CRYPT_FIEND]: 3, [NECRO]: 0.8, [MEAT_WAGON]: 0.5 } },
  ],
  heroes: [DEATH_KNIGHT, LICH, DREAD_LORD, CRYPT_LORD],
  // …and whatever the build opened with, the Death Knight comes SECOND — see `secondHero`.
  secondHero: DEATH_KNIGHT,
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
    ...TAVERN_SKILLS,
  },
  // DEATH KNIGHT → ALWAYS the Lich, then the Dark Ranger (Black Arrow) or the Crypt Lord
  // (Impale). CRYPT LORD or DREADLORD → ALWAYS the Death Knight, then the Dark Ranger. The Death
  // Knight being second whenever he did not open is also `secondHero`'s rule.
  combos: {
    [DEATH_KNIGHT]: { second: [LICH], third: [[DARK_RANGER], [CRYPT_LORD]] },
    // …and a Crypt Lord who OPENS starts on CARRION BEETLES, not Impale (the developer's): the
    // beetles are bodies that tank and grow a creeping party from the first camp on, which is
    // what the fast expansion's thin early army needs (`fastexpand`). As a third hero he keeps
    // the Impale build in `skills` above.
    [CRYPT_LORD]: {
      second: [DEATH_KNIGHT],
      third: [[DARK_RANGER]],
      skills: {
        [CRYPT_LORD]: [CARRION_SCARAB, IMPALE, CARRION_SCARAB, IMPALE, CARRION_SCARAB, LOCUST_SWARM,
          IMPALE, THORNY_SHIELD, THORNY_SHIELD, THORNY_SHIELD],
      },
    },
    [DREAD_LORD]: { second: [DEATH_KNIGHT], third: [[DARK_RANGER]] },
    "*": { second: [DEATH_KNIGHT], third: [[DARK_RANGER]] },
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
  siegeUnit: BALLISTA,
  tower: ANCIENT_PROTECT,
  // BEARS WITH MASTER TRAINING (`Redc` rank 2 is Bear Form) — the developer's spike for the race.
  // Four of them is ours: enough bears to be the front of the army rather than a sample of it.
  powerSpike: { research: [UPG_DRUID_CLAW, 2], units: [DRUID_CLAW, 4] },
  // …and the Tree of Eternity on a CLOCK, so the bears come at 10–12 minutes — see
  // `PlusRaceTable.tier3Clock`. OURS: the upgrade is 140 s (`[etoe] bldtm`), so asked at eight
  // and a half minutes it stands by about eleven.
  tier3Clock: 510,
  units: {
    [ARCHER]: { from: ANCIENT_WAR, tier: 1 },
    [HUNTRESS]: { from: ANCIENT_WAR, needs: [HUNTERS_HALL], tier: 1 }, // `[esen] Requires=edob`
    // TIER ONE with a Hunter's Hall, like the Huntress beside it — `[ebal] Requires=edob` and
    // nothing more (NightElfUnitFunc).
    [BALLISTA]: { from: ANCIENT_WAR, needs: [HUNTERS_HALL], tier: 1, siege: true },
    [DRYAD]: { from: ANCIENT_LORE, tier: 2 },
    // `[edoc] Requires=etoa`, the Tree of Ages — but TRAINED from tier 3, which is a choice and
    // not the data. What waits for tier 3 is BEAR FORM, `Redc` rank 2 (`[Redc] Requirescount=2
    // Requires1=etoe`), and a druid without it is a 255-gold caster in a melee line. The
    // developer's rule: the night elf holds out with Archers (and the Lores' Dryads) until the
    // Tree of Eternity, then ALWAYS goes bears and Dryads (`lategrove`), and the druid lives in
    // the bear (plus/casting.ts `druidPass`).
    [DRUID_CLAW]: { from: ANCIENT_LORE, tier: 3 },
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
    //
    // …and it is a UNIT-ABILITY UNLOCK in the plainest sense — rank 1 is Rejuvenation
    // (`[Arej] Requires=Redc`), rank 2 Bear Form — researched at the Ancient of Lore that is
    // training Druids and Dryads all match, so as an ordinary row it was almost never started.
    // Saved for (`unlock`), and only once a Druid of the Claw is on the field (`forUnit`).
    //
    // …and NOT `forUnit` any more. The druid is a tier-3 unit to Computer+ (see `units`), so a
    // row waiting for one on the field started Adept Training only once the first druid was out
    // at tier 3, and Master Training a research after that — the bears came minutes after the
    // Tree of Eternity. Rank 1 needs nothing (`[Redc] Requires=`, only rank 2 names `etoe`), so it
    // is bought at tier 2 out of the Lore that is already training Dryads, and rank 2 starts the
    // moment the Tree of Eternity lands.
    { id: UPG_DRUID_CLAW, from: ANCIENT_LORE, ranks: 2, after: 12, unlock: true },
    // MARK OF THE CLAW — "Allows Druids of the Claw to cast Roar while in Bear Form"
    // (NightElfUpgradeStrings `[Reeb]`; the bear's card carries `Ara2`, `Requires=Reeb`). Without
    // it a druid that morphs for the fight gives up its Roar. `[Reeb] Requires=Redc
    // Requiresamount=2`, which `researchDue` asks before it saves a coin; elf.ai buys it beside
    // the second rank too.
    { id: UPG_MARK_CLAW, from: ANCIENT_LORE, ranks: 1, after: 16, unlock: true },
    { id: UPG_ABOLISH, from: ANCIENT_LORE, ranks: 1, after: 12, unlock: true },
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
      factories: { [ANCIENT_LORE]: 2 }, thenAt3: "lategrove",
      mix: { [DRUID_CLAW]: 2.5, [DRYAD]: 2, [ARCHER]: 1.5 } },
    // KEEPER OF THE GROVE, ARCHERS AND HUNTRESSES — committed to from tier 1 (the Hunter's Hall
    // is what decides it), with the Priestess of the Moon as the second hero.
    //
    // …as an OPENING. Reported: *"night elf computer+ ai seems to like going for archers +
    // huntresses a bit too much. it's a good strategy early in the game, but later it should go
    // for bears (druid of the claw + his upgrades) and dryads"*. So it grows into the bear build
    // when the Tree of Ages lands (`thenAt2`) and into the late grove at tier 3; the Archers and
    // Huntresses already trained go on fighting in the army.
    { id: "huntresses", name: "Archers and Huntresses", tier: 1, weight: 26, expandAt: 240, expandAgainAt: 660,
      heroes: [KEEPER, MOON_CHICK, DEMON_HUNTER, WARDEN], thenAt2: "bears", thenAt3: "lategrove",
      mix: { [ARCHER]: 2.5, [HUNTRESS]: 2.5, [DRYAD]: 1 } },
    // …the same opening, massing DRYADS out of both Lores instead. Abolish Magic is the upgrade
    // that makes it, and the second hero is the ranged damage the Dryads do not have.
    { id: "dryads", name: "Mass Dryads", tier: 2, weight: 22, expandAt: 300, expandAgainAt: 720, notInsane: true,
      heroes: [DEMON_HUNTER, MOON_CHICK, KEEPER, WARDEN],
      factories: { [ANCIENT_LORE]: 2 }, thenAt3: "lategrove",
      mix: { [DRYAD]: 3.5, [ARCHER]: 1.5 } },
    // …and the same opening again, teching to the WIND instead: Druids of the Talon behind
    // Archers that never stop, with `Reib` (Improved Bows) off the Ancient of War.
    { id: "talons", name: "Archers and Druids of the Talon", tier: 2, weight: 20, expandAt: 270, expandAgainAt: 690, notInsane: true,
      heroes: [DEMON_HUNTER, MOON_CHICK, KEEPER, WARDEN], thenAt3: "lategrove",
      mix: { [ARCHER]: 3, [DRUID_TALON]: 1.2, [DRYAD]: 1 } },
    // THE PRIESTESS OF THE MOON opening into the same bears: Archers behind her Searing Arrows at
    // tier 1, both Lores at tier 2. The developer's: *"when opening with priestess of the moon,
    // the second hero must either be demon hunter or pandaren brewmaster and that hero must be the
    // designated 'carry'"* — `combos`, whose `carry` makes whichever of the two is rolled the
    // build's carry (the army's captain, first at the shop and the drop).
    { id: "potmbears", name: "Priestess of the Moon, Archers into Druids of the Claw", tier: 2, weight: 22, expandAt: 330, expandAgainAt: 750,
      heroes: [MOON_CHICK, DEMON_HUNTER, KEEPER, WARDEN],
      factories: { [ANCIENT_LORE]: 2 }, thenAt3: "lategrove",
      mix: { [ARCHER]: 2.5, [DRUID_CLAW]: 2.5, [DRYAD]: 1.5 } },
    // …and the Chimaera build is the same opening into the same tier 3, with the Roost kept
    // whatever the purse (`chimgrove`): *"night elf must ALWAYS switch to bears + dryads when it
    // reaches tier 3"*, so a build that names a tier-3 army of its own still grows into one with
    // the bears in it.
    { id: "chimaeras", name: "Chimaeras and Dryads", tier: 3, weight: 12, expandAt: 480, expandAgainAt: 900,
      thenAt3: "chimgrove",
      mix: { [CHIMAERA]: 3, [DRYAD]: 2, [HUNTRESS]: 1.5, [FAERIE_DRAGON]: 0.5 } },
    // THE LATE GROVE — never rolled (weight 0), only grown into at tier 3 by every other night
    // elf build (`thenAt3`). The developer's late game: *"bears (druid of the claw + his
    // upgrades) and dryads and even chimeras if it has the resources (or an expo at least)"*.
    // Bear Form is `Redc` rank 2, which wants this very tier (`[Redc] Requires1=etoe`), so tier 3
    // is where the Druid of the Claw becomes the army.
    //
    // MORE BEARS, AND THE CHIMAERAS AFTER THEM. The developer, after 48 observed Insane matches had
    // the night elf at 7–16: *"we should have more bears on tier 3 for night elf, then when the
    // night elf has enough it should attempt to get some chimaeras after reaching around 5-6
    // bears"*. So the druid is the bulk of the mix and the build's lead row asks for EIGHT of them
    // high in the ladder (it was six, beside a Dryad share almost as large); the Chimaeras wait for
    // five bears standing (`waitFor` — a druid in Bear Form is counted, `TOWN_COUNT_EQUIVALENTS`)
    // and, here, for the purse too (`affluent`: a second mine or a bank to spare, and kept once
    // their Roost stands). Eight and five are OURS.
    { id: "lategrove", name: "Druids of the Claw, Dryads and Chimaeras", tier: 3, weight: 0, expandAt: 480, expandAgainAt: 900,
      factories: { [ANCIENT_LORE]: 2 }, affluent: [CHIMAERA], lead: { [DRUID_CLAW]: 8 },
      waitFor: { [CHIMAERA]: { units: [DRUID_CLAW, 5] } },
      mix: { [DRUID_CLAW]: 4, [DRYAD]: 1.5, [CHIMAERA]: 1.5 } },
    // The late grove for the Chimaera build: the same bears first, with its Chimaeras kept once
    // the bears are there whatever the purse.
    { id: "chimgrove", name: "Druids of the Claw, Dryads and Chimaeras", tier: 3, weight: 0, expandAt: 480, expandAgainAt: 900,
      factories: { [ANCIENT_LORE]: 2 }, lead: { [DRUID_CLAW]: 8 },
      waitFor: { [CHIMAERA]: { units: [DRUID_CLAW, 5] } },
      mix: { [DRUID_CLAW]: 4, [DRYAD]: 1.5, [CHIMAERA]: 2 } },
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
    ...TAVERN_SKILLS,
  },
  // DEMON HUNTER → the Keeper of the Grove, the Naga Sea Witch or the Pandaren Brewmaster (both
  // Tavern — the developer added the Brewmaster here too: his Breath of Fire and Drunken Haze
  // are as good behind a Demon Hunter as behind a Keeper), then the Alchemist or the Priestess
  // of the Moon. KEEPER → the Demon Hunter, the Pit Lord or the Pandaren Brewmaster (both
  // Tavern), then the Alchemist or the Fire Lord (Lava Spawn). PRIESTESS OF THE MOON → the Demon
  // Hunter or the Pandaren Brewmaster, and whichever it is is the build's CARRY (the developer's,
  // see `potmbears`); then the Keeper or the Alchemist.
  combos: {
    [MOON_CHICK]: { second: [DEMON_HUNTER, BREWMASTER], carry: true, third: [[KEEPER], [ALCHEMIST]] },
    [DEMON_HUNTER]: { second: [KEEPER, NAGA_WITCH, BREWMASTER], third: [[ALCHEMIST], [MOON_CHICK]] },
    [KEEPER]: { second: [DEMON_HUNTER, PIT_LORD, BREWMASTER], third: [[ALCHEMIST], [FIRE_LORD]] },
  },
};

export const PLUS_RACES: Record<PlayableRace, PlusRaceTable> = {
  human: HUMAN,
  orc: ORC,
  undead: UNDEAD,
  nightelf: NIGHT_ELF,
};

/**
 * What `tableForEdition` needs to know of the loaded tech tree — `TechRegistry.has`, a type's
 * tier-0 `Requires` and a worker's `Builds`, and nothing else. An interface rather than the
 * registry so the headless ladder test can hand it a parsed `Melee_V0` profile.
 */
export interface EditionTech {
  has(id: string): boolean;
  requires(id: string): readonly string[];
  builds(id: string): readonly string[];
}

/**
 * A race's table as REIGN OF CHAOS's data can play it.
 *
 * Every table above was written — and measured, tools/ai-plus-ladder-test.cjs — against The
 * Frozen Throne's object tables. Reign of Chaos reads `Melee_V0\Units\*` instead
 * (src/vfs/edition.ts), and the difference that matters here is all in those profiles:
 *
 *  · **What does not exist.** No section at all for any race's fourth hero (`Hblm`, `Oshd`,
 *    `Ucrl`, `Ewar`), its shop (`hvlt`, `ovln`, `utom`, `eden`), the Spell Breaker, the
 *    Dragonhawk Rider, the Troll Batrider, the Spirit Walker, the Obsidian Statue, the Mountain
 *    Giant, the Faerie Dragon or the Arcane Tower — and none of the upgrades that came with them.
 *    Dropped from every place a table names them: the unit catalogue, the mixes, the hero
 *    orders and their skill builds, the `factories`, `always`, `antiAir`, `towerUpgrades`,
 *    `support`, the upgrade list and `shop` (left empty — plus/plan.ts `shop` then asks for
 *    nothing, and plus/items.ts shops at whatever neutral shelf the map has, as it always could).
 *    A build whose whole army was expansion units would be dropped too; none of the twenty-one is,
 *    and a `thenAt3` pointing at a dropped build is cut rather than left dangling.
 *  · **What moved.** Five RoC `Requires` put a unit a TIER later than the expansion does, and a
 *    row that is asked for a tier early is a `SetBuildNext` the authority refuses every pass
 *    while `OneBuildLoop` still reserves its price off the running budget: `[owyv] Requires=ofrt`
 *    (the Wind Rider waits for the Fortress), `[ugar] Requires=ugrv,unp2` (the Gargoyle for the
 *    Black Citadel), `[ebal] Requires=etoa,edob` (the Glaive Thrower for the Tree of Ages),
 *    `[hgra] Requires=hcas,hlum` (the Aviary for the Castle) and `[edos] Requires=etoe,eaow`
 *    (the Chimaera Roost wants an Ancient of Wind). So a row's `tier` and `needs` are RAISED off
 *    the data — the unit's own `Requires` and its producer's — and never lowered: a hall id in
 *    them is a tier, a building the race's worker `Builds` is a need, and nothing else is read.
 *
 * Applied at seat time and only on Reign of Chaos (`ComputerPlusAi.add`): the expansion's
 * tables are the ones these rows were tuned on, and they are left exactly as written.
 */
export function tableForEdition(table: PlusRaceTable, tech: EditionTech): PlusRaceTable {
  const has = (id: string | undefined): boolean => !!id && tech.has(id);
  const buildings = new Set(tech.builds(table.worker));

  const units: Record<string, UnitRow> = {};
  for (const [unit, row] of Object.entries(table.units)) {
    if (!has(unit) || (row.from && !has(row.from)) || (row.needs ?? []).some((n) => !has(n))) continue;
    let tier = row.tier;
    const needs = [...(row.needs ?? [])];
    for (const req of [...tech.requires(unit), ...(row.from ? tech.requires(row.from) : [])]) {
      const hall = table.halls.indexOf(req);
      if (hall >= 0) tier = Math.max(tier, hall + 1);
      else if (req !== row.from && buildings.has(req) && !needs.includes(req)) needs.push(req);
    }
    units[unit] = { ...row, tier, ...(needs.length ? { needs } : {}) };
  }
  const known = (unit: string): boolean => unit in units;

  const heroes = table.heroes.filter(has);
  const kept = table.strategies
    .map((s): PlusStrategy | null => {
      const mix = Object.fromEntries(Object.entries(s.mix).filter(([u]) => known(u)));
      if (!Object.keys(mix).length) return null;
      const order = s.heroes?.filter(has);
      const factories = s.factories
        ? Object.fromEntries(Object.entries(s.factories).filter(([b]) => has(b)))
        : undefined;
      return { ...s, mix, heroes: order?.length ? order : undefined, factories };
    })
    .filter((s): s is PlusStrategy => s !== null);
  const ids = new Set(kept.map((s) => s.id));
  const strategies = kept.map((s) => ({
    ...s,
    thenAt3: s.thenAt3 && ids.has(s.thenAt3) ? s.thenAt3 : undefined,
    thenAt3Or: s.thenAt3Or?.filter((id) => ids.has(id)),
    thenAt2: s.thenAt2 && ids.has(s.thenAt2) ? s.thenAt2 : undefined,
  }));

  return {
    ...table,
    units,
    heroes,
    skills: Object.fromEntries(Object.entries(table.skills).filter(([h]) => has(h))),
    // Never an empty table: `rollStrategy` has to be able to answer. No real data set gets here.
    strategies: strategies.length ? strategies : table.strategies,
    support: table.support.filter((r) => has(r.build)),
    upgrades: table.upgrades.filter((r) => has(r.id) && has(r.from)),
    shop: has(table.shop) ? table.shop : "",
    towerUpgrades: table.towerUpgrades?.filter((r) => has(r.id)),
    antiAir: table.antiAir && known(table.antiAir.unit) ? table.antiAir : undefined,
    siegeUnit: table.siegeUnit && known(table.siegeUnit) ? table.siegeUnit : undefined,
    always: table.always?.filter((r) => known(r.unit)),
  };
}

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
export function rollStrategy(
  table: PlusRaceTable, techTier: number, roll: (lo: number, hi: number) => number, insane = false,
): PlusStrategy {
  // A weight of 0 is a build that is only ever GROWN INTO (`thenAt2`/`thenAt3`) or swapped in
  // (`replaces`), never rolled — and an Insane seat leaves out the builds it does not play
  // (`PlusStrategy.notInsane`).
  const rollable = table.strategies.filter((s) => !s.replaces && s.weight > 0 && !(insane && s.notInsane));
  const eligible = rollable.filter((s) => s.tier <= techTier);
  const lowest = Math.min(...rollable.map((s) => s.tier));
  const pool = eligible.length ? eligible : rollable.filter((s) => s.tier === lowest);
  const total = pool.reduce((n, s) => n + s.weight, 0);
  let pick = roll(1, Math.max(1, total));
  for (const s of pool) {
    pick -= s.weight;
    if (pick <= 0) return s;
  }
  return pool[pool.length - 1];
}

/**
 * Which tier-3 transition this seat will grow into (`PlusStrategy.thenAt3Or`) — rolled ONCE, at
 * seat time, evenly over `thenAt3` and its alternatives, and written into the build as its
 * `thenAt3` so the plan (plus/plan.ts `grownInto`) reads one answer for the whole match.
 */
export function rollTransition(strategy: PlusStrategy, roll: (lo: number, hi: number) => number): PlusStrategy {
  const options = [strategy.thenAt3, ...(strategy.thenAt3Or ?? [])].filter((id): id is string => !!id);
  if (options.length < 2) return strategy;
  return { ...strategy, thenAt3: options[roll(0, options.length - 1)] };
}

/**
 * The INSANE-ONLY build a rolled build turns into, if any (`PlusStrategy.replaces`) — keeping the
 * rolled build's opening hero, because the rule is stated per opening hero. Asked only for an
 * Insane seat (index.ts `add`); every other difficulty plays the build it rolled.
 */
export function insaneVariant(table: PlusRaceTable, rolled: PlusStrategy, roll: () => number): PlusStrategy {
  const first = (rolled.heroes ?? table.heroes)[0];
  if (!first) return rolled;
  for (const s of table.strategies) {
    if (!s.replaces?.first.includes(first)) continue;
    if (roll() >= s.replaces.chance) continue;
    return { ...s, heroes: [first, ...(rolled.heroes ?? table.heroes).slice(1)] };
  }
  return rolled;
}
