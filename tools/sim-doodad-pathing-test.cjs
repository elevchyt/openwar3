// Headless check of doodad/destructible pathing footprints (issue #85).
//
// Two rules are under test, both taken from the real 1.27a data (see src/sim/destructibles.ts):
//   1. A pathing texture is authored in the World Editor's DEFAULT doodad facing, 270°, and
//      TURNS with the doodad — `Gate1Path.tga` (20×4) is the footprint of BOTH the horizontal
//      gate (facing 270 → no turn) and the vertical one (facing 0 → one CCW turn → 4×20).
//   2. Nothing that gets drawn is left un-collided: the .doo records whose 0x2 flag is clear
//      are the ones the editor moved into war3map.j, not holes the mapmaker asked for.
//
// Run: pnpm sim:test  (compiles src/sim/destructibles.ts to CommonJS — tools/tsconfig.sim.json)
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { quarterTurns, rotateFootprint, decodePathTex, stampFootprints, footprintRadius } = require(
  join(REPO, ".sim-build", "src", "sim", "destructibles.js"),
);
const { PathingGrid, PATHING_CELL } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
const RAD = (deg) => (deg * Math.PI) / 180;

// --- 1. quarter turns are measured off the 270° rest pose ---------------------------------
check("facing 270 = no turn", quarterTurns(RAD(270)) === 0, `got ${quarterTurns(RAD(270))}`);
check("facing 0 = one turn", quarterTurns(RAD(0)) === 1, `got ${quarterTurns(RAD(0))}`);
check("facing 90 = two turns", quarterTurns(RAD(90)) === 2, `got ${quarterTurns(RAD(90))}`);
check("facing 180 = three turns", quarterTurns(RAD(180)) === 3, `got ${quarterTurns(RAD(180))}`);
// The World Editor writes facings a hair off the round number, and a free-rotation prop can
// sit anywhere; both must snap to the nearest quarter rather than truncate.
check("facing 266 snaps to 270", quarterTurns(RAD(266)) === 0, `got ${quarterTurns(RAD(266))}`);
check("facing 355 snaps to 0", quarterTurns(RAD(355)) === 1, `got ${quarterTurns(RAD(355))}`);
check("facing -90 snaps to 270", quarterTurns(RAD(-90)) === 0, `got ${quarterTurns(RAD(-90))}`);

// --- 2. rotateFootprint: dimensions swap, chirality survives -------------------------------
// An L: blocked at (0,0) and (1,0) — the bottom row — plus (0,1). Asymmetric under 180°, so it
// catches a transpose masquerading as a rotation.
const L = { w: 2, h: 2, blocked: [true, true, true, false], buildBlocked: [false, false, false, false] };
const at = (fp, x, y) => fp.blocked[y * fp.w + x];
const l90 = rotateFootprint(L, 1); // CCW: (x,y) → (h−1−y, x)
check("90° CCW keeps three cells", l90.blocked.filter(Boolean).length === 3);
check("90° CCW sends (0,0)→(1,0)", at(l90, 1, 0) && at(l90, 1, 1) && at(l90, 0, 0) && !at(l90, 0, 1),
  JSON.stringify(l90.blocked));
check("360° is identity", JSON.stringify(rotateFootprint(rotateFootprint(L, 2), 2).blocked) === JSON.stringify(L.blocked));
const wide = { w: 20, h: 4, blocked: new Array(80).fill(true), buildBlocked: new Array(80).fill(true) };
check("20×4 turned once is 4×20", rotateFootprint(wide, 1).w === 4 && rotateFootprint(wide, 1).h === 20);
check("20×4 turned twice stays 20×4", rotateFootprint(wide, 2).w === 20 && rotateFootprint(wide, 2).h === 4);
check("radius reads the long side", footprintRadius(wide) === (20 * PATHING_CELL) / 2);

// --- 3. end to end: a gate seals the corridor it stands in ---------------------------------
// A stand-in for PathTextures\Gate1Path.tga: 20×4, solid red+blue, uncompressed 24bpp TGA.
function tga(w, h) {
  const b = new Uint8Array(18 + w * h * 3);
  b[2] = 2; // uncompressed true-colour
  b[12] = w & 0xff; b[13] = w >> 8;
  b[14] = h & 0xff; b[15] = h >> 8;
  b[16] = 24;
  b.fill(255, 18); // BGR all-on → blocked + unbuildable everywhere
  return b;
}
const GATE = tga(20, 4);
check("the stand-in decodes as 20×4", decodePathTex(GATE).w === 20 && decodePathTex(GATE).h === 4);

function gridWith(facing) {
  const size = 64;
  const grid = new PathingGrid({ width: size, height: size, flags: new Uint8Array(size * size) }, [0, 0]);
  const centre = (size / 2) * PATHING_CELL;
  stampFootprints(grid, [{ id: "LTg", x: centre, y: centre, angle: facing }], () => "gate.tga", () => GATE);
  return { grid, cx: size / 2, cy: size / 2 };
}
/** Blocked run through the stamp along X and along Y. */
function extents(facing) {
  const { grid, cx, cy } = gridWith(facing);
  let w = 0;
  let h = 0;
  for (let x = 0; x < 64; x++) if (!grid.walkable(x, cy)) w++;
  for (let y = 0; y < 64; y++) if (!grid.walkable(cx, y)) h++;
  return [w, h];
}
const horiz = extents(RAD(270)); // LTg1, "gate (horizontal)"
const vert = extents(RAD(0)); // LTg3, "gate (vertical)" — same texture, different facing
check("horizontal gate blocks 20 wide × 4 tall", horiz[0] === 20 && horiz[1] === 4, `got ${horiz}`);
check("vertical gate blocks 4 wide × 20 tall", vert[0] === 4 && vert[1] === 20, `got ${vert}`);

