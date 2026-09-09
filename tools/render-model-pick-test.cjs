// The selection hit test's arithmetic — ray vs a model's own COLLISIONSHAPE volumes.
//
// The claim this pins is not "a click works" (that is a screenshot's job) but that the ray
// meets the shapes the artist actually put in the model, where they put them. So the fixtures
// below are REAL shapes read out of the local 1.30.4 install with the MDX parser, transcribed
// here with the model they came from — a Footman's two spheres, the Farm's box, the Knight's
// box + sphere (docs/selection.md has the survey).
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

const { modelPickVolumes, rayVolume } = require(join(REPO, ".sim-build", "src", "render", "modelCollision.js"));

/** A column-major mat4 for "stand this model at (x,y,z), facing along +X, scaled by s". */
function place(x, y, z, s = 1) {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
}
/** ...and one that also turns it a quarter turn about Z, to prove a box is ORIENTED. */
function placeTurned(x, y, z, s = 1) {
  return [0, s, 0, 0, -s, 0, 0, 0, 0, 0, s, 0, x, y, z, 1];
}

/** A stand-in instance: every shape sits on its own node, all sharing one placement. */
function instance(shapes, matrix) {
  return {
    nodes: shapes.map(() => ({ worldMatrix: matrix })),
    model: { collisionShapes: shapes.map((s, i) => ({ ...s, index: i })) },
  };
}

// Units\Human\Footman\Footman.mdx — two collision spheres, head and chest.
const FOOTMAN = [
  { type: 2, vertices: [[5.3, 0, 63.2]], boundsRadius: 38.076 },
  { type: 2, vertices: [[3.2, 0, 22.8]], boundsRadius: 38.076 },
];
// Buildings\Human\Farm\Farm.mdx — one collision BOX, min corner then max corner.
const FARM = [{ type: 0, vertices: [[-56.6, -64.1, 0], [56.6, 64.1, 113.1]], boundsRadius: 0 }];
// Units\Human\Knight\Knight.mdx — a box for the horse, a sphere for the rider.
const KNIGHT = [
  { type: 0, vertices: [[-65.4, -29.1, 0], [65.4, 29.1, 81.8]], boundsRadius: 0 },
  { type: 2, vertices: [[31.3, -0.2, 96.8]], boundsRadius: 45.902 },
];

// --- the shapes land where the model is drawn ------------------------------------------

let v = [];
check("footman: both spheres are extracted", modelPickVolumes(instance(FOOTMAN, place(1000, 2000, 50)), v), 2);
check("footman: chest sphere follows the model to (1000,2000,50)",
  [Math.round(v[1].x), Math.round(v[1].y), Math.round(v[1].z), Math.round(v[1].r)], [1003, 2000, 73, 38]);

v = [];
modelPickVolumes(instance(FOOTMAN, place(0, 0, 0, 2)), v);
check("footman: a scaled model scales its spheres", [Math.round(v[0].z), Math.round(v[0].r)], [126, 76]);

v = [];
modelPickVolumes(instance(FARM, place(500, 500, 0)), v);
check("farm: the box is centred on its own extents",
  [Math.round(v[0].x), Math.round(v[0].y), Math.round(v[0].z)], [500, 500, 57]);
check("farm: half-extents", [round1(v[0].hx), round1(v[0].hy), round1(v[0].hz)], [56.6, 64.1, 56.6]);

v = [];
modelPickVolumes(instance(FARM, placeTurned(0, 0, 0)), v);
check("farm: a turned building turns its box rather than growing an AABB",
  [v[0].ax.map(Math.round), [round1(v[0].hx), round1(v[0].hy)]], [[0, 1, 0], [56.6, 64.1]]);

// --- the ray meets them -----------------------------------------------------------------

// A camera ray coming down at 45° from the south-west, aimed at a footman standing at origin.
// Hits are reported in the ray's own parameter, so all that matters is hit / miss and order.
const hit = (vol, ox, oy, oz, dx, dy, dz, pad = 0) => rayVolume(vol, ox, oy, oz, dx, dy, dz, pad) >= 0;

v = [];
modelPickVolumes(instance(FOOTMAN, place(0, 0, 0)), v);
check("footman: a ray straight down his head hits", hit(v[0], 5, 0, 500, 0, 0, -1), true);
check("footman: a ray 60 units to the side misses", hit(v[0], 65, 0, 500, 0, 0, -1), false);
check("footman: ...and 30 units of pad brings it back", hit(v[0], 65, 0, 500, 0, 0, -1, 30), true);
// His two spheres OVERLAP (head 25..101, chest -15..61), so the body he presents is one
// continuous column — but only as tall as the artist drew it: a level ray over his head is a
// miss on both, which is the whole difference from a screen-space disc around his centre.
check("footman: a level ray at z=110, over the top of his head, misses both spheres",
  [hit(v[0], -200, 0, 110, 1, 0, 0), hit(v[1], -200, 0, 110, 1, 0, 0)], [false, false]);
check("footman: ...and at z=90, through his head, hits", hit(v[0], -200, 0, 90, 1, 0, 0), true);

v = [];
modelPickVolumes(instance(FARM, place(0, 0, 0)), v);
check("farm: a ray onto the roof hits", hit(v[0], 0, 0, 500, 0, 0, -1), true);
check("farm: a ray past the corner misses", hit(v[0], 70, 70, 500, 0, 0, -1), false);
check("farm: a ray ABOVE the roof, going up, misses", hit(v[0], 0, 0, 200, 0, 0, 1), false);
check("farm: a ray starting INSIDE reports 0 (the camera in the body still counts)",
  rayVolume(v[0], 0, 0, 50, 0, 0, -1, 0), 0);

// Nearest-hit-wins is the whole tie-break, so the two knight volumes have to order correctly
// under one ray: coming down from above, the rider's sphere (top ~143) is met before the
// horse's box (top 82).
v = [];
modelPickVolumes(instance(KNIGHT, place(0, 0, 0)), v);
const tBox = rayVolume(v[0], 31, 0, 1000, 0, 0, -1, 0);
const tSphere = rayVolume(v[1], 31, 0, 1000, 0, 0, -1, 0);
check("knight: from above, the rider is reached before the horse", tSphere < tBox, true);

// --- a model with no shapes hands back nothing, which is what makes the caller fall back ---
check("orc barracks (no collision shapes at all): nothing extracted",
  modelPickVolumes({ nodes: [], model: { collisionShapes: [] } }, []), 0);
check("a body with no skeleton yet: nothing extracted",
  modelPickVolumes({ model: { collisionShapes: FOOTMAN } }, []), 0);

function round1(n) { return Math.round(n * 10) / 10; }

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
