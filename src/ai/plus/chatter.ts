// Computer+ — what it says, and when it accepts that it has lost (issue #124).
//
// Two things the classic melee AI never does: it greets you at the start of the game, and it
// concedes at the end of one. Both are asked for by issue #124, which names AMAI as the AI
// that does them.
//
// What we took from AMAI here is the BEHAVIOUR and one of its tables: it hangs a PROFILE on
// each bot — `TFT/Profiles.txt`, rows called Hunter, Crazy_Rusher, Xerox, each with a taunt
// rate and a surrender value — and issue #124 rules that whole idea out in as many words ("we
// don't want AIs to have custom names etc. … and we especially don't want star wars jokes").
// So a Computer+ player is anonymous: the vocabulary below is six lines of ladder shorthand,
// there is no personality behind it, and the speaker is whatever the lobby already calls that
// slot.
//
// The lines go out through the ordinary chat path — `RtsController.onChatSaid` →
// `MapViewerScene.deliverChat` — so a computer's "glhf" is routed, tagged, coloured, logged
// and relayed to LAN clients exactly like a human player's, and a map with a chat trigger on
// it sees the message the same way. There is no second channel.

/** Openers. One is drawn per match off the AI's own RNG stream. */
export const GREETINGS = ["glhf", "gl hf", "good luck"] as const;

/** …and what it says on the way out. */
export const CONCESSIONS = ["gg", "gg wp", "gg, well played"] as const;

/** Seconds into the match before anybody speaks, plus a stagger per slot — twelve computers
 *  all saying "glhf" on the same frame reads as a bug rather than as a lobby. */
export const GREET_AT = 4;
export const GREET_STAGGER = 1.5;

/** How long after conceding it actually leaves. Long enough to read the line. */
export const LEAVE_AFTER = 5;

/** Nothing is conceded inside the first two minutes, whatever `hopeless` says.
 *
 *  A safety rail rather than a rule, and it is here because the failure it guards against
 *  actually happened: an earlier `hopeless` counted "one building and no army" as lost, which
 *  is a description of every melee OPENING — the AI greeted the player and immediately said gg
 *  with its Great Hall still going up. Nothing about a real defeat can be true this early, so a
 *  floor costs nothing and makes that whole class of mistake impossible. */
export const CONCEDE_NOT_BEFORE = 120;

/**
 * How a Computer+ player's position looks to it, in the six numbers that decide whether the
 * game is over.
 */
export interface Standing {
  /** Finished halls of any tier — `townCountDone(hall)` folds a Castle into a Town Hall. */
  halls: number;
  /** Every finished structure. Blizzard.j declares a melee player defeated at ZERO of these
   *  (`MeleeGetAllyStructureCount`), so a concession has to happen while there is still one
   *  standing or it would never happen at all. */
  structures: number;
  workers: number;
  /** Food spent on fighters. */
  armyFood: number;
  gold: number;
  /** Enemy fighters standing in our towns. */
  invaders: number;
}

/**
 * Is this position beyond saving?
 *
 * Deliberately conservative — an AI that concedes a game it could still play is worse than one
 * that never concedes at all — and both clauses are stated as "there is no MOVE from here",
 * never as "this looks bad". Anything softer describes an opening as well as a defeat:
 *
 *  1. **No hall, and no way to put one back up** — nobody left to build it, or not enough gold
 *     to pay for it. This is the real losing condition of a melee game one step before the
 *     engine's own: Blizzard.j declares a player defeated at ZERO structures, so a concession
 *     has to happen while something is still standing or it would never happen at all.
 *  2. **The enemy army is in the base and there is nothing left to answer it with** — no army,
 *     no workers. A hall and a purse cannot save that, and it is the moment a human types gg.
 *
 * `structures` is not tested by either clause and is kept for the same reason `invaders` is a
 * count: they are what a future reading of the position would be written in terms of, and they
 * are cheap. `hallCost` is the race's own tier-1 hall price, read from the registry rather than
 * typed here, so clause 1 asks the real question on every race.
 */
export function hopeless(s: Standing, hallCost: number): boolean {
  if (s.halls === 0 && (s.workers === 0 || s.gold < hallCost)) return true;
  if (s.invaders > 0 && s.armyFood === 0 && s.workers === 0) return true;
  return false;
}
