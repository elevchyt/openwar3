// The upgrade-bonus cache (SimWorld.upgradeBonuses, `UpgradeBonusCache`) — correctness first,
// then what it is worth.
//
// recomputeStats runs for every unit every step, and it used to rebuild the sum of the owner's
// researched upgrades each time: a walk over the unit type's `upgradesUsed`, a research lookup and
// an upgrade-row lookup per entry, and a fresh object. That sum depends on the OWNER's research
// levels, the unit's TYPE and the upgrade rows and nothing else, so it is cached per (owner, type)
// and dropped when TechState.researchVersion moves. The bar is that it is never a different
// ANSWER: every stat the upgrades feed — dice, armour, max life, range, speed, sight, the
// `renw` weapon mask, the level numbers the info panel prints — must come out the same with the
// cache on and off, through research landing mid-fight (the invalidation), a unit changing TYPE
// (the key), a unit changing OWNER (the other key), and a new match's `reset`.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, UpgradeBonusCache } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { TechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
const { UpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT

// --- the data: three unit types, each listing a different mix of upgrades -------------------
//
// The effects are the stock ones' (UpgradeData.slk): Forged Swords `ratd` 1/1, Plating `rarm`
// (magnitude from the unit's `defUp`), Long Rifles `ratr` 200, Masonry `rhpo` 0.1, Priest
// Training `rmnx` 100/100 on a class `caster`, a flat `rhpx`, a `rmvx`, and Flying Machine
// Bombs' `renw` 3 — enough that each unit type reads a different subset.
const up = (id, className, maxLevel, effects) => [id, {
  id, race: "human", className, maxLevel, goldBase: 100, goldMod: 75, lumberBase: 0, lumberMod: 0,
  timeBase: 30, timeMod: 10, effects, names: [id], tips: [id], uberTips: [id], hotkeys: ["D"], icons: [""],
  buttonX: 0, buttonY: 0,
}];
const fx = (effect, base, mod = 0) => ({ effect, base, mod });
const upgrades = new UpgradeRegistry(new Map([
  up("Rhme", "melee", 3, [fx("ratd", 1, 1)]),
  up("Rhra", "ranged", 3, [fx("ratd", 1, 1)]),
  up("Rhar", "armor", 3, [fx("rarm", 0)]),
  up("Rhlh", "_", 2, [fx("rhpx", 50, 50), fx("rmvx", 20, 10)]),
  up("Rhri", "_", 1, [fx("ratr", 200)]),
  up("Rhpt", "caster", 2, [fx("rmnx", 100, 100), fx("ratd", 1, 1)]),
  up("Rhac", "armor", 3, [fx("rhpo", 0.1, 0.1), fx("rarm", 0)]),
  up("Rhgb", "_", 1, [fx("renw", 3)]),
]));
const unit = (id, over) => ({
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, upgradesUsed: [], defUp: 2, abilities: [], ...over,
});
const units = new UnitRegistry(new Map([
  ["hfoo", unit("hfoo", { upgradesUsed: ["Rhme", "Rhar", "Rhlh"] })],
  ["hrif", unit("hrif", { upgradesUsed: ["Rhra", "Rhar", "Rhri"] })],
  ["hmpr", unit("hmpr", { upgradesUsed: ["Rhpt", "Rhar", "Rhgb"] })],
  ["hwtw", unit("hwtw", { upgradesUsed: ["Rhac"], defUp: 1 })],
]));
const techNode = (id) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false,
}];
const tech = new TechRegistry(new Map(
  ["hfoo", "hrif", "hmpr", "hwtw", "Rhme", "Rhra", "Rhar", "Rhlh", "Rhri", "Rhpt", "Rhac", "Rhgb"].map(techNode),
));

