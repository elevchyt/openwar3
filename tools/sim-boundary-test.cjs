// The map's UNPLAYABLE area — the black border, and the "Nothing" tiles a mapmaker paints
// inside it (issue #117).
//
// The thing worth testing here is that four independent statements of the same fact agree.
// A .w3x says where its boundary is four times over, in four files written by four different
// parts of the World Editor:
//
//   • war3map.w3e — two per-tile flags. "Boundary flag 1" is bit 0x4000 of the water word
//     (the margin the editor manages), "boundary flag 2" is bit 0x80 of the texture byte
//     (the Nothing tool, `UI\WorldEditData.txt`). Either one means unplayable.
//   • war3map.wpm — the pathing grid, where those same tiles come out as 0x04 `Unflyable`
//     and NOTHING else in the map does. That bit is the difference between the border and a
//     cliff (a cliff is 0xca, the border 0xce), and it is why the border is the one thing an
//     air unit cannot cross.
//   • war3map.j — `main()` opens with `SetCameraBounds(<playable rect> ± GetCameraMargin(…))`,
//     stating the playable rect in world coordinates.
//   • war3map.w3i — the RESULT of that sum, the camera bounds themselves.
//
// So `playableRect` (derived from the flags) has to reproduce the .j's literals, and
// `cameraBoundsOf` (that, pulled in by CAMERA_MARGIN) has to reproduce the .w3i's — on maps
// of three different sizes, one of which has a boundary that is not a rectangle at all. Get
// the margin wrong and `GetPlayableMapRect()` moves for every map in the game.
//
// Run: pnpm sim:test  (tools/tsconfig.sim.json compiles src/world/terrain.ts + src/sim/pathing.ts)
const { join } = require("node:path");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const {
  CELL, CAMERA_MARGIN, isBoundaryTile, boundaryCorners, playableRect, cameraBoundsOf, parseW3E,
} = require(join(REPO, ".sim-build", "src", "world", "terrain.js"));
const { PathingGrid, PathingFlag, PATHING_CELL } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
const say = (name) => console.log(`  ok   ${name}`);
function expect(name, cond, detail) {
  check(name, cond, detail);
  if (cond) say(name);
}

// --- a hand-made grid, so the pure rules are testable with no install ----------------------
/** `cols`×`rows` CORNERS of flat ground, with `mark(tx, ty)` deciding each TILE's flag. */
function terrain(cols, rows, mark) {
  const corners = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const flag = mark(x, y) ?? "";
      corners.push({
        groundHeight: 0, waterHeight: 0, layerHeight: 2, groundTexture: 0, cliffTexture: 15,
        ramp: false, water: false, rampAdjust: 0,
        boundary: flag === "nothing", mapEdge: flag === "edge",
      });
    }
  }
  return { width: cols, height: rows, centerOffset: [-cols * 64, -rows * 64], tileset: "L", groundTilesets: [], cliffTilesets: [], corners };
}

console.log("\nthe two w3e flags are one fact");
{
  const t = terrain(4, 4, (x, y) => (x === 0 ? "edge" : x === 2 ? "nothing" : ""));
  expect("the editor's margin flag says unplayable", isBoundaryTile(t.corners[0]));
  expect("the Nothing tool's flag says unplayable", isBoundaryTile(t.corners[2]));
  expect("neither flag says playable", !isBoundaryTile(t.corners[1]));
}

console.log("\nthe tile mask is dilated onto the CORNER grid");
{
  // One boundary tile at (5,5) in an otherwise clear 12×12-corner grid.
  const t = terrain(12, 12, (x, y) => (x === 5 && y === 5 ? "nothing" : ""));
  const mask = boundaryCorners(t);
  const at = (x, y) => mask[y * 12 + x];
  expect("one boundary tile darkens exactly its four corners",
    mask.reduce((a, b) => a + b, 0) === 4, `got ${mask.reduce((a, b) => a + b, 0)}`);
  expect("…which are (5,5),(6,5),(5,6),(6,6)", at(5, 5) && at(6, 5) && at(5, 6) && at(6, 6));
  // Without the dilation a boundary TILE renders as a gradient from one corner and stays lit
  // over the other three quarters of itself — which is the bug the mask exists to prevent.
  expect("…and nothing outside them", !at(4, 5) && !at(7, 5) && !at(5, 4) && !at(5, 7));
}

