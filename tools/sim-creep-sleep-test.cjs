// Headless check that a creep camp GOES TO SLEEP after dark.
//
// Reported as "creeps that should sleep during the night are not sleeping", with the developer
// pointing at the data field that decides it. The field is real and is read: `Units\UnitData.slk`
// `canSleep` (a Gnoll 1, a Murloc 1, a Golem 0) → `UnitDef.canSleep` → `SimUnit.canSleep`, set
// when a map-placed Neutral Hostile is seeded (`RtsController`) or a script makes one
// (`createScriptUnit`). What was missing was any way for a player to SEE it happen — the Zzz
// (`[ACsp] Casterart`, mapViewer.collectSleepFx) — but the sleep itself has to keep working, and
// nothing asked. So this file asks.
//
// The rule (SimWorld.tickCreep): a creep with `canSleep` dozes off at night while it is IDLE at
// its guard post and its camp is quiet. Asleep it acquires nobody — which is what lets an army
// walk past a camp in the dark. What ends the nap is DAWN or COMBAT, and combat only:
// proximity does not wake a creep (reported as "sleeping creeps wake up when a unit simply
// walks near them" — we used to rouse one to any hostile within 200, which is well inside its
// aggro range, so "woken" meant "charging"). Being struck wakes it (`provoke`), and so does a
// camp-mate's fight — which is how the members of a camp that do NOT sleep (`cansleep=0`, the
// Mud Golem) act as the eyes of the ones that do.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const W = 160, H = 160;
/** A melee weapon, because a creep with nothing in hand notices nobody: `nearestEnemy` — which
 *  is what wakes a sleeper — asks `canAttack` first, and a weaponless unit fails it. */
const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 12, baseDamage: 12, dice: 1, baseDice: 1, sides: 6,
  cooldown: 1.2, baseCooldown: 1.2, range: 90, baseRange: 90, rangeBuffer: 250,
  damagePoint: 0.4, baseDamagePoint: 0.4, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "normal", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

/** One Neutral Hostile creep guarding where it stands. `canSleep` is the field. */
function addCreep(world, id, x, y, canSleep) {
  const c = world.add(
    {
      id, owner: -1, team: -1, race: "", typeId: "ngno", x, y, facing: 0,
      speed: 270, turnRate: 0.5, radius: 16, flying: false, flyHeight: 0,
      sightDay: 1400, sightNight: 800, hp: 500, maxHp: 500, mana: 0, maxMana: 0,
      armor: 0, armorType: "medium", weapons: [WEAPON()], oldWeapons: [WEAPON()],
      castPoint: 0, castBackswing: 0, targetedAs: "ground", moveType: "foot",
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    { level: 2 },
  );
  // What RtsController does for every map-placed Neutral Hostile: guard the ground it was put
  // on, and carry its type's own sleep flag.
  c.isCreep = true;
  c.guardX = c.x;
  c.guardY = c.y;
  c.guardFacing = c.facing;
  c.canSleep = canSleep;
  c.aggroRange = c.weapon.acquire; // no per-placed targetAcquisition here, so the weapon's
  return c;
}

/** A world with one such creep in it. */
function camp(canSleep) {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const world = new SimWorld(grid, 1);
  return { world, creep: addCreep(world, 1, 1500, 1500, canSleep) };
}

/** A player unit `gap` units from the camp — the thing a sleeping creep may or may not notice. */
function intruder(world, creep, gap) {
  return world.add(
    {
      id: 2, owner: 0, team: 0, race: "human", typeId: "hfoo", x: creep.x + gap, y: creep.y, facing: 0,
      speed: 270, turnRate: 0.5, radius: 16, flying: false, flyHeight: 0,
      sightDay: 1400, sightNight: 800, hp: 420, maxHp: 420, mana: 0, maxMana: 0,
      armor: 2, armorType: "medium", weapons: [WEAPON()], oldWeapons: [WEAPON()],
      castPoint: 0, castBackswing: 0, targetedAs: "ground", moveType: "foot",
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    {},
  );
}

const run = (world, seconds) => {
  for (let i = 0; i < seconds * 20; i++) world.tick(0.05);
};
const NIGHT = 21;
const DAY = 10;

console.log("the data field decides it");
{
  const { world, creep } = camp(true);
  world.timeOfDay = NIGHT;
  run(world, 1);
  check("a creep whose row says canSleep dozes at night", creep.asleep, true);
}
{
  const { world, creep } = camp(false);
  world.timeOfDay = NIGHT;
  run(world, 1);
  check("…and one whose row says it does not, does not", creep.asleep, false);
}

console.log("\ndawn wakes it");
{
  const { world, creep } = camp(true);
  world.timeOfDay = NIGHT;
  run(world, 1);
  world.timeOfDay = DAY;
  run(world, 1);
  check("daylight ends the nap", creep.asleep, false);
}

console.log("\nwalking past does NOT");
{
  const { world, creep } = camp(true);
  world.timeOfDay = NIGHT;
  run(world, 1);
  intruder(world, creep, 600);
  run(world, 1);
  check("an army can slip past the camp at a distance", creep.asleep, true);
  check("…and the sleeping creep has acquired nobody", creep.targetId, null);
}
{
  const { world, creep } = camp(true);
  world.timeOfDay = NIGHT;
  run(world, 1);
  intruder(world, creep, 120); // right on top of it — well inside its 500 aggro range
  run(world, 2);
  check("…and can walk right through it, so long as nobody swings", creep.asleep, true);
  check("…still having acquired nobody", creep.targetId, null);
}

console.log("\na blow does");
{
  const { world, creep } = camp(true);
  world.timeOfDay = NIGHT;
  run(world, 1);
  const foot = intruder(world, creep, 120);
  world.issueAttack(foot.id, creep.id, false, true); // the player clicked Attack on the sleeper
  run(world, 3);
  check("being struck ends the nap", creep.asleep, false);
  check("…and the woken creep fights back", creep.targetId, foot.id);
}

console.log("\n…and so does a camp-mate that never sleeps");
{
  // A mixed camp: a Golem (`cansleep=0`) beside a sleeper, guard posts inside
  // CreepCallForHelp (600) of each other so they are camp-mates.
  const { world, creep } = camp(true);
  const golem = addCreep(world, 3, creep.x + 200, creep.y, false);
  world.timeOfDay = NIGHT;
  run(world, 1);
  check("the sleeper naps beside the wakeful Golem", creep.asleep, true);
  check("…and the Golem does not", golem.asleep, false);
  // Inside the Golem's own 500 aggro range, and it is awake to use it.
  intruder(world, golem, 300);
  run(world, 2);
  check("the Golem engages", golem.order, "attack");
  check("…and its fight wakes the whole camp", creep.asleep, false);
  check("…which joins it", creep.order, "attack");
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
