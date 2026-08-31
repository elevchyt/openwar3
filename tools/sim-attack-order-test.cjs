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
// The Alchemist's own row, and the units it melts down. `goldcost` is the only field the
// payout reads; the Rifleman's real 205 is here so the arithmetic below is the game's.
const TRANSMUTE = { code: "ANtm", targetArt: "", targetFlags: ["air", "ground", "enemy", "neutral", "nonhero"],
  levelData: [{ ...emptyAbilityLevel(), data: [1.25, 0, 5, 1] }] };
// `abilities` is there because add() reads a def's ability list to size a transport's hold;
// the payout itself reads nothing but the two costs.
const COSTS = { get: (id) => ({ id, abilities: [], goldCost: id === "hrif" ? 205 : 0, lumberCost: id === "hrif" ? 30 : 0 }) };
{
  const w = new SimWorld(grid(), 1, undefined, undefined, COSTS);
  const caster = addUnit(w, 1, 0, 500, 500);
  const victim = addUnit(w, 2, 1, 760, 500, { typeId: "hrif", hp: 500, maxHp: 500 });
  const mate = addUnit(w, 3, 1, 900, 500, { hp: 500, maxHp: 500 });
  // `isCreep` and the guard post are set on the unit AFTER add(), the way RtsController seeds
  // a map-placed creep — add() itself takes neither. Both guard posts sit at the same spot,
  // which is what makes the two camp-mates (sameCamp: within MiscGame CreepCallForHelp).
  for (const c of [victim, mate]) { c.isCreep = true; c.aggroRange = 600; c.guardX = 800; c.guardY = 500; }
  const before = w.stashOf(0).gold;
  // Deliberately the spell that leaves NOTHING behind to raise the alarm from: the camp has
  // to be alerted while its victim is still standing there to be alerted about.
  w.applySpellEffect("ANtm", 1, caster, { targetId: victim.id, x: victim.x, y: victim.y }, TRANSMUTE);
  check("the transmuted creep is gone", !w.units.has(victim.id) || w.units.get(victim.id).hp <= 0);
  check("...and its camp-mate turns on the caster", mate.targetId === caster.id);
  // 205 × 1.25 = 256.25 → 256, the number players quote for a Rifleman.
  check(`...and the caster's player is paid 125% of its gold cost (${w.stashOf(0).gold - before})`, w.stashOf(0).gold - before === 256);
  check("...and nothing in lumber, which is what DataB says", w.stashOf(0).lumber === 0);
  // The number floats over the BODY, not the caster — that is where the gold came from.
  const texts = w.drainCombatTexts();
  check("...with a gold text over the victim", texts.length === 1 && texts[0].kind === "gold" && texts[0].text === "+256"
    && texts[0].x === victim.x && texts[0].y === victim.y && texts[0].unitId === 0);
  // …addressed to the Alchemist's player alone. Being paid is not a public fact (issue #120).
  check("...on the caster's player's screen only", texts[0].forPlayer === caster.owner);
}

