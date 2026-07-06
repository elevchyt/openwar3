import wpm from "mdx-m3-viewer/dist/cjs/parsers/w3x/wpm";

// Pathing grid from war3map.wpm (plan Phase 5 — move orders that respect pathing).
// The pathing map is 4x the terrain tile grid (32 world units per cell), aligned
// to the terrain's centerOffset. Byte flag bits (verified against real maps, e.g.
// (2)EchoIsles.w3m): 0x02 = unwalkable, 0x08 = unbuildable. The dominant ground byte
// 0x40 has both clear; every unwalkable cell also sets 0x08, plus ~14% of walkable
// cells set 0x08 alone (walkable-but-unbuildable margins/slopes). Buildings stamp
// 0x08 over their full pathTex footprint to reserve build spacing (see destructibles.ts).

export const PATHING_CELL = 32;
const UNWALKABLE = 0x02;
const UNBUILDABLE = 0x08;

export interface PathingData {
  width: number;
  height: number;
  flags: Uint8Array; // row-major, length width*height
}

export function parseWpm(bytes: Uint8Array): PathingData {
  const file = new wpm.File();
  file.load(bytes);
  return { width: file.size[0], height: file.size[1], flags: file.pathing };
}

// WC3 reserves an n×n block of pathing cells per stationary unit, keyed off
// collision size (hive tutorial 154558: 0–15 → 1×1, 16–31 → 2×2, 32–47 → 3×3,
// 48+ → 4×4). This is what makes surrounds work: stopped units block cells.
export function footprintCells(collision: number): number {
  if (collision <= 0) return 0;
  if (collision < 16) return 1;
  if (collision < 32) return 2;
  if (collision < 48) return 3;
  return 4;
}

export class PathingGrid {
  readonly width: number;
  readonly height: number;
  private flags: Uint8Array;
  private originX: number;
  private originY: number;
  // Dynamic reservation layer (stationary units). Counted, so overlapping
  // reservations (rare, e.g. spawn overflow) release cleanly.
  private reservations: Uint16Array | null = null;

  constructor(data: PathingData, centerOffset: readonly [number, number]) {
    this.width = data.width;
    this.height = data.height;
    this.flags = data.flags;
    this.originX = centerOffset[0];
    this.originY = centerOffset[1];
  }

