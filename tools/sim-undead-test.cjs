// Headless check of the five things that make the UNDEAD economy a different game from the
// other three. None of them is a tuning value; each is a rule, and each comes off a row:
//
//   Blight            `Abgs`/`Abgl` grow it (Area1 768 / 960, DataB "Creates Blight" = 1) and
//                     `Abds`/`Abdl` scrub it (the same radii, DataB = 0) — ONE mechanism with
//                     a boolean, carried by every building in the game. What is painted STAYS
//                     painted: the rot outlives what grew it.
//   Placement         UnitBalance `requirePlace` = "blighted", on exactly eleven Undead
//                     structures — and NOT on the Necropolis chain or the Haunted Gold Mine.
//   Summoning         An Acolyte hands the structure its own clock and walks away
//                     (BuildingState.selfBuilds); nothing can interrupt it by killing a worker.
//   Haunted Gold Mine `Abgm` — DataA 10 gold per DataB 1s at DataC 5 miners, standing in a
//                     DataD 200 ring OUTSIDE the building. No load, no trip, no depot.
//   Unsummon          `Auns` DataA "Salvage Cost Ratio" 0.5 — half the cost back, which is
//                     what lets an Undead base be re-shaped rather than lived with.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { SPELL_HANDLERS } = require(join(REPO, ".sim-build", "src", "sim", "spells.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

// The real rows, with only the columns these behaviours read.
const lvl = (over) => ({ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "", ...over });
// Blight Growth / Blight Dispel: Area1 the disc, DataA "Expansion Amount" 64 per Dur1 0.08s,
// DataB "Creates Blight" the only thing that tells growth from dispel.
const blight = (area, creates) => ({ target: "passive", targetFlags: [], levelData: [lvl({ area, duration: 0.08, data: [64, creates] })] });
const ABILITIES = {
  Abgs: { id: "Abgs", code: "Abli", ...blight(768, 1) },
  Abgl: { id: "Abgl", code: "Abli", ...blight(960, 1) },
  Abds: { id: "Abds", code: "Abli", ...blight(768, 0) },
  Abdl: { id: "Abdl", code: "Abli", ...blight(960, 0) },
  // Blighted Gold mine: 10 gold per 1s at a full crew of 5, in a 200-unit ring.
  Abgm: { id: "Abgm", code: "Abgm", target: "passive", targetFlags: [], levelData: [lvl({ data: [10, 1, 5, 200] })] },
  // Acolyte Harvest: no capacity, no gold per trip, no damage to a tree — and `Rng1` = 200,
  // the ring's own radius seen from the worker's side.
  Aaha: { id: "Aaha", code: "Aaha", target: "none", targetFlags: [], levelData: [lvl({ castRange: 200, duration: 1 })] },
  // Unsummon: half the cost back, accumulated in steps of 50.
  Auns: { id: "Auns", code: "Auns", target: "unit", targetFlags: ["structure", "player"], levelData: [lvl({ data: [0.5, 50] })] },
};
const abilities = { get: (id) => ABILITIES[id] };

// `abilities` here is UnitAbilities.slk's abilList, and `requirePlace` UnitBalance's own column.
const UNITS = {
  uaco: { id: "uaco", abilities: ["Aaha"], moveType: "foot", upgradesUsed: [], buildTime: 15, goldCost: 75, lumberCost: 0, manaRegen: 0, regenType: "blight", hpRegen: 4, requirePlace: "" },
  unpl: { id: "unpl", abilities: ["Abgl"], moveType: "foot", upgradesUsed: [], buildTime: 90, goldCost: 225, lumberCost: 0, manaRegen: 0, regenType: "none", hpRegen: 0, requirePlace: "" },
  uzig: { id: "uzig", abilities: ["Abgs"], moveType: "foot", upgradesUsed: [], buildTime: 50, goldCost: 150, lumberCost: 50, manaRegen: 0, regenType: "none", hpRegen: 0, requirePlace: "blighted" },
  ugol: { id: "ugol", abilities: ["Abgs", "Abgm"], moveType: "foot", upgradesUsed: [], buildTime: 100, goldCost: 225, lumberCost: 210, manaRegen: 0, regenType: "none", hpRegen: 0, requirePlace: "" },
  // A Human Farm — the dispel half of the same mechanism.
  hhou: { id: "hhou", abilities: ["Abds"], moveType: "foot", upgradesUsed: [], buildTime: 35, goldCost: 80, lumberCost: 20, manaRegen: 0, regenType: "none", hpRegen: 0, requirePlace: "" },
};
const unitReg = { get: (id) => UNITS[id] };
const techReg = { get: () => undefined, has: () => false, all: () => [] };
const upgradeReg = { get: () => undefined, has: () => false, all: () => [] };

