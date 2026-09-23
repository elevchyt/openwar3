// VisionMap.statesAtGrid — the minimap fog's one-call lattice read (hud.ts paintFog,
// `MinimapFogGrid`) — against `stateAt`, the point-by-point question it replaces.
//
// The minimap asks the fog state of every one of its pixels ten times a second. It used to ask
// them one at a time; now it asks for the whole lattice at once, with each column's and each
// row's cell worked out once. That is only worth having if it is the SAME answer at every point,
// so this compares the two at every point of lattices that run off every edge of the map, under
// random fog, with every combination of the three switches that change what a cell reads as
// (`revealAll`, FogEnable, FogMaskEnable).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { VisionMap } = require(join(REPO, ".sim-build", "src", "sim", "vision.js"));

let failed = 0;
function check(what, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

/** Deterministic pseudo-random. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const r = rng(0xf09);
// An awkward origin and a size that is not a whole number of cells, as a real map's are.
const OX = -3712.5, OY = -2560, W = 7421, H = 5117;
const v = new VisionMap(OX, OY, W, H);
// Random fog: explore some cells, make some of those visible (a reveal is what writes both).
for (let k = 0; k < 400; k++) v.reveal(OX + r() * W, OY + r() * H, 150 + r() * 600);
v.beginFrame(); // …then clear the visible layer, and light a few again, so all three states exist
for (let k = 0; k < 60; k++) v.reveal(OX + r() * W, OY + r() * H, 150 + r() * 600);

function lattice(nx, ny, x0, y0, w, h, flip) {
  const xs = new Float64Array(nx), ys = new Float64Array(ny);
  for (let i = 0; i < nx; i++) xs[i] = x0 + (i / nx) * w;
  for (let j = 0; j < ny; j++) ys[j] = flip ? y0 + (1 - j / ny) * h : y0 + (j / ny) * h;
  return { xs, ys };
}

const cases = [
  // The minimap's own lattice: the map's bounds, north-up.
  ["the minimap's lattice", lattice(256, 177, OX, OY, W, H, true)],
  // Wider than the map on every side, so both axes walk off both ends.
  ["a lattice past every edge", lattice(203, 151, OX - 900, OY - 700, W + 1800, H + 1400, false)],
  // Points exactly on cell boundaries, where a floor() could go either way.
  ["points on cell boundaries", lattice(64, 64, OX, OY, 64 * 64, 64 * 64, false)],
];

const seen = new Set();
for (const reveal of [false, true]) {
  for (const fog of [true, false]) {
    for (const mask of [true, false]) {
      v.setRevealAll(reveal);
      v.setFogEnabled(fog);
      v.setMaskEnabled(mask);
      for (const [name, { xs, ys }] of cases) {
        const out = new Uint8Array(xs.length * ys.length).fill(9);
        v.statesAtGrid(xs, ys, out);
        let bad = -1;
        for (let j = 0; j < ys.length && bad < 0; j++) {
          for (let i = 0; i < xs.length; i++) {
            const want = v.stateAt(xs[i], ys[j]);
            seen.add(want);
            if (out[j * xs.length + i] !== want) { bad = j * xs.length + i; break; }
          }
        }
        check(`${name} — reveal ${reveal}, fog ${fog}, mask ${mask}`, bad < 0,
          bad < 0 ? `${xs.length * ys.length} points` : `first differs at point ${bad}`);
      }
    }
  }
}
check("all three states occurred", seen.has(0) && seen.has(1) && seen.has(2), [...seen].sort().join(","));

if (failed) {
  console.log(`\n${failed} vision-grid check(s) FAILED`);
  process.exit(1);
}
console.log("\nvision grid: all checks passed");
