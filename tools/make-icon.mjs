// The app's icon, in every shape the platforms ask for, derived from ONE source image.
//
//   node tools/make-icon.mjs        → build/icon.png, build/icon.ico, build/icon.icns,
//                                     build/icons/<N>x<N>.png, and the web icons in public/
//
// The source is `art/openwar3-logo.png` — OpenWar3's own wordmark, the one image the project
// carries that no install can supply (it ships zero Blizzard assets, so the icon cannot be one).
// Everything below is DERIVED from it, because the alternative is a hand-made .ico that quietly
// stops matching the .icns: each platform wants its own container and its own set of sizes, and
// only a generated set can be trusted to be the same picture at all of them.
//
//   build/icon.png    1024², what electron-builder reads when a platform has nothing more exact
//   build/icon.ico    Windows (also the NSIS installer's icon) — 16…256
//   build/icon.icns   macOS — the PNG-in-icns types, 16…1024
//   build/icons/      Linux: electron-builder reads this DIRECTORY as an icon SET, one file per
//                     size named `512x512.png`, and it is what lands in the AppImage and in the
//                     hicolor theme the .desktop entry resolves against
//   public/           the web build's favicon and touch icons; these are also what the desktop
//                     window wears on Linux, since `dist/` is what gets packaged and `build/`
//                     never is (electron/main.mjs reads `dist/icon-512.png`)
//
// No image library: a PNG is a header, one deflate stream of filtered rows and three CRCs, an ICO
// is a directory of DIBs, and an ICNS is a length-prefixed list of PNGs. The one thing worth
// caring about is the DOWNSAMPLE — a wordmark at 16 px is nearly all edge — so every resize is a
// box filter in PREMULTIPLIED alpha, which is what keeps the transparent surround from bleeding
// grey into the black outline.

import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "art", "openwar3-logo.png");

/** How much of the square the wordmark spans. It is WIDE (16:9-ish), so width is what fills and
 *  the padding that matters is the pair of hairlines left and right: at 16 px a single pixel of
 *  margin is 6 % of the icon, and losing the outline into the panel edge costs more than it. */
const FILL = 0.96;

// ---------------------------------------------------------------------------- PNG in

/** Decode an 8-bit RGBA, non-interlaced PNG — which is what `art/` holds, and all we need. */
function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, colour = 0, depth = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString("ascii", pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNGs are not read here");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (depth !== 8 || (colour !== 6 && colour !== 2)) {
    throw new Error(`${SOURCE}: need an 8-bit RGB/RGBA PNG, got depth ${depth} colour type ${colour}`);
  }
  const bpp = colour === 6 ? 4 : 3;
  const rows = unfilter(inflateSync(Buffer.concat(idat)), width, height, bpp);
  if (bpp === 4) return { width, height, rgba: rows };
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let i = 0, o = 0; i < rows.length; i += 3, o += 4) {
    rgba[o] = rows[i]; rgba[o + 1] = rows[i + 1]; rgba[o + 2] = rows[i + 2];
  }
  return { width, height, rgba };
}

/** Undo the per-row filter each PNG scanline carries (spec §9). */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;               // the pixel to the left
      const b = y > 0 ? out[o - stride + x] : 0;               // the one above
      const c = x >= bpp && y > 0 ? out[o - stride + x - bpp] : 0; // above-left
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      out[o + x] = v & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- shaping

/** The smallest rectangle holding every pixel that is not fully transparent. The source is drawn
 *  on a transparent field with slack around it; centring the SLACK rather than the mark would
 *  put the logo off-centre in every icon by however much the field is lopsided. */
function tightBox({ width, height, rgba }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error(`${SOURCE} is fully transparent`);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Box-filter resample of a sub-rectangle, in PREMULTIPLIED alpha.
 *
 *  Premultiplied is the whole point: a transparent pixel still carries SOME colour, and averaging
 *  it in straight would drag the black outline towards whatever that is. Weighting each sample by
 *  its own alpha and dividing the result back out means an edge pixel is the colour of the ink
 *  that is actually there, at the coverage it actually has. Every destination pixel integrates
 *  the exact source box it covers, fractional edges included, so no source pixel is skipped —
 *  which a nearest-neighbour or a 2×2 tap would do at 16 px and lose whole strokes to. */
function resample(src, sw, box, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const scaleX = box.width / dw, scaleY = box.height / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = box.y + y * scaleY, y1 = y0 + scaleY;
    for (let x = 0; x < dw; x++) {
      const x0 = box.x + x * scaleX, x1 = x0 + scaleX;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const w = wy * (Math.min(x1, px + 1) - Math.max(x0, px));
          if (w <= 0) continue;
          const i = (py * sw + px) * 4;
          const alpha = src[i + 3] * w;
          r += src[i] * alpha; g += src[i + 1] * alpha; b += src[i + 2] * alpha;
          a += alpha; area += w;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) { dst[o] = Math.round(r / a); dst[o + 1] = Math.round(g / a); dst[o + 2] = Math.round(b / a); }
      dst[o + 3] = area > 0 ? Math.min(255, Math.round(a / area)) : 0;
    }
  }
  return dst;
}

