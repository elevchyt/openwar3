// The autocast search's flat scan (SimWorld.autocastTarget / dispelAutocastTarget, `AutocastScan`)
// — correctness first, then what it is worth.
//
// Every idle caster with autocast on searches for a target every step, and the search used to walk
// the unit Map with an iterator and call `Math.hypot` on every unit in it — a whole-map scan per
// caster per step. Profiled in a 287-unit fight it was ~40% of the simulation step. The fast path
// walks a flat copy of the Map in the Map's OWN order and rejects on one axis before the square
// root. That is a different LOOP, and the bar it has to clear is that it is not a different
// ANSWER: a friendly buff ranks every full-health ally in the fight the same and the tie goes to
// whichever the scan met first, so a scan in any other order — or a reach test that disagreed
// about one body on the boundary — would put the Inner Fire on a different Footman. So the test
// runs the same fight twice, fast on and fast off, and demands the same world, unit for unit,
// every step: positions, life, mana, orders, targets and every buff worn.
//
// The fight is built to exercise every path: heals (ranked by wounds), a friendly BUFF (ranked by
// "in the fight", which is where the ties are), a hostile autocast (ranked by distance), a dispel
// (its own search), units dying mid-run (the list is rebuilt on the delete) and reinforcements
// arriving mid-run (…and on the insert).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, AutocastScan } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT

// The rows as the real game has them, trimmed to what the search reads.
const LV = (cost, cooldown, castRange, buffs, data = [0]) =>
  [{ cost, cooldown, castRange, area: 0, duration: 30, heroDuration: 30, castTime: 0, data, buffs, summon: "" }];
// The art fields the effect handlers read on a successful cast; none of them draw anything here.
const ART = { buffFx: [], buffArt: "", targetArt: "", casterArt: "", effectArt: "", missileArt: "", specialArt: "", areaArt: "" };
const ROWS = {
  // Heal — ranked by WOUNDS.
  Ahea: { ...ART, id: "Ahea", code: "Ahea", target: "unit", levelData: LV(5, 1, 250, [], [25]),
    targetFlags: ["air", "ground", "friend", "vuln", "invu", "self", "organic", "nonancient", "neutral"] },
  // Inner Fire — a friendly BUFF, ranked by "in the fight": the tie-heavy one.
  Ainf: { ...ART, id: "Ainf", code: "Ainf", target: "unit", levelData: LV(35, 1, 500, ["Binf"], [5, 10]),
    targetFlags: ["air", "ground", "friend", "self", "vuln", "invu", "organic"] },
  // Slow — HOSTILE, ranked by distance.
  Aslo: { ...ART, id: "Aslo", code: "Aslo", target: "unit", levelData: LV(50, 1, 700, ["Bslo"], [0.6, 0.25]),
    targetFlags: ["air", "ground", "enemy", "organic", "neutral"] },
  // Abolish Magic — the dispel's own search.
  Aadm: { ...ART, id: "Aadm", code: "Aadm", target: "unit", levelData: LV(50, 0, 500, [], [0, 250]),
    targetFlags: ["air", "ground", "ward", "invu", "vuln", "tree"] },
};

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

function spawn(w, id, owner, x, y, kind) {
  const caster = kind !== "footman";
  const weapon = WEAPON(caster ? { range: 500, baseRange: 500, ranged: true, attackType: "magic", damage: 8, baseDamage: 8 } : {});
  const u = w.add({
    id, owner, team: owner, typeId: caster ? "hmpr" : "hfoo", x, y, facing: 0,
    hp: caster ? 260 : 180, maxHp: caster ? 260 : 420, mana: 400, maxMana: 400, manaRegen: 0.5, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon, weapons: [weapon], oldWeapons: [weapon],
    sight: 1400, nsight: 800, baseSight: 1400, sightDay: 1400, sightNight: 800,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: kind,
    worker: null, depotGold: false, depotLumber: false,
  });
  const on = (id) => ({ id, code: id, level: 1, cooldownLeft: 0, autocastOn: true });
  if (kind === "priest") u.abilities = [on("Ahea"), on("Ainf")];
  if (kind === "sorceress") u.abilities = [on("Aslo")];
  if (kind === "dryad") u.abilities = [on("Aadm")];
  return u;
}

