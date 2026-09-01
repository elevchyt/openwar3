// DISJOINTING — what makes a homing missile MISS after it has been loosed.
//
// Liquipedia's Weapon Types page states the Missile rule outright: the missile "will also
// miss, if one of the following conditions is met during any time of the missile's traveling"
// — the target is invisible, the target is loaded into another unit (Orc Burrow, Goblin
// Zeppelin, Devour), the target is teleported, the target dies — and adds that "abilities with
// missiles follow the same behaviour as the Missile weapon type". That is the whole of why a
// Blink disjoints an arrow.
//
// The list has no DISTANCE in it, and that is the half this file pins hardest. The Range
// Motion Buffer belongs to the two weapon types that throw nothing: hive's own answer on the
// field (thread 53615) is one line — "Range Motion Buffer is how far away a unit have to run to
// make a Normal or Instant-type attack against it miss. Missile and Artillery-type attacks are
// unaffected by RMB." So an arrow already in the air chases as far as it must; what ends it is
// the manner of the target's leaving, never the length of it.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const SIM_DT = 1 / 60;
const W = 256, H = 256;
const grid = () => new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);

const AIR_TARGETS = ["ground", "structure", "debris", "air", "item", "ward"];

/** One archer's worth of UnitWeapons slot, with a DELIBERATELY slow missile: the whole point
 *  of these cases is what happens while the arrow is still in the air, so it needs to be in
 *  the air for a while. The cooldown is long enough that nobody gets a second shot off. */
const archerSlot = (over = {}) => ({
  enabled: true, targets: AIR_TARGETS, weaponType: "missile", attackType: "pierce",
  damage: 20, dice: 1, sides: 1, cooldown: 30, range: 900, rangeBuffer: 250,
  damagePoint: 0.05, backswing: 0.1,
  missileArt: "Abilities\\Weapons\\Arrow\\ArrowMissile.mdx", missileSpeed: 250,
  spillDist: 0, spillRadius: 0, damageLoss: 0, areaFull: 0, areaHalf: 0, areaQuarter: 0,
  splashTargets: [], showUI: true, ...over,
});
const ARCHER = weaponsFromDef({
  weapons: [archerSlot()], acquireRange: 1600, launchX: 0, launchY: 0, launchZ: 60, impactZ: 60,
});

function addUnit(w, id, owner, x, y, weapons, over = {}) {
  return w.add({
    id, owner, team: over.team !== undefined ? over.team : owner,
    typeId: "t" + id, x, y, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 6, radius: 16, scale: 1,
    armor: 0, armorType: "medium", defUp: 0,
    sightDay: 3000, sightNight: 3000,
    flying: false, mechanical: false, invulnerable: false, race: "nightelf",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: false, targetedAs: "ground", deathTime: 2, name: "T" + id,
    worker: null, depotGold: false, depotLumber: false, castPoint: 0, castBackswing: 0,
    ...over, weapons, oldWeapons: weapons,
  });
}

/** Wind Walk landing on a unit, as the ability itself lays it down (`AOwk`: an `invisible`
 *  buff grouped with the haste, here with the Transition Time already elapsed so the fade is
 *  in force). Written as a real buff and not by poking `invisible` because recomputeStats
 *  re-derives that flag from the buff list every pass and would wipe a bare flag. */
const fade = (t) => {
  t.buffs.push({
    kind: "invisible", group: "windwalk", timeLeft: 20, sourceId: t.id,
    value: 0, value2: 0, art: "", fx: [], buffId: "", delay: 0,
  });
};

/**
 * Loose one arrow, run `duringFlight(world, shooter, target)` the tick after it is airborne,
 * then fly the rest of it out. Reports whether the shot LANDED (a hit was recorded and hp
 * came off) or FIZZLED (the projectile was removed with no impact point — the renderer's own
 * test for a disjoint: see mapViewer, "a fizzle just detaches").
 */
function shot(duringFlight, setUp = () => {}) {
  const w = new SimWorld(grid(), 2);
  const a = addUnit(w, 1, 0, 500, 500, ARCHER);
  const t = addUnit(w, 2, 1, 1100, 500, []);
  setUp(w, a, t);
  w.issueOrder(a.id, { kind: "attack", targetId: t.id, force: true });

  let launched = false, meddled = false, impacts = 0, removals = 0, hits = 0;
  for (let i = 0; i < 1200; i++) {
    w.tick(SIM_DT);
    if (w.drainSpawnedProjectiles().length) launched = true;
    impacts += w.drainProjectileImpacts().length;
    removals += w.drainRemovedProjectiles().length;
    hits += w.drainHits().length;
    if (launched && !meddled) {
      meddled = true;
      duringFlight(w, a, t);
      continue;
    }
    if (meddled && removals) break;
  }
  return {
    launched, fizzled: removals > 0 && impacts === 0, landed: hits > 0 && t.hp < 100000,
    stillFlying: w.projectiles.size > 0, hp: t.hp, teleports: t.teleports,
  };
}

