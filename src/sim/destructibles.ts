import { PATHING_CELL, type PathingGrid } from "./pathing";

// Stamp pathing footprints onto the grid (plan Phase 5). war3map.wpm encodes only
// TERRAIN pathing (cliffs/water) — destructibles (trees) AND buildings block via
// their own pathing textures (`pathTex`), applied here so units path around them.
// WC3 pathing textures: R channel > 0 = unwalkable (G stays 0 → still flyable).

export interface Placement {
  id: string;
  x: number;
  y: number;
}

export interface Footprint {
  w: number;
  h: number;
  blocked: boolean[]; // row-major [y*w + x]; y=0 is the low-Y (bottom) row
}

export type PathTexLookup = (id: string) => string | undefined;
export type ByteReader = (path: string) => Uint8Array | null;

/** Stamp footprints for a set of placements (destructibles or building units). */
export function stampFootprints(
  grid: PathingGrid,
  placements: Placement[],
  pathTexOf: PathTexLookup,
  readBytes: ByteReader,
): number {
  const cache = new Map<string, Footprint | null>();
  let stamped = 0;
  for (const p of placements) {
    const texPath = pathTexOf(p.id);
    if (!texPath) continue;
    let fp = cache.get(texPath);
    if (fp === undefined) {
      const bytes = readBytes(texPath);
      fp = bytes ? decodePathTex(bytes) : null;
      cache.set(texPath, fp);
    }
    if (fp) {
      stampFootprint(grid, fp, p.x, p.y);
      stamped++;
    }
  }
  return stamped;
}

/** Stamp one decoded footprint centred on a world position. */
export function stampFootprint(grid: PathingGrid, fp: Footprint, worldX: number, worldY: number): void {
  applyFootprint(grid, fp, worldX, worldY, true);
}

/** Clear a previously-stamped footprint (felled tree, collapsed mine). */
export function unstampFootprint(grid: PathingGrid, fp: Footprint, worldX: number, worldY: number): void {
  applyFootprint(grid, fp, worldX, worldY, false);
}

function applyFootprint(grid: PathingGrid, fp: Footprint, worldX: number, worldY: number, block: boolean): void {
  const [bx, by] = grid.worldToCell(worldX - (fp.w * PATHING_CELL) / 2, worldY - (fp.h * PATHING_CELL) / 2);
  for (let y = 0; y < fp.h; y++) {
    for (let x = 0; x < fp.w; x++) {
      if (fp.blocked[y * fp.w + x]) {
        if (block) grid.block(bx + x, by + y);
        else grid.unblock(bx + x, by + y);
      }
    }
  }
}

// Decode a WC3 pathing texture (uncompressed 24bpp TGA). A pixel blocks walking
// when its red channel is set. (Rotation ignored — blocking footprints are
// square/symmetric for trees & buildings here.)
export function decodePathTex(bytes: Uint8Array): Footprint | null {
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
    const y = topDown ? h - 1 - row : row;
    for (let x = 0; x < w; x++) {
      const i = start + (row * w + x) * stride;
      blocked[y * w + x] = bytes[i + 2] > 127; // BGR order: red is +2
    }
  }
  return { w, h, blocked };
}
