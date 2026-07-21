// Headless check of the MINIMAP queries (docs/multiplayer.md Phase E items 3 and 3b).
//
// Item 3 changed `dots()`/`creepCamps()` from walking the local client's render records to
// walking `sim.units`, and shipped with no test at all: they lived on `RtsController`, `rts.ts`
// imports `mdx-m3-viewer`, and the sim build cannot load it. The browser check proved only
// "nothing regressed", because on Echo Isles every model has loaded by the time the client is
// in-game, so "units I drew" and "units that exist" are the same set and the change is invisible.
//
// Item 3b moved them to `src/game/minimapView.ts` precisely so the property that MATTERS can be
// pinned: these answer for a viewpoint whose client rendered nothing. That is the case the whole
// move exists for and the one a single running client can never show.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { VisionSet } = require(join(REPO, ".sim-build", "src", "game", "viewpoint.js"));
const { minimapDots, hiddenFor, CreepCamps, minimapIcons, ICON_GOLD_MINE, ICON_NEUTRAL_BUILDING, dotsFromSnapshot } = require(join(REPO, ".sim-build", "src", "game", "minimapView.js"));
const { snapshotFor } = require(join(REPO, ".sim-build", "src", "game", "snapshot.js"));
const { SnapshotIndex } = require(join(REPO, ".sim-build", "src", "game", "renderView.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const noAlliances = { sharesVisionWith: () => false, coAllied: () => false };
/** A unit with every flag hiddenFor() reads, defaulted to "plainly visible". */
const unit = (o) => ({
  id: 0, owner: 0, team: 0, x: 0, y: 0, hp: 100, sight: 1400,
  inMine: false, insideBuild: false, inBurrow: false, devouredBy: 0, vanished: false,
  neutralPassive: false, invisible: false, cloaked: false, isCreep: false, level: 0,
  guardX: 0, guardY: 0, flying: false, building: null, ...o,
});

// A world seeded with units, and viewpoints that have never rendered anything — which is the
// point: no render records exist here at all, because there is no renderer.
function worldOf(units) {
  const m = new Map();
  for (const u of units) m.set(u.id, u);
  return { units: m, isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
}

console.log("the minimap answers for a viewpoint that has rendered nothing");
{
  const world = worldOf([
    unit({ id: 1, owner: 0, team: 0, x: 100, y: 100 }),
    unit({ id: 2, owner: 1, team: 1, x: 900, y: 900 }),
  ]);
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  set.setStartFog("revealall"); // take fog out of the question; team membership is what is under test

  const p0 = minimapDots(world, set.viewpointFor(0));
  const p1 = minimapDots(world, set.viewpointFor(1));
  // This is the assertion item 3 could not make. Player 1's dots are computed on a machine that
  // drew nothing for player 1 — under the old `this.entries` walk this list was empty.
  check("player 0 sees both units", p0.length, 2);
  check("player 1 sees both units too (revealed)", p1.length, 2);
  check("…and the owners come back, not just positions", p0.map((d) => d.owner).sort(), [0, 1]);
}

console.log("\nyour own team survives the fog; the enemy does not");
{
  const world = worldOf([
    unit({ id: 1, owner: 0, team: 0, x: 100, y: 100 }),
    unit({ id: 2, owner: 1, team: 1, x: 900, y: 900 }),
  ]);
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  // No reveal, no rebuild: nothing is currently visible to anyone.
  const p0 = minimapDots(world, set.viewpointFor(0));
  check("player 0 still sees its OWN unit through the dark", p0.map((d) => d.owner), [0]);
  const p1 = minimapDots(world, set.viewpointFor(1));
  check("and player 1 sees only its own", p1.map((d) => d.owner), [1]);
}

// FIXED (docs/multiplayer.md Phase E item 3c), and the fix waited on a measurement rather than
// on an argument. `Viewpoint.fogHides` already returns false for your own team, so the
// `|| u.team === vp.team` clause in minimapDots was never about fog — the only thing it could
// override was the VIEWPOINT-INDEPENDENT half of hiddenFor, which meant a friendly unit inside a
// gold mine or a burrow painted a dot at the spot it walked in from.
//
// The developer drove the real 1.27a client and reported: no dot. So `isOffField` is now tested
// first and on its own, and the own-team clause does only the fog job it reads like.
console.log("\na unit that is off the field gets no dot, not even its owner's (item 3c)");
{
  const world = worldOf([
    unit({ id: 1, owner: 0, team: 0, inBurrow: true }),
    unit({ id: 2, owner: 0, team: 0, inMine: true }),
    unit({ id: 3, owner: 1, team: 1, inBurrow: true }),
    unit({ id: 4, owner: 0, team: 0, insideBuild: true }),
    unit({ id: 5, owner: 0, team: 0, devouredBy: 9 }),
    unit({ id: 6, owner: 0, team: 0, vanished: true }),
    unit({ id: 7, owner: 0, team: 0, x: 400, y: 400 }), // plainly on the field — the control
  ]);
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  const vp = set.viewpointFor(0);
  check("hiddenFor still says the burrowed friendly is hidden", hiddenFor(vp, world.units.get(1)), true);
  // Measured against the real client: a mining peasant's dot disappears while it is inside and
  // comes back when it pops out. Same for every other way of being off the field.
  check("all five off-field friendlies are gone from the minimap", minimapDots(world, vp).length, 1);
  check("…and the one left is the unit actually standing on the map", minimapDots(world, vp)[0].x, 400);
  check("an ENEMY inside a burrow gets no dot either", minimapDots(world, vp).every((d) => d.owner === 0), true);
}

console.log("\nunits nobody can see are hidden for everyone, whatever the fog says");
{
  const set = new VisionSet(worldOf([]), noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }]);
  set.setStartFog("revealall");
  const vp = set.viewpointFor(0);
  // These five are viewpoint-INDEPENDENT: a unit in a mine or a burrow is off the map for
  // everybody, and conflating them with fog is what made Entry.hidden unusable for anyone else.
  for (const flag of ["inMine", "insideBuild", "inBurrow", "vanished"]) {
    check(`${flag} hides it even under reveal-all`, hiddenFor(vp, unit({ [flag]: true })), true);
  }
  check("devoured hides it too", hiddenFor(vp, unit({ devouredBy: 7 })), true);
  check("…and a plain unit is not hidden", hiddenFor(vp, unit({})), false);
}

console.log("\nneutral-passive furniture never gets a dot");
{
  const world = worldOf([
    unit({ id: 1, owner: 0, team: 0 }),
    unit({ id: 2, owner: 15, team: 15, neutralPassive: true, x: 500, y: 500 }),
  ]);
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }]);
  set.setStartFog("revealall");
  check("the shop is not a dot", minimapDots(world, set.viewpointFor(0)).length, 1);
}

