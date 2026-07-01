import wpm from "mdx-m3-viewer/dist/cjs/parsers/w3x/wpm";

// Pathing grid from war3map.wpm (plan Phase 5 — move orders that respect pathing).
// The pathing map is 4x the terrain tile grid (32 world units per cell), aligned
// to the terrain's centerOffset. Byte flag bit 0x02 = unwalkable (verified against
// real maps: the dominant ground byte 0x40 has it clear; cliffs/trees/water set it).

export const PATHING_CELL = 32;
const UNWALKABLE = 0x02;

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

export class PathingGrid {
  readonly width: number;
  readonly height: number;
  private flags: Uint8Array;
  private originX: number;
  private originY: number;

  constructor(data: PathingData, centerOffset: readonly [number, number]) {
    this.width = data.width;
    this.height = data.height;
    this.flags = data.flags;
    this.originX = centerOffset[0];
    this.originY = centerOffset[1];
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  walkable(cx: number, cy: number): boolean {
    return this.inBounds(cx, cy) && (this.flags[cy * this.width + cx] & UNWALKABLE) === 0;
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
}
