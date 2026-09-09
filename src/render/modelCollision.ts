// Selection hit-testing volumes, read out of a model's OWN collision shapes.
//
// Warcraft III does not click-test the visual mesh and does not click-test a capsule it
// invents: every unit model carries invisible primitive volumes — `COLLISIONSHAPE` nodes,
// spheres and boxes sitting in the model's node hierarchy — and the click ray is cast
// against THOSE. It is why the standard advice to a modeller whose custom unit cannot be
// selected in-game is "you forgot the collision shape"
// (hiveworkshop 156930, "Collision Shapes: how to make your model selectable").
//
// This is a different system from the one the units bump into each other with: pathing uses
// the flat 2D `collisionSize` radius off UnitData against the pathing grid and ignores the
// model entirely (hiveworkshop 309631, "Collision Size"). Nothing here touches movement.
//
// Verified against the real install rather than taken on trust — of the 530 models named by
// `Units\UnitUI.slk`, 440 carry collision shapes (551 spheres and 204 boxes; no cylinders,
// and exactly ONE shape in the whole corpus is parented to a bone rather than to the model
// root). The 89 without are almost all BUILDINGS — the Orc Barracks, Great Hall, Spirit
// Lodge, Voodoo Lounge and Troll Burrow among them — which is why the caller needs a
// fallback for a model that hands us nothing; see `RtsController.pickVolumes`.
//
// Everything below works in WORLD space: a shape's vertices are model-space, and the node's
// `worldMatrix` (which already carries the instance's position, facing and scale, and any
// animation on a bone-parented shape) is what puts them where the model is DRAWN.

/** The `Shape` enum of an MDX `COLLISIONSHAPE` chunk, in the file's own order. */
const SHAPE_BOX = 0;
const SHAPE_PLANE = 1;
const SHAPE_SPHERE = 2;
const SHAPE_CYLINDER = 3;

/** One collision shape as the MDX parser hands it over. */
export interface CollisionShapeNode {
  /** `Shape`: 0 box, 1 plane, 2 sphere, 3 cylinder. */
  type: number;
  /** Model-space geometry: a box's min+max corner, a sphere's centre, a cylinder's two ends. */
  vertices: ArrayLike<number>[];
  /** A sphere's (and a cylinder's) radius. Zero on a box. */
  boundsRadius: number;
  /** Index into the instance's `nodes` — this shape's own skeletal node. */
  index: number;
}

/** The bits of an mdx-m3-viewer instance a hit test needs. Kept structural so nothing here
 *  has to import the viewer (the RTS controller never does either). */
export interface CollisionHost {
  nodes?: ArrayLike<{ worldMatrix: ArrayLike<number> }>;
  model: { collisionShapes?: ArrayLike<CollisionShapeNode> };
}

/** A world-space volume the click ray is tested against. */
export type PickVolume =
  | { kind: "sphere"; x: number; y: number; z: number; r: number }
  /** Oriented box: centre, three UNIT axes, and the half-extent along each. */
  | { kind: "box"; x: number; y: number; z: number; ax: number[]; ay: number[]; az: number[]; hx: number; hy: number; hz: number }
  /** Sphere-swept segment (a cylinder's rounded stand-in — the corpus has none). */
  | { kind: "capsule"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; r: number };

