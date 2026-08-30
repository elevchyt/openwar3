// What a build row COSTS the AI, which for a tier-up is not what the row's own building costs.
//
// THE BUG. A structure upgrade is charged the DIFFERENCE between the two buildings — in WC3 and
// in our own authority (game/authority.ts "upgradebuilding": a Keep at 705/415 over a Town Hall
// at 385/205 is 320/210). `OneBuildLoop` priced it at the new building's whole row instead, so a
// `SetBuildUnit(1, KEEP)` made the computer wait until it had banked 705 gold and 415 lumber —
// more than twice what the player is actually charged. And because a unit row HALTS the loop
// while it cannot afford itself, it was not merely late: every row below it in the ladder
// starved for the whole of that wait. That is the developer's report, "Computer+ is staying at
// Tier 1 for way too long for all races", and it applies to the classic melee AI just as much,
// since both spend down the same build array.
//
// Pinned from the OUTSIDE — a build array, a stash, and what the AI actually asks the authority
// for — because the price is only interesting insofar as it changes the order that comes out.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { AiPlayer } = require(join(REPO, ".sim-build", "src", "ai", "aiPlayer.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The two halls, on the game's own numbers (UnitBalance.slk goldcost/lumbercost). The upgrade
// between them is 320/210.
const DEFS = {
  htow: { goldCost: 385, lumberCost: 205, isBuilding: true, isHero: false, classification: [], foodUsed: 0, foodMade: 0, weapons: [] },
  hkee: { goldCost: 705, lumberCost: 415, isBuilding: true, isHero: false, classification: [], foodUsed: 0, foodMade: 0, weapons: [] },
  hbar: { goldCost: 160, lumberCost: 50, isBuilding: true, isHero: false, classification: [], foodUsed: 0, foodMade: 0, weapons: [] },
  hpea: { goldCost: 75, lumberCost: 0, buildTime: 15, isBuilding: false, isHero: false, classification: ["peon"], foodUsed: 1, foodMade: 0, weapons: [] },
  // …and a tower and its upgraded form, to put a SECOND upgrade row under the tier-up with.
  hwtw: { goldCost: 70, lumberCost: 20, isBuilding: true, isHero: false, classification: [], foodUsed: 0, foodMade: 0, weapons: [] },
  hgtw: { goldCost: 100, lumberCost: 40, isBuilding: true, isHero: false, classification: [], foodUsed: 0, foodMade: 0, weapons: [] },
  // …and an altar and a hero, for the REVIVAL half. A Blademaster is 425/100 (UnitBalance
  // goldcost/lumbercost) and the altar it comes back at trains exactly its own race's four.
  oalt: { goldCost: 180, lumberCost: 50, isBuilding: true, isHero: false, classification: [], foodUsed: 0, foodMade: 0, weapons: [] },
  Obla: { goldCost: 425, lumberCost: 100, buildTime: 55, isBuilding: false, isHero: true, classification: [], foodUsed: 5, foodMade: 0, weapons: [] },
};

/**
 * A world with a finished ALTAR of ours and one hero of ours lying dead in front of it.
 *
 * The revive ladder is what the row has to be priced against — see `AiPlayer.rowCost`. The
 * factors are the game's (`MiscGame` ReviveBaseFactor 0.4, ReviveLevelFactor 0.1), so a
 * 425-gold Blademaster costs 170 to bring back at level 1 and 425 at level 7: the base cost is
 * wrong in both directions and the row has to save for the real one.
 */
function fallenSeat(gold, level, opts = {}) {
  const altar = {
    id: 1, owner: 0, typeId: "oalt", hp: 100, maxHp: 100, x: 0, y: 0,
    building: { constructionLeft: 0, queue: [] },
    orderQueue: [],
  };
  // A revival already under way is a job in the altar's queue whose `unitId` is the HERO's type
  // — the census has to count it, or the row asks again for the whole minute it takes.
  if (opts.reviving) altar.building.queue.push({ kind: "revive", unitId: "Obla", heroId: 9 });
  const asked = [];
  const host = {
    world: {
      units: new Map([[1, altar]]),
      mines: new Map(),
      nearestMine: () => null,
      stashOf: () => ({ gold, lumber: 1000 }),
      pendingTrained: () => [],
      fallenHeroesOf: () => [{ id: 9, owner: 0, typeId: "Obla", level, revivingAt: opts.reviving ? 1 : 0 }],
    },
    registry: { get: (id) => DEFS[id] },
    tech: { get: () => ({ upgrade: [], revive: true, trains: ["Obla"] }) },
    execute: (_player, cmd) => {
      asked.push(cmd);
      return true;
    },
  };
  return { ai: new AiPlayer(0, "orc", 1, host, 0, 0, 1), asked };
}

