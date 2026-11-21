// Nobody stays stuck inside anything (SimWorld.settle → wayOutOfWall, and the unstickPass
// watchdog behind it).
//
// Found on Angel Arena Allstars 1.69f: its `B24` revives every fallen hero of a team at the
// centre of one rect (`ReviveHero(YX[i], GetRectCenterX(JK), GetRectCenterY(JK), true)`), and
// that point is BLOCKED ground. settle()'s fallback search wants a clear straight line out of
// the start cell, which from inside a wall never exists — so all six heroes settled on one
// cell, inside the wall, and not one of them could take a step. Three claims are held here:
//
//   1. bodies set down inside a wall come out of it, each on a spot of its own, and can walk;
//   2. bodies set down on ONE open point come out side by side (CreateUnit's displacement);
//   3. a body that ends up wedged anyway (a stale shared reservation) is moved within a
//      second or two by the watchdog — and one at WORK (harvesting) is left where it is.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT
const W = 128, H = 128; // 4096 x 4096 world units, origin at (0,0)
const CELL = 32;

const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function addUnit(w, id, x, y, radius = 32, owner = 0) {
  const weapons = [WEAPON()];
  return w.add({
    id, owner, team: owner, typeId: "Hpal", x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 300, turnRate: 6, radius, scale: 1,
    armor: 0, armorType: "hero", defUp: 0,
    sightDay: 1800, sightNight: 800,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 5, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: radius,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Paladin",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    weapons, oldWeapons: weapons,
  });
}

/** A world with a blocked 8×8-cell square (256 world units a side) centred on (2048, 2048) —
 *  the revive point on Angel Arena is in the middle of a footprint about that size. */
function walledWorld() {
  const flags = new Uint8Array(W * H);
  for (let y = 60; y < 68; y++) for (let x = 60; x < 68; x++) flags[y * W + x] = PathingFlag.Unwalkable;
  const grid = new PathingGrid({ width: W, height: H, flags }, [0, 0]);
  return new SimWorld(grid, 1);
}
const units = (w) => [...w.units.values()];
const inWall = (w, u) => {
  const [cx, cy] = w.grid.worldToCell(u.x, u.y);
  return !w.grid.walkable(cx, cy);
};
function overlaps(list) {
  let n = 0;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) < list[i].radius + list[j].radius - 1) n++;
  return n;
}
function run(w, seconds) {
  for (let s = 0, n = Math.round(seconds / SIM_DT); s < n; s++) w.tick(SIM_DT);
}

console.log("bodies set down inside a wall come out of it, apart, and can walk (the Angel Arena revive)");
{
  const w = walledWorld();
  for (let id = 1; id <= 6; id++) addUnit(w, id, 2048, 2048);
  const list = units(w);
  check("none of the six is left inside the wall", list.every((u) => !inWall(w, u)), list.map((u) => `${u.x},${u.y}`).join(" "));
  check("no two of them overlap", overlaps(list) === 0, `${overlaps(list)} overlapping pairs`);
  const far = Math.max(...list.map((u) => Math.hypot(u.x - 2048, u.y - 2048)));
  check("each came out NEAR the point it was set down at (within 384)", far <= 384, `farthest ${far.toFixed(0)}`);
  const start = list.map((u) => [u.x, u.y]);
  for (const u of list) w.issueMove(u.id, u.x, u.y + 600 * (u.y > 2048 ? 1 : -1));
  run(w, 3);
  const moved = list.map((u, i) => Math.hypot(u.x - start[i][0], u.y - start[i][1]));
  check("every one of them walks when ordered", moved.every((d) => d > 200), moved.map((d) => d.toFixed(0)).join(" "));
}

console.log("bodies set down on one open point come out side by side");
{
  const w = walledWorld();
  for (let id = 1; id <= 8; id++) addUnit(w, id, 1024, 1024);
  check("eight bodies made on one point do not overlap", overlaps(units(w)) === 0, `${overlaps(units(w))} overlapping pairs`);
}

console.log("the watchdog moves a body that is wedged anyway, and leaves one at work alone");
{
  const w = walledWorld();
  const a = addUnit(w, 1, 1024, 1024);
  const b = addUnit(w, 2, 1400, 1024);
  // Stand B on top of A, holding A's own block — the state settle used to leave behind, and
  // what a stale reservation or a careless placement can still produce.
  const proto = Object.getPrototypeOf(w);
  proto.unsettle.call(w, b);
  b.x = b.prevX = a.x;
  b.y = b.prevY = a.y;
  w.grid.reserve(a.resX, a.resY, b.footprint);
  b.resX = a.resX;
  b.resY = a.resY;
  b.hasReservation = true;
  const a0 = [a.x, a.y];
  check("B starts wedged inside A", overlaps([a, b]) === 1);
  run(w, 0.5);
  check("…and is not moved at once (a body passing through a bad spot is not caught)", overlaps([a, b]) === 1);
  run(w, 1.5);
  check("…but is moved within two seconds", overlaps([a, b]) === 0, `B at ${b.x},${b.y}, A at ${a.x},${a.y}`);
  check("…to a spot beside A, not across the map", Math.hypot(b.x - a.x, b.y - a.y) <= 6 * CELL + 1, `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(0)} away`);
  check("…holding a block of its own", [...Array(b.footprint * b.footprint).keys()].every((k) => w.grid.reservationCount(b.resX + (k % b.footprint), b.resY + ((k / b.footprint) | 0)) === 1));
  check("…while A, the one that was there first, did not move", a.x === a0[0] && a.y === a0[1], `${a.x},${a.y}`);
}

console.log("a body at WORK is left where its job put it");
{
  // The pass is asked directly: a fake worker's harvest order would be cleared by the tick
  // itself. Two bodies in one block, both on a job, for three seconds of passes.
  const w = walledWorld();
  const proto = Object.getPrototypeOf(w);
  const c = addUnit(w, 1, 1600, 1600);
  const d = addUnit(w, 2, 1800, 1600);
  proto.unsettle.call(w, d);
  d.x = d.prevX = c.x;
  d.y = d.prevY = c.y;
  w.grid.reserve(c.resX, c.resY, d.footprint);
  d.resX = c.resX;
  d.resY = c.resY;
  d.hasReservation = true;
  c.order = d.order = "harvest";
  for (let k = 0; k < 6; k++) proto.unstickPass.call(w, 0.5);
  check("two harvesting bodies sharing a station are not moved", c.x === d.x && c.y === d.y && overlaps([c, d]) === 1, `${c.x},${c.y} / ${d.x},${d.y}`);
  c.order = d.order = "idle";
  for (let k = 0; k < 3; k++) proto.unstickPass.call(w, 0.5);
  check("…and the moment they are only standing, one of them is", overlaps([c, d]) === 0);
}

console.log("a body the script turned pathing off on may stand anywhere");
{
  const w = walledWorld();
  const g = addUnit(w, 1, 2048, 2048);
  // add() settles it out of the wall like anybody; pin it back in and turn its pathing off.
  g.pathingOff = true;
  Object.getPrototypeOf(w).unsettle.call(w, g);
  g.x = g.prevX = 2048;
  g.y = g.prevY = 2048;
  run(w, 2);
  check("a body with its pathing off stays where the script put it", g.x === 2048 && g.y === 2048, `${g.x},${g.y}`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall unstick checks passed");
