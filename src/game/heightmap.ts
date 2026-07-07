import { CELL, cornerHeight, type TerrainData } from "../world/terrain";

// Sample terrain world-height at any (x, y) by bilinear interpolation over the
// w3e corner heights (plan Phase 5) — used to keep moving units on the ground.
// mdx-m3-viewer's own heightAt is commented out, so we compute our own.

export type HeightSampler = (wx: number, wy: number) => number;

export function makeHeightSampler(terrain: TerrainData): HeightSampler {
  const { width, height, centerOffset, corners } = terrain;
  const h = (cx: number, cy: number): number => {
    const gx = cx < 0 ? 0 : cx >= width ? width - 1 : cx;
    const gy = cy < 0 ? 0 : cy >= height ? height - 1 : cy;
    return cornerHeight(corners[gy * width + gx]) * CELL;
  };

  return (wx, wy) => {
    const fx = (wx - centerOffset[0]) / CELL;
    const fy = (wy - centerOffset[1]) / CELL;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const bottom = h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx;
    const top = h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx;
    return bottom * (1 - ty) + top * ty;
  };
}

// Seat height for a building's axis-aligned footprint rectangle, centred at (cx, cy)
// with half-extents (halfW, halfH). Sampling only the CENTRE (as moving units do)
// sinks a building into any hill/slope its far corners sit on (issue #15); seating on
// the TALLEST terrain the footprint touches fixes that but visibly over-lifts a
// building on even a gentle slope — the max is reached at the far up-slope corner, so
// a large footprint floats up by ~halfDiagonal * slope. WC3 hides this by flattening
// the ground under a structure to a plateau; we don't deform terrain, so we instead
// blend the centre height toward that max by FOOTPRINT_LIFT. That keeps most of the
// anti-sink protection (model bases have generous skirt height for the small remaining
// clip) while cutting the exaggerated float roughly in half. Buildings never move, so
// a caller resolves this once at spawn.
export type FootprintMaxSampler = (cx: number, cy: number, halfW: number, halfH: number) => number;

// How far to lift a building from its centre-terrain height toward the tallest terrain
// under its footprint. 1 = full max (old behaviour, over-lifts on slopes); 0 = centre
// only (sinks on hills). Half keeps buildings out of the ground without the exaggerated
// perch on small slopes.
const FOOTPRINT_LIFT = 0.5;

export function makeFootprintMaxSampler(terrain: TerrainData): FootprintMaxSampler {
  const sample = makeHeightSampler(terrain);
  const { width, height, centerOffset, corners } = terrain;
  const cornerH = (gx: number, gy: number): number => cornerHeight(corners[gy * width + gx]) * CELL;

  return (cx, cy, halfW, halfH) => {
    const minX = cx - halfW;
    const maxX = cx + halfW;
    const minY = cy - halfH;
    const maxY = cy + halfH;
    // The height field is bilinear within each 128-unit cell, so its max over the
    // rectangle is reached either at a terrain corner strictly inside the rect (a
    // hilltop the footprint straddles) or at the rect's own corners (footprints
    // smaller than a cell). Take the max of both sets.
    let m = Math.max(sample(minX, minY), sample(maxX, minY), sample(minX, maxY), sample(maxX, maxY));
    const gx0 = Math.max(0, Math.ceil((minX - centerOffset[0]) / CELL));
    const gx1 = Math.min(width - 1, Math.floor((maxX - centerOffset[0]) / CELL));
    const gy0 = Math.max(0, Math.ceil((minY - centerOffset[1]) / CELL));
    const gy1 = Math.min(height - 1, Math.floor((maxY - centerOffset[1]) / CELL));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const h = cornerH(gx, gy);
        if (h > m) m = h;
      }
    }
    // Blend the natural centre height toward the footprint max so gentle slopes don't
    // perch the building far above the ground it visibly stands on.
    const centre = sample(cx, cy);
    return centre + (m - centre) * FOOTPRINT_LIFT;
  };
}

// Cliff-LEVEL height sampler for fog-of-war line-of-sight. In WC3 the high-ground
// advantage (vision blocking AND the uphill miss chance) comes ONLY from Blizzard
// cliff levels — the discrete `layerHeight` steps and their ramp slopes — NOT from
// hills or gentle "apply height" deformation of the ground (confirmed: hiveworkshop
// "About high ground advantage" #255594, and the classic editor's cliff vs raise/
// lower-terrain tools). `cornerHeight` folds in `groundHeight`, so feeding it to the
// vision field made every rolling bump cast fog like a cliff. This sampler drops the
// smooth `groundHeight` and keeps only the cliff level (layer + ramp half-step), so
// only real cliffs and cliff slopes shadow sight. Bilinear like makeHeightSampler so
// a cliff edge reads as a hard step (adjacent corners a full layer = CELL apart).
export function makeCliffLevelSampler(terrain: TerrainData): HeightSampler {
  const { width, height, centerOffset, corners } = terrain;
  const level = (cx: number, cy: number): number => {
    const gx = cx < 0 ? 0 : cx >= width ? width - 1 : cx;
    const gy = cy < 0 ? 0 : cy >= height ? height - 1 : cy;
    const c = corners[gy * width + gx];
    return (c.layerHeight + c.rampAdjust) * CELL; // cliff level only; no groundHeight
  };

  return (wx, wy) => {
    const fx = (wx - centerOffset[0]) / CELL;
    const fy = (wy - centerOffset[1]) / CELL;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const bottom = level(x0, y0) * (1 - tx) + level(x0 + 1, y0) * tx;
    const top = level(x0, y0 + 1) * (1 - tx) + level(x0 + 1, y0 + 1) * tx;
    return bottom * (1 - ty) + top * ty;
  };
}
