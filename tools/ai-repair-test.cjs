// `SetPeonsRepair` — the pass that sends workers at damaged buildings (`AiPlayer.applyRepairs`).
//
// Reported: "Computer+ AI must be made to repair its buildings, ESPECIALLY its hall (main)
// building" — and neither AI repaired anything at all, at any difficulty. The FLAG is
// Blizzard's and unconditional for melee (`call SetPeonsRepair(true)`, common.ai 792, inside
// `StandardAI`, beside SetGroupsFlee/SetHeroesFlee/SetIgnoreInjured); what the engine does once
// it is set is C++ and in no file in the install, so the POLICY under test here is ours:
//
//   · the HALL outranks everything, sorted before "how hurt is it" and not after it, so a Farm
//     at a tenth of its life never takes the crew off a Town Hall at four fifths;
//   · TWO WORKERS, ever — the developer's own ceiling. A raided base is damaged everywhere, and
//     a per-building crew with no cap over it walks the whole economy into the rubble;
//   · a MINER is the last body taken, because gold is what every other row on the build ladder
//     is bought with (plus/plan.ts `mineCrew`);
//   · a building still GOING UP is built, not repaired.
//
// What is NOT ours and is deliberately not re-stated here: whether a given worker may mend a
// given building at all. Every repair row lists `nonancient` except the Wisp's Renew, so only a
// Wisp mends a Tree of Life, and a Ghoul carries no repair row at all — all of it falls out of
// `SimWorld.repairRefusal`, which this pass asks and does not second-guess.
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

// `UnitBalance.slk`'s own `type` column is what says which building is the hall — all twelve
// melee halls carry `TownHall` (htow/hkee/hcas, ogre/ostr/ofrt, etol/etoa/etoe, unpl/unp1/unp2)
// and nothing else does. `UnitDef.classification` is that column, lowercased and split.
const DEFS = {
  htow: { goldCost: 385, lumberCost: 205, isBuilding: true, classification: ["townhall", "mechanical"], weapons: [] },
  hhou: { goldCost: 80, lumberCost: 20, isBuilding: true, classification: ["mechanical"], weapons: [] },
  hbar: { goldCost: 160, lumberCost: 50, isBuilding: true, classification: ["mechanical"], weapons: [] },
  hpea: { goldCost: 75, lumberCost: 0, isBuilding: false, classification: ["peon"], weapons: [] },
};

let nextId = 1;
function building(typeId, hp, opts = {}) {
  return {
    id: nextId++, owner: 0, typeId, hp, maxHp: 100, x: opts.x ?? 0, y: opts.y ?? 0,
    building: { constructionLeft: opts.constructionLeft ?? 0, queue: [] },
    orderQueue: [], worker: null, repair: null,
    inMine: false, insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false,
  };
}

/** A worker. `job` is what it is doing right now: "idle", "lumber", "gold", or "repair:<id>". */
function worker(job, opts = {}) {
  const u = {
    id: nextId++, owner: 0, typeId: "hpea", hp: 100, maxHp: 100, x: opts.x ?? 0, y: opts.y ?? 0,
    worker: { gold: true, lumber: true }, building: null, orderQueue: [], repair: null,
    order: "idle", resKind: "", resId: 0, inMineId: 0,
    inMine: false, insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false,
    buildPending: false, constructing: false, garrisonHost: 0,
  };
  if (job === "lumber") { u.order = "harvest"; u.resKind = "lumber"; }
  if (job === "gold") { u.order = "harvest"; u.resKind = "gold"; u.inMineId = 0; }
  if (typeof job === "string" && job.startsWith("repair:")) {
    u.order = "repair";
    u.repair = { targetId: Number(job.slice(7)), hpPerSec: 1, goldPerHp: 0, lumberPerHp: 0 };
  }
  return u;
}

/**
 * A seat with `units` standing in it. `refuse` is `SimWorld.repairRefusal`'s answer — the sim's
 * question, stubbed as "yes" unless a test wants the night-elf/Ghoul refusal.
 */