// …and the cap. `[ANtm]`'s Ubertip names both the rule and the column it reads: "Transmute
// cannot be used on Heroes, or creeps above level <ANtm,DataC1>" — DataC1 = 5. Refused at
// the ORDER, with the line the game ships for it, rather than eating 150 mana on a no-op.
console.log("Transmute refuses a creep above its level cap");
{
  const w = new SimWorld(grid(), 1, { get: (id) => (id === "ANtm" ? TRANSMUTE : undefined) }, undefined, COSTS);
  const caster = addUnit(w, 1, 0, 500, 500);
  caster.abilities = [{ id: "ANtm", code: "ANtm", level: 1, cooldownLeft: 0, autocastOn: false }];
  const small = addUnit(w, 2, 1, 760, 500, { typeId: "hrif" });
  const big = addUnit(w, 3, 1, 900, 500, { typeId: "hrif" });
  for (const c of [small, big]) c.isCreep = true;
  small.level = 5;
  big.level = 7; // a Granite Golem's, the one thing on Echo Isles it may not touch
  check("level 5 is inside the cap", w.targetError(caster, small, TRANSMUTE.targetFlags, "ANtm") === null);
  check("level 7 is not", w.targetError(caster, big, TRANSMUTE.targetFlags, "ANtm") === "Creeptoopowerful");
  // The cap is about CREEPS, which is the word the Ubertip uses: a player's own high-level
  // unit is not one, and the row's `nonhero` flag is what keeps Heroes out.
  big.isCreep = false;
  check("...but only for a creep", w.targetError(caster, big, TRANSMUTE.targetFlags, "ANtm") === null);
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

// ── A target that goes INVULNERABLE mid-fight is let go ─────────────────────────────────
// `issueAttack` has always refused an attack on an invulnerable unit (issue #26), so an order
// aimed at one cannot be GIVEN — but an order that outlived its target's vulnerability was the
// same illegal state arrived at by waiting, and it left the attacker swinging forever at
// something it cannot hurt. A Divine Shield, a Big Bad Voodoo, a trigger's SetUnitInvulnerable.
//
// The sibling order paths already knew: attack-move and Hold Position both drop a target that
// went invulnerable, and `acquireTarget` will not pick one up. This is the single-target attack
// order keeping the same rule — which is also what makes it safe to ask every tick.
console.log("an attack order whose target goes invulnerable");
{
  // Alone on the field: the attacker lets go and stands down.
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 0, 500, 500);
  const shielded = addUnit(w, 2, 1, 620, 500, { weapons: [] }); // weaponless: it never pulls us back itself
  w.issueOrder(1, { kind: "attack", targetId: shielded.id, force: false });
  run(w, 1.5);
  check(`is fighting it (order ${u.order}, hp ${shielded.hp})`, u.order === "attack" && u.targetId === shielded.id && shielded.hp < shielded.maxHp);
  const hpWhenShielded = shielded.hp;
  w.setInvulnerable(shielded.id, true);
  run(w, 1);
  check(`let it go (targetId ${u.targetId})`, u.targetId !== shielded.id);
  check(`and stopped swinging at it (hp ${shielded.hp}, was ${hpWhenShielded})`, shielded.hp === hpWhenShielded);
  // The re-acquire must not hand the same unit straight back — that would be a per-tick
  // drop/re-target loop rather than a unit standing down.
  let grabbedAgain = false;
  for (let i = 0; i < Math.round(4 / SIM_DT); i++) {
    w.tick(SIM_DT);
    if (u.targetId === shielded.id) grabbedAgain = true;
  }
  check("and never picks it back up", !grabbedAgain);
}
{
  // With another enemy in reach it rolls onto that one, exactly as it does when a target dies.
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 0, 500, 500);
  const shielded = addUnit(w, 2, 1, 620, 500, { weapons: [] });
  const other = addUnit(w, 3, 1, 860, 500, { weapons: [] });
  w.issueOrder(1, { kind: "attack", targetId: shielded.id, force: false });
  run(w, 1.5);
  w.setInvulnerable(shielded.id, true);
  run(w, 4);
  check(`rolled onto the other enemy (targetId ${u.targetId}, other ${other.id})`, u.targetId === other.id);
  check(`…and is hitting it (hp ${other.hp})`, other.hp < other.maxHp);
}
{
  // The same rule on the AUTOMATIC side, where the thrash would show: an attack-move walks
  // PAST an untouchable enemy to its destination instead of re-engaging it every tick.
  // `nearestEnemy` skips it, so the A-move never stops to fight what it cannot hurt.
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 0, 300, 500);
  const shielded = addUnit(w, 2, 1, 900, 500, { weapons: [] });
  w.setInvulnerable(shielded.id, true);
  w.issueOrder(1, { kind: "attackmove", x: 2400, y: 500 });
  run(w, 12);
  check(`advanced past it (x ${u.x.toFixed(0)}, it stands at 900, destination 2400)`, u.x > 2000);
  check(`never engaged it (targetId ${u.targetId}, hp ${shielded.hp})`, shielded.hp === shielded.maxHp);
}

// ── A COMMITTED SWING LANDS ─────────────────────────────────────────────────────────────
// The wind-up is a commitment. Once the attack animation has started, a target that turns and
// runs does NOT make the attacker cancel it: the unit stands its ground through the wind-up
// and the blow goes through. WC3 even says how far the target may get and still be struck —
// the weapon's own Range Motion Buffer (`RngBuff1`, 250 on all but a handful of the game's
// armed rows), which is the one thing the strike consults. Measuring it by the chase leash
// (48) instead made a melee unit whiff the moment its target ran: animation played, cooldown
// spent, nothing happened.
console.log("a swing already begun is not interrupted by the target running away");
{
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 0, 500, 500);
  const runner = addUnit(w, 2, 1, 600, 500, { weapons: [], hp: 500, maxHp: 500 });
  w.issueOrder(1, { kind: "attack", targetId: runner.id, force: false });
  let ticks = 0;
  while (u.swingLeft < 0 && ticks++ < Math.round(5 / SIM_DT)) w.tick(SIM_DT); // wait for the swing to start
  check("the swing started", u.swingLeft >= 0);
  const hp = runner.hp;
  const swingTarget = u.swingTargetId;
  w.issueOrder(2, { kind: "move", x: 2400, y: 500 }); // …and off it goes, mid-swing
  run(w, 0.5); // the damage point is 0.4s in
  check(`the blow landed anyway (hp ${runner.hp}, was ${hp})`, runner.hp < hp);
  check(`…on the unit it was aimed at (swingTargetId ${swingTarget})`, swingTarget === runner.id);
  check(`…and it is still on the order (order ${u.order}, target ${u.targetId})`, u.order === "attack" && u.targetId === runner.id);
}

