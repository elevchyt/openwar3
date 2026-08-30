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
//   2. NOTHING WAITS FOR EVER. A wave had no deadline of any kind, so any objective the group
//      could not reach froze the whole army — hero included — for the rest of the match, and a
//      camp it gave up on was handed straight back to it on the next pass.
//   3. THE SCOUT GOES ROUND. A melee map's creep camps sit on the ground between two bases, so
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
  canClearCamp, maxCampLevel, armyPower, forcePower, CAMP_GREEN_MAX, CAMP_ORANGE_MAX, CAMP_HEALTH,
} = require(join(REPO, ".sim-build", "src", "ai", "plus", "power.js"));
const { safeLeg, pushStalled, isShunned } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The three melee soldiers this file reasons in, on the GAME's own numbers (UnitBalance.slk /
// UnitWeapons.slk): a Grunt hits hard and has a lot of hit points, an Archer neither.
const GRUNT = { dps: 16, hp: 700, maxHp: 700 };
const FOOTMAN = { dps: 9.6, hp: 420, maxHp: 420 };
const ARCHER = { dps: 11, hp: 245, maxHp: 245 };
const n = (unit, k) => Array.from({ length: k }, () => ({ ...unit }));

/** A party, in the terms plus/power.ts reads. Healthy unless said otherwise. */
const force = (fighters, heroLevel, health = 1, heroHealth = 1) =>
  ({ fighters, heroLevel, health, heroHealth });

// A camp of each colour, at the boundaries the minimap's own dot colours draw.
const GREEN = 6;
const ORANGE = 14;
const RED = 24;

// ==========================================================================================
console.log("\n-- FOOD IS NOT WHAT AN ARMY IS WORTH ------------------------------------");
// ==========================================================================================

// The whole reason this file replaced a food count. Three Grunts and three Archers are nine
// food and six food of the same "three units", and they are not the same army.
check("three grunts outrank three archers", armyPower(n(GRUNT, 3)) > armyPower(n(ARCHER, 3)), true);
check("…by a lot", armyPower(n(GRUNT, 3)) > armyPower(n(ARCHER, 3)) * 1.5, true);
check("a hurt army is worth less than a healthy one",
  armyPower([{ dps: 16, hp: 200, maxHp: 700 }]) < armyPower([GRUNT]), true);
check("nothing is worth nothing", armyPower([]), 0);
check("a unit that cannot swing adds nothing", armyPower([{ dps: 0, hp: 900, maxHp: 900 }]), 0);
// Quadrature: twice the army is not twice the power, it is √2 — which is what keeps the
// thresholds readable as "about this many soldiers".
check("power adds in quadrature", Math.round(armyPower(n(GRUNT, 4)) / armyPower([GRUNT])), 2);
// The hero is a multiplier on the party, not another body.
check("a levelled hero is worth more than a level-1 one",
  forcePower(force(n(GRUNT, 2), 5)) > forcePower(force(n(GRUNT, 2), 1)), true);
check("no hero, no power at all", forcePower(force(n(GRUNT, 4), 0)), 0);

// ==========================================================================================
console.log("\n-- a party is priced against the camp's colour ----------------------------");
// ==========================================================================================

// GREEN: the brief is "one hero and one or two fighters".
check("hero + two grunts takes a green camp", canClearCamp(force(n(GRUNT, 2), 1), GREEN), true);
check("…the hero alone does not", canClearCamp(force([], 1), GREEN), false);
check("…and neither do the grunts alone", canClearCamp(force(n(GRUNT, 4), 0), GREEN), false);

// ORANGE: "about four of those units with the hero" — and this is the bar that was RAISED,
// because the AI was walking into orange camps with parties that had no chance.
check("hero + two grunts does NOT take an orange camp", canClearCamp(force(n(GRUNT, 2), 1), ORANGE), false);
check("four grunts and a level-3 hero does", canClearCamp(force(n(GRUNT, 4), 3), ORANGE), true);
check("…but not on a level-1 hero", canClearCamp(force(n(GRUNT, 4), 1), ORANGE), false);
check("…and four ARCHERS are not four grunts", canClearCamp(force(n(ARCHER, 4), 3), ORANGE), false);

// RED: "a pretty big army with a level 3-4+ hero". This is the case the whole file exists for.
check("four grunts and a level-3 hero does NOT take a red camp", canClearCamp(force(n(GRUNT, 4), 3), RED), false);
check("a lone hero never does, at any level", canClearCamp(force([], 10), RED), false);
check("eight grunts and a level-5 hero does", canClearCamp(force(n(GRUNT, 8), 5), RED), true);

