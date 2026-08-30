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
//      learnt about the map. Two halves of that were still missing after the first fix and are
//      pinned here too: a camp is a CLUSTER, so the berth has to clear its flanks and not merely
//      its centroid; and the tour's later legs are GOLD MINES, which every melee map guards, so
//      a goal sitting inside a camp has to be STOOD OFF rather than declared "not on the way".
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
const { safeLeg, backOffSpot, onGoldDuty, pushStalled, isShunned, pullBackSpot, pullDue, pulledOut } = require(join(REPO, ".sim-build", "src", "ai", "plus", "index.js"));
const { PLUS_EASY, PLUS_NORMAL, PLUS_INSANE } = require(join(REPO, ".sim-build", "src", "ai", "plus", "profile.js"));

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
// …and the fourth, which is why the GREEN bar had to come down: the undead's soldier is also its
// lumberjack and it is the weakest body of the four (UnitBalance `realHP` 340, UnitWeapons 13
// damage over a 1.3-second cooldown).
const GHOUL = { dps: 10, hp: 340, maxHp: 340 };
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
// …and an OPENING PARTY of the smaller bodies takes one too, which is the whole of the reported
// "it sits in its base instead of creeping": at the old bar of 150 neither of these cleared it,
// so every race stood at home waiting for a fourth soldier and the undead — whose soldier is the
// weakest body in the game — waited longest. `PlusProfile.creepFood` (10 on Normal) calls each
// of these a party, and the two gates have to agree.
check("hero + three footmen takes a green camp", canClearCamp(force(n(FOOTMAN, 3), 1), GREEN), true);
check("…and hero + three ghouls, the undead's own opening", canClearCamp(force(n(GHOUL, 3), 1), GREEN), true);
check("…but hero + two ghouls is still not a party", canClearCamp(force(n(GHOUL, 2), 1), GREEN), false);

// ORANGE: "about four of those units with the hero" — and this is the bar that was RAISED,
// because the AI was walking into orange camps with parties that had no chance.
check("hero + two grunts does NOT take an orange camp", canClearCamp(force(n(GRUNT, 2), 1), ORANGE), false);
check("four grunts and a level-3 hero does", canClearCamp(force(n(GRUNT, 4), 3), ORANGE), true);
check("…but not on a level-1 hero", canClearCamp(force(n(GRUNT, 4), 1), ORANGE), false);
// …and the ORANGE bar did NOT move when the green one did: it is what "the AI attacks orange
// camps with very weak armies" raised, and lowering green does not touch the party an orange
// camp asks for. The ladder out of green is the hero's own levels.
check("…nor on a level-2 one, however the green bar moved", canClearCamp(force(n(GRUNT, 4), 2), ORANGE), false);
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

// A CAMP IS A CLUSTER, and this is the half that was missing. `safeLeg` is handed every live
// creep rather than the camp's centroid (see ComputerPlusAi.safeStep), because linking guard
// posts up to CAMP_LINK (600) apart makes a six-creep camp 1200 across: a 900 berth around the
// CENTRE walks the scout 300 from the creep on the near edge, which is inside AcquisitionRange
// and one CreepCallForHelp shout from the whole camp. The detour has to clear the FLANKS too.
const SPREAD = [
  { x: 0, y: -600 }, { x: 0, y: -200 }, { x: 0, y: 200 }, { x: 0, y: 600 },
  { x: 400, y: 0 }, { x: -400, y: 0 },
];
const wide = safeLeg(HOME, BASE, SPREAD);
let closest = Infinity;
for (const c of SPREAD) closest = Math.min(closest, nearest(wide, c));
check("a spread-out camp is cleared by the berth, flanks and all", closest >= 900, true);

// THE DESTINATION ITSELF INSIDE A CAMP — every melee map's gold mines are guarded, and the
// tour's later legs ARE gold mines. The old routine only looked at camps the line ran PAST, so
// it walked the scout to the middle of the one sitting on the mine.
const ON_TARGET = [{ x: 3000, y: 0 }];
const off = safeLeg(HOME, BASE, ON_TARGET);
check("a camp sitting ON the waypoint is stood off, not walked into",
  Math.hypot(off.x - ON_TARGET[0].x, off.y - ON_TARGET[0].y) >= 900, true);
