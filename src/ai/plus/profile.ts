import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL, UPKEEP_TIER2 } from "../ids";
import type { TargetSkill } from "./targeting";

// Computer+ — what a difficulty MEANS (issue #124).
//
// This is the file to read first, and the one place a difficulty is defined. It is also the
// clearest difference between Computer+ and the classic melee AI, so it is worth stating the
// contrast up front (docs/melee-ai.md "The difficulty spread" is the other half):
//
//   • The CLASSIC computer's difficulty is scattered across five Blizzard scripts as forty
//     `MeleeDifficulty() != MELEE_NEWBIE` guards, and INSANE is not in the scripts at all —
//     it is an engine cheat (double harvest, no fog). One rung is a build order with holes
//     punched in it and another is the same build order with a bigger bank.
//   • COMPUTER+ has no cheats at ANY rung — see `docs/computer-plus.md`. Every difference is
//     a number in the table below, and every one of them is something a HUMAN player varies:
//     how fast they notice, how much they build, how far they tech, whether they micro.
//
// **None of these numbers are Warcraft III's.** Nothing in the install describes an improved
// AI, so unlike `src/ai/human.ts` and its three siblings — where a number is Blizzard's unless
// a comment says otherwise — every value here is OURS, chosen to hit the brief in issue #124
// and stated with the reasoning beside it. Treat them as tuning, not as reference data.

/** One difficulty, in full. Everything the Computer+ brain reads about "how well do I play". */
export interface PlusProfile {
  /** `MeleeDifficulty()` — the lobby's Easy/Normal/Insane, as common.ai numbers it. Shared
   *  with the classic AI so a slot's difficulty means the same thing on both sides of the
   *  Computer+ checkbox. */
  readonly difficulty: number;

  // --- reaction: how long the AI takes to NOTICE things ---------------------------------
  /** Seconds between economy/production passes. A human checks their queues every couple of
   *  seconds when they are concentrating and much less often when they are not. */
  readonly buildPeriod: number;
  /** Seconds between army passes — re-aiming, retreating, regrouping. */
  readonly armyPeriod: number;
  /** Seconds between spell passes (see plus/casting.ts). */
  readonly castPeriod: number;
  /** How long an enemy has to stand in the base before the army turns around. THE single
   *  most-felt difficulty number: an easy computer lets you kill four peasants first. */
  readonly defendDelay: number;
  /** How long a fight has to have been going before a spell is pressed. A human does not
   *  Storm Bolt on the first frame of an engagement. */
  readonly castDelay: number;

  // --- aiming: how well it CHOOSES, as opposed to how fast it reacts ----------------------
  /**
   * How it reads a fight when it picks a target — for a spell and for the army alike
   * (plus/targeting.ts).
   *
   * `castDelay` above is how fast this player sees the fight; this is how well they understand
   * it, and the two are genuinely different axes. A `naive` player aims at the biggest body on
   * the screen: Storm Bolt goes on the Tauren, Death Coil on the Abomination, and the Shaman
   * behind them keeps casting. A `sound` one values what a unit IS. An `expert` also knows what
   * the SPELL is for — a nuke where it finishes something, a disable on the highest damage per
   * second, and never a full-length stun spent on a hero that only eats a third of it.
   */
  readonly castTargeting: TargetSkill;
  /**
   * Chance that a cast is aimed at a random legal target instead of at the best one.
   *
   * The other half of "aims badly": `castTargeting` is a consistently wrong MODEL of a fight,
   * this is ordinary sloppiness on top of it — the click that went on the wrong unit. Kept
   * small, because a computer that misclicks a third of its spells stops reading as a player
   * and starts reading as broken.
   */
  readonly castMistake: number;
  /**
   * How hard the kill-priority ladder is allowed to pull onto an enemy HERO. 0 = a hero is
   * just another soldier; 1 = the full curve in plus/targeting.ts.
   *
   * This is the knob on the single most-complained-about habit of Blizzard's own melee AI: it
   * drops everything to swing at the enemy hero, follows it out of the fight, and loses the
   * army to the units it walked past. Even at 1 the curve is conditional — a HEALTHY hero is
   * worth barely more than a soldier and only a hero that can be finished (`heroKillable`)
   * climbs — so a higher number here means "is better at spotting the kill", not "chases
   * harder". The army adds a second gate on top: it will not walk after one (`HERO_CHASE`).
   */
  readonly heroFocus: number;

