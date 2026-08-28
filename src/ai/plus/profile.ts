import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL, UPKEEP_TIER2 } from "../ids";

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

  // --- economy --------------------------------------------------------------------------
  /** Workers per town it aims for.
   *
   *  A WC3 gold mine takes five at a time, so everything past the fifth is a lumberjack — and
   *  every one of them is 75 gold that did not become an army. The ladder's own answer for a
   *  one-base game is around five on gold and half a dozen in the trees, which is what these
   *  are; the top rung is higher because it expands and crews the second mine too. */
  readonly workers: number;
  /** How many EXTRA towns it will take (0 = it never expands — issue #124's "Easy must not
   *  execute complex strategies like fast expansions"). */
  readonly expansions: number;
  /** …and not before this many seconds, whatever the gold situation says. */
  readonly expandAfter: number;

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
  /** In an enemy base, does it turn on the WORKERS rather than whatever swung first? */
  readonly harass: boolean;
  /** Does it send an early scout? (Only matters for finding expansions — a melee player is
   *  handed every start location, see AiPlayer.knows.) */
  readonly scout: boolean;

  // --- manners ------------------------------------------------------------------------------
  /** How long the position has to be hopeless before it says gg and leaves. A weaker player
   *  takes longer to accept it. */
  readonly concedeAfter: number;
}

/**
 * Computer+ (Easy) — "must essentially be able to be beaten by players who have played MOBAs"
 * (issue #124).
 *
 * The shape of it: it builds one barracks' worth of tier-1 soldiers, never expands, never puts
 * up a tower, never teches past its Town Hall, and takes seven minutes to come and find you
 * with six food of army. It reacts to an attack on its base fifteen seconds late and it never
 * pulls a broken army out of a fight. It is a player who knows the buttons and nothing else.
 */
export const PLUS_EASY: PlusProfile = {
  difficulty: MELEE_NEWBIE,
  buildPeriod: 3, armyPeriod: 3, castPeriod: 2, defendDelay: 15, castDelay: 2.5,
  workers: 8, expansions: 0, expandAfter: Infinity,
  armyFood: 12, towers: 0, heroes: 1, techTier: 1, upgradeRank: 1,
  firstAttack: 420, waveGap: 150, attackFood: 10, retreatHp: 0,
  focusFire: false, creeps: false, harass: false, scout: false,
  concedeAfter: 45,
};

/**
 * Computer+ (Normal) — "a bit of a faster reaction time and executes simple build orders, but
 * again, NO unit massing".
 *
 * Two heroes, a Keep, one expansion once the game has gone long, a couple of towers, and an
 * army it will actually pull out of a lost fight. Thirty food is a real army and still half of
 * what the map can feed, which is the line the brief draws.
 */
export const PLUS_NORMAL: PlusProfile = {
  difficulty: MELEE_NORMAL,
  buildPeriod: 2, armyPeriod: 1.5, castPeriod: 1, defendDelay: 6, castDelay: 1,
  workers: 11, expansions: 1, expandAfter: 600,
  armyFood: 30, towers: 2, heroes: 2, techTier: 2, upgradeRank: 2,
  firstAttack: 300, waveGap: 90, attackFood: 14, retreatHp: 0.35,
  focusFire: false, creeps: true, harass: false, scout: true,
  concedeAfter: 30,
};

/**
 * Computer+ (Insane) — "should play as well as possible with little reaction times and it must
 * execute build orders fairly well".
 *
 * No artificial ceiling anywhere: it takes the whole tech tree, expands as the gold runs out,
 * creeps its heroes up, focus-fires, retreats, goes for workers in your base, and thinks four
 * times a second. `armyFood` is `UPKEEP_TIER2` rather than Infinity because that is where the
 * game itself says an army stops paying for itself — an AI that ignored upkeep would be
 * playing worse, not better.
 */
export const PLUS_INSANE: PlusProfile = {
  difficulty: MELEE_INSANE,
  buildPeriod: 1, armyPeriod: 0.5, castPeriod: 0.35, defendDelay: 1, castDelay: 0,
  workers: 14, expansions: 3, expandAfter: 300,
  armyFood: UPKEEP_TIER2, towers: 4, heroes: 3, techTier: 3, upgradeRank: 3,
  firstAttack: 150, waveGap: 30, attackFood: 16, retreatHp: 0.4,
  focusFire: true, creeps: true, harass: true, scout: true,
  concedeAfter: 20,
};

/** The profile a lobby difficulty seats. Anything unrecognised plays Normal, which is what
 *  every seat was before the menu offered three. */
export function plusProfile(difficulty: number): PlusProfile {
  return difficulty === MELEE_NEWBIE ? PLUS_EASY : difficulty === MELEE_INSANE ? PLUS_INSANE : PLUS_NORMAL;
}
