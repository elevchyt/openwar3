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

/** A solid w x h pathTex footprint — every cell of the core unwalkable, as a building's is. */
const stamp = (w, h) => ({ w, h, blocked: new Array(w * h).fill(true), buildBlocked: new Array(w * h).fill(true) });

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

// ── 7. A move AT a thing walks up to it the short way ──────────────────────────────────
// A move order naming a unit/building means "go to THAT". Its centre is ground the mover
// can never stand on, so the ordinary point search hunts the cell nearest that centre —
// which can sit on the FAR side, reached the long way round. A named move must stop against
// the near face, and its path must not be longer than the straight run in.
console.log("a move at a building stops against the near face");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  // A 6x6-cell block of unwalkable terrain standing in for a building's stamped footprint:
  // cells 34-39 in both axes, i.e. world 1088..1280, so its centre is (1184, 1184).
  for (let cy = 34; cy < 40; cy++) for (let cx = 34; cx < 40; cx++) grid.block(cx, cy);
  const bld = addUnit(w, 90, 1, 1184, 1184, { weapons: [], speed: 0, radius: 96 });
  bld.pathStamp = { fp: stamp(6, 6), x: 1184, y: 1184 };
  // Approaching from due west, a long way out.
  addUnit(w, 1, 0, 400, 1184);
  const ok = w.issueOrder(1, { kind: "move", x: 1184, y: 1184, targetId: 90 });
  check("the order was accepted", ok);
  const overlap = runWatched(w, grid, 14);
  const u = w.units.get(1);
  // Stopped on the WEST face — never walked round to another side.
  check(`stayed on the side it came from (x ${u.x.toFixed(0)}, y ${u.y.toFixed(0)})`, u.x < 1088 && Math.abs(u.y - 1184) < 200);
  // And right up against it: the footprint's west face is at x = 1088, and a footman's
  // 2x2 block puts its centre one block clear of that.
  check(`up against the face (gap ${(1088 - u.x).toFixed(0)} units)`, 1088 - u.x <= 64);
  check("came to rest", !u.moving && u.hasReservation);
  check("nobody stood inside anybody", overlap === null);
}

// …and the fastest route means the near face even when the far side is marginally closer
// to the CENTRE. Approaching a wide, shallow block from the long side, the cells nearest
// its centre lie off the short ends; a unit must not detour to one.
console.log("a move at a thing never hikes round it for a nearer cell");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  for (let cy = 38; cy < 42; cy++) for (let cx = 28; cx < 46; cx++) grid.block(cx, cy); // 18x4 cells
  const wide = addUnit(w, 90, 1, 1184, 1280, { weapons: [], speed: 0, radius: 96 });
  wide.pathStamp = { fp: stamp(18, 4), x: 1184, y: 1280 };
  addUnit(w, 1, 0, 1184, 1900); // due NORTH of the middle of the long side
  w.issueOrder(1, { kind: "move", x: 1184, y: 1280, targetId: 90 });
  run(w, 14);
  const u = w.units.get(1);
  check(`stopped on the long side it approached (x ${u.x.toFixed(0)}, y ${u.y.toFixed(0)})`, u.y > 1344 && u.x > 900 && u.x < 1470);
  check(`up against it (gap ${(u.y - 1344).toFixed(0)} units)`, u.y - 1344 <= 64);
}

