// Headless check of the terrain camera cull (docs/terrain-culling.md). The cull is verified in
// PIXELS in the running game — that is the test that matters, because "invisible" is a claim
// about what is drawn — but the arithmetic under it is exactly the kind of thing a screenshot
// cannot see: which cells a given frustum keeps, that a run is a contiguous slice of the
// row-major buffers, and that HEIGHT is part of the decision. Those are pinned here.
//
// The frustums below are axis-aligned boxes rather than real camera frustums, which is the point:
// a box has an exact answer, so the expected runs can be written down rather than eyeballed.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const { TerrainCull } = require(join(REPO, ".sim-build", "src", "render", "terrainCull.js"));

const CELL = 128;

/** A flat square map, `cells` cells on a side, its origin at the world origin. `raise(x, y)`
 *  gives a corner's height in CELL units so a test can put a cliff in it. */
function terrain(cells, raise = () => 0) {
  const width = cells + 1;
  const corners = [];
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      // cornerHeight() is groundHeight + layerHeight - 2 + rampAdjust, so a groundHeight of 2
      // with nothing else is a corner at world Z 0.
      corners.push({ groundHeight: 2 + raise(x, y), waterHeight: 0, layerHeight: 0, rampAdjust: 0,
        groundTexture: 0, cliffTexture: 0, ramp: false, water: false, boundary: false, mapEdge: false });
    }
  }
  return { width, height: width, centerOffset: [0, 0], tileset: "L", groundTilesets: [], cliffTilesets: [], corners };
}

/** A frustum that is just an axis-aligned box: inside is `a·x + b·y + c·z + d >= 0` for all six,
 *  which is the same convention mdx-m3-viewer's camera unpacks its planes into. */
function box(x0, x1, y0, y1, z0, z1) {
  return { planes: [
    [1, 0, 0, -x0], [-1, 0, 0, x1],
    [0, 1, 0, -y0], [0, -1, 0, y1],
    [0, 0, 1, -z0], [0, 0, -1, z1],
  ] };
}

/** The runs as (first, count) pairs, for readability in a failure message. */
function pairs(cull) {
  const r = cull.runs();
  const out = [];
  for (let i = 0; i < r.length; i += 2) out.push([r[i], r[i + 1]]);
  return out;
}

console.log("a box over one block keeps that block's cells and nothing else");
{
  const cull = new TerrainCull(terrain(32)); // 32x32 cells, blocks of 8
  cull.update(box(0, 1000, 0, 1000, -1000, 1000)); // covers cells 0..7 in both axes = block (0,0)
  check("one run per cell row of the block", pairs(cull).length, 8);
  // Row-major: row y starts at y * 32, and the run is the block's eight columns.
  check("runs are the block's rows", pairs(cull), [[0, 8], [32, 8], [64, 8], [96, 8], [128, 8], [160, 8], [192, 8], [224, 8]]);
  check("cells drawn", cull.visibleCells, 64);
  check("…out of the whole map", cull.totalCells, 32 * 32);
}

console.log("\na box past the edge of the map keeps nothing");
{
  const cull = new TerrainCull(terrain(32));
  cull.update(box(100000, 200000, 0, 1000, -1000, 1000));
  check("no runs", pairs(cull), []);
  check("no cells", cull.visibleCells, 0);
}

console.log("\na box across two blocks is ONE run per row, not two");
{
  // Cells 0..15 across = block columns 0 and 1. A row of a run must stay contiguous, or the
  // whole "a run is a slice of the buffers" idea is lost.
  const cull = new TerrainCull(terrain(32));
  cull.update(box(0, 2000, 0, 500, -1000, 1000));
  check("one run per row, sixteen wide", pairs(cull).slice(0, 3), [[0, 16], [32, 16], [64, 16]]);
}

console.log("\nheight is part of the decision, not just the footprint");
{
  // A slab of view well ABOVE the ground: a flat map has nothing in it…
  const flat = new TerrainCull(terrain(32));
  flat.update(box(0, 1000, 0, 1000, 900, 1200));
  check("flat ground is below the slab", flat.visibleCells, 0);
  // …but raise the corners of block (0,0) by eight cells and the same slab now cuts through it.
  const cliff = new TerrainCull(terrain(32, (x, y) => (x <= 8 && y <= 8 ? 8 : 0)));
  cliff.update(box(0, 1000, 0, 1000, 900, 1200));
  check("a cliff reaches into it", cliff.visibleCells, 64);
}

console.log("\nthe two switches the cull is inspected with");
{
  const cull = new TerrainCull(terrain(32));
  cull.update(box(0, 1000, 0, 1000, -1000, 1000));
  const before = pairs(cull);
  // holdRuns: the runs stop following the camera, which is how you fly out and SEE the cull.
  cull.holdRuns = true;
  cull.update(box(2000, 3000, 2000, 3000, -1000, 1000));
  check("held runs ignore the new camera", pairs(cull), before);
  cull.holdRuns = false;
  // enabled: no runs at all means the patched viewer draws the whole map, which is what the
  // pixel comparison in docs/terrain-culling.md switches between.
  cull.enabled = false;
  check("disabled hands back an empty list", pairs(cull), []);
  cull.enabled = true;
  check("…and re-enabling brings the same runs back", pairs(cull), before);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
