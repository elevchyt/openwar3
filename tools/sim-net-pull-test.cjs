// Headless check that a NET brings a FLYER down — Web (`Aweb`) and Ensnare (`Aens`) alike:
// "Air units that are ensnared can be attacked as though they were land units" ([Aens]
// Ubertip, OrcAbilityStrings.txt). The flyer falls to the ground (flyHeight 0), answers to
// `ground` so a melee weapon can reach it, and — netted over unwalkable ground (a forest) — is
// DRAGGED along the line toward the net's thrower to the first free walkable block
// (SimWorld.netAltitude). Let go, it climbs back to its type's own altitude.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PATHING_CELL } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
const check = (what, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${ok ? "" : `  want ${want}, got ${got}`}`);
};
const W = 64;
const FOREST = [36, 52]; // cell columns [from, to) that are trees (Unwalkable)
const weapon = (targets, over = {}) => ({
  enabled: true, targets, ranged: false,
  damage: 50, baseDamage: 50, dice: 1, baseDice: 1, sides: 1,
  cooldown: 1, baseCooldown: 1, range: 100, baseRange: 100, rangeBuffer: 250,
  damagePoint: 0.1, baseDamagePoint: 0.1, backswing: 0.1, baseBackswing: 0.1,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 600, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0, ...over,
});
function addUnit(w, id, owner, x, y, weapons, fly = false) {
  const u = w.add({
    id, owner, team: owner, typeId: fly ? "ugar" : "unit", x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    sightDay: 1800, sightNight: 1800, flying: fly, mechanical: false, invulnerable: false,
    race: "undead", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, upgrades: [],
    moveType: fly ? "fly" : "foot", collisionSize: 16, canFlee: true, targetedAs: fly ? "air" : "ground", deathTime: 2,
    name: "u", worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons, oldWeapons: weapons,
  });
  if (fly) u.flyHeight = 240;
  return u;
}
const net = (u, group, sourceId) => {
  u.buffs.push({ kind: "root", group, timeLeft: 5, total: 5, sourceId, value: 1, value2: 0, art: "", fx: [], buffId: "", delay: 0 });
};
const run = (w, s) => { for (let i = 0; i < Math.round(s * 60); i++) w.tick(1 / 60); };
function world() {
  const flags = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = FOREST[0]; x < FOREST[1]; x++) flags[y * W + x] = 0x0a;
  const w = new SimWorld(new PathingGrid({ width: W, height: W, flags }, [0, 0]), 1);
  w.unitReg = { get: (id) => (id === "ugar" ? { moveHeight: 240, collision: 16, abilities: [], moveType: "fly" } : undefined) };
  return w;
}
const forestEdge = FOREST[0] * PATHING_CELL;

for (const group of ["ensnare", "web"]) {
  console.log(`${group}: a flyer over open ground`);
  {
    const w = world();
    const raider = addUnit(w, 1, 0, 300, 1000, []);
    const garg = addUnit(w, 2, 1, 600, 1000, [], true);
    const foot = addUnit(w, 3, 0, 400, 1000, [weapon(["ground", "structure"])]);
    check("a footman cannot hit it in the air", w.issueAttack(foot.id, garg.id, false, true), false);
    net(garg, group, raider.id);
    run(w, 0.1);
    check("it is pulled down", garg.webbed, true);
    run(w, 0.5);
    check("…all the way to the ground", garg.flyHeight, 0);
    check("…without being moved", Math.round(garg.x), 600);
    check("a footman can hit it now", w.issueAttack(foot.id, garg.id, false, true), true);
    run(w, 5);
    check("let go, it is a flyer again", garg.webbed, false);
    check("…back at its own altitude", garg.flyHeight, 240);
  }
  console.log(`${group}: a flyer netted over the trees`);
  {
    const w = world();
    const raider = addUnit(w, 1, 0, 300, 1000, []);
    const garg = addUnit(w, 2, 1, (FOREST[0] + 8) * PATHING_CELL, 1000, [], true);
    net(garg, group, raider.id);
    run(w, 0.6);
    check("it lands", garg.flyHeight, 0);
    check("…dragged out of the forest", garg.x < forestEdge, true);
    check("…toward the thrower, not past it", garg.x > raider.x, true);
    check("…along the line to him", Math.abs(garg.y - 1000) < 8, true);
    check("…to the first free block, at the forest's edge", forestEdge - garg.x <= PATHING_CELL * 1.5, true);
  }
}
console.log("Entangling Roots never pulls anything down (it never reaches a flyer anyway)");
{
  const w = world();
  const garg = addUnit(w, 2, 1, 600, 1000, [], true);
  net(garg, "roots", 0);
  run(w, 0.6);
  check("not webbed", garg.webbed, false);
  check("still aloft", garg.flyHeight, 240);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
