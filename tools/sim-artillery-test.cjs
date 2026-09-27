// ARTILLERY — the Mortar Team, the Demolisher, the Meat Wagon, the Glaive Thrower.
//
// Liquipedia's Weapon Types page, under Artillery: the attacks "can be actively dodged, as they
// do not target units, but areas"; they "add the Attack Ground button to the unit"; and "units
// killed by Artillery attacks splatter and do not leave corpses behind". Its Mortar Team page:
// "Mortar Teams will damage your own units". Its Demolisher and Meat Wagon pages: they "cannot
// attack melee units or any units right next to them. You will have to move them away." And the
// shell is LOBBED by the weapon's own `Missilearc` (UnitFunc.txt: 0.35 on the Mortar Team).
//
// Every one of those is pinned here against a mortar-shaped weapon row lifted from the install
// (UnitWeapons [hmtm]: artillery, 1150 range, minRange 250, rings 25/100/200 at 1/0.4/0.1,
// splashTargs ground,structure,debris,tree,wall — no allegiance word).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { flyHeight } = require(join(REPO, ".sim-build", "src", "sim", "missile.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60;
const W = 256, H = 256;
const grid = () => new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);

const mortarSlot = (over = {}) => ({
  enabled: true, targets: ["ground", "debris", "tree", "wall", "item", "ward"],
  weaponType: "artillery", attackType: "siege",
  damage: 50, dice: 1, sides: 1, cooldown: 3.5, range: 1150, rangeBuffer: 250,
  damagePoint: 0.1, backswing: 0.1,
  missileArt: "Abilities\\Weapons\\Mortar\\MortarMissile.mdx", missileSpeed: 900, missileArc: 0.35,
  spillDist: 0, spillRadius: 0, damageLoss: 0,
  areaFull: 25, areaHalf: 100, areaQuarter: 200, areaHalfFactor: 0.4, areaQuarterFactor: 0.1,
  splashTargets: ["ground", "structure", "debris", "tree", "wall"], showUI: true, ...over,
});
const mortar = (over = {}, def = {}) => weaponsFromDef({
  weapons: [mortarSlot(over)], acquireRange: 1150, minRange: 250, launchX: 0, launchY: 0, launchZ: 60, impactZ: 0, ...def,
});

function addUnit(w, id, owner, x, y, weapons, over = {}) {
  return w.add({
    id, owner, team: over.team !== undefined ? over.team : owner,
    typeId: "t" + id, x, y, facing: 0, flyHeight: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "T" + id,
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    ...over, weapons, oldWeapons: weapons,
  });
}

