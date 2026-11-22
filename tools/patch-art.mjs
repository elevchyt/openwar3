// Our own art for the game's later patches → the BLPs the engine reads (docs/patches.md).
//
// A patch that ADDS an object Blizzard drew new art for (the Ritual Dagger, Sundering Blades)
// needs an icon a 1.30.4 install does not have. OpenWar3 ships none of Blizzard's art, so those
// icons are OUR OWN, drawn for the project and kept as PNGs in src/patches/art/ under the name
// the game would give them — `BTN<Name>.png`, `DISBTN<Name>.png`, `PASBTN<Name>.png`,
// `DISPASBTN<Name>.png` — which is also what decides where each is served:
//
//   BTN*       ReplaceableTextures\CommandButtons\
//   PASBTN*    ReplaceableTextures\PassiveButtons\
//   DIS*       ReplaceableTextures\CommandButtonsDisabled\   (both kinds, as the install files them)
//
// Every reader of an icon decodes a BLP (assets/blp.ts), so each PNG is converted into one: a
// BLP1 PALETTED image (content 1) with an 8-bit alpha plane and the full mip chain — the plain
// uncompressed shape mdx-m3-viewer's BlpImage reads. 256 colours is ample for a 64×64 icon; the
// palette is a median cut over the icon's own pixels.
//
// The BLPs go into src/patches/art.ts as base64, because `rawBytes` is synchronous and the headless
// tests import the same module — no fetch, no bundler query. Run after adding or changing a PNG:
//
//   node tools/patch-art.mjs            (writes src/patches/art.ts)
//   node tools/patch-art.mjs --check    (fails if art.ts is stale)

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ART = join(REPO, "src", "patches", "art");
const OUT = join(REPO, "src", "patches", "art.ts");

// ---------------------------------------------------------------------------------------------
// PNG → RGBA (8-bit, non-interlaced, RGB/RGBA/palette/grey — what an icon editor writes)

function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");
  let at = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = bytes.readUInt32BE(at);
    const kind = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    at += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const f = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      if (f === undefined) throw new Error(`bad PNG filter ${filter}`);
      px[y * stride + x] = (v + f) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, i * channels + channels);
    let r, g, b, al = 255;
    if (type === 0) r = g = b = s[0];
    else if (type === 4) { r = g = b = s[0]; al = s[1]; }
    else if (type === 2) [r, g, b] = s;
    else if (type === 6) [r, g, b, al] = s;
    else {
      r = palette[s[0] * 3]; g = palette[s[0] * 3 + 1]; b = palette[s[0] * 3 + 2];
      al = trns && s[0] < trns.length ? trns[s[0]] : 255;
    }
    rgba.set([r, g, b, al], i * 4);
  }
  return { width, height, rgba };
}

// The encoder is the game's own (src/assets/blpEncode.ts — the one DerivedArtDataSource uses at
// mount), compiled by tools/tsconfig.sim.json, so a drawn icon and a derived one are one format.
const BUILD = join(REPO, ".sim-build");
if (!existsSync(join(BUILD, "src", "assets", "blpEncode.js"))) {
  execFileSync("npx", ["tsc", "-p", "tools/tsconfig.sim.json"], { cwd: REPO, stdio: "inherit" });
}
writeFileSync(join(BUILD, "package.json"), '{"type":"commonjs"}');
const { encodeBlp: encodeRgba } = createRequire(import.meta.url)(join(BUILD, "src", "assets", "blpEncode.js"));
const encodeBlp = (img) => Buffer.from(encodeRgba({ width: img.width, height: img.height, data: img.rgba }));

// ---------------------------------------------------------------------------------------------

function wc3Path(file) {
  const name = file.replace(/\.png$/i, "");
  if (/^DIS/i.test(name)) return `ReplaceableTextures\\CommandButtonsDisabled\\${name}.blp`;
  if (/^PASBTN/i.test(name)) return `ReplaceableTextures\\PassiveButtons\\${name}.blp`;
  if (/^BTN/i.test(name)) return `ReplaceableTextures\\CommandButtons\\${name}.blp`;
  throw new Error(`${file}: name it BTN*/PASBTN*/DISBTN*/DISPASBTN* so its WC3 path is known`);
}

