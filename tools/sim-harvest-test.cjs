// Headless check that GOLD MINING is a round trip and not a standing wave (issue #89).
//
// The bug this pins down: a worker emerged from the mine onto a point projected on a
// CIRCLE of the mine's radius. The mine's pathing footprint is a SQUARE of that half-
// extent, so on any diagonal the emerge point was INSIDE the footprint, and even on an
// axis it was flush against the rim — where the worker's own 2×2 clearance does not fit.
// Every pathTo from there failed, so the worker never walked again. It stayed invisible
// because arriveAtNode counted "not moving" as "arrived": the frozen worker went on
// banking 10 gold a second from the rim, so the income looked healthy while a clump of
// peasants stood at the mine forever.
//
// Hence the two assertions per geometry: workers must COVER GROUND proportional to the
// gold they bank, and the income must not exceed what the mine can physically issue.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const CELL = 32;
const MINE = [2560, 2560]; // cell-aligned, like a build-grid-snapped mine
const MINE_R = 128; // half-extent of 16x16Goldmine.tga's BLOCKED core (mapViewer sizes it so)
const HALL_R = 128;
const HALL_DIST = 900;
const GOLD_PER_TRIP = 10;
const MINE_TIME = 1.0; // Agld "Mining Duration" — the mine issues at most one load a second

/** A mine + town hall `angle` degrees apart, `n` peasants ordered onto the mine.
 *  `bonus` is `setHarvestBonus`'s factor — 2 is an insane computer (src/ai/ids.ts). */
function harvestRun(angleDeg, n, seconds, bonus = 1, hook = null) {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const a = (angleDeg * Math.PI) / 180;
  const hall = [Math.round((MINE[0] + Math.cos(a) * HALL_DIST) / CELL) * CELL, Math.round((MINE[1] + Math.sin(a) * HALL_DIST) / CELL) * CELL];
  // Both structures block their footprint, exactly as stampMapPathing does in game.
  for (const [cx, cy, half] of [[MINE[0], MINE[1], MINE_R], [hall[0], hall[1], HALL_R]]) {
    const cells = (half * 2) / CELL;
    const [x0, y0] = [Math.round((cx - half) / CELL), Math.round((cy - half) / CELL)];
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) grid.block(x0 + i, y0 + j);
  }

  const world = new SimWorld(grid, 1);
  const mine = world.addMine(MINE[0], MINE[1], 125000, MINE_R);
  world.add(
    {
      id: 100, owner: 0, team: 0, typeId: "htow", x: hall[0], y: hall[1], facing: 0,
      hp: 1500, maxHp: 1500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: HALL_R, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 72, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Town Hall", worker: null, depotGold: true, depotLumber: true,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: hall[0], rallyY: hall[1], rallyKind: "point", rallyTargetId: 0, producesUnits: true },
  );

  if (bonus !== 1) world.setHarvestBonus(0, bonus);

  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = 1 + i;
    world.add({
      id, owner: 0, team: 0, typeId: "hpea",
      x: hall[0] - Math.cos(a) * 200, y: hall[1] - Math.sin(a) * 200 - 160 + i * 80, facing: 0,
      hp: 220, maxHp: 220, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 190, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
      sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
      deathTime: 2, name: "Peasant", castPoint: 0, castBackswing: 0,
      worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, carryGold: 0, carryLumber: 0 },
      depotGold: false, depotLumber: false, isPeon: true,
    });
    ids.push(id);
    if (!world.issueHarvest(id, "gold", mine.id)) throw new Error(`issueHarvest refused for ${id}`);
  }

  const DT = 1 / 30;
  const walked = new Map(ids.map((id) => [id, 0]));
  for (let t = 0; t < seconds / DT; t++) {
    const was = ids.map((id) => [world.units.get(id).x, world.units.get(id).y]);
    if (hook) hook(world, mine, t * DT);
    world.tick(DT);
    ids.forEach((id, i) => {
      const u = world.units.get(id);
      walked.set(id, walked.get(id) + Math.hypot(u.x - was[i][0], u.y - was[i][1]));
    });
  }
  return { gold: world.stashOf(0).gold, mined: 125000 - mine.gold, walked, hall, seconds };
}

