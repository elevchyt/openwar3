// Strip the TrueType HINTING out of a font, in memory, before it is registered (gameFont.ts).
//
// Why: the archives' faces are early-90s TrueType with full bytecode hinting — Friz Quadrata
// carries `fpgm`/`prep`/`cvt ` programs, per-glyph instructions and an `hdmx` table, and no
// `gasp` table to say how it wants to be smoothed. Chromium draws text very differently per OS:
//   • Linux (FreeType) renders with "slight" hinting, which leaves the stems alone — the letters
//     keep the weight the outlines were drawn with.
//   • Windows (Skia over DirectWrite) treats a font whose `maxp.maxSizeOfInstructions` is non-zero
//     as HINTED and renders it GDI-style: the instructions snap every stem to a whole pixel,
//     which at HUD/tooltip sizes rounds Friz's stems DOWN to one pixel. Light text on a dark
//     panel then reads visibly THINNER than the same build on Linux.
// An unhinted font takes Skia's other branch on Windows (natural, symmetric smoothing at the true
// size), which is what Linux draws. The OUTLINES are untouched, glyph for glyph, so this changes
// no shape and no advance width — only whether the rasteriser may bend them to the pixel grid.
//
// The file is the player's own and is never written back; this is a copy handed to FontFace.
// Anything unexpected in the table layout returns null and the caller keeps the original bytes.

/** Tables that exist only to drive or cache the hinting. `gasp` goes too: Nimrod MT's asks for
 *  NO smoothing between 9 and 22 ppem, which Windows honours (aliased, jagged Cyrillic). */
const HINT_TABLES = new Set(["fpgm", "prep", "cvt ", "hdmx", "LTSH", "VDMX", "gasp"]);

// Simple-glyph point flags (OpenType spec, 'glyf' table).
const X_SHORT_VECTOR = 0x02;
const Y_SHORT_VECTOR = 0x04;
const REPEAT_FLAG = 0x08;
const X_IS_SAME = 0x10;
const Y_IS_SAME = 0x20;

// Composite-glyph component flags (OpenType spec, 'glyf' table).
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;

const tagAt = (v: DataView, o: number): string =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

const pad4 = (n: number): number => (n + 3) & ~3;

/** The sfnt table checksum:big-endian uint32 sum over the zero-padded table. */
function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array(pad4(bytes.length));
  padded.set(bytes);
  const v = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

/** One glyph without its instructions. A simple glyph drops its instruction block; a composite
 *  drops the trailing one and clears WE_HAVE_INSTRUCTIONS on its last component. */
function stripGlyph(src: Uint8Array): Uint8Array {
  if (src.length === 0) return src; // an empty glyph (space) has no header at all
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const contours = v.getInt16(0);
  if (contours >= 0) {
    const lenAt = 10 + 2 * contours;
    const instrLen = v.getUint16(lenAt);
    // Walk the point data to its true end, so the slot's old padding isn't carried over.
    const points = contours ? v.getUint16(lenAt - 2) + 1 : 0;
    let o = lenAt + 2 + instrLen;
    let xBytes = 0;
    let yBytes = 0;
    for (let p = 0; p < points; ) {
      const flag = v.getUint8(o++);
      const times = flag & REPEAT_FLAG ? v.getUint8(o++) + 1 : 1;
      xBytes += times * (flag & X_SHORT_VECTOR ? 1 : flag & X_IS_SAME ? 0 : 2);
      yBytes += times * (flag & Y_SHORT_VECTOR ? 1 : flag & Y_IS_SAME ? 0 : 2);
      p += times;
    }
    const end = o + xBytes + yBytes;
    const out = new Uint8Array(end - instrLen);
    out.set(src.subarray(0, lenAt));
    // instructionLength is now 0 — the new buffer is already zeroed there
    out.set(src.subarray(lenAt + 2 + instrLen, end), lenAt + 2);
    return out;
  }
  const out = src.slice();
  const ov = new DataView(out.buffer);
  let o = 10;
  let flags: number;
  do {
    flags = ov.getUint16(o);
    if (!(flags & MORE_COMPONENTS) && flags & WE_HAVE_INSTRUCTIONS) {
      ov.setUint16(o, flags & ~WE_HAVE_INSTRUCTIONS);
    }
    o += 4 + (flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
    if (flags & WE_HAVE_A_SCALE) o += 2;
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) o += 4;
    else if (flags & WE_HAVE_A_TWO_BY_TWO) o += 8;
  } while (flags & MORE_COMPONENTS);
  return out.subarray(0, o);
}

