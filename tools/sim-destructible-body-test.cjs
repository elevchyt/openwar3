// A crate, a barrel or a gate that can be attacked fights as a sim UNIT (RtsController.
// addDestructible gives it a body, marked by its `targetKey`) — but to the SCRIPT it is a
// DESTRUCTABLE and nothing else. It is not in any unit enumeration (`GetUnitsOfPlayerAll(
// Player(PLAYER_NEUTRAL_PASSIVE))` is how a map finds its shops), and when it breaks it raises a
// destructable's death (MapViewerScene.reapDestructibles), never EVENT_PLAYER_UNIT_DEATH for a
// Neutral Passive "unit".
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { unitSnapshots } = require(join(REPO, ".sim-build", "src", "game", "jassHooks.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

function unit(over = {}) {
  const u = {
    id: 1, owner: -1, team: -2, typeId: "ngme", race: "other", isHero: false, properName: "",
    level: 1, xp: 0, skillPoints: 0, abilities: [], inventory: [],
    baseStr: 10, baseAgi: 10, baseInt: 10, baseMaxHp: 100,
    hp: 0, maxHp: 100, mana: 0, maxMana: 0, x: 500, y: 500,
    sightDay: 0, sightNight: 0, flying: false, mechanical: false, isSummon: false,
    isCreep: false, neutralPassive: true, isIllusion: false, targetKey: "",
    buffs: [], weapons: [], orderQueue: [], path: [], footprint: 0, hasReservation: false,
    building: null, worker: null, order: "idle", targetId: null, moving: false,
    garrison: [], garrisonCap: 0, inMine: false, inBurrow: false, insideBuild: false,
    summonLeft: 0, constructing: 0, mineId: 0, entangledBy: 0, heldCorpses: [],
    noCollision: false, radius: 16, facing: 0,
    ...over,
  };
  u.baseSightDay = u.sightDay;
  u.baseSightNight = u.sightNight;
  return u;
}
const worldOf = () => new SimWorld(new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]), 1);

console.log("a destructible's body is not a unit to the script");
{
  const w = worldOf();
  w.units.set(1, unit({ id: 1, typeId: "ngme" })); // a shop
  w.units.set(2, unit({ id: 2, typeId: "LTcr", targetKey: "debris" })); // a crate's body
  check("the unit enumeration lists the shop and not the crate", unitSnapshots(w).map((s) => s.id), [1]);
}

console.log("\n…and it does not die as one");
{
  const w = worldOf();
  w.captureDeaths = true;
  w.units.set(3, unit({ id: 3, typeId: "LTcr", targetKey: "debris" }));
  w.units.set(4, unit({ id: 4, typeId: "nshe" }));
  w.killUnit(3);
  w.killUnit(4);
  check("only the real unit raised a unit death", w.drainDeathEvents().map((e) => e.victim.id), [4]);
}

console.log(failed ? `\ndestructible-body: ${failed} FAILED` : "\ndestructible-body: all checks passed");
process.exit(failed ? 1 : 0);
