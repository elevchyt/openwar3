// MISSILE (BOUNCE) — the Huntress's glaive (issue #279).
//
// Units\UnitWeapons.slk [esen]: weapTp1 = mbounce, targCount1 = 2, damageLoss1 = 0.5,
// Farea1 = 400, splashTargs1 = ground,structure,debris,enemy. [ensh] (Naisha) is targCount 5.
// Units\UpgradeData.slk [Remg] Upgrade Moon Glaive: effect1 = ratc, base1 = 1 — a third body.
// 2.0.3 adds the Bouncing Missile Filter ([Amgi], targs1 = structure): never to or from one.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { TechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
const { UpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const SIM_DT = 1 / 60;

const upgrades = new UpgradeRegistry(new Map([["Remg", {
  id: "Remg", race: "nightelf", className: "_", maxLevel: 1, goldBase: 100, goldMod: 0, lumberBase: 150, lumberMod: 0,
  timeBase: 35, timeMod: 0, effects: [{ effect: "ratc", base: 1, mod: 0 }], names: ["Remg"], tips: [""], uberTips: [""],
  hotkeys: ["M"], icons: [""], buttonX: 0, buttonY: 0,
}]]));
const unitDef = (id, over = {}) => [id, {
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, upgradesUsed: [], defUp: 2, abilities: [], hpRegen: 0, regenType: "none", armorType: "medium", ...over,
}];
const units = new UnitRegistry(new Map([
  unitDef("esen", { upgradesUsed: ["Remg"] }),
  unitDef("esef", { upgradesUsed: ["Remg"], abilities: ["Amgi"] }), // the 2.0.3 Huntress
  unitDef("foot"), unitDef("hall", { isBuilding: true }),
]));
const techNode = (id) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false,
}];
const tech = new TechRegistry(new Map(["esen", "esef", "foot", "hall", "Remg"].map(techNode)));
// The one thing bounceFilter asks of the ability table: the row's code and Targets Allowed.
const abilities = { get: (id) => (id === "Amgi" ? { id, code: "Amgi", targetFlags: ["structure"], levelData: [] } : undefined) };

const glaive = (over = {}) => weaponsFromDef({
  weapons: [{
    enabled: true, targets: ["ground", "structure", "debris", "item", "ward"],
    weaponType: "mbounce", attackType: "normal",
    damage: 20, dice: 1, sides: 1, cooldown: 100, range: 225, rangeBuffer: 250,
    damagePoint: 0.1, backswing: 0.1,
    missileArt: "Abilities\\Weapons\\SentinelMissile\\SentinelMissile.mdx", missileSpeed: 900, missileArc: 0,
    spillDist: 0, spillRadius: 0, damageLoss: 0.5,
    areaFull: 400, areaHalf: 0, areaQuarter: 0, areaHalfFactor: 0.5, areaQuarterFactor: 0.25,
    splashTargets: ["ground", "structure", "debris", "enemy"], targetCount: 2, showUI: true, ...over,
  }],
  acquireRange: 600, minRange: 0, launchX: 0, launchY: 0, launchZ: 60, impactZ: 60,
});

function add(w, id, owner, x, y, typeId, over = {}) {
  const isB = typeId === "hall";
  return w.add({
    id, owner, team: owner, typeId, x, y, facing: 0, flyHeight: 0,
    hp: 1000, maxHp: 1000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: isB ? 0 : 270, turnRate: 6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000, flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: isB, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: false, targetedAs: isB ? "structure" : "ground",
    deathTime: 2, name: typeId, worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [], ...over,
  }, isB ? { constructionLeft: 0, queue: [], rally: null } : null);
}