check("…and the stand-off is on the way there, not off to one side", off.y, 0);
check("…and it is as close as the berth allows", Math.round(off.x), 2100);

// A creep already on top of us cannot be avoided by any waypoint, and must not cancel the
// detour round the one ahead — every candidate would score equally badly and the scout would
// walk straight on into the camp it CAN still go round.
const ATFOOT = [{ x: -3000, y: 200 }, ON_THE_LINE];
const away = safeLeg(HOME, BASE, ATFOOT);
check("a creep at our feet does not cancel the detour round the next one",
  nearest(away, ON_THE_LINE) >= 900, true);

// BACKING OUT OF A CAMP THE SCOUT IS ALREADY INSIDE (plus/index.ts `backOffSpot`). `safeLeg`
// deliberately drops creeps that are within the berth of where the scout STANDS — no waypoint
// avoids them, and leaving them in scores every candidate equally badly — so the step it hands
// back is computed as though they were not there, and the scout walks straight on into them.
// That is the Wisp that hugged a camp and died on the way home, and the hole is on every leg.
const HOMEP = { x: -3000, y: -3000 };
function farther(spot, c) { return Math.hypot(spot.x - c.x, spot.y - c.y); }

check("nothing inside the bar is nothing to walk out of",
  backOffSpot({ x: 0, y: 0 }, [{ x: 2000, y: 0 }], HOMEP), null);
// The two bars are deliberately different numbers: it backs off under CREEP_PASS (750) and comes
// out beyond CREEP_BERTH (900), which is the hysteresis that stops it stepping out of routes it
// was just given — and is also what puts the camp back inside `safeLeg`'s own view, since that
// drops creeps within the BERTH of where the scout stands from its detour.
check("a graze of the berth is not an emergency",
  backOffSpot({ x: 0, y: 0 }, [{ x: 800, y: 0 }], HOMEP), null);
{
  const c = { x: 500, y: 0 };
  const out = backOffSpot({ x: 0, y: 0 }, [c], HOMEP);
  check("a creep 500 away is walked away from", out !== null, true);
  check("…out past the BERTH, not merely past the bar it tripped", farther(out, c) >= 950 - 1, true);
  check("…and directly away from it, not round it", Math.round(out.y), 0);
}
{
  // TWO MEMBERS OF ONE CAMP, which is the shape that actually occurs — `CreepCamps` links guard
  // posts up to CAMP_LINK (600) apart, so a scout that has walked up to a camp is inside the
  // berth of two or three of them at once. The POOLED bearing is one direction away from all of
  // them; "the nearest one" would alternate between their answers every pass and go nowhere.
  const a = { x: 500, y: 300 };
  const b2 = { x: 500, y: -300 };
  const out = backOffSpot({ x: 0, y: 0 }, [a, b2], HOMEP);
  check("two creeps of one camp are stepped away from on one bearing", out !== null, true);
  check("…further from the first than it was", farther(out, a) > Math.hypot(500, 300), true);
  check("…and further from the second too", farther(out, b2) > Math.hypot(500, 300), true);
  check("…straight back down the middle", Math.round(out.y), 0);
}
{
  // Surrounded: the pool cancels, so there is no "away" to name and it takes the way home.
  const ring = [{ x: 400, y: 0 }, { x: -400, y: 0 }, { x: 0, y: 400 }, { x: 0, y: -400 }];
  const out = backOffSpot({ x: 0, y: 0 }, ring, HOMEP);
  check("surrounded, it walks the way home rather than standing still", out !== null, true);
  check("…on the bearing of home", out.x < 0 && out.y < 0, true);
  check("…and it is a real point", Number.isFinite(out.x) && Number.isFinite(out.y), true);
}
check("a creep stood exactly on us cannot produce a NaN",
  Number.isFinite(backOffSpot({ x: 0, y: 0 }, [{ x: 0, y: 0 }], HOMEP).x), true);

