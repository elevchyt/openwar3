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

/**
 * Openers. One is drawn per match off the AI's own RNG stream.
 *
 * WIDE ON PURPOSE. Three lines shared between a lobby's worth of computers is not a draw, it
 * is a rotation: on a four-player map two of them said the same word every game, and with the
 * greetings also going out in strict slot order (see `GREET_AT`) the whole opening read as one
 * scripted line rather than as four players typing. Still anonymous ladder shorthand — issue
 * #124 rules out personalities, and none of these say anything about who is speaking.
 *
 * **Nothing here addresses a ROOM.** "gl all", "hf all" and "glhf all" were in this list and
 * came out again: a Computer+ seat draws the same line whatever the lobby is, and most lobbies
 * are a 1v1, where a computer greeting "all" is greeting one person as if it were four. The
 * alternative — a second list for games with three or more seats — buys a word nobody reads
 * and a rule to keep right, and the eight remaining lines are already wider than the four
 * openings a four-player map needs.
 */
export const GREETINGS = [
  "glhf", "hf", "glgl", "gl hf", "hf gl", "gl", "gl & hf", "hfgl",
] as const;

/** …and what it says on the way out. */
export const CONCESSIONS = ["gg", "gg wp", "gg, well played"] as const;

/**
 * WHEN a computer says it: never before `GREET_AT`, and somewhere inside the `GREET_SPREAD`
 * seconds after it — drawn per seat off that player's own stream (`Brain.greetAt`).
 *
 * It used to be `GREET_AT + GREET_STAGGER * slot`, which is a metronome: every seat spoke, in
 * ascending slot order, exactly a second apart, every match. Drawing the moment instead makes
 * the order and the gaps different each game — two computers landing on the same beat and then
 * a pause is what a lobby actually sounds like, and it is the same window either way.
 *
 * `GREET_STAGGER` survives because the ALLY openers are still staggered by it (`openerTalk`),
 * where a fixed beat is right: those are sentences rather than two-letter words, and reading
 * them wants them apart.
 */
export const GREET_AT = 2;
export const GREET_SPREAD = 6;
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
 * HALF THE TEAM HAS GONE — the concession that is NOT a reading of the board.
 *
 * Asked for in as many words: *"if half or more of the allies have left the game, then the rest
 * of the Computer+ AI teammates must concede"*. It sits beside `hopeless` rather than inside it
 * because it is a different question entirely: `hopeless` reads this player's own base, army and
 * heroes, and a computer whose two teammates walked out can be sitting on a perfectly healthy
 * economy while the match is over. A 3v3 that is now a 1v3 is not a game anybody plays out. For
 * the same reason `mannersPass` does not put it behind `CONCEDE_NOT_BEFORE`: a teammate leaving
 * at ninety seconds has decided the game as thoroughly as one leaving at ten minutes.
 *
 * `team` is the roster as it STARTED and `allies` who is still playing, and the caller's job is
 * that the first only ever grows (`Brain.team`): "left" is seen as *nothing on the map*, because
 * leaving runs `MeleeTriggerActionPlayerLeft` and the leaver's units go to Neutral Passive — so
 * a re-derived roster would lose the departed from both sides of the ratio at once and it would
 * never move. It also means a teammate who was WIPED OUT counts, which is right: either way
 * there is nobody there to fight beside.
 *
 * Half or MORE, against the team as it started: two of four concedes, one of three does not.
 * An empty team is a 1v1 or a free-for-all and can never concede for this reason.
 */
export function teamLost(team: readonly number[], allies: readonly number[]): boolean {
  if (!team.length) return false;
  let gone = 0;
  for (const p of team) if (!allies.includes(p)) gone++;
  return gone * 2 >= team.length;
}

