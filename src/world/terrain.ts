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
  /** war3map.w3e's "boundary flag 2" (flags byte 0x80) — the World Editor's **Nothing**
   *  tile (`UI\WorldEditData.txt`: `Nothing=WESTRING_NOTHINGTILE,…\BoundaryPlace`), painted
   *  by hand to carve unplayable ground out of the middle of a map. See isBoundaryTile. */
  boundary: boolean;
  /** war3map.w3e's "boundary flag 1" (water-level word 0x4000) — the unplayable MARGIN the
   *  editor keeps outside the playable area, `cameraBoundsComplements` tiles deep on each
   *  side. Means exactly what `boundary` means; only who painted it differs. */
  mapEdge: boolean;
  rampAdjust: number; // +0.5 layer on ramp-entrance base corners (HiveWE ref)
}

/**
 * Is the TILE this corner anchors part of the map's UNPLAYABLE area — the black border,
 * and any "Nothing" the mapmaker painted inside it (issue #117)?
 *
 * A w3e corner carries its TILE's flags (the tile whose lower-left corner it is), and the
 * two boundary flags are one fact wearing two bits: the editor sets `mapEdge` on the margin
 * it manages itself and `boundary` where the Nothing tool has been. Verified against the
 * real data rather than assumed — across (2)EchoIsles, (2)BootyBay and a hand-made test map,
 * the union of the two is EXACTLY the set of war3map.wpm cells carrying 0x04
 * (`PathingFlag.Unflyable`), with no cell on either side of that equality left over.
 */
export function isBoundaryTile(c: TerrainCorner): boolean {
  return c.boundary || c.mapEdge;
}

/**
 * The boundary as the RENDERER needs it: one byte per terrain CORNER, 1 where any of the up
 * to four tiles meeting at that corner is unplayable.
 *
 * The dilation is the point. Flags are per-tile but every terrain surface we draw (the fog
 * mesh, the cliff/water shaders' fog mask) is interpolated across the corner grid, so tinting
 * only the anchor corner would shade a boundary tile as a gradient from one corner and leave
 * three quarters of it lit. Marking all four corners of a boundary tile instead makes the tile
 * itself uniformly dark and spends the falloff on the PLAYABLE side — one tile of fade into
 * the map, which is how the border reads in the real game.
 */
export function boundaryCorners(t: TerrainData): Uint8Array {
  const { width, height } = t;
  const mask = new Uint8Array(width * height);
  for (let ty = 0; ty < height - 1; ty++) {
    for (let tx = 0; tx < width - 1; tx++) {
      if (!isBoundaryTile(t.corners[ty * width + tx])) continue;
      mask[ty * width + tx] = 1;
      mask[ty * width + tx + 1] = 1;
      mask[(ty + 1) * width + tx] = 1;
      mask[(ty + 1) * width + tx + 1] = 1;
    }
  }
  return mask;
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

/** A world-space rectangle in the terrain's own coordinates. */
export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * `GetCameraMargin(CAMERA_MARGIN_*)` — indexed LEFT, RIGHT, TOP, BOTTOM, as common.j
 * numbers them. How far INSIDE the playable area the camera's focus is stopped, and the
 * reason you can never quite push the view up against the black.
 *
 * Not in any data file — the engine keeps them — but they are not guesses either. Every
 * World-Editor-generated `main()` opens with `SetCameraBounds(<playable rect> ± GetCameraMargin(…))`,
 * and war3map.w3i stores the RESULT of that sum; subtract one from the other and the margin
 * falls out. Done on three maps of different sizes and shapes, it is the same pair every
 * time — 512 across, 256 up and down (4 and 2 terrain cells):
 *
 *   (2)BootyBay   .j −10240,−5376,10240,3840   w3i −9728,−5120,9728,3584   → 512 / 256
 *   (2)EchoIsles  .j  −7424,−5632, 7424,5120   w3i −6912,−5376,6912,4864   → 512 / 256
 *   BoundaryTest  .j  −3328,−3584, 3328,3072   w3i −2816,−3328,2816,2816   → 512 / 256
 *
 * Blizzard.j reads them back the other way — `bj_mapInitialPlayableArea` is the camera
 * bounds WIDENED by these — so getting them wrong would move `GetPlayableMapRect()` for
 * every map, not just the camera.
 */
export const CAMERA_MARGIN = [512, 512, 256, 256] as const;

/**
 * The rect a unit can actually reach: the bounding box of the map's PLAYABLE tiles
 * (issue #117). This is `GetPlayableMapRect()` / `bj_mapInitialPlayableArea`, and it is
 * emphatically not `GetWorldBounds()`, which is the whole grid, black border included.
 *
 * Derived from the boundary flags rather than from war3map.w3i, so it is right for a map
 * whose unplayable area is not a plain frame. Checked against the value the editor itself
 * wrote into each map's `main()`: BootyBay's flags give exactly its
 * `SetCameraBounds(−10240, −5376, 10240, 3840, …)`, and BoundaryTest's exactly its
 * `(−3328, −3584, 3328, 3072, …)`.
 *
 * TILES, not corners: the last corner row and column anchor no tile, and BootyBay's
 * carries stale unflagged corners that would push the box a whole row out if they counted.
 */
export function playableRect(t: TerrainData): WorldRect {
  const { width, height, centerOffset } = t;
  let minTx = width - 1, minTy = height - 1, maxTx = 0, maxTy = 0;
  let any = false;
  for (let ty = 0; ty < height - 1; ty++) {
    for (let tx = 0; tx < width - 1; tx++) {
      if (isBoundaryTile(t.corners[ty * width + tx])) continue;
      any = true;
      if (tx < minTx) minTx = tx;
      if (tx > maxTx) maxTx = tx;
      if (ty < minTy) minTy = ty;
      if (ty > maxTy) maxTy = ty;
    }
  }
  // A map that is boundary end to end has no playable area to speak of; hand back the whole
  // grid rather than an inside-out rect.
  if (!any) return { minX: centerOffset[0], minY: centerOffset[1], maxX: centerOffset[0] + (width - 1) * CELL, maxY: centerOffset[1] + (height - 1) * CELL };
  return {
    minX: centerOffset[0] + minTx * CELL,
    minY: centerOffset[1] + minTy * CELL,
    maxX: centerOffset[0] + (maxTx + 1) * CELL,
    maxY: centerOffset[1] + (maxTy + 1) * CELL,
  };
}

/** The rect the camera's FOCUS is confined to — the playable area pulled in by
 *  `CAMERA_MARGIN`. This is what a map's own `SetCameraBounds` call resolves to, and what
 *  `GetCameraBoundMinX` and friends answer. */
export function cameraBoundsOf(t: TerrainData): WorldRect {
  const r = playableRect(t);
  return {
    minX: r.minX + CAMERA_MARGIN[0],
    maxX: r.maxX - CAMERA_MARGIN[1],
    maxY: r.maxY - CAMERA_MARGIN[2],
    minY: r.minY + CAMERA_MARGIN[3],
  };
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
        mapEdge: !!c.mapEdge,
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