/** A world with one finished Town Hall of ours standing in it, and a stash we can set. */
function seat(gold, lumber, opts = {}) {
  const hall = {
    id: 1, owner: 0, typeId: "htow", hp: 100, maxHp: 100, x: 0, y: 0,
    building: { constructionLeft: 0, queue: opts.busy ? [{ kind: "unit", unitId: "hpea" }] : [] },
    orderQueue: [],
  };
  const tower = {
    id: 2, owner: 0, typeId: "hwtw", hp: 100, maxHp: 100, x: 256, y: 0,
    building: { constructionLeft: 0, queue: [] },
    orderQueue: [],
  };
  const asked = [];
  // MUTABLE, so a test can let the income arrive between passes — see the stall valve below.
  const stash = { gold, lumber };
  const host = {
    world: {
      units: new Map([[1, hall], [2, tower]]),
      mines: new Map(),
      nearestMine: () => null,
      hauntsMines: () => false,
      stashOf: () => stash,
      pendingTrained: () => [],
    },
    registry: { get: (id) => DEFS[id] },
    tech: {
      get: (id) => ({ upgrade: id === "htow" ? ["hkee"] : id === "hwtw" ? ["hgtw"] : [] }),
      trains: (id) => (id === "htow" ? ["hpea"] : []),
    },
    execute: (_player, cmd) => {
      asked.push(cmd);
      return true;
    },
  };
  return { ai: new AiPlayer(0, "human", 1, host, 0, 0, 1), asked, stash };
}

// ==========================================================================================
console.log("\n-- a tier-up is priced as the UPGRADE it is --------------------------------");
// ==========================================================================================

// 320 gold and 210 lumber is the whole price of a Keep over a Town Hall, and it is enough.
{
  const { ai, asked } = seat(320, 210);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hkee");
  ai.runBuildLoop();
  check("the Keep is ordered on the difference", asked.map((c) => c.c), ["upgradebuilding"]);
  check("…of the hall we are standing on", asked[0]?.toTypeId, "hkee");
}
// A gold short of it, and nothing happens — the row is a real gate, not a rounding.
{
  const { ai, asked } = seat(319, 210);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hkee");
  ai.runBuildLoop();
  check("a gold short and it waits", asked.length, 0);
}
{
  const { ai, asked } = seat(320, 209);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hkee");
  ai.runBuildLoop();
  check("…and a lumber short too", asked.length, 0);
}

// THE ROWS BELOW IT. The loop RETURNS at the first unit row it cannot afford, so the old price
// did not merely delay the Keep — it held everything under it for as long as the AI was short of
// a sum it was never charged. With the true price both rows are reached in one pass.
{
  const { ai, asked } = seat(350, 230);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hkee");
  ai.setBuildUnit(1, "hgtw");
  ai.runBuildLoop();
  check("the ladder under the tier-up is reached", asked.map((c) => c.toTypeId), ["hkee", "hgtw"]);
}

// …and the RESERVATION is the upgrade's too, which is the same fact from the other side: 350
// gold pays for the Keep (320) and the tower (30), where the old price deducted 705 for the Keep
// and left the row under it nothing whatever.

// FOUNDING one is a different thing and still costs the whole row. Nothing of ours upgrades into
// a Barracks, so its 160/50 is its price — and a Keep with no hall to raise from would be too.
{
  const { ai, asked } = seat(159, 300);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hbar");
  ai.runBuildLoop();
  check("a building we FOUND is priced whole", asked.length, 0);
}

// A BUSY HALL IS STILL A CHEAP KEEP. The price used to be asked of the idle-only
// `upgradeCandidates` scan, so a hall with a worker in its queue — which is a hall for most of
// the opening, since the worker rows sit above the tier row in every build order there is —
// priced the Keep at its whole 705/415 again. That is the same halt the whole file is about,
// wearing a different hat: what a row COSTS cannot depend on what the building happens to be
// doing this second, and it is `upgradeSources` (standing, busy or not) that decides.
{
  const { ai, asked } = seat(400, 300, { busy: true });
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hkee");
  ai.setBuildUnit(1, "hgtw");
  ai.runBuildLoop();
  // The Keep itself cannot START — `upgradeExisting` needs the hall idle — but it no longer
  // stops the ladder at a price nobody would have charged, so the tower under it is reached.
  check("a busy hall does not halt the ladder at a phantom price", asked.map((c) => c.toTypeId), ["hgtw"]);
}

