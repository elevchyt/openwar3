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
    // Raised facing south (bj_UNIT_FACING) but currently looking east: an Ancient that plants
    // has to TURN back, and the two angles have to differ for that turn to be visible at all.
    facing: 0, desiredFacing: 0, builtFacing: 4.71238898038469, morphT: 0,
    rootPending: null, rootSettle: null, radius: 72, turnRate: 0.5,
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

/** Let a transition finish. A root/unroot takes `Aroo`'s own `Dur1` (2.5s) and the unit is
 *  locked for it — no orders, no walking, no second press — so every check about the state on
 *  the OTHER side of a toggle has to wait the clock out first. These units are hand-built and
 *  never see `world.tick`, so the clock is run by hand — and with it the settle a PLANTING
 *  Ancient spends that clock on (the walk onto its site and the turn square), which the real
 *  tick advances every frame. */
const settled = (u) => { u.morphT = 0; world.tickRootSettle(u); world.recomputeStats(u); return u; };

// --- an Ancient of War (Aro1) ---------------------------------------------------------
{
  const u = ancient("Aro1");
  world.recomputeStats(u);
  check("planted, an Ancient cannot move", u.speed, 0);
  check("…and fires DataA \"Rooted Weapons\" = slot 1", liveSlots(u), [0]);

  check("it uproots", world.toggleRoot(u), true);
  world.recomputeStats(u);
  check("…and is locked for the transition", u.morphT > 0 && u.speed === 0, true);
  check("…so a second press does nothing", world.toggleRoot(u), false);
  settled(u);
  check("uprooted, it walks at its UnitBalance speed", u.speed, 40);
  check("…and swaps to DataB \"Uprooted Weapons\" = slot 2", liveSlots(u), [1]);

  check("it roots again", world.toggleRoot(u), true);
  // The turn back to `builtFacing` is part of the root GESTURE, not something that happens on
  // the frame the button is pressed: 2.5 seconds of a tree lowering itself onto a spot cannot
  // start out already square. So it is still looking the way it walked here…
  check("…still facing the way it walked while the roots go down", u.facing, 0);
  settled(u);
  check("planted again, it is immobile once more", u.speed, 0);
  check("…facing the way it was raised", u.facing, u.builtFacing);
  check("…back on the rooted slot", liveSlots(u), [0]);
}

// --- Root is a WALK to a site, even a site under its own feet ---------------------------
//
// Pressing Root hands the player the building's silhouette and the click chooses the spot, so
// the order always has a destination and the Ancient always walks onto it. A "close enough,
// plant now" shortcut skipped that for every site within a body's width — which is most of the
// ground a player actually aims at — and the tree snapped into its rooted pose on the click.
{
  const u = ancient("Aro1", { footprint: 4, x: 512, y: 512, prevX: 512, prevY: 512 });
  world.toggleRoot(u); // uproot
  settled(u);
  check("ordering it to root where it stands is accepted", world.issueRootAt(u.id, u.x, u.y), true);
  check("…as an order with a destination, not a plant", u.uprooted, true);
  check("…which it holds until it has arrived", JSON.stringify(u.rootPending), JSON.stringify({ x: 512, y: 512 }));
  world.tickRootAt(u); // it is standing on the spot already: this is the arrival
  check("…and then it plants", u.uprooted, false);
  check("…on the site rather than beside it", [u.x, u.y], [512, 512]);
  settled(u);
  check("…square with the base once the gesture is over", u.facing, u.builtFacing);
}

// --- the settle closes the gap the walk leaves, across the transition -------------------
//
// A move stops within a body of the point it was aimed at, and a building has to end up ON its
// site. That last stretch is walked during the root animation (SimUnit.rootSettle) rather than
// teleported the instant the stance flips.
{
  const u = ancient("Aro1", { footprint: 4, x: 816, y: 768, prevX: 816, prevY: 768 });
  world.toggleRoot(u); // uproot
  settled(u);
  // Straight to the arrival: the walk itself is an ordinary move order and belongs to the
  // pathing tests, and what is under test here is what happens once it has stopped short.
  u.rootPending = { x: 768, y: 768 };
  world.tickRootAt(u);
  check("planting starts from where the walk stopped", [Math.round(u.x), Math.round(u.y)], [816, 768]);
  u.morphT = u.rootSettle.dur / 2;
  world.tickRootSettle(u);
  check("…half way through, it is half way there", [Math.round(u.x), Math.round(u.y)], [792, 768]);
  // 0 → 3π/2 the SHORT way is a quarter turn backwards, so half of it is -π/4.
  check("…and half way round, the short way", Math.round(u.facing * 1000) / 1000, -0.785);
  settled(u);
  check("…and lands exactly on the site", [Math.round(u.x), Math.round(u.y)], [768, 768]);
  check("…facing the way it was raised", u.facing, u.builtFacing);
  check("…with the gesture spent", u.rootSettle, null);
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
  settled(u);
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
  settled(u);
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
  settled(u);
  check("…now rooted", u.uprooted, false);
  check("…with its 3x3 footprint back", u.footprint, 3);
}

// --- an Ancient carries its BUILDING footprint with it ---------------------------------
//
// The one that actually bites. A structure's block is not the `footprint` above — that is the
// walker's own body — it is a stamped Footprint on the grid (setPathStamp), and it is not part
// of the reservation system at all. An Ancient that kept it while it walked was inside its own
// wall: every path out failed and planting again was refused by the hole it had left, so the
// thing pulled its roots up and then stood there for the rest of the match.
{
  // A real 4x4 stamp, laid on the grid exactly as spawnUnit lays a building's.
  const fp = { w: 4, h: 4, blocked: new Array(16).fill(true), buildBlocked: new Array(16).fill(true) };
  const u = ancient("Aro1", { footprint: 4, x: 512, y: 512, prevX: 512, prevY: 512 });
  world.setPathStamp(u.id, fp, 512, 512);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) grid.block(16 - 2 + x, 16 - 2 + y);

  world.toggleRoot(u);
  settled(u);
  check("uprooting lifts the stamped building footprint", u.pathStamp, null);
  check("…and keeps it for the walk", !!u.rootedStamp, true);
  check("…leaving ground the Ancient can path over", grid.walkable(16, 16), true);

  check("planting lays it back down", world.toggleRoot(u), true);
  settled(u);
  check("…on the build grid, where a fresh one would go", [u.x % 64, u.y % 64], [0, 0]);
  check("…blocking again", grid.walkable(16, 16), false);
  check("…and carrying nothing", u.rootedStamp, null);
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
