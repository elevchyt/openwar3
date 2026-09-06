import { CELL, cornerAt, cornerHeight, type TerrainData } from "../world/terrain";

// Terrain camera culling — draw the terrain cells the camera can SEE, and not the whole map.
//
// THE PROBLEM. mdx-m3-viewer draws the ground as one instanced quad per terrain cell and issues
// it for every cell on the map, every frame, no matter where the camera is looking:
//
//     drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, this.rows * this.columns)
//
// On a 128×128 map that is 16 384 instances per pass, and there are up to four such passes a
// frame (ground, a second ground pass when the map's palette runs past fifteen tilesets, water,
// and each is a full-map sweep). The camera sees a few hundred cells of that. The rest is
// transformed, clipped away, and thrown out — and on old hardware the vertex throughput and the
// draw's own driver cost are exactly what there is least of. Warcraft III itself never did this;
// it drew the terrain around the camera.
//
// THE SHAPE OF THE FIX. The per-cell buffers are ROW-MAJOR — the ground shader recovers a cell's
// position as `corner = (mod(a_InstanceID, u_size.x), floor(a_InstanceID / u_size.x))` — so one
// row of cells is a CONTIGUOUS slice of every one of them. That makes the whole of the culling an
// OFFSET: point the instance attributes at cell `first` and ask for `count` instances. So this
// produces a list of (first, count) runs, one per visible cell row, and the patched
// `map.ow3DrawCells` walks it. Nothing about the geometry, the buffers or the shaders changes.
//
// WHY BLOCKS AND NOT CELLS. Testing 16 384 cells against the frustum on the CPU would cost more
// than the draw call it saves. So the map is diced into blocks of `BLOCK` cells square — 256
// tests on that same map — each with the Z range of the terrain under it, and a block is tested
// as a box. Then, per block row, the visible blocks are the columns between the first and the
// last: a frustum's intersection with a horizontal slab is CONVEX, so the visible span in any one
// row is contiguous and "first..last" loses nothing.
//
// This is a conservative cull, which is the only kind that is allowed to be invisible: a block
// whose box merely touches the frustum is kept, so the only thing that can go wrong is drawing a
// cell that did not need drawing.

/** Cells per block along each axis. 8 keeps the per-frame test in the hundreds on the biggest
 *  maps while the over-draw at the frustum's edge stays under a block — a few dozen cells. */
const BLOCK = 8;

/**
 * Vertical slack on every block's box, in CELLS.
 *
 * The block's own Z range is taken from the terrain and the water table under it, which bounds
 * the ground pass exactly. The WATER pass then adds `Water.slk`'s `height` to every water corner
 * (`u_offsetHeight` in water.vert), which is not in the terrain data at all. Two cells of slack
 * covers that offset and any float slop with room to spare, and the cost of slack is a block at
 * the edge of the view that did not have to be drawn.
 */
const Z_PAD = 2;

/** The six frustum planes as mdx-m3-viewer's camera unpacks them: `a·x + b·y + c·z + d`, and a
 *  point is OUTSIDE the frustum when that is negative for any one of them. */
type Planes = ArrayLike<ArrayLike<number>>;

export interface CullCamera {
  planes: Planes;
}

export class TerrainCull {
  /** Cells across and down — one fewer than the CORNER grid in each axis. */
  readonly cellCols: number;
  readonly cellRows: number;
  private readonly blockCols: number;
  private readonly blockRows: number;
  /** Per block, in world units: minX, minY, minZ, maxX, maxY, maxZ. */
  private readonly boxes: Float32Array;
  /** (first, count) pairs, refilled in place each frame — never reallocated. */
  private readonly runBuf: Int32Array;
  private runCount = 0;
  private cells = 0;

  /**
   * Freeze the runs where they are. Nothing in the game sets this; it is the way to SEE the
   * culling, which is otherwise invisible by construction — hold the runs, fly the camera, and
   * the drawn region stays behind as a hole in the world exactly the shape of the old frustum.
   */
  holdRuns = false;

  /**
   * Turn the cull off — every cell is drawn, exactly as the stock viewer does it.
   *
   * This is what makes the cull TESTABLE rather than merely plausible. A conservative cull is
   * supposed to be invisible, and "invisible" is a claim about pixels: pause the world so the
   * rain stops, grab a frame each way, and the two images must be identical. Anything else is a
   * cell that should have been drawn and was not.
   */
  enabled = true;

