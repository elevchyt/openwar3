// Headless check of what `SetTerrainType` paints (src/render/terrainBrush.ts —
// docs/map-compatibility.md pass 10): which tile points an area of a size and shape covers, and
// which variation a -1 picks.
//
// The footprint is pinned against the only depiction the install has — the World Editor's own
// brush icons (ReplaceableTextures\WorldEditUI\TextureBrush0N.blp), decoded: a circle of size
// 1–5 covers 1, 5, 21, 37 and 61 tile points. The rarity table is read out of the install's own
// UI\WorldEditData.txt when it is extracted, so the weights are the file's and not a copy.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { brushPoints, parseCellRarity, pickCell } = require(join(REPO, ".sim-build", "src", "render", "terrainBrush.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

console.log("an area of a size and a shape (TerrainShapeCircle = 0, TerrainShapeSquare = 1)");
{
  check("circles of size 1–5 cover what the editor's brush icons draw", [1, 2, 3, 4, 5].map((n) => brushPoints(n, 0, 100).length), [1, 5, 21, 37, 61]);
  check("size 2 is the plus, not the 3×3", brushPoints(2, 0, 100).map(([x, y]) => `${x},${y}`).sort(), ["-1,0", "0,-1", "0,0", "0,1", "1,0"]);
  check("a square of size N is (2N−1)² points", [1, 2, 4].map((n) => brushPoints(n, 1, 100).length), [1, 9, 49]);
  check("a size below 1 still paints the point it names", brushPoints(0, 0, 100), [[0, 0]]);
  // Angel Arena paints "the whole map" with an area of 1 000 000 000 — capped at the map.
  check("a huge area is capped at the map's own size", brushPoints(1e9, 1, 3).length, 49);
}

console.log("\nthe variation a -1 picks");
{
  const table = [[16, 85], [17, 85], [0, 85], [1, 10], [3, 1]];
  check("the bottom of the range is the first cell", pickCell(table, 0), 16);
  check("…a draw lands in proportion to the weights", pickCell(table, (85 + 85 + 85 + 5) / 266), 1);
  check("…and the very top is the rarest last cell", pickCell(table, 0.99999), 3);
  const WED = join(REPO, "Warcraft III", "ExtractedData", "merged", "UI", "WorldEditData.txt");
  if (existsSync(WED)) {
    const rarity = parseCellRarity(new TextDecoder("windows-1252").decode(readFileSync(WED)));
    check("the install's table has all 18 cells", rarity && rarity.length, 18);
    check("…the two originals are common (85)", rarity && [16, 17].map((id) => rarity.find(([c]) => c === id)[1]), [85, 85]);
    check("…and cell 3 is rare (1)", rarity && rarity.find(([c]) => c === 3)[1], 1);
  } else console.log("  (skip — run `pnpm data:extract` to check the install's own table)");
  check("a file with no [TerrainCellRarity] gives nothing", parseCellRarity("[Other]\n0=1\n"), null);
}

console.log(failed ? `\n${failed} FAILED` : "\nall terrain-brush checks passed");
process.exit(failed ? 1 : 0);