// The mine→hall gap the loads have to cross. Both ends stop at their footprint's edge, so
// the walk is shorter than the centre-to-centre distance — this is the floor, not the mean.
const LEG = HALL_DIST - MINE_R - HALL_R;

console.log("gold mining is a round trip, whatever side of the mine the hall is on");
for (const angle of [0, 30, 45, 135, 200, 315]) {
  const { gold, walked } = harvestRun(angle, 5, 120);
  const trips = gold / GOLD_PER_TRIP;
  const total = [...walked.values()].reduce((a, b) => a + b, 0);
  // Every load banked is one mine→hall→mine round trip somebody had to walk, i.e. TWO legs.
  // Asking for one is a floor with all the slack a corner-cutting worker could want — the
  // frozen case banked ~1/8 of it, so a failure here is never a near miss.
  check(`hall ${angle}° — ${trips} loads banked were actually carried`, total > trips * LEG, `walked ${total.toFixed(0)}, ${trips} loads`);
  const share = (trips / walked.size) * LEG; // …and no ONE worker may coast on the others
  const idle = [...walked.entries()].filter(([, d]) => d < share).map(([id]) => id);
  check(`hall ${angle}° — every worker carried its own share`, idle.length === 0, idle.length ? `stood still: ${idle.join(",")}` : `min ${Math.min(...walked.values()).toFixed(0)} of ${share.toFixed(0)} units`);
}

console.log("\nthe mine is the bottleneck, not the pathing (Agld Mining Capacity = 1)");
{
  // Twelve workers on one mine: the queue at the rim is WC3-correct, but it must be a
  // queue of walkers. The ceiling is the mine's own one-load-a-second occupancy.
  const seconds = 120;
  const { gold, walked } = harvestRun(45, 12, seconds);
  const ceiling = (seconds / MINE_TIME) * GOLD_PER_TRIP;
  check("12 workers cannot out-earn the mine's issue rate", gold <= ceiling, `${gold} <= ${ceiling}`);
  const share = (gold / GOLD_PER_TRIP / walked.size) * LEG;
  check("…and every one of them still walks", Math.min(...walked.values()) > share, `min ${Math.min(...walked.values()).toFixed(0)} of ${share.toFixed(0)} units`);
}

console.log("\nan INSANE computer is paid double for the same digging (docs/melee-ai.md)");
{
  // The one thing MELEE_INSANE gets that is not in common.ai — it never tests for the
  // constant it declares. The doubling is on the CREDIT, so the same run must take the same
  // gold OUT of the mine and put twice as much in the bank.
  const plain = harvestRun(45, 5, 60);
  const insane = harvestRun(45, 5, 60, 2);
  check("the same five workers bank twice as much", insane.gold === plain.gold * 2, `${insane.gold} vs ${plain.gold}`);
  check("…having taken exactly the same gold out of the mine", insane.mined === plain.mined, `${insane.mined} vs ${plain.mined}`);
  check("…so the mine runs dry on everybody's schedule", insane.mined < insane.gold, `mined ${insane.mined}, banked ${insane.gold}`);
  const normal = harvestRun(45, 5, 60, 1);
  check("everyone else is paid the flat rate", normal.gold === plain.gold, `${normal.gold} vs ${plain.gold}`);
}

// --- one pair of hands, one load ------------------------------------------------------
//
// A worker that takes up a load drops whatever else it was holding. The old sack kept both,
// so a Peasant sent to the mine with four lumber on its back delivered gold AND lumber at the
// hall out of one visit to one node.

