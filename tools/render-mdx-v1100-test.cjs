// Headless check of the viewer patch's MDX v1100 reader (parsers/mdlx/material.js, layer.js in
// patches/mdx-m3-viewer@5.12.0.patch — docs/map-compatibility.md, Test of Balance).
//
// A v1100 (1.33+) material has NO 80-byte shader name, and each layer carries a LIST of
// textures after a shader-type id — `uint32 shaderTypeId, uint32 count`, then per texture
// `int32 textureId, uint32 slot` and an optional KMTF track. The stock reader took the shader
// name anyway, lost the layers, and the model drew nothing: Test of Balance's Sacred Pillar
// stood on the map as a health bar. Built here from bytes so the layout is pinned without the
// map; the real Obelisk.mdx is checked too when the developer's copy of the map is present.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const REPO = join(__dirname, "..");
const MDLX = join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "mdlx", "model");
const Model = require(MDLX).default;

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

/** Little-endian byte writer. */
class W {
  constructor() { this.b = []; }
  u32(v) { const a = Buffer.alloc(4); a.writeUInt32LE(v >>> 0); this.b.push(a); return this; }
  i32(v) { const a = Buffer.alloc(4); a.writeInt32LE(v); this.b.push(a); return this; }
  f32(v) { const a = Buffer.alloc(4); a.writeFloatLE(v); this.b.push(a); return this; }
  tag(s) { this.b.push(Buffer.from(s, "latin1")); return this; }
  str(s, n) { const a = Buffer.alloc(n); a.write(s, "latin1"); this.b.push(a); return this; }
  bytes(buf) { this.b.push(buf); return this; }
  done() { return Buffer.concat(this.b); }
}
/** One KMTF/KMTA track with a single linear key. */
const track = (tag, value, float) => {
  const w = new W().tag(tag).u32(1).u32(1).i32(-1).i32(0);
  return (float ? w.f32(value) : w.u32(value)).done();
};
/** A layer: the v1000 fields, then the v1100 texture list, then trailing tracks. */
function layer(version, { filter, legacyTex, textures, tracks = [] }) {
  const body = new W().u32(filter).u32(0).i32(legacyTex).i32(-1).u32(0).f32(1);
  body.f32(1).f32(1).f32(1).f32(1).f32(0).f32(0); // emissive, fresnel rgb, opacity, team colour
  if (version >= 1100) {
    body.u32(0).u32(textures.length);
    for (const [id, slot, kmtf] of textures) {
      body.i32(id).u32(slot);
      if (kmtf !== undefined) body.bytes(track("KMTF", kmtf, false));
    }
  }
  for (const t of tracks) body.bytes(t);
  const b = body.done();
  return new W().u32(b.length + 4).bytes(b).done();
}
function material(version, layers) {
  const body = new W().i32(0).u32(0);
  if (version > 800 && version < 1100) body.str("Shader_SD_FixedFunction", 80);
  body.tag("LAYS").u32(layers.length);
  for (const l of layers) body.bytes(layer(version, l));
  const b = body.done();
  return new W().u32(b.length + 4).bytes(b).done();
}
function model(version, materials) {
  const mtls = Buffer.concat(materials.map((m) => material(version, m)));
  // A camera AFTER the materials: the chunks share one stream, so a layer read a few bytes
  // short or long surfaces here as a garbled or missing camera.
  const cam = new W().u32(120).str("Camera01", 80).f32(1).f32(2).f32(3).f32(0.7).f32(1000).f32(8).f32(4).f32(5).f32(6).done();
  return new Uint8Array(new W().tag("MDLX").tag("VERS").u32(4).u32(version)
    .tag("MTLS").u32(mtls.length).bytes(mtls)
    .tag("CAMS").u32(cam.length).bytes(cam).done());
}
const parse = (bytes) => { const m = new Model(); m.load(bytes); return m; };

console.log("v1100 — no shader name, a texture list per layer");
{
  const m = parse(model(1100, [
    [{ filter: 3, legacyTex: 0, textures: [[4, 0]], tracks: [track("KMTA", 0.5, true)] }],
    [
      { filter: 0, legacyTex: 0, textures: [[2, 0]] },
      // an HD-style layer: diffuse 1 with its own animated id, then a normal map 7 with one too
      { filter: 2, legacyTex: 0, textures: [[1, 0, 5], [7, 1, 9]] },
    ],
  ]));
  check("both materials and all three layers are read", m.materials.map((x) => x.layers.length), [1, 2]);
  check("a layer draws its list's SLOT-0 texture, not the legacy field", m.materials.map((x) => x.layers.map((l) => l.textureId)), [[4], [2, 1]]);
  check("the layer's own tracks still come after the list", m.materials[0].layers[0].animations.map((a) => a.name), ["KMTA"]);
  check("slot 0's KMTF animates the layer; another slot's is read past", m.materials[1].layers[1].animations.map((a) => [a.name, a.values[0][0]]), [["KMTF", 5]]);
  check("…and the stream is still aligned for the next chunk", [m.cameras.length, m.cameras[0]?.name, [...(m.cameras[0]?.targetPosition ?? [])]], [1, "Camera01", [4, 5, 6]]);
}

console.log("\nv1000 and v800 — unchanged");
{
  const m = parse(model(1000, [[{ filter: 1, legacyTex: 3, textures: [] }]]));
  check("v1000 still reads its 80-byte shader name", m.materials[0].shader, "Shader_SD_FixedFunction");
  check("…and its legacy texture id", m.materials[0].layers[0].textureId, 3);
  check("…and the next chunk", m.cameras[0]?.name, "Camera01");
}

const MAP = join(REPO, "Warcraft III", "Maps", "Download", "Test of Balance v1.24-4p.w3x");
console.log("\nTest of Balance's own Obelisk.mdx (the Sacred Pillar)");
if (!existsSync(MAP)) console.log("  skip  (map not in the install)");
else {
  const MpqArchive = require(join(REPO, "node_modules", "mdx-m3-viewer", "dist", "cjs", "parsers", "mpq", "archive")).default;
  const a = new MpqArchive();
  a.load(new Uint8Array(readFileSync(MAP)), true);
  const m = parse(a.get("war3mapImported\\Obelisk.mdx").bytes());
  check("it is v1100", m.version, 1100);
  check("every layer draws a real texture", m.materials.map((x) => x.layers.map((l) => l.textureId)), [[0], [1], [2, 1], [3], [4], [3]]);
  check("the obelisk layer is the Icecrown Obelisk art", m.textures[m.materials[1].layers[0].textureId].path, "Doodads\\Cinematic\\IcecrownObelisk\\Icecrown_Obelisk.blp");
  check("its seven geosets and its camera all read", [m.geosets.length, m.cameras.length], [7, 1]);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall MDX v1100 checks passed");
