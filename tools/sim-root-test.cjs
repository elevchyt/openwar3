// Headless check of Root / Unroot (`Aroo`, aliases Aro1/Aro2) — the Ancients' stance toggle.
//
// The point of the ability is that one unit is two things: a building that trains and blocks
// cells, and a slow angry tree that walks and swings. What is verified here is that both
// states fall out of the DATA rather than out of hardcoded special cases.
//
// Numbers are the real 1.27a ones from Units\AbilityData.slk, with the column meanings from
// AbilityMetaData.slk Roo1..Roo4 → UI\WorldEditStrings.txt:
//   DataA "Rooted Weapons"        Aroo/Aro1 = 1, Aro2 = 2   (same bitmask as weapsOn)
//   DataB "Uprooted Weapons"      Aroo/Aro1 = 2, Aro2 = 1
//   DataC "Rooted Turning"        0
//   DataD "Uprooted Defense Type" 2  — unspent, see the handler
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// A registry carrying the two real Root rows. Aro1 is what the Ancients and the Trees take;
// Aro2 is the Ancient Protector's, with the slots the other way round.
const ROWS = {
  Aro1: [1, 2, 0, 2],
  Aro2: [2, 1, 0, 2],
};
const reg = {
  get: (id) => (ROWS[id] ? { levelData: [{ castRange: 0, area: 0, data: ROWS[id] }] } : undefined),
};

// A REAL PathingGrid: the plant-refusal case calls footprintFits/worldToCell, so a bare
// {width,height,blocked} stub (what the other sim tests get away with) is not enough here.
const FLAGS = new Uint8Array(32 * 32); // 0 = walkable everywhere
const grid = new PathingGrid({ width: 32, height: 32, flags: FLAGS }, [0, 0]);
const world = new SimWorld(grid, 1, reg);

/** An Ancient with two weapon slots, planted. `abilId` picks Aro1 (Ancient) or Aro2 (Protector). */
function ancient(abilId, over = {}) {
  const u = {
    id: 1, owner: 0, team: 0, hp: 900, x: 256, y: 256, prevX: 256, prevY: 256,
    detectRadius: 0, invisible: false, cloaked: false, uprooted: false, rootedFootprint: 0,
    inventory: [], buffs: [], footprint: 0, hasReservation: false,
    abilities: [{ id: abilId, code: "Aroo", level: 1, cooldownLeft: 0, autocastOn: false }],
    // Slot 0 = a 128-range melee; slot 1 = the Protector's 700-range attack that also hits air.
    weapons: [
      { enabled: false, baseDamage: 25, damage: 0, baseDice: 1, dice: 0, baseRange: 128, range: 0, baseDamagePoint: 0.3, damagePoint: 0, baseBackswing: 0.3, backswing: 0, baseCooldown: 2, cooldown: 0, baseSpillDist: 0, spillDist: 0, baseSpillRadius: 0, spillRadius: 0 },
      { enabled: false, baseDamage: 44, damage: 0, baseDice: 1, dice: 0, baseRange: 700, range: 0, baseDamagePoint: 0.3, damagePoint: 0, baseBackswing: 0.3, backswing: 0, baseCooldown: 2, cooldown: 0, baseSpillDist: 0, spillDist: 0, baseSpillRadius: 0, spillRadius: 0 },
    ],
    baseArmor: 2, baseMaxHp: 900, baseMaxMana: 0, baseSpeed: 40, baseSight: 1800,
    ...over,
  };
  world.units.set(u.id, u);
  return u;
}
const liveSlots = (u) => u.weapons.map((w, i) => (w.enabled ? i : -1)).filter((i) => i >= 0);

// --- an Ancient of War (Aro1) ---------------------------------------------------------
{
  const u = ancient("Aro1");
  world.recomputeStats(u);
  check("planted, an Ancient cannot move", u.speed, 0);
  check("…and fires DataA \"Rooted Weapons\" = slot 1", liveSlots(u), [0]);

  check("it uproots", world.toggleRoot(u), true);
  world.recomputeStats(u);
  check("uprooted, it walks at its UnitBalance speed", u.speed, 40);
  check("…and swaps to DataB \"Uprooted Weapons\" = slot 2", liveSlots(u), [1]);

  check("it roots again", world.toggleRoot(u), true);
  world.recomputeStats(u);
  check("planted again, it is immobile once more", u.speed, 0);
  check("…back on the rooted slot", liveSlots(u), [0]);
}

// --- the Ancient Protector (Aro2), where the swap actually matters ---------------------
//
// etrp has weapsOn=3 and takes Aro2, so the columns run the other way: planted it is a
// TOWER (slot 2, range 700, hits air), uprooted it is a melee unit (slot 1, range 128).
{
  const u = ancient("Aro2");
  world.recomputeStats(u);
  check("a planted Protector fires its 700-range tower attack", liveSlots(u), [1]);
  check("…which is genuinely the long-ranged slot", u.weapons[1].range, 700);

  world.toggleRoot(u);
  world.recomputeStats(u);
  check("uprooted it drops to the 128-range melee slot", liveSlots(u), [0]);
  check("…which is genuinely the short-ranged one", u.weapons[0].range, 128);
}

// --- planting refuses where the footprint no longer fits -------------------------------
//
// An Ancient can walk somewhere too tight to plant. Refusing is the right answer: a building
// that plants itself inside a wall is worse than one that says no.
{
  const u = ancient("Aro1", { footprint: 3 });
  world.toggleRoot(u); // uproot — frees its cells
  check("it is walking", u.uprooted, true);
  // Walking, it collides by RADIUS, not as a stamped 3x3 block — otherwise the pathfinder
  // routes around the Ancient's own body and it can never take a step.
  check("…and puts its building footprint away while it walks", u.footprint, 0);
  check("…remembering what to take back", u.rootedFootprint, 3);
  // Wall the grid off so nothing fits anywhere.
  FLAGS.fill(0x02); // wall every cell off (the .wpm unwalkable bit)
  check("planting refuses where it does not fit", world.toggleRoot(u), false);
  check("…and it is still walking, not half-planted", u.uprooted, true);
  FLAGS.fill(0);
  check("…and plants once there is room again", world.toggleRoot(u), true);
  check("…now rooted", u.uprooted, false);
  check("…with its 3x3 footprint back", u.footprint, 3);
}

// --- a unit without the ability is untouched -------------------------------------------
{
  const u = ancient("Aro1", { abilities: [] });
  check("a unit with no Root ability cannot toggle", world.toggleRoot(u), false);
  world.recomputeStats(u);
  check("…and keeps its ordinary movement speed", u.speed, 40);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