console.log("\ncreep camps cluster by guard post and step aside when seen");
{
  // Two creeps 200 apart (one camp, CAMP_LINK is 600) and a third 5000 away (its own camp).
  const world = worldOf([
    unit({ id: 1, isCreep: true, level: 3, x: 100, y: 100, guardX: 100, guardY: 100, owner: 12, team: -1 }),
    unit({ id: 2, isCreep: true, level: 4, x: 300, y: 100, guardX: 300, guardY: 100, owner: 12, team: -1 }),
    unit({ id: 3, isCreep: true, level: 9, x: 5000, y: 5000, guardX: 5000, guardY: 5000, owner: 12, team: -1 }),
  ]);
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 8192, 8192);
  set.seat([{ player: 0, team: 0 }]);
  const vp = set.viewpointFor(0);
  const camps = new CreepCamps(world);

  const m = camps.markers(vp).sort((a, b) => a.x - b.x);
  check("two camps, not three creeps", m.length, 2);
  check("the near pair combined their levels", m[0].level, 7);
  check("…and the marker sits between their guard posts", m[0].x, 200);
  check("the lone creep is its own camp", m[1].level, 9);

  // A camp with a creep you can SEE yields — the creep speaks for itself, and dots() is already
  // drawing it. Showing both at once is the bug this rule exists to prevent.
  set.setStartFog("revealall");
  check("a visible camp shows no marker", camps.markers(vp).length, 0);

  // Killing the whole camp removes it for good.
  set.setStartFog(null);
  world.units.delete(1);
  world.units.delete(2);
  check("a cleared camp is gone", camps.markers(vp).map((c) => c.level), [9]);
}

