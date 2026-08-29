// Headless check of when Computer+ accepts it has lost (src/ai/plus/chatter.ts `hopeless`).
//
// The bug this exists for: an AI that never conceded. A player finished a game by razing the
// base building by building, minutes after it was decided, because BOTH of the original two
// clauses are vetoed by a surviving WORKER — clause 1 by "somebody could still put a hall back
// up", clause 2 by `workers === 0` — and a worker is precisely the last thing a player kills.
// Two Peons in a corner with gold banked held the concession open indefinitely.
//
// `hopeless` is pure — six numbers in, a boolean out, no world — so the positions it has to
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
const { hopeless, CONCEDE_NOT_BEFORE, LEAVE_AFTER } = require(join(REPO, ".sim-build", "src", "ai", "plus", "chatter.js"));
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
const at = (o) => ({ halls: 0, structures: 0, workers: 0, armyFood: 0, gold: 0, invaders: 0, ...o });

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

console.log("\n-- the rails ---------------------------------------------------------------");

// The floor exists because the failure it guards actually happened — see the constant.
check("nothing is decided inside the first two minutes", CONCEDE_NOT_BEFORE, 120);
check("it says gg before it goes", LEAVE_AFTER > 0, true);
// A weaker player takes longer to accept a lost game. This ordering IS the difficulty.
check("Easy takes longest to accept it", PLUS_EASY.concedeAfter > PLUS_NORMAL.concedeAfter, true);
check("…and Insane the least", PLUS_NORMAL.concedeAfter > PLUS_INSANE.concedeAfter, true);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
