// Headless check of when Computer+ accepts it has lost (src/ai/plus/chatter.ts `hopeless`).
//
// The bug this exists for: an AI that never conceded. A player finished a game by razing the
// base building by building, minutes after it was decided, because BOTH of the original two
// clauses are vetoed by a surviving WORKER — clause 1 by "somebody could still put a hall back
// up", clause 2 by `workers === 0` — and a worker is precisely the last thing a player kills.
// Two Peons in a corner with gold banked held the concession open indefinitely.
//
// The bug BESIDE it, and the reason for the second half of the file: each of those clauses is a
// whole defeat, so a position two thirds of the way into three of them at once matched none and
// read as perfectly healthy — every hero dead and the hall razed is not itself any of the five.
// `despair` weighs the parts instead, and those two are the heavy terms.
//
// `hopeless` is pure — nine numbers in, a boolean out, no world — so the positions it has to
// read correctly are testable exactly as written. Both directions matter and the false one
// matters more: an AI that concedes a game it could still play is worse than one that never
// concedes at all, so every "plays on" case below is a position a real melee player recovers.
//
// None of these numbers are Warcraft III's — nothing in the install describes an AI that
// resigns (see docs/computer-plus.md) — so this pins OUR ruling, and a later edit to it is a
// deliberate one.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { hopeless, despair, teamLost, CONCEDE_AT, CONCEDE_NOT_BEFORE, LEAVE_AFTER } = require(join(REPO, ".sim-build", "src", "ai", "plus", "chatter.js"));
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The Great Hall's own price, which is what `mannersPass` reads off the registry for an orc.
const HALL = 385;
const at = (o) => ({ halls: 0, structures: 0, workers: 0, armyFood: 0, gold: 0, invaders: 0,
  invaderHeroes: 0, heroes: 0, heroesLost: 0, ...o });
// A position with a base and an army standing — what clause 4's cases vary the HEROES of, so
// that nothing in them can be passing for one of the first three clauses' reasons.
const holding = (o) => at({ halls: 1, structures: 6, workers: 5, armyFood: 30, gold: 500, ...o });

console.log("\n-- positions that are still games ------------------------------------------");

check("a melee opening is not a defeat",
  hopeless(at({ halls: 1, structures: 3, workers: 5, gold: 200 }), HALL), false);
check("an army traded away, with the base intact",
  hopeless(at({ halls: 1, structures: 6, workers: 5, gold: 400 }), HALL), false);
// The line the third clause deliberately does NOT cross: a hall standing means it can rebuild.
check("the base is being razed, but the hall still stands",
  hopeless(at({ halls: 1, structures: 2, workers: 3, gold: 600, invaders: 8 }), HALL), false);
// `armyFood` counts production queues too, so a building still making soldiers is an answer.
check("hall gone and raiders in the base, but a Barracks is still training",
  hopeless(at({ structures: 2, workers: 2, armyFood: 5, gold: 900, invaders: 6 }), HALL), false);
check("hall gone, but nothing is standing on the base — it can rebuild",
  hopeless(at({ structures: 2, workers: 2, gold: 900, invaders: 0 }), HALL), false);
check("no hall yet the purse and the builders are there (clause 1's own veto)",
  hopeless(at({ structures: 2, workers: 2, gold: 900 }), HALL), false);

console.log("\n-- positions with no move left ---------------------------------------------");

// THE REPORTED CASE. Before clause 3 this read "plays on" and the player had to raze the base.
check("hall razed, army dead, the enemy standing in the base, two peons and gold left",
  hopeless(at({ structures: 2, workers: 2, gold: 900, invaders: 6 }), HALL), true);
check("…one peon hiding in a corner changes nothing",
  hopeless(at({ structures: 1, workers: 1, gold: 1500, invaders: 8 }), HALL), true);
check("clause 1 still stands: no hall and nobody to build one",
  hopeless(at({ structures: 2, gold: 900 }), HALL), true);
check("clause 1 still stands: no hall and not the gold for one",
  hopeless(at({ structures: 2, workers: 2, gold: 50 }), HALL), true);
