// Headless check that terrain memory and eyewitness memory are two different facts.
//
// They were one bitmap. Nothing caught it, because every path that set one set the other —
// until the "start explored" lobby option handed out knowledge of the ground with nobody
// looking at it. Then `exploreAll()` marked every cell explored, the renderer's rule for a
// remembered BUILDING was "is this cell explored", and every opponent's town hall was on the
// minimap from turn 0 of a start-explored match. Found by booting two clients on Echo Isles
// (docs/multiplayer.md Phase D item 1), which is the only reason it was found at all: fog is
// invisible to a test that does not ask about it. So this file asks.
//
// WC3's own three fogstates name the distinction — FOG_OF_WAR_FOGGED is "explored, not seen".
// A building shows through fog because you REMEMBER it, not because the tile is grey.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { VisionMap, FogState } = require(join(REPO, ".sim-build", "src", "sim", "vision.js"));

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

// A 1024x1024 world at 64 units/cell = 16x16 cells. Origin 0 keeps world==cell*64.
const map = () => new VisionMap(0, 0, 1024, 1024);
const CELL = 64;
const cellOf = (w) => Math.floor(w / CELL);

console.log("a cell nobody has looked at");
{
  const v = map();
  check("is not explored", v.cellState(2, 2), FogState.Unexplored);
  check("has not been seen", v.hasSeen(2, 2), false);
}

console.log("\nreal sight explores AND sees");
{
  const v = map();
  v.beginFrame();
  v.reveal(128, 128, 200); // no height field installed → plain radial circle
  const [cx, cy] = [cellOf(128), cellOf(128)];
  check("the cell is Visible now", v.stateAt(128, 128), FogState.Visible);
  check("…and counts as seen", v.hasSeen(cx, cy), true);
  // Sight goes away; memory does not.
  v.beginFrame();
  check("after sight lapses it is Explored, not Visible", v.stateAt(128, 128), FogState.Explored);
  check("…and STILL counts as seen — a building stays remembered", v.hasSeen(cx, cy), true);
}

console.log("\nstart-explored gives terrain, not eyes  (the bug)");
{
  const v = map();
  v.exploreAll();
  check("far ground is Explored — grey, not black", v.stateAt(900, 900), FogState.Explored);
  check("but it was never SEEN, so no building is remembered there", v.hasSeen(cellOf(900), cellOf(900)), false);
  // The local player's own corner is no different until something of theirs looks at it.
  v.beginFrame();
  v.reveal(128, 128, 200);
  check("the corner a unit stands in IS seen", v.hasSeen(cellOf(128), cellOf(128)), true);
  check("the far corner still is not", v.hasSeen(cellOf(900), cellOf(900)), false);
}

console.log("\nfog modifiers follow the same split");
{
  const v = map();
  // FOGGED — "explored, not seen". Grey terrain, no memory of what stands on it.
  v.stampRect(0, 0, 256, 256, FogState.Explored);
  check("a FOGGED stamp explores", v.stateAt(128, 128), FogState.Explored);
  check("…and does NOT grant sight of what stands there", v.hasSeen(cellOf(128), cellOf(128)), false);

  // VISIBLE — real eyes handed out by a script (the TD showing you its whole maze).
  const w = map();
  w.stampRect(0, 0, 256, 256, FogState.Visible);
  check("a VISIBLE stamp does grant it", w.hasSeen(cellOf(128), cellOf(128)), true);

  // MASKED wipes both — re-masked ground goes properly black and forgets its buildings.
  w.stampRect(0, 0, 256, 256, FogState.Unexplored);
  check("a MASKED stamp blacks the ground again", w.stateAt(128, 128), FogState.Unexplored);
  check("…and forgets the buildings on it", w.hasSeen(cellOf(128), cellOf(128)), false);
}

console.log("\niseedeadpeople still shows everything");
{
  const v = map();
  v.setRevealAll(true);
  check("reveal-all reports unseen ground as seen", v.hasSeen(14, 14), true);
  v.setRevealAll(false);
  check("…and toggling it back off restores the truth", v.hasSeen(14, 14), false);
}

// --- the viewpoint registry (docs/multiplayer.md Phase D item 3) ----------------------
//
// The hazard this section exists for: mapViewer installs the fog's height field and tree
// blockers while the terrain loads, a good half-second BEFORE setLocalPlayer says who is
// playing. A viewpoint minted after that moment and handed out bare would see through every
// cliff and treeline on the map. So the SET replays world setup onto whatever it creates.
const { VisionSet } = require(join(REPO, ".sim-build", "src", "game", "viewpoint.js"));

