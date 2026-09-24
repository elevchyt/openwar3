// Headless check that an `rtma` unit-swap upgrade reaches the PRODUCTION QUEUES as well as the
// field: the Berserker Upgrade (`Robk`, ohun→otbk) finishing while Headhunters are queued — or
// half-trained — in a Barracks means those Headhunters walk out as Troll Berserkers. The swap
// used to morph only the units already standing, so a queued Headhunter came out a Headhunter
// after the upgrade that withdraws it.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]);
const world = new SimWorld(grid, 1);
// Only what `applyUnitSwap` asks of the tech tree: which pair the upgrade swaps, and the caps.
const caps = [];
world.tech = {
  unitSwapForUpgrade: (id) => (id === "Robk" ? { from: "ohun", to: "otbk" } : null),
  setMaxAllowed: (p, id, n) => caps.push([p, id, n]),
};
const barracks = (id, owner, queue) => {
  const u = { id, owner, typeId: "obar", hp: 1000, building: { queue } };
  world.units.set(id, u);
  return u;
};
const job = (unitId, timeLeft) => ({ kind: "unit", unitId, timeLeft, buildTime: 20, foodPaid: timeLeft < 20 });

const ours = barracks(1, 0, [job("ohun", 7), job("ohun", 20), job("ogru", 20), { kind: "research", unitId: "Rotr", level: 1, timeLeft: 30, buildTime: 30 }]);
const theirs = barracks(2, 1, [job("ohun", 20)]);
world.applyUnitSwap(0, "Robk");

check("the half-trained Headhunter comes out a Berserker", ours.building.queue[0].unitId, "otbk");
check("…keeping its clock and its paid food", [ours.building.queue[0].timeLeft, ours.building.queue[0].foodPaid], [7, true]);
check("the one queued behind it too", ours.building.queue[1].unitId, "otbk");
check("a Grunt is still a Grunt", ours.building.queue[2].unitId, "ogru");
check("a research job is left alone", ours.building.queue[3].unitId, "Rotr");
check("another player's Headhunters are theirs to upgrade", theirs.building.queue[0].unitId, "ohun");
check("production flips as before", caps, [[0, "otbk", -1], [0, "ohun", 0]]);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