/** One glaive thrown at `a`, with bodies b (100 past a), c (200 past), d (300 past) in a row. */
function throwGlaive(opts = {}) {
  const g = new PathingGrid({ width: 256, height: 256, flags: new Uint8Array(256 * 256) }, [0, 0]);
  const w = new SimWorld(g, 2, undefined, undefined, units, tech, upgrades);
  if (opts.filter) w.abilities = abilities;
  const weapons = glaive(opts.slot);
  const h = add(w, 1, 0, 1000, 1000, opts.filter ? "esef" : "esen", { weapons, oldWeapons: weapons });
  const u = {
    w, h,
    a: add(w, 2, 1, 1200, 1000, opts.aType || "foot"),
    b: add(w, 3, 1, 1300, 1000, opts.bType || "foot"),
    c: add(w, 4, 1, 1400, 1000, "foot"),
    d: add(w, 5, 1, 1500, 1000, "foot"),
    own: add(w, 6, 0, 1240, 1000, "foot"), // the Huntress's own side, nearer than anybody
    air: add(w, 7, 1, 1220, 1040, "foot", { flying: true, targetedAs: "air" }),
    far: add(w, 8, 1, 1200, 1600, "foot"), // 600 from a — past Farea
  };
  if (opts.research) w.tech.setResearchLevel(0, "Remg", 1);
  if (opts.setup) opts.setup(u);
  w.tick(SIM_DT);
  w.issueOrder(h.id, { kind: "attack", targetId: u.a.id, force: true });
  let launched = false, spawned = 0;
  for (let i = 0; i < 900; i++) {
    w.tick(SIM_DT);
    spawned += w.drainSpawnedProjectiles().length;
    w.drainProjectileImpacts(); w.drainRemovedProjectiles(); w.drainHits();
    if (w.projectiles.size) launched = true;
    else if (launched) break;
  }
  const took = (x) => 1000 - x.hp;
  return { a: took(u.a), b: took(u.b), c: took(u.c), d: took(u.d), own: took(u.own), air: took(u.air), far: took(u.far), spawned, h };
}
const near = (x, y) => Math.abs(x - y) < 1e-6;

console.log("\nMISSILE (BOUNCE): the glaive goes on to a second body for half (issue #279)");
{
  const r = throwGlaive();
  check("the aimed body takes the blow in full", r.a > 0, `took ${r.a.toFixed(1)}`);
  check("targCount 2: the NEAREST other body takes 1 - damageLoss of it (50%)", near(r.b, r.a * 0.5), `${r.b.toFixed(2)} vs ${r.a.toFixed(2)}`);
  check("…and it stops there", r.c === 0 && r.d === 0, `c ${r.c}, d ${r.d}`);
  check("the bounce is a missile of its own", r.spawned === 2, `${r.spawned} missiles`);
  check("splashTargs names `enemy`: it does not go through the Huntress's own unit", r.own === 0);
  check("…and names no `air`: a flyer beside the target is passed over", r.air === 0);
}
{
  const r = throwGlaive({ research: true });
  check("Upgrade Moon Glaive (ratc +1): the slot's count is 3", r.h.weapons[0].targetCount === 3, `${r.h.weapons[0].targetCount}`);
  check("…a third body at 25%", near(r.b, r.a * 0.5) && near(r.c, r.a * 0.25), `${r.b.toFixed(2)} / ${r.c.toFixed(2)}`);
  check("…and no fourth", r.d === 0);
}
{
  const r = throwGlaive({ slot: { targetCount: 5 } }); // [ensh] Naisha
  check("targCount 5 (Naisha): four bounces, halving each hop", near(r.b, r.a / 2) && near(r.c, r.a / 4) && near(r.d, r.a / 8), `${r.b} ${r.c} ${r.d}`);
  check("…never back to a body it has struck, and a chain with nobody left in reach just ends", r.far === 0 && r.spawned === 4, `${r.spawned} missiles`);
}
{
  const r = throwGlaive({ setup: ({ b, c, d }) => { b.x = c.x = d.x = 1200; b.y = c.y = d.y = 1600; } });
  check("nobody within Farea (400) of the struck body: no bounce", r.a > 0 && r.b + r.c + r.d === 0 && r.spawned === 1);
}
{
  const r = throwGlaive({ slot: { weaponType: "missile" } });
  check("a plain `missile` slot with a targCount does not bounce — weapTp is what sorts them", r.a > 0 && r.b === 0);
}
{
  const r = throwGlaive({ slot: { targetCount: 1 } });
  check("an mbounce slot with targCount 1 strikes one body", r.a > 0 && r.b === 0);
}
{
  const r = throwGlaive({ bType: "hall" });
  check("1.30.4: a glaive bounces onto a structure (splashTargs lists it)", near(r.b, r.a * 0.5), `${r.b}`);
}
{
  const r = throwGlaive({ filter: true, bType: "hall", research: true });
  check("2.0.3's Bouncing Missile Filter: never TO a structure — the next unit takes the hop", r.b === 0 && near(r.c, r.a * 0.5), `hall ${r.b}, c ${r.c}`);
  const s = throwGlaive({ filter: true, aType: "hall" });
  check("…nor FROM one", s.a > 0 && s.b + s.c === 0 && s.spawned === 1, `a ${s.a}, b ${s.b}`);
}

console.log(failures ? `\nbounce: ${failures} FAILED` : "\nbounce: all checks passed");
process.exit(failures ? 1 : 0);