const files = existsSync(ART) ? readdirSync(ART).filter((f) => /\.png$/i.test(f)).sort() : [];
const lines = [
  "// GENERATED by tools/patch-art.mjs from the PNGs in src/patches/art/ — do not edit by hand.",
  "// OpenWar3's OWN icons for objects the game's later patches added (docs/patches.md), as BLP1",
  "// (base64), keyed on the WC3 path each is served from by PatchDataSource (src/vfs/patch.ts).",
  "",
  "export const PATCH_ART: Record<string, string> = {",
];
for (const file of files) {
  const blp = encodeBlp(decodePng(readFileSync(join(ART, file))));
  lines.push(`  ${JSON.stringify(wc3Path(file))}: ${JSON.stringify(blp.toString("base64"))},`);
}
lines.push("};", "");
const text = lines.join("\n");

// ---------------------------------------------------------------------------------------------
// FALLBACK ART (src/fallback/README.md, docs/versions.md): our own remakes of art an OLDER build
// of the game lacks. Unlike an icon above, a file's place in `src/fallback/art/` IS its WC3
// path — `UI/Console/Human/HumanUITile05.png` is served as `UI\Console\Human\HumanUITile05.blp`
// — so nothing here has to know what any of it is.

const FALLBACK = join(REPO, "src", "fallback", "art");
const FALLBACK_OUT = join(REPO, "src", "fallback", "art.ts");
const FALLBACK_PATHS = join(REPO, "src", "fallback", "paths.ts");

function pngsUnder(dir, rel = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (e.isDirectory()) out.push(...pngsUnder(join(dir, e.name), `${rel}${e.name}\\`));
    else if (/\.png$/i.test(e.name)) out.push({ file: join(dir, e.name), path: `${rel}${e.name.replace(/\.png$/i, ".blp")}` });
  }
  return out;
}

const fallback = pngsUnder(FALLBACK);
const fallbackText = [
  "// GENERATED by tools/patch-art.mjs from the PNGs under src/fallback/art/ — do not edit by hand.",
  "// OpenWar3's OWN remakes of art an older build of the game lacks (src/fallback/README.md), as",
  "// BLP1 (base64), keyed on the WC3 path each is served at by FallbackArtDataSource. Loaded only",
  "// by an install that lacks one of them (src/vfs/fallbackArt.ts).",
  "",
  "export const FALLBACK_ART: Record<string, string> = {",
  ...fallback.map(({ file, path }) => `  ${JSON.stringify(path)}: ${JSON.stringify(encodeBlp(decodePng(readFileSync(file))).toString("base64"))},`),
  "};",
  "",
].join("\n");
const pathsText = [
  "// GENERATED by tools/patch-art.mjs — the WC3 paths src/fallback/art/ has a remake for. Small,",
  "// and always loaded: it is what decides whether an install needs the art itself (art.ts).",
  "",
  "export const FALLBACK_ART_PATHS: readonly string[] = [",
  ...fallback.map(({ path }) => `  ${JSON.stringify(path)},`),
  "];",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const stale = [[FALLBACK_OUT, fallbackText], [FALLBACK_PATHS, pathsText]].filter(([f, t]) => (existsSync(f) ? readFileSync(f, "utf8") : "") !== t);
  if (stale.length) {
    console.error("FAIL  src/fallback/art.ts is stale — run `node tools/patch-art.mjs`");
    process.exit(1);
  }
  console.log(`ok    src/fallback/art.ts matches ${fallback.length} PNGs`);
} else {
  writeFileSync(FALLBACK_OUT, fallbackText);
  writeFileSync(FALLBACK_PATHS, pathsText);
  console.log(`wrote src/fallback/art.ts (${fallback.length} remakes)`);
}

if (process.argv.includes("--check")) {
  const have = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (have !== text) {
    console.error("FAIL  src/patches/art.ts is stale — run `node tools/patch-art.mjs`");
    process.exit(1);
  }
  console.log(`ok    src/patches/art.ts matches ${files.length} PNGs`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote src/patches/art.ts (${files.length} icons)`);
}