function newWorld(w = 256, h = 256) {
  const grid = new PathingGrid({ width: w, height: h, flags: new Uint8Array(w * h) }, [0, 0]);
  return new SimWorld(grid, 1, abilities, undefined, unitReg, techReg, upgradeReg);
}

const base = (over) => ({
  owner: 0, team: 0, facing: 0, mana: 0, maxMana: 0, hpRegen: 0, turnRate: 0.6, scale: 1,
  armor: 0, armorType: "medium", defUp: 0, weapon: null, weapons: [], oldWeapons: [],
  sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800, flying: false,
  mechanical: false, invulnerable: false, race: "undead", isBuilding: false, foodCost: 0,
  goldCost: 0, lumberCost: 0, abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
  canFlee: true, targetedAs: "ground", deathTime: 2, name: "", worker: null,
  depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
  ...over,
});

/** An Acolyte, with `Aaha`'s profile: no capacity, no gold per trip, and a ring to kneel in. */
const acolyte = (id, x, y) => base({
  id, typeId: "uaco", x, y, hp: 230, maxHp: 230, speed: 220, radius: 16, name: "Acolyte",
  worker: { gold: true, lumber: false, harvestAbility: "Aaha", lumberCapacity: 0, baseLumberCapacity: 0, lumberPerChop: 0, chopPeriod: 1, goldPerTrip: 0, damagesTree: false, deliversInPlace: false, minesInRing: true, carryGold: 0, carryLumber: 0 },
});

const BUILT = (x, y) => ({ constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: x, rallyY: y, rallyKind: "point", rallyTargetId: 0, producesUnits: false });
const RISING = (x, y, left) => ({ ...BUILT(x, y), constructionLeft: left, buildTimeTotal: left });

/** Run a blight bloom out: `Abgl`'s 960 is 15 steps of 64 at 0.08s. */
const bloom = (world) => { for (let i = 0; i < 40; i++) world.tickBlight(0.08); };

// ---------------------------------------------------------------------------------------
console.log("Blight is TERRAIN — painted once by whatever grew it, and it stays painted");
{
  const world = newWorld();
  const zig = world.add(base({ id: 1, typeId: "uzig", x: 2000, y: 2000, hp: 600, maxHp: 600, speed: 0, radius: 48, isBuilding: true, name: "Ziggurat" }), BUILT(2000, 2000));
  check("nothing is blighted before it finishes", world.blight === null || world.blight.count === 0);
  bloom(world);
  check("a finished Ziggurat blights its 768", world.isBlighted(2000 + 640, 2000));
  check("…and stops there", !world.isBlighted(2000 + 1024, 2000));

  // The bloom is 64 units every 0.08s, not an instant disc — the purple wash players watch
  // spread out from a new building.
  const w2 = newWorld();
  w2.add(base({ id: 1, typeId: "uzig", x: 2000, y: 2000, hp: 600, maxHp: 600, speed: 0, radius: 48, isBuilding: true, name: "Ziggurat" }), BUILT(2000, 2000));
  w2.tickBlight(0.08);
  check("one step in, only the first 64 is rotted", !w2.isBlighted(2000 + 640, 2000));
  bloom(w2);
  check("…and 12 steps later the whole 768 is", w2.isBlighted(2000 + 640, 2000));

  // Painted, not projected: knocking the Ziggurat down leaves the ground as it left it.
  zig.hp = 0;
  bloom(world);
  check("the rot outlives the building that grew it", world.isBlighted(2000 + 640, 2000));

  // …and the dispel is the SAME mechanism with DataB = 0, carried by every non-Undead
  // building in the game.
  world.add(base({ id: 2, typeId: "hhou", x: 2000, y: 2000, hp: 500, maxHp: 500, speed: 0, radius: 48, isBuilding: true, race: "human", name: "Farm" }), BUILT(2000, 2000));
  bloom(world);
  check("a Human Farm finishing on it scrubs the rot", !world.isBlighted(2000 + 640, 2000));

  // …but only once the source is gone. A LIVE Undead building re-asserts its own disc, which
  // is the mechanical form of "blight can be dispelled by your enemies once the building that
  // generated it has been destroyed or unsummoned".
  const w3 = newWorld();
  w3.add(base({ id: 1, typeId: "unpl", x: 2000, y: 2000, hp: 1500, maxHp: 1500, speed: 0, radius: 64, isBuilding: true, name: "Necropolis" }), BUILT(2000, 2000));
  bloom(w3);
  w3.add(base({ id: 2, typeId: "hhou", x: 2000, y: 2000, hp: 500, maxHp: 500, speed: 0, radius: 48, isBuilding: true, race: "human", name: "Farm" }), BUILT(2000, 2000));
  bloom(w3);
  check("a live Necropolis takes its ground straight back", w3.isBlighted(2000 + 640, 2000));
}

