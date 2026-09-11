import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL } from "../../ids";

// Computer+ on Extreme Candy War — what a difficulty MEANS for a HERO.
//
// plus/profile.ts is the melee computer's table and almost none of it applies here: there are no
// workers, no tech, no army to cap. What separates a weak lane player from a strong one is how
// fast they see a fight, whether their spells go on the right body at the right moment, and
// whether they know when to leave — which is exactly the developer's brief: "the different
// difficulties must have more to do with reaction times, nuke capabilities/combos etc. (easy should
// be easy, normal should be normal and insane should be very hard/skilled)".
//
// The standing rule from plus/profile.ts holds: **no rung cheats**. Nothing here grants gold,
// vision or stats (unlike the user-made ExtremeCandyWarAI, which sets its computers' gold to 550
// against a person's 325 and conjures its items out of thin air); every difference is something a
// PLAYER varies. And none of these numbers are Warcraft III's — every one is OURS.

export interface CandyProfile {
  readonly difficulty: number;

  // --- reaction ---------------------------------------------------------------------------
  /** Seconds between decision passes — how often it LOOKS. The single most-felt number. */
  readonly think: number;
  /** Seconds an enemy hero has to have been in reach before a spell is pressed on it. */
  readonly castDelay: number;

  // --- spells -----------------------------------------------------------------------------
  /** Chance a pressed spell goes on a worse target than the best one (a misclick). */
  readonly castMistake: number;
  /**
   * Does it COMBO — open on a disable, and spend the nuke while the target cannot answer it?
   * Without it every spell is pressed the moment it is ready on whatever is nearest, which is
   * how a new player casts.
   */
  readonly combos: boolean;
  /** Does it hold a nuke for the KILL when the target is close to one (and the nuke is not
   *  needed to win the trade)? The difference between a burst and a finisher. */
  readonly holdNuke: boolean;
  /** Does it keep its mana for the fight rather than spending it on creep waves? */
  readonly saveMana: boolean;

  // --- trading and killing --------------------------------------------------------------------
  /** Enemy hero life fraction under which it commits to the kill (dives, chases). */
  readonly killHp: number;
  /** How far it will walk after a fleeing hero, in world units, before it lets it go. */
  readonly chase: number;
  /** Does it read the fight before going in — its side's heroes against theirs, towers, its own
   *  life — rather than swinging at whatever hero walks by? */
  readonly readsFights: boolean;
  /** Does it focus with its allies — join the hero an ally is already on, and call its own? */
  readonly focus: boolean;
  /** Does it time its blows on dying creeps (the bounty) instead of just attack-moving? */
  readonly lastHit: boolean;

  // --- staying alive ------------------------------------------------------------------------
  /** Life fraction it heads home at. */
  readonly retreatHp: number;
  /** Life fraction it leaves the fountain at. */
  readonly returnHp: number;
  /** Mana fraction a CASTER heads home at (0 = never goes home for mana). */
  readonly retreatMana: number;
  /** Does it stay out of an enemy tower's reach unless there are allied creeps for the tower to
   *  shoot, or it is diving a kill? */
  readonly towerSense: boolean;
  /** Does it drink potions and press its active items (heals, hastes, escapes)? */
  readonly items: boolean;
  /** Does it shop for its CLASS (a caster's staff, a fighter's weapon) rather than for whatever
   *  it can afford? */
  readonly shopSmart: boolean;
}

/** Easy — a player who knows the buttons. Looks a little over once a second, spells on sight,
 *  never combos, stands in a fight until it is nearly dead, never touches a potion. */
export const CANDY_EASY: CandyProfile = {
  difficulty: MELEE_NEWBIE,
  think: 1.1, castDelay: 1.5,
  castMistake: 0.35, combos: false, holdNuke: false, saveMana: false,
  killHp: 0.15, chase: 350, readsFights: false, focus: false, lastHit: false,
  retreatHp: 0.18, returnHp: 0.6, retreatMana: 0, towerSense: false, items: false, shopSmart: false,
};

/** Normal — a player who has played a lane map before: backs off at a third, finishes a kill it
 *  is given, stops before the tower, drinks when hurt, buys for its class. Its combos are the
 *  obvious ones and it is a beat slow on them. */
export const CANDY_NORMAL: CandyProfile = {
  difficulty: MELEE_NORMAL,
  think: 0.55, castDelay: 0.6,
  castMistake: 0.12, combos: true, holdNuke: false, saveMana: true,
  killHp: 0.3, chase: 700, readsFights: true, focus: true, lastHit: false,
  retreatHp: 0.3, returnHp: 0.85, retreatMana: 0.12, towerSense: true, items: true, shopSmart: true,
};

/** Insane — a player who is good at this. Reacts in a fifth of a second, disables then bursts,
 *  keeps a nuke for the kill, last-hits, picks its fights by the numbers and leaves before it is
 *  in danger rather than after. */
export const CANDY_INSANE: CandyProfile = {
  difficulty: MELEE_INSANE,
  think: 0.2, castDelay: 0.05,
  castMistake: 0, combos: true, holdNuke: true, saveMana: true,
  killHp: 0.45, chase: 1100, readsFights: true, focus: true, lastHit: true,
  retreatHp: 0.35, returnHp: 0.95, retreatMana: 0.15, towerSense: true, items: true, shopSmart: true,
};

/** The profile a lobby difficulty seats — anything unrecognised plays Normal. */
export function candyProfile(difficulty: number): CandyProfile {
  return difficulty === MELEE_NEWBIE ? CANDY_EASY : difficulty === MELEE_INSANE ? CANDY_INSANE : CANDY_NORMAL;
}
