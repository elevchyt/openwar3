// A unit FOLLOWING a hero across the map gets round what is in the way — while the hero keeps
// walking.
//
// The report was "units rallied to a hero sometimes stand stuck in a corner". A chase re-planned
// whenever its target strayed CHASE_REPATH (128) from where the route was aimed, and a walking
// hero does that every 0.4 s. Each re-plan is the 700-cell chase search, which against a
// treeline comes back short and aims the unit at the trees; the real way round is an escalated
// DETOUR, of which there is one slot. So six followers behind a wall each had their detour
// replaced by a walk at the wall two and a half times a second, and paced in front of it until
// the hero stood still. `ChaseDrift.far` makes the tolerance a share of the distance still to
// go, so a route across the map survives the hero's wandering.
//
// The control is the same walk with the hero standing still, which never had the problem: a
// moving hero may cost a few seconds, not a multiple.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const world = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { SimWorld } = world;
const SIM_DT = 1 / 60;
const WEAPON = { enabled: true, targets: ["ground"], acquire: 600, range: 90, baseRange: 90, rangeBuffer: 250, dice: 1, baseDice: 1, sides: 6, base: 12, damage: 12, baseDamage: 12, cooldown: 1.35, baseCooldown: 1.35, rangeMotionBuffer: 250, damagePoint: 0.5, baseDamagePoint: 0.5, backswing: 0.5, baseBackswing: 0.5, baseSpillDist: 0, baseSpillRadius: 0, attackType: "normal", ranged: false, projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0, factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0, spillDist: 0, spillRadius: 0, damageLoss: 0 };
function spawn(w, id, x, y, speed = 270) {
  return w.add({ id, owner: 0, team: 0, typeId: "hfoo", x, y, facing: 0, hp: 420, maxHp: 420, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0, speed, turnRate: 0.6, radius: 31, scale: 1, armor: 2, armorType: "large", defUp: 0, weapon: { ...WEAPON }, weapons: [{ ...WEAPON }], oldWeapons: [{ ...WEAPON }], sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800, castPoint: 0, castBackswing: 0, flying: false, mechanical: false, invulnerable: false, race: "human", isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0, abilities: [], upgrades: [], moveType: "foot", collisionSize: 31, canFlee: true, targetedAs: "ground", deathTime: 2, name: "footman", worker: null, depotGold: false, depotLumber: false });
}
const W = 384, H = 384; // 12288 world units
function terrain(kind) {
  const f = new Uint8Array(W * H);
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) f[y * W + x] = PathingFlag.Unwalkable; };
  if (kind === "cup") {
    // A cup open to the WEST (toward the followers), its closed end toward the hero: the
    // best-effort route walks into the pocket.
    rect(150, 120, 230, 126); rect(150, 250, 230, 256); rect(224, 120, 230, 256);
  } else if (kind === "base") {
    // A base ringed by trees with one exit on the far (west) side: the follower starts inside.
    rect(40, 120, 46, 260); rect(40, 120, 140, 126); rect(40, 254, 140, 260); rect(134, 120, 140, 180); rect(134, 200, 140, 260);
    rect(150, 150, 190, 156); rect(140, 224, 190, 230); rect(184, 150, 190, 230); // a second pocket outside the gate
  } else if (kind === "wall") {
    rect(200, 40, 206, 344);
  }
  return f;
}
function run(kind, heroMoves, nFollow, LIMIT = 1e9) {
  const g = new PathingGrid({ width: W, height: H, flags: terrain(kind) }, [0, 0]);
  const w = new SimWorld(g, 1);
  const hero = spawn(w, 1, 9000, 6016, 270);
  const ids = [];
  for (let i = 0; i < nFollow; i++) { spawn(w, 10 + i, 2800 + (i % 3) * 90, 5900 + Math.floor(i / 3) * 90); ids.push(10 + i); }
  for (const id of ids) w.issueFollow(id, 1);
  // The hero wanders the far side the way a creeping hero does.
  // …a few seconds' walk, then a few seconds at the camp: never still for long, never out of reach.
  const stops = [[9000, 4600], [10300, 5600], [9200, 7200], [10500, 6800], [9400, 5400]];
  let leg = 0;
  const T = 120 * 60;
  let arrivedAt = new Map();
  for (let s = 0; s < T; s++) {
    if (heroMoves && s % (10 * 60) === 0 && s < LIMIT) { const [x, y] = stops[leg++ % stops.length]; w.issueMove(1, x, y); }
    w.tick(SIM_DT);
    for (const id of ids) { const u = w.units.get(id); if (!arrivedAt.has(id) && Math.hypot(u.x - hero.x, u.y - hero.y) < 400) arrivedAt.set(id, s); }
  }
  return { times: ids.map((id) => (arrivedAt.has(id) ? arrivedAt.get(id) / 60 : Infinity)) };
  const out = ids.map((id) => { const u = w.units.get(id); return `${id}:${arrivedAt.has(id) ? (arrivedAt.get(id) / 60).toFixed(0) + "s" : `NEVER d=${Math.round(Math.hypot(u.x - hero.x, u.y - hero.y))} at ${Math.round(u.x)},${Math.round(u.y)} ord=${u.order} moving=${u.moving}`}`; });

}

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}
const worst = (r) => Math.max(...r.times);
for (const [kind, n] of [["wall", 6], ["wall", 12], ["cup", 6], ["base", 6]]) {
  const still = run(kind, false, n);
  const moving = run(kind, true, n);
  check(`${kind}, ${n} followers: everyone reaches a hero who stands still`, worst(still) < 90, `last at ${worst(still).toFixed(0)}s`);
  check(`${kind}, ${n} followers: …and one who keeps walking, nearly as soon`, worst(moving) <= worst(still) + 20,
    `last at ${worst(moving).toFixed(0)}s against ${worst(still).toFixed(0)}s`);
}
// The rule as it was, so the test is known to see the bug it is here for.
world.ChaseDrift.far = 0;
{
  const still = run("wall", false, 6);
  const moving = run("wall", true, 6);
  check("with the flat 128 the same six are held at the wall (the test sees the bug)", worst(moving) > worst(still) + 20,
    `last at ${worst(moving).toFixed(0)}s against ${worst(still).toFixed(0)}s`);
}
world.ChaseDrift.far = 0.25;
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall follow-detour checks passed");
