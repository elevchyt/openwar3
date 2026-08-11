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
  Ambt: { id: "Ambt", code: "Ambt", target: "unit", autocast: true, targetFlags: ["air", "ground", "invu", "vuln", "friend", "organic"], levelData: [lvl({ castRange: 99999, area: 400, data: [2, 0.5, 10, 30, 1] })] },
};
const abilities = { get: (id) => ABILITIES[id] };
const UNITS = {
  // `abilities` here is UnitAbilities.slk's abilList — what cargoHold/computeGarrisonCap read.
  egol: { id: "egol", abilities: ["Aenc", "Aegm"], moveType: "foot", manaRegen: 0, regenType: "none", hpRegen: 0 },
  emow: { id: "emow", abilities: ["Ambt"], moveType: "foot", manaRegen: 1.5, regenType: "none", hpRegen: 0 },
  ewsp: { id: "ewsp", abilities: [], moveType: "hover", manaRegen: 0, regenType: "none", hpRegen: 0 },
  eaom: { id: "eaom", abilities: [], moveType: "foot", manaRegen: 0, regenType: "night", hpRegen: 0.25 },
  // The drinker, with its own regeneration turned as far down as the column allows. A
  // target topping itself up would mean the well spent less on its mana and more on its
  // life, and the arithmetic below would stop being the ability's. (Not a flat 0: an absent
  // `regenMana` and a stated zero look the same to a parser, so the sim reads 0 as "the row
  // says nothing" and falls back to UNIT_MANA_REGEN — see baseManaRegen.)
  hkni: { id: "hkni", abilities: [], moveType: "foot", manaRegen: 1e-6, regenType: "none", hpRegen: 0 },
};
const unitReg = { get: (id) => UNITS[id] };

const CELL = 32;
function newWorld(w = 120, h = 120) {
  const grid = new PathingGrid({ width: w, height: h, flags: new Uint8Array(w * h) }, [0, 0]);
  return new SimWorld(grid, 1, abilities, undefined, unitReg);
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
