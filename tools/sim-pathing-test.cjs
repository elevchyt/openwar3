// Pathing: a unit reserves the tile before it walks onto it (issue #108).
//
// WC3 units never walk through one another. The engine's movement is tile-based: a unit
// holds the cell block it stands on and may only advance once it holds the next one, so
// standing in somebody's way genuinely stops them — and, when the way stays shut, forces
// them to recalculate a route AROUND rather than grind through. Our old movement
// interpolated freely and let the circle-separation pass sort the overlap out afterwards,
// which is exactly the "units fighting to squeeze through each other" the issue reports.
//
// The other half of the issue is an anchor-space bug: A* and the clearance predicate index
// a unit's n×n block by its ANCHOR cell (PathingGrid.footprintAnchor), which for an EVEN
// footprint — every unit whose collision is 16–31, i.e. most of them — is half a cell away
// from the cell centre the waypoints used to be built from. Every even-footprint unit was
// therefore walked half a cell off the cells the pathfinder had cleared for it.
//
// Run: pnpm sim:test  (compiles the sim to CommonJS first — see tools/tsconfig.sim.json)

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag, PATHING_CELL } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT

const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

const W = 96, H = 96; // 3072 x 3072 world units, origin at (0,0)
const gridOf = (flags) => new PathingGrid({ width: W, height: H, flags: flags ?? new Uint8Array(W * H) }, [0, 0]);

function addUnit(w, id, owner, x, y, over = {}) {
  const weapons = over.weapons ?? [WEAPON()];
  return w.add({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    ...over, weapons, oldWeapons: weapons,
  });
}

/** THE invariant the issue asks for: at the end of every tick, no two ground units' cell
 *  blocks overlap. A block is what a unit holds — reserved when it is stopped, claimed
 *  while it walks — so an overlap is precisely one unit standing inside another, which is
 *  what "squeezing through" looks like frame by frame. Returns the worst offence seen. */
function runWatched(w, grid, seconds) {
  let worst = null;
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    w.tick(SIM_DT);
    const live = [...w.units.values()].filter((u) => u.hp > 0 && !u.flying && u.footprint > 0 && !u.noCollision);
    for (let a = 0; a < live.length; a++) {
      for (let b = a + 1; b < live.length; b++) {
        const na = live[a].footprint, nb = live[b].footprint;
        const [ax, ay] = grid.footprintOrigin(live[a].x, live[a].y, na);
        const [bx, by] = grid.footprintOrigin(live[b].x, live[b].y, nb);
        if (ax < bx + nb && bx < ax + na && ay < by + nb && by < ay + na) {
          worst = `units ${live[a].id} and ${live[b].id} share cells at t=${(i * SIM_DT).toFixed(2)}s`;
        }
      }
    }
  }
  return worst;
}

const run = (w, seconds) => { for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.tick(SIM_DT); };

/** A vertical wall of unwalkable cells at column `cx` (2 cells thick — the width of an
 *  even footprint's block), with walkable gaps at the given 2-cell-tall row pairs. */
function wallWithGaps(cx, gapRows) {
  const flags = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++) {
    if (gapRows.some((g) => cy === g || cy === g + 1)) continue;
    flags[cy * W + cx] = PathingFlag.Unwalkable;
    flags[cy * W + cx + 1] = PathingFlag.Unwalkable;
  }
  return flags;
}

// ── 1. A body in the doorway is a closed door ──────────────────────────────────────────
// One 2-cell gap in a wall, exactly the width of a footman's block. Park a unit in it and
// nothing can get past — before the fix the mover interpolated straight into the blocker's
// tile, was shoved back out by the separation pass, and kept grinding at it (or slipped
// through). Control run first, so we know the gap really is passable when it is empty.
console.log("a unit parked in a one-body gap blocks it");
{
  const grid = gridOf(wallWithGaps(30, [20]));
  const w = new SimWorld(grid, 1);
  addUnit(w, 1, 0, 500, 672);
  w.issueMove(1, 1500, 672);
  run(w, 12);
  check(`with the gap clear the unit gets through (x ${w.units.get(1).x.toFixed(0)})`, w.units.get(1).x > 1100);
}
{
  const grid = gridOf(wallWithGaps(30, [20]));
  const w = new SimWorld(grid, 1);
  addUnit(w, 1, 0, 500, 672);
  // (992, 672) is the footprint-aligned centre of the block covering cells x∈{30,31},
  // y∈{20,21} — the whole gap. issueHold settles it there, reserving those cells.
  const plug = addUnit(w, 2, 0, 992, 672);
  w.issueHold(2);
  w.tick(SIM_DT);
  check("the plug reserved the gap", plug.hasReservation);
  w.issueMove(1, 1500, 672);
  const overlap = runWatched(w, grid, 12);
  const u = w.units.get(1);
  check(`the mover never got past it (x ${u.x.toFixed(0)}, wall at 960)`, u.x < 960);
  check("and never stood inside it", overlap === null);
}

