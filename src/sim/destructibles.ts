import { PATHING_CELL, type PathingGrid } from "./pathing";

// Stamp pathing footprints onto the grid (plan Phase 5). war3map.wpm encodes only
// TERRAIN pathing (cliffs/water) — destructibles (trees) AND buildings block via
// their own pathing textures (`pathTex`), applied here so units path around them.
//
// WC3 pathing textures carry TWO independent channels (verified against the real
// 1.27a MPQs — e.g. `PathTextures\12x12Simple.tga` for the Barracks):
//   R channel > 0 → UNWALKABLE  (blocks unit movement / collision)
//   B channel > 0 → UNBUILDABLE (blocks *building placement* only — still walkable)
//   G stays 0 → still flyable.
// Production buildings pad their solid red core with a ~2-cell blue-only border:
// unbuildable but walkable. That border is what keeps two buildings' red cores
// spaced apart, leaving the walkable corridor units slip through (Taurens et al.).
// A Farm's texture (`4x4SimpleSolid.tga`) is red+blue to every edge — no border,
// so farms wall. We must therefore keep the two channels separate: stamp red as
// unwalkable (collision) and blue as unbuildable (placement), never collapse them.

export interface Placement {
  id: string;
  x: number;
  y: number;
  /** Facing in radians — a doodad's pathing texture turns with it (see `quarterTurns`).
   *  Omitted for buildings: they always sit axis-aligned on the build grid, and every
   *  building's pathTex is square anyway. */
  angle?: number;
  /** Stamp THIS texture instead of the one `id` would look up — how a destructible placed
   *  dead in the editor takes its `pathTexDeath` (an already-open gate blocks its posts only). */
  pathTex?: string;
}

export interface Footprint {
  w: number;
  h: number;
  blocked: boolean[]; // red channel → UNWALKABLE. row-major [y*w + x]; y=0 = low-Y (bottom) row
  buildBlocked: boolean[]; // blue channel → UNBUILDABLE (a superset of `blocked` for buildings)
}

/** A stamped footprint and the world position it was stamped at — what a pre-placed
 *  building hands to its sim unit so the unit can lift its own collision when it dies. */
export interface PlacedFootprint {
  x: number;
  y: number;
  fp: Footprint;
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
  const decoded = new Map<string, Footprint | null>(); // texPath → the texture as authored
  const turned = new Map<string, Footprint | null>(); // texPath|turns → rotated to a facing
  let stamped = 0;
  for (const p of placements) {
    const texPath = p.pathTex || pathTexOf(p.id);
    if (!texPath) continue;
    const turns = p.angle === undefined ? 0 : quarterTurns(p.angle);
    const key = `${texPath}|${turns}`;
    let fp = turned.get(key);
    if (fp === undefined) {
      let base = decoded.get(texPath);
      if (base === undefined) {
        const bytes = readBytes(texPath);
        base = bytes ? decodePathTex(bytes) : null;
        decoded.set(texPath, base);
      }
      fp = base ? rotateFootprint(base, turns) : null;
      turned.set(key, fp);
    }
    if (fp) {
      stampFootprint(grid, fp, p.x, p.y);
      stamped++;
    }
  }
  return stamped;
}

/**
 * How many 90° turns a pathing texture takes when its doodad faces `angle` (radians).
 *
 * WC3's pathing textures are authored in the World Editor's DEFAULT doodad facing, **270°** —
 * so the turn count is the facing measured off that rest pose, not off 0. That is why every
 * stock destructible named "…_HORIZONTAL" has `fixedRot` 270 and a WIDE texture
 * (`StoneWall1Path.tga`, 10×2) while its "…_VERTICAL" twin is either a tall texture at the
 * same 270 (`StoneWall3Path.tga`, 2×10) or the SAME texture at `fixedRot` 0 — both gates read
 * `Gate1Path.tga` (20×4), and only the facing tells them apart.
 *
 * Verified against the real 1.27a `Units\DestructableData.slk`: applied to every destructible
 * whose name declares HORIZONTAL or VERTICAL it yields the matching shape in **all 76 cases,
 * 0 mismatches** — gates, doors, stone walls, and all four bridge/cliff sizes. It also lands
 * WarChasers' gates across the corridors `war3map.wpm` actually leaves open (a vertical gate
 * at facing 0 seals an east-west corridor 16 cells tall, which needs the 4×20 turn).
 */
