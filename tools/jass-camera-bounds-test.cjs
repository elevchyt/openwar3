// `SetCameraBounds(x1, y1, x2, y2, x3, y3, x4, y4)` — four CORNERS, in the caller's order.
//
// A map's own main() writes them (bottom-left, top-right, top-left, bottom-right), while
// blizzard.j's `SetCameraBoundsToRect` — behind every GUI "Camera - Set camera bounds" and every
// `SetCameraBoundsToRectForPlayerBJ` — writes (minX,minY, minX,maxY, maxX,maxY, maxX,minY).
// Read as "the first two pairs", the second order is a rect zero units wide, and the focus is
// pinned to its left edge for the rest of the match.
//
// Run: pnpm jass:test
const { join } = require("node:path");
const { readFileSync } = require("node:fs");
const { requireInstallScripts } = require("./jass-install-scripts.cjs");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".jass-build", "src", "jass");
require("node:fs").writeFileSync(join(REPO, ".jass-build", "package.json"), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, "headless.js"));

const SCRIPTS = requireInstallScripts("common.j", "Blizzard.j");
const COMMON_J = readFileSync(join(SCRIPTS, "common.j"), "latin1");
const BLIZZARD_J = readFileSync(join(SCRIPTS, "Blizzard.j"), "latin1");

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const SRC = `
function MainOrder takes nothing returns nothing
    call SetCameraBounds( -3000.0, -2000.0, 3000.0, 2500.0, -3000.0, 2500.0, 3000.0, -2000.0 )
endfunction
function RectOrder takes nothing returns nothing
    call SetCameraBoundsToRect( Rect(-400.0, 160.0, 1648.0, 2208.0) )
endfunction
`;
let bounds = null;
const interp = buildInterpreter([COMMON_J, BLIZZARD_J, SRC], { hooks: { setCameraBounds: (b) => (bounds = b) } });

interp.callFunction("MainOrder", []);
check("a map's main() order", bounds, { minX: -3000, minY: -2000, maxX: 3000, maxY: 2500 });
interp.callFunction("RectOrder", []);
check("blizzard.j's SetCameraBoundsToRect order", bounds, { minX: -400, minY: 160, maxX: 1648, maxY: 2208 });

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall camera-bounds checks passed");
process.exit(failed ? 1 : 0);
