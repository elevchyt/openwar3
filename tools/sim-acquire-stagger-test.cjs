// The idle AUTO-ACQUIRE scan, spread and single-walked (issue #386).
//
// Every unit used to start its scan clock at 0 and re-arm it to ACQUIRE_PERIOD, so every
// map-placed unit and everything born on one step scanned on the SAME step for the rest of the
// match — 600 idle units were a 3.6–7 ms step every half second over a 0.55 ms median — and a
// scan that found nothing walked the world a second time for a friend's fight to join
// (`acquireTarget(u, range) ?? assistTarget(u, ASSIST_RANGE)`). Two claims are pinned here:
//   1. the clocks are SPREAD: no step carries more than its share of a crowd's scans;
//   2. `acquireOrAssist` is the old pair EXACTLY — this sim is what a replay re-runs and what a
//      save resumes, so folding two walks into one may change the cost and never the answer.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "AbilityData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    const parts = p.split("\\");
    let dir = EXTRACT;
    for (const part of parts) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return new Uint8Array(fs.readFileSync(dir));
  },
  exists: () => false,
  list: () => [],
};
const ABILITIES = loadAbilityRegistry(vfs);
const UNITS = loadUnitRegistry(vfs);

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const W = 512, H = 512; // 16384 x 16384 world units
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  return new SimWorld(grid, 1, ABILITIES, undefined, UNITS);
}
let nextId = 1;
function spawn(w, typeId, x, y, owner, team, over = {}) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  const flying = def.moveType === "fly";
  return w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying, flyHeight: flying ? 200 : 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: flying ? "air" : "ground", moveType: def.moveType,
      worker: null, depotGold: false, depotLumber: false,
    },
    // A structure carries building state — that is what makes it a building to the sim.
    def.isBuilding ? { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: def.goldCost, lumberCost: def.lumberCost, queue: [], rallyX: x, rallyY: y - 200, rallyKind: "none", rallyTargetId: 0, producesUnits: false } : null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon"), ...over },
  );
}


/** The two walks the idle scan used to make, as they were — the reference for claim 2. */
function oldAssist(w, u, range) {
  if (u.swarm) return null;
  let best = null, bestGap = range;
  for (const ally of w.units.values()) {
    if (ally === u || ally.team !== u.team) continue;
    if (ally.order !== "attack" || ally.targetId === null) continue;
    const enemy = w.units.get(ally.targetId);
    if (!enemy || !w.hostile(u, enemy)) continue;
    if (!w.canAttack(u, enemy)) continue;
    const gap = Math.hypot(ally.x - u.x, ally.y - u.y) - u.radius - ally.radius;
    if (gap >= bestGap) continue;
    if (!w.canSee(u, enemy)) continue;
    bestGap = gap;
    best = enemy;
  }
  return best;
}
const ASSIST_RANGE = 800;
const oldPick = (w, u, range) => w.acquireTarget(u, range) ?? oldAssist(w, u, ASSIST_RANGE);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
// Ground and air, melee and ranged, across three sides — a Gargoyle among them for PRIORITIZE.
const TYPES = ["hfoo", "hrif", "ogru", "ohun", "ugho", "ucry", "earc", "ugar", "hgry", "nfrl"];
function build(n, spread, seed, sides = 3) {
  nextId = 1;
  const w = world();
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const team = i % sides;
    spawn(w, TYPES[Math.floor(r() * TYPES.length)], 2000 + r() * spread, 2000 + r() * spread, team, team);
  }
  return w;
}

// --- 1. spread: 600 idle units of ONE side, so every scan misses and nobody's clock is reset ---
{
  const w = build(600, 12000, 9, 1);
  const t0 = [...w.units.values()].map((u) => u.acquireT);
  check("a fresh unit's first scan is never later than one period", Math.max(...t0) < 0.5, true);
  let worst = 0;
  const seen = new Set();
  let scans = 0;
  w.acquireOrAssist = function (u, range, assist) {
    scans++;
    seen.add(u.id);
    return SimWorld.prototype.acquireOrAssist.call(this, u, range, assist);
  };
  for (let i = 0; i < 60; i++) {
    scans = 0;
    w.tick(1 / 60);
    worst = Math.max(worst, scans);
  }
  // Thirty phases over a half-second period: 600 units are 20 a step, never 600.
  check(`no step scans more than its share (worst ${worst} of 600)`, worst <= Math.ceil(600 / 30), true);
  check("…and every unit still scans within the period", seen.size, 600);
}

// --- 2. one walk is the old two, exactly, while fights start and spread ---
{
  let asked = 0, mism = 0, assists = 0;
  for (const seed of [1, 2]) {
    const w = build(240, 6000, seed);
    const r = rng(seed * 7);
    for (let step = 0; step < 360; step++) {
      if (step % 60 === 0) {
        const us = [...w.units.values()];
        for (let k = 0; k < 10; k++) {
          const a = us[Math.floor(r() * us.length)], b = us[Math.floor(r() * us.length)];
          if (a && b && a.team !== b.team) w.issueAttack(a.id, b.id);
        }
      }
      if (step % 10 === 0) {
        for (const u of w.units.values()) {
          if (!u.weapon) continue;
          for (const range of [u.weapon.acquire ?? 500, 300, 900]) {
            const want = oldPick(w, u, range), got = w.acquireOrAssist(u, range, ASSIST_RANGE);
            asked++;
            if (want !== got) mism++;
            else if (got && !w.acquireTarget(u, range)) assists++;
          }
        }
      }
      w.tick(1 / 60);
    }
  }
  check(`acquireOrAssist answers as the two walks did (${asked} asks)`, mism, 0);
  check(`…including picks only the assist half could make (${assists})`, assists > 0, true);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall auto-acquire checks passed");