console.log("\nthe playable rect is measured in TILES, not corners");
{
  // The last corner row and column anchor no tile. (2)BootyBay's are stale and UNflagged, so
  // a corner-wise bounding box would push its playable rect a whole row past the map.
  const clear = terrain(9, 9, (x, y) => (x < 2 || y < 2 || x > 6 || y > 6 ? "edge" : ""));
  const stale = terrain(9, 9, (x, y) => (y === 8 ? "" : x < 2 || y < 2 || x > 6 || y > 6 ? "edge" : ""));
  const a = playableRect(clear);
  const b = playableRect(stale);
  const off = clear.centerOffset;
  expect("a two-tile frame leaves tiles 2..6 playable",
    a.minX === off[0] + 2 * CELL && a.maxX === off[0] + 7 * CELL, JSON.stringify(a));
  expect("…and an unflagged final corner row does not widen it", b.maxY === a.maxY, `${b.maxY} vs ${a.maxY}`);
}

console.log("\nthe camera stops a margin short of the playable area");
{
  const t = terrain(9, 9, (x, y) => (x < 2 || y < 2 || x > 6 || y > 6 ? "edge" : ""));
  const play = playableRect(t);
  const cam = cameraBoundsOf(t);
  expect("512 across", cam.minX - play.minX === 512 && play.maxX - cam.maxX === 512, JSON.stringify(cam));
  expect("256 up and down", cam.minY - play.minY === 256 && play.maxY - cam.maxY === 256, JSON.stringify(cam));
  // common.j orders them LEFT, RIGHT, TOP, BOTTOM — the order GetCameraMargin is indexed by.
  expect("GetCameraMargin's four sides are [512, 512, 256, 256]",
    CAMERA_MARGIN.join() === "512,512,256,256", CAMERA_MARGIN.join());
}

console.log("\nUnflyable (0x04) is the boundary, and only the boundary");
{
  const W = 8;
  const flags = new Uint8Array(W * W).fill(0x40); // open land
  flags[2 * W + 2] = 0xca; // a cliff: unwalkable, unbuildable, no water — and FLYABLE
  flags[2 * W + 3] = 0xce; // the border: the same, plus 0x04
  const grid = new PathingGrid({ width: W, height: W, flags }, [0, 0]);
  expect("the bit is 0x04", PathingFlag.Unflyable === 0x04);
  expect("open land is playable", grid.playable(0, 0));
  expect("a cliff is playable — a flyer crosses it", grid.playable(2, 2));
  expect("…though nothing walks on it", !grid.walkable(2, 2));
  expect("the border is not playable", !grid.playable(3, 2));
  expect("off the grid is not playable either", !grid.playable(-1, 0) && !grid.playable(W, 0));
  // The world-space form is what every caller outside the pathfinder uses (a cast's target
  // point, a flyer's destination), so it has to agree cell for cell.
  expect("playableAt maps world → cell", !grid.playableAt(3 * PATHING_CELL + 1, 2 * PATHING_CELL + 1));
  expect("nearestPlayable keeps a point that is already inside",
    String(grid.nearestPlayable(0, 0)) === "0,0");
  const near = grid.nearestPlayable(3, 2);
  expect("…and pulls one that is not to an adjacent cell",
    !!near && Math.max(Math.abs(near[0] - 3), Math.abs(near[1] - 2)) === 1, String(near));
  // A whole column of border, so the first ring that has anything at all is 3 wide: the
  // answer must be the one straight out from the point, not the ring's corner.
  const wall = new Uint8Array(9 * 9).fill(0x40);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 3; x++) wall[y * 9 + x] = 0xce;
  const edged = new PathingGrid({ width: 9, height: 9, flags: wall }, [0, 0]);
  expect("nearestPlayable takes the closest cell on the ring, not the ring's corner",
    String(edged.nearestPlayable(1, 4)) === "3,4", String(edged.nearestPlayable(1, 4)));
  const walled = new PathingGrid({ width: 3, height: 3, flags: new Uint8Array(9).fill(0xce) }, [0, 0]);
  expect("a map that is boundary end to end has nowhere to send anything",
    walled.nearestPlayable(1, 1, 4) === null);
}

// --- and the same rules against the real files, when this machine has an install -----------
const MPQ_PATH = "mdx-m3-viewer/dist/cjs/parsers/mpq/archive";
const WPM_PATH = "mdx-m3-viewer/dist/cjs/parsers/w3x/wpm/file";
const W3I_PATH = "mdx-m3-viewer/dist/cjs/parsers/w3x/w3i/file";

