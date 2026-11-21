// What a fight costs the PATHFINDER, and who asked — a measurement, not a pass/fail test.
//
// docs/perf-research.md: in a 180-unit fight the pathfinder is 29% of all CPU, and the lever is
// fewer searches rather than cheaper ones. Anything that cuts searches changes where units walk,
// so before a change lands it is run through here BOTH ways and has to show two things at once:
// the searches went down, and the fight did not get worse (the same bodies reach the enemy, as
// soon, and nobody is left standing behind the line).
//
// Every `findPath` is attributed to the SimWorld method that asked for it (the outermost caller
// that is not itself part of the path machinery), with what it spent and whether it arrived.
//
// Run:  tsc -p tools/tsconfig.sim.json && node tools/sim-path-budget.cjs [--switch Name.key=value …]
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const pathfind = require(join(REPO, ".sim-build", "src", "sim", "pathfind.js"));
const world = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { SimWorld } = world;

const SIM_DT = 1 / 60;
const STEPS = 20 * 60; // the profile's own window: 20 s of the fight

// --- attribution ------------------------------------------------------------------------------
/** Path machinery: a search inside one of these belongs to whoever called IT. */
const MACHINERY = new Set(["pathTo", "repairPath", "escalate", "pumpPathJob", "requestLongPath", "airPath", "tick", "tickMovement", "constructor"]);
const stack = [];
let tally = new Map();
function wrapAll() {
  const proto = SimWorld.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof d.value !== "function" || name === "constructor") continue;
    const fn = d.value;
    proto[name] = function (...args) {
      stack.push(name);
      try { return fn.apply(this, args); } finally { stack.pop(); }
    };
  }
  const real = pathfind.findPath;
  pathfind.findPath = function (...args) {
    const cells = real.apply(this, args);
    let who = "(none)";
    for (const n of stack) if (!MACHINERY.has(n)) { who = n; break; }
    // …and which primitive ran it: a plan, a repair or an escalated job.
    const via = stack.includes("repairPath") ? "repair" : stack.includes("escalate") || stack.includes("pumpPathJob") ? "escalate" : "plan";
    const key = `${who} · ${via}`;
    const row = tally.get(key) ?? { n: 0, exp: 0, arrived: 0, arrivedExp: 0 };
    const spent = pathfind.pathExpansionsSpent();
    row.n++; row.exp += spent;
    if (pathfind.pathArrived()) { row.arrived++; row.arrivedExp += spent; }
    tally.set(key, row);
    return cells;
  };
}

// --- the fight --------------------------------------------------------------------------------
const WEAPON = (over = {}) => ({
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 90, baseRange: 90, rangeBuffer: 250,
  dice: 1, baseDice: 1, sides: 6, base: 12, damage: 12, baseDamage: 12, cooldown: 1.35, baseCooldown: 1.35,
  rangeMotionBuffer: 250, damagePoint: 0.5, baseDamagePoint: 0.5, backswing: 0.5, baseBackswing: 0.5,
  baseSpillDist: 0, baseSpillRadius: 0, attackType: "normal", ranged: false,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0, ...over,
});
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function spawn(w, id, owner, x, y, ranged) {
  const weapon = WEAPON(ranged ? { range: 500, baseRange: 500, ranged: true, attackType: "pierce", damage: 16, baseDamage: 16, projectile: "x" } : {});
  return w.add({
    id, owner, team: owner, typeId: ranged ? "hrif" : "hfoo", x, y, facing: 0,
    hp: ranged ? 505 : 420, maxHp: ranged ? 505 : 420, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: ranged ? 16 : 31, scale: 1, armor: 2, armorType: ranged ? "medium" : "large", defUp: 0,
    weapon, weapons: [weapon], oldWeapons: [weapon],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: ranged ? 16 : 31,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: ranged ? "rifleman" : "footman",
    worker: null, depotGold: false, depotLumber: false,
  });
}

/** A melee map's middle: open ground with clumps of trees, so a route is sometimes a detour. */
function field(W, H, r) {
  const flags = new Uint8Array(W * H);
  for (let k = 0; k < 26; k++) {
    const cx = 24 + Math.floor(r() * (W - 48)), cy = 24 + Math.floor(r() * (H - 48));
    const rad = 3 + Math.floor(r() * 5);
    for (let y = cy - rad; y <= cy + rad; y++)
      for (let x = cx - rad; x <= cx + rad; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) flags[y * W + x] = PathingFlag.Unwalkable;
  }
  return flags;
}

