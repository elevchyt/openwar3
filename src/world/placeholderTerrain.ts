import type { TerrainData, TerrainCorner } from "./terrain";

// Zero-asset terrain (plan §2): a procedural heightmap so Phase 2 renders and
// flies with no install. Same TerrainData shape as a parsed map, so the renderer
// is identical whether terrain is synthetic or real.

export function makePlaceholderTerrain(cols = 64, rows = 64): TerrainData {
  const corners: TerrainCorner[] = new Array(cols * rows);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // Rolling hills from a couple of sine waves.
      const h =
        Math.sin(x * 0.28) * 0.6 +
        Math.cos(y * 0.22) * 0.5 +
        Math.sin((x + y) * 0.12) * 0.4;

      // A raised plateau in one quadrant → a cliff step to fly over.
      const onPlateau = x > cols * 0.55 && x < cols * 0.85 && y > rows * 0.55 && y < rows * 0.85;
      const layerHeight = 2 + (onPlateau ? 2 : 0);

      // A water pool in a sunken corner.
      const inPool = x < cols * 0.3 && y < rows * 0.3;
      const groundHeight = h + (inPool ? -1.2 : 0);

      corners[y * cols + x] = {
        groundHeight,
        waterHeight: inPool ? 0.2 : groundHeight,
        layerHeight,
        groundTexture: onPlateau ? 1 : inPool ? 2 : 0,
        cliffTexture: 0,
        ramp: false,
        rampAdjust: 0,
        water: inPool,
        boundary: x === 0 || y === 0 || x === cols - 1 || y === rows - 1,
      };
    }
  }

  return {
    width: cols,
    height: rows,
    // Center the map on the world origin.
    centerOffset: [(-(cols - 1) * 128) / 2, (-(rows - 1) * 128) / 2],
    tileset: "L",
    groundTilesets: ["Lgrs", "Ldrt", "Lrok"],
    cliffTilesets: ["CLdi"],
    corners,
  };
}
