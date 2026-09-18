// WALKABLE DESTRUCTIBLES — the bridges, ramps and platforms a unit stands ON TOP OF.
//
// `Units\DestructableData.slk` has a `walkable` column, 1 on 106 of its 247 types: every
// bridge (`LT00`-`LT11` wood, `YT00`-`YT31` rock and stone, `DTsb`-`DTs3` the demon force
// bridge), the stone ramps, the Dalaran thrones, and the invisible platforms a mapmaker
// builds a second storey out of. It is the one column in the table that has nothing to do
// with what the thing is made of or how it dies.
//
// **It is a HEIGHT flag, not a pathing one.** Where a unit may walk is already settled by the
// type's `pathTex` (`PathTextures\CityBridgeLarge45.tga` and friends), which is stamped like
// any other footprint and is what makes the water under a bridge crossable at all. What
// `walkable` adds is that the deck, rather than the terrain, is the floor — and a bridge spans
// a gap precisely because the terrain under it is far below. Without this a unit crossing
// Strahnbrad's bridge is drawn down in the streambed, walking THROUGH the thing it is
// supposed to be on.
//
// The reference resolves the height by **casting a ray straight down at the model's own
// geometry** and taking the nearest surface it meets. Warsmash does exactly this and its shape
// is worth quoting, because it also settles what happens where two of them overlap and what
// happens off the edge of one:
//
//     ray.set(x, y, 4096, 0, 0, -8192);                 // QuadtreeIntersectorFindsWalkableRenderHeight
//     if (instance.intersectRayWithCollision(ray, out, true, true)) z = max(z, out.z);
//     …
//     final float unitZ = Math.max(getWalkableRenderHeight(unitX, unitY),
//                                  terrain.getGroundHeight(unitX, unitY));
//
// — the highest surface wins, and the GROUND is always in that max, so a unit that steps off
// the deck is back on the grass in the same breath and a map with no walkables costs nothing.
//
// We do the ray once per query against triangles transformed into world space at load, rather
// than per frame against a live instance: a destructible does not move, so its deck is a fixed
// piece of geometry, and the only thing that changes is who is standing on it.
//
// Verified against the install rather than assumed. Human01 (The Defense of Strahnbrad) places
// one `LT05` — "Long Bridge, Diagonal 1", `Doodads\Terrain\WoodBridgeLarge45` — at
// (1216, -960) with the .doo's own z of **-114**. The terrain there is -165 at the middle of
// the span and about +73 at either bank; the model's deck runs from z 195 at the ends up to
// 274 at the crown of the arch, so placed at -114 it meets the banks at +81 and rises to +160
// over the water. That is a bridge, and the numbers are the data's.

/** A model's geometry as the MDX parser hands it over — vertices as a flat XYZ array and
 *  faces as vertex indices. Structural on purpose: nothing here imports the viewer. */
export interface WalkableGeoset {
  vertices: ArrayLike<number>;
  faces: ArrayLike<number>;
}

/** Where a walkable destructible was placed, in the .doo's own terms. */
export interface WalkablePlacement {
  x: number;
  y: number;
  /** The .doo's z, which is an ABSOLUTE world height: the viewer moves the instance to
   *  `doodad.location` verbatim and adds no terrain under it. */
  z: number;
  angle: number; // radians, about world Z
  scale: [number, number, number];
}

/** How coarse the per-surface triangle buckets are, in world units. A bridge is ~1,100 units
 *  across and a few hundred triangles, so a 128-unit bucket puts a handful in each and the
 *  query does a handful of point-in-triangle tests instead of hundreds. */
const BUCKET = 128;

/** One walkable destructible's deck, as world-space triangles in a flat bucket grid. */
class WalkableSurface {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Triangle indices (into `tri`, ×9) per bucket. */
  private readonly buckets: number[][];
  /** Triangles, nine floats each: ax ay az bx by bz cx cy cz. */
  private readonly tri: Float64Array;

