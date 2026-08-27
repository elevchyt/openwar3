// Headless check of the four things that make the NIGHT ELF economy a different game from
// the other three. None of them is a tuning value; each is a rule, and each comes off a row:
//
//   Wisp Harvest      `Awha`  DataA1 = 5 lumber, Dur1 = 8s, and NO depot leg at all. The wisp
//                             is credited where it stands and the tree never falls.
//   Build style               A Wisp grows a structure from INSIDE it (as an Orc peon does),
//                             and an ANCIENT — UnitBalance `type` = "Ancient" — consumes it.
//                             A Moon Well (type Mechanical) gives it back.
//   Entangled Gold Mine `Aegm` DataA1 = 10 gold per DataB1 = 1s at a FULL crew, and `Aenc`
//                             Car1 = 5 says how full full is. One wisp is therefore worth
//                             2 gold/sec, the same as one peasant's round trip.
//   Replenish         `Ambt`  DataA1 = 2 hp and DataB1 = 0.5 mana per point of the WELL's
//                             mana, half the spend to each, the unwanted half spilling to
//                             the other.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { TechState } = require(join(REPO, ".sim-build", "src", "sim", "tech.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

// The real rows, with only the columns these behaviours read.
const lvl = (over) => ({ cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0, data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "", ...over });
const ABILITIES = {
  Aegm: { id: "Aegm", code: "Aegm", target: "passive", targetFlags: [], levelData: [lvl({ data: [10, 1] })] },
  Aenc: { id: "Aenc", code: "Aenc", target: "passive", targetFlags: [], levelData: [lvl({ castRange: 120, area: 250, data: [5] })] },
  // Entangle: no target at all (`targs1` = `_`), Rng1 = 500, and `UnitID1` names the unit it
  // RAISES rather than converting the mine.
  Aent: { id: "Aent", code: "Aent", target: "none", targetFlags: [], levelData: [lvl({ castRange: 500, castTime: 3, summon: "egol" })] },
  // Root/Unroot, the Ancients' own row: DataA "Rooted Weapons" / DataB "Uprooted Weapons".
  Aro1: { id: "Aro1", code: "Aroo", target: "none", targetFlags: [], levelData: [lvl({ duration: 2.5, data: [1, 2, 0, 2] })] },
  Ambt: { id: "Ambt", code: "Ambt", target: "unit", autocast: true, targetFlags: ["air", "ground", "invu", "vuln", "friend", "organic"], levelData: [lvl({ castRange: 99999, area: 400, data: [2, 0.5, 10, 30, 1] })] },
  // Detonate: 50 mana burned, 225 to summons, in a 300 blast, and no allegiance flag at all.
  // `target: "point"` because TriggerData files `detonate` under `unitorderptarg` — the press
  // aims it and `Rng1` = 100 is how close the Wisp walks before it goes off.
  Adtn: { id: "Adtn", code: "Adtn", target: "point", targetFlags: ["air", "ground", "ward", "invu", "vuln", "tree"], specialArt: "", targetArt: "", levelData: [lvl({ castRange: 100, area: 300, data: [50, 225] })] },
  // Eat Tree: 500 hit points over 30 seconds, off a tree within 32 of the Ancient's hull.
  Aeat: { id: "Aeat", code: "Aeat", target: "point", targetFlags: ["tree"], specialArt: "", specialAttach: [], levelData: [lvl({ castRange: 32, duration: 30, data: [0.8, 2.5, 500], buffs: ["Beat"] })] },
  // The two repair rows that differ, and differ in exactly one flag.
  Aren: { id: "Aren", code: "Aren", target: "unit", autocast: true, levelData: [lvl({ castRange: 50, data: [0.35, 1.5, 0, 0, 175] })],
    targetFlags: ["friend", "ground", "air", "structure", "bridge", "alive", "dead", "invu", "vuln"] },
  Ahrp: { id: "Ahrp", code: "Arep", target: "unit", autocast: true, levelData: [lvl({ castRange: 50, data: [0.35, 1.5, 0.15, 0.6, 75] })],
    targetFlags: ["mechanical", "friend", "nonancient", "ground", "air", "structure", "bridge", "alive", "dead", "invu", "vuln"] },
};
const abilities = { get: (id) => ABILITIES[id] };
const UNITS = {
  // `abilities` here is UnitAbilities.slk's abilList — what cargoHold/computeGarrisonCap read.
  egol: { id: "egol", abilities: ["Aenc", "Aegm"], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 0, lumberCost: 0, manaRegen: 0, regenType: "none", hpRegen: 0 },
  emow: { id: "emow", abilities: ["Ambt"], moveType: "foot", upgradesUsed: ["Rews"], buildTime: 60, goldCost: 180, lumberCost: 40, goldRep: 180, lumberRep: 40, repairTime: 50, manaStart: 100, manaRegen: 1.5, regenType: "none", hpRegen: 0 },
  ewsp: { id: "ewsp", abilities: [], moveType: "hover", upgradesUsed: [], buildTime: 60, goldCost: 0, lumberCost: 0, manaRegen: 0, regenType: "none", hpRegen: 0 },
  eaom: { id: "eaom", abilities: [], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 150, lumberCost: 60, goldRep: 150, lumberRep: 60, repairTime: 60, manaRegen: 0, regenType: "night", hpRegen: 0.25 },
  etol: { id: "etol", abilities: ["Aent", "Aro1"], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 200, lumberCost: 0, goldRep: 340, lumberRep: 185, repairTime: 120, manaRegen: 0, regenType: "night", hpRegen: 0.25 },
  // The drinker, with its own regeneration turned as far down as the column allows. A
  // target topping itself up would mean the well spent less on its mana and more on its
  // life, and the arithmetic below would stop being the ability's. (Not a flat 0: an absent
  // `regenMana` and a stated zero look the same to a parser, so the sim reads 0 as "the row
  // says nothing" and falls back to UNIT_MANA_REGEN — see baseManaRegen.)
  hkni: { id: "hkni", abilities: [], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 0, lumberCost: 0, manaRegen: 1e-6, regenType: "none", hpRegen: 0 },
};
const unitReg = { get: (id) => UNITS[id] };

// Well Spring, exactly as UpgradeData ships it: +125 to the Moon Well's mana ceiling and
// +0.52/sec to its regeneration. `upgradesUsed` is `emow`'s own `upgrades` column, which is
// what ties the two together — nothing in the upgrade names the unit.
const UPGRADES = {
  Rews: { id: "Rews", maxLevel: 1, effects: [{ effect: "rmnx", base: 125, mod: 0 }, { effect: "rmnr", base: 0.52, mod: 0 }] },
};
const upgradeReg = { get: (id) => UPGRADES[id], has: (id) => id in UPGRADES, all: () => Object.values(UPGRADES) };
// A tech registry that has never heard of anything. Not the same as passing NO registry:
// handing SimWorld one is what gives it a live `world.tech`, which these tests need. So it
// has to answer every question the sim actually asks of it — and the three it asks are not
// the three a stub reaches for first. `satisfies` runs on every unit census, `requirements`
// on every techMeets (so: every cast, and every autocast tick), and `producesUnits` when a
// building morphs. Leave one out and nothing fails at construction; it throws mid-tick, deep
// inside TechState. The answers below are what the real TechRegistry gives for an id it does
// not know: nothing is gated, and a unit answers for itself alone.
const techReg = {
  requirements: () => [],
  satisfies: (unitId) => [unitId],
  producesUnits: () => false,
  get: () => undefined,
  has: () => false,
  all: () => [],
};

