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
// **FOOD IS NOT WHAT AN ARMY IS WORTH, and that is this file's second lesson.** The first
// version of it said "ten food of fighters clears an orange camp", and ten food is four Grunts
// (36 damage each, 700 hit points) or five Archers (16 damage each, 245 hit points) — armies
// that lose to entirely different camps. Measured: orange camps were being walked into by
// parties that had no chance. So a party is now priced by what it can actually DO, which is the
// developer's own suggestion and the only reading that survives contact with two races:
//
//     POWER = Σ (a unit's damage per second × its remaining hit points)
//
// …which is the standard "effective health × output" figure a player is estimating when they
// look at an army and decide. It is quadratic in the right way — twice the army is four times
// the power, which is what actually happens in a fight — so it is taken to the square root at
// the end to keep the numbers readable and the thresholds linear in "army size".
//
// The HERO is priced separately and on top, because a hero is not a soldier: it is the unit the
// camp's damage is spread over, the one that levels, and the one carrying the items. Its level
// is most of what it contributes, so it enters as a multiplier on the whole party rather than as
// another body.
//
// **None of these numbers are Warcraft III's.** Nothing in the install describes an AI that
// creeps, so — the standing rule for this whole directory (docs/computer-plus.md) — every value
// here is OURS. What IS the game's is the scale they are stated against: the camp levels, the
// three colours the client itself draws them in, and every unit's own damage and hit points.

/** A camp's combined level, at the two boundaries the minimap's own dot colours draw. Green is
 *  1-9, orange 10-19, red 20 and up. */
export const CAMP_GREEN_MAX = 9;
export const CAMP_ORANGE_MAX = 19;

/** One fighter, as the metric reads it. Everything here is off the SimUnit — no table. */
export interface Fighter {
  /** Damage per second: the mean of the unit's damage roll over its cooldown. 0 for anything
   *  that cannot swing (a Meat Wagon's crew, a dead weapon slot, a worker in the wave). */
  dps: number;
  /** Hit points it has RIGHT NOW, not its maximum. A party that cleared one camp is worth less
   *  going into the next one, which is the developer's "current health must be taken into
   *  account" and is why this is not `maxHp`. */
  hp: number;
  maxHp: number;
}

/** What a creeping party looks like. */
export interface CreepForce {
  /** Everything in the party that is not a hero. */
  fighters: readonly Fighter[];
  /** The leading hero's level, or 0 with no hero in the party. A party without a hero does not
   *  creep at all — the camp is experience, and experience goes on a hero. */
  heroLevel: number;
  /** …and how healthy that hero is. A full-strength army behind a hero at a third life is a
   *  party that loses the hero, which is the most expensive thing on a melee map. */
  heroHealth: number;
  /** The party's hit points as a fraction of its maximum, heroes included. */
  health: number;
}

/**
 * The raw combat figure: Σ (dps × current hit points), square-rooted.
 *
 * The square root is what makes the thresholds below readable — it puts the number back in
 * "army size" units, so doubling a party roughly doubles its power rather than quadrupling it,
 * and a threshold can be reasoned about as "about this many soldiers".
 *
 * Pure, and exported, so the thing that actually matters about it — that three Grunts outrank
 * three Archers — is pinned by a test rather than by reading it (tools/ai-plus-army-test.cjs).
 */
export function armyPower(fighters: readonly Fighter[]): number {
  let sum = 0;
  for (const f of fighters) {
    if (f.dps <= 0 || f.hp <= 0) continue;
    sum += f.dps * f.hp;
  }
  return Math.sqrt(sum);
}

/**
 * …and what the HERO multiplies it by.
 *
 * A level-1 hero is worth about a soldier and a half of presence; a level-5 one is worth several
 * and has an ultimate. Linear in level, which is roughly how a hero's own damage and hit points
 * scale (`Strength Per Level` and friends in UnitBalance), and floored at 1 so a party is never
 * priced BELOW its own soldiers.
 */
