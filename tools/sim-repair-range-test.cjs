// Headless check of the two REACHES a body has to walk to before it may work: a worker's
// Repair and a cast whose `Rng1` is literally 0.
//
// Both bugs were the same shape — a range test that was not a range test:
//
//  · tickRepair asked whether the worker was still MOVING. A worker waiting out a jam or a
//    repath cooldown is not moving for that tick, so it started hammering a building it was
//    still half a screen away from. Repair states its own reach and every stock row carries
//    the same one: `Ahrp`/`Arep`/`Arst`/`Aren` Rng1 = 50.
//  · tickCast approached only when the ability stated a POSITIVE range, so `Rng1` = 0 read as
//    "no approach needed" instead of "you have to be touching it" — and a Goblin Sapper
//    (`[Asds] Rng1` = 0) detonated a building from wherever it happened to be standing.
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
const SITE_R = 128; // an 8×8-cell stamp, like a Barracks-sized pathTex core

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

function addBuilding(world, hp) {
  world.add(
    {
      id: 100, owner: 0, team: 0, typeId: "hbar", x: SITE[0], y: SITE[1], facing: 0,
      hp, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: SITE_R, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 72, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Barracks", worker: null, depotGold: false, depotLumber: false,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: SITE[0], rallyY: SITE[1], rallyKind: "point", rallyTargetId: 0, producesUnits: true },
  );
  return world.units.get(100);
}

function addBody(world, id, x, y, over = {}) {
  const { abilities, ...spawn } = over;
  world.add({
    id, owner: 0, team: 0, typeId: "hpea", x, y, facing: 0,
    hp: 220, maxHp: 220, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 190, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: "Body", castPoint: 0, castBackswing: 0,
    depotGold: false, depotLumber: false,
    ...spawn,
  });
  const u = world.units.get(id);
  // `add` filters an ability list through the real registry (buildInitialAbilities); this
  // world's registry is one hand-written row, so hand the ability over directly.
  if (abilities) u.abilities = abilities;
  return u;
}

const WORKER = {
  worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, carryGold: 0, carryLumber: 0 },
  isPeon: true,
  abilities: [{ id: "Arst", code: "Arst", level: 1, cooldownLeft: 0, autocastOn: false }],
};

/** An ability registry of exactly one row. */
const registry = (id, def) => ({ get: (want) => (want === id ? def : undefined) });

const DT = 1 / 30;
const REPAIR_RATES = [10, 0, 0]; // hpPerSec, goldPerHp, lumberPerHp — issueRepair takes them

console.log("REPAIR — the reach is the ability's own Rng1, not 'am I still walking'");
{
  const world = makeWorld();
  world.abilities = registry("Arst", { code: "Arst", target: "unit", targetFlags: [], levelData: [{ castRange: 50, data: [0.35, 1.5] }] });
  const b = addBuilding(world, 500);
  const w = addBody(world, 1, SITE[0] - 1200, SITE[1], WORKER);
  world.stashOf(0).gold = 1000;
  check("the order is accepted from across the map", world.issueRepair(w.id, b.id, ...REPAIR_RATES));

  // The frame the bug lived in: the walk pauses (a jam, a repath cooldown, a shove), so the
  // worker is not moving — and it was still a screen away.
  w.moving = false;
  const hpBefore = b.hp;
  world.tick(DT);
  check("a worker that has STOPPED far away still mends nothing", b.hp === hpBefore, `hp ${b.hp}`);
  check("…and it is not marked as working", w.repair && !w.repair.active);

  // …and it takes the walk up again by itself rather than standing there with a job.
  let arrived = false;
  for (let t = 0; t < 30 / DT && !arrived; t++) {
    world.tick(DT);
    arrived = !!w.repair?.active;
  }
  check("it walks in and starts", arrived);
  const gap = Math.max(Math.abs(w.x - b.x), Math.abs(w.y - b.y)) - SITE_R - w.radius;
  check("…from inside Repair's own 50", arrived && gap <= 50, `gap ${gap.toFixed(0)}`);
  const hpAt = b.hp;
  for (let t = 0; t < 1 / DT; t++) world.tick(DT);
  check("…and the building actually gains hit points", b.hp > hpAt + 5, `hp ${b.hp.toFixed(0)}`);
}

// …and the 50 comes out of the row rather than out of this file: the same worker, the same
// walk, an ability that says 900, and it starts nine hundred units out.
{
  const world = makeWorld();
  world.abilities = registry("Arst", { code: "Arst", target: "unit", targetFlags: [], levelData: [{ castRange: 900, data: [0.35, 1.5] }] });
  const b = addBuilding(world, 500);
  const w = addBody(world, 1, SITE[0] - 1200, SITE[1], WORKER);
  world.stashOf(0).gold = 1000;
  world.issueRepair(w.id, b.id, ...REPAIR_RATES);
  let gap = Infinity;
  for (let t = 0; t < 30 / DT; t++) {
    world.tick(DT);
    if (w.repair?.active) {
      gap = Math.max(Math.abs(w.x - b.x), Math.abs(w.y - b.y)) - SITE_R - w.radius;
      break;
    }
  }
  check("a row that states 900 mends from 900 out", gap > 700 && gap <= 900, `gap ${gap.toFixed(0)}`);
}

console.log("\nKABOOM — `Rng1` = 0 is a reach, and it means 'touching'");
{
  const world = makeWorld();
  const ASDS = { code: "Asds", target: "unit", targetFlags: [], levelData: [{ castRange: 0, cost: 0, cooldown: 0, castTime: 0, duration: 0.1, heroDuration: 0, area: 0, data: [100, 250, 250, 100, 3], buffs: [] }] };
  world.abilities = registry("Asds", ASDS);
  const b = addBuilding(world, 1000);
  const sapper = addBody(world, 1, SITE[0] - 1200, SITE[1], {
    owner: 1, team: 1, typeId: "ngsp", radius: 32, collisionSize: 32,
    abilities: [{ id: "Asds", code: "Asds", level: 1, cooldownLeft: 0, autocastOn: false }],
  });
  check("the cast is accepted from across the map", world.issueCast(sapper.id, "Asds", b.id));
  world.tick(DT);
  check("…but nothing goes off there", b.hp === 1000 && sapper.hp > 0, `hp ${b.hp}`);
  const startGap = Math.hypot(sapper.x - b.x, sapper.y - b.y);

  let blown = false;
  for (let t = 0; t < 30 / DT && !blown; t++) {
    world.tick(DT);
    blown = !world.units.has(sapper.id) || sapper.hp <= 0; // killUnit removes the body outright
  }
  check("the sapper walks in and detonates", blown);
  check("…having actually covered the ground", Math.hypot(sapper.x - b.x, sapper.y - b.y) < startGap - 800);
  check("…and the blast landed on the building", b.hp < 1000, `hp ${b.hp}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