/** Run until `until()` or the tick budget, draining the per-tick queues as the renderer does. */
function run(w, ticks, until = () => false, each = () => {}) {
  for (let i = 0; i < ticks; i++) {
    w.tick(SIM_DT);
    each(w);
    w.drainSpawnedProjectiles();
    w.drainProjectileImpacts();
    w.drainRemovedProjectiles();
    w.drainHits();
    if (until(w)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------
console.log("\nthe LOB: the peak is Missilearc × distance above the launch→impact line");
{
  const p = { z: 0, startZ: 60, impactZ: 0, startDist: 1000, arc: 0.35 };
  flyHeight(p, 500); // half way
  check("mid-flight a 0.35 shell thrown 1000 is 350 above the line (30 + 350)", Math.abs(p.z - 380) < 1e-6, `z ${p.z}`);
  check("…and level at the top", Math.abs(p.pitch - Math.atan(-60 / 1000)) < 1e-6);
  flyHeight(p, 1000);
  check("it leaves from its launch height", Math.abs(p.z - 60) < 1e-6);
  check("…nose up, at atan(4 × arc) near enough", p.pitch > 0.9 && p.pitch < 1.0, `pitch ${p.pitch.toFixed(3)}`);
  flyHeight(p, 0);
  check("and lands at its impact height", Math.abs(p.z) < 1e-6);
  const short = { z: 0, startZ: 0, impactZ: 0, startDist: 300, arc: 0.35 };
  flyHeight(short, 150);
  check("a short throw is a low one (105 at 300)", Math.abs(short.z - 105) < 1e-6);
  const flat = { z: 0, startZ: 60, impactZ: 60, startDist: 1000, arc: 0 };
  flyHeight(flat, 500);
  check("an arc of 0 is the straight line it always was", flat.z === 60 && flat.pitch === 0);
}
{
  // …and in the sim: the shell really goes up, and the flight still takes distance / speed.
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar());
  const t = addUnit(w, 2, 1, 2000, 1000, []);
  w.issueOrder(m.id, { kind: "attack", targetId: t.id, force: true });
  let peak = 0, flying = 0;
  run(w, 600, () => flying > 0 && w.projectiles.size === 0, (w) => {
    for (const p of w.projectiles.values()) { peak = Math.max(peak, p.z); flying++; }
  });
  check("the sim's shell climbs to about arc × distance", peak > 300 && peak < 400, `peak ${peak.toFixed(0)}`);
  const secs = flying * SIM_DT, want = 984 / 900; // hull-to-hull flight from the launch point
  check("…in the time its horizontal speed takes (the arc costs no time)", Math.abs(secs - want) < 0.1, `${secs.toFixed(2)} s vs ${want.toFixed(2)} s`);
}

console.log("\nSPELL MISSILES lob by their own row's Missilearc too");
function spellPeak(missileArc) {
  const w = new SimWorld(grid(), 2);
  const c = addUnit(w, 1, 0, 1000, 1000, []);
  const t = addUnit(w, 2, 1, 1800, 1000, []);
  // The door resolveCast uses for a unit-target spell with a Missileart (Storm Bolt, Acid Bomb).
  // A code with no handler, so landing it does nothing but land.
  const def = { id: "Xtst", code: "Xtst", missileArt: "m.mdx", missileSpeed: 900, missileArc, levelData: [] };
  w.spawnSpellProjectile(c, t.id, def, 1);
  let peak = 0;
  run(w, 300, (w) => w.projectiles.size === 0, (w) => { for (const p of w.projectiles.values()) peak = Math.max(peak, p.z); });
  return peak;
}
{
  const acid = spellPeak(0.4); // [ANab] Acid Bomb: Missilearc=0.4
  const bolt = spellPeak(0); // [AHtb] Storm Bolt states none
  check("a 0.4 spell missile thrown ~800 peaks ~0.4 × 784 above its 60-unit line", Math.abs(acid - 60 - 0.4 * 784) < 20, `peak ${acid.toFixed(0)}`);
  check("a row that states no arc flies level", bolt < 80, `peak ${bolt.toFixed(0)}`);
}

console.log("\nFRIENDLY FIRE: a burst with no allegiance word in its splashTargs catches both sides");
function burst(splashTargets, ally = true) {
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar({ splashTargets }));
  const foe = addUnit(w, 2, 1, 1600, 1000, []);
  const friend = ally ? addUnit(w, 3, 0, 1640, 1000, []) : null; // 40 away: inside the 0.4 ring
  w.issueOrder(m.id, { kind: "attack", targetId: foe.id, force: true });
  let launched = false;
  run(w, 600, () => launched && w.projectiles.size === 0, (w) => { if (w.projectiles.size) launched = true; });
  return { foe, friend };
}
{
  const { foe, friend } = burst(["ground", "structure", "debris", "tree", "wall"]);
  check("the enemy the shell was aimed at is hit in full", foe.hp < 1000, `hp ${foe.hp}`);
  check("the shooter's own Footman beside it is hit too", friend.hp < 1000, `hp ${friend.hp}`);
  check("…by the ring he is in (0.4 of the blow)", friend.hp > foe.hp);
}
{
  const { foe, friend } = burst(["ground", "structure", "enemy"]);
  check("a row that SAYS enemy still spares the shooter's side", foe.hp < 1000 && friend.hp === 1000, `friend hp ${friend.hp}`);
}

console.log("\nSPLATTER: what a burst kills leaves no corpse");
{
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar({ damage: 5000 }));
  const foe = addUnit(w, 2, 1, 1600, 1000, []);
  w.issueOrder(m.id, { kind: "attack", targetId: foe.id, force: true });
  run(w, 600, () => !w.units.has(foe.id));
  check("the target died", !w.units.has(foe.id));
  check("…exploded, as SetUnitExploded does", w.diedExploded(foe.id));
  check("…and left nothing to raise", ![...w.corpses.values()].some((c) => c.unitId === foe.id || c.deadId === foe.id));
}