  // --- economy --------------------------------------------------------------------------
  /** Workers per town it aims for.
   *
   *  A WC3 gold mine takes five at a time, so everything past the fifth is a lumberjack — and
   *  every one of them is 75 gold that did not become an army. The ladder's own answer for a
   *  one-base game is around five on gold and half a dozen in the trees, which is what these
   *  are; the top rung is higher because it expands and crews the second mine too. */
  readonly workers: number;
  /**
   * How many EXTRA towns it will take. 0 = it never expands, which is issue #124's "Easy must
   * not execute complex strategies like fast expansions".
   *
   * A CEILING and nothing else. WHEN a computer expands is the build order's business, not the
   * difficulty's — every strategy carries its own `expandAt` / `expandAgainAt` (plus/races.ts),
   * because taking a second mine early is what a fast-expand build IS. All the difficulty adds
   * is `expandDelay`.
   */
  readonly expansions: number;
  /** Seconds ADDED to whatever clock the build order set. A weaker player runs the same build
   *  late; they do not run a different build. */
  readonly expandDelay: number;

  // --- countering: rebuilding against what the enemy turns out to be fielding ---------------
  /**
   * How hard it re-weights its army mix against the enemy composition it has SCOUTED
   * (plus/counter.ts). 0 = it never counters; 1 = a unit's share moves by the full damage-table
   * advantage its attack type has against what it has seen.
   *
   * Applied as a nudge to the strategy's own weights rather than as a rewrite, so a countering
   * computer is still visibly playing the build it opened with.
   */
  readonly counterWeight: number;
  /** How many distinct enemy fighters it must have seen before it reacts at all. A bigger
   *  sample is a slower, more careful read — and a weaker player needs more of it. */
  readonly counterSample: number;
  /** …and the share of that sample a type must reach before it counts as a composition rather
   *  than as a sighting. Issue #124: "after scouting a certain percentage of units of a certain
   *  type". */
  readonly counterShare: number;
  /** How long a sighting stays in the memory. A short memory is a player who only reacts to
   *  what they saw a moment ago. */
  readonly counterMemory: number;

  // --- the ceiling on the army ------------------------------------------------------------
  /**
   * The HARD CAP on food spent on fighters — issue #124's "must NOT mass armies at all (must
   * have constraints for this)".
   *
   * It is a food number rather than a unit count because that is the only cap that means the
   * same thing to every race: 12 food is six Footmen, or four Grunts, or six Archers. Enforced
   * where production is asked for (plus/plan.ts `armyBudget`), not at the wave — an AI that
   * builds twenty Grunts and attacks with six still owns twenty Grunts when you walk into its
   * base.
   */
  readonly armyFood: number;
  /** Towers it will ever put up. Easy builds none at all. */
  readonly towers: number;
  /** How many heroes it fields. */
  readonly heroes: number;
  /** The highest hall tier it will build (1 Town Hall / 2 Keep / 3 Castle). Capping this is
   *  what keeps an easy computer on tier-1 units without a per-unit blacklist. */
  readonly techTier: number;
  /** The highest RANK of a repeatable upgrade (armour, weapons) it will research. */
  readonly upgradeRank: number;

  // --- fighting ---------------------------------------------------------------------------
  /** Seconds before the first wave may leave home, whatever it has built. */
  readonly firstAttack: number;
  /** Quiet time between waves. */
  readonly waveGap: number;
  /**
   * Army food that makes a wave.
   *
   * Kept at or below `CORE_ARMY_FOOD` (plus/plan.ts), which is the army the plan holds while it
   * is teching — so the AI fights with the army it has rather than waiting for the one it is
   * saving up for. Set it above that and the first wave lands only after the tier-up, the tech
   * buildings and the upgrades have all been paid for, which on a one-base map is most of the
   * game.
   */
  readonly attackFood: number;
  /** Group hit-point fraction that sends a wave home. 0 = it never retreats, which is what
   *  makes an easy computer's army feedable one clump at a time. */
  readonly retreatHp: number;
  /** Does the whole group pick ONE target and kill it? The clearest "this AI micros" tell. */
  readonly focusFire: boolean;
  /** Does it go and level its hero on creep camps? */
  readonly creeps: boolean;
  /**
   * Seconds before it will go creeping — its OWN clock, not `firstAttack`.
   *
   * This is the whole reason `creeps: true` used not to produce a computer that creeps.
   * Creeping was a rung of `pickTarget`, and `pickTarget` is only reached once the wave gates
   * have opened — `firstAttack` (300 s on Normal), `waveGap`, and `attackFood`. So a Normal
   * computer's first creep camp came at FIVE MINUTES, by which time a ladder player has three
   * camps and a level-4 hero, and its hero was still level 1 at the first fight.
   *
   * A creep camp is not an attack: it is the early game's other economy, it goes out with the
   * hero and a couple of units rather than with a wave, and it starts about when the hero
   * does. Hence a separate clock and a separate (much smaller) force — `creepFood`.
   */
  readonly creepAt: number;
  /** Army food that makes a creeping party, as `attackFood` is for a wave. Small on purpose:
   *  a hero and two soldiers clear a green camp, and waiting for a wave's worth is waiting
   *  until creeping is pointless. */
  readonly creepFood: number;
  /** In an enemy base, does it turn on the WORKERS rather than whatever swung first? */
  readonly harass: boolean;
  /** Does it send an early scout? (Only matters for finding expansions — a melee player is
   *  handed every start location, see AiPlayer.knows.) */
  readonly scout: boolean;