// ASKED TWICE. `safeLeg` returns its BEST attempt rather than a guarantee, and against the wide
// berth "best" is under the berth surprisingly often — so the scout asks again for the clearance
// that actually matters (CREEP_PASS) rather than treating the wide arc's failure as "no route".
// A corridor between two camps is the shape: too narrow to keep 900 from both, wide open at 750.
{
  // A picket rather than a lone camp, so that swinging wider is no answer either — 1600 apart,
  // which leaves 800 of clearance at every gap in it and nowhere at all that keeps 900.
  const PICKET = [-4000, -2400, -800, 800, 2400, 4000].map((y) => ({ x: 0, y }));
  const worst = (leg) => Math.min(...PICKET.map((c) => nearest(leg, c)));
  const wide = safeLeg(HOME, BASE, PICKET);        // 900: not available anywhere on the line
  const pass = safeLeg(HOME, BASE, PICKET, 750);   // 750: straight through the middle gap
  check("a picket 1600 apart cannot be crossed keeping 900", worst(wide) < 900, true);
  check("…but asking for 750 crosses it", Math.round(pass.x), BASE.x);
  check("…through the gap", Math.round(pass.y), 0);
  check("…and that leg really does keep 750", worst(pass) >= 750, true);
}

// AND A WAYPOINT HAS TO BE SOMEWHERE THE SCOUT COULD STAND. The perpendicular `safeLeg` prefers
// is chosen by which side the CREEP is on, which says nothing about which side is MAP — so beside
// a camp pinned against the world's edge it threw the arc clean off it, and the pathfinder, aimed
// at a point it cannot reach, walked the unit at the nearest thing it can: the strip of ground
// the camp is standing on. (The Wisp that walked into a boundary camp on its way home instead of
// at its own Tree of Life.) The map's own answer is handed in, and a rejected arc is simply not a
// candidate.
{
  const NORTH_IS_OFF_MAP = (x, y) => y <= 0;
  const round2 = safeLeg(HOME, BASE, [ON_THE_LINE], undefined, undefined, NORTH_IS_OFF_MAP);
  check("the arc is thrown to the side that is on the map", round2.y <= 0, true);
  check("…and it still clears the camp", nearest(round2, ON_THE_LINE) > 800, true);
  // With NO arc standable the straight line stands: the pathfinder is a great deal better at
  // going round a cliff than a perpendicular is, and a reachable goal is what it needs.
  const none = safeLeg(HOME, BASE, [ON_THE_LINE], undefined, undefined, () => false);
  check("with nowhere to throw it, the straight line stands", none.x, BASE.x);
}
{
  // The back-off sweeps for a bearing that is on the map, for the same reason.
  const c = { x: 500, y: 0 };
  const WALL_TO_THE_WEST = (x) => x > -100;
  const out = backOffSpot({ x: 0, y: 0 }, [c], HOMEP, undefined, WALL_TO_THE_WEST);
  check("backed into a wall, it turns rather than walking at it", out !== null, true);
  check("…to a bearing that is on the map", out.x > -100, true);
  check("…and the turned bearing is still a back-off", farther(out, c) > 500, true);
  check("with no bearing at all it gives up rather than ordering a walk into a wall",
    backOffSpot({ x: 0, y: 0 }, [c], HOMEP, undefined, () => false), null);
}

console.log("\n-- who is sent to go and look ------------------------------------------------");

// WHO THE SCOUT IS (plus/index.ts `freeWorker`, via `onGoldDuty`). The spare worker first, then
// a lumberjack, and the gold crew last — a preference, not a filter, since a player with nothing
// but miners still sends one. `isOffField` used to be the whole of it, which works by accident on
// three races (their gold workers are literally inside something) and fails completely on the
// fourth: an Acolyte kneels in the OPEN around a Haunted Gold Mine, so the first Acolyte in
// iteration order — a member of the crew of five — was the scout, every undead game, while the
// SIXTH Acolyte the build ladder trains for exactly this job stood in the base all match.
check("an Acolyte holding a mark in a Haunted mine's ring is on gold",
  onGoldDuty({ ringSlot: 3 }), true);