function seat(units, opts = {}) {
  nextId = 1000; // ids the fixtures below don't collide with
  const asked = [];
  const host = {
    world: {
      units: new Map(units.map((u) => [u.id, u])),
      mines: new Map(),
      nearestMine: () => null,
      hauntsMines: () => false,
      stashOf: () => ({ gold: opts.gold ?? 1000, lumber: opts.lumber ?? 1000 }),
      pendingTrained: () => [],
      repairRefusal: (w, b) => (opts.refuse ? opts.refuse(w, b) : null),
    },
    registry: { get: (id) => DEFS[id] },
    tech: { get: () => ({ upgrade: [] }), trains: () => [] },
    execute: (_player, cmd) => {
      asked.push(cmd);
      // Mirror what the authority does, so a second pass in the same fixture sees the crew.
      const u = host.world.units.get(cmd.unitId);
      if (u) { u.order = "repair"; u.repair = { targetId: cmd.buildingId, hpPerSec: 1, goldPerHp: 0, lumberPerHp: 0 }; }
      return true;
    },
  };
  const ai = new AiPlayer(0, "human", 1, host, 0, 0, 1);
  ai.peonsRepair = opts.peonsRepair !== false;
  return { ai, asked, host };
}

// ==========================================================================================
console.log("-- the flag ---------------------------------------------------------------");
// ==========================================================================================
{
  const hall = building("htow", 10);
  const { ai, asked } = seat([hall, worker("idle")], { peonsRepair: false });
  ai.applyRepairs();
  check("nothing is mended while SetPeonsRepair is off", asked.length, 0);
}
{
  const hall = building("htow", 10);
  const w = worker("idle");
  const { ai, asked } = seat([hall, w]);
  ai.applyRepairs();
  check("…and the hall is mended once it is on", asked, [{ c: "repair", unitId: w.id, buildingId: hall.id, queued: false }]);
}

// ==========================================================================================
console.log("\n-- the hall outranks everything -------------------------------------------");
// ==========================================================================================
// A Farm at a TENTH of its life against a Town Hall at four fifths: sorted by damage alone the
// Farm wins every time, and the developer's report is about the hall.
{
  const farm = building("hhou", 10, { x: 500 });
  const hall = building("htow", 80);
  const w = worker("idle", { x: 500 }); // …and standing next to the Farm, so distance says Farm too
  const { ai, asked } = seat([farm, hall, w]);
  ai.applyRepairs();
  check("the hall is mended before a Farm that is far worse off", asked[0]?.buildingId, hall.id);
}
// …and it may have BOTH workers, which nothing else may.
{
  const hall = building("htow", 40);
  const barracks = building("hbar", 40, { x: 800 });
  const ws = [worker("idle"), worker("idle"), worker("idle")];
  const { ai, asked } = seat([hall, barracks, ...ws]);
  ai.applyRepairs();
  check("two workers on the hall", asked.filter((c) => c.buildingId === hall.id).length, 2);
  check("…and none left over for the Barracks", asked.filter((c) => c.buildingId === barracks.id).length, 0);
}
// With the hall whole, the allowance is spread ONE per building — the most hurt first.
{
  const barracks = building("hbar", 20, { x: 800 });
  const farm = building("hhou", 50, { x: 400 });
  const farm2 = building("hhou", 60, { x: 600 });
  const ws = [worker("idle"), worker("idle"), worker("idle"), worker("idle")];
  const { ai, asked } = seat([barracks, farm, farm2, ...ws]);
  ai.applyRepairs();
  check("one worker apiece, worst first", asked.map((c) => c.buildingId), [barracks.id, farm.id]);
}

// ==========================================================================================
console.log("\n-- two workers, ever ------------------------------------------------------");
// ==========================================================================================
{
  // A raided base: five things damaged and eight workers standing in it.
  const damaged = [building("htow", 30), building("hbar", 30, { x: 200 }), building("hhou", 30, { x: 400 }),
    building("hhou", 30, { x: 600 }), building("hhou", 30, { x: 800 })];
  const ws = Array.from({ length: 8 }, () => worker("idle"));
  const { ai, asked } = seat([...damaged, ...ws]);
  ai.applyRepairs();
  check("a raided base still only spends two workers", asked.length, 2);
}
{
  // …counting the ones already at it. One is mending the hall; the second is the last body free.
  const hall = building("htow", 30);
  const farm = building("hhou", 30, { x: 400 });
  const ws = [worker(`repair:${hall.id}`), worker("idle"), worker("idle"), worker("idle")];
  const { ai, asked } = seat([hall, farm, ...ws]);
  ai.applyRepairs();
  check("a crew already at work counts against the two", asked.length, 1);
  check("…and it goes to the hall, which may have both", asked[0]?.buildingId, hall.id);
}
{
  const hall = building("htow", 30);
  const ws = [worker(`repair:${hall.id}`), worker(`repair:${hall.id}`), worker("idle")];
  const { ai, asked } = seat([hall, ...ws]);
  ai.applyRepairs();
  check("with both already mending, nothing more is ordered", asked.length, 0);
}

