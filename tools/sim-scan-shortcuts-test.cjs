// The sim's WHOLE-WORLD SCANS and the short cuts over them — the same world, twice.
//
// Three passes asked every unit in the world a question whose answer is nearly always "no", for
// every unit, every step (Angel Arena Allstars: 950 units, 660 of them creeps standing at their
// posts, and an 8 ms sim step): is a camp-mate of mine fighting (`campFightAnchor`), is this
// unit inside that aura's circle (`applyAuras`), could this unit be that shop's patron
// (`tickShopBuyers`). Each now narrows who is asked — `campHasFighter`'s set of units that may
// hold an attack order, `auraCells`, the patron list — and the bar each has to clear is that it
// is not a different ANSWER: this sim is what a replay re-runs and what a save resumes.
//
// So the test builds a map of camps, auras and two raiding parties, runs it with the
// short cuts on and again with them off, and demands the same world, unit for unit, every step.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef, CampFighters, AuraCells } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { CreepCaster } = require(join(REPO, ".sim-build", "src", "ai", "creeps.js"));

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

function creep(w, typeId, x, y) {
  const c = spawn(w, typeId, x, y, -1, -1);
  c.isCreep = true;
  c.guardX = c.x;
  c.guardY = c.y;
  c.guardFacing = c.facing;
  c.aggroRange = c.weapon?.acquire ?? 0;
  c.canSleep = true;
  return c;
}
const aura = (id) => ({ id, code: ABILITIES.get(id)?.code ?? id, level: 1, cooldownLeft: 0, autocastOn: false });

/** Deterministic pseudo-random, so both arms see exactly the same world. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Camps with casters, aura carriers and sleepers in them, off the install's own rows: Gnoll
// Overseer (Command Aura), Kobold Taskmaster (Bloodlust… and Command), Ogre Magi, Forest Troll
// High Priest (Heal, Abolish), Centaur Khan (Endurance Aura), Satyr Hellcaller (Unholy Aura).
const CAMPS = [
  ["ngnv", "ngno", "ngno", "ngnw"],
  ["nkot", "nkob", "nkob", "nkog"],
  ["nomg", "nogr", "nogr"],
  ["nfsh", "nftb", "nftr", "nftr"],
  ["ncnk", "ncen", "ncea", "ncea"],
  ["nsth", "nsty", "nsat", "nsat"],
];

function build() {
  nextId = 1;
  const w = world();
  const r = rng(0xa07a);
  const mine = { creeps: [], raiders: [] };
  // A 6 x 6 field of camps 2400 apart: far enough that one camp's shout never reaches the next.
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const cx = 1400 + i * 2400, cy = 1400 + j * 2400;
      for (const id of CAMPS[(i * 6 + j) % CAMPS.length]) {
        if (!UNITS.get(id)) continue;
        mine.creeps.push(creep(w, id, cx + (r() - 0.5) * 300, cy + (r() - 0.5) * 300));
      }
    }
  }
  // A Fountain of Health between camps, a Goblin Merchant with a hero at its counter, and two
  // parties each led by a Paladin under Devotion Aura.
  spawn(w, "nfoh", 2600, 2600, 15, 15);
  spawn(w, "ngme", 1150, 800, 15, 15);
  for (const [owner, x, y] of [[0, 900, 900], [1, 15000, 15000]]) {
    const party = [spawn(w, "Hpal", x, y, owner, owner, { abilities: [aura("AHad")], isHero: true, inventory: [null, null, null, null, null, null] })];
    for (let k = 0; k < 10; k++) party.push(spawn(w, k % 3 ? "hfoo" : "hrif", x + (k % 4) * 70, y + 90 + Math.floor(k / 4) * 70, owner, owner));
    mine.raiders.push(party);
  }
  return { w, ...mine };
}

/** Everything about a unit that a wrong answer from any of the three passes would move. */
function digest(w) {
  let out = "";
  for (const u of w.units.values()) {
    out += `${u.id}:${u.x},${u.y},${u.facing},${u.hp},${u.mana},${u.order},${u.targetId},${u.asleep},${u.returning},${u.campHelper},${u.cloaked}`;
    for (const b of u.buffs) out += `|${b.kind},${b.group},${b.timeLeft},${b.value},${b.sourceId}`;
    out += ";";
  }
  for (const [shop, per] of w.shopBuyers) for (const [owner, id] of per) out += `S${shop}:${owner}=${id};`;
  return out;
}

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT
const STEPS = 60 * 75;

function runArm(on, sink) {
  CampFighters.enabled = on;
  AuraCells.enabled = on;
  const { w, raiders } = build();
  const seen = { fights: 0, buffed: 0, asleep: 0, adopted: 0 };
  const t0 = process.hrtime.bigint();
  let spent = 0n;
  for (let step = 0; step < STEPS; step++) {
    // The raid: each party attack-moves across the field of camps, re-ordered every 10 s to the
    // next waypoint so camps are pulled, leashed, left and pulled again.
    if (step % 600 === 0) {
      const leg = step / 600;
      raiders.forEach((party, p) => {
        const tx = 1400 + ((leg + p * 3) % 6) * 2400, ty = 1400 + ((leg * 2 + p) % 6) * 2400;
        for (const u of party) if (u.hp > 0) w.issueAttackMove(u.id, tx, ty);
      });
    }
    const a = process.hrtime.bigint();
    w.tick(SIM_DT);
    spent += process.hrtime.bigint() - a;
    for (const party of raiders) for (const u of party) if (u.hp > 0) u.hp = Math.max(u.hp, u.maxHp * 0.6); // keep the raid alive
    sink(step, digest(w));
    if (step % 60 === 0) {
      for (const u of w.units.values()) {
        if (u.isCreep && u.order === "attack") seen.fights++;
        if (u.buffs.some((b) => b.aura)) seen.buffed++;
        if (u.asleep) seen.asleep++;
      }
      seen.adopted += w.shopBuyers.size;
    }
  }
  void t0;
  return { ms: Number(spent) / 1e6, seen, units: w.units.size };
}

console.log("the same raid across 36 camps, short cuts on and off");
{
  const want = [];
  const off = runArm(false, (step, d) => want.push(d));
  let firstDiff = -1;
  const on = runArm(true, (step, d) => {
    if (firstDiff < 0 && d !== want[step]) firstDiff = step;
  });
  check("the world is the same on every step", firstDiff, -1);
  // …and the scenario is one that could have told them apart: camps fought and auras landed.
  // (The patron list has no off switch — it is the same walk in the same order — and what a
  // shop adopts is sim-shop-test's.)
  check("creeps fought", on.seen.fights > 50, true);
  check("auras landed", on.seen.buffed > 500, true);
  check("both arms saw the same things", JSON.stringify(on.seen), JSON.stringify(off.seen));
  console.log(`      ${on.units} units, ${STEPS} steps: ${(off.ms / STEPS).toFixed(3)} ms a step without, ${(on.ms / STEPS).toFixed(3)} ms with`);
}

// The plain walk is what a world that never STEPS gets (a LAN client's, whose orders are written
// straight off a snapshot): an attack order nobody issued through issueAttack is still found.
console.log("a world that has not stepped does not trust the set");
{
  CampFighters.enabled = true;
  nextId = 1;
  const w = world();
  const a = creep(w, "ngno", 1000, 1000), b = creep(w, "ngno", 1100, 1000);
  const foe = spawn(w, "hfoo", 1050, 1100, 0, 0);
  a.order = "attack"; // as snapshotApply writes it — not through issueAttack
  a.targetId = foe.id;
  check("a camp-mate's fight is seen", w.creepInFight(b), true);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall scan short-cut checks passed");