check("…and the spare Acolyte beside it is not", onGoldDuty({ ringSlot: 0 }), false);
check("a worker walking to a mine is on gold before it arrives",
  onGoldDuty({ order: "harvest", resKind: "gold" }), true);
check("a worker down a shaft is on gold", onGoldDuty({ inMineId: 7 }), true);
check("a lumberjack is not", onGoldDuty({ order: "harvest", resKind: "lumber" }), false);
check("and neither is an idle worker", onGoldDuty({ order: "stop", resKind: null }), false);

console.log("\n-- the wounded walk out of the fight ------------------------------------------");

// THE PULL-BACK (plus/index.ts `pullPass`). A unit on its last quarter steps out of the line,
// stays out on a clock of its own, and goes back in — and the whole rule stands or falls on the
// SECOND half of that: a soldier released at a hair under the bar wants pulling again on the
// very next pass, and a rule with no memory is a unit that walks in and out of the battle
// instead of fighting in it. None of these numbers are Warcraft III's (see the file header).

// Easy does not do this at all — issue #124's easy computer gives an order and watches it happen.
check("easy never pulls a unit out", pullDue(undefined, 0.05, PLUS_EASY.pullOutHp, 100), false);
check("normal pulls one out at a quarter health", pullDue(undefined, 0.2, PLUS_NORMAL.pullOutHp, 100), true);
check("insane too", pullDue(undefined, 0.2, PLUS_INSANE.pullOutHp, 100), true);
check("…but not a unit that is merely scratched", pullDue(undefined, 0.5, PLUS_NORMAL.pullOutHp, 100), false);

// The see-saw guard, end to end: pulled at t=100, out until 110, and not pullable again until
// 145 however hurt it is when it rejoins.
const entry = { x: 0, y: 0, until: 110, next: 145 };
check("while it is out, it is OUT (commit and squadFood skip it)", pulledOut(entry, 105), true);
check("…and it rejoins when the hold expires", pulledOut(entry, 111), false);
check("it is not pulled again the instant it rejoins", pullDue(entry, 0.1, 0.25, 111), false);
check("…nor while it is still out", pullDue(entry, 0.1, 0.25, 105), false);
check("…and it may be, once its own cooldown is up", pullDue(entry, 0.1, 0.25, 146), true);

// WHERE it goes: behind the army, away from what is hitting it — and a screen away rather than
// a step ("around 800-1000", the developer's own distance).
const ENEMY = { x: 1000, y: 0 };
const LINE = { x: 0, y: 0 };      // the army's anchor, standing in the fight
const AHEAD = { x: 300, y: 0 };   // …and the wounded soldier, out in front of it
const back = pullBackSpot(AHEAD, ENEMY, LINE);
check("the spot is on the far side of the army from the enemy", back.x < LINE.x, true);
check("…a screen behind it", Math.round(Math.hypot(back.x - LINE.x, back.y - LINE.y)), 900);
check("…which is further still from the enemy", Math.round(Math.hypot(back.x - ENEMY.x, back.y - ENEMY.y)), 1900);

// Measured from the ARMY rather than from the unit's feet: a straggler already at the back does
// not walk another nine hundred units, and one out in front walks all the way past the line.
const BEHIND = { x: -800, y: 0 };
check("a unit already behind the line is sent to the same spot as one in front of it",
  Math.round(pullBackSpot(BEHIND, ENEMY, LINE).x), Math.round(back.x));

// …and with no army left to stand behind, it backs off its own line instead.
const alone = pullBackSpot(AHEAD, ENEMY, null);
check("with no army, it backs away from the enemy on its own line", Math.round(alone.x), -600);
check("a degenerate anchor cannot produce a NaN destination",
  Number.isFinite(pullBackSpot(ENEMY, ENEMY, ENEMY).x), true);

console.log(failed ? `\n${failed} FAILED\n` : "\nall ok\n");
process.exit(failed ? 1 : 0);