console.log("`requirePlace` = blighted — the whole Undead placement rule, in one column");
{
  const world = newWorld();
  check("a Ziggurat needs rot under it", UNITS.uzig.requirePlace === "blighted");
  check("…and a Necropolis does not", UNITS.unpl.requirePlace === "");
  check("…nor a Haunted Gold Mine", UNITS.ugol.requirePlace === "");
  // A 6x6-cell Ziggurat is 192 units across; the check is per BUILD SQUARE, so half of it
  // hanging off the edge of the rot is refused.
  world.add(base({ id: 1, typeId: "uzig", x: 2000, y: 2000, hp: 600, maxHp: 600, speed: 0, radius: 48, isBuilding: true, name: "Ziggurat" }), BUILT(2000, 2000));
  bloom(world);
  check("a site well inside the disc is buildable", world.footprintBlighted(2000, 2000, 6, 6));
  check("…one hanging off its edge is not", !world.footprintBlighted(2000 + 704, 2000, 6, 6));
  check("…and one right outside it certainly is not", !world.footprintBlighted(2000 + 1200, 2000, 6, 6));
}

console.log("An Acolyte summons and WALKS AWAY — nothing can interrupt an Undead building");
{
  const world = newWorld();
  world.initStash(0, 500, 500);
  const zig = world.add(base({ id: 1, typeId: "uzig", x: 2000, y: 2000, hp: 60, maxHp: 600, speed: 0, radius: 48, isBuilding: true, name: "Ziggurat" }), RISING(2000, 2000, 10));
  world.add(acolyte(2, 2100, 2000));
  world.assignBuilder(2, 1);
  const aco = world.units.get(2);
  check("the Acolyte is released at once", aco.constructing === 0, `${aco.constructing}`);
  check("…and the structure was handed its own clock", zig.building.selfBuilds === true);
  check("…with nobody assigned to it", zig.building.builderIds.length === 0);
  // Send the Acolyte to the far side of the map and the building still rises.
  world.issueMove(2, 100, 100);
  for (let t = 0; t < 11 / 0.05; t++) world.tick(0.05);
  check("it finishes with the Acolyte long gone", zig.building.constructionLeft === 0);
  check("…at full hit points", zig.hp === zig.maxHp, `${Math.round(zig.hp)}/${zig.maxHp}`);
}

