// The app's icon, drawn from scratch.
//
//   node tools/make-icon.mjs          → build/icon.png, the chosen variant
//   node tools/make-icon.mjs --all    → build/icons/<name>.png, every variant, to choose from
//
// It is CODE rather than a file in the repo for one reason: OpenWar3 ships zero Blizzard assets,
// and the icon is the one image a packaged app must carry that no install can supply. Drawing it
// here means what ships is provably ours — a reader can see where every pixel came from — and
// nobody can quietly drop a familiar-looking .png in beside it later.
//
// Every mark below is abstract and borrows nothing from anybody. No image library: a PNG is a
// header, one deflate stream of filtered rows, and three CRCs.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one that ships. Change this word to change the app's icon. */
const CHOSEN = "chevron";

const SIZE = 512;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const GOLD = [0xf2, 0xc4, 0x4a];
const GOLD_DEEP = [0xc9, 0x91, 0x1f];
const ICE = [0x9d, 0xd7, 0xf0];
const PLATE = [0x14, 0x17, 0x21];
const PLATE_EDGE = [0x2c, 0x33, 0x47];

/** Smooth 0→1 across `edge ± half`, so no line in here has a staircase on it. */
const band = (d, edge, half = 1.5) => Math.min(1, Math.max(0, (edge + half - d) / (2 * half)));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
/** Distance from a point to the segment ab — every straight stroke below is one of these. */
function toSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The plate every mark sits on: a rounded square, darker at its edge so it is not flat. */
function plate(cx, cy) {
  const square = Math.max(Math.abs(cx), Math.abs(cy));
  const corner = Math.hypot(Math.max(Math.abs(cx) - 176, 0), Math.max(Math.abs(cy) - 176, 0));
  const alpha = band(corner, 60) * band(square, 236, 2);
  return { alpha, rgb: mix(PLATE_EDGE, PLATE, band(Math.hypot(cx, cy), 150, 120)) };
}

