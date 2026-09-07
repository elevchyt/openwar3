// Headless check that a computer's GOLD CREW cannot stand still for good.
//
// Reported from a real match: a Computer+ human's miners "had stopped gathering gold altogether
// and were chillin in the worker line" — five peasants in the mine→hall line, every one holding
// a harvest order, banking nothing for the rest of the game. A worker WITH an order is invisible
// to both of the AI's worker passes: `applyHarvest` counts it as already on the job (rightly —
// re-issuing a live crew every pass is the collision bug documented in `alreadyHarvesting`), and
// `workIdleWorkers` can only see a worker whose order is literally "idle". So whatever wedged
// them, nothing above would ever have asked again.
//
// `AiPlayer.kickStalledMines` is the watchdog under both: a mine of ours that has held the same
// gold for MINE_STALL seconds while we have a crew assigned to it has a crew that is not mining,
// and that crew is re-issued through the funnel — the reset a player's click is.
//
// This pins the watchdog on a REAL SimWorld: five peasants mining, frozen mid-walk the way a
// parked walk that never resumed leaves them (no movement, no arrival, a wait that never ends),
// and an AiPlayer whose only tool is the command funnel.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { AiPlayer } = require(join(REPO, ".sim-build", "src", "ai", "aiPlayer.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const CELL = 32;
const MINE = [2560, 2560];
const MINE_R = 128;
const HALL = [2560 + 900, 2560];
const HALL_R = 128;
const GOLD_PER_TRIP = 10;
const N = 5;

function fixture() {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  for (const [cx, cy, half] of [[MINE[0], MINE[1], MINE_R], [HALL[0], HALL[1], HALL_R]]) {
    const cells = (half * 2) / CELL;
    const [x0, y0] = [Math.round((cx - half) / CELL), Math.round((cy - half) / CELL)];
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) grid.block(x0 + i, y0 + j);
  }
  const world = new SimWorld(grid, 1);
  const mine = world.addMine(MINE[0], MINE[1], 125000, MINE_R);
  world.add(
    {
      id: 100, owner: 0, team: 0, typeId: "htow", x: HALL[0], y: HALL[1], facing: 0,
      hp: 1500, maxHp: 1500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: HALL_R, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 72, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Town Hall", worker: null, depotGold: true, depotLumber: true,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: HALL[0], rallyY: HALL[1], rallyKind: "point", rallyTargetId: 0, producesUnits: true },
  );
  const ids = [];
  for (let i = 0; i < N; i++) {
    const id = 1 + i;
    world.add({
      id, owner: 0, team: 0, typeId: "hpea",
      x: HALL[0] - 250, y: HALL[1] - 160 + i * 80, facing: 0,
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
  // The AI, with nothing but the command funnel — every order it gives is the authority's
  // harvest order, exactly as in a match (Authority.applyOrder → SimWorld.issueHarvest).
  const asked = [];
  const host = {
    world,
    registry: { get: () => undefined },
    tech: { get: () => ({ upgrade: [] }), trains: () => [], builds: () => [] },
    upgrades: {},
    execute: (_player, cmd) => {
      asked.push(cmd);
      if (cmd.c === "order" && cmd.order.kind === "harvest") return world.issueHarvest(cmd.unitId, cmd.order.res, cmd.order.nodeId);
      return false;
    },
  };
  const ai = new AiPlayer(0, "human", 1, host, HALL[0], HALL[1], 1);
  return { world, mine, ids, ai, asked };
}

/** Freeze the crew the way a parked walk that never resumed does: standing short of the mine,
 *  not moving, not arrived, and waiting on a countdown that never ends. Anyone down the shaft
 *  is popped first (`stop`), so the whole crew is on the field and the latch is free — this is
 *  a crew that CAN mine and is not. */
function freeze(world, mine, ids) {
  for (const id of ids) {
    const u = world.units.get(id);
    world.stop(id);
    world.teleportUnit(u, HALL[0] - 250, u.y);
    u.worker.carryGold = 0; // a load in hand would be walked home, and a deposit resumes the walk
    u.worker.carryLumber = 0;
    u.order = "harvest";
    u.resKind = "gold";
    u.resId = mine.id;
    u.atNode = false;
    u.moving = false;
    u.path = [];
    u.waitT = 1e9;
  }
}

const DT = 1 / 30;
console.log("a crew that has stopped paying is sent back in");
{
  const { world, mine, ids, ai, asked } = fixture();
  const banked = () => world.stashOf(0).gold;
  const run = (seconds, from) => {
    for (let t = 0; t < seconds / DT; t++) {
      const now = from + t * DT;
      world.tick(DT);
      // The build pass runs about once a second in a match; the watchdog is asked with the
      // match clock, as Computer+ asks it.
      if (t % 30 === 0) ai.kickStalledMines(now);
    }
  };
  run(15, 0);
  const paid = banked();
  check("five peasants bank gold on their own", paid > 5 * GOLD_PER_TRIP, `${paid / GOLD_PER_TRIP} loads in 15 s`);
  check("…and a paying crew is never re-issued", asked.length === 0, `${asked.length} orders`);

  freeze(world, mine, ids);
  run(30, 15);
  check("frozen, they bank nothing", banked() === paid, `${(banked() - paid) / GOLD_PER_TRIP} loads`);
  check("…and are not kicked before the stall period", asked.length === 0, `${asked.length} orders by 45 s`);

  run(20, 45);
  check("the watchdog re-issues the crew once the mine has held its gold for the period", asked.length === N, `${asked.length} orders by 65 s`);
  check("…every order the plan's own harvest order", asked.every((c) => c.c === "order" && c.order.kind === "harvest" && c.order.res === "gold" && c.order.nodeId === mine.id), JSON.stringify(asked[0]));
  const kickedAt = banked();
  run(30, 65);
  check("…and they are mining again", banked() - kickedAt > 10 * GOLD_PER_TRIP, `${(banked() - kickedAt) / GOLD_PER_TRIP} loads in the 30 s after`);
  check("…without being re-issued again while they pay", asked.length === N, `${asked.length} orders by 95 s`);
}

console.log(failed ? `\nmine watchdog: ${failed} check(s) FAILED` : "\nmine watchdog: all checks passed");
process.exit(failed ? 1 : 0);