check("clause 2 still stands: raiders in the base, no army, no workers",
  hopeless(at({ halls: 1, structures: 4, gold: 900, invaders: 6 }), HALL), true);

console.log("\n-- clause 4: heroless against a live enemy hero in the base ----------------");

// The three parts of the rule, each removed in turn from a position that otherwise fires.
check("our hero is dead, theirs is alive and in our base",
  hopeless(holding({ heroesLost: 1, invaders: 9, invaderHeroes: 1 }), HALL), true);
check("…still true with a whole base and army standing: this clause reads the FIGHT",
  hopeless(holding({ halls: 3, structures: 14, armyFood: 60, gold: 2000, heroesLost: 3, invaders: 12, invaderHeroes: 2 }), HALL), true);

check("…but not while one of ours is still on the field",
  hopeless(holding({ heroes: 1, heroesLost: 1, invaders: 9, invaderHeroes: 1 }), HALL), false);
// `standing()` counts a hero on an altar's clock into `heroes` — it is coming back, not gone.
check("…nor while ours is on the altar's revival clock",
  hopeless(holding({ heroes: 1, heroesLost: 1, invaders: 9, invaderHeroes: 1 }), HALL), false);
check("…nor when the raid has no hero in it",
  hopeless(holding({ heroesLost: 1, invaders: 9, invaderHeroes: 0 }), HALL), false);
check("…nor when their hero is not in our base (invaderHeroes counts only the group attacking)",
  hopeless(holding({ heroesLost: 1, invaders: 0, invaderHeroes: 0 }), HALL), false);

// The guard that keeps clause 4 off the opening. "We have no hero" is also true of every
// player who has not built one yet, so without `heroesLost` an early hero RUSH reads as a lost
// game. The fallen roster is empty here because there is nothing on it to be empty of.
check("a hero rush at the two-minute floor is NOT a lost game — we never had a hero to lose",
  hopeless(holding({ heroesLost: 0, invaders: 6, invaderHeroes: 1 }), HALL), false);

console.log("\n-- clause 5: no hero, no army, and them in your base -----------------------");

// The clause 4 case, minus the enemy hero — which is how a real game actually ends: the
// player's hero is off elsewhere while the rest of their army razes the base. Reported as
// "it took quite a while for the AI to leave even though it lost its hero and didn't have an
// army", and before clause 5 nothing fired at all in that position.
check("our hero dead, our army gone, and their ARMY (no hero) in our base",
  hopeless(at({ halls: 2, structures: 8, workers: 4, gold: 700, heroesLost: 1, invaders: 7 }), HALL), true);
check("…still true with a full purse and a base standing: there is nothing to spend it on",
  hopeless(at({ halls: 3, structures: 15, workers: 9, gold: 4000, heroesLost: 2, invaders: 4 }), HALL), true);

// …and the three ways out of it, each of which is a real route back.
check("…but not while an army of ours is still on the field",
  hopeless(at({ halls: 2, structures: 8, workers: 4, armyFood: 12, gold: 700, heroesLost: 1, invaders: 7 }), HALL), false);
check("…nor once the raiders have left",
  hopeless(at({ halls: 2, structures: 8, workers: 4, gold: 700, heroesLost: 1, invaders: 0 }), HALL), false);
check("…nor while a hero of ours is up (or on the altar's clock)",
  hopeless(at({ halls: 2, structures: 8, workers: 4, gold: 700, heroes: 1, heroesLost: 1, invaders: 7 }), HALL), false);
// The same opening guard clause 4 carries: never having built a hero is not having lost one.
check("…and a hero rush against a player who has no hero YET is not a lost game",
  hopeless(at({ halls: 2, structures: 8, workers: 4, gold: 700, heroesLost: 0, invaders: 7 }), HALL), false);

console.log("\n-- half the team has gone ---------------------------------------------------");