  // --- items (plus/items.ts) ----------------------------------------------------------------
  /**
   * How many of a hero's six inventory slots it will fill by SHOPPING. 0 = it never shops,
   * which is Easy: a novice knows the shop is there and forgets about it.
   *
   * A ceiling on the habit rather than on the wallet — `itemReserve` is the wallet — so the
   * difference between the top two rungs is that one of them keeps a full belt.
   */
  readonly shopping: number;
  /**
   * Gold it will NOT spend on items.
   *
   * The gate docs/computer-plus.md warns about: item gold is gold `OneBuildLoop` was going to
   * spend, so a shopping list needs a place in the build ladder rather than a side budget. A
   * floor is that place expressed the only way a separate pass honestly can — the build loop
   * still gets first call on everything below it, and the shop only ever sees the surplus a
   * player would also be looking at. It is not a rung in the ladder, and it does not pretend
   * to be one: it is the surplus test, stated as a number.
   */
  readonly itemReserve: number;
  /**
   * Does it keep a Scroll of Town Portal on the hero, and REPLACE it as soon as it can?
   *
   * The clearest "this player has played before" tell there is, and the one item that changes
   * how a lost fight ends. It puts the scroll at the top of the shopping list rather than the
   * bottom, which is what makes the replacement prompt: the moment one is spent, the next
   * shopping trip buys another before it buys anything else.
   *
   * Off only on Easy, where nothing is bought at all.
   */
  readonly keepPortal: boolean;

  // --- manners ------------------------------------------------------------------------------
  /**
   * How long the position has to be hopeless before it says gg and leaves. A weaker player
   * takes longer to accept it — the ORDERING is what carries the meaning here, not the
   * absolute values.
   *
   * All three came down after a real game reported the wait as too long. The dwell is a guard
   * against a position that recovers, and `hopeless` is already five clauses of "there is no
   * move from here": a third of a minute of a decided game is a third of a minute nobody wants
   * to play, and every clause un-latches the moment the position recovers anyway.
   */
  readonly concedeAfter: number;
}

/**
 * Computer+ (Easy) — "must essentially be able to be beaten by players who have played MOBAs"
 * (issue #124).
 *
 * The shape of it: it builds one barracks' worth of tier-1 soldiers, never expands, never puts
 * up a tower, never teches past its Town Hall, and takes seven minutes to come and find you
 * with six food of army. It reacts to an attack on its base fifteen seconds late, it never
 * pulls a broken army out of a fight, and it never notices what you are building. It is a
 * player who knows the buttons and nothing else.
 *
 * `techTier` 1 also decides which BUILDS it can roll: a strategy that aims higher than the
 * difficulty can reach is not offered to it (`rollStrategy`), so an easy computer only ever
 * plays its race's simplest openings.
 */
export const PLUS_EASY: PlusProfile = {
  difficulty: MELEE_NEWBIE,
  buildPeriod: 3, armyPeriod: 3, castPeriod: 2, defendDelay: 15, castDelay: 2.5,
  // It aims like a new player: at whatever is biggest. This is the requested behaviour in one
  // line — an easy computer's Storm Bolt lands on the Tauren and its Death Coil on the
  // Abomination — and it is why its casters never feel like they are answering your army.
  castTargeting: "naive", castMistake: 0.35, heroFocus: 0.3,
  workers: 8, expansions: 0, expandDelay: 0,
  // It does not counter at all: an easy computer builds what it opened with, whatever walks
  // into its base. This is the single biggest thing the top two difficulties do that it doesn't.
  counterWeight: 0, counterSample: Infinity, counterShare: 1, counterMemory: 0,
  armyFood: 12, towers: 0, heroes: 1, techTier: 1, upgradeRank: 1,
  firstAttack: 420, waveGap: 150, attackFood: 10, retreatHp: 0,
  // It never creeps and never shops, so neither clock nor purse below ever matters — the two
  // booleans are the switch. They are still stated rather than left to a default, because a
  // profile that only half-describes a difficulty is how one of them ends up playing another's
  // game by accident.
  focusFire: false, creeps: false, creepAt: Infinity, creepFood: Infinity,
  harass: false, scout: false,
  shopping: 0, itemReserve: Infinity, keepPortal: false,
  concedeAfter: 35,
};