export function heroFactor(level: number): number {
  if (level < 1) return 0; // no hero, no party
  return 1 + level * HERO_PER_LEVEL;
}

/** How much a hero level adds to the party's whole power. */
const HERO_PER_LEVEL = 0.35;

/**
 * The number every threshold below is stated in — the party's power with its hero counted.
 *
 * Health enters twice on purpose and the two are different questions: `armyPower` already reads
 * each fighter's CURRENT hit points (a hurt army hits as hard but dies sooner), and the gates in
 * `canClearCamp` refuse the walk outright below a floor. This is the first of those.
 */
export function forcePower(force: CreepForce): number {
  return armyPower(force.fighters) * heroFactor(force.heroLevel);
}

/** What each colour asks for: the power the party must have, and the level its hero must have
 *  reached. */
interface CampBar {
  power: number;
  hero: number;
}

// The three bars, in the units `forcePower` produces. For scale, on the game's own numbers:
//
//   a Footman  (13 dmg / 1.35 s ≈ 9.6 dps, 420 hp) is worth √(9.6 × 420) ≈ 64
//   a Grunt    (23 dmg / 1.4 s  ≈ 16 dps,  700 hp) is worth √(16 × 700)  ≈ 106
//   an Archer  (16 dmg / 1.5 s  ≈ 11 dps,  245 hp) is worth √(11 × 245)  ≈ 52
//
// …and power adds in quadrature, so three Grunts are √(3) × 106 ≈ 184, not 318. Read the bars
// against those figures: GREEN is a hero and a soldier or two, ORANGE is a real four-unit
// party behind a levelled hero, RED is an army.
//
// **These were all raised**, and the report that caused it was "the AI is attacking orange
// creep camps with very weak armies". The old bars were stated in food and a party of four
// Archers cleared them on paper; they do not clear them on the map. Worked examples at the new
// bars, so the numbers can be checked against a game rather than trusted:
//
//   4 Grunts + a level-3 hero  →  √(4 × 16 × 700) × 2.05  ≈ 434   — clears ORANGE
//   6 Footmen + a level-3 hero →  √(6 × 9.6 × 420) × 2.05 ≈ 319   — clears ORANGE, only just
//   4 Archers + a level-3 hero →  √(4 × 11 × 245) × 2.05  ≈ 217   — does NOT
//   8 Grunts + a level-5 hero  →  √(8 × 16 × 700) × 2.75  ≈ 822   — clears RED
//
// The hero LEVELS are the developer's own words: orange wants a hero that has been somewhere,
// red wants "a high level > 3-4 levels hero".
const GREEN: CampBar = { power: 150, hero: 1 };
const ORANGE: CampBar = { power: 300, hero: 3 };
const RED: CampBar = { power: 620, hero: 5 };

/**
 * How healthy the party has to be before it walks into ANY camp.
 *
 * Above `CREEP_HEALTH` (the captain's own gate in plus/index.ts), because this one is about the
 * whole party rather than about the hero: a hero at full life leading four soldiers at a third
 * of theirs is an army that loses the soldiers. Below 1 so a party is not held at home by a
 * scratch.
 */
export const CAMP_HEALTH = 0.75;
/** …and the hero's own, which is stricter: the hero is what the run is FOR. */
export const CAMP_HERO_HEALTH = 0.8;

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
 * walk into a red camp, and that three Archers are not three Grunts — is pinned by a test
 * rather than by reading it (tools/ai-plus-army-test.cjs).
 */
export function canClearCamp(force: CreepForce, campLevel: number): boolean {
  if (force.heroLevel < 1) return false; // no captain, no creeping
  if (force.health < CAMP_HEALTH) return false;
  if (force.heroHealth < CAMP_HERO_HEALTH) return false;
  const bar = barFor(campLevel);
  return force.heroLevel >= bar.hero && forcePower(force) >= bar.power;
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
