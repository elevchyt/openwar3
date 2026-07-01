import { PATHING_CELL, type PathingGrid } from "./pathing";

// Stamp destructible/doodad pathing onto the grid (plan Phase 5). war3map.wpm
// only encodes TERRAIN pathing (cliffs/water) — trees and other destructibles
// block via their own pathing textures (`pathTex`), applied here so units path
// around them. WC3 pathing textures: R channel > 0 = unwalkable (G stays 0, so
// units still fly over — not relevant to ground movement).

export interface DoodadPlacement {
  id: string;
  x: number;
  y: number;
}

/** Look up a doodad/destructible's pathing texture path by object id. */
export type PathTexLookup = (id: string) => string | undefined;
/** Read raw file bytes (from the mounted install). */
export type ByteReader = (path: string) => Uint8Array | null;

interface Footprint {
  w: number;
  h: number;
  blocked: boolean[]; // row-major, [y*w + x]; y=0 is the low-Y (bottom) row
}

export function stampDestructibles(
  grid: PathingGrid,
  doodads: DoodadPlacement[],
  pathTexOf: PathTexLookup,
  readBytes: ByteReader,
): number {
  const cache = new Map<string, Footprint | null>();
  let stamped = 0;

  for (const d of doodads) {
    const texPath = pathTexOf(d.id);
    if (!texPath) continue;

    let fp = cache.get(texPath);
    if (fp === undefined) {
      const bytes = readBytes(texPath);
      fp = bytes ? decodePathTex(bytes) : null;
      cache.set(texPath, fp);
    }
    if (!fp) continue;

    // Footprint is centred on the doodad; map its bottom-left corner to a cell.
    const [bx, by] = grid.worldToCell(d.x - (fp.w * PATHING_CELL) / 2, d.y - (fp.h * PATHING_CELL) / 2);
    for (let y = 0; y < fp.h; y++) {
      for (let x = 0; x < fp.w; x++) {
        if (fp.blocked[y * fp.w + x]) grid.block(bx + x, by + y);
      }
    }
    stamped++;
  }
  return stamped;
}

// Decode a WC3 pathing texture (uncompressed 24bpp TGA). A pixel blocks walking
// when its red channel is set. (Rotation is ignored — blocking textures are
// square/symmetric for trees; asymmetric gates are a later refinement.)
function decodePathTex(bytes: Uint8Array): Footprint | null {
  if (bytes[2] !== 2) return null; // only uncompressed true-color TGA
  const idLength = bytes[0];
  const w = bytes[12] | (bytes[13] << 8);
  const h = bytes[14] | (bytes[15] << 8);
  const bpp = bytes[16];
  const topDown = (bytes[17] & 0x20) !== 0; // TGA default is bottom-up
  const stride = bpp >> 3;
  const start = 18 + idLength;
  const blocked: boolean[] = new Array(w * h);
  for (let row = 0; row < h; row++) {
    const y = topDown ? h - 1 - row : row; // normalize so y=0 is the bottom row
    for (let x = 0; x < w; x++) {
      const i = start + (row * w + x) * stride;
      blocked[y * w + x] = bytes[i + 2] > 127; // BGR order: red is +2
    }
  }
  return { w, h, blocked };
}
