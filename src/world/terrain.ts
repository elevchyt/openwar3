import w3e from "mdx-m3-viewer/dist/cjs/parsers/w3x/w3e";

// Terrain data model + war3map.w3e parser wrapper (plan §4, Phase 2).
// Height math matches mdx-m3-viewer's own w3x handler (the oracle):
//   worldZ = (groundHeight + layerHeight - 2) * CELL
// where the parser already scales groundHeight as (int16 - 8192) / 512.

/** World units per terrain grid cell (also one cliff-layer step in Z). */
export const CELL = 128;

export interface TerrainCorner {
  groundHeight: number; // parser-scaled, cell units
  waterHeight: number;
  layerHeight: number; // cliff layer 0..15
  groundTexture: number; // index into groundTilesets
  cliffTexture: number; // index into cliffTilesets
  ramp: boolean;
  water: boolean;
  boundary: boolean;
  rampAdjust: number; // +0.5 layer on ramp-entrance base corners (HiveWE ref)
}

export interface TerrainData {
  /** Corner columns/rows (cells = width-1 by height-1). */
  width: number;
  height: number;
  centerOffset: [number, number];
  tileset: string;
  groundTilesets: string[];
  cliffTilesets: string[];
  /** Row-major, length width*height; index via cornerAt(). */
  corners: TerrainCorner[];
}

export function cornerAt(t: TerrainData, x: number, y: number): TerrainCorner {
  return t.corners[y * t.width + x];
}

/** Height of a corner in cell units; multiply by CELL for world Z. */
export function cornerHeight(c: TerrainCorner): number {
  return c.groundHeight + c.layerHeight - 2 + c.rampAdjust;
}

/** Parse war3map.w3e bytes into a normalized TerrainData. */
export function parseW3E(bytes: Uint8Array): TerrainData {
  const map = new w3e.File();
  map.load(bytes);

  const width = map.mapSize[0];
  const height = map.mapSize[1];
  const corners: TerrainCorner[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = map.corners[y][x];
      corners[y * width + x] = {
        groundHeight: c.groundHeight,
        waterHeight: c.waterHeight,
        layerHeight: c.layerHeight,
        groundTexture: c.groundTexture,
        cliffTexture: c.cliffTexture,
        ramp: !!c.ramp,
        water: !!c.water,
        boundary: !!c.boundary,
        rampAdjust: 0,
      };
    }
  }

  // Ramp entrances (HiveWE ref): where all four tile corners carry the ramp
  // flag and layers differ non-diagonally, base-layer corners rise half a
  // layer so units walk a slope that meets the ramp model. Assignment (not
  // +=) keeps corners shared by multiple ramp tiles idempotent.
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const bl = corners[y * width + x];
      const br = corners[y * width + x + 1];
      const tl = corners[(y + 1) * width + x];
      const tr = corners[(y + 1) * width + x + 1];
      if (!(bl.ramp && br.ramp && tl.ramp && tr.ramp)) continue;
      if (bl.layerHeight === tr.layerHeight && tl.layerHeight === br.layerHeight) continue;
      const base = Math.min(bl.layerHeight, br.layerHeight, tl.layerHeight, tr.layerHeight);
      for (const c of [bl, br, tl, tr]) if (c.layerHeight === base) c.rampAdjust = 0.5;
    }
  }

  return {
    width,
    height,
    centerOffset: [map.centerOffset[0], map.centerOffset[1]],
    tileset: map.tileset,
    groundTilesets: map.groundTilesets,
    cliffTilesets: map.cliffTilesets,
    corners,
  };
}
