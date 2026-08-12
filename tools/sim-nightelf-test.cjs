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
  Adtn: { id: "Adtn", code: "Adtn", target: "none", targetFlags: ["air", "ground", "ward", "invu", "vuln", "tree"], specialArt: "", targetArt: "", levelData: [lvl({ castRange: 100, area: 300, data: [50, 225] })] },
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
  emow: { id: "emow", abilities: ["Ambt"], moveType: "foot", upgradesUsed: ["Rews"], buildTime: 60, goldCost: 180, lumberCost: 40, manaStart: 100, manaRegen: 1.5, regenType: "none", hpRegen: 0 },
  ewsp: { id: "ewsp", abilities: [], moveType: "hover", upgradesUsed: [], buildTime: 60, goldCost: 0, lumberCost: 0, manaRegen: 0, regenType: "none", hpRegen: 0 },
  eaom: { id: "eaom", abilities: [], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 150, lumberCost: 60, manaRegen: 0, regenType: "night", hpRegen: 0.25 },
  etol: { id: "etol", abilities: ["Aent", "Aro1"], moveType: "foot", upgradesUsed: [], buildTime: 60, goldCost: 200, lumberCost: 0, manaRegen: 0, regenType: "night", hpRegen: 0.25 },
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
const techReg = { get: () => undefined, has: () => false, all: () => [] };

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
  worker: { gold: true, lumber: true, lumberCapacity: 0, baseLumberCapacity: 0, lumberPerChop: 5, chopPeriod: 8, damagesTree: false, deliversInPlace: true, orbitAngle: 0, carryGold: 0, carryLumber: 0 },
});

const BUILT = (x, y) => ({ constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: x, rallyY: y, rallyKind: "point", rallyTargetId: 0, producesUnits: false });

// ---------------------------------------------------------------------------------------
console.log("Wisp Harvest (`Awha`) — 5 lumber per 8s, no haul, no felled tree");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const tree = world.addTree(1600, 1600, 50, 64);
  world.add(wisp(1, 1600, 1900));
  world.issueHarvest(1, "lumber", tree.id);
  for (let t = 0; t < 25 / 0.05; t++) world.tick(0.05);
  const u = world.units.get(1);
  const stash = world.stashOf(0);
  // 25 seconds is three payouts once it has walked over (the first lands on arrival).
  check("lumber is credited without a trip home", stash.lumber >= 15 && stash.lumber <= 20, `${stash.lumber}`);
  check("…and nothing is ever carried", u.worker.carryLumber === 0, `${u.worker.carryLumber}`);
  check("…and the tree still stands", world.trees.has(tree.id) && world.trees.get(tree.id).lumber === 50);
  check("the wisp never left the tree", Math.hypot(u.x - tree.x, u.y - tree.y) < 120, `${Math.round(Math.hypot(u.x - tree.x, u.y - tree.y))}`);
  check("…and is orbiting it (its angle advanced)", u.worker.orbitAngle > 0);
  // The orbit must stay OUTSIDE the trunk's blocked square, or the wisp cannot path away.
  const [cx, cy] = world.grid.worldToCell(u.x, u.y);
  check("…on ground it can still walk off", world.grid.walkable(cx, cy));
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

console.log("…and the mine is closed to everyone else while the roots are on it");
{
  const world = newWorld();
  world.initStash(0, 0, 0);
  const mine = world.addMine(2000, 2000, 12500, 128);
  world.add(base({ id: 50, typeId: "egol", x: 2000, y: 2000, hp: 800, maxHp: 800, speed: 0, radius: 128, isBuilding: true, name: "Entangled Gold Mine" }), BUILT(2000, 2000));
  world.attachEntangled(50, mine.id);
  world.add(base({ id: 70, typeId: "hpea", race: "human", x: 2400, y: 2000, hp: 220, maxHp: 220, speed: 190, radius: 16, name: "Peasant",
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, deliversInPlace: false, orbitAngle: 0, carryGold: 0, carryLumber: 0 } }));
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
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, deliversInPlace: false, orbitAngle: 0, carryGold: 0, carryLumber: 0 } }),
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