// ── 1b. Two bodies cannot swap places in a one-body corridor ───────────────────────────
// The head-on case. A corridor two cells wide holds exactly one unit across; in WC3 the two
// meet and jam. The old separation pass split the overlap between them and slid them
// tangentially, so they passed straight THROUGH each other — the "fighting to squeeze
// through" the issue opens with.
console.log("two units cannot pass through each other in a one-body corridor");
{
  const flags = new Uint8Array(W * H);
  for (let cx = 0; cx < W; cx++) {
    for (let cy = 0; cy < H; cy++) {
      if (cy === 20 || cy === 21) continue; // the corridor
      flags[cy * W + cx] = PathingFlag.Unwalkable;
    }
  }
  const grid = gridOf(flags);
  const w = new SimWorld(grid, 1);
  const a = addUnit(w, 1, 0, 500, 672);
  const b = addUnit(w, 2, 0, 1500, 672);
  w.issueMove(1, 1600, 672);
  w.issueMove(2, 400, 672);
  let swapped = false;
  for (let i = 0; i < Math.round(14 / SIM_DT); i++) {
    w.tick(SIM_DT);
    if (a.x >= b.x) swapped = true;
  }
  check(`neither slipped past the other (a.x ${a.x.toFixed(0)}, b.x ${b.x.toFixed(0)})`, !swapped);
}

// ── 1c. A body moving ahead of you holds you to ITS pace ───────────────────────────────
// "Blocking a unit from moving but constantly moving in front of it is very hard." The
// honest version of that: a slow unit walking down the same one-body corridor ahead of a
// fast one. The fast one cannot get past — it is held to the blocker's speed. With
// permeable bodies it simply walked through and arrived at its own pace.
console.log("a slow unit ahead in a corridor holds a fast one back");
{
  const flags = new Uint8Array(W * H);
  for (let cx = 0; cx < W; cx++) {
    for (let cy = 0; cy < H; cy++) {
      if (cy === 20 || cy === 21) continue;
      flags[cy * W + cx] = PathingFlag.Unwalkable;
    }
  }
  let control = 0;
  {
    const w = new SimWorld(gridOf(flags), 1);
    addUnit(w, 1, 0, 400, 672);
    w.issueMove(1, 2400, 672);
    run(w, 6);
    control = w.units.get(1).x - 400;
  }
  const w = new SimWorld(gridOf(flags), 1);
  const runner = addUnit(w, 1, 0, 400, 672);
  const blocker = addUnit(w, 2, 0, 560, 672, { speed: 90 }); // a third of the runner's pace
  w.issueMove(1, 2400, 672);
  w.issueMove(2, 2400, 672);
  run(w, 6);
  const blockedDist = runner.x - 400;
  check(`held to the blocker's pace (${blockedDist.toFixed(0)} of ${control.toFixed(0)} units)`, blockedDist < control * 0.6);
  check(`and never passed it (runner ${runner.x.toFixed(0)}, blocker ${blocker.x.toFixed(0)})`, runner.x < blocker.x);
}

// ── 2. Blocked → recalculate and route AROUND ──────────────────────────────────────────
// Same wall, but with a second gap further down. The near gap is plugged, so the only way
// through is the far one: the unit must give up on shoving and go round, which is the
// "path-finding disruption" the issue describes.
console.log("a blocked unit reroutes through the other gap");
{
  const grid = gridOf(wallWithGaps(30, [20, 40]));
  const w = new SimWorld(grid, 1);
  addUnit(w, 1, 0, 500, 672);
  addUnit(w, 2, 0, 992, 672); // plugs the near gap (cells y 20-21)
  w.issueHold(2);
  w.tick(SIM_DT);
  w.issueMove(1, 1500, 672);
  const overlap = runWatched(w, grid, 20);
  const u = w.units.get(1);
  check(`found the far gap and got through (x ${u.x.toFixed(0)}, y ${u.y.toFixed(0)})`, u.x > 1100);
  check("without ever standing inside another unit", overlap === null);
}

