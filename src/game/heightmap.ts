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