// Minimap GLYPHS (item 4). The open question Phase D left was whether these should be fog-gated
// at all. Somebody checked the running 1.27a client: they are not — both draw over pitch-black
// unexplored ground in a fresh melee game, which is how you pick an expansion before scouting.
// So the check below asserts the ABSENCE of a gate deliberately. If a future change adds one,
// this goes red and whoever added it has to justify it against the real game rather than intuition.
console.log("\nminimap glyphs are NOT fog-gated (verified against the real 1.27a client)");
{
  const world = {
    ...worldOf([
      unit({ id: 1, owner: 15, team: 15, neutralPassive: true, building: {}, typeId: "ntav", x: 700, y: 700 }),
      unit({ id: 2, owner: 15, team: 15, neutralPassive: true, building: {}, typeId: "nhut", x: 800, y: 800 }),
      unit({ id: 3, owner: 1, team: 1, building: {}, typeId: "hkee", x: 900, y: 900 }),
    ]),
    mines: new Map([[1, { x: 300, y: 300 }]]),
  };
  const registry = { get: (id) => ({ ntav: { minimapIcon: true }, nhut: { minimapIcon: false }, hkee: { minimapIcon: true } })[id] };
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }]);
  // Nothing explored, nothing revealed, no rebuild — the fog is as black as it gets.
  const icons = minimapIcons(world, registry);
  check("the gold mine draws on unexplored ground", icons.filter((i) => i.icon === ICON_GOLD_MINE).length, 1);
  check("the tavern draws too (nbmmIcon set)", icons.filter((i) => i.icon === ICON_NEUTRAL_BUILDING).length, 1);
  check("the murloc hut does not (no nbmmIcon)", icons.some((i) => i.x === 800), false);
  check("an ENEMY building is not a neutral glyph", icons.some((i) => i.x === 900), false);
}

// ---------------------------------------------------------------------------------------
// Item 10c: a CLIENT draws its minimap dots from the AoI snapshot it was sent, not from its
// own sim + local fog. The load-bearing property is that the two produce the SAME dots for the
// same viewer — a client renders the authority's answer, and byte-for-byte it is the host's.
// ---------------------------------------------------------------------------------------

/** A SnapshotWorld from the same units (snapshotFor needs mines/items/time; the minimap ones
 *  don't matter to dots). */
const snapWorld = (units) => {
  const m = new Map();
  for (const u of units) m.set(u.id, u);
  return { units: m, mines: new Map(), items: new Map(), timeOfDay: 12, dawnDusk: true };
};

console.log("\nthe client's snapshot dots equal the host's sim+fog dots — revealed");
{
  const units = [
    unit({ id: 1, owner: 0, team: 0, x: 100, y: 100 }), // own — a dot
    unit({ id: 2, owner: 0, team: 0, x: 200, y: 200, inMine: true }), // own but off-field — no dot
    unit({ id: 3, owner: 15, team: 15, neutralPassive: true, x: 300, y: 300 }), // furniture — no dot
    unit({ id: 4, owner: 1, team: 1, x: 400, y: 400 }), // an enemy in the open — a dot
  ];
  const set = new VisionSet(worldOf(units), noAlliances, () => [], 0, 0, 1024, 1024);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  set.setStartFog("revealall"); // everything visible: the snapshot carries all four
  const vp = set.viewpointFor(0);

  const fromSim = minimapDots(worldOf(units), vp);
  const fromSnap = dotsFromSnapshot(snapshotFor(snapWorld(units), vp, 0, 1).units);
  // THE check. If dotsFromSnapshot re-applied fog it would need a viewpoint it does not have;
  // the bugs it CAN have are dropping the neutral-passive or the off-field skip, and either
  // puts a dot in the snapshot list that the sim list does not have.
  check("client dots match host dots exactly", fromSnap, fromSim);
  check("and it is the two on-field, non-furniture units", fromSim.map((d) => `${d.x}:${d.owner}`), ["100:0", "400:1"]);
}

console.log("the client is shown no more than the authority sent — fogged");
{
  const units = [
    unit({ id: 1, owner: 0, team: 0, x: 100, y: 100 }), // own — always on the minimap
    unit({ id: 2, owner: 1, team: 1, x: 5000, y: 5000 }), // enemy far in the black — fogged
    unit({ id: 3, owner: 1, team: 1, building: { constructionLeft: 0 }, x: 6000, y: 6000 }), // never-seen enemy building
  ];
  const set = new VisionSet(worldOf(units), noAlliances, () => [], 0, 0, 8192, 8192);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  // No revealall, no rebuild: the fog is black, so both the fogged enemy and the unseen
  // building are dropped by the sim minimap AND are absent from the snapshot entirely.
  const vp = set.viewpointFor(0);
  const fromSim = minimapDots(worldOf(units), vp);
  const fromSnap = dotsFromSnapshot(snapshotFor(snapWorld(units), vp, 0, 1).units);
  check("a fogged enemy is a dot on neither side", fromSnap, fromSim);
  check("only the own unit shows", fromSim.map((d) => d.owner), [0]);
  // And the maphack guard: the snapshot the client draws from never CONTAINED the fogged
  // enemy, so no client-side code — correct or tampered — can turn it into a dot.
  const sent = snapshotFor(snapWorld(units), vp, 0, 1).units.map((u) => u.id);
  check("the fogged units were never sent", [sent.includes(2), sent.includes(3)], [false, false]);
}

