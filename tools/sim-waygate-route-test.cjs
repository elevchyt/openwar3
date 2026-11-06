// Headless check that a GROUND walk to ground it cannot reach goes THROUGH a Way Gate
// (SimWorld.gateHop): (2)MysticIsles' island mines are reached through its gates and nothing
// else, and without this a worker or an army sent there stood still at the water's edge.
//
// Two halves of a map split by a solid wall, one gate on each side pointing at the other.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};
const SIM_DT = 1 / 60;
const W = 96, H = 96; // 3072 × 3072, origin (0,0)

function splitGrid() {
  const flags = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++) for (let cx = 46; cx < 50; cx++) flags[cy * W + cx] = PathingFlag.Unwalkable;
  return new PathingGrid({ width: W, height: H, flags }, [0, 0]);
}

function addUnit(w, id, owner, x, y, over = {}) {
  return w.add({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 300, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0, sightDay: 1400, sightNight: 800,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [], ...over,
  });
}
const run = (w, s, until) => {
  for (let i = 0; i < Math.round(s / SIM_DT); i++) {
    w.tick(SIM_DT);
    if (until && until()) return true;
  }
  return false;
};

function world() {
  const w = new SimWorld(splitGrid(), 1);
  // A gate on each half (west at 800,800; east at 2300,800), each landing on the other.
  const gw = addUnit(w, 100, 12, 800, 800, { neutralPassive: true, speed: 0 });
  const ge = addUnit(w, 101, 12, 2300, 800, { neutralPassive: true, speed: 0 });
  w.setWaygateDestination(gw.id, 2300, 800);
  w.setWaygateDestination(ge.id, 800, 800);
  w.waygateActivate(gw.id, true);
  w.waygateActivate(ge.id, true);
  return { w, gw, ge };
}

console.log("a walk across the divide goes through the gate");
{
  const { w } = world();
  const u = addUnit(w, 1, 0, 500, 2200);
  check("the far side reads as reachable", w.canWalkTo(u.id, 2600, 2200));
  check("the order is taken", w.issueMove(u.id, 2600, 2200));
  check("…and the unit is walking at the gate", u.viaGate?.gateId === 100, JSON.stringify(u.viaGate));
  const arrived = run(w, 30, () => Math.hypot(u.x - 2600, u.y - 2200) < 64);
  check("it arrives on the far side", arrived, `at ${u.x.toFixed(0)},${u.y.toFixed(0)} order=${u.order}`);
  check("…with the plan spent", !u.viaGate);
}

console.log("a walk on the unit's own side ignores the gates");
{
  const { w } = world();
  const u = addUnit(w, 1, 0, 500, 2200);
  w.issueMove(u.id, 500, 400);
  check("no gate", !u.viaGate);
  check("it arrives", run(w, 20, () => Math.hypot(u.x - 500, u.y - 400) < 64));
}

console.log("a gate switched off is no road");
{
  const { w, gw } = world();
  w.waygateActivate(gw.id, false);
  const u = addUnit(w, 1, 0, 500, 2200);
  check("the far side reads as unreachable", !w.canWalkTo(u.id, 2600, 2200));
}

console.log("a unit that came out of a gate and is sent straight back goes back through it");
{
  const { w } = world();
  const u = addUnit(w, 1, 0, 500, 2200);
  w.issueMove(u.id, 2600, 2200);
  check("it crosses", run(w, 30, () => u.x > 1600));
  w.issueMove(u.id, 400, 400);
  check("…and crosses back", run(w, 30, () => Math.hypot(u.x - 400, u.y - 400) < 64), `at ${u.x.toFixed(0)},${u.y.toFixed(0)}`);
}

console.log("a stop drops the plan");
{
  const { w } = world();
  const u = addUnit(w, 1, 0, 500, 2200);
  w.issueMove(u.id, 2600, 2200);
  w.stop(u.id);
  check("no gate after a stop", !u.viaGate);
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
