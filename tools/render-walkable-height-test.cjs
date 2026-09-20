// WALKABLE DESTRUCTIBLES — a unit on a bridge stands on the DECK (src/render/walkableHeight.ts).
//
// The claim under test is a numeric one about the real data, so it is made against the real
// data: Human01 (The Defense of Strahnbrad) places exactly one walkable destructible, an
// `LT05` "Long Bridge, Diagonal 1" — `Doodads\Terrain\WoodBridgeLarge45` — and its war3map.doo
// record reads
//
//     LT05  at (1216, -960, -114)  angle 0  scale 1,1,1
//
// while its war3map.w3e puts the terrain at about -165 in the middle of the span and +73 at
// either bank. If the deck is read correctly the two meet: the ray finds the planks at ~+81
// where the bridge lands on the bank (within a few units of the ground it joins) and ~+160 at
// the crown of the arch, ~325 above the streambed. Get the transform wrong — forget the .doo's
// z, or apply the rotation the other way round — and one of those two numbers goes badly wrong.
//
// The MISS matters as much as the hit: off the ends of the bridge the ray must find nothing,
// because that is what hands the unit back to the terrain (`groundOrDeck` maxes the two).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { WalkableSurfaces } = require(join(REPO, ".sim-build", "src", "render", "walkableHeight.js"));
const mdlx = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "mdlx", "model"));
const MdlxModel = mdlx.default ?? mdlx;
const { openInstall, isCascInstallDir } = require(join(REPO, "tools", "install.cjs"));
const { decodePathTex } = require(join(REPO, ".sim-build", "src", "sim", "destructibles.js"));
const { PATHING_CELL } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { VisionMap, FogState } = require(join(REPO, ".sim-build", "src", "sim", "vision.js"));