/** One square icon: the wordmark scaled to `FILL` of the width and centred, on transparency. */
function square(source, box, size) {
  const w = Math.max(1, Math.round(size * FILL));
  const h = Math.max(1, Math.round((w * box.height) / box.width));
  const mark = resample(source.rgba, source.width, box, w, h);
  const canvas = Buffer.alloc(size * size * 4);
  const ox = (size - w) >> 1, oy = (size - h) >> 1;
  for (let y = 0; y < h; y++) {
    mark.copy(canvas, ((y + oy) * size + ox) * 4, y * w * 4, (y + 1) * w * 4);
  }
  return canvas;
}

// ---------------------------------------------------------------------------- PNG out

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0, p = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    rgba.copy(raw, p, y * size * 4, (y + 1) * size * 4);
    p += size * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------- ICO / ICNS

/** One ICO image as a 32-bit DIB: BITMAPINFOHEADER, then bottom-up BGRA rows, then the 1-bit AND
 *  mask. The mask is legacy — the alpha channel already says what is transparent — but it is not
 *  optional: the header's doubled height counts its rows, and a reader that trusts the mask (the
 *  NSIS installer among them) draws a black square without it. */
function dib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR rows + AND rows
  header.writeUInt16LE(1, 12);      // planes
  header.writeUInt16LE(32, 14);     // bits per pixel
  const xor = Buffer.alloc(size * size * 4);
  const stride = ((size + 31) >> 5) << 2; // the mask's rows are padded to 32 bits
  const mask = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (src + x) * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([header, xor, mask]);
}

/** An .ico: a directory of entries, each a DIB — except 256, which is stored as a PNG because the
 *  directory records a size in ONE byte and 256 is written there as 0. */
function ico(images) {
  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  const blobs = [];
  let offset = dir.length;
  images.forEach(({ size, rgba }, i) => {
    const data = size >= 256 ? encodePng(rgba, size) : dib(rgba, size);
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);   // planes
    dir.writeUInt16LE(32, e + 6);  // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
    blobs.push(data);
  });
  return Buffer.concat([dir, ...blobs]);
}

/** An .icns: `icns`, a total length, then one length-prefixed PNG per named slot. The names are
 *  Apple's and each is a SIZE (`icp4` = 16, `ic10` = 1024); the `ic11`…`ic14` set are the retina
 *  twins of the four below them, which is why two slots can hold the same picture. */
const ICNS_SLOTS = [
  ["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128],
  ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024],
];
function icns(pngFor) {
  const parts = ICNS_SLOTS.map(([type, size]) => {
    const png = pngFor(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------- writing it out

const write = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`${path.slice(root.length + 1)} (${(bytes.length / 1024).toFixed(1)} kB)`);
};

const source = decodePng(readFileSync(SOURCE));
const box = tightBox(source);

/** Every size any output asks for, rendered once. */
const SIZES = [16, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
const bitmap = new Map(SIZES.map((size) => [size, square(source, box, size)]));
const at = (size) => ({ size, rgba: bitmap.get(size) });
const pngAt = (size) => encodePng(bitmap.get(size), size);

// electron-builder's fallback for any platform with nothing more exact, and the master it warns
// about if it is under 512².
write(join(root, "build", "icon.png"), pngAt(1024));
write(join(root, "build", "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map(at)));
write(join(root, "build", "icon.icns"), icns(pngAt));
// The Linux SET. NOT `build/icon*.png` in one directory: the name `icons` is what electron-builder
// reads as a set, and the file names are the sizes it installs them under.
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  write(join(root, "build", "icons", `${size}x${size}.png`), pngAt(size));
}
// The web build's icons — served from `public/`, copied into `dist/`, and so the only ones that
// are inside the packaged app (electron/main.mjs dresses the Linux window out of `icon-512.png`).
write(join(root, "public", "favicon.ico"), ico([16, 24, 32, 48].map(at)));
write(join(root, "public", "icon-192.png"), pngAt(192));
write(join(root, "public", "icon-512.png"), pngAt(512));
write(join(root, "public", "apple-touch-icon.png"), pngAt(180));