// ── 3. A march never overlaps ──────────────────────────────────────────────────────────
// Eight units crossing the field to a shared area. Every tick of it is watched: no two may
// ever share a cell, walking or stopped.
console.log("a marching group never shares a tile");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  for (let i = 0; i < 8; i++) {
    addUnit(w, 10 + i, 0, 400 + (i % 4) * 80, 400 + Math.floor(i / 4) * 80);
    w.issueMove(10 + i, 1600 + (i % 4) * 80, 1600 + Math.floor(i / 4) * 80);
  }
  const overlap = runWatched(w, grid, 20);
  check(`no two units ever shared cells (${overlap ?? "clean"})`, overlap === null);
  const arrived = [...w.units.values()].filter((u) => u.x > 1400 && u.y > 1400).length;
  check(`all eight covered the ground (${arrived}/8 arrived)`, arrived === 8);
}

// ── 4. Even footprints land where they were sent ───────────────────────────────────────
// The anchor-space half of the fix. A footman (collision 16 → a 2×2 block) walked to cell
// CENTRES used to arrive half a cell off the block A* had cleared, then get shoved and
// re-path. Ordered onto open ground it must now stop essentially on the spot.
console.log("an even-footprint unit stops on the ordered spot");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  addUnit(w, 1, 0, 500, 500);
  w.issueMove(1, 1490, 1330);
  run(w, 12);
  const u = w.units.get(1);
  const off = Math.hypot(u.x - 1490, u.y - 1330);
  check(`landed on the ordered point (off by ${off.toFixed(0)} units)`, off <= PATHING_CELL);
  check("and came to rest", !u.moving && u.hasReservation);
}

// ── 5. A surround fills: everybody gets a swing in ─────────────────────────────────────
// Five melee units onto one target. The complaint is that some just stand there and never
// approach even when there is clearly room. All five must reach striking distance.
console.log("five attackers all reach a single target");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  const target = addUnit(w, 99, 1, 1200, 1200, { weapons: [], hp: 1e9, maxHp: 1e9 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    addUnit(w, 20 + i, 0, 1200 + Math.cos(a) * 600, 1200 + Math.sin(a) * 600);
    w.issueOrder(20 + i, { kind: "attack", targetId: target.id, force: false });
  }
  const overlap = runWatched(w, grid, 15);
  const inRange = [...w.units.values()].filter((u) => {
    if (u.id === 99) return false;
    return Math.hypot(u.x - target.x, u.y - target.y) - u.radius - target.radius <= 90 + 48;
  }).length;
  check(`all five closed to striking distance (${inRange}/5)`, inRange === 5);
  check("and the target is taking damage", target.hp < target.maxHp);
  check(`nobody stood inside anybody (${overlap ?? "clean"})`, overlap === null);
}

// ── 6. A squad attack-moving into a creep camp all joins in ────────────────────────────
// The reported case: a group walks into a camp and one or two of them just stand there.
// Every attacker must end up fighting something.
console.log("a squad attack-moving into a camp all engages");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  for (let i = 0; i < 3; i++) addUnit(w, 50 + i, 1, 1500 + i * 90, 1200, { hp: 1e9, maxHp: 1e9 });
  for (let i = 0; i < 6; i++) {
    addUnit(w, 30 + i, 0, 700 + (i % 3) * 80, 1140 + Math.floor(i / 3) * 80);
    w.issueAttackMove(30 + i, 1600, 1200);
  }
  const overlap = runWatched(w, grid, 18);
  const fighting = [...w.units.values()].filter((u) => u.id >= 30 && u.id < 36 && u.targetId !== null).length;
  check(`every attacker picked a fight (${fighting}/6)`, fighting === 6);
  const hurt = [50, 51, 52].filter((id) => w.units.get(id) && w.units.get(id).hp < w.units.get(id).maxHp).length;
  check(`the camp is taking damage (${hurt}/3 hurt)`, hurt >= 1);
  check(`nobody stood inside anybody (${overlap ?? "clean"})`, overlap === null);
}

console.log(failures ? `\npathing: ${failures} check(s) FAILED` : "\npathing: all checks passed");
process.exit(failures ? 1 : 0);