console.log("\nDODGED: the shell flies at the spot, not the unit");
{
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar());
  const foe = addUnit(w, 2, 1, 1800, 1000, []);
  w.issueOrder(m.id, { kind: "attack", targetId: foe.id, force: true });
  let moved = false;
  run(w, 600, () => moved && w.projectiles.size === 0, (w) => {
    if (!moved && w.projectiles.size) { moved = true; foe.x += 600; } // walked out from under it
  });
  check("a target that left the rings takes nothing", foe.hp === 1000, `hp ${foe.hp}`);
}

console.log("\nATTACK GROUND: shells a spot until told otherwise");
{
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar());
  const own = addUnit(w, 2, 0, 1700, 1000, []); // nobody's enemy: the ground is the target
  const ok = w.issueOrder(m.id, { kind: "attackground", x: 1700, y: 1000 });
  check("a mortar takes the order", ok && m.order === "attackground");
  run(w, 60 * 12);
  check("it is still on the order after 12 s", m.order === "attackground");
  check("…and the ground it shelled has hurt what stood there, its own unit included", own.hp < 1000 - 100, `hp ${own.hp}`);
  const archer = addUnit(w, 3, 0, 900, 900, weaponsFromDef({
    weapons: [mortarSlot({ weaponType: "missile" })], acquireRange: 800, launchX: 0, launchY: 0, launchZ: 60, impactZ: 60,
  }));
  check("a unit with no artillery slot has no such order", !w.issueOrder(archer.id, { kind: "attackground", x: 1700, y: 1000 }));
}
{
  // Out of reach: it walks in, then fires.
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 500, 500, mortar());
  w.issueOrder(m.id, { kind: "attackground", x: 3000, y: 500 });
  let fired = -1;
  run(w, 60 * 20, () => fired >= 0, (w) => { if (w.projectiles.size) fired = m.x; });
  check("a spot beyond the range is walked to and shelled from range", fired > 0 && 3000 - fired <= 1150 + 16 + 1, `fired from x=${fired.toFixed?.(0)}`);
}
{
  // Aimed at a TREE, the order is the tree's: the burst fells it and the shelling stops.
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar());
  const tree = w.addTree(1600, 1000);
  tree.hp = 80;
  const near = w.addTree(1690, 1000); // in the 0.1 ring
  near.hp = 80;
  w.issueOrder(m.id, { kind: "attackground", x: tree.x, y: tree.y, treeId: tree.id });
  run(w, 60 * 12, () => m.order !== "attackground");
  check("the tree came down", !w.trees.has(tree.id));
  check("…and the order ended with it", m.order !== "attackground", m.order);
  check("the burst's outer ring hurt the tree beside it and left it standing", w.trees.has(near.id) && near.hp < 80, `hp ${near.hp}`);
}

console.log("\nMINIMUM RANGE: nothing inside 250 is shot at");
{
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar());
  const close = addUnit(w, 2, 1, 1150, 1000, []); // 118 hull to hull
  run(w, 60 * 3);
  check("an idle mortar does not pick the enemy in its dead zone", m.targetId === null && close.hp === 1000, `target ${m.targetId}`);
  const x0 = m.x, y0 = m.y; // where it stands (a spawn snaps to its cell)
  w.issueOrder(m.id, { kind: "attack", targetId: close.id, force: true });
  let launched = false;
  run(w, 60 * 3, () => false, (w) => { if (w.projectiles.size) launched = true; });
  check("ordered onto it, it holds the order and fires nothing", !launched && m.order === "attack");
  check("…and does not back off by itself", Math.hypot(m.x - x0, m.y - y0) < 2);
  close.x = 1600; // steps out of the dead zone
  run(w, 60 * 3, () => false, (w) => { if (w.projectiles.size) launched = true; });
  check("once it steps back out, the shell goes", launched);
  const w2 = new SimWorld(grid(), 2);
  const m2 = addUnit(w2, 1, 0, 1000, 1000, mortar());
  addUnit(w2, 2, 1, 1150, 1000, []);
  const f2 = addUnit(w2, 3, 1, 1000, 1700, []);
  run(w2, 60 * 4);
  check("with one enemy too close and one in range, it acquires the one it can hit", m2.targetId === f2.id, `target ${m2.targetId}`);
}

console.log(failures ? `\nartillery: ${failures} FAILED` : "\nartillery: all checks passed");
process.exit(failures ? 1 : 0);