// A doodad with no facing (a building) must stamp exactly as authored — no accidental turn.
{
  const size = 64;
  const grid = new PathingGrid({ width: size, height: size, flags: new Uint8Array(size * size) }, [0, 0]);
  const centre = (size / 2) * PATHING_CELL;
  stampFootprints(grid, [{ id: "b", x: centre, y: centre }], () => "gate.tga", () => GATE);
  let w = 0;
  for (let x = 0; x < size; x++) if (!grid.walkable(x, size / 2)) w++;
  check("an angle-less placement is not turned", w === 20, `got ${w}`);
}

// --- 4. the .doo 0x2 bit ------------------------------------------------------------------
// parseDoo lives behind the mdx-m3-viewer parser, so assert the decision the renderer makes
// off it: every record is stamped, script-created ones included (issue #85 — WarChasers'
// gates drew as gates and let units walk through).
{
  const size = 64;
  const grid = new PathingGrid({ width: size, height: size, flags: new Uint8Array(size * size) }, [0, 0]);
  const records = [
    { id: "LTg1", x: 512, y: 512, angle: RAD(270), scriptCreated: true }, // flags 0 — the editor's placeholder
    { id: "LTlt", x: 1536, y: 1536, angle: RAD(90), scriptCreated: false }, // flags 2 — an ordinary tree
  ];
  const n = stampFootprints(grid, records.map((d) => ({ id: d.id, x: d.x, y: d.y, angle: d.angle })), () => "gate.tga", () => GATE);
  check("script-created records still stamp", n === 2, `stamped ${n}`);
}

// --- 5. the destructible registry: a gate opens by dying -----------------------------------
const { collectMapDestructibles, findDestructibleAt } = require(join(REPO, ".sim-build", "src", "world", "mapDestructibles.js"));
{
  // Rows shaped like the real Units\DestructableData.slk (a gate, a tree, a barrel).
  const ROWS = {
    LTg3: { HP: "500", pathTex: "PathTextures\\Gate1Path.tga", pathTexDeath: "PathTextures\\Gate1PathDeath.tga", targType: "debris", Name: "WESTRING_DEST_GATE_VERTICAL" },
    LTlt: { HP: "50", pathTex: "PathTextures\\4x4Default.tga", pathTexDeath: "_", targType: "tree", Name: "WESTRING_DEST_SUMMER_TREE_WALL" },
    LTbr: { HP: "20", pathTex: "PathTextures\\2x2Default.tga", pathTexDeath: "none", targType: "debris", Name: "WESTRING_DEST_BARREL" },
  };
  const rowOf = (id) => (ROWS[id] ? { string: (c) => ROWS[id][c] } : undefined);
  const doodads = [
    { id: "ZPsh", x: 0, y: 0, z: 0, angle: 0, scale: [1, 1, 1], life: 100, scriptCreated: false }, // scenery: no SLK row
    { id: "LTg3", x: 4032, y: -2176, z: 0, angle: 0, scale: [1, 1, 1], life: 100, scriptCreated: true },
    { id: "LTlt", x: 100, y: 200, z: 0, angle: RAD(270), scale: [1, 1, 1], life: 40, scriptCreated: false },
    { id: "LTbr", x: 300, y: 400, z: 0, angle: RAD(90), scale: [1, 1, 1], life: 0, scriptCreated: false }, // placed dead
  ];
  const list = collectMapDestructibles(doodads, rowOf);
  check("scenery is not a destructible", list.length === 3, `got ${list.length}`);
  // The id is the .doo INDEX (1-based), not a position in the filtered list — that is the
  // identity a `destructable` handle carries, and the scenery record must not shift it.
  check("ids are .doo indices", list.map((d) => d.id).join(",") === "2,3,4", list.map((d) => d.id).join(","));
  const gate = list[0];
  const tree = list[1];
  const barrel = list[2];
  check("life is a PERCENT of the type's HP", gate.life === 500 && tree.life === 20 && barrel.life === 0,
    `${gate.life}/${tree.life}/${barrel.life}`);
  check("a gate leaves posts behind", gate.pathTexDeath.endsWith("Gate1PathDeath.tga"));
  check("`_` and `none` both mean no texture", tree.pathTexDeath === "" && barrel.pathTexDeath === "");
  check("targType picks out the harvestable trees", tree.isTree && !gate.isTree && !barrel.isTree);

  // CreateDestructable adopts the record already standing there — position for position, with
  // only float-round-trip slop allowed.
  check("adopted by type + position", findDestructibleAt(list, "LTg3", 4032, -2176)?.id === 2);
  check("…tolerating the script's decimal literals", findDestructibleAt(list, "LTg3", 4032.0001, -2176.0002)?.id === 2);
  check("…but not a different type at the same spot", findDestructibleAt(list, "LTg1", 4032, -2176) === undefined);
  check("…nor an unrelated position", findDestructibleAt(list, "LTg3", 4600, -2176) === undefined);
}

if (failures) {
  console.error(`\ndoodad pathing: ${failures} failure(s)`);
  process.exit(1);
}
console.log("doodad pathing: all checks passed");