// ==========================================================================================
console.log("\n-- who is taken, and in what order ----------------------------------------");
// ==========================================================================================
// Idle before lumberjack before miner: gold is what every other row on the ladder is bought
// with, so a miner is the last body spent — even standing closest.
{
  const hall = building("htow", 30);
  const miner = worker("gold", { x: 0 });
  const chopper = worker("lumber", { x: 400 });
  const idle = worker("idle", { x: 800 });
  const { ai, asked } = seat([hall, miner, chopper, idle]);
  ai.applyRepairs();
  check("the idle worker first, then the lumberjack", asked.map((c) => c.unitId), [idle.id, chopper.id]);
}
{
  // …but a miner IS taken when it is all there is. The hall must not fall.
  const hall = building("htow", 30);
  const miners = [worker("gold"), worker("gold"), worker("gold"), worker("gold"), worker("gold")];
  const { ai, asked } = seat([hall, ...miners]);
  ai.applyRepairs();
  check("a miner is taken when the hall has nobody else", asked.length, 2);
}
{
  // A worker inside its gold is not addressable at all — the authority refuses an order naming
  // an off-field unit — so it is never counted as a body this pass could spend.
  const hall = building("htow", 30);
  const down = worker("gold");
  down.inMine = true;
  const { ai, asked } = seat([hall, down]);
  ai.applyRepairs();
  check("a peon down the shaft is not a body this pass has", asked.length, 0);
}
{
  // Nor is one the captain is holding (the scout, or a worker in the wave — see captainHeld).
  const hall = building("htow", 30);
  const w = worker("idle");
  const { ai, asked } = seat([hall, w]);
  ai.captainHeld = new Set([w.id]);
  ai.applyRepairs();
  check("nor one the captain is holding", asked.length, 0);
}

// ==========================================================================================
console.log("\n-- what is worth mending --------------------------------------------------");
// ==========================================================================================
{
  const hall = building("htow", 95); // a stray arrow
  const { ai, asked } = seat([hall, worker("idle")]);
  ai.applyRepairs();
  check("a scratch does not pull a worker off anything", asked.length, 0);
}
{
  const site = building("htow", 30, { constructionLeft: 20 });
  const { ai, asked } = seat([site, worker("idle")]);
  ai.applyRepairs();
  check("a building still going up is BUILT, not repaired", asked.length, 0);
}
{
  const theirs = building("htow", 30);
  theirs.owner = 1;
  const { ai, asked } = seat([theirs, worker("idle")]);
  ai.applyRepairs();
  check("somebody else's building is not ours to mend", asked.length, 0);
}
{
  // Repair is charged per hit point restored off the target's own goldRep/lumberRep
  // (`SimWorld.repairRates`), so a computer down to its last hundred gold spends it on a worker
  // rather than on a Farm's paintwork — but the hall is still worth every coin left.
  const farm = building("hhou", 30, { x: 400 });
  const { ai, asked } = seat([farm, worker("idle")], { gold: 40 });
  ai.applyRepairs();
  check("a broke computer leaves the Farm alone", asked.length, 0);

  const hall = building("htow", 30);
  const w2 = worker("idle");
  const poor = seat([hall, w2], { gold: 40 });
  poor.ai.applyRepairs();
  check("…and mends the hall anyway", poor.asked.length, 1);
}
{
  // The SIM's question, not ours: a worker whose repair row does not list this target is passed
  // over (a Peasant at a Tree of Life, a Ghoul at anything) and the next body is tried.
  const hall = building("htow", 30);
  const refused = worker("idle");
  const able = worker("lumber", { x: 900 });
  const { ai, asked } = seat([hall, refused, able], {
    refuse: (w) => (w === refused.id ? "Cantrepair" : null),
  });
  ai.applyRepairs();
  check("a worker the sim refuses is passed over", asked.map((c) => c.unitId), [able.id]);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
