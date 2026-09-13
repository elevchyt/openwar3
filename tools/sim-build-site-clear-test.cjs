// Headless check that a BUILD SITE is cleared of the player's own units when the order is
// GIVEN — and that a unit working there keeps working, from ground off the site.
//
// Two bugs this pins:
//  · The site was only cleared when the builder got there (mapViewer's tickPendingBuild), so
//    a unit idling on the spot stood on it for the whole walk and the foundation then waited
//    on a shuffle. SimWorld.clearBuildSite now runs from the order and every tick after it.
//  · The shuffle was a plain move, and a move is a new order: a lumberjack chopping from the
//    spot stepped aside and never chopped again, and a Peasant hammering a building next door
//    walked off its job. They keep their order now and take the work up from another side of
//    the tree / the building (treeStand, besideBuilding), and the round trip's own stand-spot
//    pickers ask the same keep-out, so the next trip does not walk straight back in.
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
const DT = 1 / 30;
const SITE_HALF = 96; // a 6×6-cell stamp
const HALL = [2560, 3600];
const HALL_R = 128;

function blockBox(grid, cx, cy, half) {
  const cells = Math.round((half * 2) / CELL);
  const [x0, y0] = [Math.round((cx - half) / CELL), Math.round((cy - half) / CELL)];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) grid.block(x0 + i, y0 + j);
}

function makeWorld() {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const world = new SimWorld(grid, 1);
  world.buildHalfExtent = () => SITE_HALF;
  world.initStash(0, 5000, 5000);
  blockBox(grid, HALL[0], HALL[1], HALL_R);
  addBuilding(world, 100, "htow", HALL[0], HALL[1], HALL_R, 0, { depotGold: true, depotLumber: true });
  return { world, grid };
}

function addBuilding(world, id, typeId, x, y, r, constructionLeft, extra = {}) {
  world.add(
    {
      id, owner: 0, team: 0, typeId, x, y, facing: 0,
      hp: 500, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: r, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: r, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: typeId, worker: null, depotGold: false, depotLumber: false,
      castPoint: 0, castBackswing: 0, ...extra,
    },
    { constructionLeft, buildTimeTotal: 60, builderIds: [], goldCost: 100, lumberCost: 0, queue: [], rallyX: x, rallyY: y, rallyKind: "none", rallyTargetId: 0, producesUnits: false },
  );
  return world.units.get(id);
}

function addUnit(world, id, x, y, worker = true) {
  world.add({
    id, owner: 0, team: 0, typeId: worker ? "hpea" : "hfoo", x, y, facing: 0,
    hp: 220, maxHp: 220, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 190, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: worker ? "Peasant" : "Footman", castPoint: 0, castBackswing: 0,
    depotGold: false, depotLumber: false, isPeon: worker,
    worker: worker
      ? { gold: true, lumber: true, harvestAbility: "Ahar", lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, goldPerTrip: 10, damagesTree: true, carryGold: 0, carryLumber: 0 }
      : null,
  });
  return world.units.get(id);
}

const onSite = (u, sx, sy) => Math.abs(u.x - sx) < SITE_HALF + u.radius && Math.abs(u.y - sy) < SITE_HALF + u.radius;
function run(world, seconds, each) {
  for (let t = 0; t < seconds / DT; t++) {
    world.tick(DT);
    if (each) each(t * DT);
  }
}

console.log("ORDER TIME — an idle unit on the site walks off it before the builder gets there");
{
  const { world } = makeWorld();
  const SITE = [2560, 2560];
  const foot = addUnit(world, 1, SITE[0] + 16, SITE[1], false);
  const builder = addUnit(world, 2, SITE[0] - 1400, SITE[1]);
  world.issueBuildNew(builder.id, "hhou", SITE[0], SITE[1], 80, 20, true);
  check("the order sets the footman walking at once", foot.moving && foot.order === "move");
  run(world, 3);
  check("…and within three seconds it is off the site", !onSite(foot, SITE[0], SITE[1]), `at ${foot.x.toFixed(0)},${foot.y.toFixed(0)}`);
  check("…while the builder is still on its way", !!builder.buildPending && Math.hypot(builder.x - SITE[0], builder.y - SITE[1]) > 300);
}

console.log("LUMBER — a chopper working from the site keeps chopping, from off it");
{
  const { world, grid } = makeWorld();
  // A tree against the site's east edge; the chopper stands between the two.
  const SITE = [2560, 2560];
  const TREE = [SITE[0] + SITE_HALF + 64, SITE[1]];
  blockBox(grid, TREE[0], TREE[1], 32);
  const tree = world.addTree(TREE[0], TREE[1], 500);
  // A second tree further off, well clear of the site.
  blockBox(grid, TREE[0] + 64, TREE[1] + 256, 32);
  world.addTree(TREE[0] + 64, TREE[1] + 256, 500);
  const chopper = addUnit(world, 1, TREE[0] - 64, TREE[1]);
  world.issueHarvest(chopper.id, "lumber", tree.id);
  run(world, 3);
  check("setup: it is chopping, from ground the site will cover", chopper.working && onSite(chopper, SITE[0], SITE[1]), `at ${chopper.x.toFixed(0)},${chopper.y.toFixed(0)} working=${chopper.working}`);
  const builder = addUnit(world, 2, SITE[0] - 1400, SITE[1]);
  world.issueBuildNew(builder.id, "hhou", SITE[0], SITE[1], 80, 20, true);
  const lumber0 = world.stashOf(0).lumber;
  let everOnSiteIdle = false;
  let leftSite = false;
  run(world, 40, () => {
    if (!onSite(chopper, SITE[0], SITE[1])) leftSite = true;
    else if (leftSite && !chopper.moving && builder.buildPending) everOnSiteIdle = true;
  });
  check("it leaves the site", leftSite);
  check("…still under its harvest order (or carrying home)", chopper.order === "harvest" || chopper.order === "return", `order=${chopper.order}`);
  check("…and the lumber keeps coming in", world.stashOf(0).lumber > lumber0, `banked ${world.stashOf(0).lumber - lumber0}`);
  check("…without ever parking back on the site while the build is pending", !everOnSiteIdle);
}

