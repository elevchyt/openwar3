// Headless checks of the two Computer+ decisions that used to be made by arithmetic that did
// not mean anything: WHICH CREEP CAMP an army may walk into (src/ai/plus/power.ts) and WHICH
// WAY the scout walks to avoid one (src/ai/plus/index.ts `safeLeg`).
//
// What each is here to pin:
//
//   1. CAMPS ARE PRICED, NOT MEASURED IN FOOD. Creeping used to compare four fifths of the
//      army's FOOD against a camp's combined creep LEVEL — two different units of measurement
//      that happen to be numbers. At thirty food it read "camps between 14 and 24", which is
//      orange and red, and it sent whatever was standing around into them. Both directions
//      matter here and the false one matters more: a lone hero must not walk into a red camp.
//   2. THE SCOUT GOES ROUND. A melee map's creep camps sit on the ground between two bases, so
//      the straight line from home to the enemy's door runs through one — the scout walked in,
//      died, and because a lost scout LATCHES that one walk was the whole of what the AI ever
//      learnt about the map.
//
// None of these numbers are Warcraft III's (nothing in the install describes an AI that creeps
// or scouts) so this pins OUR tuning. What IS the game's is the scale it is stated against: the
// camp levels, and the green/orange/red the client itself paints them in.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const {
  canClearCamp, maxCampLevel, CAMP_GREEN_MAX, CAMP_ORANGE_MAX, CAMP_HEALTH,
} = require(join(REPO, ".sim-build", "src", "ai", "plus", "power.js"));
const { safeLeg } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** A party, in the three terms plus/power.ts reads. Healthy unless said otherwise. */
const force = (fighterFood, heroLevel, health = 1) => ({ fighterFood, heroLevel, health });

// A camp of each colour, at the boundaries the minimap's own dot colours draw.
const GREEN = 6;
const ORANGE = 14;
const RED = 24;

// ==========================================================================================
console.log("\n-- a party is priced against the camp's colour ----------------------------");
// ==========================================================================================

// GREEN: the brief is "one hero and one or two fighters". Two Footmen is four food.
check("hero + two footmen takes a green camp", canClearCamp(force(4, 1), GREEN), true);
check("…the hero alone does not", canClearCamp(force(0, 1), GREEN), false);
check("…and neither do the footmen alone", canClearCamp(force(8, 0), GREEN), false);

// ORANGE: "about four of those units with the hero".
check("hero + two footmen does NOT take an orange camp", canClearCamp(force(4, 1), ORANGE), false);
check("four footmen and a level-2 hero does", canClearCamp(force(10, 2), ORANGE), true);
check("…but not on a level-1 hero", canClearCamp(force(10, 1), ORANGE), false);

// RED: "a pretty big army with a level 3-4+ hero". This is the case the whole file exists for.
check("a level-2 hero with four footmen does NOT take a red camp", canClearCamp(force(10, 2), RED), false);
check("a lone hero never does, at any level", canClearCamp(force(0, 10), RED), false);
check("twelve food and a level-4 hero does", canClearCamp(force(24, 4), RED), true);

// HEALTH — the third term, and the one that stops the party clearing a camp and walking
// straight into the next one on what is left of it.
check("a hurt party stays home", canClearCamp(force(24, 4, CAMP_HEALTH - 0.01), GREEN), false);
check("…and a scratched one does not", canClearCamp(force(24, 4, CAMP_HEALTH + 0.01), GREEN), true);

// ==========================================================================================
console.log("\n-- …and the ceiling that becomes GetCreepCamp's `max` ---------------------");
// ==========================================================================================

check("nothing at all: not creeping", maxCampLevel(force(0, 0)) < 0, true);
check("hero + two footmen: green only", maxCampLevel(force(4, 1)), CAMP_GREEN_MAX);
check("four footmen + level 2: up to orange", maxCampLevel(force(10, 2)), CAMP_ORANGE_MAX);
check("an army + level 4: no ceiling", maxCampLevel(force(24, 4)), Infinity);
check("…a hurt army has no ceiling because it is not going", maxCampLevel(force(24, 4, 0.4)) < 0, true);

// ==========================================================================================
console.log("\n-- the scout walks ROUND a creep camp, not through it ---------------------");
// ==========================================================================================

const HOME = { x: -3000, y: 0 };
const BASE = { x: 3000, y: 0 };
/** How near the leg passes a camp — the whole question. */
const nearest = (leg, camp) => {
  // Distance from the camp to the SEGMENT home→leg, which is what the scout actually walks.
  const dx = leg.x - HOME.x;
  const dy = leg.y - HOME.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((camp.x - HOME.x) * dx + (camp.y - HOME.y) * dy) / len2));
  return Math.hypot(HOME.x + dx * t - camp.x, HOME.y + dy * t - camp.y);
};

check("a clear line is walked straight", safeLeg(HOME, BASE, []).x, BASE.x);
check("…with a camp well off it, still straight", safeLeg(HOME, BASE, [{ x: 0, y: 4000 }]).x, BASE.x);

// A camp sitting exactly on the line between the two bases — the melee map's own layout.
const ON_THE_LINE = { x: 0, y: 0 };
const round = safeLeg(HOME, BASE, [ON_THE_LINE]);
check("a camp ON the line is detoured around", round.x === BASE.x && round.y === BASE.y, false);
check("…and the leg then clears it", nearest(round, ON_THE_LINE) > 800, true);

// A camp just to one side: the detour must go the OTHER way, not straight through it.
const OFF_LEFT = { x: 0, y: 400 };
const past = safeLeg(HOME, BASE, [OFF_LEFT]);
check("a camp off to the left is passed on the right", past.y < 0, true);
check("…clearing it", nearest(past, OFF_LEFT) > 800, true);

// Two camps: the FIRST one on the way is the one gone round, because clearing it changes
// where everything after it lies.
const two = safeLeg(HOME, BASE, [{ x: 1500, y: 0 }, { x: -1500, y: 0 }]);
check("the nearer camp is the one gone round", nearest(two, { x: -1500, y: 0 }) > 800, true);

// A camp BEHIND us, or past the destination, is not on the way at all.
check("a camp behind is ignored", safeLeg(HOME, BASE, [{ x: -4000, y: 0 }]).x, BASE.x);
check("…and one past the target too", safeLeg(HOME, BASE, [{ x: 5000, y: 0 }]).x, BASE.x);

console.log(failed ? `\n${failed} FAILED\n` : "\nall ok\n");
process.exit(failed ? 1 : 0);
