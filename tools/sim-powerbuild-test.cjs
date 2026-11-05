// Headless check of HUMAN POWERBUILDING — extra Peasants on one construction.
//
// Each builder past the first adds its repair row's "Powerbuild Rate" to the build speed and
// pays its "Powerbuild Cost" share of the base price across the build: `[Ahrp]` DataD1 = 0.6,
// DataC1 = 0.15 (Units\AbilityData.slk; patch 1.10: "Each additional Peasant contributes 60%
// of the speed of the first"). The yardstick is Liquipedia's Town Hall — 180 s, 385/205 —
// "with 5 Peasants in total reduces build time to 53 seconds while increasing cost to 613
// gold and 329 lumber". The constant this replaced (0.17 a Peasant) had been fitted to a
// 90-second Town Hall and left five Peasants at 107 s, which read as "powerbuild doesn't work".
//
// A bare world (no ability registry) uses SimWorld's POWERBUILD_* fallbacks, which are those
// same two numbers.
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

/** A Town Hall-priced site, from scratch, with `n` Peasants standing against its wall. */
function build(n, { gold = 5000, lumber = 5000, race = "human" } = {}) {
  const world = makeWorld();
  const b = addSite(world);
  b.building.constructionLeft = b.building.buildTimeTotal = 180;
  b.building.goldCost = 385;
  b.building.lumberCost = 205;
  b.race = race;
  const st = world.stashOf(0);
  st.gold = gold;
  st.lumber = lumber;
  const ws = [];
  for (let i = 0; i < n; i++) {
    const w = addPeasant(world, 1 + i, SITE[0] - SITE_R - 40, SITE[1] - 120 + i * 40);
    w.race = race;
    ws.push(w);
    world.assignBuilder(w.id, b.id);
  }
  let t = 0;
  while (b.building.constructionLeft > 0 && t < 400) {
    world.tick(DT);
    t += DT;
  }
  return { t, gold: gold - st.gold, lumber: lumber - st.lumber, ws, b, st };
}

console.log("POWERBUILD — the Town Hall table");
{
  const one = build(1);
  check("one Peasant builds it in its own 180 s", Math.abs(one.t - 180) < 0.5, `${one.t.toFixed(1)} s`);
  check("…for nothing extra", one.gold === 0 && one.lumber === 0);
  const two = build(2);
  check("two: 180 / 1.6 = 112.5 s", Math.abs(two.t - 112.5) < 0.5, `${two.t.toFixed(1)} s`);
  check("…for 15% more gold (57.75)", Math.abs(two.gold - 57.75) < 1, `${two.gold.toFixed(1)} g`);
  const five = build(5);
  check("five: 180 / 3.4 ≈ 53 s (Liquipedia: 53)", Math.abs(five.t - 52.9) < 0.5, `${five.t.toFixed(1)} s`);
  check("…for 4 × 15% more: ≈ 231 gold, 123 lumber (Liquipedia: 613/329 in all)",
    Math.abs(five.gold - 231) < 2 && Math.abs(five.lumber - 123) < 2, `${(385 + five.gold).toFixed(0)}/${(205 + five.lumber).toFixed(0)}`);
}

console.log("\nPOWERBUILD — an owner who cannot pay the surcharge builds at one Peasant's speed");
{
  const broke = build(5, { gold: 0, lumber: 0 });
  check("five Peasants, an empty bank: the base 180 s", Math.abs(broke.t - 180) < 0.5, `${broke.t.toFixed(1)} s`);
  check("…and the bank is never overdrawn", broke.st.gold >= 0 && broke.st.lumber >= 0);
}

console.log("\nPOWERBUILD — human only: a second peon is turned away and keeps its job");
{
  const world = makeWorld();
  const b = addSite(world);
  b.race = "orc";
  const a = addPeasant(world, 1, SITE[0] - SITE_R - 40, SITE[1]);
  a.race = "orc";
  world.assignBuilder(a.id, b.id);
  const c = addPeasant(world, 2, SITE[0] - SITE_R - 40, SITE[1] + 200);
  c.race = "orc";
  c.order = "move"; // what it was doing before the click
  world.assignBuilder(c.id, b.id);
  check("the site keeps one builder", b.building.builderIds.length === 1 && b.building.builderIds[0] === a.id);
  check("…and the turned-away peon was not given the job", c.constructing !== b.id);
  check("…nor taken off what it was doing", c.order === "move");
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