const noWorld = { units: new Map(), isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
const noAlliances = { sharesVisionWith: () => false, coAllied: () => false };
const trees = [{ x: 320, y: 320, blockRadius: 64 }];
const setOf = () => new VisionSet(noWorld, noAlliances, () => trees, 0, 0, 1024, 1024);

console.log("\na viewpoint asked for twice is the same viewpoint");
{
  const set = setOf();
  check("same object back", set.viewpointFor(3) === set.viewpointFor(3), true);
  check("a different slot is a different object", set.viewpointFor(3) === set.viewpointFor(4), false);
}

console.log("\nworld setup reaches viewpoints created AFTER it  (the boot-order trap)");
{
  const set = setOf();
  set.initBlockers(() => 0); // flat terrain, but the field is now installed
  set.setStartFog("explored");
  // …now the lobby finally says who we are, and a fresh viewpoint is minted.
  const late = set.viewpointFor(7);
  check("the late viewpoint got the lobby's start-explored", late.vision.stateAt(900, 900), FogState.Explored);
  check("…and is still not SEEN there", late.vision.hasSeen(cellOf(900), cellOf(900)), false);
}

console.log("\nreveal-all is set both ways, so clearing it clears it");
{
  const set = setOf();
  const vp = set.viewpointFor(0);
  set.setStartFog("revealall");
  check("revealall on", vp.revealed, true);
  set.setStartFog(null);
  check("…and off again", vp.revealed, false);
}

console.log("\neach viewpoint keeps its own rebuild clock");
{
  const set = setOf();
  const vp = set.viewpointFor(0);
  check("the first tick rebuilds (accum starts above the interval)", set.tick(0.016, []).length, 1);
  check("the very next frame does not", set.tick(0.016, []).length, 0);
  check("…nor the one after", set.tick(0.016, []).length, 0);
  let rebuilt = 0;
  for (let i = 0; i < 8; i++) rebuilt += set.tick(0.016, []).length;
  check("but ~0.1s later it does", rebuilt, 1);
  check("and it is the viewpoint we hold", set.tick(1, []).includes(vp), true);
}

console.log("\nexposure and one-shots resolve per RECIPIENT, not per 'local'");
{
  // Two players on two teams. Slot 0's viewpoint exists; slot 1's does not yet.
  const units = new Map([
    [1, { id: 1, owner: 0, team: 0, x: 0, y: 0 }],
    [2, { id: 2, owner: 1, team: 1, x: 900, y: 900 }],
  ]);
  const world = { units, isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  const zero = set.viewpointFor(0);
  zero.setTeam(0);

  const victim = units.get(2); // player 1's unit, far away in the dark

  check("player 1's unit is hidden from player 0 to begin with", zero.fogHides(victim), true);
  // CripplePlayer(1, [0], true): reveal player 1's units TO player 0.
  set.setExposed(0, 1, true);
  check("…and exposed once player 0 is a recipient", zero.fogHides(victim), false);
  set.setExposed(0, 1, false);
  check("…and hidden again when the cripple clears", zero.fogHides(victim), true);

  // The recipient that has no viewpoint yet must still inherit it when one is minted —
  // otherwise recording exposure would have to conjure twelve grids to hold a flag.
  set.setExposed(5, 1, true);
  const late = set.viewpointFor(5);
  late.setTeam(5);
  check("a viewpoint created later inherits its standing exposure", late.fogHides(victim), false);
  check("…and a bystander viewpoint does not", set.viewpointFor(6).fogHides(victim), true);
}

console.log("\na one-shot SetFogState reaches whoever renders that player's fog");
{
  const world = { units: new Map(), isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  const zero = set.viewpointFor(0);
  const one = set.viewpointFor(1);
  set.stampFor(0, { kind: "rect", minX: 0, minY: 0, maxX: 256, maxY: 256 }, FogState.Visible);
  check("the owning player's grid got it", zero.vision.hasSeen(cellOf(128), cellOf(128)), true);
  check("…and an unrelated player's did not", one.vision.hasSeen(cellOf(128), cellOf(128)), false);
}

console.log("\nevery team gets asked of its OWN grid  (item 7)");
{
  const units = new Map([
    [1, { id: 1, owner: 0, team: 0, x: 100, y: 100 }],
    [2, { id: 2, owner: -1, team: 9, x: 900, y: 900 }], // a creep, far away
  ]);
  const world = { units, isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  const mine = set.viewpointFor(0);
  mine.setTeam(0);

  check("a player's team is answered by that player's own viewpoint", set.viewpointForTeam(0), mine);
  const creeps = set.viewpointForTeam(9);
  check("…and a team with no player slot gets its own", creeps === mine, false);
  check("a team-only viewpoint carries no player slot", creeps.player, -1);
  check("asking twice does not mint a second", set.viewpointForTeam(9), creeps);

  // Rebuild everything, then ask what each side can see.
  set.tick(1, []);
  check("player 0 sees where its own unit stands", mine.vision.stateAt(100, 100), FogState.Visible);
  check("…and not where the creep stands", mine.vision.stateAt(900, 900) === FogState.Visible, false);
  check("the creep sees its own ground", creeps.vision.stateAt(900, 900), FogState.Visible);
  check("…and not the player's base", creeps.vision.stateAt(100, 100) === FogState.Visible, false);

  // The whole point: the two grids disagree. Under the old code every non-local team
  // short-circuited to "sees everything", so the creep's answer here was always true.
  check("the creep grid does NOT report the player's base visible", creeps.vision.stateAt(100, 100) === FogState.Visible, false);
}

console.log("\na team is never rebuilt twice");
{
  const units = new Map([[1, { id: 1, owner: 0, team: 4, x: 100, y: 100 }]]);
  const world = { units, isDay: true, activeAttackReveals: () => [], teamDetects: () => false };
  const set = new VisionSet(world, noAlliances, () => [], 0, 0, 1024, 1024);
  // A team-only viewpoint appears FIRST (the sim asked before the lobby seated anyone)…
  set.viewpointForTeam(4);
  check("one viewpoint so far", [...set.all()].length, 1);
  // …and then a player viewpoint takes that team over.
  set.viewpointFor(0).setTeam(4);
  check("the team-only one steps aside rather than double-rebuilding", [...set.all()].length, 1);
  check("and the survivor is the player's", [...set.all()][0].player, 0);
  check("viewpointForTeam now returns the player's", set.viewpointForTeam(4).player, 0);
}

// --- seating every slot at match start (docs/multiplayer.md Phase E item 2) ---------------
//
// The bug this exists for is not "a viewpoint is missing" — `viewpointFor` would mint one on
// demand anyway. It is that a lazily minted viewpoint has to GUESS its team: `teamOfPlayer`
// scans the world for a unit that player owns and falls back to the SLOT NUMBER. Before the
// first unit is seeded there is nothing to scan, so every player silently lands on a team of
// their own — and two ALLIED players on one team stop sharing vision with each other, which is
// the whole reason teams exist. Slot and team are equal in a plain 1v1, which is exactly why
// this has to be tested with a seating where they are not.
console.log("\nseating states the lobby's team instead of guessing it from units");
{
  const set = setOf();
  // Players 0 and 3 allied on team 0; player 5 alone on team 1. No units exist yet.
  set.seat([{ player: 0, team: 0 }, { player: 3, team: 0 }, { player: 5, team: 1 }]);
  check("player 3 is on the lobby's team, not its slot number", set.viewpointFor(3).team, 0);
  check("player 5 likewise", set.viewpointFor(5).team, 1);
  // The consequence that matters: seesFor is team membership, so the ally must be included.
  check("allies render each other's fog", set.viewpointFor(0).seesFor(3), true);
  check("…and the opponent's is not rendered", set.viewpointFor(0).seesFor(5), false);
  check("every seat exists from tick 0", [...set.all()].length, 3);
}

console.log("\nseating is idempotent and restates rather than duplicating");
{
  const set = setOf();
  const first = set.viewpointFor(2); // minted early, guessing team 2
  set.seat([{ player: 2, team: 0 }]);
  check("the same viewpoint object is kept", set.viewpointFor(2) === first, true);
  check("…and its team is corrected to the lobby's", first.team, 0);
  set.seat([{ player: 2, team: 0 }]);
  check("seating twice does not add a second", [...set.all()].length, 1);
}

console.log(failed ? `\nvision: ${failed} FAILED` : "\nvision: all checks passed");
process.exit(failed ? 1 : 0);