console.log("CONSTRUCTING — a Peasant hammering next door keeps hammering, from another face");
{
  const { world, grid } = makeWorld();
  const A = [2560, 2560];
  const A_HALF = 96;
  blockBox(grid, A[0], A[1], A_HALF);
  const farm = addBuilding(world, 50, "hhou", A[0], A[1], 80, 30);
  const hammer = addUnit(world, 1, A[0] + A_HALF + 24, A[1]);
  world.assignBuilder(hammer.id, farm.id);
  run(world, 1);
  const left1 = farm.building.constructionLeft;
  check("setup: it is building", hammer.constructing === farm.id && left1 < 30);
  const SITE = [A[0] + A_HALF + SITE_HALF, A[1]]; // flush against the farm's east wall, over the Peasant
  check("setup: the Peasant stands on the new site", onSite(hammer, SITE[0], SITE[1]));
  const builder = addUnit(world, 2, SITE[0] + 1400, SITE[1]);
  world.issueBuildNew(builder.id, "hhou", SITE[0], SITE[1], 80, 20, true);
  run(world, 6);
  check("it has left the site", !onSite(hammer, SITE[0], SITE[1]), `at ${hammer.x.toFixed(0)},${hammer.y.toFixed(0)}`);
  check("…still holding the job", hammer.constructing === farm.id, `constructing=${hammer.constructing}`);
  const left2 = farm.building.constructionLeft;
  run(world, 2);
  check("…and the farm is still going up", farm.building.constructionLeft < left2, `${left2.toFixed(2)} → ${farm.building.constructionLeft.toFixed(2)}`);
}

console.log("GOLD — a site against the hall on the mine side does not stop the crew");
{
  const { world, grid } = makeWorld();
  const MINE = [HALL[0], HALL[1] - 900];
  const MINE_R = 128;
  blockBox(grid, MINE[0], MINE[1], MINE_R);
  const mine = world.addMine(MINE[0], MINE[1], 100000, MINE_R);
  const SITE = [HALL[0], HALL[1] - HALL_R - SITE_HALF]; // flush against the hall's mine-facing wall
  const crew = [];
  for (let i = 0; i < 3; i++) {
    const u = addUnit(world, 1 + i, HALL[0] - 64 + i * 64, HALL[1] - HALL_R - 48);
    world.issueHarvest(u.id, "gold", mine.id);
    crew.push(u);
  }
  run(world, 4);
  const builder = addUnit(world, 9, HALL[0] + 1400, HALL[1]);
  world.issueBuildNew(builder.id, "hhou", SITE[0], SITE[1], 80, 20, true);
  const gold0 = world.stashOf(0).gold;
  let deliveredOnSite = 0;
  let delivered = 0;
  const carry = crew.map((u) => u.worker.carryGold);
  run(world, 45, () => {
    crew.forEach((u, i) => {
      // The tick a load lands is the tick the worker stood at the hall to hand it over.
      if (carry[i] > 0 && u.worker.carryGold === 0 && builder.buildPending) {
        delivered++;
        if (onSite(u, SITE[0], SITE[1])) deliveredOnSite++;
      }
      carry[i] = u.worker.carryGold;
    });
  });
  check("the crew is still mining", crew.every((u) => u.order === "harvest" || u.order === "return"), crew.map((u) => u.order).join(","));
  check("…and gold is still delivered", world.stashOf(0).gold > gold0 && delivered > 0, `banked ${world.stashOf(0).gold - gold0}`);
  check("…at a side of the hall off the site", deliveredOnSite === 0, `${deliveredOnSite} of ${delivered} loads handed in from the site`);
}

console.log("RAISE — a body caught on the cells when the stamp lands is put back on open ground");
{
  const { world, grid } = makeWorld();
  const SITE = [2560, 2560];
  const walker = addUnit(world, 1, SITE[0] + 8, SITE[1] + 8, false);
  world.issueMove(walker.id, SITE[0] + 900, SITE[1]);
  world.tick(DT);
  const house = addBuilding(world, 60, "hhou", SITE[0], SITE[1], 80, 60);
  blockBox(grid, SITE[0], SITE[1], SITE_HALF);
  const cells = (SITE_HALF * 2) / CELL;
  world.setPathStamp(house.id, { w: cells, h: cells, blocked: new Uint8Array(cells * cells).fill(1) }, SITE[0], SITE[1]);
  world.clearRaisedSite(house.id, 0);
  check("it is off the stamp", !onSite(walker, SITE[0], SITE[1]), `at ${walker.x.toFixed(0)},${walker.y.toFixed(0)}`);
  check("…still on its way", walker.order === "move" && walker.moving);
  run(world, 8);
  check("…and it gets there", Math.hypot(walker.x - SITE[0] - 900, walker.y - SITE[1]) < 64, `at ${walker.x.toFixed(0)},${walker.y.toFixed(0)}`);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall build-site clearing checks passed");