  constructor(geosets: readonly WalkableGeoset[], at: WalkablePlacement) {
    const cos = Math.cos(at.angle);
    const sin = Math.sin(at.angle);
    const [sx, sy, sz] = at.scale;
    const pts: number[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of geosets) {
      const v = g.vertices;
      const f = g.faces;
      for (let i = 0; i + 2 < f.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const o = f[i + k] * 3;
          // Model space → world: scale, then turn about Z, then translate. The same order the
          // viewer's own Doodad does it in (move / rotateLocal / scale on one node).
          const mx = v[o] * sx, my = v[o + 1] * sy, mz = v[o + 2] * sz;
          const wx = at.x + mx * cos - my * sin;
          const wy = at.y + mx * sin + my * cos;
          pts.push(wx, wy, at.z + mz);
          if (wx < minX) minX = wx;
          if (wy < minY) minY = wy;
          if (wx > maxX) maxX = wx;
          if (wy > maxY) maxY = wy;
        }
      }
    }
    this.tri = new Float64Array(pts);
    this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / BUCKET));
    this.rows = Math.max(1, Math.ceil((maxY - minY) / BUCKET));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [] as number[]);
    for (let t = 0; t < this.tri.length; t += 9) {
      const tminX = Math.min(this.tri[t], this.tri[t + 3], this.tri[t + 6]);
      const tmaxX = Math.max(this.tri[t], this.tri[t + 3], this.tri[t + 6]);
      const tminY = Math.min(this.tri[t + 1], this.tri[t + 4], this.tri[t + 7]);
      const tmaxY = Math.max(this.tri[t + 1], this.tri[t + 4], this.tri[t + 7]);
      const c0 = this.col(tminX), c1 = this.col(tmaxX);
      const r0 = this.row(tminY), r1 = this.row(tmaxY);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.buckets[r * this.cols + c].push(t);
    }
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / BUCKET)));
  }
  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / BUCKET)));
  }

  /** The highest surface of this deck at (x, y), or -Infinity where the ray misses it
   *  entirely — off the end of the bridge, or through one of the gaps in a railing. */
  heightAt(x: number, y: number): number {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return -Infinity;
    let best = -Infinity;
    for (const t of this.buckets[this.row(y) * this.cols + this.col(x)]) {
      const ax = this.tri[t], ay = this.tri[t + 1], az = this.tri[t + 2];
      const bx = this.tri[t + 3], by = this.tri[t + 4], bz = this.tri[t + 5];
      const cx = this.tri[t + 6], cy = this.tri[t + 7], cz = this.tri[t + 8];
      // Barycentric in the XY plane: a vertical ray hits the triangle exactly where the point
      // is inside its XY projection, and the height is then the interpolated z. A triangle
      // seen edge-on (d ≈ 0) projects to a line and can be skipped — a vertical wall is not
      // a floor.
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d > -1e-6 && d < 1e-6) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      if (l1 < 0 || l1 > 1) continue;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      if (l2 < 0 || l2 > 1) continue;
      const l3 = 1 - l1 - l2;
      if (l3 < 0 || l3 > 1) continue;
      const z = l1 * az + l2 * bz + l3 * cz;
      if (z > best) best = z;
    }
    return best;
  }
}

/**
 * Every walkable destructible on the map, and the one question anything asks of them.
 *
 * Empty on most maps and on every melee map in the game, which is why the query starts with a
 * length check: this costs literally nothing where there are no bridges.
 */
export class WalkableSurfaces {
  private readonly surfaces: WalkableSurface[] = [];
  /** So the same destructible is never added twice — the doodad pass runs every frame until
   *  the last model has streamed in, and a bridge's model may arrive on any of them. */
  private readonly seen = new Set<number>();

  /** Has this destructible (by its .doo id) already been taken? */
  has(destId: number): boolean {
    return this.seen.has(destId);
  }

  /** Take a walkable destructible's deck. `geosets` is its model's geometry; `at` is where the
   *  .doo put it. A model with no geometry is remembered as taken and contributes nothing. */
  add(destId: number, geosets: readonly WalkableGeoset[], at: WalkablePlacement): void {
    if (this.seen.has(destId)) return;
    this.seen.add(destId);
    const surface = new WalkableSurface(geosets, at);
    if (Number.isFinite(surface.minX)) this.surfaces.push(surface);
  }

  clear(): void {
    this.surfaces.length = 0;
    this.seen.clear();
  }

  get count(): number {
    return this.surfaces.length;
  }

  /**
   * The height of the highest walkable deck over (x, y), or -Infinity if the point is over
   * none. The caller maxes this with the terrain — see the note at the top: the ground is
   * always in the max, so stepping off a bridge is stepping back onto the grass.
   */
  heightAt(x: number, y: number): number {
    if (!this.surfaces.length) return -Infinity;
    let best = -Infinity;
    for (const s of this.surfaces) {
      const z = s.heightAt(x, y);
      if (z > best) best = z;
    }
    return best;
  }
}