/** The whole observable world, in the Map's order — what the two arms must agree on. */
function snapshot(w) {
  const out = [];
  for (const u of w.units.values()) {
    out.push(u.id, u.x, u.y, u.hp, u.mana, u.order, u.targetId,
      u.pendingCast ? `${u.pendingCast.code}>${u.pendingCast.targetId}` : "-",
      u.buffs.map((b) => b.buffId).join(","));
  }
  return JSON.stringify(out);
}

function scenario(fast, steps, timed) {
  AutocastScan.fast = fast;
  const W = 128, H = 128;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => ROWS[id], all: () => Object.values(ROWS) };
  const r = rng(0xa07c457);
  const kinds = ["footman", "footman", "footman", "priest", "sorceress", "dryad"];
  let id = 1;
  const army = (owner, cx) => {
    for (let i = 0; i < 48; i++) {
      const u = spawn(w, id++, owner, cx + (r() - 0.5) * 700, 2048 + (r() - 0.5) * 900, kinds[i % kinds.length]);
      u.hp = Math.max(40, u.maxHp * (0.35 + r() * 0.65)); // wounded to varying depths: work for Heal
    }
  };
  army(0, 1500);
  army(1, 2600);
  for (const u of w.units.values()) w.issueAttackMove(u.id, u.owner === 0 ? 2600 : 1500, 2048);
  const trace = [];
  const t0 = timed ? process.hrtime.bigint() : 0n;
  for (let s = 0; s < steps; s++) {
    // Reinforcements mid-fight, so the list is rebuilt on an INSERT as well as on the deaths.
    if (s === 240 || s === 480) {
      for (let k = 0; k < 6; k++) {
        const u = spawn(w, id++, k % 2, k % 2 ? 2800 : 1300, 1900 + k * 60, kinds[k]);
        w.issueAttackMove(u.id, u.owner === 0 ? 2600 : 1500, 2048);
      }
    }
    w.tick(SIM_DT);
    if (!timed) trace.push(snapshot(w));
  }
  const ms = timed ? Number(process.hrtime.bigint() - t0) / 1e6 : 0;
  return { trace, ms, alive: w.units.size };
}

// --- correctness: the same world, step for step ---
{
  const STEPS = 900; // fifteen seconds of a 96-unit melee with casters on both sides
  const a = scenario(true, STEPS, false);
  const b = scenario(false, STEPS, false);
  let first = -1;
  for (let i = 0; i < STEPS; i++) if (a.trace[i] !== b.trace[i]) { first = i; break; }
  check("fast scan and Map scan give the same world every step", first === -1, first === -1 ? `${STEPS} steps` : `first differs at step ${first}`);
  // …and the run actually exercised what it claims to.
  const final = a.trace[STEPS - 1];
  check("units died along the way (the list was rebuilt on deletes)", a.alive < 96 + 12, `${a.alive} of 108 left`);
  check("Inner Fire landed on somebody (the tie-heavy friendly buff ran)", final.includes("Binf"));
  check("Slow landed on somebody (the hostile search ran)", final.includes("Bslo") || a.trace.some((t) => t.includes("Bslo")));
}

// --- what it is worth (a benchmark, not a gate) ---
{
  const STEPS = 900;
  scenario(true, 120, true); // warm the JIT on both paths before timing either
  scenario(false, 120, true);
  const slow = scenario(false, STEPS, true).ms;
  const fast = scenario(true, STEPS, true).ms;
  console.log(`info  ${STEPS} steps: Map scan ${slow.toFixed(0)} ms, fast scan ${fast.toFixed(0)} ms (${(slow / fast).toFixed(2)}x the whole step)`);
}

AutocastScan.fast = true;
if (failed) {
  console.log(`\n${failed} autocast-scan check(s) FAILED`);
  process.exit(1);
}
console.log("\nautocast scan: all checks passed");