console.log("Haunted Gold Mine (`Abgm` 10 gold/s at DataC = 5 miners, in a DataD = 200 ring)");
{
  for (const crew of [1, 3, 5]) {
    const world = newWorld();
    world.initStash(0, 0, 0);
    const mine = world.addMine(4000, 4000, 12500, 128);
    world.add(base({ id: 50, typeId: "ugol", x: 4000, y: 4000, hp: 950, maxHp: 950, speed: 0, radius: 128, isBuilding: true, name: "Haunted Gold Mine" }), BUILT(4000, 4000));
    world.attachEntangled(50, mine.id, 0);
    for (let i = 0; i < crew; i++) {
      world.add(acolyte(60 + i, 4000 + 400, 4000 - 400 + i * 64));
      check(`Acolyte ${i + 1} takes the order`, world.issueHarvest(60 + i, "gold", mine.id));
    }
    for (let t = 0; t < 20 / 0.05; t++) world.tick(0.05);
    const kneeling = [...world.units.values()].filter((u) => u.ringSlot > 0 && u.working).length;
    check(`${crew} Acolyte(s) kneeling in the ring`, kneeling === crew, `${kneeling}`);
    // 2 gold/sec each — the mine's 10 shared over its five stations, which is a Peasant's
    // 10-per-trip round trip exactly. Measured over the whole window, so the walk costs a
    // little; the floor allows for it.
    const rate = world.stashOf(0).gold / 20;
    check(`…paying ~${crew * 2} gold/sec`, rate > crew * 1.4 && rate <= crew * 2 + 0.5, `${rate.toFixed(2)}/s`);
    check("…and nobody is carrying anything", [...world.units.values()].every((u) => !u.worker || u.worker.carryGold === 0));
    check("…each on its own station", new Set([...world.units.values()].filter((u) => u.ringSlot).map((u) => u.ringSlot)).size === crew);
  }
}

console.log("…and the ring is a hard five: a sixth Acolyte is turned away");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(4000, 4000, 12500, 128);
  world.add(base({ id: 50, typeId: "ugol", x: 4000, y: 4000, hp: 950, maxHp: 950, speed: 0, radius: 128, isBuilding: true, name: "Haunted Gold Mine" }), BUILT(4000, 4000));
  world.attachEntangled(50, mine.id, 0);
  for (let i = 0; i < 6; i++) {
    world.add(acolyte(60 + i, 4000 + 400, 4000 - 400 + i * 48));
    world.issueHarvest(60 + i, "gold", mine.id);
  }
  for (let t = 0; t < 25 / 0.05; t++) world.tick(0.05);
  const held = [...world.units.values()].filter((u) => u.ringSlot > 0).length;
  check("five stations, and no more", held <= 5, `${held}`);
}

console.log("An Acolyte cannot mine a BARE gold mine — there is no ring until it is haunted");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(4000, 4000, 12500, 128);
  world.add(acolyte(1, 4300, 4000));
  check("the order is refused outright", !world.issueHarvest(1, "gold", mine.id));
  // …and once it IS haunted, the same order is taken.
  world.add(base({ id: 50, typeId: "ugol", x: 4000, y: 4000, hp: 950, maxHp: 950, speed: 0, radius: 128, isBuilding: true, name: "Haunted Gold Mine" }), BUILT(4000, 4000));
  world.attachEntangled(50, mine.id, 0);
  check("…and taken once the mine is haunted", world.issueHarvest(1, "gold", mine.id));
}

console.log("Unsummon (`Auns`) — half the cost back, in steps of 50");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  world.add(acolyte(1, 2100, 2000));
  world.add(base({ id: 2, typeId: "uzig", x: 2000, y: 2000, hp: 600, maxHp: 600, speed: 0, radius: 48, isBuilding: true, name: "Ziggurat" }), BUILT(2000, 2000));
  const ok = world.unsummonBuilding(world.units.get(1), world.units.get(2), 0.5, 50);
  check("the Ziggurat is unsummoned", ok && !world.units.has(2));
  // 150 gold and 50 lumber, halved to 75/25, each rounded to the nearest step of 50.
  check("…paying back half its gold, stepped", world.stashOf(0).gold === 100, `${world.stashOf(0).gold}`);
  check("…and half its lumber, stepped", world.stashOf(0).lumber === 50, `${world.stashOf(0).lumber}`);
  check("the handler is wired to the same code", typeof SPELL_HANDLERS.Auns === "function");

  // Somebody else's building is not yours to take back (`targs1 = structure,player`).
  const w2 = newWorld();
  w2.initStash(0, 0, 0);
  w2.initStash(1, 0, 0);
  w2.add(acolyte(1, 2100, 2000));
  w2.add(base({ id: 2, typeId: "uzig", owner: 1, team: 1, x: 2000, y: 2000, hp: 600, maxHp: 600, speed: 0, radius: 48, isBuilding: true, name: "Ziggurat" }), BUILT(2000, 2000));
  check("an enemy's building is refused", !w2.unsummonBuilding(w2.units.get(1), w2.units.get(2), 0.5, 50));
  check("…and it is still standing", w2.units.has(2));
}

console.log(failed ? `\nsim-undead: ${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
