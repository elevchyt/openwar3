// RGBA → a BLP1 the engine reads — for the icons OpenWar3 makes itself (docs/icons.md).
//
// Two callers: tools/patch-art.mjs (our own drawn icons, baked into src/patches/art.ts) and
// DerivedArtDataSource (src/vfs/derivedArt.ts), which computes the icons a later patch names and
// a 1.30.4 install lacks — a PASBTN from its BTN — once the install is mounted.
//
// The format is the plain one mdx-m3-viewer's BlpImage reads: BLP1, content 1 (PALETTED), 8-bit
// alpha, picture type 4, with the full mip chain. 256 colours is ample for a 64×64 icon; the
// palette is a median cut over the icon's own pixels, which is what keeps a derived icon within a
// couple of levels of its source (measured: 2 / 255 mean against the real PASBTN art).

export interface Rgba {
  width: number;
  height: number;
  /** width × height × 4 bytes, row-major, RGBA. */
  data: Uint8Array | Uint8ClampedArray;
}

function medianCut(rgba: Rgba["data"], count: number): number[][] {
  const pixels: number[][] = [];
  for (let i = 0; i < rgba.length; i += 4) pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  const boxes: number[][][] = [pixels];
  const span = (box: number[][], c: number): number => {
    let lo = 255, hi = 0;
    for (const p of box) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); }
    return hi - lo;
  };
  while (boxes.length < count) {
    let best = -1, bestSpan = 0, bestChannel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        const s = span(box, c);
        if (s > bestSpan) { bestSpan = s; best = i; bestChannel = c; }
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

function nearest(colours: number[][], r: number, g: number, b: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < colours.length; i++) {
    const [cr, cg, cb] = colours[i];
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function downsample(img: Rgba): Rgba {
  const w = Math.max(1, img.width >> 1), h = Math.max(1, img.height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(img.width - 1, x * 2 + dx), sy = Math.min(img.height - 1, y * 2 + dy);
        sum += img.data[(sy * img.width + sx) * 4 + c];
        n++;
      }
      out[(y * w + x) * 4 + c] = Math.round(sum / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** BLP1, content 1 (paletted), alpha 8, picture type 4, with every mip down to 1×1. */
export function encodeBlp(img: Rgba): Uint8Array {
  const colours = medianCut(img.data, 256);
  const mips: Uint8Array[] = [];
  let level = img;
  for (;;) {
    const size = level.width * level.height;
    const data = new Uint8Array(size * 2);
    for (let i = 0; i < size; i++) {
      data[i] = nearest(colours, level.data[i * 4], level.data[i * 4 + 1], level.data[i * 4 + 2]);
      data[size + i] = level.data[i * 4 + 3];
    }
    mips.push(data);
    if ((level.width === 1 && level.height === 1) || mips.length === 16) break;
    level = downsample(level);
  }
  const HEADER = 156, PALETTE = 1024;
  const out = new Uint8Array(HEADER + PALETTE + mips.reduce((n, m) => n + m.length, 0));
  const view = new DataView(out.buffer);
  out.set([0x42, 0x4c, 0x50, 0x31], 0); // "BLP1"
  view.setInt32(4, 1, true); // content: paletted
  view.setInt32(8, 8, true); // alpha bits
  view.setInt32(12, img.width, true);
  view.setInt32(16, img.height, true);
  view.setInt32(20, 4, true); // picture type: indices + alpha
  view.setInt32(24, 1, true); // has mipmaps
  let at = HEADER + PALETTE;
  mips.forEach((m, i) => {
    view.setInt32(28 + i * 4, at, true);
    view.setInt32(92 + i * 4, m.length, true);
    out.set(m, at);
    at += m.length;
  });
  colours.forEach(([r, g, b], i) => out.set([b, g, r, 0], HEADER + i * 4)); // BGRA
  return out;
}
