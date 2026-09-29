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

// ---------------------------------------------------------------------------------------------
// Median cut → 256 colours

function medianCut(rgba, count) {
  const pixels = [];
  for (let i = 0; i < rgba.length; i += 4) pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  let boxes = [pixels];
  const range = (box, c) => {
    let lo = 255, hi = 0;
    for (const p of box) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); }
    return hi - lo;
  };
  while (boxes.length < count) {
    let best = -1, bestSpan = 0, bestChannel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        const span = range(box, c);
        if (span > bestSpan) { bestSpan = span; best = i; bestChannel = c; }
      }
    });
    if (best < 0) break;
    const box = boxes[best].slice().sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  const colours = boxes.map((box) => {
    const sum = [0, 0, 0];
    for (const p of box) for (let c = 0; c < 3; c++) sum[c] += p[c];
    return sum.map((v) => Math.round(v / box.length));
  });
  while (colours.length < count) colours.push([0, 0, 0]);
  return colours;
}

function nearest(colours, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < colours.length; i++) {
    const [cr, cg, cb] = colours[i];
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function downsample({ width, height, rgba }) {
  const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(width - 1, x * 2 + dx), sy = Math.min(height - 1, y * 2 + dy);
        sum += rgba[(sy * width + sx) * 4 + c]; n++;
      }
      out[(y * w + x) * 4 + c] = Math.round(sum / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

/** BLP1, content 1 (paletted), alpha 8, picture type 4, with every mip down to 1×1. */
function encodeBlp(img) {
  const colours = medianCut(img.rgba, 256);
  const mips = [];
  let level = img;
  for (;;) {
    const size = level.width * level.height;
    const data = new Uint8Array(size * 2);
    for (let i = 0; i < size; i++) {
      data[i] = nearest(colours, level.rgba[i * 4], level.rgba[i * 4 + 1], level.rgba[i * 4 + 2]);
      data[size + i] = level.rgba[i * 4 + 3];
    }
    mips.push(data);
    if (level.width === 1 && level.height === 1) break;
    level = downsample(level);
    if (mips.length === 16) break;
  }
  const HEADER = 156, PALETTE = 1024;
  const total = HEADER + PALETTE + mips.reduce((n, m) => n + m.length, 0);
  const out = Buffer.alloc(total);
  out.write("BLP1", 0, "latin1");
  out.writeInt32LE(1, 4); // content: paletted
  out.writeInt32LE(8, 8); // alpha bits
  out.writeInt32LE(img.width, 12);
  out.writeInt32LE(img.height, 16);
  out.writeInt32LE(4, 20); // picture type: indices + alpha
  out.writeInt32LE(1, 24); // has mipmaps
  let at = HEADER + PALETTE;
  mips.forEach((m, i) => {
    out.writeInt32LE(at, 28 + i * 4);
    out.writeInt32LE(m.length, 92 + i * 4);
    out.set(m, at);
    at += m.length;
  });
  colours.forEach(([r, g, b], i) => out.set([b, g, r, 0], HEADER + i * 4)); // BGRA
  return out;
}

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