// HEALTH — the term that stops a party clearing a camp and walking into the next one on what
// is left of it. Both halves: the army's, and the captain's own.
check("a hurt party stays home", canClearCamp(force(n(GRUNT, 8), 5, CAMP_HEALTH - 0.01), GREEN), false);
check("…a scratched one does not", canClearCamp(force(n(GRUNT, 8), 5, CAMP_HEALTH + 0.01), GREEN), true);
check("a hurt CAPTAIN stays home too", canClearCamp(force(n(GRUNT, 8), 5, 1, 0.5), GREEN), false);

// ==========================================================================================
console.log("\n-- …and the ceiling that becomes GetCreepCamp's `max` ---------------------");
// ==========================================================================================

check("nothing at all: not creeping", maxCampLevel(force([], 0)) < 0, true);
check("hero + two grunts: green only", maxCampLevel(force(n(GRUNT, 2), 1)), CAMP_GREEN_MAX);
check("four grunts + level 3: up to orange", maxCampLevel(force(n(GRUNT, 4), 3)), CAMP_ORANGE_MAX);
check("eight grunts + level 5: no ceiling", maxCampLevel(force(n(GRUNT, 8), 5)), Infinity);
check("…a hurt army has no ceiling because it is not going", maxCampLevel(force(n(GRUNT, 8), 5, 0.4)) < 0, true);
// Footmen are between the two, which is the point of pricing rather than counting.
check("six footmen and a level-3 hero reach orange", maxCampLevel(force(n(FOOTMAN, 6), 3)), CAMP_ORANGE_MAX);

// ==========================================================================================
console.log("\n-- a wave that is going nowhere is written off ---------------------------");
// ==========================================================================================

// `PUSH_STUCK_AFTER` / `PUSH_PROGRESS` — 20 s with less than 300 units of movement. The FALSE
// direction matters most: a wave written off while it is merely walking never arrives anywhere.
const walk = (steps, { fighting = false, step = 400, from = 0 } = {}) => {
  const w = { was: null, since: 0 };
  let stuck = false;
  for (let i = 0; i < steps; i++) stuck = pushStalled(w, { x: from + i * step, y: 0 }, i * 2, fighting);
  return stuck;
};

check("an army that is walking is never written off", walk(30), false);
check("…even at a crawl, so long as it is covering ground", walk(30, { step: 200 }), false);
check("an army standing still for twenty seconds is", walk(30, { step: 0 }), true);
check("…but not before that", walk(6, { step: 0 }), false);
// A fight is not a stall, however long the group stands in it — and the clock starts again
// from where the fight ends rather than from where the group first stopped.
check("a group in a fight is never written off", walk(60, { step: 0, fighting: true }), false);
{
  const w = { was: null, since: 0 };
  for (let t = 0; t < 30; t += 2) pushStalled(w, { x: 0, y: 0 }, t, true); // thirty seconds of fighting
  check("…and the clock restarts when it ends", pushStalled(w, { x: 0, y: 0 }, 30, false), false);
  let stuck = false;
  for (let t = 32; t <= 60; t += 2) stuck = pushStalled(w, { x: 0, y: 0 }, t, false);
  check("…and then runs", stuck, true);
}

// ==========================================================================================
console.log("\n-- a camp it could not get to is left alone for a while -------------------");
// ==========================================================================================

// `CAMP_SHUN` (120 s) and `SHUN_MATCH` (200). Without the memory the watchdog is a loop: the
// wave gives up, `massing` asks for the nearest camp it can handle and gets the same one back.
const SHUN = [{ x: 1000, y: 1000, until: 120 }];
check("the camp it gave up on is not offered again", isShunned(SHUN, { x: 1000, y: 1000 }, 30), true);
check("…nor is the same camp under a little arithmetic drift",
  isShunned(SHUN, { x: 1050, y: 1050 }, 30), true);
check("its NEIGHBOUR still is offered", isShunned(SHUN, { x: 1000, y: 1700 }, 30), false);
check("and it comes back once the shun expires", isShunned(SHUN, { x: 1000, y: 1000 }, 121), false);
check("nothing is shunned by an empty list", isShunned([], { x: 1000, y: 1000 }, 30), false);

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