/** `bytes` as an unhinted TrueType font, or null when it isn't a plain glyf-outline font. */
export function unhintTrueType(bytes: Uint8Array): Uint8Array | null {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = v.getUint32(0);
    if (version !== 0x00010000 && version !== 0x74727565 /* 'true' */) return null;
    const numTables = v.getUint16(4);
    const tables = new Map<string, Uint8Array>();
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + 16 * i;
      const off = v.getUint32(rec + 8);
      tables.set(tagAt(v, rec), bytes.subarray(off, off + v.getUint32(rec + 12)));
    }
    const head = tables.get("head")?.slice();
    const maxp = tables.get("maxp")?.slice();
    const loca = tables.get("loca");
    const glyf = tables.get("glyf");
    if (!head || !maxp || !loca || !glyf || maxp.length < 32) return null;
    const hv = new DataView(head.buffer);
    const mv = new DataView(maxp.buffer);
    const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
    const numGlyphs = mv.getUint16(4);
    const longLoca = hv.getInt16(50) === 1;
    const locaAt = (i: number): number => (longLoca ? lv.getUint32(i * 4) : lv.getUint16(i * 2) * 2);

    // Rebuild glyf + a LONG loca (glyphs shrink unevenly, so the short form's even-offset rule
    // would need padding to 2 anyway; 4 keeps every glyph aligned).
    const glyphs: Uint8Array[] = [];
    let glyfLen = 0;
    for (let g = 0; g < numGlyphs; g++) {
      const glyph = stripGlyph(glyf.subarray(locaAt(g), locaAt(g + 1)));
      glyphs.push(glyph);
      glyfLen += pad4(glyph.length);
    }
    const newGlyf = new Uint8Array(glyfLen);
    const newLoca = new Uint8Array(4 * (numGlyphs + 1));
    const nlv = new DataView(newLoca.buffer);
    let at = 0;
    glyphs.forEach((glyph, g) => {
      nlv.setUint32(g * 4, at);
      newGlyf.set(glyph, at);
      at += pad4(glyph.length);
    });
    nlv.setUint32(numGlyphs * 4, at);

    hv.setInt16(50, 1); // indexToLocFormat: long
    hv.setUint32(8, 0); // checkSumAdjustment, recomputed below
    mv.setUint16(26, 0); // maxSizeOfInstructions — the field Skia reads to call a font "hinted"
    tables.set("head", head);
    tables.set("maxp", maxp);
    tables.set("loca", newLoca);
    tables.set("glyf", newGlyf);
    for (const tag of HINT_TABLES) tables.delete(tag);

    // Reassemble: tags sorted (the directory must be), every table 4-aligned.
    const tags = [...tables.keys()].sort();
    const n = tags.length;
    let size = 12 + 16 * n;
    for (const t of tags) size += pad4(tables.get(t)!.length);
    const out = new Uint8Array(size);
    const ov = new DataView(out.buffer);
    const log2 = Math.floor(Math.log2(n));
    ov.setUint32(0, 0x00010000);
    ov.setUint16(4, n);
    ov.setUint16(6, 16 * 2 ** log2);
    ov.setUint16(8, log2);
    ov.setUint16(10, 16 * n - 16 * 2 ** log2);
    let off = 12 + 16 * n;
    let headOff = 0;
    tags.forEach((tag, i) => {
      const data = tables.get(tag)!;
      const rec = 12 + 16 * i;
      for (let c = 0; c < 4; c++) ov.setUint8(rec + c, tag.charCodeAt(c));
      ov.setUint32(rec + 4, checksum(data));
      ov.setUint32(rec + 8, off);
      ov.setUint32(rec + 12, data.length);
      out.set(data, off);
      if (tag === "head") headOff = off;
      off += pad4(data.length);
    });
    ov.setUint32(headOff + 8, (0xb1b0afba - checksum(out)) >>> 0);
    return out;
  } catch {
    return null;
  }
}
