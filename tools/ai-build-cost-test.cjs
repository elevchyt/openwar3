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
  htow: { goldCost: 385, lumberCost: 205, isBuilding: true, isHero: false, classification: [], foodUsed: 0 },
  hkee: { goldCost: 705, lumberCost: 415, isBuilding: true, isHero: false, classification: [], foodUsed: 0 },
  hbar: { goldCost: 160, lumberCost: 50, isBuilding: true, isHero: false, classification: [], foodUsed: 0 },
  // …and a tower and its upgraded form, to put a SECOND upgrade row under the tier-up with.
  hwtw: { goldCost: 70, lumberCost: 20, isBuilding: true, isHero: false, classification: [], foodUsed: 0 },
  hgtw: { goldCost: 100, lumberCost: 40, isBuilding: true, isHero: false, classification: [], foodUsed: 0 },
};

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
  const host = {
    world: {
      units: new Map([[1, hall], [2, tower]]),
      mines: new Map(),
      nearestMine: () => null,
      stashOf: () => ({ gold, lumber }),
      pendingTrained: () => [],
    },
    registry: { get: (id) => DEFS[id] },
    tech: { get: (id) => ({ upgrade: id === "htow" ? ["hkee"] : id === "hwtw" ? ["hgtw"] : [] }) },
    execute: (_player, cmd) => {
      asked.push(cmd);
      return true;
    },
  };
  return { ai: new AiPlayer(0, "human", 1, host, 0, 0, 1), asked };
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

// The price is asked of the same scan that will place the order (`upgradeCandidates`), so the
// two can never disagree: a hall with something in its queue refuses the upgrade, and is not
// what the row is priced against either.
{
  const { ai, asked } = seat(400, 300, { busy: true });
  ai.refresh();
  ai.initBuildArray();
  ai.setBuildUnit(1, "hkee");
  ai.runBuildLoop();
  check("a busy hall is not a cheap Keep", asked.length, 0);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