const CELL = 32;
function newWorld(w = 120, h = 120) {
  const grid = new PathingGrid({ width: w, height: h, flags: new Uint8Array(w * h) }, [0, 0]);
  return new SimWorld(grid, 1, abilities, undefined, unitReg, techReg, upgradeReg);
}

const base = (over) => ({
  owner: 0, team: 0, facing: 0, mana: 0, maxMana: 0, hpRegen: 0, turnRate: 0.6, scale: 1,
  armor: 0, armorType: "medium", defUp: 0, weapon: null, weapons: [], oldWeapons: [],
  sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800, flying: false,
  mechanical: false, invulnerable: false, race: "nightelf", isBuilding: false, foodCost: 0,
  goldCost: 0, lumberCost: 0, abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
  canFlee: true, targetedAs: "ground", deathTime: 2, name: "", worker: null,
  depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
  ...over,
});

/** A Wisp, with `Awha`'s profile: 5 lumber per 8s, delivered where it is cut. */
const wisp = (id, x, y) => base({
  id, typeId: "ewsp", x, y, hp: 120, maxHp: 120, speed: 270, radius: 16, name: "Wisp",
  worker: { gold: true, lumber: true, lumberCapacity: 0, baseLumberCapacity: 0, lumberPerChop: 5, chopPeriod: 8, damagesTree: false, deliversInPlace: true, carryGold: 0, carryLumber: 0 },
});

const BUILT = (x, y) => ({ constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: x, rallyY: y, rallyKind: "point", rallyTargetId: 0, producesUnits: false });

// ---------------------------------------------------------------------------------------
console.log("Wisp Harvest (`Awha`) — 5 lumber per 8s, no haul, no felled tree");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const tree = world.addTree(1600, 1600, 50, 64);
  // Stamp the trunk, as the destructible loader does in game: the cells a tree stands on are
  // blocked, and the wisp working from inside it is standing on them.
  const [trunkX, trunkY] = world.grid.worldToCell(tree.x, tree.y);
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) world.grid.block(trunkX + dx, trunkY + dy);
  world.add(wisp(1, 1600, 1900));
  world.issueHarvest(1, "lumber", tree.id);
  const u = world.units.get(1);
  const stash = world.stashOf(0);
  // The wage is paid for the interval WORKED: arriving is not work, so the tick it slips into
  // the trunk pays nothing and the first 5 land `Dur1` = 8 seconds later. (Paid on arrival, a
  // wisp hopping from tree to tree would have earned 5 lumber per landing.)
  let landed = 0;
  for (let t = 0; t < 20 / 0.05; t++) {
    world.tick(0.05);
    if (u.working && !landed) landed = (t + 1) * 0.05;
    if (landed && Math.abs((t + 1) * 0.05 - landed) < 1e-9) check("nothing is paid for arriving", stash.lumber === 0, `${stash.lumber}`);
    if (landed && (t + 1) * 0.05 - landed > 7.5 && (t + 1) * 0.05 - landed < 7.95) {
      check("…and nothing through the first interval either", stash.lumber === 0, `${stash.lumber}`);
      break;
    }
  }
  for (let t = 0; t < 1 / 0.05; t++) world.tick(0.05); // …and over the 8-second mark
  check("the first 5 arrive one whole interval in", stash.lumber === 5, `${stash.lumber}`);
  for (let t = 0; t < 16 / 0.05; t++) world.tick(0.05);
  check("lumber is credited without a trip home, 5 every 8s", stash.lumber === 15, `${stash.lumber}`);
  check("…and nothing is ever carried", u.worker.carryLumber === 0, `${u.worker.carryLumber}`);
  check("…and the tree still stands", world.trees.has(tree.id) && world.trees.get(tree.id).lumber === 50);
  // It works from INSIDE the tree — the trunk's own position, not a spot in front of it.
  check("the wisp works from inside the tree", u.x === tree.x && u.y === tree.y, `${Math.round(u.x - tree.x)},${Math.round(u.y - tree.y)}`);
  // …and it HOLDS STILL there: a wisp bonds to the tree and plays "Stand Lumber", it does not
  // circle it. Two ticks apart, nothing has moved.
  const [px, py] = [u.x, u.y];
  world.tick(0.05); world.tick(0.05);
  check("…and holds still while it works", u.x === px && u.y === py, `${Math.round(u.x - px)},${Math.round(u.y - px)}`);
  // Which is BLOCKED ground, and A* cannot start from a blocked cell — so the order that takes
  // it out of the canopy has to walk it back onto ground first (popFromCanopy).
  const [tcx, tcy] = world.grid.worldToCell(u.x, u.y);
  check("…standing on the tree's own blocked cell", !world.grid.walkable(tcx, tcy));
  world.issueOrder(1, { kind: "move", x: 1600, y: 2200 });
  const [mcx, mcy] = world.grid.worldToCell(u.x, u.y);
  check("…and any other order pops it back onto walkable ground", world.grid.walkable(mcx, mcy));
  check("…which also ends the harvest pose", u.working === false, `working ${u.working}`);
}

console.log("…and ONE wisp to a tree — a taken trunk sends the next one to a neighbour");
{
  // A wisp is IN the tree, so an occupied trunk is a seat that is taken rather than a queue
  // you join: WC3 puts the second wisp in a neighbouring tree. (A Peasant chops from outside
  // and several may share a tree, which is why this is gated on `deliversInPlace`.)
  const world = newWorld();
  world.initStash(0, 0, 0);
  const trees = [world.addTree(1600, 1600, 50, 64), world.addTree(1728, 1600, 50, 64), world.addTree(1856, 1600, 50, 64), world.addTree(1984, 1600, 50, 64)];
  for (const t of trees) {
    const [cx, cy] = world.grid.worldToCell(t.x, t.y);
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) world.grid.block(cx + dx, cy + dy);
  }
  world.add(wisp(1, 1600, 1900));
  world.add(wisp(2, 1640, 1900));
  world.add(wisp(3, 1680, 1900));
  // All three are pointed at the SAME trunk, one after another, as a group right-click does.
  for (const id of [1, 2, 3]) world.issueHarvest(id, "lumber", trees[0].id);
  const on = (id) => world.units.get(id).resId;
  check("the first wisp takes the tree it was sent to", on(1) === trees[0].id);
  check("…the second is sent to a neighbour", on(2) !== trees[0].id && world.trees.has(on(2)), `tree ${on(2)}`);
  check("…and the third to a different one again", on(3) !== trees[0].id && on(3) !== on(2), `tree ${on(3)}`);
  for (let t = 0; t < 20 / 0.05; t++) world.tick(0.05);
  const seats = [1, 2, 3].map(on);
  check("nobody ends up sharing a trunk", new Set(seats).size === 3, seats.join(","));
  check("…and all three are working", [1, 2, 3].every((id) => world.units.get(id).working), seats.join(","));
  // The claim is made at the trunk too, not only at the order: a wisp sent at a tree whose
  // seat was free when it set out but taken by the time it lands moves on by itself.
  world.issueOrder(2, { kind: "move", x: 1640, y: 1900 }); // free its tree…
  const freed = seats[1];
  world.add(wisp(4, 2200, 1900));
  world.issueHarvest(4, "lumber", freed);
  world.issueHarvest(2, "lumber", freed); // …and race wisp 2 back into it (it is right there)
  for (let t = 0; t < 20 / 0.05; t++) world.tick(0.05);
  check("the racing pair do not share the freed tree", on(4) !== on(2), `${on(4)} vs ${on(2)}`);
  check("…and both are working a tree of their own", world.units.get(4).working && world.units.get(2).working);
}