/** Transform a model-space point by a column-major mat4. */
function xform(m: ArrayLike<number>, x: number, y: number, z: number, out: number[]): number[] {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** Length of one of the matrix's basis columns — the scale it applies along that axis. */
function axisLen(m: ArrayLike<number>, c: number): number {
  return Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
}

const P0: number[] = [0, 0, 0];
const P1: number[] = [0, 0, 0];

/**
 * The world-space selection volumes of one drawn instance, appended to `out`. Returns the
 * number pushed — **zero means the model carries no collision shapes at all**, and the
 * caller must decide what such a model is clickable by.
 */
export function modelPickVolumes(inst: CollisionHost, out: PickVolume[]): number {
  const shapes = inst.model.collisionShapes;
  const nodes = inst.nodes;
  if (!shapes || !nodes) return 0;
  let n = 0;
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const node = nodes[s.index];
    if (!node) continue;
    const m = node.worldMatrix;
    const v0 = s.vertices[0];
    if (s.type === SHAPE_SPHERE) {
      xform(m, v0[0], v0[1], v0[2], P0);
      // A sphere has ONE radius, so it can only follow one axis of a non-uniform scale.
      // Every unit in the game is scaled uniformly (UnitUI `modelScale`), so the largest
      // axis is the same number as the others in practice and the widest is the safe read.
      const r = s.boundsRadius * Math.max(axisLen(m, 0), axisLen(m, 1), axisLen(m, 2));
      out.push({ kind: "sphere", x: P0[0], y: P0[1], z: P0[2], r });
      n++;
    } else if (s.type === SHAPE_BOX) {
      const v1 = s.vertices[1];
      xform(m, (v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2, (v0[2] + v1[2]) / 2, P0);
      const lx = axisLen(m, 0), ly = axisLen(m, 1), lz = axisLen(m, 2);
      if (lx < 1e-6 || ly < 1e-6 || lz < 1e-6) continue;
      out.push({
        kind: "box",
        x: P0[0], y: P0[1], z: P0[2],
        ax: [m[0] / lx, m[1] / lx, m[2] / lx],
        ay: [m[4] / ly, m[5] / ly, m[6] / ly],
        az: [m[8] / lz, m[9] / lz, m[10] / lz],
        hx: (Math.abs(v1[0] - v0[0]) / 2) * lx,
        hy: (Math.abs(v1[1] - v0[1]) / 2) * ly,
        hz: (Math.abs(v1[2] - v0[2]) / 2) * lz,
      });
      n++;
    } else if (s.type === SHAPE_CYLINDER) {
      const v1 = s.vertices[1];
      xform(m, v0[0], v0[1], v0[2], P0);
      xform(m, v1[0], v1[1], v1[2], P1);
      const r = s.boundsRadius * Math.max(axisLen(m, 0), axisLen(m, 1), axisLen(m, 2));
      out.push({ kind: "capsule", x0: P0[0], y0: P0[1], z0: P0[2], x1: P1[0], y1: P1[1], z1: P1[2], r });
      n++;
    }
    // SHAPE_PLANE is skipped: an infinite half-space is not a body to click, and no model in
    // the install's unit corpus uses one.
    void SHAPE_PLANE;
  }
  return n;
}

/**
 * Where the ray `o + t·d` first enters `v`, or -1 for a miss. `t` is in the ray's own
 * parameter (the caller hands in near→far, so t runs 0..1 across the frustum) and a ray that
 * STARTS inside the volume reports 0 — the camera sitting in a body still counts as a hit.
 *
 * `pad` grows the volume by a fixed world distance, which is how the caller turns "the mouse
 * is within a couple of pixels" into slack the ray can use.
 */
export function rayVolume(
  v: PickVolume,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  pad: number,
): number {
  if (v.kind === "sphere") return raySphere(ox - v.x, oy - v.y, oz - v.z, dx, dy, dz, v.r + pad);
  if (v.kind === "box") return rayBox(v, ox, oy, oz, dx, dy, dz, pad);
  return rayCapsule(v, ox, oy, oz, dx, dy, dz, pad);
}

/** Ray vs a sphere at the origin, with the ray already translated into its frame. */
function raySphere(mx: number, my: number, mz: number, dx: number, dy: number, dz: number, r: number): number {
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return -1;
  const b = 2 * (mx * dx + my * dy + mz * dz);
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / (2 * a);
  if (t0 >= 0) return t0;
  const t1 = (-b + sq) / (2 * a);
  return t1 >= 0 ? 0 : -1; // origin inside the sphere
}

/** Ray vs an oriented box: rotate the ray into the box's own frame, then a slab test. */
function rayBox(
  v: Extract<PickVolume, { kind: "box" }>,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  pad: number,
): number {
  const rx = ox - v.x, ry = oy - v.y, rz = oz - v.z;
  const h = [v.hx + pad, v.hy + pad, v.hz + pad];
  const axes = [v.ax, v.ay, v.az];
  let tMin = -Infinity;
  let tMax = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = axes[i];
    const o = rx * a[0] + ry * a[1] + rz * a[2];
    const d = dx * a[0] + dy * a[1] + dz * a[2];
    if (Math.abs(d) < 1e-9) {
      if (o < -h[i] || o > h[i]) return -1; // parallel and outside this slab
      continue;
    }
    let t0 = (-h[i] - o) / d;
    let t1 = (h[i] - o) / d;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return -1;
  }
  if (tMax < 0) return -1;
  return tMin >= 0 ? tMin : 0; // origin inside the box
}

/** Ray vs a sphere-swept segment. Infinite-cylinder solve, clamped to the segment, with the
 *  two end caps tested separately so a hit on a rounded end is not missed. */
function rayCapsule(
  v: Extract<PickVolume, { kind: "capsule" }>,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  pad: number,
): number {
  const r = v.r + pad;
  const ax = v.x1 - v.x0, ay = v.y1 - v.y0, az = v.z1 - v.z0;
  const aa = ax * ax + ay * ay + az * az;
  const capA = raySphere(ox - v.x0, oy - v.y0, oz - v.z0, dx, dy, dz, r);
  const capB = raySphere(ox - v.x1, oy - v.y1, oz - v.z1, dx, dy, dz, r);
  let best = capA >= 0 && capB >= 0 ? Math.min(capA, capB) : Math.max(capA, capB);
  if (aa < 1e-9) return best; // degenerate segment: it IS a sphere
  const mx = ox - v.x0, my = oy - v.y0, mz = oz - v.z0;
  const md = mx * ax + my * ay + mz * az;
  const dd = dx * ax + dy * ay + dz * az;
  const A = (dx * dx + dy * dy + dz * dz) - (dd * dd) / aa;
  const B = 2 * ((mx * dx + my * dy + mz * dz) - (md * dd) / aa);
  const C = (mx * mx + my * my + mz * mz) - (md * md) / aa - r * r;
  if (Math.abs(A) > 1e-12) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t < 0) continue;
        const s = (md + t * dd) / aa; // where along the segment the hit lands
        if (s < 0 || s > 1) continue;
        if (best < 0 || t < best) best = t;
        break;
      }
    }
  } else if (C <= 0 && best < 0) {
    best = 0; // ray runs down the axis from inside
  }
  return best;
}