// …and the hall a row means to UPGRADE takes no worker while it can be paid for. Without this
// the tier-up could be priced perfectly and still never happen: `upgradeExisting` needs an idle
// hall, the worker rows above the tier row re-fill its queue on every pass, and the computer
// therefore sits at tier 1 for as long as it still wants workers — which, with
// `PlusProfile.workers` counted per MINE, is most of a match that expands.
{
  const { ai, asked } = seat(400, 300);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildNext(5, "hpea"); // the worker row, where every build order puts it: above the tier
  ai.setBuildUnit(1, "hkee");
  ai.runBuildLoop();
  check("the hall is held for the tier-up rather than filled with a worker",
    asked.map((c) => c.c), ["upgradebuilding"]);
}
// The hold is only ever for a row that can be PAID for, so no hall is idled waiting on a
// tier-up the player is nowhere near affording.
{
  const { ai, asked } = seat(100, 300);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildNext(5, "hpea");
  ai.setBuildUnit(1, "hkee");
  ai.runBuildLoop();
  check("…and an unaffordable one holds nothing", asked.map((c) => c.c), ["train"]);
}

// ==========================================================================================
console.log("\n-- a halt that is going nowhere lets one pass through -----------------------");
// ==========================================================================================

// `OneBuildLoop` returning at the first row it cannot afford is the file's own rule, and it
// assumes the shortfall SHRINKS. It does not always: a row short of LUMBER on a player with
// nobody in the trees is short of it for ever, and everything below the row — including the rows
// that would have put a worker back on the wood, lifted the food cap or trained the soldier that
// pays for itself — is never read again. `AiPlayer.releaseStall` lets exactly one pass through
// after `STALL_PASSES` passes that have not once got nearer the price.
{
  const { ai, asked } = seat(400, 0); // a Keep wants 210 lumber and nothing is chopping
  let trains = 0;
  for (let pass = 0; pass < 21; pass++) {
    ai.refresh();
    ai.initBuildArray();
    ai.setBuildUnit(1, "hkee");
    ai.setBuildNext(5, "hpea"); // …and underneath it, the row that would fix the lumber
    ai.runBuildLoop();
    trains = asked.filter((c) => c.c === "train").length;
    if (trains > 0) { check(`the ladder is let past on pass ${pass + 1}`, pass >= 19 && pass <= 20, true); break }
  }
  check("a dead-end halt does not hold the ladder for ever", trains, 1);
}
// …and a halt that IS earning is never released. The row gets nearer the price on every pass,
// which resets the count, so a player genuinely saving for a Keep is not interrupted and the
// rows below it wait exactly as `OneBuildLoop` says they should.
{
  const { ai, asked, stash } = seat(0, 300);
  for (let pass = 0; pass < 40; pass++) {
    stash.gold += 5; // the mine paying in, a little at a time
    ai.refresh();
    ai.initBuildArray();
    ai.setBuildUnit(1, "hkee");
    ai.setBuildNext(5, "hpea");
    ai.runBuildLoop();
  }
  check("a halt that is still earning is never released", asked.length, 0);
}

// ==========================================================================================
console.log("\n-- a dead hero's row is priced as the REVIVAL it becomes --------------------");
// ==========================================================================================

// LEVEL 1: 425 × 0.4 = 170. The old price made the ladder save 425 for it — and a unit row that
// cannot afford itself HALTS the loop, so everything under the hero starved for the difference.
{
  const { ai, asked } = fallenSeat(170, 1);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "Obla");
  ai.runBuildLoop();
  check("a level-1 revival costs 170, not 425", asked.map((c) => c.c), ["revive"]);
  check("…and it is the corpse that is raised", asked[0]?.heroId, 9);
}
{
  const { ai, asked } = fallenSeat(169, 1);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "Obla");
  ai.runBuildLoop();
  check("a gold short and it waits", asked.length, 0);
}
// LEVEL 7: 425 × (0.4 + 0.6) = 425 — the one level at which the two prices agree. LEVEL 10 is
// 425 × 1.3 = 552, which the base cost UNDER-reserves: the row used to be declared affordable at
// 425, the rows below spent the difference, and the authority then refused the revival for want
// of the real price while `startUnit` reported success either way.
{
  const { ai, asked } = fallenSeat(551, 10);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "Obla");
  ai.runBuildLoop();
  check("a level-10 revival is not affordable at the base price", asked.length, 0);
}
{
  const { ai, asked } = fallenSeat(552, 10);
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "Obla");
  ai.runBuildLoop();
  check("…and is at its own", asked.map((c) => c.c), ["revive"]);
}
// A REVIVAL ALREADY UNDER WAY satisfies the row. `job.unitId` on a revive job is the hero's own
// type id but its `kind` is "revive", so the census used to skip it: `count(hero)` read 0 for the
// whole minute the altar was working, the row asked again on every pass, and it reserved the
// hero's gold the whole time — starving every row below it.
{
  const { ai, asked } = fallenSeat(2000, 3, { reviving: true });
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "Obla");
  ai.setBuildUnit(1, "oalt");
  ai.runBuildLoop();
  check("a hero already coming back is not asked for twice", asked.filter((c) => c.c === "revive").length, 0);
  check("…and the rows below it are still reached", ai.count("Obla"), 1);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
