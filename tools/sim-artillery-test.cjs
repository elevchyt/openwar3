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

console.log("\nMISSED: a missed shell still bursts, at (1 - MissDamageReduction) of every ring");
// Liquipedia's Miss page: "Missed single target attacks deal no damage" but "Missed splash attacks
// deal … reduced damage"; the install's MiscGame.txt MissDamageReduction = 0.5. And the miss is the
// ATTACK's, rolled once — not once per body in the rings.
function cursedBurst(curse) {
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, mortar());
  const foe = addUnit(w, 2, 1, 1600, 1000, []);
  const near = addUnit(w, 3, 1, 1660, 1000, []); // 60 - 16 = 44 from the aim: the 0.4 ring
  if (curse) m.buffs.push({ kind: "miss", group: "curse", timeLeft: 999, sourceId: 0, value: 1 }); // misses every time
  w.issueOrder(m.id, { kind: "attack", targetId: foe.id, force: true });
  let launched = false;
  run(w, 600, () => launched && w.projectiles.size === 0, (w) => { if (w.projectiles.size) launched = true; });
  return { foe: 1000 - foe.hp, near: 1000 - near.hp };
}
{
  const hit = cursedBurst(false);
  const miss = cursedBurst(true);
  check("a cursed mortar's shell still lands on what it was aimed at", miss.foe > 0, `took ${miss.foe.toFixed(1)}`);
  check("…at half the blow a clean shell deals", Math.abs(miss.foe - hit.foe / 2) < 1e-6, `${miss.foe.toFixed(1)} vs ${hit.foe.toFixed(1)}`);
  check("…and the ring beside it is halved the same way, not rolled again", Math.abs(miss.near - hit.near / 2) < 1e-6, `${miss.near.toFixed(1)} vs ${hit.near.toFixed(1)}`);
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

console.log("\nTHROWN FIELDS: Healing Spray's bottles and Cluster Rockets' rockets are real missiles");
{
  // A heal wave (Healing Spray's shape): 3 waves 1 s apart, 6 bottles each, 30 a wave.
  const w = new SimWorld(grid(), 2);
  const alc = addUnit(w, 1, 0, 1000, 1000, []);
  const ally = addUnit(w, 2, 0, 1700, 1000, []);
  ally.hp = 500;
  w.addSpellFieldInternal({
    code: "ANhs", x: 1700, y: 1000, area: 250, damagePerWave: 0, waves: 3, interval: 1, casterId: 1,
    art: "HealBottleMissile.mdx", artPerWave: 6, thrown: { speed: 700, arc: 0.4 }, healPerWave: 30,
  });
  const spawned = [];
  let healedAt = -1, peak = 0;
  for (let i = 0; i < 60 * 5; i++) {
    w.tick(SIM_DT);
    spawned.push(...w.drainSpawnedProjectiles());
    for (const p of w.projectiles.values()) peak = Math.max(peak, p.z);
    w.drainProjectileImpacts(); w.drainRemovedProjectiles();
    if (healedAt < 0 && ally.hp > 500) healedAt = i * SIM_DT;
  }
  check("each wave throws its six bottles as missiles", spawned.length === 18, `${spawned.length} missiles`);
  check("…lobbed by the row's arc (0.4 of ~700)", peak > 200, `peak ${peak.toFixed(0)}`);
  const flight = 700 / 700;
  check("the heal lands when the bottles do, not at the throw", Math.abs(healedAt - flight) < 0.15, `healed at ${healedAt.toFixed(2)} s, flight ${flight.toFixed(2)} s`);
  check("…one wave's worth each, three waves", Math.abs(ally.hp - 590) < 1e-6, `hp ${ally.hp}`);
}
{
  // A hurting thrown wave (Cluster Rockets' shape) lands on whoever is THERE when it lands.
  const w = new SimWorld(grid(), 2);
  addUnit(w, 1, 0, 1000, 1000, []);
  const foe = addUnit(w, 2, 1, 1700, 1000, []);
  w.addSpellFieldInternal({
    code: "ANcs", x: 1700, y: 1000, area: 200, damagePerWave: 40, waves: 1, interval: 0.25, casterId: 1,
    art: "TinkerRocketMissile.mdx", artPerWave: 2, thrown: { speed: 700, arc: 0.2 },
  });
  w.tick(SIM_DT);
  foe.x = 2400; // walks out of the circle while the rockets are up
  run(w, 60 * 2);
  check("a rocket wave can be walked out from under", foe.hp === 1000, `hp ${foe.hp}`);
}

console.log("\nMISSILE (SPLASH): a homing missile bursts in its rings around whoever it struck (issue #278)");
// UnitWeapons [ufro] — the Frost Wyrm: weapTp msplash, rings 25/50/200 at 1/0.2/0.1,
// splashTargs ground,air,structure,debris,enemy. Unlike a shell the missile still HOMES.
const wyrm = (over = {}) => mortar({
  weaponType: "msplash", attackType: "magic", range: 300, missileArc: 0, missileSpeed: 900,
  targets: ["ground", "structure", "debris", "air", "item", "ward"],
  areaFull: 25, areaHalf: 50, areaQuarter: 200, areaHalfFactor: 0.2, areaQuarterFactor: 0.1,
  splashTargets: ["ground", "air", "structure", "debris", "enemy"], ...over,
}, { minRange: 0 });
function breath(over = {}, setup = () => {}) {
  const w = new SimWorld(grid(), 2);
  const m = addUnit(w, 1, 0, 1000, 1000, wyrm(over));
  const foe = addUnit(w, 2, 1, 1250, 1000, []);
  const mid = addUnit(w, 3, 1, 1250, 1060, []); // 60 - 16 = 44 from the struck unit: the 0.2 ring
  const far = addUnit(w, 4, 1, 1250, 850, []); // 150 - 16 = 134: the 0.1 ring
  const out = addUnit(w, 5, 1, 1250, 1300, []); // 284 away: outside every ring
  const friend = addUnit(w, 6, 0, 1290, 1000, []); // beside the struck unit, and the shooter's own
  const u = { w, m, foe, mid, far, out, friend };
  setup(u);
  w.issueOrder(m.id, { kind: "attack", targetId: foe.id, force: true });
  let launched = false, moved = false;
  run(w, 600, () => launched && w.projectiles.size === 0, (w) => {
    if (!w.projectiles.size) return;
    launched = true;
    if (over.walk && !moved) { moved = true; for (const x of [foe, mid, far, out, friend]) x.y += 400; } // everybody walks, together
  });
  const took = (x) => 1000 - x.hp;
  return { foe: took(foe), mid: took(mid), far: took(far), out: took(out), friend: took(friend), w, ids: u };
}
{
  const r = breath();
  check("the struck unit takes the blow in full", r.foe > 0, `took ${r.foe.toFixed(1)}`);
  check("a body in the Harea ring takes Hfact of it (0.2)", Math.abs(r.mid - r.foe * 0.2) < 1e-6, `${r.mid.toFixed(2)} vs ${r.foe.toFixed(2)}`);
  check("a body in the Qarea ring takes Qfact of it (0.1)", Math.abs(r.far - r.foe * 0.1) < 1e-6, `${r.far.toFixed(2)} vs ${r.foe.toFixed(2)}`);
  check("a body past the rings takes nothing", r.out === 0);
  check("splashTargs names `enemy`, so the shooter's own unit beside it is spared", r.friend === 0, `took ${r.friend}`);
  check("…and nothing it hits is struck twice", r.foe <= 50 + 1e-6, `took ${r.foe.toFixed(1)}`);
}
{
  const r = breath({ splashTargets: ["ground"] }); // [nadr] and the creep dragons: no allegiance word
  check("a row that names no allegiance burns the shooter's own side too", r.friend > 0, `friend took ${r.friend.toFixed(1)}`);
}
{
  const r = breath({ walk: true });
  check("the missile still HOMES: a target that walks is struck all the same", r.foe > 0, `took ${r.foe.toFixed(1)}`);
  check("…and the burst is centred where it was struck, not where it was aimed", Math.abs(r.mid - r.foe * 0.2) < 1e-6 && r.out === 0);
}
{
  const r = breath({ areaFull: 0, areaHalf: 0, areaQuarter: 0 }); // 26 msplash rows state no rings
  check("an msplash row with no rings is a plain missile", r.foe > 0 && r.mid === 0 && r.far === 0);
}
{
  const r = breath({ weaponType: "missile" }); // twelve plain `missile` rows carry stray rings
  check("rings on a plain `missile` slot do not splash — weapTp is what sorts them", r.foe > 0 && r.mid === 0 && r.far === 0);
}
{
  const hit = breath();
  const miss = breath({}, ({ m }) => m.buffs.push({ kind: "miss", group: "curse", timeLeft: 999, sourceId: 0, value: 1 }));
  check("a MISSED splash missile still bursts, at half of every ring", Math.abs(miss.foe - hit.foe / 2) < 1e-6 && Math.abs(miss.mid - hit.mid / 2) < 1e-6, `${miss.foe.toFixed(1)} / ${miss.mid.toFixed(2)}`);
}
{
  const r = breath({ damage: 5000 });
  check("what it kills does NOT splatter — that is the Artillery type's rule", !r.w.units.has(r.ids.foe.id) && !r.w.diedExploded(r.ids.foe.id));
}

console.log(failures ? `\nartillery: ${failures} FAILED` : "\nartillery: all checks passed");
process.exit(failures ? 1 : 0);