const WEAPON = (over = {}) => ({
  enabled: true, targets: ["ground", "air", "structure"], acquire: 600, range: 90, baseRange: 90, rangeBuffer: 250,
  dice: 1, baseDice: 1, sides: 6, base: 12, damage: 12, baseDamage: 12, cooldown: 1.2, baseCooldown: 1.2,
  rangeMotionBuffer: 250, damagePoint: 0.3, baseDamagePoint: 0.3, backswing: 0.3, baseBackswing: 0.3,
  baseSpillDist: 0, baseSpillRadius: 0, attackType: "normal", ranged: false,
  projectile: "", projectileSpeed: 900, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0, launchX: 0, launchY: 0, launchZ: 0,
  spillDist: 0, spillRadius: 0, damageLoss: 0, ...over,
});

/** Deterministic pseudo-random, so both arms see exactly the same world. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function spawn(w, id, owner, x, y, typeId) {
  const w1 = WEAPON(typeId === "hrif" ? { range: 400, baseRange: 400, ranged: true } : {});
  const w2 = WEAPON({ enabled: false, targets: ["air"] }); // the dormant slot `renw` wakes
  return w.add({
    id, owner, team: owner, typeId, x, y, facing: 0,
    hp: 300, maxHp: 300, mana: 200, maxMana: 200, manaRegen: 0.5, hpRegen: 0.25,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 2, armorType: "heavy", defUp: 2,
    weapon: w1, weapons: [w1, w2], oldWeapons: [w1, w2],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: typeId,
    worker: null, depotGold: false, depotLumber: false,
  });
}

/** Every stat the upgrades feed, for every unit, in the Map's order. */
function snapshot(w) {
  const out = [];
  for (const u of w.units.values()) {
    out.push(u.id, u.typeId, u.owner, u.x, u.y, u.hp, u.maxHp, u.maxMana, u.armor, u.bonusArmor,
      u.speed, u.sightDay, u.sightNight, u.attackUpgrade, u.armorUpgrade,
      u.weapons.map((x) => `${x.enabled}:${x.dice}:${x.range}:${x.damage}`).join("|"));
  }
  return JSON.stringify(out);
}

// What lands, and when: research on both sides mid-fight, a snapshot-style overwrite back DOWN,
// a unit changing type, a unit changing hands.
const EVENTS = {
  60: (w) => { w.tech.setResearchLevel(0, "Rhme", 1); w.tech.setResearchLevel(1, "Rhar", 1); },
  120: (w) => { w.tech.setResearchLevel(0, "Rhar", 2); w.tech.setResearchLevel(0, "Rhlh", 1); },
  180: (w) => { w.tech.setResearchLevel(1, "Rhri", 1); w.tech.setResearchLevel(1, "Rhpt", 2); w.tech.setResearchLevel(1, "Rhgb", 1); },
  240: (w) => { w.tech.setResearchLevel(0, "Rhac", 3); w.tech.setResearchLevel(1, "Rhra", 3); },
  300: (w) => { w.tech.setResearchLevel(0, "Rhar", 1); }, // an applier writing a LOWER level
  360: (w) => { // a unit changes TYPE (the morph / the Tower's upgrade path)
    for (const u of w.units.values()) if (u.typeId === "hfoo" && u.owner === 0) { u.typeId = "hrif"; break; }
  },
  420: (w) => { // a unit changes HANDS (Charm, Possession, a player leaving)
    for (const u of w.units.values()) if (u.typeId === "hmpr" && u.owner === 1) { u.owner = 0; u.team = 0; break; }
  },
  480: (w) => { w.tech.setResearchLevel(1, "Rhme", 2); w.tech.setResearchLevel(0, "Rhlh", 2); },
};