/** Every map on this machine we know how to check, by path. Silent when there is no install. */
function localMaps() {
  const root = join(REPO, "Warcraft III", "Maps");
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.w3[mx]$/i.test(e.name)) out.push(p);
    }
  };
  walk(root);
  // Two melee maps of different sizes plus the boundary test map, which is the only one with
  // hand-painted Nothing INSIDE the playable area.
  const want = ["(2)BootyBay", "(2)EchoIsles", "BoundaryTest"];
  return want.map((n) => out.find((p) => p.includes(n))).filter(Boolean);
}

/** The four literals a World-Editor `main()` states its playable rect with, or null. */
function cameraBoundsFromScript(text) {
  const flat = text.replace(/\s+/g, "");
  const m = /SetCameraBounds\((-?[\d.]+)\+GetCameraMargin\([^)]*\),(-?[\d.]+)\+GetCameraMargin\([^)]*\),(-?[\d.]+)-GetCameraMargin\([^)]*\),(-?[\d.]+)-GetCameraMargin/.exec(flat);
  return m ? { minX: +m[1], minY: +m[2], maxX: +m[3], maxY: +m[4] } : null;
}

const maps = localMaps();
if (!maps.length) {
  console.log("\n(no install on this machine — the real-map cross-checks were skipped)");
} else {
  const Archive = require(MPQ_PATH).default ?? require(MPQ_PATH);
  const Wpm = require(WPM_PATH).default ?? require(WPM_PATH);
  const W3i = require(W3I_PATH).default ?? require(W3I_PATH);
  for (const file of maps) {
    const name = file.split(/[\\/]/).pop();
    console.log(`\n${name}: the map states its own boundary four ways`);
    const mpq = new Archive();
    mpq.load(new Uint8Array(readFileSync(file)));
    const t = parseW3E(new Uint8Array(mpq.get("war3map.w3e").arrayBuffer()));
    const wpm = new Wpm();
    wpm.load(mpq.get("war3map.wpm").arrayBuffer());
    const grid = new PathingGrid({ width: wpm.size[0], height: wpm.size[1], flags: wpm.pathing }, t.centerOffset);

    // 1) w3e flags ⇔ wpm 0x04, tile for tile, in BOTH directions.
    let flaggedButFlyable = 0;
    let unflaggedButNot = 0;
    for (let ty = 0; ty < t.height - 1; ty++) {
      for (let tx = 0; tx < t.width - 1; tx++) {
        const bnd = isBoundaryTile(t.corners[ty * t.width + tx]);
        for (let dy = 0; dy < CELL / PATHING_CELL; dy++) {
          for (let dx = 0; dx < CELL / PATHING_CELL; dx++) {
            const open = grid.playable(tx * 4 + dx, ty * 4 + dy);
            if (bnd && open) flaggedButFlyable++;
            if (!bnd && !open) unflaggedButNot++;
          }
        }
      }
    }
    expect("every boundary tile is Unflyable in the pathing map", flaggedButFlyable === 0, `${flaggedButFlyable} cells`);
    expect("…and no other tile is", unflaggedButNot === 0, `${unflaggedButNot} cells`);

    // 2) the flags reproduce the rect the editor wrote into main().
    const script = cameraBoundsFromScript(mpq.get("war3map.j").text());
    const play = playableRect(t);
    if (script) {
      expect("playableRect is the rect SetCameraBounds names",
        play.minX === script.minX && play.minY === script.minY && play.maxX === script.maxX && play.maxY === script.maxY,
        `ours ${JSON.stringify(play)} vs script ${JSON.stringify(script)}`);
    }

    // 3) …and pulling it in by the camera margin lands on the w3i's own camera bounds.
    const w3i = new W3i();
    w3i.load(mpq.get("war3map.w3i").arrayBuffer());
    const cam = cameraBoundsOf(t);
    const [bx, by, tx2, ty2] = w3i.cameraBounds; // bottom-left then top-right
    expect("cameraBoundsOf is war3map.w3i's camera bounds",
      cam.minX === bx && cam.minY === by && cam.maxX === tx2 && cam.maxY === ty2,
      `ours ${JSON.stringify(cam)} vs w3i ${[bx, by, tx2, ty2].join()}`);
  }
}

if (failures) {
  console.error(`\nboundary: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nboundary: all checks passed");
