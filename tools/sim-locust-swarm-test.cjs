// LOCUST SWARM (`AUls`, the Crypt Lord's ultimate) — twenty units that behave as a swarm
// (SimWorld.tickLocustSwarms), not twenty summons standing where they landed.
//
// Numbers are the live row (Units\AbilityData.slk AUls, AbilityMetaData Uls1..Uls5):
//   DataA 20 locusts · DataB 0.2 s between releases · DataC 7 to a victim
//   DataD 0.75 of the damage carried home · DataE 20 to carry before turning back
//   HeroDur1 30 · Area1 800 · targs air,ground,enemy · UnitID1 uloc
// and `uloc`'s own (UnitWeapons.slk): 13–14 damage, cool 1, range 10, spd 400, flying, Aloc.
// What a locust does BETWEEN bites is in no table — Liquipedia's Crypt Lord page and r/WC3
// "A closer look at Locust Swarm" — so the checks on wandering ask only that it never stops.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const LVL = { cost: 150, cooldown: 180, duration: 30, heroDuration: 30, castRange: 0, area: 800, castTime: 0, data: D(20, 0.2, 7, 0.75, 20), dataStr: [], buffs: [], summon: "uloc" };
const DEF = { id: "AUls", code: "AUls", targetFlags: ["air", "ground", "enemy"], levelData: [LVL] };

const W = 128, H = 128;
function world() {
  const w = new SimWorld(new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]), 7);
  w.abilities = { get: (id) => (id === "AUls" ? DEF : undefined), all: () => [DEF], buffFx: () => [], buffCarrier: () => null, buff: () => undefined };
  return w;
}
let nextId = 1;
function addUnit(w, team, x, y, over = {}) {
  return w.add({
    id: nextId++, owner: team, team, typeId: "t", x, y, facing: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 1400, sightNight: 800,
    flying: false, mechanical: false, invulnerable: false, race: "undead",
    isBuilding: false, foodCost: 0, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "T",
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [], ...over,
  });
}
// `uloc`, as the renderer would make it off a SummonRequest (MapViewerScene.drainSummons).
const LOCUST = {
  typeId: "uloc", hp: 65, maxHp: 65, speed: 400, radius: 8, collisionSize: 8, flying: true, moveType: "fly", targetedAs: "air",
  weapons: weaponsFromDef({
    weapons: [{
      enabled: true, targets: ["enemy", "air", "ground"], weaponType: "missile", attackType: "spells",
      damage: 12, dice: 1, sides: 2, cooldown: 1, range: 10, rangeBuffer: 250, damagePoint: 0, backswing: 0,
      missileArt: "Abilities\\Weapons\\LocustMissile\\LocustMissile.mdl", missileSpeed: 500, missileArc: 0.15,
      spillDist: 0, spillRadius: 0, damageLoss: 0, areaFull: 0, areaHalf: 0, areaQuarter: 0, areaHalfFactor: 0, areaQuarterFactor: 0,
      splashTargets: [], targetCount: 1, showUI: true,
    }],
    acquireRange: 900, minRange: 0, launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
  }),
};
/** Step the world, making each requested locust the way the renderer does. */
function run(w, secs, each) {
  for (let i = 0; i < Math.round(secs * 60); i++) {
    w.tick(1 / 60);
    for (const s of w.drainSummonRequests()) {
      const u = addUnit(w, s.team, s.x, s.y, { ...LOCUST, owner: s.owner });
      u.locust = true; // `Aloc`, off the type's abilList in the real game
      if (s.swarm) w.joinSwarm(u, s.sourceId);
    }
    each?.();
  }
}
const locusts = (w) => [...w.units.values()].filter((u) => u.swarm && u.hp > 0);