export function quarterTurns(angle: number): number {
  const q = Math.round((angle - (3 * Math.PI) / 2) / (Math.PI / 2));
  return ((q % 4) + 4) % 4;
}

/** Rotate a decoded footprint counter-clockwise by `turns` quarter turns (WC3 facings are
 *  CCW from +X). Not a no-op for square textures — `4x4Diag1.tga` and friends are chiral. */
export function rotateFootprint(fp: Footprint, turns: number): Footprint {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return fp;
  const swap = t === 1 || t === 3;
  const w = swap ? fp.h : fp.w;
  const h = swap ? fp.w : fp.h;
  const blocked: boolean[] = new Array(w * h);
  const buildBlocked: boolean[] = new Array(w * h);
  for (let y = 0; y < fp.h; y++) {
    for (let x = 0; x < fp.w; x++) {
      // CCW: 90° sends (x,y) → (h−1−y, x); 180° → (w−1−x, h−1−y); 270° → (y, w−1−x).
      const dx = t === 1 ? fp.h - 1 - y : t === 2 ? fp.w - 1 - x : y;
      const dy = t === 1 ? x : t === 2 ? fp.h - 1 - y : fp.w - 1 - x;
      const src = y * fp.w + x;
      const dst = dy * w + dx;
      blocked[dst] = fp.blocked[src];
      buildBlocked[dst] = fp.buildBlocked[src];
    }
  }
  return { w, h, blocked, buildBlocked };
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
      const i = y * fp.w + x;
      // Red core → unwalkable (units route around it). Blue footprint (a superset:
      // the walkable border) → unbuildable (reserves spacing so the next building
      // can't crowd in and close the walkable corridor between production buildings).
      if (fp.blocked[i]) block ? grid.block(bx + x, by + y) : grid.unblock(bx + x, by + y);
      if (fp.buildBlocked[i]) block ? grid.blockBuild(bx + x, by + y) : grid.unblockBuild(bx + x, by + y);
    }
  }
}

// Decode a WC3 pathing texture (uncompressed 24bpp TGA) into its two channels:
// red → `blocked` (unwalkable), blue → `buildBlocked` (unbuildable). (Rotation
// ignored — blocking footprints are square/symmetric for trees & buildings here.)
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
  const buildBlocked: boolean[] = new Array(w * h);
  for (let row = 0; row < h; row++) {
    const y = topDown ? h - 1 - row : row;
    for (let x = 0; x < w; x++) {
      const i = start + (row * w + x) * stride;
      blocked[y * w + x] = bytes[i + 2] > 127; // BGR order: red is +2 → unwalkable
      buildBlocked[y * w + x] = bytes[i] > 127; // blue is +0 → unbuildable
    }
  }
  return { w, h, blocked, buildBlocked };
}

/** World-unit radius of a footprint's *blocked* region (not the full texture).
 *  WC3 pads pathing textures with empty border cells — e.g. the gold mine's
 *  `16x16Goldmine.tga` only blocks the central 8×8, so its true half-extent is
 *  4 cells (128), not 8 (256). Used to size selection rings and interaction
 *  reach off what actually collides. Returns 0 for an all-clear footprint. */
export function footprintRadius(fp: Footprint): number {
  let minX = fp.w;
  let maxX = -1;
  let minY = fp.h;
  let maxY = -1;
  for (let y = 0; y < fp.h; y++) {
    for (let x = 0; x < fp.w; x++) {
      if (!fp.blocked[y * fp.w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return 0;
  const span = Math.max(maxX - minX + 1, maxY - minY + 1);
  return (span * PATHING_CELL) / 2;
}
