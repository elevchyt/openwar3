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
export const GREETINGS = ["glhf", "hf", "glgl"] as const;

/** …and what it says on the way out. */
export const CONCESSIONS = ["gg", "gg wp", "gg, well played"] as const;

/** Seconds into the match before anybody speaks, plus a stagger per slot — twelve computers
 *  all saying "glhf" on the same frame reads as a bug rather than as a lobby. */
export const GREET_AT = 2;
export const GREET_STAGGER = 1;

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
 * How a Computer+ player's position looks to it — the numbers that decide whether the game is
 * over, and nothing else.
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
  /** …and how many of THOSE are heroes. A subset of `invaders`, never larger. */
  invaderHeroes: number;
  /** Our own heroes still on the field — plus any already on an altar's revival clock, which
   *  is a hero on the way back rather than a hero we no longer have. */
  heroes: number;
  /** Heroes of ours lying DEAD — the fallen roster (SimWorld.fallenHeroesOf), which a hero is
   *  struck off the moment it is actually revived. So this is "one of ours is down right now",
   *  and it is empty both for a player who has lost none and for one who never built any. */
  heroesLost: number;
}

/**
 * Is this position beyond saving?
 *
 * Deliberately conservative — an AI that concedes a game it could still play is worse than one
 * that never concedes at all — and every clause is stated as "there is no MOVE from here",
 * never as "this looks bad". Anything softer describes an opening as well as a defeat:
 *
 *  1. **No hall, and no way to put one back up** — nobody left to build it, or not enough gold
 *     to pay for it. This is the real losing condition of a melee game one step before the
 *     engine's own: Blizzard.j declares a player defeated at ZERO structures, so a concession
 *     has to happen while something is still standing or it would never happen at all.
 *  2. **The enemy army is in the base and there is nothing left to answer it with** — no army,
 *     no workers. A hall and a purse cannot save that, and it is the moment a human types gg.
 *  3. **The enemy army is in the base, there is no army, and no hall to make one from.**
 *  4. **Our heroes are dead, theirs is not, and theirs is in our base.**
 *  5. **Our heroes are dead, our army is gone, and they are in our base** — whether or not a
 *     hero of theirs happens to be standing in it.
 *
 * Clause 3 is what makes the other two reachable, and it is here because without it the AI
 * effectively never conceded at all: a player had to raze the base building by building to win
 * a game that had been over for minutes. Both of the first two clauses are vetoed by a WORKER —
 * clause 1 by "somebody could still build a hall", clause 2 by `workers === 0` — and a worker
 * is precisely the last thing a player kills. Two Peons cowering in a corner with 900 gold
 * banked held the whole concession open.
 *
 * It is still "no route back", not "this looks bad", and it says so in the three terms it is
 * written in: with no hall there is nothing to train from, so the gold cannot be spent on an
 * answer; a new hall takes the better part of a minute to raise with the enemy army already
 * standing on the spot; and workers do not fight. What it deliberately does NOT claim is that a
 * razing is lost while a hall still stands — that position can genuinely rebuild, and the AI
 * plays it out. Note also how it un-latches: if the raiders die or move on `invaders` drops to
 * 0, and if anything at all is trained `armyFood` rises, and either resets `hopelessSince` —
 * so a position that recovers inside `concedeAfter` never says gg.
 *
 * Clause 4 is a different KIND of reading from the first three, and it is worth being honest
 * about that. Those three are about what is left standing; this one is about the fight. It is
 * the read a ladder player actually makes — a hero is the piece a melee army is built around,
 * and being heroless against a live enemy hero that is already inside your base is the position
 * people type gg in long before the last building falls. It says nothing about buildings or
 * gold on purpose.
 *
 * Two things keep it honest, and neither is optional:
 *
 *  • It asks `heroesLost > 0`, not just `heroes === 0`. "We have no hero" is also true of
 *    every player who has not built one yet — at the two-minute floor, most of them — so
 *    without this the clause reads an early hero RUSH as a lost game, which is exactly the
 *    mistake CONCEDE_NOT_BEFORE exists to make impossible. Together the two terms say what
 *    the rule actually means: we have a hero down, and not one of ours is up.
 *  • A hero already on an altar's revival clock counts as a hero we HAVE (see `heroes`). It
 *    is coming back at full strength inside the minute, which is a move from here — and the
 *    AI does revive: `AiPlayer.reviveFallen` is how every race script's "always rebuild heroes
 *    for defense" branch is answered.
 *
 * Clause 5 is clause 4 with the enemy hero taken out of it and the ARMY put in instead, and it
 * exists because clause 4 turned out to be reachable only by accident. Reported from a real
 * game: "it took quite a while for the AI to leave even though it lost its hero and didn't have
 * an army." It had — but the player's hero was off somewhere else at the moment the rest of
 * their army was razing the base, so `invaderHeroes` was 0 and nothing fired. No hero, no army,
 * and them standing in your town is a lost game whoever is doing the standing; the enemy hero
 * in clause 4 is what makes the position lost EARLY, while an army of ours is still on the
 * field, which is why both are kept rather than one replacing the other.
 *
 * Clause 4 is also the loosest of the five, and `concedeAfter` is what makes that safe rather
 * than the clause itself: the position has to hold for 20-45 s, and it un-latches if the raiders
 * die or leave (`invaders`), if their hero dies or walks out (`invaderHeroes`), or the moment
 * ours is back on the field. A defence that wins, or a revival that lands, resets the clock.
 * What it will NOT wait for is the last building — which is the whole point.
 *
 * `structures` is not tested by any clause and is kept for the same reason `invaders` is a
 * count: they are what a future reading of the position would be written in terms of, and they
 * are cheap. `hallCost` is the race's own tier-1 hall price, read from the registry rather than
 * typed here, so clause 1 asks the real question on every race.
 */
export function hopeless(s: Standing, hallCost: number): boolean {
  if (s.halls === 0 && (s.workers === 0 || s.gold < hallCost)) return true;
  if (s.invaders > 0 && s.armyFood === 0 && s.workers === 0) return true;
  if (s.invaders > 0 && s.armyFood === 0 && s.halls === 0) return true;
  if (s.heroesLost > 0 && s.heroes === 0 && s.invaderHeroes > 0) return true;
  if (s.heroesLost > 0 && s.heroes === 0 && s.armyFood === 0 && s.invaders > 0) return true;
  return false;
}