function run(seed) {
  tally = new Map();
  const W = 256, H = 256; // 8192 world units a side
  const r = rng(seed);
  const g = new PathingGrid({ width: W, height: H, flags: field(W, H, r) }, [0, 0]);
  const w = new SimWorld(g, 1);
  let id = 1;
  const PER_SIDE = 90;
  const army = (owner, cx) => {
    let made = 0;
    while (made < PER_SIDE) {
      const x = cx + (r() - 0.5) * 1100, y = 4096 + (r() - 0.5) * 1700;
      const [cxl, cyl] = g.worldToCell(x, y);
      if (!g.walkable(cxl, cyl)) continue;
      spawn(w, id++, owner, x, y, made % 3 === 2);
      made++;
    }
  };
  army(0, 2700);
  army(1, 5500);
  for (const u of w.units.values()) w.issueAttackMove(u.id, u.owner === 0 ? 5500 : 2700, 4096);
  const firstSwing = new Map(); // unit → step it first had a target in a swing
  const hpAt0 = new Map([...w.units.values()].map((u) => [u.id, u.hp]));
  let total = 0;
  for (const v of hpAt0.values()) total += v;
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < STEPS; s++) {
    w.tick(SIM_DT);
    for (const u of w.units.values()) if (!firstSwing.has(u.id) && u.swingLeft >= 0) firstSwing.set(u.id, s);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let left = 0;
  for (const u of w.units.values()) if (hpAt0.has(u.id)) left += Math.max(0, u.hp);
  const swings = [...firstSwing.values()].sort((a, b) => a - b);
  return {
    ms,
    alive: [...w.units.values()].filter((u) => u.hp > 0).length,
    damage: Math.round(total - left),
    fought: swings.length,
    medianFirstSwing: swings.length ? (swings[swings.length >> 1] * SIM_DT).toFixed(2) : "-",
    p90FirstSwing: swings.length ? (swings[Math.floor(swings.length * 0.9)] * SIM_DT).toFixed(2) : "-",
    tally,
  };
}

// --- switches from the command line: `--switch ShovedPathReuse.enabled=false` ------------------
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== "--switch") continue;
  const [path, value] = process.argv[++i].split("=");
  const [obj, key] = path.split(".");
  if (!world[obj] || !(key in world[obj])) throw new Error(`no switch ${path}`);
  world[obj][key] = JSON.parse(value);
  console.log(`switch ${path} = ${value}`);
}

wrapAll();
const seeds = [0x51ed, 0xbeef, 0x1234];
const sum = new Map();
const outcomes = [];
for (const seed of seeds) {
  const r = run(seed);
  outcomes.push(r);
  for (const [k, v] of r.tally) {
    const row = sum.get(k) ?? { n: 0, exp: 0, arrived: 0, arrivedExp: 0 };
    row.n += v.n; row.exp += v.exp; row.arrived += v.arrived; row.arrivedExp += v.arrivedExp;
    sum.set(k, row);
  }
}
const rows = [...sum].sort((a, b) => b[1].exp - a[1].exp);
let N = 0, E = 0;
for (const [, v] of rows) { N += v.n; E += v.exp; }
console.log(`\n${seeds.length} fights × ${STEPS} steps, 180 units each`);
console.log("caller · kind".padEnd(34) + "searches".padStart(9) + "expansions".padStart(12) + "  share" + "  arrived" + "  exp/search" + "  exp/arrived" + "  exp/failed");
for (const [k, v] of rows) {
  console.log(k.padEnd(34) + String(v.n).padStart(9) + String(v.exp).padStart(12) + `  ${((100 * v.exp) / E).toFixed(1).padStart(5)}%` + `  ${String(v.arrived).padStart(7)}` + `  ${Math.round(v.exp / v.n)}`.padStart(13) + `${v.arrived ? Math.round(v.arrivedExp / v.arrived) : "-"}`.padStart(13) + `${v.n > v.arrived ? Math.round((v.exp - v.arrivedExp) / (v.n - v.arrived)) : "-"}`.padStart(12));
}
console.log("TOTAL".padEnd(34) + String(N).padStart(9) + String(E).padStart(12));
console.log("\noutcome per fight (must not get worse):");
for (const o of outcomes) {
  console.log(`  alive ${o.alive}  damage ${o.damage}  fought ${o.fought}/180  first swing median ${o.medianFirstSwing}s p90 ${o.p90FirstSwing}s  wall ${o.ms.toFixed(0)}ms`);
}