// The other concession, and the one that is not a reading of this player's own board at all:
// `teamLost` (plus/chatter.ts). `team` is the roster as it started — every seat that has ever
// been an ally — and `allies` is who still has anything on the map, so a player who quit and
// one who was wiped out are the same thing here. See docs/computer-plus.md.
check("a 1v1 can never concede for this reason", teamLost([], []), false);
check("a 2v2 with the partner still playing plays on", teamLost([1], [1]), false);
check("…and concedes when the partner goes", teamLost([1], []), true);
// Half or MORE, so one of two is already it — a 3v3 that is now a 2v3 has lost half its team.
check("a 3v3 concedes when one of its two teammates goes", teamLost([1, 2], [2]), true);
check("…and of course when both do", teamLost([1, 2], []), true);
// …while one of THREE is under half, which is the case the "or more" does not reach.
check("a 4v4 with one of its three gone plays on", teamLost([1, 2, 3], [2, 3]), false);
check("…and concedes at two of three", teamLost([1, 2, 3], [3]), true);
// The roster is latched precisely so this stays true: re-deriving it would drop the departed
// from both sides of the ratio at once and the rule would never fire.
check("a shrinking roster would never fire — the latched one does", teamLost([1, 2, 3], [1]), true);

console.log("\n-- the weighed reading -----------------------------------------------------");

// The second half of `hopeless`: the five clauses each describe a WHOLE defeat, so a position
// two thirds of the way into three of them at once matched none and read as healthy. `despair`
// adds the parts up instead, and the two heavy terms are the two the developer asked to weigh:
// no hero left alive, and no hall left standing. Either alone is half a lost game; both is one.
check("all heroes dead is half a lost game on its own, and not a concession",
  hopeless(holding({ heroesLost: 1 }), HALL), false);
check("…and so is the hall going down with the gold and the workers to put one back up",
  hopeless(at({ structures: 6, workers: 5, armyFood: 30, gold: 900 }), HALL), false);
// THE ASK. No clause reaches this: a hall can be rebuilt (clause 1's veto), nobody is standing
// in the base (clauses 2, 3 and 5) and there is no enemy hero in it (clause 4) — and the army
// is still on the field. Together the two are a player who has been knocked out of their game.
check("…but every hero dead AND the hall razed is a concession, army or no army",
  hopeless(at({ structures: 6, workers: 5, armyFood: 30, gold: 900, heroesLost: 1 }), HALL), true);
check("…and the heavier for a second and a third hero on the floor",
  despair(at({ structures: 6, workers: 5, armyFood: 30, gold: 900, heroesLost: 3 }), HALL)
    > despair(at({ structures: 6, workers: 5, armyFood: 30, gold: 900, heroesLost: 1 }), HALL), true);
// Neither heavy term is reachable by the light ones adding up — that is what CONCEDE_AT is for.
check("a bad position with a hero and a hall in it is still a game",
  hopeless(at({ halls: 1, structures: 4, workers: 3, gold: 0, invaders: 5, invaderHeroes: 1, heroes: 1 }), HALL), false);
check("an opening nowhere near a defeat scores nowhere near the line",
  despair(at({ halls: 1, structures: 3, workers: 5, gold: 200 }), HALL) < CONCEDE_AT, true);
check("a healthy player scores nothing at all",
  despair(holding({ heroes: 2 }), HALL), 0);

console.log("\n-- the rails ---------------------------------------------------------------");

// The floor exists because the failure it guards actually happened — see the constant.
check("nothing is decided inside the first two minutes", CONCEDE_NOT_BEFORE, 120);
check("it says gg before it goes", LEAVE_AFTER > 0, true);
// A weaker player takes longer to accept a lost game. This ordering IS the difficulty.
check("Easy takes longest to accept it", PLUS_EASY.concedeAfter > PLUS_NORMAL.concedeAfter, true);
check("…and Insane the least", PLUS_NORMAL.concedeAfter > PLUS_INSANE.concedeAfter, true);
// The dwell only ever pays for a position that was never lost, and every term of both readings
// un-latches the instant one recovers — so it is short. Half a minute of a decided game is half
// a minute nobody wants to play.
check("even the slowest of them accepts it inside half a minute", PLUS_EASY.concedeAfter <= 30, true);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
