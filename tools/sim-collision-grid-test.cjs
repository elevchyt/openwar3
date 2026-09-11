// The collision pass's spatial grid (SimWorld.resolveCollisions, `CollisionGrid`) — correctness
// first, then what it is worth.
//
// The separation pass used to test every mobile ground body against every other, twice a step:
// ~200,000 pairs in a late-game 600-unit match, nearly all of them two units nowhere near each
// other. The grid only offers a unit the bodies in the cells its reach touches. That is a
// DIFFERENT LOOP, and the bar it has to clear is that it is not a different ANSWER: the pairs are
// still taken in the same order, a pair the grid never offered is provably apart when the old
// loop would have reached it, and the grid follows every nudge as it lands. So the test runs the
// same crowd twice — grid on, grid off — and demands the same world, unit for unit, every step.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, CollisionGrid } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT
const W = 256, H = 256; // 8192 x 8192 world units, origin at (0,0)

/** Deterministic pseudo-random, so both arms see exactly the same world. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function addUnit(w, id, x, y, radius) {
  const weapons = [WEAPON()];
  return w.add({
    id, owner: 0, team: 0, typeId: "hfoo", x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: radius,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    weapons, oldWeapons: weapons,
  });
}

/**
 * `clumps` crowds of `per` bodies of mixed size (8–48, the spread of the collision table from a
 * Wisp to a Kodo), half of each crowd sent THROUGH the next crowd along — the head-on, crossing,
 * shoulder-to-shoulder traffic the separation pass exists for — and the rest left standing, so
 * idle and moving bodies meet in every combination.
 */
function scenario(enabled, clumps, per, steps, timed) {
  CollisionGrid.enabled = enabled;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const w = new SimWorld(grid, 1);
  const r = rng(0xc0111de);
  const sizes = [8, 16, 16, 24, 32, 48];
  const centres = [];
  for (let c = 0; c < clumps; c++) {
    const a = (c / clumps) * Math.PI * 2;
    centres.push([4096 + Math.cos(a) * 1400, 4096 + Math.sin(a) * 1400]);
  }
  let id = 1;
  for (let c = 0; c < clumps; c++) {
    const [cx, cy] = centres[c];
    for (let k = 0; k < per; k++) {
      addUnit(w, id++, cx + (r() - 0.5) * 520, cy + (r() - 0.5) * 520, sizes[(r() * sizes.length) | 0]);
    }
  }
  id = 1;
  for (let c = 0; c < clumps; c++) {
    const [tx, ty] = centres[(c + 1) % clumps];
    for (let k = 0; k < per; k++, id++) {
      if (k % 2 === 0) w.issueMove(id, tx + (r() - 0.5) * 300, ty + (r() - 0.5) * 300);
    }
  }
  const proto = Object.getPrototypeOf(w);
  const inner = proto.resolveCollisions;
  let ms = 0;
  if (timed) {
    w.resolveCollisions = function () {
      const t0 = performance.now();
      inner.call(this);
      ms += performance.now() - t0;
    };
  }
  const trace = [];
  for (let s = 0; s < steps; s++) {
    w.tick(SIM_DT);
    const row = new Float64Array(w.units.size * 3);
    let i = 0;
    for (const u of w.units.values()) {
      row[i++] = u.x;
      row[i++] = u.y;
      row[i++] = u.facing;
    }
    trace.push(row);
  }
  CollisionGrid.enabled = true;
  return { trace, msPerStep: ms / steps, bodies: w.units.size };
}

function firstDifference(a, b) {
  if (a.length !== b.length) return `step count ${a.length} vs ${b.length}`;
  for (let s = 0; s < a.length; s++) {
    if (a[s].length !== b[s].length) return `unit count differs at step ${s}`;
    for (let i = 0; i < a[s].length; i++) {
      if (!Object.is(a[s][i], b[s][i])) return `step ${s}, unit #${(i / 3) | 0}: ${a[s][i]} vs ${b[s][i]}`;
    }
  }
  return null;
}

console.log("the grid pass and the all-pairs pass leave the same world, step for step");
{
  // 6 crowds of 60 = 360 bodies for 12 seconds — long enough for the crossing waves to meet,
  // jam, slide past each other and arrive.
  const grid = scenario(true, 6, 60, 720, false);
  const pairs = scenario(false, 6, 60, 720, false);
  const diff = firstDifference(grid.trace, pairs.trace);
  check("360 mixed bodies, 720 steps: every position and facing identical", diff === null, diff ?? "");
  const moved = grid.trace[0].some((v, i) => i % 3 !== 2 && v !== grid.trace[grid.trace.length - 1][i]);
  check("…and the crowds actually moved (the comparison is not of two still pictures)", moved);
}
{
  // One dense pile: every body inside everybody's reach, the grid's worst case, where a nudge
  // re-files units between cells constantly.
  const grid = scenario(true, 1, 240, 360, false);
  const pairs = scenario(false, 1, 240, 360, false);
  const diff = firstDifference(grid.trace, pairs.trace);
  check("240 bodies in one pile, 360 steps: identical", diff === null, diff ?? "");
}

console.log("what it is worth (informational — the collision pass alone, ms per step)");
for (const [clumps, per] of [[6, 75], [8, 125], [10, 160]]) {
  const grid = scenario(true, clumps, per, 600, true);
  const pairs = scenario(false, clumps, per, 600, true);
  console.log(`      ${String(grid.bodies).padStart(5)} bodies: all-pairs ${pairs.msPerStep.toFixed(3)} ms, grid ${grid.msPerStep.toFixed(3)} ms`);
}

if (failed) {
  console.log(`\ncollision grid: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\ncollision grid: all checks passed");