/** A bare world with a mine, a tree and one worker — no round trips, just the loads. */
function loadWorld() {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  // Stub registries, so the burrow below has a cargo hold to be recognised BY: the Orc
  // Burrow's `abilList` carries `Abun` "Burrow" and its Dataa1 is the seat count.
  const ABILS = { Abun: { code: "Abun", levelData: [{ castRange: 0, area: 0, duration: 0, data: [4] }] } };
  const UNITS = { otrb: { abilities: ["Abtl", "Abun", "Astd"] } };
  const world = new SimWorld(grid, 1, { get: (id) => ABILS[id] }, undefined, { get: (id) => UNITS[id] });
  const mine = world.addMine(MINE[0], MINE[1], 125000, MINE_R);
  const tree = world.addTree(MINE[0] + 600, MINE[1], 500);
  world.add(
    {
      id: 100, owner: 0, team: 0, typeId: "htow", x: MINE[0], y: MINE[1] + HALL_DIST, facing: 0,
      hp: 1500, maxHp: 1500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: HALL_R, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 72, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Town Hall", worker: null, depotGold: true, depotLumber: true,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: MINE[0], rallyY: MINE[1], rallyKind: "point", rallyTargetId: 0, producesUnits: true },
  );
  world.add({
    id: 1, owner: 0, team: 0, typeId: "hpea", x: MINE[0], y: MINE[1] + 400, facing: 0,
    hp: 220, maxHp: 220, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 190, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: "Peasant", castPoint: 0, castBackswing: 0,
    worker: { gold: true, lumber: true, harvestAbility: "Ahar", lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1.1, goldPerTrip: GOLD_PER_TRIP, damagesTree: true, carryGold: 0, carryLumber: 0 },
    depotGold: false, depotLumber: false, isPeon: true,
  });
  return { world, mine, tree, worker: world.units.get(1) };
}

/** Run the world until `done()` or the clock runs out. Returns whether it happened. */
function runUntil(world, done, seconds = 90) {
  const DT = 1 / 30;
  for (let t = 0; t < seconds / DT; t++) {
    world.tick(DT);
    if (done()) return true;
  }
  return false;
}

console.log("\na worker's hands hold one thing at a time");
{
  const { world, mine, worker } = loadWorld();
  worker.worker.carryLumber = 5; // it was on the trees when the mine order came
  world.issueHarvest(worker.id, "gold", mine.id);
  const gotGold = runUntil(world, () => worker.worker.carryGold > 0);
  check("a worker that went in with lumber comes out with gold", gotGold && worker.worker.carryGold === GOLD_PER_TRIP, `${worker.worker.carryGold} gold`);
  check("…and the lumber is gone, not banked with it", worker.worker.carryLumber === 0, `${worker.worker.carryLumber} lumber`);
}
{
  const { world, tree, worker } = loadWorld();
  worker.worker.carryGold = GOLD_PER_TRIP; // pulled off the mine with a load still in hand
  world.issueHarvest(worker.id, "lumber", tree.id);
  const chopped = runUntil(world, () => worker.worker.carryLumber > 0);
  check("a worker carrying gold that starts chopping gets lumber", chopped, `${worker.worker.carryLumber} lumber`);
  check("…and drops the gold on the first chop", worker.worker.carryGold === 0, `${worker.worker.carryGold} gold`);
}

// --- Stand Down means back to WORK ----------------------------------------------------
//
// CommandStrings for `Astd`: "Causes Peons within the Burrow to return to work." Battle
// Stations is an interruption, not a re-assignment, so the job has to survive the boarding
// (SimUnit.garrisonJob) — nothing else remembers it, since climbing in cancels the order.
console.log("\nStand Down returns the crew to the job it was pulled off");
{
  const { world, mine, worker } = loadWorld();
  world.add(
    {
      id: 200, owner: 0, team: 0, typeId: "otrb", x: MINE[0] + 300, y: MINE[1] + 400, facing: 0,
      hp: 600, maxHp: 600, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0, radius: 72, scale: 1, armor: 2, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 900, nsight: 600, baseSight: 900,
      sightDay: 900, sightNight: 600, flying: false, mechanical: false, invulnerable: false,
      race: "orc", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 72, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Orc Burrow", worker: null, depotGold: false, depotLumber: false,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: MINE[0], rallyY: MINE[1], rallyKind: "point", rallyTargetId: 0, producesUnits: false },
  );
  const burrow = world.units.get(200);
  check("the burrow's hold is its `Abun` Dataa1", burrow.garrisonCap === 4, `cap ${burrow.garrisonCap}`);

  world.issueHarvest(worker.id, "gold", mine.id);
  runUntil(world, () => worker.order === "harvest" && !worker.moving, 30);
  world.issueGarrison(worker.id, burrow.id);
  const boarded = runUntil(world, () => worker.inBurrow, 60);
  check("a peon at work climbs into the burrow", boarded, `order ${worker.order}`);
  const job = worker.garrisonJob;
  check("…and its job goes in with it", !!job && job.kind === "harvest" && job.res === "gold" && job.nodeId === mine.id, JSON.stringify(job));

  check("Stand Down empties the burrow", world.unloadBurrow(burrow.id, true), "");
  check("…and puts the peon back on the mine", worker.order === "harvest" && worker.resKind === "gold" && worker.resId === mine.id, `order ${worker.order}, node ${worker.resId}`);
  check("…spending the memory as it goes", worker.garrisonJob === null, `${JSON.stringify(worker.garrisonJob)}`);

  // …and every other way out of a hold is not a command and promises nothing.
  world.issueGarrison(worker.id, burrow.id);
  runUntil(world, () => worker.inBurrow, 60);
  world.unloadBurrow(burrow.id);
  check("a plain unload leaves them standing", worker.order === "idle", `order ${worker.order}`);
}

// A worker whose way home closes behind it must RE-DECIDE, not grind.
//
// The bug: `pathTo` reports failure by returning false — it does not stand the unit down,
// because most callers want to decide that themselves. checkStuck's gatherer branch asked for
// a reroute and then ignored the answer, so a worker whose reroute came back empty was left
// with `moving` still true and last tick's dead path still on it. It walked into the
// obstruction for ever: `arriveAtNode` will not let a MOVING unit short of its goal deposit,
// and checkStuck ran the same failing search twice a second from then on. Nothing in the loop
// could end it — which is why it reads as a freeze rather than a stumble, and why it was
// reported on the RETURN leg, which ends in the tightest crowd on the map.
console.log("\na worker whose way home is shut re-decides instead of grinding");
{
  const { world, worker } = loadWorld();
  worker.worker.carryLumber = 10;
  worker.order = "return";
  worker.atNode = false;
  // Let it get right up to where the way is about to close. The wall has to go up while the
  // worker is mid-STEP toward it: further back and the route it is already on simply runs out
  // against the obstruction, which the movement tail already handles (`settle`). It is the
  // step that is REFUSED — the one the reroute is asked to replace and cannot — that had
  // nothing behind it.
  check("it sets off for the hall", runUntil(world, () => worker.y > 3160, 5), `order ${worker.order}, y ${worker.y.toFixed(0)}`);
  // Now shut the way: a wall across the whole map between the worker and the depot, which is
  // the extreme of the crowd that shuts it in a real game — every reroute from here fails.
  for (let cx = 0; cx < 160; cx++) { world.grid.block(cx, 100); world.grid.block(cx, 101); }
  const freed = runUntil(world, () => !worker.moving, 6);
  check("…and stops walking a path that goes nowhere", freed, `still moving after 6s, order ${worker.order}`);
  check("…without being sacked mid-job", worker.order === "return" || world.stashOf(0).lumber === 10, `order ${worker.order}, banked ${world.stashOf(0).lumber}`);
}

// --- the mine's latch cannot be wedged shut -------------------------------------------
//
// `SimMine.busy` is the one-worker-at-a-time latch (Agld Mining Capacity 1), and it is cleared
// by the emerge branch of the worker holding it. Anything that took that worker off its harvest
// WITHOUT the emerge — a Stop that did not come through issueOrder, a teleport, a path that
// forgot popFromMine — left it set for ever, and the rest of the crew then parked at the
// entrance "waiting its turn" for the rest of the match: standing in the mine→hall line, mining
// nothing. Reported from a Computer+ human's base. Now the latch names its holder (`busyBy`), a
// parked miner verifies the holder is still inside before it waits (mineLatchStale), and both
// Stop and teleportUnit pop a worker out of the shaft first.
console.log("\nthe mine's latch cannot be wedged shut");
{
  // A latch held by NOBODY — the state every forgotten pop left behind.
  let before = 0;
  const { gold } = harvestRun(45, 5, 70, 1, (world, mine, t) => {
    if (Math.abs(t - 10) < 1e-6) {
      before = world.stashOf(0).gold;
      mine.busy = true;
      mine.busyBy = 9999; // no such unit
    }
  });
  check("a latch held by nobody is freed and the crew keeps mining", gold - before > 30 * GOLD_PER_TRIP, `${(gold - before) / GOLD_PER_TRIP} loads in the 60 s after the wedge`);
}
{
  // A worker STOPPED mid-shaft (an Amulet of Recall's pull is the stock way): it comes out onto
  // the field, the latch is released with it, and the crew goes on.
  let stopped = null;
  let atStop = null;
  let before = 0;
  const { gold } = harvestRun(45, 5, 70, 1, (world, mine, t) => {
    if (t >= 10 && stopped === null) {
      for (const u of world.units.values()) if (u.inMine) { stopped = u; break; }
      if (!stopped) return;
      before = world.stashOf(0).gold;
      world.stop(stopped.id);
      atStop = { inMine: stopped.inMine, order: stopped.order, busy: mine.busy, busyBy: mine.busyBy };
    }
  });
  check("a worker stopped mid-shaft is on the field, idle", atStop && !atStop.inMine && atStop.order === "idle", JSON.stringify(atStop));
  check("…and the latch went with it", atStop && !atStop.busy && atStop.busyBy === 0, JSON.stringify(atStop));
  check("…so the other four keep mining", gold - before > 25 * GOLD_PER_TRIP, `${(gold - before) / GOLD_PER_TRIP} loads in the 60 s after the stop`);
}

// --- the GOBLIN SHREDDER gathers at its OWN rate ---------------------------------------
//
// `ngir`'s whole abilList is `Ahr3` "Harvest Lumber (shredder)" — an ALIAS of `Ahrl`, so it
// takes the Ghoul's worker profile (lumber only, no gold, the tree falls). What it must NOT
// take is the Ghoul's numbers: one base code ships three rate cards in AbilityData.slk, and
// the shredder's is five times the Ghoul's.
//
//     Ahrl  DataA  2  DataB  20  Dur1 1.35   the Ghoul
//     Ahr2  DataA  5  DataB  50  Dur1 1.35   the campaign Arch Ghoul
//     Ahr3  DataA 10  DataB 200  Dur1 1.35   the Goblin Shredder
//
// Ten a swing is the wiki's own description ("gathers 10 wood at a time … cuts a healthy tree
// down in 5 swings") and it is what the shredder's second WEAPON does to a tree as well
// (`ngir` targs2 = tree, 10 damage, cooldown 1.35), so the two halves of the data agree.
console.log("\nthe Goblin Shredder gathers off its own harvest row, not the Ghoul's");
{
  const { harvestAbilityOf } = require(join(REPO, ".sim-build", "src", "data", "races.js"));
  const abil = (id, code) => ({ id, code, level: 1, cooldownLeft: 0, autocastOn: false });
  check("harvestAbilityOf picks the alias a unit actually carries",
    harvestAbilityOf([abil("Ahr3", "Ahrl")]) === "Ahr3", `${harvestAbilityOf([abil("Ahr3", "Ahrl")])}`);
  check("…and a Peasant's is still `Ahar`",
    harvestAbilityOf([abil("Ahar", "Ahar"), abil("Ahrp", "Ahrp")]) === "Ahar", `${harvestAbilityOf([abil("Ahar", "Ahar")])}`);
  check("…and a unit with no harvest row has none",
    harvestAbilityOf([abil("AHtb", "AHtb")]) === null, `${harvestAbilityOf([abil("AHtb", "AHtb")])}`);

  // AbilityData.slk's two rows, verbatim: DataA lumber per swing, DataB the load, Dur1 the beat.
  const D9 = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
  const ROW = {
    Ahrl: { code: "Ahrl", levelData: [{ castRange: 116, area: 900, duration: 1.35, data: D9(2, 20) }] },
    Ahr3: { code: "Ahrl", levelData: [{ castRange: 116, area: 900, duration: 1.35, data: D9(10, 200) }] },
  };
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const world = new SimWorld(grid, 1, { get: (id) => ROW[id] });
  const tree = world.addTree(2560, 2560, undefined, 0); // a standard 50-lumber trunk
  // Both are built with the GHOUL's numbers as their fallbacks, exactly as the profile hands
  // them over: what separates them is only which row `harvestAbility` names.
  const gatherer = (id, harvestAbility, x) => world.add({
    id, owner: 0, team: 0, typeId: id === 1 ? "ngir" : "ugho", x, y: 2560, facing: 0,
    hp: 600, maxHp: 600, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.5, radius: 24, scale: 1, armor: 3, armorType: "heavy", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: true, invulnerable: false,
    race: "creeps", isBuilding: false, foodCost: 4, goldCost: 375, lumberCost: 100,
    abilities: [{ id: harvestAbility, code: "Ahrl", level: 1, cooldownLeft: 0, autocastOn: false }],
    upgrades: [], moveType: "foot", collisionSize: 24, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: "Goblin Shredder", castPoint: 0.3, castBackswing: 0.6,
    worker: { gold: false, lumber: true, harvestAbility, lumberCapacity: 20, baseLumberCapacity: 20,
      lumberPerChop: 2, chopPeriod: 1.35, goldPerTrip: 0, damagesTree: true, deliversInPlace: false,
      minesInRing: false, carryGold: 0, carryLumber: 0 },
    depotGold: false, depotLumber: false, isPeon: false,
  });
  const shred = gatherer(1, "Ahr3", 2400);
  const ghoul = gatherer(2, "Ahrl", 2700);
  check("the shredder's load is its own row's 200", shred.worker.lumberCapacity === 200, `${shred.worker.lumberCapacity}`);
  check("…and its swing its own row's 10", shred.worker.lumberPerChop === 10, `${shred.worker.lumberPerChop}`);
  check("…while the Ghoul beside it still carries 20", ghoul.worker.lumberCapacity === 20, `${ghoul.worker.lumberCapacity}`);
  check("…two at a time", ghoul.worker.lumberPerChop === 2, `${ghoul.worker.lumberPerChop}`);
  check("…and both keep the row's 1.35 s beat", shred.worker.chopPeriod === 1.35 && ghoul.worker.chopPeriod === 1.35,
    `${shred.worker.chopPeriod} / ${ghoul.worker.chopPeriod}`);

  // Five swings to fell a 50-lumber trunk, and nothing hauled yet: 50 is a quarter of the load.
  world.issueHarvest(shred.id, "lumber", tree.id);
  const felled = runUntil(world, () => !world.trees.has(tree.id), 60);
  check("it fells a standard tree", felled, "still standing after 60 s");
  check("…having taken the whole 50 into its arms, with room to spare",
    shred.worker.carryLumber === 50, `${shred.worker.carryLumber} lumber`);
  check("…so it is still in the forest, not walking a load home", shred.order === "harvest", `order ${shred.order}`);
}

console.log(failed ? `\nharvest: ${failed} check(s) FAILED` : "\nharvest: all checks passed");
process.exit(failed ? 1 : 0);
