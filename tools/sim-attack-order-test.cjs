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

// ── 5. A TOWER holds no grudge ─────────────────────────────────────────────────────────
// A building cannot walk to what you point it at, so an ordered attack on something outside
// its weapon range is an order it could never carry out: WC3 refuses it at the click with
// [Errors] `Notinrange` ("Target is outside range."), and lets a target that walks back out of
// range GO rather than standing aimed at it while the field moves past underneath.
console.log("a tower's ordered attack");
{
  // 700 range, 700 acquisition — a Guard Tower's numbers, minus the Spirit Tower's longer
  // acquire (that one gets its own case below).
  const TOWER_GUN = (acquire = 700) => ({
    ...WEAPON(), ranged: true, range: 700, baseRange: 700, cooldown: 1, baseCooldown: 1, acquire,
  });
  const tower = (w) => addUnit(w, 1, 0, 500, 500, { speed: 0, isBuilding: true, radius: 48, weapons: [TOWER_GUN()] });
  {
    const w = new SimWorld(grid(), 1);
    tower(w);
    const near = addUnit(w, 2, 1, 900, 500, { weapons: [] });
    check("no refusal for a target it can reach", w.attackRefusal(1, near.id) === null);
    check("…and the order is taken", w.issueOrder(1, { kind: "attack", targetId: near.id, force: false }));
    run(w, 2);
    check("…and it shoots it", near.hp < near.maxHp);
  }
  {
    const w = new SimWorld(grid(), 1);
    tower(w);
    const far = addUnit(w, 2, 1, 1600, 500, { weapons: [] });
    check("out of range answers with the game's own line", w.attackRefusal(1, far.id) === "Notinrange");
    check("…and the order is not taken", w.issueOrder(1, { kind: "attack", targetId: far.id, force: false }) === false);
    check("…leaving the tower on nothing", w.units.get(1).order === "idle" && w.units.get(1).targetId === null);
  }
  {
    // The grudge itself: in range when ordered, then it walks away.
    const w = new SimWorld(grid(), 1);
    tower(w);
    const runner = addUnit(w, 2, 1, 900, 500, { weapons: [] });
    w.issueOrder(1, { kind: "attack", targetId: runner.id, force: false });
    run(w, 1);
    check("locked on while it is in range", w.units.get(1).targetId === runner.id);
    w.issueOrder(2, { kind: "move", x: 2400, y: 500 });
    run(w, 8);
    const u = w.units.get(1);
    check(`let it go once it left range (order ${u.order}, target ${u.targetId})`, u.order === "idle" && u.targetId === null);
  }
  {
    // …and the other half of the rule, which is NOT a grudge: a tower whose acquisition
    // outruns its weapon (the Spirit Tower's 900 against 700) picks a target up at the edge of
    // its sight and waits for it to close. Only the ORDERED attack is let go.
    const w = new SimWorld(grid(), 1);
    addUnit(w, 1, 0, 500, 500, { speed: 0, isBuilding: true, radius: 48, weapons: [TOWER_GUN(900)] });
    const closing = addUnit(w, 2, 1, 1300, 500, { weapons: [] });
    w.issueAttack(1, closing.id); // the automatic path — no `ordered` flag
    run(w, 1);
    check("an auto-acquired target outside weapon range is still held", w.units.get(1).targetId === closing.id);
  }
}


// ── A harmful SPELL is an attack ────────────────────────────────────────────────────────
// Waking, returning fire and the creep camp's call for help all hang off landDamage, which
// is the right home for a blow and only half the story. Two of the Alchemist's three spells
// never pass through it: `[ANtm]` Transmute lands no damage at all (it deletes the unit) and
// `[ANab]` Acid Bomb lands its as a dot the victim's own tick spends against hp directly. So
// an Alchemist could transmute a creep out of a camp, or bomb the camp outright, and walk
// away unchased. Both go through the same provoke() now, raised at the cast.
console.log("a harmful spell provokes its victim, damage or no damage");
{
  const w = new SimWorld(grid(), 1);
  const caster = addUnit(w, 1, 0, 500, 500);
  const victim = addUnit(w, 2, 1, 760, 500, { hp: 500, maxHp: 500 });
  const mate = addUnit(w, 3, 1, 900, 500, { hp: 500, maxHp: 500 });
  // `isCreep` and the guard post are set on the unit AFTER add(), the way RtsController seeds
  // a map-placed creep — add() itself takes neither. Both guard posts sit at the same spot,
  // which is what makes the two camp-mates (sameCamp: within MiscGame CreepCallForHelp).
  for (const c of [victim, mate]) { c.isCreep = true; c.aggroRange = 600; c.guardX = 800; c.guardY = 500; }
  // Only the fields ANtm's handler reads. It is deliberately the spell that leaves NOTHING
  // behind to raise the alarm from: the camp has to be alerted while its victim is still
  // standing there to be alerted about.
  w.applySpellEffect("ANtm", 1, caster, { targetId: victim.id, x: victim.x, y: victim.y }, { code: "ANtm", targetArt: "" });
  check("the transmuted creep is gone", !w.units.has(victim.id) || w.units.get(victim.id).hp <= 0);
  check("...and its camp-mate turns on the caster", mate.targetId === caster.id);
}

// ── A cast is an ORDER, and an order replaces the one before it ─────────────────────────
// Casting used to remember the attack it interrupted and go straight back to it, which made
// the spell read as though it had never taken the caster's attention: an Alchemist told to
// Healing Spray mid-fight sprayed and resumed chasing whatever he had been swinging at.
// Resuming is for an AUTOCAST — a Priest healing inside a commanded fight is pausing, not
// defecting — and that half still stands.
console.log("a player's cast replaces the order it interrupted; an autocast resumes it");
{
  const ABIL = { id: "Atst", code: "Atst", target: "none", levelData: [emptyAbilityLevel()] };
  const mk = () => {
    const w = new SimWorld(grid(), 1, { get: (id) => (id === "Atst" ? ABIL : undefined) });
    const u = addUnit(w, 1, 0, 500, 500);
    u.abilities = [{ id: "Atst", code: "Atst", level: 1, cooldownLeft: 0, autocastOn: false }]; // add() takes no ability list
    const foe = addUnit(w, 2, 1, 1600, 500);
    w.issueOrder(1, { kind: "attack", targetId: foe.id, force: false });
    run(w, 1);
    return { w, u, foe };
  };
  const commanded = mk();
  check("it is carrying out the attack order", commanded.u.order === "attack" && commanded.u.attackOrdered);
  check("the cast was accepted", commanded.w.issueCast(1, "Atst"));
  run(commanded.w, 3);
  // The COMMITMENT is what a cast ends, not the fighting: a unit left idle beside a fight
  // re-acquires on its own next tick, and that auto-acquired target is not an order.
  // Idle, holding nobody. What it does NEXT is its own business — a unit standing beside a
  // fight re-acquires on the following tick, and an auto-acquired target is not an order.
  check("a cast the PLAYER issued drops the commanded attack", commanded.u.order !== "attack" && commanded.u.targetId === null);

  const auto = mk();
  check("…the same cast, accepted", auto.w.issueCast(1, "Atst", 0, 0, 0, true)); // …the last argument is `auto`
  run(auto.w, 3);
  check("an AUTOCAST goes back to it", auto.u.order === "attack" && auto.u.targetId === auto.foe.id);
}

console.log(failures === 0 ? "\nattack-order: all checks passed" : `\nattack-order: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