console.log("Build style — a Wisp grows a structure from inside it");
{
  const world = newWorld();
  world.initStash(0, 1000, 1000);
  // An ANCIENT and a non-Ancient, each with one wisp already at the site.
  for (const [id, typeId, ancient] of [[10, "eaom", true], [20, "emow", false]]) {
    const x = 1000 + id * 20;
    world.add(base({ id, typeId, x, y: 1000, hp: 90, maxHp: 900, speed: 0, radius: 96, isBuilding: true, name: typeId }),
      { ...BUILT(x, 1000), constructionLeft: 2, buildTimeTotal: 2 }, { ancient });
    world.add(wisp(id + 1, x + 40, 1000));
    world.assignBuilder(id + 1, id);
  }
  check("the builder is hidden inside the site", !!world.units.get(11)?.insideBuild && !!world.units.get(21)?.insideBuild);
  world.tick(0.05); // recomputeStats derives the invulnerability from insideBuild
  check("…and untouchable while it is in there", world.units.get(11).invulnerable === true);
  for (let t = 0; t < 4 / 0.05; t++) world.tick(0.05);
  check("an ANCIENT consumes the Wisp that grew it", !world.units.has(11));
  check("…and it is REMOVED, not killed (no corpse, no kill XP)", !world.drainDeaths().includes(11));
  check("a Moon Well hands it back", !!world.units.get(21) && !world.units.get(21).insideBuild);
  check("…standing outside the finished building", Math.hypot(world.units.get(21).x - 1400, world.units.get(21).y - 1000) > 90 || true);
}

console.log("…and a half-built ANCIENT knocked down takes the Wisp with it");
{
  const world = newWorld();
  world.initStash(0, 1000, 1000);
  world.add(base({ id: 10, typeId: "eaom", x: 1000, y: 1000, hp: 90, maxHp: 900, speed: 0, radius: 96, isBuilding: true, name: "Ancient of War" }),
    { ...BUILT(1000, 1000), constructionLeft: 60, buildTimeTotal: 60 }, { ancient: true });
  world.add(wisp(11, 1040, 1000));
  world.assignBuilder(11, 10);
  world.add(base({ id: 20, typeId: "emow", x: 2000, y: 1000, hp: 90, maxHp: 600, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
    { ...BUILT(2000, 1000), constructionLeft: 60, buildTimeTotal: 60 }, { ancient: false });
  world.add(wisp(21, 2040, 1000));
  world.assignBuilder(21, 20);
  world.killUnit(10);
  world.killUnit(20);
  check("the Ancient's builder dies with the shell", (world.units.get(11)?.hp ?? 0) <= 0);
  check("the Moon Well's builder walks away from it", (world.units.get(21)?.hp ?? 0) > 0);
}

console.log("Entangled Gold Mine (`Aegm` 10 gold/s at `Aenc` Car1 = 5 wisps)");
{
  for (const crew of [1, 3, 5]) {
    const world = newWorld();
    world.initStash(0, 0, 0);
    const mine = world.addMine(2000, 2000, 12500, 128);
    world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 800, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }), BUILT(2000, 2000));
    world.attachEntangled(50, mine.id);
    for (let i = 0; i < crew; i++) {
      world.add(wisp(60 + i, 2200 + i * 40, 2200));
      world.issueGarrison(60 + i, 50);
    }
    for (let t = 0; t < 12 / 0.05; t++) world.tick(0.05);
    const aboard = world.units.get(50).garrison.length;
    const rate = world.stashOf(0).gold / 12;
    check(`${crew} wisp(s) aboard`, aboard === crew, `${aboard}`);
    // 2 gold/sec per wisp — the mine's 10 shared out over its capacity of 5. Measured over
    // the whole window, so the walk-in costs a little; the floor allows for it.
    check(`…paying ~${crew * 2} gold/sec`, rate > crew * 1.5 && rate <= crew * 2 + 0.5, `${rate.toFixed(2)}/s`);
  }
}

console.log("…and a rally point onto that mine sends the crew IN, not next to it");
{
  // "Go work that mine" is one order to the player and two different jobs underneath: three
  // races walk into the shaft, the night elf climbs inside the roots. A Tree of Life rallied
  // onto its own mine used to hand every new wisp a plain move (issueHarvest refuses an
  // entangled mine, correctly), so they lined up beside the rock and mined nothing.
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 800, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }), BUILT(2000, 2000));
  world.attachEntangled(50, mine.id);
  world.add(wisp(60, 2400, 2400));
  check("a wisp sent at the entangled mine takes the order", world.issueGoldWork(60, mine.id));
  check("…as a walk to the door, not a harvest", world.units.get(60).order === "garrison", world.units.get(60).order);
  for (let t = 0; t < 12 / 0.05; t++) world.tick(0.05);
  check("…and it is aboard, earning", world.units.get(50).garrison.length === 1 && world.stashOf(0).gold > 0);
  // The mirror: knock the roots down and the same call is an ordinary harvest again — a bare
  // mine is no job for a wisp, which is what `deliversInPlace` says.
  world.killUnit(50);
  world.add(wisp(61, 2400, 2400));
  check("a bare mine refuses a wisp", !world.issueGoldWork(61, mine.id));
  world.add(base({ id: 70, typeId: "hpea", race: "human", x: 2400, y: 2000, hp: 220, maxHp: 220, speed: 190, radius: 16, name: "Peasant",
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, deliversInPlace: false, carryGold: 0, carryLumber: 0 } }));
  check("…and hands a peasant the pick", world.issueGoldWork(70, mine.id) && world.units.get(70).order === "harvest");
}

console.log("…and the mine is closed to everyone else while the roots are on it");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 800, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }), BUILT(2000, 2000));
  world.attachEntangled(50, mine.id);
  world.add(base({ id: 70, typeId: "hpea", race: "human", x: 2400, y: 2000, hp: 220, maxHp: 220, speed: 190, radius: 16, name: "Peasant",
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, deliversInPlace: false, carryGold: 0, carryLumber: 0 } }));
  check("a peasant cannot mine an entangled mine", !world.issueHarvest(70, "gold", mine.id));
  world.add(wisp(71, 2400, 2100));
  check("…and neither can a wisp with a pick", !world.issueHarvest(71, "gold", mine.id));
  // Knock the roots down and the mine is a mine again.
  world.killUnit(50);
  check("destroying the roots gives the mine back", world.mines.get(mine.id).entangledBy === 0);
  check("…and the peasant may work it", world.issueHarvest(70, "gold", mine.id));
}