// …and a whole GROUP sent at it stays on the side it came from. This is the case a re-path
// used to lose: the first arrivals take the near face, the ones behind are blocked, reroute
// — and a reroute that forgot the order named a THING aimed at the building's centre
// instead, whose goal-snapping lands on one fixed side, so the stragglers hiked round it.
console.log("a group sent at a building all stays on the near side");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  for (let cy = 34; cy < 40; cy++) for (let cx = 34; cx < 40; cx++) grid.block(cx, cy);
  // OUR building, so this is a pure move — a hostile one would be auto-acquired and the
  // squad would be running an attack instead.
  const bld = addUnit(w, 90, 0, 1184, 1184, { weapons: [], speed: 0, radius: 96 });
  bld.pathStamp = { fp: stamp(6, 6), x: 1184, y: 1184 };
  const squad = [];
  for (let i = 0; i < 6; i++) {
    squad.push(addUnit(w, 10 + i, 0, 300 + (i % 2) * 72, 1120 + Math.floor(i / 2) * 72).id);
    w.issueOrder(10 + i, { kind: "move", x: 1184, y: 1184, targetId: 90 });
  }
  const overlap = runWatched(w, grid, 20);
  // Only three 2x2 blocks fit along a 6-cell face, so the last few wrap the near corners —
  // what must never happen is a unit crossing to the FAR side, which is the long way round
  // for no gain. Nobody may end up past the building's centre line.
  const nearSide = squad.filter((id) => w.units.get(id).x <= 1184).length;
  const packed = squad.filter((id) => Math.hypot(w.units.get(id).x - 1184, w.units.get(id).y - 1184) <= 96 + 160).length;
  check(`nobody crossed to the far side (${nearSide}/6 on the near side)`, nearSide === 6);
  check(`and all six are up against it (${packed}/6)`, packed === 6);
  check(`nobody stood inside anybody (${overlap ?? "clean"})`, overlap === null);
}

// ── 8. Attack-move never freezes staring at an enemy it hasn't reached ─────────────────
// tickAttack has a whole watchdog for an approach that stops making headway; attack-move
// calls engage() straight and had none. So when the surround slot a unit was handed turned
// out to be unreachable — walled off by the ranks already fighting — its chase simply
// failed, and it stood there for the rest of the battle with a target 250 units away that
// it never walked at and never hit.
console.log("attack-move: nobody freezes with an unreached target");
{
  const grid = gridOf();
  const w = new SimWorld(grid, 1);
  const foes = [];
  for (let i = 0; i < 4; i++) {
    foes.push(addUnit(w, 50 + i, 1, 1500, 1080 + i * 80, { hp: 4e5, maxHp: 4e5 }).id);
  }
  const squad = [];
  for (let i = 0; i < 6; i++) {
    squad.push(addUnit(w, 30 + i, 0, 500 + (i % 2) * 72, 1100 + Math.floor(i / 2) * 72).id);
    w.issueAttackMove(30 + i, 2200, 1200);
  }
  run(w, 8);
  // A unit is FROZEN if it holds a target it is neither in reach of nor walking toward.
  const frozen = () => squad.filter((id) => {
    const u = w.units.get(id);
    if (u.targetId === null) return false;
    const t = w.units.get(u.targetId);
    if (!t) return false;
    const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.radius - t.radius;
    return gap > 90 + 48 && !u.moving;
  });
  const a = frozen();
  run(w, 6);
  const b = frozen();
  check(`nobody stood off with an unreached target (${a.length} at 8s, ${b.length} at 14s)`, a.length === 0 && b.length === 0);
  const fighting = squad.filter((id) => w.units.get(id).inCombat).length;
  check(`the whole squad is in the fight (${fighting}/6 in combat)`, fighting === 6);
  const dealt = foes.reduce((n, id) => n + (w.units.get(id).maxHp - w.units.get(id).hp), 0);
  check(`and it is dealing real damage (${dealt.toFixed(0)} hp)`, dealt > 500);
}