let failed = 0;
function check(what, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${what}${cond || !detail ? "" : ` — ${detail}`}`);
}
const near = (got, want, tol) => Math.abs(got - want) <= tol;

// --- the pure geometry, with no install at all ------------------------------------------
console.log("the ray takes the HIGHEST surface, and misses off the edge");
{
  // A 200x200 square deck at model z 50, with a second, smaller one at z 120 over its middle.
  const quad = (half, z) => ({
    vertices: new Float32Array([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
    faces: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });
  const s = new WalkableSurfaces();
  s.add(1, [quad(100, 50), quad(40, 120)], { x: 1000, y: 2000, z: 7, angle: 0, scale: [1, 1, 1] });
  check("over the lower deck alone, the lower deck", near(s.heightAt(1080, 2000), 57, 0.01), s.heightAt(1080, 2000));
  check("over both, the higher one", near(s.heightAt(1000, 2000), 127, 0.01), s.heightAt(1000, 2000));
  // The .doo's z is an ABSOLUTE world height, not an offset off the terrain — the viewer moves
  // the instance to `doodad.location` verbatim — so moving the record moves the deck with it.
  const lower = new WalkableSurfaces();
  lower.add(1, [quad(100, 50)], { x: 1000, y: 2000, z: -200, angle: 0, scale: [1, 1, 1] });
  check("the record's own z is carried", lower.heightAt(1080, 2000) === -150, lower.heightAt(1080, 2000));
  check("off the edge, nothing at all", s.heightAt(1200, 2000) === -Infinity, s.heightAt(1200, 2000));
  check("a destructible is taken once", (s.add(1, [quad(100, 900)], { x: 1000, y: 2000, z: 0, angle: 0, scale: [1, 1, 1] }), s.count), 1);
}
console.log("\n…and it turns and scales with the record");
{
  // A long thin plank along X. Turned a quarter turn it must answer along Y instead.
  const plank = {
    vertices: new Float32Array([-400, -20, 10, 400, -20, 10, 400, 20, 10, -400, 20, 10]),
    faces: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
  const flat = new WalkableSurfaces();
  flat.add(1, [plank], { x: 0, y: 0, z: 0, angle: 0, scale: [1, 1, 1] });
  check("unturned, it lies along X", flat.heightAt(300, 0) === 10 && flat.heightAt(0, 300) === -Infinity);
  const turned = new WalkableSurfaces();
  turned.add(1, [plank], { x: 0, y: 0, z: 0, angle: Math.PI / 2, scale: [1, 1, 1] });
  check("a quarter turn puts it along Y", turned.heightAt(0, 300) === 10 && turned.heightAt(300, 0) === -Infinity);
  const big = new WalkableSurfaces();
  big.add(1, [plank], { x: 0, y: 0, z: 0, angle: 0, scale: [1, 1, 2] });
  check("the z scale lifts the deck with it", big.heightAt(300, 0) === 20, big.heightAt(300, 0));
}

// --- the real bridge ---------------------------------------------------------------------
const WC3 = join(REPO, "Warcraft III");
if (!fs.existsSync(WC3) || !isCascInstallDir(WC3)) {
  console.log("\nskip  no local Warcraft III install — the Strahnbrad bridge half is skipped");
  console.log(failed ? `\nwalkable: ${failed} check(s) FAILED` : "\nwalkable: all checks passed");
  process.exit(failed ? 1 : 0);
}
(async () => {
  const { vfs } = await openInstall(WC3);
  const path = "Doodads\\Terrain\\WoodBridgeLarge45\\WoodBridgeLarge45.mdx";
  const bytes = vfs.rawBytes(path);
  console.log("\nStrahnbrad's own bridge, out of the archives");
  check(`${path} is in the install`, !!bytes);
  if (bytes) {
    const model = new MdlxModel();
    model.load(bytes);
    const geosets = model.geosets
      .filter((g) => g.lod === 0 || g.lod === -1)
      .map((g) => ({ vertices: g.vertices, faces: g.faces }));
    const s = new WalkableSurfaces();
    // Human01's war3map.doo record, verbatim.
    s.add(1, geosets, { x: 1216, y: -960, z: -113.99, angle: 0, scale: [1, 1, 1] });
    // The bridge runs along the 45° diagonal, so sample along it.
    const along = (t) => s.heightAt(1216 + t * Math.SQRT1_2, -960 + t * Math.SQRT1_2);
    const crown = along(0);
    const bank = along(-500);
    check("the crown of the arch is ~160", near(crown, 160, 6), crown);
    check("the bank end is ~81 — the terrain it joins is +73", near(bank, 81, 6), bank);
    check("…so the deck rises about 80 over the span", near(crown - bank, 80, 10), crown - bank);
    check("…and stands ~325 clear of the streambed (-165)", near(crown + 165, 325, 12), crown + 165);
    check("past the end of the bridge the ray finds nothing", along(700) === -Infinity, along(700));
  }

  // --- and the other half of "a bridge is not high ground" -------------------------------
  //
  // A bridge's DECK is never in the fog's line-of-sight field — `VisionSet.initBlockers`
  // installs the CLIFF-LEVEL sampler, and the river Human01's bridge spans is cliff level 0
  // from bank to bank while the deck stands at +161. What made the bridge LOOK like high
  // ground was the renderer lighting it from the single vision cell under its ORIGIN, which
  // for a thousand-unit bridge is out in the middle of the water: walk up to it and the whole
  // span went explored-grey, step onto it and it lit up. `MapViewerScene.propFogRadius` gives
  // every prop its own body to be lit from (the half-extent of its pathing texture), so both
  // halves of the claim are pinned here — how big the bridge's body is, and that a footprint
  // of that size is what turns one dark cell into a lit prop.
  console.log("\na prop is lit from its BODY, not from the cell under its origin");
  {
    const bytes = vfs.rawBytes("PathTextures\\CityBridgeLarge45.tga");
    check("the bridge's own pathing texture is in the install", !!bytes);
    if (bytes) {
      const fp = decodePathTex(bytes);
      const half = (Math.max(fp.w, fp.h) * PATHING_CELL) / 2;
      check("…and it is 32x32 cells, so the bridge's body reaches 512 from its origin",
        fp.w === 32 && fp.h === 32 && half === 512, `${fp.w}x${fp.h} → ${half}`);
      // A tree, for scale: its texture is four cells, so it keeps a single-cell-ish reading.
      const tree = vfs.rawBytes("PathTextures\\4x4Default.tga");
      if (tree) {
        const tfp = decodePathTex(tree);
        check("…while a tree's is 4x4, i.e. 64 — props are not all given a huge radius",
          (Math.max(tfp.w, tfp.h) * PATHING_CELL) / 2 === 64, `${tfp.w}x${tfp.h}`);
      }
    }

    // The mechanism, on a vision map of its own: one cell Explored in a Visible field.
    const v = new VisionMap(0, 0, 4096, 4096);
    v.stampRect(0, 0, 4096, 4096, FogState.Visible);
    v.stampCircle(2048, 2048, 70, FogState.Explored); // one vision cell (VISION_CELL is 64)
    check("the origin cell alone reads Explored", v.stateAt(2048, 2048) === FogState.Explored);
    check("…which is what dimmed the whole bridge (radius 0 sees only that cell)",
      v.bestStateAt(2048, 2048, 0) === FogState.Explored);
    check("…and with the bridge's own 512 it is Visible again",
      v.bestStateAt(2048, 2048, 512) === FogState.Visible);
    // …and the fix must not light a prop whose whole body really is unseen.
    v.stampCircle(2048, 2048, 700, FogState.Explored);
    check("a prop whose whole body is explored-grey still reads Explored",
      v.bestStateAt(2048, 2048, 512) === FogState.Explored);
  }
  console.log(failed ? `\nwalkable: ${failed} check(s) FAILED` : "\nwalkable: all checks passed");
  process.exit(failed ? 1 : 0);
})();