// ---------------------------------------------------------------------------------------
console.log("\nthe baseline: an arrow that is left alone lands");
{
  const r = shot(() => {});
  check("it was actually loosed", r.launched);
  check("and it hit", r.landed && !r.fizzled, `hp ${r.hp}`);
}

console.log("\nDISTANCE is not a disjoint — RMB belongs to Normal and Instant, not to a missile");
{
  // Shoved 3000 units away WITHOUT a teleport — the displacement a walk would make, only all
  // at once. Far beyond any "base range + Range Motion Buffer" reading of the folklore
  // (900 + 250 = 1150), and the arrow must still chase it down.
  const r = shot((w, a, t) => { t.x += 3000; });
  check("the target is nowhere near the shooter's reach", true, "moved 3000 units out");
  check("nothing was teleported", r.teleports === 0);
  check("the arrow chases it and lands anyway", r.landed && !r.fizzled, `hp ${r.hp}`);
}

console.log("\nTELEPORTED: the Blink case");
{
  // The same displacement as above, through the teleport path this time (SetUnitPosition is
  // the JASS door onto `teleportUnit`, which is also Blink's and Mass Teleport's).
  const r = shot((w, a, t) => { w.setUnitPosition(t.id, t.x + 3000, t.y); });
  check("the teleport was stamped on the unit", r.teleports === 1);
  check("the arrow is disjointed", r.fizzled, `hits ${r.landed}`);
  check("and nothing is left in the air", !r.stillFlying);
  check("the target took no damage", r.hp === 100000);
}
{
  // A SHORT hop disjoints exactly as a long one does: it is the manner of the leaving that
  // ends the missile, not the distance covered. (Blink's own minimum is nothing like this
  // small — the point is that the rule never consults the number.)
  const r = shot((w, a, t) => { w.setUnitPosition(t.id, t.x + 40, t.y); });
  check("a 40-unit hop still disjoints", r.fizzled && r.hp === 100000);
}

console.log("\nINVISIBLE: the Wind Walk case");
{
  const r = shot((w, a, t) => { fade(t); });
  check("fading mid-flight disjoints the arrow", r.fizzled, `hp ${r.hp}`);
}
{
  // …unless the shooter's side has TRUE SIGHT over the vanishing point. Detection is a team
  // property in WC3 (one Sentry Ward serves the whole army, and Dust of Appearance serves it
  // with nothing standing there at all), which is the same rule canSee already keeps — so the
  // disjoint has to ask it too.
  const r = shot((w, a, t) => { fade(t); }, (w, a, t) => {
    w.addItemReveal(0, 0, { x: 1100, y: 500, radius: 900, seconds: 60, detect: true });
  });
  check("a detector over the target cancels the disjoint", r.landed && !r.fizzled, `hp ${r.hp}`);
}
{
  // A unit is never hidden from its OWN side: a Death Coil sent to heal a Wind Walking ally
  // must not be thrown away by the ally fading. Same team, so the fade is nothing to us.
  const r = shot((w, a, t) => { fade(t); }, (w, a, t) => { t.team = 0; });
  check("an ally's own fade does not disjoint the shot", r.landed && !r.fizzled, `hp ${r.hp}`);
}

console.log("\nINVULNERABLE: the Divine Shield case");
{
  // Liquipedia files this one line ABOVE the miss list — the missile "will deal no damage, if
  // the target is invulnerable, when the missile reaches the target", i.e. it arrives wasted.
  // We disjoint it instead (see missileDisjointed): for a plain arrow the difference is
  // cosmetic, but an arrival carries orbs, Liquid Fire, Pillage, the line spill and a spell
  // missile's whole effect, none of which may reach a unit nothing is supposed to touch.
  const r = shot((w, a, t) => {
    t.buffs.push({ kind: "invuln", group: "divineshield", timeLeft: 15, sourceId: t.id,
      value: 0, value2: 0, art: "", fx: [], buffId: "", delay: 0 });
  });
  check("a shield raised mid-flight disjoints the arrow", r.fizzled, `hp ${r.hp}`);
  check("and nothing lands on it", r.hp === 100000);
}

console.log("\nLOADED INTO ANOTHER UNIT: the Burrow / Zeppelin / Devour case");
{
  const r = shot((w, a, t) => { t.inBurrow = true; });
  check("climbing into a hold disjoints the arrow", r.fizzled && r.hp === 100000);
}
{
  const r = shot((w, a, t) => { t.devouredBy = 99; });
  check("being swallowed by a Kodo does too", r.fizzled && r.hp === 100000);
}
{
  // Mirror Image whisks the Blademaster off the field for the beat the copies fly out on
  // (`vanished`), and that is a disjoint on the same grounds: there is nothing standing there.
  const r = shot((w, a, t) => { t.vanished = true; });
  check("and so does Mirror Image's shuffle", r.fizzled && r.hp === 100000);
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
