import { PATHING_CELL } from "./pathing";

/**
 * Blight — the rotted ground an Undead settlement stands on.
 *
 * It is TERRAIN, not an aura, and that is the whole design. Every other "area a building
 * projects" in this engine (a Ziggurat's range, an Unholy Aura) is recomputed from the
 * buildings that are alive right now; blight is not. It is painted onto the ground once,
 * by the building that grew it, and it stays there — which is why an Undead player who
 * loses a base can rebuild on it, and why the classic manual's line is that blight "can be
 * dispelled by your enemies ONCE the building that generated it has been destroyed or
 * unsummoned" (classic.battle.net/war3/undead/basics.shtml). A live source keeps re-asserting
 * its own disc, so while it stands there is nothing to dispel.
 *
 * **The grid is the TERRAIN CORNER grid**, 128 world units a side, sharing the map's own
 * `centerOffset` — the same lattice `war3map.w3e` stores a corner on and the same one
 * mdx-m3-viewer's ground shader blends `corner.blight` over. Anything coarser or finer would
 * have to be resampled to draw, and the seams would show. The sim never sees the w3e (it is
 * handed a `PathingGrid`), and it does not need to: the pathing map is exactly 4× the tile
 * grid, so `corners = pathingCells / 4 + 1` is an identity, not an estimate.
 *
 * Not modelled: the sickly recolour blight puts on nearby TREES (a separate
 * `*TreeBlight.blp` per tileset, which outlives the blight itself — see the Warcraft Wiki),
 * and the blight doodads (`Environment\BlightDoodad\BlightDoodad.mdx`) the real client
 * scatters over it.
 */
export class BlightGrid {
  /** Corner columns/rows — the w3e lattice, 128 units apart. */
  readonly columns: number;
  readonly rows: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly on: Uint8Array;
  /** Corner indices whose state changed since `drainDirty` last ran. The renderer is the
   *  only consumer and it may not exist (headless), so this is capped: past the cap the
   *  list is dropped and `dirtyAll` says "re-read everything". */
  private dirty: number[] = [];
  private dirtyAll = false;
  /** True while anything at all is blighted — the fast out for `at()` on the three races
   *  that never paint any (a whole match's worth of `regenType = blight` checks). */
  private any = false;

  constructor(pathingWidth: number, pathingHeight: number, originX: number, originY: number) {
    // The w3e corner lattice: one corner per 128 units, i.e. one per 4 pathing cells, plus
    // the closing edge. `Math.round` rather than a bare divide because a map whose pathing
    // map is not a clean multiple of 4 (none stock is) should still land on a whole lattice.
    this.columns = Math.round(pathingWidth / (128 / PATHING_CELL)) + 1;
    this.rows = Math.round(pathingHeight / (128 / PATHING_CELL)) + 1;
    this.originX = originX;
    this.originY = originY;
    this.on = new Uint8Array(this.columns * this.rows);
  }

  /** Is this world point on blight? Corners are 128 apart and a point between four of them
   *  takes the NEAREST — the same rounding the ground shader does when it decides which
   *  texture a tile corner carries, so what the sim says and what the player sees agree. */
  at(wx: number, wy: number): boolean {
    if (!this.any) return false;
    const col = Math.round((wx - this.originX) / 128);
    const row = Math.round((wy - this.originY) / 128);
    if (col < 0 || row < 0 || col >= this.columns || row >= this.rows) return false;
    return this.on[row * this.columns + col] === 1;
  }

  /** Paint (or clear) every corner within `radius` of a world point. Returns true if
   *  anything actually changed — the caller uses that to skip the renderer sync. */
  paintDisc(wx: number, wy: number, radius: number, blighted: boolean): boolean {
    if (radius <= 0) return false;
    const value = blighted ? 1 : 0;
    const c0 = Math.max(0, Math.ceil((wx - radius - this.originX) / 128));
    const c1 = Math.min(this.columns - 1, Math.floor((wx + radius - this.originX) / 128));
    const r0 = Math.max(0, Math.ceil((wy - radius - this.originY) / 128));
    const r1 = Math.min(this.rows - 1, Math.floor((wy + radius - this.originY) / 128));
    const r2 = radius * radius;
    let changed = false;
    for (let row = r0; row <= r1; row++) {
      const dy = this.originY + row * 128 - wy;
      for (let col = c0; col <= c1; col++) {
        const dx = this.originX + col * 128 - wx;
        if (dx * dx + dy * dy > r2) continue;
        const i = row * this.columns + col;
        if (this.on[i] === value) continue;
        this.on[i] = value;
        changed = true;
        if (this.dirty.length < DIRTY_CAP) this.dirty.push(i);
        else this.dirtyAll = true;
      }
    }
    if (changed && blighted) this.any = true;
    return changed;
  }

  /** The corners the renderer has not been told about yet, as `[col, row, on]` triples.
   *  `all` means the cap was blown and it should re-read the whole grid. */
  drainDirty(): { all: boolean; cells: Array<[number, number, boolean]> } {
    const all = this.dirtyAll;
    const cells: Array<[number, number, boolean]> = [];
    if (!all) {
      const seen = new Set<number>();
      for (const i of this.dirty) {
        if (seen.has(i)) continue;
        seen.add(i);
        cells.push([i % this.columns, (i / this.columns) | 0, this.on[i] === 1]);
      }
    }
    this.dirty = [];
    this.dirtyAll = false;
    return { all, cells };
  }

  /** Whether a corner is blighted, by lattice index — the renderer's read for a full resync. */
  atCorner(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.columns || row >= this.rows) return false;
    return this.on[row * this.columns + col] === 1;
  }

  /** Nothing blighted anywhere — three of the four races never touch this. */
  get empty(): boolean {
    return !this.any;
  }

  /** Blighted corner count. Only the tests ask; it is the cheapest thing to assert on. */
  get count(): number {
    let n = 0;
    for (let i = 0; i < this.on.length; i++) n += this.on[i];
    return n;
  }
}

/** Past this many pending corners it is cheaper to re-upload the whole terrain buffer than
 *  to track which parts of it moved. A Necropolis's 960 disc is ~180 corners, so an ordinary
 *  building never comes close; a map script blighting a region does. */
const DIRTY_CAP = 4096;
