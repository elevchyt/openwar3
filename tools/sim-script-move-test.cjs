// A TRIGGER moving a unit: SetUnitX / SetUnitY / SetUnitPosition[Loc] (SimWorld.setUnitPosition).
//
// Jassbot's notes are the contract. SetUnitX "is a low level call and ignores all pathing" and
// "does not cancel orders of the unit"; SetUnitPosition "sets new unit location, respecting
// pathing rules like terrain" and "cancels the orders of the unit by issuing order "stop"".
// Neither is a move onto the 32-unit pathing grid — they used to share teleportUnit's snap, and
// Azeroth Grand Prix, which drives its carts with nothing but SetUnitPositionLoc every 0.05 s
// and reads the next speed back off the distance covered, was held to 32 units a tick, read
// every curve as a slide, and could never pull away from a standstill.
//
// Run: pnpm sim:test  (compiles the sim to CommonJS first — see tools/tsconfig.sim.json)

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT
// 96 cells = 3072 world units a side, origin at (0,0); the cart gets a wider field to race in.
function grid(walls = [], W = 96, H = 96) {
  const flags = new Uint8Array(W * H);
  for (const [cx, cy] of walls) flags[cy * W + cx] = PathingFlag.Unwalkable;
  return new PathingGrid({ width: W, height: H, flags }, [0, 0]);
}
function addUnit(w, id, x, y, over = {}) {
  return w.add({
    id, owner: 0, team: 0, typeId: "hfoo", x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.4, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0, sightDay: 1400, sightNight: 800,
    flying: false, mechanical: true, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 0, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Unit",
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [], ...over,
  });
}
const run = (w, seconds) => { for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.tick(SIM_DT); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 1. The cart: a script driving a unit every 0.05 s, reading its speed back ──────────────
// Azeroth Grand Prix's own loop, cut to what it measures (Trig_Move_Cart_Actions, CalcCurSpeed,
// CalcSpeed, Move): the cart's move speed is 0, every tick projects the next point from where
// it STOOD and reads the speed back as 3 × the distance it actually went. Accelerate 6.8 per
// tick with the Diablo cart's drag, top speed 205, a 3°-a-tick turn after the straight.
console.log("a script-driven cart (Azeroth Grand Prix's Move loop)");
{
  const w = new SimWorld(grid([], 256, 256), 1); // 8192 a side: 60 ticks flat out is ~3500
  const cart = addUnit(w, 1, 4000.3, 500.7, { speed: 0 }); // off any cell centre, as a start point is
  let speed = 0, angle = 90, prevX = cart.x, prevY = cart.y, worst = 0, slid = 0;
  const speeds = [];
  for (let tick = 0; tick < 100; tick++) {
    const covered = Math.hypot(cart.x - prevX, cart.y - prevY) * 3; // CalcCurSpeed's FakeSpeed
    if (tick > 0) {
      const heading = (Math.atan2(cart.y - prevY, cart.x - prevX) * 180) / Math.PI;
      if (covered > 0 && Math.abs(((heading - angle + 540) % 360) - 180) > 2) slid++; // its "bSlide"
      speed = covered;
    }
    prevX = cart.x;
    prevY = cart.y;
    speed = Math.min(205, speed + 6.8 - (speed > 0 ? 0.5 + speed * 0.006 : 0));
    if (tick >= 60) angle += 3; // Left held: GetModelTurnRate 1, × 3 a tick
    const step = speed / 3; // RealSpeed
    const ax = prevX + step * Math.cos((angle * Math.PI) / 180);
    const ay = prevY + step * Math.sin((angle * Math.PI) / 180);
    w.setUnitPosition(cart.id, ax, ay, true);
    worst = Math.max(worst, Math.hypot(cart.x - ax, cart.y - ay));
    speeds.push(speed);
    run(w, 0.05);
  }
  check(`every tick lands exactly where it was put (worst miss ${worst.toFixed(3)})`, worst < 1e-6);
  check(`pulls away from rest (first measured speed ${speeds[1].toFixed(2)} > 0)`, speeds[1] > 0);
  const top = Math.max(...speeds);
  check(`reaches its top speed of 205 (best ${top.toFixed(1)}; the snap held it at ~102)`, top > 200);
  check(`a curve reads as no slide at all (${slid} ticks off-heading)`, slid === 0);
}

// ── 2. SetUnitX / SetUnitY: ignore pathing, keep the order ──────────────────────────────────
console.log("SetUnitX/Y — low level: no pathing, no stop");
{
  const w = new SimWorld(grid([[40, 15]]), 1); // one unwalkable cell: world 1280..1312, 480..512
  const u = addUnit(w, 1, 500.5, 500.5);
  w.issueOrder(1, { kind: "move", x: 2500, y: 500 });
  run(w, 0.2);
  w.setUnitPosition(1, 1295.25, 497.75, false);
  check(`stands exactly at the point, wall or not (${u.x}, ${u.y})`, u.x === 1295.25 && u.y === 497.75);
  check(`kept its order (${u.order})`, u.order === "move");
  run(w, 8);
  check(`…and carried it out (x ${u.x.toFixed(0)})`, u.x > 2400);
}

// ── 3. SetUnitPosition: respects the terrain, cancels the order ─────────────────────────────
console.log("SetUnitPosition — pathed: stop, and never inside a wall");
{
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 500, 500);
  w.issueOrder(1, { kind: "move", x: 2500, y: 500 });
  run(w, 0.2);
  w.setUnitPosition(1, 1001.5, 1203.25, true);
  check(`kept the exact point on open ground (${u.x}, ${u.y})`, u.x === 1001.5 && u.y === 1203.25);
  check(`stopped (order ${u.order})`, u.order === "idle");
  run(w, 1);
  check(`…and stays put (${u.x.toFixed(2)}, ${u.y.toFixed(2)})`, near(u.x, 1001.5, 1) && near(u.y, 1203.25, 1));
}
{
  const walls = [];
  for (let cx = 38; cx <= 42; cx++) for (let cy = 13; cy <= 17; cy++) walls.push([cx, cy]); // 1216..1376 × 416..576
  const w = new SimWorld(grid(walls), 1);
  const u = addUnit(w, 1, 500, 500);
  w.setUnitPosition(1, 1296, 496, true);
  const [cx, cy] = w.grid.worldToCell(u.x, u.y);
  check(`put into a wall, it lands on walkable ground (${u.x}, ${u.y})`, w.grid.walkable(cx, cy));
}
{
  // A one-cell body driven INTO a wall is set on the nearest point beside it — it scrapes along
  // the edge — never thrown back onto a cell centre: Azeroth Grand Prix reads the distance it
  // covered as its speed, and a cell's worth backwards read as reversing, so the cart bounced.
  const walls = [];
  for (let cx = 0; cx <= 39; cx++) for (let cy = 0; cy < 96; cy++) walls.push([cx, cy]); // x < 1280 is wall
  const w = new SimWorld(grid(walls), 1);
  const cart = addUnit(w, 1, 1290, 1000, { speed: 0 });
  w.setUnitPosition(1, 1270, 1030, true);
  check(`scrapes along the wall (${cart.x.toFixed(2)}, ${cart.y.toFixed(2)})`, near(cart.x, 1280, 0.05) && near(cart.y, 1030, 1e-6));
}
{
  // A body already standing there: pathing includes the units on it, so the second is set
  // beside the first rather than inside it (TeleportCaptain sends a whole group to one point).
  const w = new SimWorld(grid(), 1);
  const a = addUnit(w, 1, 800, 800);
  run(w, 0.1);
  const b = addUnit(w, 2, 400, 400);
  w.setUnitPosition(2, a.x, a.y, true);
  check(`a second body is not stacked on the first (gap ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(0)})`, Math.hypot(a.x - b.x, a.y - b.y) >= 16);
}

// ── SetUnitFacing[Timed] on a PAUSED unit ─────────────────────────────────────────────────
// war3.exe still turns it, even though a paused unit sits out the turning pass — so the timed
// form lands at once rather than waiting for a pass that never comes.
console.log("\nturning a paused unit");
{
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 800, 800);
  u.paused = true;
  w.setUnitFacing(1, Math.PI / 2, false); // SetUnitFacingTimed(u, 90, 0)
  run(w, 0.5);
  check(`a paused unit faces where it was turned (${(u.facing * 180 / Math.PI).toFixed(0)}°)`, near(u.facing, Math.PI / 2));
  const v = addUnit(w, 2, 1200, 800);
  w.setUnitFacing(2, Math.PI, false);
  check("an unpaused one still turns at its own rate, not at once", !near(v.facing, Math.PI));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall script-move checks passed");
