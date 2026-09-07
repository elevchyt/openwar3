// Headless check that a worker RE-TASKED to a halted construction actually builds it.
//
// Right-clicking a worker onto a building that is still going up is a "buildresume" order —
// SimWorld.assignBuilder — and a worker far from the site walks there under a plain "move"
// with the job hanging off `constructing`. Three things used to go wrong on that walk, and
// each ended the same way: the worker arrived and stood there idle.
//
//  · A LONE worker was sent at the building's CENTRE, ground inside the stamp that nothing
//    can stand on. A plain move there can never ARRIVE (atMoveGoal wants the point) and could
//    not be waited out either (terrainReachable read a centre six cells inside a Barracks as
//    "walled off"), so the walk ended in holdOrGiveUp → stop().
//  · stop() is the PLAYER's Stop, and it detaches a builder. Every way the movement code ends
//    a walk early — close enough in a crowd, parked and then "as close as it gets", walled
//    off — called it, and so threw the construction job away at the very moment the worker
//    got there. A group's spread points were the one case that worked, which is the whole
//    of "sometimes".
//  · Nothing ever took the walk up again: a builder is skipped by every idle-worker pass
//    (it has a job) and its shift-queue waits on that job too.
//
// So: a lone builder is walked to the building's BOX (approachExtent, exactly as a repair
// order is), the movement code's own arrivals go through `endWalk` — a stop that keeps a
// builder's site — and tickBuildings walks a builder that ended short back up to the box.
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
const SITE = [2560, 2560];
const SITE_R = 192; // a 12×12-cell stamp — a Barracks' `12x12` pathTex, the size that broke

function makeWorld() {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const cells = (SITE_R * 2) / CELL;
  const [x0, y0] = [Math.round((SITE[0] - SITE_R) / CELL), Math.round((SITE[1] - SITE_R) / CELL)];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) grid.block(x0 + i, y0 + j);
  const world = new SimWorld(grid, 1);
  // The renderer is what reads a pathTex in game (setFootprintReader); headless, say it here.
  world.buildHalfExtent = () => SITE_R;
  return world;
}

const BUILD_TIME = 60;

/** A Barracks half way up, with nobody on it — the halted site the click is for. */
function addSite(world) {
  world.add(
    {
      id: 100, owner: 0, team: 0, typeId: "hbar", x: SITE[0], y: SITE[1], facing: 0,
      hp: 500, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: SITE_R, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 160, lumberCost: 60, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 144, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Barracks", worker: null, depotGold: false, depotLumber: false,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: BUILD_TIME / 2, buildTimeTotal: BUILD_TIME, builderIds: [], goldCost: 160, lumberCost: 60, queue: [], rallyX: SITE[0], rallyY: SITE[1], rallyKind: "point", rallyTargetId: 0, producesUnits: true },
  );
  return world.units.get(100);
}

function addPeasant(world, id, x, y) {
  world.add({
    id, owner: 0, team: 0, typeId: "hpea", x, y, facing: 0,
    hp: 220, maxHp: 220, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 190, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: "Peasant", castPoint: 0, castBackswing: 0,
    depotGold: false, depotLumber: false, isPeon: true,
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, carryGold: 0, carryLumber: 0 },
  });
  return world.units.get(id);
}

const DT = 1 / 30;
const gapOf = (w, b) => Math.max(Math.abs(w.x - b.x), Math.abs(w.y - b.y)) - SITE_R - w.radius;

/** Walk the world until the site's clock moves, or the patience runs out. Reports whether the
 *  worker held its job the whole way — dropping it and picking it up again is not "kept". */
function walkIn(world, w, b, seconds = 40) {
  const left0 = b.building.constructionLeft;
  let kept = true;
  for (let t = 0; t < seconds / DT; t++) {
    world.tick(DT);
    if (w.constructing !== b.id) kept = false;
    if (b.building.constructionLeft < left0) return { built: true, kept };
  }
  return { built: false, kept };
}

console.log("RESUME — a lone worker sent from across the map builds it");
{
  const world = makeWorld();
  const b = addSite(world);
  const w = addPeasant(world, 1, SITE[0] - 1200, SITE[1]);
  world.assignBuilder(w.id, b.id); // the right-click, with nobody else selected
  check("it takes the job", w.constructing === b.id && b.building.builderIds.includes(w.id));
  check("…and walks for it", w.order === "move" && w.moving);
  const before = b.building.constructionLeft;
  world.tick(DT);
  check("the clock does not move while it is still on its way", b.building.constructionLeft === before);
  const r = walkIn(world, w, b);
  check("it walks in and the building goes up", r.built);
  check("…holding the job the whole way — the walk's end did not stop() it off the site", r.kept);
  const gap = gapOf(w, b);
  check("…from against the wall", gap < 96, `gap ${gap.toFixed(0)}`);
  check("…standing still, on no order", !w.moving && w.order === "idle");
}

console.log("\nRESUME — the spread's plain centre is the building too");
{
  // ringTargets hands a lone worker the plain centre rather than a ring slot, and the order
  // passes it through as ax/ay — the exact point a plain move can never reach.
  const world = makeWorld();
  const b = addSite(world);
  const w = addPeasant(world, 1, SITE[0], SITE[1] + 1100);
  world.assignBuilder(w.id, b.id, b.x, b.y);
  const r = walkIn(world, w, b);
  check("it walks in and the building goes up", r.built);
  check("…holding the job the whole way", r.kept);
}

console.log("\nRESUME — a walk that ends SHORT is taken up again");
{
  // A spread point a ring too far out: the worker arrives there, idle, three bodies short of
  // the wall. Before, that was the end of it — a builder nothing re-tasks.
  const world = makeWorld();
  const b = addSite(world);
  const w = addPeasant(world, 1, SITE[0] - 1200, SITE[1]);
  const farX = SITE[0] - SITE_R - 320;
  world.assignBuilder(w.id, b.id, farX, SITE[1]);
  let parked = false;
  for (let t = 0; t < 30 / DT && !parked; t++) {
    world.tick(DT);
    parked = !w.moving && Math.abs(w.x - farX) < CELL * 3 && w.constructing === b.id;
  }
  check("it reaches the spread point, still holding the job", parked, `x ${w.x.toFixed(0)} order ${w.order}`);
  check("…which is not at the site", gapOf(w, b) >= 96, `gap ${gapOf(w, b).toFixed(0)}`);
  const r = walkIn(world, w, b);
  check("…and it walks the rest of the way in by itself", r.built && r.kept);
  check("…to the wall", gapOf(w, b) < 96, `gap ${gapOf(w, b).toFixed(0)}`);
}

console.log("\nSTOP — the player's Stop still takes it off the site");
{
  const world = makeWorld();
  const b = addSite(world);
  const w = addPeasant(world, 1, SITE[0] - 1200, SITE[1]);
  world.assignBuilder(w.id, b.id);
  for (let t = 0; t < 2 / DT; t++) world.tick(DT);
  world.stop(w.id);
  check("a Stop drops the job", w.constructing === 0 && !b.building.builderIds.includes(w.id));
  const left = b.building.constructionLeft;
  for (let t = 0; t < 3 / DT; t++) world.tick(DT);
  check("…and the site stays halted", b.building.constructionLeft === left && !w.moving);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