  constructor(terrain: TerrainData) {
    this.cellCols = terrain.width - 1;
    this.cellRows = terrain.height - 1;
    this.blockCols = Math.ceil(this.cellCols / BLOCK) || 1;
    this.blockRows = Math.ceil(this.cellRows / BLOCK) || 1;
    this.boxes = new Float32Array(this.blockCols * this.blockRows * 6);
    this.runBuf = new Int32Array(this.cellRows * 2);

    const [ox, oy] = terrain.centerOffset;
    for (let by = 0; by < this.blockRows; by++) {
      for (let bx = 0; bx < this.blockCols; bx++) {
        const x0 = bx * BLOCK;
        const y0 = by * BLOCK;
        const x1 = Math.min(this.cellCols, x0 + BLOCK); // exclusive, in CELLS
        const y1 = Math.min(this.cellRows, y0 + BLOCK);
        let minZ = Infinity;
        let maxZ = -Infinity;
        // A cell is bounded by the four corners around it, so the block's corner span is one
        // wider than its cell span in each axis.
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const c = cornerAt(terrain, Math.min(x, terrain.width - 1), Math.min(y, terrain.height - 1));
            const h = cornerHeight(c);
            if (h < minZ) minZ = h;
            if (h > maxZ) maxZ = h;
            if (c.waterHeight < minZ) minZ = c.waterHeight;
            if (c.waterHeight > maxZ) maxZ = c.waterHeight;
          }
        }
        const i = (by * this.blockCols + bx) * 6;
        this.boxes[i] = ox + x0 * CELL;
        this.boxes[i + 1] = oy + y0 * CELL;
        this.boxes[i + 2] = (minZ - Z_PAD) * CELL;
        this.boxes[i + 3] = ox + x1 * CELL;
        this.boxes[i + 4] = oy + y1 * CELL;
        this.boxes[i + 5] = (maxZ + Z_PAD) * CELL;
      }
    }
  }

  /** Cells the last `update` kept — the counter the perf census reads. */
  get visibleCells(): number {
    return this.cells;
  }

  /** Every cell on the map, for the "how much did we save" half of that counter. */
  get totalCells(): number {
    return this.cellCols * this.cellRows;
  }

  /**
   * Recompute the runs for this camera. Call once per frame, before the terrain passes — the
   * ground and the water share one cell grid and therefore one answer.
   */
  update(camera: CullCamera): void {
    if (this.holdRuns) return;
    const planes = camera.planes;
    const runs = this.runBuf;
    let n = 0;
    let cells = 0;
    for (let by = 0; by < this.blockRows; by++) {
      let first = -1;
      let last = -1;
      for (let bx = 0; bx < this.blockCols; bx++) {
        if (!this.blockVisible(planes, (by * this.blockCols + bx) * 6)) continue;
        if (first < 0) first = bx;
        last = bx;
      }
      if (first < 0) continue; // this whole band of rows is off screen
      const x0 = first * BLOCK;
      const x1 = Math.min(this.cellCols, (last + 1) * BLOCK); // exclusive
      const count = x1 - x0;
      const yEnd = Math.min(this.cellRows, (by + 1) * BLOCK);
      for (let y = by * BLOCK; y < yEnd; y++) {
        runs[n++] = y * this.cellCols + x0;
        runs[n++] = count;
        cells += count;
      }
    }
    this.runCount = n;
    this.cells = cells;
  }

  /** The runs as the patched map reads them: (first instance, count) pairs. */
  runs(): Int32Array {
    return this.runBuf.subarray(0, this.enabled ? this.runCount : 0);
  }

  /**
   * Is this block's box inside the frustum? The standard positive-vertex test: for each plane,
   * take the box corner furthest along that plane's normal, and if even THAT corner is on the
   * outside then every corner is and the box is gone.
   */
  private blockVisible(planes: Planes, i: number): boolean {
    const b = this.boxes;
    for (let p = 0; p < 6; p++) {
      const plane = planes[p];
      const a = plane[0];
      const c = plane[1];
      const d = plane[2];
      const x = a >= 0 ? b[i + 3] : b[i];
      const y = c >= 0 ? b[i + 4] : b[i + 1];
      const z = d >= 0 ? b[i + 5] : b[i + 2];
      if (a * x + c * y + d * z + plane[3] < 0) return false;
    }
    return true;
  }
}
