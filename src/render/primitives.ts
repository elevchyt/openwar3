// Built-in primitive geometry (plan §2). A unit box standing on the ground
// (z in [0,1], x/y in [-0.5,0.5]) — the fallback shape for a missing model.

export interface Geometry {
  positions: Float32Array;
  normals: Float32Array;
}

export function boxGeometry(): Geometry {
  const faces = [
    { n: [0, 0, 1], v: [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]] },
    { n: [0, 0, -1], v: [[0.5, -0.5, 0], [-0.5, -0.5, 0], [-0.5, 0.5, 0], [0.5, 0.5, 0]] },
    { n: [0, 1, 0], v: [[-0.5, 0.5, 1], [0.5, 0.5, 1], [0.5, 0.5, 0], [-0.5, 0.5, 0]] },
    { n: [0, -1, 0], v: [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, -0.5, 1], [-0.5, -0.5, 1]] },
    { n: [1, 0, 0], v: [[0.5, -0.5, 1], [0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 1]] },
    { n: [-1, 0, 0], v: [[-0.5, -0.5, 0], [-0.5, -0.5, 1], [-0.5, 0.5, 1], [-0.5, 0.5, 0]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const f of faces) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(...f.v[i]);
      normals.push(...f.n);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals) };
}