  /** Reserve an n×n cell block whose origin (low corner) is (cx0, cy0). */
  reserve(cx0: number, cy0: number, n: number): void {
    this.reservations ??= new Uint16Array(this.width * this.height);
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        if (this.inBounds(x, y)) this.reservations[y * this.width + x]++;
      }
    }
  }

  release(cx0: number, cy0: number, n: number): void {
    if (!this.reservations) return;
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        const i = y * this.width + x;
        if (this.inBounds(x, y) && this.reservations[i] > 0) this.reservations[i]--;
      }
    }
  }

  isReserved(cx: number, cy: number): boolean {
    return this.reservations !== null && this.inBounds(cx, cy) && this.reservations[cy * this.width + cx] > 0;
  }

  /** Snap a world position so an n×n footprint aligns to the cell grid: odd
   *  footprints centre on a cell centre, even ones on a cell corner (WC3). */
  snapForFootprint(wx: number, wy: number, n: number): [number, number] {
    if (n <= 0) return [wx, wy];
    return this.snapForFootprintRect(wx, wy, n, n);
  }

  /** Rectangular variant for building footprints (w×h cells). */
  snapForFootprintRect(wx: number, wy: number, w: number, h: number): [number, number] {
    const snap = (v: number, origin: number, cells: number) =>
      cells % 2 === 1
        ? origin + (Math.floor((v - origin) / PATHING_CELL) + 0.5) * PATHING_CELL
        : origin + Math.round((v - origin) / PATHING_CELL) * PATHING_CELL;
    return [snap(wx, this.originX, w), snap(wy, this.originY, h)];
  }

  /** Origin (low corner) cell of an n×n footprint centred at world (wx, wy).
   *  Positions should be snapped via snapForFootprint() first. */
  footprintOrigin(wx: number, wy: number, n: number): [number, number] {
    if (n % 2 === 1) {
      const [cx, cy] = this.worldToCell(wx, wy);
      return [cx - (n - 1) / 2, cy - (n - 1) / 2];
    }
    return [
      Math.round((wx - this.originX) / PATHING_CELL) - n / 2,
      Math.round((wy - this.originY) / PATHING_CELL) - n / 2,
    ];
  }

  /** World-space origin (low corner) = the map's centerOffset. Used to align an
   *  independent overlay grid (e.g. the fog-of-war vision map) to the same space. */
  get origin(): readonly [number, number] {
    return [this.originX, this.originY];
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  walkable(cx: number, cy: number): boolean {
    return this.inBounds(cx, cy) && (this.flags[cy * this.width + cx] & UNWALKABLE) === 0;
  }

  /** True if a building may be founded on this cell: not unbuildable *and* not
   *  unwalkable terrain (cliffs/water are both). Placement tests this over a
   *  building's full pathTex footprint; movable-unit reservations are ignored
   *  (our own units scatter when the builder arrives), matching WC3. */
  buildable(cx: number, cy: number): boolean {
    return this.inBounds(cx, cy) && (this.flags[cy * this.width + cx] & (UNWALKABLE | UNBUILDABLE)) === 0;
  }

  /** Mark a cell unwalkable — used to stamp destructible (tree) footprints. */
  block(cx: number, cy: number): void {
    if (this.inBounds(cx, cy)) this.flags[cy * this.width + cx] |= UNWALKABLE;
  }

  /** Clear a stamped cell (felled tree / collapsed mine footprint). */
  unblock(cx: number, cy: number): void {
    if (this.inBounds(cx, cy)) this.flags[cy * this.width + cx] &= ~UNWALKABLE;
  }

  /** Mark/clear a cell unbuildable — building footprints' full (blue) extent, so
   *  the next building can't crowd in and close the walkable corridor between them. */
  blockBuild(cx: number, cy: number): void {
    if (this.inBounds(cx, cy)) this.flags[cy * this.width + cx] |= UNBUILDABLE;
  }

  unblockBuild(cx: number, cy: number): void {
    if (this.inBounds(cx, cy)) this.flags[cy * this.width + cx] &= ~UNBUILDABLE;
  }

  worldToCell(wx: number, wy: number): [number, number] {
    return [
      Math.floor((wx - this.originX) / PATHING_CELL),
      Math.floor((wy - this.originY) / PATHING_CELL),
    ];
  }

  cellToWorld(cx: number, cy: number): [number, number] {
    return [this.originX + (cx + 0.5) * PATHING_CELL, this.originY + (cy + 0.5) * PATHING_CELL];
  }

  /** Nearest walkable cell to (cx,cy), searched in growing rings. Null if none near. */
  nearestWalkable(cx: number, cy: number, maxRadius = 32): [number, number] | null {
    if (this.walkable(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (this.walkable(cx + dx, cy + dy)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }

  /** True if an n×n unit footprint centred on (cx,cy) fits entirely on walkable,
   *  unreserved cells. */
  footprintFits(cx: number, cy: number, n: number): boolean {
    if (n <= 1) return this.walkable(cx, cy) && !this.isReserved(cx, cy);
    const half = n >> 1;
    for (let y = cy - half; y < cy - half + n; y++) {
      for (let x = cx - half; x < cx - half + n; x++) {
        if (!this.walkable(x, y) || this.isReserved(x, y)) return false;
      }
    }
    return true;
  }

  /** Nearest cell (spiralling out from cx,cy) where an n×n footprint fits — for
   *  placing a freshly-trained unit on empty tiles it actually fits on. */
  nearestFit(cx: number, cy: number, n: number, maxRadius = 24): [number, number] | null {
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (this.footprintFits(cx + dx, cy + dy, n)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }
}