/**
 * The WEIGHTS the position is read with, once no single clause of `hopeless` has fired.
 *
 * Five clauses of "there is no move from here" is an honest rule and a narrow one: every one of
 * them has to be true all the way through, so a position that is two thirds of the way into
 * three different clauses at once — which is what a game actually looks like while it is being
 * lost — matches none of them and reads as perfectly healthy. Reported as exactly that: the AI
 * plays on long after a person would have typed gg, because losing the hall and losing every
 * hero is not *itself* any of the five.
 *
 * So the clauses stay as the FLOOR and this is the second reading above them: each term is what
 * that part of the position is worth on its own, they add up, and `CONCEDE_AT` is the line. It
 * is a lower bar than the clauses by construction — nothing here has to be the whole of a defeat
 * — and the dwell (`PlusProfile.concedeAfter`) is what keeps it safe, exactly as it does for
 * clause 4: every term un-latches the instant the position recovers, and a hall that goes back
 * up, a hero that revives, a raid that dies or walks off, or one soldier coming out of a
 * Barracks all reset `hopelessSince`.
 *
 * **The two heavy ones are heavy because they were asked to be**: a player with no hero and a
 * player with no hall are each halfway out of the game, and together they are out of it — those
 * are the two `CONCEDE_AT` is calibrated on, and they alone reach it. The rest are the ordinary
 * terms of a losing position and none of them is worth a third of one.
 *
 *  • `heroesDead` — not one of ours up (an altar's revival clock still counts as up, see
 *    `Standing.heroes`) and at least one down. The `heroesLost > 0` half is the same guard
 *    clause 4 carries and for the same reason: "we have no hero" describes every player who has
 *    not built one yet. `heroEach` adds for the SECOND and THIRD as well, capped there — losing
 *    a three-hero roster outright is worse than losing the one hero you had.
 *  • `hallDown` — every hall of ours gone (`townCountDone` folds a Castle into a Town Hall, so
 *    this is "no town centre anywhere", expansions included). Losing it with a worker and the
 *    gold for another is not clause 1, which is why it needs a weight at all: the position CAN
 *    rebuild, and it is still a player who has been knocked out of their own base.
 *  • `armyGone` — nothing on the field and nothing in a queue (`armyFood` counts production).
 *  • `invaded` / `invaderHero` — somebody is standing in our towns, and one of them is a hero.
 *  • `noWorkers` — nothing left to mine, build or repair with.
 *  • `broke` — not the gold for a hall, which is what makes the loss of one permanent.
 *
 * None of these numbers are Warcraft III's — nothing in the install describes an AI that resigns
 * (docs/computer-plus.md) — so they are OURS, and `tools/ai-plus-concede-test.cjs` pins them.
 */
export const DESPAIR = {
  heroesDead: 0.5,
  heroEach: 0.1,
  hallDown: 0.5,
  armyGone: 0.3,
  invaded: 0.2,
  invaderHero: 0.1,
  noWorkers: 0.25,
  broke: 0.15,
} as const;

/** Where the weighed reading tips into a concession. One whole defeat's worth — which the two
 *  heavy terms make exactly, and nothing else in `DESPAIR` reaches without one of them. */
export const CONCEDE_AT = 1;

/** How lost this position is, in `DESPAIR`'s units. Pure, and 0 for a healthy player. */
export function despair(s: Standing, hallCost: number): number {
  let d = 0;
  if (s.heroes === 0 && s.heroesLost > 0) {
    d += DESPAIR.heroesDead + DESPAIR.heroEach * Math.min(s.heroesLost - 1, 2);
  }
  if (s.halls === 0) d += DESPAIR.hallDown;
  if (s.armyFood === 0) d += DESPAIR.armyGone;
  if (s.invaders > 0) d += DESPAIR.invaded;
  if (s.invaderHeroes > 0) d += DESPAIR.invaderHero;
  if (s.workers === 0) d += DESPAIR.noWorkers;
  if (s.gold < hallCost) d += DESPAIR.broke;
  return d;
}

/**
 * Is this position beyond saving?
 *
 * TWO readings, and a position only has to fail one of them. First the five CLAUSES below, each
 * of which is a complete defeat on its own; then the weighed one above them (`despair`), which
 * is what catches a game that is being lost in three places at once without being wholly lost in
 * any of them. The clauses are the older half and the narrower, and they are still the reason
 * nothing here reads an opening as a defeat.
 *
 * Each clause is deliberately conservative — an AI that concedes a game it could still play is
 * worse than one that never concedes at all — and every one is stated as "there is no MOVE from
 * here", never as "this looks bad". Anything softer describes an opening as well as a defeat:
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
 * than the clause itself: the position has to hold for 8-24 s, and it un-latches if the raiders
 * die or leave (`invaders`), if their hero dies or walks out (`invaderHeroes`), or the moment
 * ours is back on the field. A defence that wins, or a revival that lands, resets the clock.
 * What it will NOT wait for is the last building — which is the whole point.
 *
 * `structures` is tested by neither reading and is kept for the same reason `invaders` is a
 * count rather than a boolean: they are what a further reading of the position would be written
 * in terms of, and they are cheap. `hallCost` is the race's own tier-1 hall price, read from the
 * registry rather than typed here, so clause 1 — and `DESPAIR.broke` with it — asks the real
 * question on every race.
 */
export function hopeless(s: Standing, hallCost: number): boolean {
  if (s.halls === 0 && (s.workers === 0 || s.gold < hallCost)) return true;
  if (s.invaders > 0 && s.armyFood === 0 && s.workers === 0) return true;
  if (s.invaders > 0 && s.armyFood === 0 && s.halls === 0) return true;
  if (s.heroesLost > 0 && s.heroes === 0 && s.invaderHeroes > 0) return true;
  if (s.heroesLost > 0 && s.heroes === 0 && s.armyFood === 0 && s.invaders > 0) return true;
  // …and the positions no single clause describes but every one of them is partly true of.
  return despair(s, hallCost) >= CONCEDE_AT;
}
