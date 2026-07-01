import { CELL, cornerHeight, type TerrainData } from "../world/terrain";

// Build a renderable heightmap mesh from TerrainData (plan Phase 2).
// Cliffs appear as height steps (layerHeight feeds Z); decorative cliff MDX
// models and true tile-texture blending are later refinements. Per-vertex tint
// stands in for tile textures (plan §2: a flat-color quad for a tile).

export interface TerrainMesh {
  positions: Float32Array; // xyz, Z-up world units
  normals: Float32Array;
  colors: Float32Array; // rgb 0..1
  indices: Uint32Array;
  vertexCount: number;
}

export function buildTerrainMesh(t: TerrainData): TerrainMesh {
  const { width, height, centerOffset } = t;
  const count = width * height;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const h = (x: number, y: number): number =>
    cornerHeight(t.corners[clamp(y, height) * width + clamp(x, width)]);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = t.corners[i];

      positions[i * 3] = x * CELL + centerOffset[0];
      positions[i * 3 + 1] = y * CELL + centerOffset[1];
      positions[i * 3 + 2] = cornerHeight(c) * CELL;

      // Normal from neighbour height slopes (matches the reference shader).
      const n = normalize(h(x - 1, y) - h(x + 1, y), h(x, y - 1) - h(x, y + 1), 2);
      normals[i * 3] = n[0];
      normals[i * 3 + 1] = n[1];
      normals[i * 3 + 2] = n[2];

      const code = t.groundTilesets[c.groundTexture] ?? t.tileset;
      const rgb = c.water ? [0.15, 0.32, 0.55] : groundColor(code);
      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }
  }

  // Two triangles per cell.
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  let k = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const bl = y * width + x;
      const br = bl + 1;
      const tl = bl + width;
      const tr = tl + 1;
      indices[k++] = bl; indices[k++] = br; indices[k++] = tr;
      indices[k++] = bl; indices[k++] = tr; indices[k++] = tl;
    }
  }

  return { positions, normals, colors, indices, vertexCount: count };
}

function clamp(v: number, size: number): number {
  return v < 0 ? 0 : v >= size ? size - 1 : v;
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// A few known WC3 tile codes; everything else hashes to a stable hue. Real BLP
// tile textures replace this once verified against an install.
const KNOWN: Record<string, [number, number, number]> = {
  Lgrs: [0.30, 0.44, 0.20], // grass
  Lgrd: [0.40, 0.42, 0.22], // grassy dirt
  Ldrt: [0.42, 0.32, 0.20], // dirt
  Lrok: [0.44, 0.44, 0.46], // rock
  Ldro: [0.50, 0.42, 0.26], // rough dirt
};

function groundColor(code: string): [number, number, number] {
  const known = KNOWN[code];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) | 0;
  return hslToRgb((Math.abs(hash) % 360) / 360, 0.35, 0.4);
}

function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + hue * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