function scenario(cached, steps, timed) {
  UpgradeBonusCache.enabled = cached;
  const W = 128, H = 128;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const w = new SimWorld(g, 1, undefined, undefined, units, tech, upgrades);
  const r = rng(0x5eed0f);
  const types = ["hfoo", "hfoo", "hrif", "hmpr", "hwtw"];
  let id = 1;
  const army = (owner, cx) => {
    for (let i = 0; i < 60; i++) spawn(w, id++, owner, cx + (r() - 0.5) * 700, 2048 + (r() - 0.5) * 900, types[i % types.length]);
  };
  army(0, 1500);
  army(1, 2600);
  for (const u of w.units.values()) w.issueAttackMove(u.id, u.owner === 0 ? 2600 : 1500, 2048);
  const trace = [];
  const t0 = timed ? process.hrtime.bigint() : 0n;
  for (let s = 0; s < steps; s++) {
    EVENTS[s]?.(w);
    w.tick(SIM_DT);
    if (!timed) trace.push(snapshot(w));
  }
  const ms = timed ? Number(process.hrtime.bigint() - t0) / 1e6 : 0;
  return { trace, ms, w };
}

// --- correctness: the same stats, step for step --------------------------------------------
{
  const STEPS = 600;
  const a = scenario(true, STEPS, false);
  const b = scenario(false, STEPS, false);
  let first = -1;
  for (let i = 0; i < STEPS; i++) if (a.trace[i] !== b.trace[i]) { first = i; break; }
  check("cached and uncached give the same world every step", first === -1, first === -1 ? `${STEPS} steps` : `first differs at step ${first}`);
  // …and the run actually moved the numbers the cache serves.
  const at = (s) => JSON.parse(a.trace[s]);
  const statsOf = (s, type, owner) => {
    const f = at(s);
    for (let i = 0; i < f.length; i += 16) if (f[i + 1] === type && f[i + 2] === owner) return f.slice(i, i + 16);
    return null;
  };
  const foot59 = statsOf(59, "hfoo", 0), foot61 = statsOf(61, "hfoo", 0);
  check("research landing mid-fight moved a stat (the invalidation ran)",
    !!foot59 && !!foot61 && foot59[15] !== foot61[15], `${foot59?.[15]} → ${foot61?.[15]}`);
  const prie179 = statsOf(179, "hmpr", 1), prie181 = statsOf(181, "hmpr", 1);
  check("renw woke the dormant slot", !!prie181 && /^true:.*\|true:/.test(prie181[15]) && !/\|true:/.test(prie179?.[15] ?? ""));
}

// --- the cache against the sum itself, after every kind of write ---------------------------
{
  const { w } = scenario(true, 1, false);
  const same = () => {
    for (const u of w.units.values()) {
      if (JSON.stringify(w.upgradeBonuses(u)) !== JSON.stringify(w.sumUpgradeBonuses(u))) return `unit ${u.id} (${u.typeId}/${u.owner})`;
    }
    return "";
  };
  for (const u of w.units.values()) w.upgradeBonuses(u); // fill it
  w.tech.setResearchLevel(0, "Rhme", 3);
  let bad = same();
  check("setResearchLevel invalidates", !bad, bad);
  w.tech.reset();
  bad = same();
  check("reset (a new match) invalidates", !bad, bad);
  const any = w.units.values().next().value;
  const first = w.upgradeBonuses(any);
  check("a hit is served from the cache (the same object)", w.upgradeBonuses(any) === first);
}

// --- what it is worth (a benchmark, not a gate) --------------------------------------------
{
  const STEPS = 600;
  scenario(true, 120, true); // warm the JIT on both paths before timing either
  scenario(false, 120, true);
  const slow = scenario(false, STEPS, true).ms;
  const fast = scenario(true, STEPS, true).ms;
  console.log(`info  ${STEPS} steps: uncached ${slow.toFixed(0)} ms, cached ${fast.toFixed(0)} ms (${(slow / fast).toFixed(2)}x the whole step)`);
}

UpgradeBonusCache.enabled = true;
if (failed) {
  console.log(`\n${failed} upgrade-cache check(s) FAILED`);
  process.exit(1);
}
console.log("\nupgrade cache: all checks passed");
