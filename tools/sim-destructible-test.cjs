// Attackable DESTRUCTIBLES — the gate you have to break to get on with the mission.
//
// A destructible was map geometry, a pathing footprint and a JASS handle, and nothing a fight
// could reach: no life to spend, no body to stand next to, no identity a weapon could match.
// Rise of the Naga shuts its first path with an Elven Gate, and there was no way to attack it.
//
// It is a sim UNIT now (see RtsController.addDestructible), which is how WC3 has it too —
// a destructable and a unit meet one class up, at CWidget. Three things make it a
// destructible rather than a unit, and all three are what this pins:
//
//   • `targetKey` — its DestructableData `targType`, matched against a weapon's Targets
//     Allowed. `debris` is in every melee unit's list (`ground,structure,debris,item,ward`),
//     which is exactly why a gate is attackable and a bridge is not.
//   • `neutralPassive` — so nothing AUTO-acquires it. Units walk past crates until told.
//   • death routed back out, so the renderer opens the gate the same way a script's
//     KillDestructable does.
//
// Run: pnpm sim:test
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

const SIM_DT = 1 / 60;
const W = 96, H = 96;
const grid = () => new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);

// Straight out of UnitWeapons.slk: this IS the Huntress's / Warden's / Footman's list.
const MELEE_TARGETS = ["ground", "structure", "debris", "item", "ward"];

const WEAPON = (targets = MELEE_TARGETS) => ({
  enabled: true, targets, ranged: false,
  damage: 20, baseDamage: 20, dice: 1, baseDice: 1, sides: 1,
  cooldown: 1.0, baseCooldown: 1.0, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.1, baseDamagePoint: 0.1, backswing: 0.1, baseBackswing: 0.1,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 800, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function addUnit(w, id, owner, x, y, over = {}) {
  const weapons = over.weapons ?? [WEAPON()];
  return w.add({
    id, owner, team: owner, typeId: "hfoo", x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
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

/** What RtsController.addDestructible produces: a neutral-passive, immobile, weaponless unit
 *  carrying the destructible's own life, collider and target class. The Elven Gate's numbers
 *  (LTe1): HP 500, radius 50, targType debris, no armour multiplier. */
function addDestructible(w, id, x, y, over = {}) {
  const u = w.add({
    id, owner: -1, team: -2, typeId: "dest:LTe1", x, y, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 0, turnRate: 0, radius: 50, scale: 1,
    // The damage table carries the eight UNIT armour classes and no destructable row, so a
    // blow lands undivided — "" degrades to a 1.0 multiplier.
    armor: 0, armorType: "", defUp: 0,
    sightDay: 0, sightNight: 0,
    flying: false, mechanical: false, invulnerable: false, race: "other",
    isBuilding: false, foodCost: 0, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "none", collisionSize: 50,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "Elven Gate",
    worker: null, depotGold: false, depotLumber: false,
    castPoint: 0, castBackswing: 0,
    weapons: [], oldWeapons: [],
    ...over,
  });
  u.neutralPassive = true;
  u.targetKey = over.targetKey ?? "debris";
  return u;
}

const run = (w, seconds) => { for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.tick(SIM_DT); };

console.log("a gate is a target a weapon can name");
{
  const w = new SimWorld(grid(), 1);
  addUnit(w, 1, 0, 400, 500);
  const gate = addDestructible(w, 2, 900, 500);
  const ok = w.issueOrder(1, { kind: "attack", targetId: gate.id, force: true });
  check("the attack order is accepted", ok);
  run(w, 10);
  check(`the gate took damage (hp ${gate.hp.toFixed(0)} of 500)`, gate.hp < 500);
  run(w, 30);
  check(`and it comes down (hp ${gate.hp.toFixed(0)})`, gate.hp <= 0);
}

console.log("\nbut only when the weapon lists its class");
{
  const w = new SimWorld(grid(), 1);
  // A Chimaera's corrosive breath: `structure,debris` only — it CAN hit a gate.
  addUnit(w, 1, 0, 400, 500, { weapons: [WEAPON(["structure", "debris"])] });
  const gate = addDestructible(w, 2, 900, 500);
  check("a structure,debris weapon may attack it", w.issueOrder(1, { kind: "attack", targetId: gate.id, force: true }));

  const w2 = new SimWorld(grid(), 1);
  // A ground-only attack — no `debris` — must be refused, exactly as WC3 refuses the order.
  addUnit(w2, 1, 0, 400, 500, { weapons: [WEAPON(["ground", "air"])] });
  const gate2 = addDestructible(w2, 2, 900, 500);
  check("a ground,air weapon may NOT", !w2.issueOrder(1, { kind: "attack", targetId: gate2.id, force: true }));

  const w3 = new SimWorld(grid(), 1);
  addUnit(w3, 1, 0, 400, 500);
  // `bridge` is in no unit's Targets Allowed in the whole game — nothing can attack one.
  const bridge = addDestructible(w3, 2, 900, 500, { targetKey: "bridge" });
  check("and a bridge is attackable by nobody", !w3.issueOrder(1, { kind: "attack", targetId: bridge.id, force: true }));
}

console.log("\nnothing auto-acquires a destructible");
{
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 0, 400, 500);
  const gate = addDestructible(w, 2, 560, 500); // well inside the 800 acquire range
  run(w, 6);
  check("the gate is untouched — units walk past crates until told", gate.hp === 500);
  check("and the unit never picked a fight", u.order === "idle" && u.targetId === null);
}

console.log("\na destructible is not a combatant");
{
  const w = new SimWorld(grid(), 1);
  const u = addUnit(w, 1, 0, 400, 500);
  const gate = addDestructible(w, 2, 470, 500);
  w.issueOrder(1, { kind: "attack", targetId: gate.id, force: true });
  run(w, 6);
  check("it never hits back (no weapons)", u.hp === u.maxHp);
  check("and it never moves", gate.x === 470 && gate.y === 500);
}

console.log(failures ? `\n${failures} FAILED` : "\ndestructibles: all checks passed");
process.exit(failures ? 1 : 0);