console.log("\nRelease: one locust every 0.2 s, twenty in all, out of the Crypt Lord himself");
{
  const w = world();
  const lord = addUnit(w, 0, 2000, 2000, { isHero: true });
  w.startLocustSwarm(lord, DEF, LVL);
  run(w, 1.0);
  const n1 = locusts(w).length;
  check("about five are out after a second", n1 >= 5 && n1 <= 6, `${n1}`);
  run(w, 4.0);
  check("twenty are out after five, and no more", locusts(w).length === 20, `${locusts(w).length}`);
  check("every one of them is a Locust body (untargetable)", locusts(w).every((u) => u.locust));

  console.log("\nWander: with nothing to bite a locust never stands still, and stays by its lord");
  let still = 0, samples = 0, far = 0;
  run(w, 5.0, () => {
    for (const u of locusts(w)) {
      samples++;
      if (Math.hypot(u.x - u.prevX, u.y - u.prevY) < 0.5) still++;
      if (Math.hypot(u.x - lord.x, u.y - lord.y) > 0.85 * 800 + 40) far++;
    }
  });
  check("it is moving on (nearly) every step", still / samples < 0.1, `${(100 * still / samples).toFixed(1)}% of steps still`);
  check("never farther than its wander ring", far === 0, `${far} samples outside`);
  const reach = Math.max(...locusts(w).map((u) => Math.hypot(u.x - lord.x, u.y - lord.y)));
  check("and they range wide — not a huddle at his feet", reach > 450, `farthest ${reach.toFixed(0)}`);

  console.log("\nFollow: the swarm goes where the Crypt Lord goes");
  w.issueMove(lord.id, 3600, 2000);
  run(w, 12.0);
  const strag = locusts(w).filter((u) => Math.hypot(u.x - lord.x, u.y - lord.y) > 0.85 * 800 + 60).length;
  check("he walked 1600 away and all twenty are around him", strag === 0 && Math.abs(lord.x - 3600) < 100, `${strag} stragglers, lord at ${lord.x.toFixed(0)}`);

  console.log("\nRecall: at 30 s every locust flies home and is gone — removed, not killed");
  const deaths = [];
  w.deathObserver = (u) => deaths.push(u.id);
  run(w, 12.0);
  check("none left", locusts(w).length === 0, `${locusts(w).length}`);
  check("none of them died (no twenty death cries)", deaths.length === 0, `${deaths.length} deaths`);
}

console.log("\nBite: no more than seven on one victim, and only inside Area1 of the Crypt Lord");
{
  const w = world();
  const lord = addUnit(w, 0, 2000, 2000, { isHero: true, hp: 300, maxHp: 100000 });
  const a = addUnit(w, 1, 2300, 2000, { hp: 5000, maxHp: 5000 });
  const b = addUnit(w, 1, 2000, 2300, { hp: 5000, maxHp: 5000 });
  const out = addUnit(w, 1, 2000, 3200, { hp: 5000, maxHp: 5000 }); // 1200 away: outside the 800
  const friend = addUnit(w, 0, 1800, 2000, { hp: 5000, maxHp: 5000 });
  for (const u of [lord, a, b, out, friend]) w.issueHold(u.id);
  w.startLocustSwarm(lord, DEF, LVL);
  let maxOn = 0;
  run(w, 10.0, () => {
    for (const t of [a, b]) maxOn = Math.max(maxOn, locusts(w).filter((u) => u.order === "attack" && u.targetId === t.id && !u.swarm.returning).length);
  });
  check("never more than DataC (7) on one victim", maxOn === 7, `peak ${maxOn}`);
  check("both victims in the area were bitten", a.hp < 5000 && b.hp < 5000, `${a.hp.toFixed(0)} / ${b.hp.toFixed(0)}`);
  check("the one outside Area1 was not", out.hp === 5000, `${out.hp}`);
  check("nor the Crypt Lord's own unit", friend.hp === 5000, `${friend.hp}`);

  console.log("\nCarry: DataD (0.75) of the damage comes home as life");
  const dealt = (5000 - a.hp) + (5000 - b.hp);
  const carried = locusts(w).reduce((n, u) => n + u.swarm.stored, 0);
  const healed = lord.hp - 300;
  check("he has been healed", healed > 0, `+${healed.toFixed(1)}`);
  check("healed + still being carried = 0.75 × dealt", Math.abs(healed + carried - 0.75 * dealt) < 1e-6, `${(healed + carried).toFixed(2)} vs ${(0.75 * dealt).toFixed(2)}`);
  check("nobody holds much more than the threshold (20) before turning back", locusts(w).every((u) => u.swarm.stored < 20 + 14 * 0.75 + 1e-9));

  console.log("\nDeath: the swarm dies with the Crypt Lord, on the spot");
  const deaths = [];
  w.deathObserver = (u) => deaths.push(u.id);
  w.kill(lord);
  run(w, 0.1);
  check("no locust outlives him", locusts(w).length === 0, `${locusts(w).length} alive`);
  check("and they were killed where they flew", deaths.length >= 20, `${deaths.length} deaths`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