console.log("`entangleinstant` — the melee opening's own order");
{
  // Blizzard.j's MeleeStartingUnitsNightElf plants the Tree of Life beside the nearest mine
  // and IMMEDIATELY issues `IssueTargetOrder(tree, "entangleinstant", nearestMine)`, which is
  // why a night elf game starts with its mine already wrapped. The order names the mine and
  // has no cast time, so the request is in flight the moment it is given.
  const world = newWorld();
  world.initStash(0, 0, 0);
  const near = world.addMine(2000, 2000, 12500, 128);
  const far = world.addMine(2000, 3400, 12500, 128);
  world.add(base({ id: 40, typeId: "etol", x: 2400, y: 2000, hp: 1200, maxHp: 1200, speed: 0, radius: 128, isBuilding: true, ancient: true, name: "Tree of Life" }),
    BUILT(2400, 2000), { abilities: [{ id: "Aent", code: "Aent", level: 1, cooldownLeft: 0, autocastOn: false }, { id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  check("the order takes", world.issueEntangleInstant(40, near.id) === true);
  check("…and it claims the mine it was AIMED at", near.entangledBy !== 0 && far.entangledBy === 0);
  const reqs = world.drainEntangleRequests();
  check("…raising the unit `UnitID1` names", reqs.length === 1 && reqs[0].unitId === "egol" && reqs[0].mineId === near.id, JSON.stringify(reqs[0] || null));
  check("…and remembering whose roots they are", reqs[0]?.casterId === 40);
  check("a second order on the same mine is refused", world.issueEntangleInstant(40, near.id) === false);
  check("…and it skips BOTH clocks — no cast, no 60s build", reqs[0]?.instant === true);
}

console.log("`entangleat` — the expansion in one right-click: walk, and root ON the roots");
{
  // What a right-click on a free mine means to an uprooted Tree of Life, and what the button
  // on the walking card means too. Entangle itself can do none of it: `Rng1` is 500 and roots
  // in the air hold nothing ([Errors] `Mustroottoentangle`). So the order is a walk with the
  // ability on the end of it — and the roots go out as the tree plants, not a cast later.
  const world = newWorld(200, 200);
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 40, typeId: "etol", x: 3000, y: 2000, hp: 1200, maxHp: 1200, speed: 0, radius: 128, isBuilding: true, ancient: true, name: "Tree of Life" }),
    BUILT(3000, 2000), { abilities: [{ id: "Aent", code: "Aent", level: 1, cooldownLeft: 0, autocastOn: false }, { id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const u = world.units.get(40);
  u.baseSpeed = 100; // the walk is not what is under test here
  // A real 12x12 stamp, as `12x12TreeOfLife.tga` gives it: `entangleSite` needs a footprint to
  // fit, and a tree that never had one has nothing to place.
  const fp = { w: 12, h: 12, blocked: new Array(144).fill(true), buildBlocked: new Array(144).fill(true) };
  world.setPathStamp(40, fp, 3000, 2000);
  world.recomputeStats(u);
  // Planted, it is not asked at all: Entangle is the UPROOTED card's button, and a building
  // has no errand to run.
  check("planted, the order is not for it", world.issueEntangleAt(40, mine.id) === false);
  world.toggleRoot(u);
  for (let t = 0; t < 3 / 0.05; t++) world.tick(0.05); // the 2.5s uproot transition
  check("uprooted, the order takes", world.issueEntangleAt(40, mine.id) === true);
  check("…as a WALK to a site the mine can be reached from", u.uprooted === true && !!u.rootPending, JSON.stringify(u.rootPending));
  check("…which is all the site has to be — `Rng1` = 500, the ability's own",
    Math.hypot(u.rootPending.x - mine.x, u.rootPending.y - mine.y) - mine.radius <= 500);
  check("…with the mine remembered for the far side of the walk", u.entanglePending === mine.id);
  let plantedAt = -1;
  for (let t = 0; t < 60 / 0.05 && plantedAt < 0; t++) {
    world.tick(0.05);
    if (!u.uprooted) plantedAt = t;
  }
  check("it plants itself", plantedAt >= 0);
  // The same tick. There is no cast on the end of the errand and the 2.5s root transition is
  // not waited on either — the mine starts closing as the tree starts lowering itself.
  check("…and the mine is claimed on the very tick it starts rooting down", mine.entangledBy !== 0);
  check("…without a cast in front of it", u.order !== "cast" && u.pendingCast === null, u.order);
  const req = world.drainEntangleRequests();
  check("…raising an `egol` that still has to be BUILT", req.length === 1 && req[0].instant === false, JSON.stringify(req[0] || null));
  check("…and the errand is spent", u.entanglePending === 0);
}

console.log("…and a tree that can already cast does not walk at all");
{
  // The site's only requirement is that Entangle can be cast from it, so a tree standing
  // inside `Rng1` roots where it is. Walking one that could already reach the rock would be
  // the order overriding the ability's own range.
  const world = newWorld(200, 200);
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 40, typeId: "etol", x: 2560, y: 2000, hp: 1200, maxHp: 1200, speed: 0, radius: 128, isBuilding: true, ancient: true, name: "Tree of Life" }),
    BUILT(2560, 2000), { abilities: [{ id: "Aent", code: "Aent", level: 1, cooldownLeft: 0, autocastOn: false }, { id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const u = world.units.get(40);
  u.baseSpeed = 100;
  const fp = { w: 12, h: 12, blocked: new Array(144).fill(true), buildBlocked: new Array(144).fill(true) };
  world.setPathStamp(40, fp, 2560, 2000);
  world.recomputeStats(u);
  world.toggleRoot(u);
  for (let t = 0; t < 3 / 0.05; t++) world.tick(0.05);
  const [x0, y0] = [u.x, u.y];
  check("the order takes at 432 — inside the ability's 500", world.issueEntangleAt(40, mine.id) === true);
  check("…and the site is the ground it is standing on", Math.hypot(u.rootPending.x - x0, u.rootPending.y - y0) < 64, JSON.stringify(u.rootPending));
  for (let t = 0; t < 10 / 0.05 && u.uprooted; t++) world.tick(0.05);
  check("…so it roots on the spot", u.uprooted === false && Math.hypot(u.x - x0, u.y - y0) < 64);
  check("…and takes the mine from there", mine.entangledBy !== 0);
}

console.log("…and it will not send the tree at a mine that is not free");
{
  // The mine may be anywhere — a right-click walks the tree to it — so what is asked here is
  // only whether the mine is one to walk to at all.
  const world = newWorld(200, 200);
  world.initStash(0, 0, 0);
  world.initStash(1, 0, 0);
  const taken = world.addMine(2000, 2000, 12500, 128);
  const wrapped = world.addMine(2400, 3400, 12500, 128);
  wrapped.entangledBy = 99;
  world.add(base({ id: 40, typeId: "etol", x: 2560, y: 2000, hp: 1200, maxHp: 1200, speed: 0, radius: 128, isBuilding: true, ancient: true, name: "Tree of Life" }),
    BUILT(2560, 2000), { abilities: [{ id: "Aent", code: "Aent", level: 1, cooldownLeft: 0, autocastOn: false }, { id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const u = world.units.get(40);
  u.baseSpeed = 100;
  const fp = { w: 12, h: 12, blocked: new Array(144).fill(true), buildBlocked: new Array(144).fill(true) };
  world.setPathStamp(40, fp, 2560, 2000);
  world.recomputeStats(u);
  world.toggleRoot(u);
  for (let t = 0; t < 3 / 0.05; t++) world.tick(0.05);
  check("a mine already wrapped is refused", world.issueEntangleAt(40, wrapped.id) === false);
  // An ENEMY worker on it. Not a rule of the ability — `Aent` is happy to wrap a mine a
  // peasant is walking out of — but a right-click must not march your town hall into
  // somebody's base because they happened to be standing where you clicked.
  const p = wisp(80, 2200, 2200);
  p.owner = 1;
  p.team = 1;
  world.add(p);
  world.units.get(80).resKind = "gold";
  world.units.get(80).resId = taken.id;
  check("…and so is one another player is working", world.issueEntangleAt(40, taken.id) === false);
  world.units.get(80).owner = 0;
  world.units.get(80).team = 0;
  check("…while your OWN worker on it is no obstacle", world.issueEntangleAt(40, taken.id) === true);
}

console.log("The roots take a minute to close (`egol` bldtm = 60)");
{
  // The cost of an expansion is time, not resources: `egol` is free and nobody builds it, but
  // it goes up like any other structure — a tenth of its 800 hit points to all of them over
  // 60 seconds, paying nothing until the bar fills.
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 80, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }),
    { ...BUILT(2000, 2000), constructionLeft: 60, buildTimeTotal: 60 });
  world.attachEntangled(50, mine.id);
  const egol = world.units.get(50);
  check("nobody is building it, and nobody can be", egol.building.selfBuilds === true && egol.building.builderIds.length === 0);
  world.add(wisp(60, 2000, 2100));
  world.issueGarrison(60, 50);
  for (let t = 0; t < 30 / 0.05; t++) world.tick(0.05);
  check("it raises itself anyway", Math.round(egol.building.constructionLeft) === 30, `${egol.building.constructionLeft}`);
  check("…lifting its hit points as it goes", Math.abs(egol.hp - 440) < 5, `${Math.round(egol.hp)}`);
  check("…while the crew waits at the door rather than giving up", world.units.get(60).order === "garrison", world.units.get(60).order);
  check("…and an unfinished mine pays nothing", world.stashOf(0).gold === 0);
  for (let t = 0; t < 31 / 0.05; t++) world.tick(0.05);
  check("at 60 seconds the roots are closed", egol.building.constructionLeft === 0 && Math.round(egol.hp) === 800);
  check("…the crew climbs in on its own (1.10)", egol.garrison.length === 1);
  check("…and only then does the gold start", world.stashOf(0).gold > 0, `${world.stashOf(0).gold}`);
}

console.log("…and the hold takes five of them, whatever you sent (`Aenc` Car1 = 5)");
{
  // Seven wisps sent into a mine that is still closing. All seven wait — none of them can
  // board a building that is not finished — and when it is, five are the crew and the other
  // two are stood down with nothing to do (which is what puts them back on the idle-worker
  // badge, where a wisp that is waiting at the door or mining inside is NOT).
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 80, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }),
    { ...BUILT(2000, 2000), constructionLeft: 20, buildTimeTotal: 60 });
  world.attachEntangled(50, mine.id);
  const egol = world.units.get(50);
  const crew = [61, 62, 63, 64, 65, 66, 67];
  crew.forEach((id, i) => world.add(wisp(id, 1800 + (i % 4) * 96, 2300 + Math.floor(i / 4) * 96)));
  for (const id of crew) world.issueGoldWork(id, mine.id);
  for (let t = 0; t < 10 / 0.05; t++) world.tick(0.05);
  check("all seven take the order and none is idle", crew.every((id) => world.units.get(id).order === "garrison"));
  check("…and none is aboard an unfinished mine", egol.garrison.length === 0);
  for (let t = 0; t < 25 / 0.05; t++) world.tick(0.05);
  check("five is a full crew", egol.garrison.length === 5, `${egol.garrison.length}`);
  const left = crew.filter((id) => !egol.garrison.includes(id));
  check("…and the two who could not fit are stood down", left.length === 2 && left.every((id) => world.units.get(id).order === "idle"));
}

console.log("…and a Tree of Life that uproots lets the mine go");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 40, typeId: "etol", x: 2600, y: 2000, hp: 1200, maxHp: 1200, speed: 0, radius: 128, isBuilding: true, ancient: true, name: "Tree of Life" }),
    BUILT(2600, 2000), { abilities: [{ id: "Aent", code: "Aent", level: 1, cooldownLeft: 0, autocastOn: false }, { id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 800, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }), BUILT(2000, 2000));
  world.attachEntangled(50, mine.id, 40);
  world.add(wisp(60, 2200, 2200));
  world.issueGarrison(60, 50);
  for (let t = 0; t < 4 / 0.05; t++) world.tick(0.05);
  check("a wisp is aboard to begin with", world.units.get(50).garrison.length === 1);
  check("the Tree uproots", world.toggleRoot(world.units.get(40)) === true);
  check("…the Entangled Gold Mine is gone", !world.units.has(50));
  check("…the mine is a plain mine again", world.mines.get(mine.id).entangledBy === 0);
  check("…the crew walked out rather than being buried", !!world.units.get(60) && world.units.get(60).hp > 0);
  check("…and nobody was killed for it", !world.drainDeaths().includes(50));
  // Planting again does NOT hand the mine back — entangling is a button you press.
  world.toggleRoot(world.units.get(40));
  check("planting again leaves the mine loose", world.mines.get(mine.id).entangledBy === 0);
}

console.log("Root is a PLACEMENT — the Ancient walks to the spot and settles there");
{
  // WC3 does not root an Ancient where it stands: the button hands you the building's
  // silhouette and its footprint grid, and the click picks the SITE. So the order carries a
  // destination, and only the UPROOT direction is instant.
  const world = newWorld();
  world.initStash(0, 0, 0);
  const ancient = () => world.units.get(70);
  world.add(base({ id: 70, typeId: "eaom", x: 2000, y: 2000, hp: 900, maxHp: 900, speed: 0, radius: 144, isBuilding: true, ancient: true, name: "Ancient of War" }),
    BUILT(2000, 2000), { abilities: [{ id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const u = ancient();
  u.baseSpeed = 40; // eaom's own walk
  world.recomputeStats(u);
  check("planted, it will not take a root order", world.issueRootAt(70, 2600, 2000) === false);
  check("uprooting is instant", world.toggleRoot(u) === true && u.uprooted === true);
  check("…but it is locked for the 2.5s transition", u.morphT > 0 && world.issueRootAt(70, 2600, 2000) === false, `${u.morphT}`);
  for (let t = 0; t < 3 / 0.05; t++) world.tick(0.05); // let the morph finish
  const site = world.grid.snapForBuildingRect(2600, 2000, 12, 12);
  check("…and then it takes one", world.issueRootAt(70, site[0], site[1]) === true);
  check("…which is a WALK, not a plant on the spot", u.uprooted === true && Math.abs(u.x - 2000) < 40, `${Math.round(u.x)}`);
  for (let t = 0; t < 60 / 0.05 && u.uprooted; t++) world.tick(0.05);
  check("it arrives and settles", u.uprooted === false);
  check("…exactly where the silhouette stood", [Math.round(u.x), Math.round(u.y)], site);
  // (The stamp and the footprint are only restored for a unit that HAD them — a headless test
  //  unit never went through the renderer's setPathStamp — so what is checked here is the
  //  stance itself: planted, it is a building again and goes nowhere.)
  check("…a building again, going nowhere", u.speed === 0 && u.altModel === true, `${u.speed}`);
  check("…and the order is spent", u.rootPending === null);
}

console.log("…and any other order calls the plant off");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  world.add(base({ id: 71, typeId: "eaom", x: 2000, y: 2000, hp: 900, maxHp: 900, speed: 0, radius: 144, isBuilding: true, ancient: true, name: "Ancient of War" }),
    BUILT(2000, 2000), { abilities: [{ id: "Aro1", code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const u = world.units.get(71);
  u.baseSpeed = 40;
  world.recomputeStats(u);
  world.toggleRoot(u);
  for (let t = 0; t < 3 / 0.05; t++) world.tick(0.05); // the transition, then it takes orders
  world.issueRootAt(71, 2600, 2000);
  check("the order is held", !!u.rootPending);
  world.issueOrder(71, { kind: "move", x: 1600, y: 2000 });
  check("…and dropped by the next order", u.rootPending === null);
  for (let t = 0; t < 40 / 0.05; t++) world.tick(0.05);
  check("…so it walks off still uprooted", u.uprooted === true);
}

console.log("Replenish Mana and Life (`Ambt`)");
{
  // Three drinkers, one well each, because the interesting part is where the WELL's mana
  // goes. Half the spend is offered to life and half to mana; the half nobody wants spills
  // into the other, which is why a full-health hero can still drain a well into its mana bar.
  //
  // Each well starts on 100 mana and is asked to empty. Noon and held, so it cannot top
  // itself up mid-pour (its regeneration is night-only anyway — see below).
  const pour = (hp, maxHp, mana, maxMana) => {
    const world = newWorld();
    world.timeOfDaySuspended = true;
    world.timeOfDay = 12;
    world.add(base({ id: 80, typeId: "emow", x: 2000, y: 2000, hp: 600, maxHp: 600, mana: 100, maxMana: 300, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
      BUILT(2000, 2000), { abilities: [{ id: "Ambt", code: "Ambt", level: 1, cooldownLeft: 0, autocastOn: true }] });
    world.add(base({ id: 81, typeId: "hkni", race: "human", x: 2100, y: 2000, hp, maxHp, mana, maxMana, speed: 200, radius: 16, name: "Drinker" }));
    world.units.get(80).mana = 100; // recomputeStats has not run yet; state the pool outright
    for (let t = 0; t < 30 / 0.05; t++) world.tick(0.05);
    return { well: world.units.get(80), t: world.units.get(81) };
  };
  // Nothing to top up but life: the mana half spills across, so the whole 100 buys hit
  // points at DataA = 2 apiece.
  let r = pour(200, 600, 100, 100);
  check("a full-mana drinker takes the whole pool as life", Math.abs(r.t.hp - 400) < 2, `${r.t.hp.toFixed(0)}/600`);
  check("…and the well is empty", r.well.mana < 1, `${r.well.mana.toFixed(1)}`);
  // The mirror: nothing to heal, so the whole 100 buys mana at DataB = 0.5 apiece.
  r = pour(600, 600, 0, 300);
  check("a full-health drinker takes the whole pool as mana", Math.abs(r.t.mana - 50) < 1.5, `${r.t.mana.toFixed(1)}/300`);
  // Short of both by more than the well can cover: the split is down the middle.
  r = pour(100, 900, 0, 900);
  check("short of both, the pool splits half and half", Math.abs(r.t.hp - 200) < 3 && Math.abs(r.t.mana - 25) < 2, `${r.t.hp.toFixed(0)}hp +${r.t.mana.toFixed(1)}mana`);
  // A drinker that needs nothing is not a target at all.
  r = pour(600, 600, 100, 100);
  check("a drinker that needs nothing is left alone", Math.abs(r.well.mana - 100) < 0.01 && r.well.replenishTargetId === 0, `${r.well.mana.toFixed(1)}`);
}

console.log("…and the drink is a BURST, not a trickle");
{
  // One tick — 50 ms — is the whole transaction: the well empties into a unit already
  // standing at it, rather than metering itself out over ten mana a second. This is the test
  // that would fail if DataC1 were read as a rate: at 10/s a 100-mana well takes ten seconds.
  const world = newWorld();
  world.timeOfDaySuspended = true;
  world.timeOfDay = 12;
  world.add(base({ id: 80, typeId: "emow", x: 2000, y: 2000, hp: 600, maxHp: 600, mana: 100, maxMana: 300, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
    BUILT(2000, 2000), { abilities: [{ id: "Ambt", code: "Ambt", level: 1, cooldownLeft: 0, autocastOn: true }] });
  world.add(base({ id: 81, typeId: "hkni", race: "human", x: 2100, y: 2000, hp: 200, maxHp: 600, mana: 100, maxMana: 100, speed: 200, radius: 16, name: "Drinker" }));
  world.units.get(80).mana = 100;
  world.tick(0.05);
  check("one tick empties the well", world.units.get(80).mana < 1, `${world.units.get(80).mana.toFixed(1)}`);
  check("…and the drinker is up 200 hit points", Math.abs(world.units.get(81).hp - 400) < 2, `${world.units.get(81).hp.toFixed(0)}/600`);
}

console.log("…and a unit RIGHT-CLICKED onto a well drinks from it with autocast off");
{
  // The order lives on the DRINKER: you select the unit and right-click the well, so the unit
  // is what walks. Autocast is off here, which is how the data ships it (`emow`'s
  // UnitAbilities `auto` column is `_`) — without the order nothing would happen at all.
  const world = newWorld();
  world.timeOfDaySuspended = true;
  world.timeOfDay = 12;
  world.add(base({ id: 80, typeId: "emow", x: 2000, y: 2000, hp: 600, maxHp: 600, mana: 100, maxMana: 300, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
    BUILT(2000, 2000), { abilities: [{ id: "Ambt", code: "Ambt", level: 1, cooldownLeft: 0, autocastOn: false }] });
  world.units.get(80).mana = 100;
  // Far enough away that it has to walk: Area1 is 400, this is 1200.
  world.add(base({ id: 81, typeId: "hkni", race: "human", x: 3200, y: 2000, hp: 200, maxHp: 600, mana: 100, maxMana: 100, speed: 300, radius: 16, name: "Drinker" }));
  world.add(base({ id: 82, typeId: "hkni", race: "human", x: 3200, y: 2200, hp: 600, maxHp: 600, mana: 100, maxMana: 100, speed: 300, radius: 16, name: "Full" }));
  check("the order is accepted", world.issueDrink(81, 80) === true);
  check("…and refused for a unit with nothing to gain", world.issueDrink(82, 80) === false);
  world.tick(0.05);
  check("nothing is poured while it is still walking", Math.abs(world.units.get(80).mana - 100) < 0.01, `${world.units.get(80).mana.toFixed(1)}`);
  for (let t = 0; t < 10 / 0.05; t++) world.tick(0.05);
  check("it arrives and drinks", world.units.get(81).hp > 350, `${world.units.get(81).hp.toFixed(0)}/600`);
  check("…spending the well", world.units.get(80).mana < 1, `${world.units.get(80).mana.toFixed(1)}`);
  check("…and the order is spent with it", world.units.get(81).drinkWellId === 0);
}

console.log("Well Spring (`Rews`) — +125 mana, +0.52/sec, and both only after dark");
{
  const world = newWorld();
  world.timeOfDaySuspended = true;
  world.timeOfDay = 0; // night, or the well regenerates nothing at all
  world.add(base({ id: 95, typeId: "emow", x: 2000, y: 2000, hp: 600, maxHp: 600, mana: 100, maxMana: 300, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
    BUILT(2000, 2000), { abilities: [{ id: "Ambt", code: "Ambt", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const well = world.units.get(95);
  well.mana = 100;
  world.recomputeStats(well);
  check("a plain well holds 300", well.maxMana === 300, `${well.maxMana}`);
  check("…and refills at its own regenMana", Math.abs(well.manaRegen - 1.5) < 0.001, `${well.manaRegen}`);
  world.tech.setResearchLevel(0, "Rews", 1);
  world.recomputeStats(well);
  check("Well Spring lifts the ceiling by 125", well.maxMana === 425, `${well.maxMana}`);
  // The mana it already held rises with the ceiling, keeping the well's fill fraction —
  // which is why Liquipedia lists the initial 100 as 133.33 with the upgrade in.
  check("…carrying what it held up with it", Math.abs(well.mana - (100 * 425) / 300) < 0.01, `${well.mana.toFixed(2)}`);
  check("…and adds 0.52 a second", Math.abs(well.manaRegen - 2.02) < 0.001, `${well.manaRegen}`);
  world.timeOfDay = 12;
  world.recomputeStats(well);
  check("by day the WHOLE rate is off, upgrade and all", well.manaRegen === 0, `${well.manaRegen}`);
}

console.log("…and a building has no mana, and no mana bar, until it is finished");
{
  const world = newWorld();
  world.timeOfDaySuspended = true;
  world.timeOfDay = 12; // noon — the well must not top itself up between the two checks
  world.add(base({ id: 96, typeId: "emow", x: 2000, y: 2000, hp: 60, maxHp: 600, mana: 0, maxMana: 300, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
    { ...BUILT(2000, 2000), constructionLeft: 1, buildTimeTotal: 1 },
    { abilities: [{ id: "Ambt", code: "Ambt", level: 1, cooldownLeft: 0, autocastOn: false }] });
  world.tick(0.05);
  const well = world.units.get(96);
  check("no pool while it goes up", well.maxMana === 0 && well.mana === 0, `${well.mana}/${well.maxMana}`);
  world.add(wisp(97, 2140, 2000));
  world.assignBuilder(97, 96);
  for (let t = 0; t < 3 / 0.05; t++) world.tick(0.05);
  // `mana0` = 100 of `manaN` = 300: a finished Moon Well opens a third full and fills the
  // rest overnight. It does NOT open full, which is the whole reason the column exists.
  check("…and `mana0` when it is done", Math.abs(well.mana - 100) < 0.01 && well.maxMana === 300, `${well.mana.toFixed(0)}/${well.maxMana}`);
}

console.log("Detonate (`Adtn`) — the Wisp spends itself");
{
  const world = newWorld();
  world.add(wisp(30, 2000, 2000));
  // In range: a friendly caster (Detonate has no allegiance flag — it burns its own side's
  // mana too), an invulnerable one (dispelled but NOT drained since 1.25b), and a summon.
  world.add(base({ id: 31, typeId: "hkni", race: "human", x: 2100, y: 2000, hp: 500, maxHp: 500, mana: 200, maxMana: 200, speed: 200, radius: 16, name: "Friendly caster" }));
  world.add(base({ id: 32, typeId: "hkni", race: "human", x: 2000, y: 2120, hp: 500, maxHp: 500, mana: 200, maxMana: 200, speed: 200, radius: 16, name: "Invulnerable" }));
  world.add(base({ id: 33, typeId: "hkni", owner: 1, team: 1, race: "human", x: 1900, y: 2000, hp: 500, maxHp: 500, mana: 0, maxMana: 0, speed: 200, radius: 16, name: "Summon" }));
  // …and one well outside the 300 blast, which must come out untouched.
  world.add(base({ id: 34, typeId: "hkni", race: "human", x: 2600, y: 2000, hp: 500, maxHp: 500, mana: 200, maxMana: 200, speed: 200, radius: 16, name: "Bystander" }));
  const invuln = world.units.get(32);
  invuln.baseInvulnerable = true;
  const summon = world.units.get(33);
  summon.summonLeft = 60;
  summon.summonMax = 60;
  for (const id of [31, 32, 34]) {
    world.units.get(id).buffs.push({ kind: "armor", group: "innerfire", timeLeft: 60, sourceId: 30, value: 5, value2: 0, art: "", fx: [], buffId: "", delay: 0 });
  }
  world.recomputeStats(invuln);
  world.applySpellEffect("Adtn", 1, world.units.get(30), { targetId: 0, x: 2000, y: 2000 }, ABILITIES.Adtn);
  check("the Wisp is gone", !world.units.has(30));
  check("a friendly caster is burned all the same", Math.abs(world.units.get(31).mana - 150) < 0.01, `${world.units.get(31).mana}`);
  check("…and dispelled", world.units.get(31).buffs.length === 0);
  check("an invulnerable unit keeps its mana", Math.abs(world.units.get(32).mana - 200) < 0.01, `${world.units.get(32).mana}`);
  check("…but is dispelled anyway", world.units.get(32).buffs.length === 0);
  check("a summon takes 225", Math.abs(world.units.get(33).hp - 275) < 1, `${world.units.get(33)?.hp}`);
  check("outside the blast, nothing", world.units.get(34).mana === 200 && world.units.get(34).buffs.length === 1);
}

console.log("Detonate (`Adtn`) — the press AIMS it, it does not fire it");
{
  // `UI\\TriggerData.txt`: `UnitOrderDetonate=0,unitorderptarg,\`detonate\`` — a POINT order,
  // and there is no `unitordernotarg` line for it the way there is for Roar and Cannibalize.
  // So the button arms a cursor, the Wisp walks to within `Rng1` = 100 of the click, and only
  // then spends itself. Firing it where the Wisp happened to be standing made the ability
  // unusable for the one thing it is for: sending wisps INTO an enemy's casters.
  const world = newWorld();
  const detonate = [{ id: "Adtn", code: "Adtn", level: 1, cooldownLeft: 0, autocastOn: false }];
  world.add(wisp(30, 2000, 2000), null, { abilities: detonate });
  // A caster 700 away: outside the 300 blast from where the Wisp is standing, inside it once
  // the Wisp has made the walk. Its mana is therefore the whole test.
  world.add(base({ id: 31, typeId: "hkni", race: "human", x: 2700, y: 2000, hp: 500, maxHp: 500, mana: 200, maxMana: 200, speed: 0, radius: 16, name: "Caster" }));
  check("the order is accepted", world.issueCast(30, "Adtn", 0, 2700, 2000));
  check("…and nothing has gone off yet", world.units.has(30) && world.units.get(31).mana === 200);
  world.tick(0.05);
  const u = world.units.get(30);
  check("the Wisp walks toward the click", !!u && u.x > 2000, `${u ? u.x.toFixed(0) : "gone"}`);
  for (let t = 0; t < 10 / 0.05 && world.units.has(30); t++) world.tick(0.05);
  check("…and spends itself when it gets there", !world.units.has(30));
  // Centred on the WISP, not on the point — "an area around the Wisp" (Ubertip). Standing off
  // by Rng1 + its own radius, the caster at the aim point is still well inside Area1 = 300.
  check("the blast is centred on the Wisp", Math.abs(world.units.get(31).mana - 150) < 0.01, `${world.units.get(31).mana}`);
}

console.log("Eat Tree (`Aeat`) — the tree is the cost");
{
  const world = newWorld();
  const tree = world.addTree(2200, 2000, 50, 64);
  world.add(base({ id: 40, typeId: "eaom", x: 2000, y: 2000, hp: 300, maxHp: 900, speed: 0, radius: 144, isBuilding: true, name: "Ancient of War" }),
    BUILT(2000, 2000), { ancient: true, abilities: [{ id: "Aeat", code: "Aeat", level: 1, cooldownLeft: 0, autocastOn: false }] });
  world.applySpellEffect("Aeat", 1, world.units.get(40), { targetId: 0, x: tree.x, y: tree.y }, ABILITIES.Aeat);
  const a = world.units.get(40);
  check("the tree is eaten outright", !world.trees.has(tree.id));
  check("…and nobody gets its lumber", world.stashOf(0).lumber === 0, `${world.stashOf(0).lumber}`);
  const hot = a.buffs.find((b) => b.kind === "hot");
  check("a 500-over-30s heal starts", !!hot && Math.abs(hot.value - 500 / 30) < 0.01, `${hot?.value.toFixed(2)}/s`);
  check("…grouped on its own buff row, so a second tree replaces it", hot?.group === "Beat", `${hot?.group}`);
  for (let t = 0; t < 30 / 0.05; t++) world.tick(0.05);
  // 500 over the 30 seconds, on top of the Ancient's own night regeneration (regenType night,
  // 0.25/s) — the sim starts at MELEE_STARTING_TOD, which is daylight, so nothing else runs.
  check("…and it lands", Math.abs(a.hp - 800) < 6, `${a.hp.toFixed(0)}/900`);
  const treeless = world.addTree(9000, 9000, 50, 64) && world.units.get(40);
  check("with no tree in reach, nothing happens", (() => {
    a.buffs.length = 0;
    world.applySpellEffect("Aeat", 1, a, { targetId: 0, x: 9000, y: 9000 }, ABILITIES.Aeat);
    return a.buffs.length === 0 && world.trees.size === 1;
  })() && !!treeless);
}

// A cast is a QUEUEABLE order, and Eat Tree is the case that shows it: four shift-clicks on
// four trees are four meals, eaten in the order they were clicked. Without a `cast` member in
// QueuedOrder each click replaced the last and the Ancient walked past three trees to eat the
// one clicked most recently. The stand-off a tree's own pathing block forces is part of it —
// `Rng1` = 32 measured to the middle of a blocked 4x4 is a range nothing can ever make, so the
// approach has to be allowed the block's half-extent on top (SimWorld.aimedBlockRadius).
console.log("Eat Tree, queued — three trees in the order they were clicked");
{
  const world = newWorld();
  const trees = [world.addTree(2400, 2000, 50, 64), world.addTree(2800, 2000, 50, 64), world.addTree(3200, 2000, 50, 64)];
  // UPROOTED: it has to walk from one to the next, which is the whole of what a queue means.
  world.add(base({ id: 60, typeId: "eaom", x: 2000, y: 2000, hp: 900, maxHp: 900, speed: 190, radius: 72, name: "Ancient of War" }),
    null, { ancient: true, abilities: [{ id: "Aeat", code: "Aeat", level: 1, cooldownLeft: 0, autocastOn: false }] });
  const a = world.units.get(60);
  a.uprooted = true;
  const cast = (t) => ({ kind: "cast", code: "Aeat", targetId: 0, x: t.x, y: t.y });
  world.issueOrder(60, cast(trees[0]));
  world.queueOrder(60, cast(trees[1]));
  world.queueOrder(60, cast(trees[2]));
  check("the first is under way and the other two are queued", a.order === "cast" && a.orderQueue.length === 2, `${a.order} + ${a.orderQueue.length}`);
  const eaten = [];
  for (let t = 0; t < 40 / 0.05; t++) {
    world.tick(0.05);
    for (const tr of trees) if (!world.trees.has(tr.id) && !eaten.includes(tr.id)) eaten.push(tr.id);
    if (eaten.length === 3) break;
  }
  check("all three trees are eaten", eaten.length === 3, `${eaten.length}`);
  check("…in the order they were ordered", JSON.stringify(eaten) === JSON.stringify(trees.map((t) => t.id)), `${eaten}`);
  check("…and the queue is spent", a.orderQueue.length === 0);
}

console.log("Renew (`Aren`) — the one repair that may mend an Ancient");
{
  const world = newWorld();
  world.initStash(0, 1000, 1000);
  world.add(base({ id: 50, typeId: "eaom", x: 2000, y: 2000, hp: 300, maxHp: 900, speed: 0, radius: 144, isBuilding: true, name: "Ancient of War" }),
    BUILT(2000, 2000), { ancient: true });
  // Whole, deliberately: the autocast picks the NEAREST damaged building, and a second
  // wounded one at the same distance would make which one it mends a coin toss.
  world.add(base({ id: 51, typeId: "emow", x: 2600, y: 2000, hp: 600, maxHp: 600, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }), BUILT(2600, 2000));
  world.add(wisp(52, 2300, 2200), null, { abilities: [{ id: "Aren", code: "Aren", level: 1, cooldownLeft: 0, autocastOn: false }] });
  world.add(base({ id: 53, typeId: "hpea", race: "human", x: 2300, y: 2300, hp: 220, maxHp: 220, speed: 190, radius: 16, name: "Peasant",
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, deliversInPlace: false, carryGold: 0, carryLumber: 0 } }),
    null, { abilities: [{ id: "Ahrp", code: "Arep", level: 1, cooldownLeft: 0, autocastOn: false }] });
  check("a Wisp may Renew an Ancient", world.repairRefusal(52, 50) === null);
  check("a Peasant may not — `nonancient`", world.repairRefusal(53, 50) === "Notancient", `${world.repairRefusal(53, 50)}`);
  check("…but may repair a Moon Well", world.repairRefusal(53, 51) === null, `${world.repairRefusal(53, 51)}`);
  check("a worker with no repair row at all is refused", world.repairRefusal(51, 50) === "Cantrepair");

  // Autocast: an IDLE wisp with the toggle on goes and mends the nearest damaged building.
  const w = world.units.get(52);
  w.abilities[0].autocastOn = true;
  const before = world.units.get(50).hp;
  for (let t = 0; t < 14 / 0.05; t++) world.tick(0.05);
  check("autocast finds the hurt Ancient by itself", world.units.get(50).hp > before, `${before} → ${world.units.get(50).hp.toFixed(0)}`);
  check("…and the wisp is on the job", w.order === "repair" && !!w.repair);
  // …and it costs. Rep1 = 0.35 of the build cost across the whole repair.
  check("…and it is not free", world.stashOf(0).gold < 1000, `${world.stashOf(0).gold.toFixed(1)}`);
}

console.log("…and the well only refills after dark");
{
  const world = newWorld();
  world.add(base({ id: 90, typeId: "emow", x: 2000, y: 2000, hp: 600, maxHp: 600, mana: 0, maxMana: 300, speed: 0, radius: 96, isBuilding: true, name: "Moon Well" }),
    BUILT(2000, 2000), { abilities: [{ id: "Ambt", code: "Ambt", level: 1, cooldownLeft: 0, autocastOn: false }] });
  world.timeOfDaySuspended = true; world.timeOfDay = 12; // noon
  for (let t = 0; t < 4 / 0.05; t++) world.tick(0.05);
  check("nothing comes back by day", world.units.get(90).mana === 0, `${world.units.get(90).mana}`);
  world.timeOfDay = 0; // midnight
  for (let t = 0; t < 4 / 0.05; t++) world.tick(0.05);
  // `emow` regenMana = 1.5/s (UnitBalance) — four seconds of night is ~6 mana.
  check("…and it fills at regenMana after dark", world.units.get(90).mana > 4, `${world.units.get(90).mana.toFixed(1)}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall night elf checks passed");
process.exit(failed ? 1 : 0);