/**
 * Computer+ (Normal) — "a bit of a faster reaction time and executes simple build orders, but
 * again, NO unit massing".
 *
 * Two heroes, a Keep, one expansion, a couple of towers, and an army it will actually pull out
 * of a lost fight. Thirty food is a real army and still half of what the map can feed, which is
 * the line the brief draws. It counters, but late and half-heartedly — see `counterWeight`.
 */
export const PLUS_NORMAL: PlusProfile = {
  difficulty: MELEE_NORMAL,
  buildPeriod: 2, armyPeriod: 1.5, castPeriod: 1, defendDelay: 6, castDelay: 1,
  // It knows what the units are and mostly aims at the right one, and misclicks about one
  // spell in seven. It does not price a spell's effect — a nuke goes on whoever is lowest
  // rather than on whoever it can finish.
  castTargeting: "sound", castMistake: 0.15, heroFocus: 0.7,
  workers: 11, expansions: 1, expandDelay: 180,
  // It counters, badly: it wants to have seen a dozen enemy units and half its army to be one
  // thing before it believes it, it only moves its mix a third of the way, and it forgets in a
  // minute and a half. That reads as a player who noticed late and over-corrected slightly.
  counterWeight: 0.35, counterSample: 12, counterShare: 0.4, counterMemory: 90,
  armyFood: 30, towers: 2, heroes: 2, techTier: 2, upgradeRank: 2,
  firstAttack: 300, waveGap: 90, attackFood: 14, retreatHp: 0.35,
  // Creeps from two and a half minutes with the hero and ten food behind it — about a hero, a
  // couple of soldiers and whatever else is standing around, which is what clears a green camp.
  focusFire: false, creeps: true, creepAt: 150, creepFood: 10,
  harass: false, scout: true,
  // Half a belt, and it keeps 300 gold back for the build order. It DOES keep a Town Portal and
  // replace it: a scroll is the difference between losing a fight and losing an army, and a
  // player at this level has learnt that much.
  shopping: 3, itemReserve: 300, keepPortal: true,
  concedeAfter: 20,
};

/**
 * Computer+ (Insane) — "should play as well as possible with little reaction times and it must
 * execute build orders fairly well".
 *
 * No artificial ceiling anywhere: it takes the whole tech tree, expands on its build order's
 * own clock, creeps its heroes up, focus-fires, retreats, goes for workers in your base, reads
 * your army composition and rebuilds against it, and thinks four times a second. `armyFood` is `UPKEEP_TIER2` rather than Infinity because that is where the
 * game itself says an army stops paying for itself — an AI that ignored upkeep would be
 * playing worse, not better.
 */
export const PLUS_INSANE: PlusProfile = {
  difficulty: MELEE_INSANE,
  buildPeriod: 1, armyPeriod: 0.5, castPeriod: 0.35, defendDelay: 1, castDelay: 0,
  // The whole ladder: kill shots, damage-per-second, and the game's own `herodur1` — so it
  // saves the Hex for the Shaman rather than spending it on a hero that eats a third of it.
  castTargeting: "expert", castMistake: 0, heroFocus: 1,
  workers: 14, expansions: 3, expandDelay: 0,
  // Full countering, off a small sample and a long memory: six units and a quarter of them one
  // type is enough to start shifting, and it remembers what it saw four minutes ago.
  counterWeight: 1, counterSample: 6, counterShare: 0.25, counterMemory: 240,
  armyFood: UPKEEP_TIER2, towers: 4, heroes: 3, techTier: 3, upgradeRank: 3,
  firstAttack: 150, waveGap: 30, attackFood: 16, retreatHp: 0.4,
  // Creeping starts at ninety seconds with the hero and eight food — the ladder's own answer,
  // which is "as soon as the hero walks out of the altar".
  focusFire: true, creeps: true, creepAt: 90, creepFood: 8,
  harass: true, scout: true,
  // A full belt and a Town Portal on the hero. Both are what separates a player who has been
  // here before from one who has not.
  shopping: 6, itemReserve: 200, keepPortal: true,
  concedeAfter: 12,
};

/** The profile a lobby difficulty seats. Anything unrecognised plays Normal, which is what
 *  every seat was before the menu offered three. */
export function plusProfile(difficulty: number): PlusProfile {
  return difficulty === MELEE_NEWBIE ? PLUS_EASY : difficulty === MELEE_INSANE ? PLUS_INSANE : PLUS_NORMAL;
}
