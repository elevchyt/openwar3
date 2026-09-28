// An AI never animation-cancels a blow's backswing — see SimUnit.backswingLeft.
//
// Run: pnpm sim:test

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
// Build ability ranks from the real blank rather than a literal, so a stub cannot drift from
// AbilityLevel the moment a field is added (same reason sim-morph-test does it).
const { emptyAbilityLevel } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60; // must match render/mapViewer.ts SIM_DT

// A footman's melee slot (SimWeapon: the live values are re-derived from the base* ones by
// recomputeStats every tick, so BOTH have to be set — a slot with only the live half reads
// back as range 0 and the unit "attacks" from wherever it stands). `targets` is the Targets
// Allowed LIST out of UnitWeapons.slk, and a slot must be `enabled` to be picked at all.
const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

const W = 96, H = 96; // 3072 x 3072 world units, origin at (0,0)
function grid() {
  return new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
}

/** A footman-ish melee unit through the world's own add(), so every runtime field is set
 *  up the way a real spawn would be. Big HP by default: these tests run for seconds and a
 *  corpse re-targets, which would mask the behaviour under test. */
function addUnit(w, id, owner, x, y, over = {}) {
  return w.add(addSpec(id, owner, x, y, over));
}

/** The spec addUnit hands to `add()`. Split out because a BUILDING and a WORKER are made
 *  through add()'s OTHER two arguments (a BuildingState, and `opts.isPeon` — which `add`
 *  reads only from there: passed in the spec it is overwritten with false), and the ladder
 *  cases below need both. */
function addSpec(id, owner, x, y, over = {}) {
  const weapons = over.weapons ?? [WEAPON()];
  return {
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    // Sight wide enough that nothing here is a fog test — canSee gates every automatic
    // path, and a unit that cannot see the field would pass these checks for the wrong reason.
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "human",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Footman",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    ...over, weapons, oldWeapons: weapons,
  };
}

const run = (w, seconds) => { for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.tick(SIM_DT); };


// ── The AI plays each blow's BACKSWING out before it chases ───────────────────────────
// A person may move out of a swing's follow-through (the animation cancel); the game's own AI
// never does. A creep or a computer's unit strikes, stands the backswing out, and only THEN
// walks after a target that stepped away — chasing from the damage frame on read as a camp
// attack-cancelling: swing, lurch, swing.
function chaseAfterBlow(setup) {
  const w = new SimWorld(grid(), 1);
  setup(w);
  addUnit(w, 1, 1, 1000, 1000);
  addUnit(w, 2, 0, 1000 + 16 + 16 + 60, 1000, { speed: 350 }); // in reach, and faster than the attacker
  w.issueAttack(1, 2);
  const a = w.units.get(1);
  // Wait for the damage point, then send the target off out of reach.
  let t = 0;
  while (a.swingLeft < 0 && t < 3) { w.tick(SIM_DT); t += SIM_DT; }
  while (a.swingLeft >= 0 && t < 3) { w.tick(SIM_DT); t += SIM_DT; }
  const [x0, y0] = [a.x, a.y];
  const tgt = w.units.get(2);
  tgt.x += 400; // out of reach the instant the blow went out
  let movedAt = -1;
  for (let s = 0; s < 1.0 && movedAt < 0; s += SIM_DT) {
    w.tick(SIM_DT);
    if (Math.hypot(a.x - x0, a.y - y0) > 1) movedAt = s;
  }
  return movedAt;
}
console.log("backswing: the AI stands out the follow-through, a person may cut it");
{
  const ai = chaseAfterBlow((w) => w.computerPlayers.add(1));
  check(`a computer's unit does not step before its 0.3s backswing is over (moved at ${ai.toFixed(2)}s)`, ai >= 0.3 - SIM_DT);
  check("…and then gives chase", ai >= 0 && ai < 0.6);
  const insane = chaseAfterBlow((w) => { w.computerPlayers.add(1); w.cancelsBackswing.add(1); });
  check(`…but an INSANE Computer+ unit animation-cancels: it chases at once (moved at ${insane.toFixed(2)}s)`, insane >= 0 && insane < 0.15);
  const human = chaseAfterBlow(() => {});
  check(`a person's unit chases at once (moved at ${human.toFixed(2)}s)`, human >= 0 && human < 0.15);
}
{
  // A creep: Neutral Hostile, which the sim files under owner -1.
  const w = new SimWorld(grid(), 1);
  addUnit(w, 1, -1, 1000, 1000);
  addUnit(w, 2, 0, 1000 + 16 + 16 + 60, 1000, { speed: 350 });
  w.issueAttack(1, 2);
  const a = w.units.get(1);
  let t = 0;
  while (a.swingLeft < 0 && t < 3) { w.tick(SIM_DT); t += SIM_DT; }
  while (a.swingLeft >= 0 && t < 3) { w.tick(SIM_DT); t += SIM_DT; }
  const [x0, y0] = [a.x, a.y];
  w.units.get(2).x += 400;
  let movedAt = -1;
  for (let s = 0; s < 1.0 && movedAt < 0; s += SIM_DT) {
    w.tick(SIM_DT);
    if (Math.hypot(a.x - x0, a.y - y0) > 1) movedAt = s;
  }
  check(`a creep stands its backswing out too (moved at ${movedAt.toFixed(2)}s)`, movedAt >= 0.3 - SIM_DT && movedAt < 0.6);
}

if (failures) {
  console.log(`\n${failures} backswing check(s) FAILED`);
  process.exit(1);
}
console.log("\nall backswing checks passed");