// ── 9. A jam PAUSES an order, it never cancels it ──────────────────────────────────────
// Bodies in the way used to cost a unit its order outright: two windows of no progress and
// checkStuck called stop(), so a group that jammed in a doorway simply forgot where it had
// been sent and stood there. Bodies move — the order has to outlive them.
console.log("a jam pauses a move order, it does not cancel it");
{
  const grid = gridOf(wallWithGaps(30, [20]));
  const w = new SimWorld(grid, 1);
  // The one-body gap is plugged for the first stretch, then the plug walks away.
  const plug = addUnit(w, 2, 0, 992, 672);
  w.issueHold(2);
  w.tick(SIM_DT);
  addUnit(w, 1, 0, 500, 672);
  w.issueMove(1, 1500, 672);
  run(w, 6); // long enough that the old code had given up twice over
  const u = w.units.get(1);
  check(`still under its move order while jammed (order ${u.order})`, u.order === "move");
  check(`and waiting on the near side (x ${u.x.toFixed(0)})`, u.x < 960);
  // Let the plug walk off; the order must resume on its own, with no new command.
  w.issueMove(2, 992, 1600);
  run(w, 14);
  check(`resumed and got through unaided (x ${u.x.toFixed(0)})`, u.x > 1100);
}

// …and the same for attack-move: the destination survives the jam.
console.log("a jam pauses an attack-move, it does not cancel it");
{
  const grid = gridOf(wallWithGaps(30, [20]));
  const w = new SimWorld(grid, 1);
  const plug = addUnit(w, 2, 0, 992, 672);
  w.issueHold(2);
  w.tick(SIM_DT);
  addUnit(w, 1, 0, 500, 672);
  w.issueAttackMove(1, 1500, 672);
  run(w, 6);
  const u = w.units.get(1);
  check(`still under its attack-move (order ${u.order})`, u.order === "attackmove");
  check(`with its destination intact (${u.amDestX.toFixed(0)}, ${u.amDestY.toFixed(0)})`, Math.round(u.amDestX) === 1500);
  w.issueMove(2, 992, 1600);
  run(w, 14);
  check(`resumed and arrived unaided (x ${u.x.toFixed(0)})`, u.x > 1100);
}

// …and a whole SQUAD queued at a one-body gap drains through it. This is the case that
// caught the first attempt: parking by settling made every waiting unit RESERVE its cells,
// and reservations are walls to the pathfinder — so the queue became a wall to itself and
// sat there with the gap wide open. A parked unit holds its walking CLAIM instead: solid to
// the others' movement, transparent to their routing.
console.log("a squad queued at a one-body gap drains through it");
{
  const grid = gridOf(wallWithGaps(30, [20]));
  const w = new SimWorld(grid, 1);
  const plug = addUnit(w, 2, 0, 992, 672);
  w.issueHold(2);
  w.tick(SIM_DT);
  const squad = [];
  for (let i = 0; i < 6; i++) {
    squad.push(addUnit(w, 10 + i, 0, 420 + (i % 2) * 72, 600 + Math.floor(i / 2) * 72).id);
    w.issueMove(10 + i, 1600, 672);
  }
  run(w, 8); // jammed behind the plug the whole time
  const held = squad.filter((id) => w.units.get(id).order === "move").length;
  check(`the whole squad still holds its order (${held}/6)`, held === 6);
  w.issueMove(2, 1400, 1400); // uncork; nothing re-issues the squad's order
  const overlap = runWatched(w, grid, 30);
  const through = squad.filter((id) => w.units.get(id).x > 1100).length;
  check(`and all six drain through unaided (${through}/6)`, through === 6);
  check(`without ever standing inside anybody (${overlap ?? "clean"})`, overlap === null);
}

// Terrain is the one thing that DOES end a move: no waiting opens a cliff.
console.log("an unreachable destination still ends the order");
{
  const flags = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++) { flags[cy * W + 30] = PathingFlag.Unwalkable; flags[cy * W + 31] = PathingFlag.Unwalkable; }
  const w = new SimWorld(gridOf(flags), 1);
  addUnit(w, 1, 0, 500, 672);
  w.issueMove(1, 1500, 672); // behind a wall with no gap anywhere
  run(w, 10);
  const u = w.units.get(1);
  check(`gave the order up (order ${u.order})`, u.order === "idle");
  check(`having walked up to the wall (x ${u.x.toFixed(0)})`, u.x > 800 && u.x < 960);
}

console.log(failures ? `\npathing: ${failures} check(s) FAILED` : "\npathing: all checks passed");
process.exit(failures ? 1 : 0);
