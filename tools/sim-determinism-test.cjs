// The property the whole netcode rests on: a match is a function of (seed, commands).
//
// Same seed + same orders => identical world, tick for tick. Different seed => a different
// game. If this ever fails, a LAN client and its host are watching different matches
// (docs/multiplayer.md) and a replay cannot replay.
//
// Compiles src/sim/world.ts to CommonJS first (pnpm sim:test) — no browser, no MPQs.

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT

// A footman's melee slot. `targets` is the Targets Allowed LIST out of UnitWeapons.slk
// ("ground"/"air"/"structure"), not a bitmask, and a slot must be `enabled` to be picked —
// weaponVs() walks the array and skips anything disabled.
const WEAPON = {
  enabled: true, targets: ["ground", "air", "structure"],
  dice: 1, sides: 6, base: 12, cooldown: 1.2, range: 90, rangeMotionBuffer: 250,
  damagePoint: 0.4, backswing: 0.3, attackType: "normal",
  projectile: "", projectileSpeed: 0, areaFull: 0, areaMid: 0, areaSmall: 0,
  factorMid: 0, factorSmall: 0, dieUp: 0,
};

/** A real PathingGrid over open ground — SimWorld.add() settles a spawn against it, so a
 *  plain object literal will not do. 64x64 cells of 32 units, centred on the origin. */
function grid() {
  const W = 64, H = 64;
  return new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
}

/** A footman-ish melee unit, added through the world's own `add()` so every runtime field
 *  (order queue, pathing, swing state) is initialised the way a real spawn would. */
function addUnit(w, id, owner, x, y) {
  w.add({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 420, maxHp: 420, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1,
    armor: 2, armorType: "medium", defUp: 0,
    // `weapon` is the SLOT currently selected for the target; `weapons` is the pair the
    // unit owns. issueAttack refuses a unit with no `weapon`, which is exactly how this
    // test first passed while nothing fought (see the assertions below — they now check).
    weapon: WEAPON, weapons: [WEAPON], oldWeapons: [WEAPON],
    sight: 1400, nsight: 800, baseSight: 1400,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
  });
}

// SCOPE. Two properties are driven here: that a moving world reproduces exactly from a
// seed, and that the seeded stream is what damage rolls come off. Full combat AI (chase,
// acquire, swing) is NOT driven — that needs a unit fixture faithful enough to satisfy the
// acquisition path, and a half-built one silently produces a world where nothing happens.
// It already did once: the first version of this file compared two such worlds and passed
// every check. Hence the assertions below that the run was not a no-op.

/** March two units across open ground and return a signature of where everything ended up. */
function march(seed, ticks) {
  const w = new SimWorld(grid(), seed);
  addUnit(w, 1, 0, 300, 500);
  addUnit(w, 2, 1, 1200, 500);
  const accepted = w.issueOrder(1, { kind: "move", x: 1500, y: 900 })
    && w.issueOrder(2, { kind: "move", x: 200, y: 200 });
  const from = [...w.units.values()].map((u) => [u.x, u.y]);
  for (let i = 0; i < ticks; i++) w.tick(SIM_DT);
  const us = [...w.units.values()].sort((p, q) => p.id - q.id);
  return {
    accepted,
    travelled: us.reduce((n, u, i) => n + Math.hypot(u.x - from[i][0], u.y - from[i][1]), 0),
    sig: us.map((u) => `${u.id}:${u.x.toFixed(6)},${u.y.toFixed(6)},${u.facing.toFixed(6)}`).join("|")
      + `|elapsed:${w.elapsed.toFixed(6)}`,
  };
}

/** Roll one weapon's damage `n` times off the world's own stream. */
function rolls(seed, n) {
  const w = new SimWorld(grid(), seed);
  addUnit(w, 1, 0, 300, 500);
  addUnit(w, 2, 1, 400, 500);
  const attacker = w.units.get(1), target = w.units.get(2);
  const out = [];
  for (let i = 0; i < n; i++) out.push(w.applyDamage(target, 10 + Math.floor(w.random() * 20), attacker.id, 0));
  return out;
}

console.log("the march actually moves");
const m1 = march(12345, 900);
check("both move orders were accepted", m1.accepted);
check(`units covered ground (${m1.travelled.toFixed(0)} units total)`, m1.travelled > 500);

console.log("same seed, same orders");
const m2 = march(12345, 900);
check("two runs of seed 12345 agree exactly", m1.sig === m2.sig);
if (m1.sig !== m2.sig) {
  console.log(`    A: ${m1.sig}`);
  console.log(`    B: ${m2.sig}`);
}

console.log("damage comes off the seeded stream");
const d1 = rolls(12345, 40), d1b = rolls(12345, 40), d2 = rolls(99999, 40);
check("damage was actually dealt", d1.reduce((a, b) => a + b, 0) > 0);
check("seed 12345 rolls the same damage twice", JSON.stringify(d1) === JSON.stringify(d1b));
check("seed 99999 rolls different damage", JSON.stringify(d2) !== JSON.stringify(d1));

console.log("the seed survives a reseed");
const w = new SimWorld(grid(), 1);
w.reseed(12345);
check("reseed records the new seed", w.seed === 12345);
const fresh = new SimWorld(grid(), 12345);
check("reseed(n) matches constructing with n", w.random() === fresh.random());

console.log(failures === 0 ? "\ndeterminism: all checks passed" : `\ndeterminism: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