/** Each variant paints ON the plate: given a point and the colour so far, return the colour. */
const VARIANTS = {
  // A ring with a chevron rising inside it. Reads as an arrow and as a rooftop.
  chevron(cx, cy, rgb) {
    const r = Math.hypot(cx, cy);
    rgb = mix(rgb, GOLD, band(Math.abs(r - 150), 11) * band(r, 200, 2));
    const arm = Math.abs(Math.abs(cx) - (cy + 74) * 0.85);
    const on = cy > -78 && cy < 66 && Math.abs(cx) < 108 ? band(arm, 15) : 0;
    return mix(rgb, GOLD, on);
  },

  // A shield: square shoulders, a full belly and a point, with a chevron notched into it.
  shield(cx, cy, rgb) {
    const top = -156, tip = 168;
    const t = (cy - top) / (tip - top);
    if (t < 0 || t > 1) return rgb;
    // A heater shield's width: broad across the shoulders, fullest a third of the way down, and
    // gone at the point. `cos^0.55` is the curve that keeps the belly without a waist.
    const half = 142 * Math.pow(Math.cos(t * Math.PI / 2), 0.55);
    // The shoulders are eased rather than square-cut, or the corners read as a torn edge.
    const shoulder = band(Math.hypot(Math.max(Math.abs(cx) - (half - 26), 0), Math.max(top + 26 - cy, 0)), 26);
    const inside = Math.min(band(Math.abs(cx), half, 2), cy < top + 26 ? shoulder : 1);
    const edge = inside * (1 - Math.min(band(Math.abs(cx), half - 17, 2), cy < top + 43 ? band(Math.hypot(Math.max(Math.abs(cx) - (half - 43), 0), Math.max(top + 43 - cy, 0)), 26) : 1));
    rgb = mix(rgb, mix(PLATE, GOLD_DEEP, 0.2), inside);
    rgb = mix(rgb, GOLD, edge);
    const arm = Math.abs(Math.abs(cx) - (cy + 26) * 0.72);
    return mix(rgb, GOLD, cy > -60 && cy < 58 && Math.abs(cx) < 84 ? band(arm, 12) * inside : 0);
  },

  // An orb: lit from within, with a thin ring holding it.
  orb(cx, cy, rgb) {
    const r = Math.hypot(cx, cy * 1.02);
    const glow = band(r, 120, 90);
    rgb = mix(rgb, mix(GOLD_DEEP, GOLD, band(Math.hypot(cx, cy + 34), 44, 60)), glow * 0.95);
    rgb = mix(rgb, GOLD, band(Math.abs(r - 150), 9) * band(r, 190, 2));
    return rgb;
  },

  // A carved rune: one stem and two struck arms, the shapes a stone glyph is made of.
  rune(cx, cy, rgb) {
    const w = 14;
    let on = band(toSegment(cx, cy, 0, -132, 0, 132), w);
    on = Math.max(on, band(toSegment(cx, cy, 0, -34, 96, -122), w));
    on = Math.max(on, band(toSegment(cx, cy, 0, 34, -96, 122), w));
    on = Math.max(on, band(toSegment(cx, cy, -84, -118, -84, -46), w * 0.8));
    on = Math.max(on, band(toSegment(cx, cy, 84, 46, 84, 118), w * 0.8));
    return mix(rgb, GOLD, on);
  },

  // A portal: arcs closing on a cold bright centre. The one that is not gold.
  portal(cx, cy, rgb) {
    const r = Math.hypot(cx, cy);
    const a = Math.atan2(cy, cx);
    // Each arc is broken at a different angle, so the eye reads depth rather than three circles.
    for (const [radius, gap, width] of [[168, 0.55, 9], [124, 2.2, 11], [80, 3.9, 13]]) {
      const open = Math.abs(((a - gap + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.42;
      if (open) rgb = mix(rgb, ICE, band(Math.abs(r - radius), width * 0.5));
    }
    // A cold core rather than a grey one: white at the centre, ice at its edge.
    return mix(rgb, mix(ICE, [0xff, 0xff, 0xff], band(r, 14, 18)), band(r, 34, 20));
  },

  // A blade, point up: a long taper, a crossguard, a short grip and a pommel.
  blade(cx, cy, rgb) {
    const taper = cy > -178 && cy < 62 ? 44 * Math.min(1, (cy + 178) / 216) : 0;
    let on = taper ? band(Math.abs(cx), taper, 2) * band(cy, 58, 3) : 0;
    on = Math.max(on, band(toSegment(cx, cy, -104, 80, 104, 80), 13));  // crossguard
    on = Math.max(on, band(toSegment(cx, cy, 0, 92, 0, 146), 15));      // grip
    on = Math.max(on, band(Math.hypot(cx, cy - 158), 24));              // pommel
    rgb = mix(rgb, mix(GOLD_DEEP, GOLD, 0.5), on);
    // A highlight down the blade's spine, so it is metal rather than a triangle.
    return mix(rgb, [0xff, 0xf4, 0xd6], taper ? band(Math.abs(cx), 5) * band(cy, 48, 3) * 0.8 : 0);
  },
};

function render(name) {
  const paint = VARIANTS[name];
  if (!paint) throw new Error(`no icon variant "${name}" — have ${Object.keys(VARIANTS).join(", ")}`);
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let p = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const cx = x - SIZE / 2 + 0.5, cy = y - SIZE / 2 + 0.5;
      const base = plate(cx, cy);
      if (base.alpha <= 0) { p += 4; continue; }
      const [r, g, b] = paint(cx, cy, base.rgb);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = Math.round(255 * base.alpha);
    }
  }
  return png(raw);
}

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
function png(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };

if (process.argv.includes("--all")) {
  for (const name of Object.keys(VARIANTS)) {
    write(join(root, "build", "icons", `${name}.png`), render(name));
    console.log(`build/icons/${name}.png`);
  }
} else {
  write(join(root, "build", "icon.png"), render(CHOSEN));
  console.log(`build/icon.png (${CHOSEN}, ${SIZE}×${SIZE})`);
}