// Item 10c-2c: a CLIENT decides whether to draw a MODEL from the payload it was sent, not from
// its own fog grid -- the same rule as the dots above, applied to the units themselves. The
// property is again an EQUALITY, and it is the only thing that makes the switch safe: if
// `hiddenFromSnapshot` and `hiddenFor` ever disagree, a client either loses a unit the host is
// drawing or draws one the host is hiding, and the second of those is a maphack.
// ---------------------------------------------------------------------------------------

console.log("\nthe client hides exactly what the host's fog hides");
{
  const units = [
    unit({ id: 1, owner: 0, team: 0, x: 100, y: 100 }), // own, in the open
    unit({ id: 2, owner: 0, team: 0, x: 150, y: 150, inMine: true }), // own but off-field: SENT, still not drawn
    unit({ id: 3, owner: 1, team: 1, x: 5000, y: 5000 }), // enemy in the black: never sent
    unit({ id: 4, owner: 1, team: 1, x: 200, y: 200 }), // enemy under our eyes
    unit({ id: 5, owner: 1, team: 1, x: 260, y: 260, invisible: true }), // undetected: never sent
    unit({ id: 6, owner: 15, team: 15, neutralPassive: true, x: 300, y: 300 }), // furniture, in sight
  ];
  const set = new VisionSet(worldOf(units), noAlliances, () => [], 0, 0, 8192, 8192);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  const vp = set.viewpointFor(0);
  vp.rebuild([]);

  const idx = new SnapshotIndex();
  idx.update(snapshotFor(snapWorld(units), vp, 0, 1));

  // THE check. The host asks its grid; the client asks the payload; the frame is the same.
  check("client hides exactly what the host hides", units.map((u) => idx.hidden(u.id)), units.map((u) => hiddenFor(vp, u)));
  // ...and the equality is not the trivial one. Without this line a `hidden()` that always
  // returned true would pass above only if `hiddenFor` also did -- pin the actual answers.
  check("and that is a real mix, not hide-everything", units.map((u) => hiddenFor(vp, u)), [false, true, true, false, true, false]);
  // The off-field case is the one that cannot ride on absence: the snapshot deliberately SENDS
  // a mining worker to its own owner (a Burrow has to be able to list its garrison), so the
  // client is holding the record and must still refuse to draw it.
  check("the mining worker WAS sent, and is still not drawn", [idx.unit(2) !== undefined, idx.hidden(2)], [true, true]);
  // The maphack guard, restated for models: the fogged and the invisible are not in the payload
  // at all, so no client-side code -- correct or tampered -- can put them on screen.
  check("the fogged and the invisible were never sent", [idx.unit(3), idx.unit(5)], [undefined, undefined]);
}

console.log("a building you have SEEN keeps its image on the client too");
{
  // WC3 leaves the last-seen structure standing in the fog, which is the case `fogHides`
  // deliberately answers "draw" to -- and the reason the send rule is three-valued. A client
  // that treated "not currently visible" as "do not draw" would delete enemy buildings off the
  // player's screen the moment a scout walked away.
  const scout = unit({ id: 1, owner: 0, team: 0, x: 200, y: 200 });
  const hall = unit({ id: 2, owner: 1, team: 1, x: 300, y: 300, building: { constructionLeft: 0 } });
  const units = [scout, hall];
  const set = new VisionSet(worldOf(units), noAlliances, () => [], 0, 0, 8192, 8192);
  set.seat([{ player: 0, team: 0 }, { player: 1, team: 1 }]);
  const vp = set.viewpointFor(0);
  vp.rebuild([]); // the scout is standing next to it: seen AND visible
  const watched = new SnapshotIndex();
  watched.update(snapshotFor(snapWorld(units), vp, 0, 1));
  check("watched: drawn on both sides, off a LIVE record", [hiddenFor(vp, hall), watched.hidden(2), watched.unit(2).remembered], [false, false, false]);

  scout.x = 7000; // walk away
  scout.y = 7000;
  vp.rebuild([]); // seen, no longer visible -- remembered
  const idx = new SnapshotIndex();
  idx.update(snapshotFor(snapWorld(units), vp, 0, 1));
  check("remembered: the host still draws it", hiddenFor(vp, hall), false);
  check("...and so does the client, off a redacted record", [idx.hidden(2), idx.unit(2).remembered, idx.unit(2).hp], [false, true, 0]);
}

console.log(failed ? `\nminimap: ${failed} FAILED` : "\nminimap: all checks passed");
process.exit(failed ? 1 : 0);
