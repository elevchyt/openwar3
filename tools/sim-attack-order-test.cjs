// An ORDERED attack is a commitment (issue #83).
//
// Right-clicking an enemy (or the Attack command, or a trigger's `IssueTargetOrder`) says
// "kill THAT one". WC3 units honour it: they walk past whatever stands in between, they do
// not turn on whoever shoots them on the way, and they keep at it. Only a target they
// genuinely cannot path to releases the order — and then, and only then, they fall back to
// the nearest enemy they CAN reach.
//
// Auto-acquired targets keep the old, opportunistic behaviour (never walk past an enemy you
// can hit) — that is issue #24's fix and the last case here guards it against regressing.
//
// Run: pnpm sim:test  (compiles the sim to CommonJS first — see tools/tsconfig.sim.json)

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid, PathingFlag } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

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
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90,
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
  const weapons = over.weapons ?? [WEAPON()];
  return w.add({
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
  });
}

const run = (w, seconds) => { for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.tick(SIM_DT); };

// ── 1. The bug: ordered onto a far enemy, distracted by a nearer one ────────────────────
// The commanded target sits across the field; another enemy stands right on the way, well
// inside strike range as we pass it. Before the fix the attacker peeled off onto the one it
// brushed past ("it starts attacking the target closer to it") and never delivered the order.
console.log("ordered attack, an enemy standing on the way");
{
  const w = new SimWorld(grid(), 1);
  addUnit(w, 1, 0, 300, 500);
  const distractor = addUnit(w, 2, 1, 800, 500);
  const commanded = addUnit(w, 3, 1, 1800, 500);
  const ok = w.issueOrder(1, { kind: "attack", targetId: commanded.id, force: false });
  check("the order was accepted", ok);
  run(w, 8);
  const u = w.units.get(1);
  check(`kept the commanded target (targetId ${u.targetId}, commanded ${commanded.id})`, u.targetId === commanded.id);
  // The commanded target auto-acquires us on the way in, so the two meet short of 1800 —
  // what matters is that our unit walked well past the distractor and closed on it.
  const gap = Math.hypot(commanded.x - u.x, commanded.y - u.y) - 32;
  check(`walked past the distractor (x ${u.x.toFixed(0)}, started at 300, distractor at 800)`, u.x > 1200);
  // Inside the melee strike band: weapon range 90 + ATTACK_LEASH 48, the same band engage() uses.
  check(`closed to striking distance (hull gap ${gap.toFixed(0)})`, gap <= 90 + 48);
  check("is fighting it", u.inCombat);
  check("the distractor was never engaged", commanded.hp < commanded.maxHp && distractor.hp === distractor.maxHp);
}

// ── 2. Being shot on the way doesn't cancel the order ───────────────────────────────────
// Retaliation (return fire) is for units that are idle or stuck on something they can't
// reach — never for one carrying out an order it is making headway on.
console.log("ordered attack, taking fire on the way");
{
  const w = new SimWorld(grid(), 1);
  addUnit(w, 1, 0, 300, 500);
  const sniper = addUnit(w, 2, 1, 800, 620);
  const commanded = addUnit(w, 3, 1, 1800, 500);
  w.issueOrder(1, { kind: "attack", targetId: commanded.id, force: false });
  run(w, 2);
  // Hit it mid-march, from a unit it was NOT ordered onto.
  for (let i = 0; i < 5; i++) { w.applyDamage(w.units.get(1), 20, sniper.id, 0); run(w, 0.2); }
  const u = w.units.get(1);
  check(`still on the commanded target (targetId ${u.targetId})`, u.targetId === commanded.id);
  run(w, 6);
  check("saw the order through", w.units.get(1).targetId === commanded.id && commanded.hp < commanded.maxHp);
}

// ── 3. Unreachable target → fall back, but only after the commitment window ─────────────
// A wall of unwalkable cells splits the field. The commanded target is behind it; a
// perfectly reachable enemy stands on our side. The unit must spend ~ORDERED_COMMIT_TIME
// trying (the pathfinder is what decides, not the first stalled second) and then switch.
console.log("ordered attack on a walled-off target");
{
  const flags = new Uint8Array(W * H);
  const wallCx = Math.floor(1200 / 32);
  for (let cy = 0; cy < H; cy++) for (let d = 0; d < 3; d++) flags[cy * W + wallCx + d] = PathingFlag.Unwalkable;
  const w = new SimWorld(new PathingGrid({ width: W, height: H, flags }, [0, 0]), 1);
  addUnit(w, 1, 0, 300, 500);
  const reachable = addUnit(w, 2, 1, 700, 500, { weapons: [] }); // weaponless: it never fights back or pulls us itself
  const commanded = addUnit(w, 3, 1, 1800, 500);
  w.issueOrder(1, { kind: "attack", targetId: commanded.id, force: false });
  run(w, 1.2); // inside the commitment window — still trying for the commanded target
  check("holds the order while it is still trying", w.units.get(1).targetId === commanded.id);
  run(w, 8);
  const u = w.units.get(1);
  check(`fell back to the reachable enemy (targetId ${u.targetId}, reachable ${reachable.id})`, u.targetId === reachable.id);
  check("and is actually hitting it", reachable.hp < reachable.maxHp);
}

// ── 4. Regression guard: an AUTO-acquired target still yields to a closer one ───────────
// Issue #24's rule is untouched — a unit that picked its own fight must never walk past an
// enemy it can hit. Here nothing is ordered: the attacker auto-acquires the far one first
// (issueAttack with ordered=false, as reacquire/idle-scan do) and should switch.
console.log("auto-acquired target still yields to one in strike range");
{
  const w = new SimWorld(grid(), 1);
  addUnit(w, 1, 0, 300, 500);
  const near = addUnit(w, 2, 1, 420, 500, { weapons: [] });
  const far = addUnit(w, 3, 1, 1800, 500, { weapons: [] });
  w.issueAttack(1, far.id); // no `ordered` flag — this is the automatic path
  run(w, 3);
  const u = w.units.get(1);
  check(`switched to the enemy in strike range (targetId ${u.targetId}, near ${near.id})`, u.targetId === near.id);
  check("far one untouched", far.hp === far.maxHp);
}

console.log(failures === 0 ? "\nattack-order: all checks passed" : `\nattack-order: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
