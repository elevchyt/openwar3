// Computer+ — "is this army strong enough for that camp?" (issue #124).
//
// The one question the AI had no answer to at all. Creeping used to be aimed by a food number
// pretending to be a camp level:
//
//     const max = Math.floor((food * 4) / 5);
//     ai.creepCamp(Math.max(0, max - CREEP_WINDOW), max, …)
//
// — four fifths of the army's FOOD, compared against a camp's combined creep LEVEL, which are
// two different units of measurement that happen to be numbers. At thirty food that reads
// "camps between 14 and 24", i.e. orange and red, and it sent whatever was standing around into
// them: a real match ended with a Computer+ player that had fed three separate parties to the
// same red camp and never reached the enemy at all.
//
// **The camp colours are the game's, and they are the whole scale.** WC3 groups Neutral Hostile
// creeps into camps (`MiscGame` CreepCallForHelp is the clustering radius — see
// game/minimapView.ts `CreepCamps`) and marks each with a dot coloured by the camp's COMBINED
// level: green 1-9, yellow/orange 10-19, red 20+ (Liquipedia "Creeps", and it is what the
// minimap actually paints). So a camp already tells you how hard it is, in one number, and the
// only thing that needed inventing is what an army has to look like to take each colour.
//
// **What an army has to look like is the developer's own brief**, and it is stated in units
// rather than in a formula because that is how a player thinks about it:
//
//   · a GREEN camp goes down to one hero and a soldier or two;
//   · an ORANGE camp wants about four of those soldiers behind the hero;
//   · a RED camp wants a real army and a hero that is level 3-4 or better.
//
// Three things are read off the party and nothing else is: how much FOOD of fighters is in it,
// what LEVEL the hero leading it has reached, and what fraction of its hit points the party
// still has. The third is what stops the ordinary failure — a party that cleared an orange camp
// at a third life and walked straight into the next one.
//
// **None of these numbers are Warcraft III's.** Nothing in the install describes an AI that
// creeps, so — the standing rule for this whole directory (docs/computer-plus.md) — every value
// here is OURS. What IS the game's is the scale they are stated against: the camp levels, and
// the three colours the client itself draws them in.

/** A camp's combined level, at the two boundaries the minimap's own dot colours draw. Green is
 *  1-9, orange 10-19, red 20 and up. */
export const CAMP_GREEN_MAX = 9;
export const CAMP_ORANGE_MAX = 19;

/** What a creeping party looks like, in the only three terms the decision needs. */
export interface CreepForce {
  /** Food spent on FIGHTERS in the party — the hero is not in it (it is counted by `heroLevel`)
   *  and neither is anything that is healing up rather than walking. */
  fighterFood: number;
  /** The leading hero's level, or 0 with no hero in the party. A party without a hero does not
   *  creep at all — the camp is experience, and experience goes on a hero. */
  heroLevel: number;
  /** The party's hit points as a fraction of its maximum, heroes included. A camp entered on
   *  half life is a camp that kills somebody. */
  health: number;
}

/** What each colour asks for. `food` is fighter food behind the hero; `hero` is the level that
 *  hero has to have reached. */
interface CampBar {
  food: number;
  hero: number;
}

/**
 * A green camp: the hero and one or two soldiers.
 *
 * Four food is two Footmen, two Ghouls or two Archers; it is one Grunt and change. Stated as
 * food rather than as a count so it means the same thing to four races, which is the same
 * reason `PlusProfile.armyFood` is.
 */
const GREEN: CampBar = { food: 4, hero: 1 };
/** An orange camp: about four soldiers behind the hero, and a hero that has been somewhere. */
const ORANGE: CampBar = { food: 10, hero: 2 };
/** A red camp: a real army, and the level the brief names. */
const RED: CampBar = { food: 24, hero: 4 };

/**
 * How healthy the party has to be before it walks into ANY camp.
 *
 * Above `CREEP_HEALTH` (the captain's own gate in plus/index.ts), because this one is about the
 * whole party rather than about the hero: a hero at full life leading four soldiers at a third
 * of theirs is an army that loses the soldiers. Below 1 so a party is not held at home by a
 * scratch.
 */
export const CAMP_HEALTH = 0.75;

/** The bar a camp of this level sets. */
function barFor(campLevel: number): CampBar {
  if (campLevel <= CAMP_GREEN_MAX) return GREEN;
  if (campLevel <= CAMP_ORANGE_MAX) return ORANGE;
  return RED;
}

/**
 * Can this party take that camp?
 *
 * Pure, and exported, so the thing that actually matters about it — that a lone hero does not
 * walk into a red camp — is pinned by a test rather than by reading it
 * (tools/ai-plus-army-test.cjs).
 */
export function canClearCamp(force: CreepForce, campLevel: number): boolean {
  if (force.heroLevel < 1) return false; // no captain, no creeping
  if (force.health < CAMP_HEALTH) return false;
  const bar = barFor(campLevel);
  return force.fighterFood >= bar.food && force.heroLevel >= bar.hero;
}

/**
 * The hardest camp this party may be pointed at — what `AiPlayer.creepCamp`'s `max` becomes.
 *
 * Negative means "not creeping at all", which is what an unhealthy or leaderless party gets.
 * Expressed as a ceiling rather than as a filter because that is the shape `GetCreepCamp` takes:
 * it hands back the NEAREST camp inside a level window, which is what a player picks too.
 */
export function maxCampLevel(force: CreepForce): number {
  if (!canClearCamp(force, 1)) return -1;
  if (!canClearCamp(force, CAMP_GREEN_MAX + 1)) return CAMP_GREEN_MAX;
  if (!canClearCamp(force, CAMP_ORANGE_MAX + 1)) return CAMP_ORANGE_MAX;
  return Infinity;
}
