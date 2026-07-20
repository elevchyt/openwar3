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

console.log(failed ? `\nvision: ${failed} FAILED` : "\nvision: all checks passed");
process.exit(failed ? 1 : 0);