// ── An ATTACK-MOVE works down a ladder: the army, then the workers, then the buildings ──
// An A-move is the player pointing rather than picking, so WHICH of the enemies in range it
// picks is the sim's decision — and "the nearest" is the wrong one on the way into a base,
// where the outer Farm and the Peasant beside it are always met before the soldiers that
// defend them. The army first (it is the only thing that shoots back), the workers next
// (they rebuild what you kill), the buildings last.
console.log("attack-move picks the army over the workers over the buildings");
{
  // A Farm's building state — nothing is under construction and nothing is queued; what
  // matters to the ladder is only that the unit HAS one (SimUnit.building is what
  // attackMoveTier reads).
  const FARM = (x, y) => [
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0,
      queue: [], rallyX: x, rallyY: y, rallyKind: "point", rallyTargetId: 0, producesUnits: false },
  ];
  // All three stand inside the attacker's 500 acquisition, and DELIBERATELY in the reverse
  // order: the building is nearest, the worker next, the soldier farthest. Nearest-wins
  // would take them in exactly that order.
  const field = () => {
    const w = new SimWorld(grid(), 1);
    const u = addUnit(w, 1, 0, 300, 500);
    const farm = w.add({ ...addSpec(2, 1, 560, 500), speed: 0, isBuilding: true, radius: 48,
      targetedAs: "structure", weapons: [], oldWeapons: [], name: "Farm" }, ...FARM(560, 500));
    const peasant = w.add({ ...addSpec(3, 1, 640, 500), weapons: [], oldWeapons: [], name: "Peasant" },
      null, { isPeon: true });
    const grunt = addUnit(w, 4, 1, 720, 500, { weapons: [], name: "Grunt" }); // weaponless: it never pulls us itself
    w.issueOrder(1, { kind: "attackmove", x: 2400, y: 500 });
    return { w, u, farm, peasant, grunt };
  };
  {
    const f = field();
    run(f.w, 2);
    check(`took the soldier over the worker and the building (targetId ${f.u.targetId}, soldier ${f.grunt.id})`,
      f.u.targetId === f.grunt.id);
    check(`…and neither of the others was touched (farm ${f.farm.hp}, peasant ${f.peasant.hp})`,
      f.farm.hp === f.farm.maxHp && f.peasant.hp === f.peasant.maxHp);
  }
  {
    // Same field with the army gone: the worker outranks the building.
    const f = field();
    f.w.removeUnit(f.grunt.id);
    run(f.w, 2);
    check(`with no army left, took the worker over the building (targetId ${f.u.targetId}, worker ${f.peasant.id})`,
      f.u.targetId === f.peasant.id);
    check(`…and the building was not touched (hp ${f.farm.hp})`, f.farm.hp === f.farm.maxHp);
  }
  {
    // …and with nothing else standing, the building IS the fight — an A-move into an empty
    // base still razes it. Last is last, not never.
    const f = field();
    f.w.removeUnit(f.grunt.id);
    f.w.removeUnit(f.peasant.id);
    run(f.w, 3);
    check(`with nothing else, engaged the building (targetId ${f.u.targetId}, hp ${f.farm.hp})`,
      f.u.targetId === f.farm.id && f.farm.hp < f.farm.maxHp);
  }
  {
    // The UPGRADE: the ladder is re-asked while the unit is holding something below the
    // army, because on the way into a base the outbuildings are in range first and the
    // defenders arrive after. Without it, one decision at second zero has the whole squad
    // chewing a Farm for the rest of the battle.
    const w = new SimWorld(grid(), 1);
    const u = addUnit(w, 1, 0, 300, 500);
    const farm = w.add({ ...addSpec(2, 1, 560, 500), speed: 0, isBuilding: true, radius: 48,
      targetedAs: "structure", weapons: [], oldWeapons: [], name: "Farm", hp: 100000, maxHp: 100000 }, ...FARM(560, 500));
    w.issueOrder(1, { kind: "attackmove", x: 2400, y: 500 });
    run(w, 2);
    check(`started on the only thing there was (targetId ${u.targetId}, farm ${farm.id})`, u.targetId === farm.id);
    const defender = addUnit(w, 3, 1, 700, 500, { weapons: [] }); // the defence turns up
    run(w, 2);
    check(`switched onto the defender that arrived (targetId ${u.targetId}, defender ${defender.id})`,
      u.targetId === defender.id);
    check(`…and is hitting it (hp ${defender.hp})`, defender.hp < defender.maxHp);
  }
  {
    // …and never the other way round. A fight already joined is not abandoned because a
    // Peasant wandered past: the switch is an UPGRADE only.
    const w = new SimWorld(grid(), 1);
    const u = addUnit(w, 1, 0, 300, 500);
    const soldier = addUnit(w, 2, 1, 560, 500, { weapons: [] });
    w.issueOrder(1, { kind: "attackmove", x: 2400, y: 500 });
    run(w, 2);
    check(`engaged the soldier (targetId ${u.targetId})`, u.targetId === soldier.id);
    const peasant = w.add({ ...addSpec(3, 1, 400, 500), weapons: [], oldWeapons: [], name: "Peasant" },
      null, { isPeon: true });
    run(w, 2);
    check(`stayed on it when a worker walked nearer (targetId ${u.targetId}, worker ${peasant.id})`,
      u.targetId === soldier.id);
    check(`…and never swung at the worker (hp ${peasant.hp})`, peasant.hp === peasant.maxHp);
  }
}

console.log(failures === 0 ? "\nattack-order: all checks passed" : `\nattack-order: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
