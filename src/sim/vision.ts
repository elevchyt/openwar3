// Fog of war — the per-team vision map (plan §7).
//
// A grid of fog states rebuilt from friendly unit positions each update:
//   • Unexplored — never seen; a solid black mask (you don't even know the terrain).
//   • Explored   — seen at least once; terrain is remembered but shown dimmed grey,
//                  and enemy movement in it is hidden ("concealing enemy movements").
//   • Visible    — inside a friendly unit's current sight radius; fully lit.
//
// WC3 sight is a radius that shrinks at night (UnitBalance `sight`/`nsight`); the
// caller picks which radius to pass based on the day/night clock. This module is a
// pure grid (no world/render deps), matching the sim's headless, testable style.
//
// Vision is LINE-OF-SIGHT, not a flat circle (WC3): once a height/blocker field is
// installed (setHeightField + addTreeBlocker), reveal() ray-casts over the terrain
// height so higher ground and trees cast shadows — you can't see up onto a cliff you
// don't stand on, or through a treeline, and units on high ground see over low. With
// no field installed (unit tests), reveal() falls back to a plain radial circle.

// World units per vision cell. WC3's internal fog-grid size lives in no data file,
// so this is our tuning knob: 64 = half a 128-unit terrain tile. Fine enough that a
// stamped circle reads as round once the 3D overlay bilinear-blends cell corners,
// coarse enough that ray-casting ~50 units' sight each update stays cheap.
export const VISION_CELL = 64;

/** The two halves of `cellSpan`, as plain functions so the hot callers can take the numbers
 *  without a tuple to allocate (see `bestStateAt`). Same arithmetic, said twice. */
function spanLo(lo: number, origin: number): number {
  return Math.max(0, Math.ceil((lo - origin) / VISION_CELL - 0.5));
}
function spanHi(hi: number, origin: number, limit: number): number {
  return Math.min(limit - 1, Math.ceil((hi - origin) / VISION_CELL - 0.5) - 1);
}

// Line-of-sight tuning (world units). EYE_BONUS raises a ground unit's eye a little
// above the terrain so it sees across gentle bumps but NOT up a full 128-unit cliff
// (that's what makes high ground block vision). TREE_BLOCK is how tall a tree stands
// for sight — enough that a treeline shadows the ground behind it.
const EYE_BONUS = 20;
const TREE_BLOCK = 250;
const ANGLE_EPS = 1e-4; // slack so a cell isn't shadowed by its own block height

export enum FogState {
  Unexplored = 0,
  Explored = 1,
  Visible = 2,
}

/** common.j's `fogstate` — what a script-placed fog modifier holds an area at.
 *  The values are the engine's own bit flags, not 0/1/2:
 *
 *    constant fogstate FOG_OF_WAR_MASKED  = ConvertFogState(1)   // black — un-explored
 *    constant fogstate FOG_OF_WAR_FOGGED  = ConvertFogState(2)   // grey  — explored, not seen
 *    constant fogstate FOG_OF_WAR_VISIBLE = ConvertFogState(4)   // lit   — currently seen
 *
 *  They map one-for-one onto our three FogStates, which is why a fog modifier is a
 *  stamp onto the same grid the units reveal into rather than a system of its own. */
export enum JassFogState {
  Masked = 1,
  Fogged = 2,
  Visible = 4,
}

/** Translate a common.j fogstate to the grid's own FogState (defaults to Visible —
 *  the state every real call passes most often, and the harmless one to get wrong). */
export function fogStateOf(jassState: number): FogState {
  if (jassState === JassFogState.Masked) return FogState.Unexplored;
  if (jassState === JassFogState.Fogged) return FogState.Explored;
  return FogState.Visible;
}

/**
 * One unit's sight footprint, cast ONCE and replayed.
 *
 * THE COST THIS EXISTS FOR. `revealLineOfSight` casts a ray to every cell on the sight ring and
 * walks it — O(R²) per unit, and R is ~22 cells for a footman and ~28 for a town hall, so one
 * unit is a few thousand ray steps. That was being paid again for every unit, in every
 * VIEWPOINT, ten times a second. In an eight-player match with 366 units on the field it came to
 * roughly sixteen million ray steps a second and 2.5 ms of every frame — the largest single
 * sub-phase of the sim after the world step itself (docs/perf-logging.md, and the Feralas LV
 * session that prompted this).
 *
 * WHY ONE CACHE SERVES EVERY VIEWPOINT. The footprint of a sight is a fact about the TERRAIN, not
 * about who is looking: `VisionSet` installs the same height field on every viewpoint and
 * broadcasts every felled tree to all of them, so a unit standing on a spot lights the same cells
 * for its owner, for each ally sharing vision, and for an observer. What differs between
 * viewpoints is only WHICH units they stamp and which of their own three layers they write —
 * both of which stay where they are. So the ray cast is shared and the writing is not.
 *
 * WHY IT IS KEYED ON THE UNIT AND NOT ON THE POSITION. A position key would be a cache with no
 * bound: a unit walking across the map mints a new entry every 64 world units and never returns
 * to one. Keyed on the unit there is exactly one entry per unit, replaced when it moves to
 * another vision cell — which still hits, because viewpoints rebuild 8 ms apart while a running
 * unit takes ~240 ms to cross a cell.
 *
 * DETERMINISM. A replay writes exactly the cell list the cast produced, so a cached rebuild and
 * an uncast one are the same grid to the byte. `tools/sim-vision-cache-test.cjs` asserts that
 * against the real map rather than trusting it.
 */
export class SightStamps {
  private readonly byUnit = new Map<number, { cx: number; cy: number; r: number; cells: Uint32Array; used: number }>();
  private clock = 0;
  /** Cast/replay counts, for the test and for anyone wondering whether it is working. */
  hits = 0;
  misses = 0;
  /**
   * Turn the sharing off — every sight is cast from scratch, which is what this replaced.
   *
   * It exists for the same reason `TerrainCull.enabled` does: a claim about how much something
   * costs has to be measurable in the running game, on the same match state, at the same moment,
   * rather than inferred from a benchmark's model of one. `tools/sim-vision-cache-test.cjs`
   * takes the synthetic measurement; this takes the real one.
   */
  enabled = true;

  /** The remembered footprint for this unit at this exact cell and sight, or null. */
  get(unit: number, cx: number, cy: number, r: number): Uint32Array | null {
    const e = this.byUnit.get(unit);
    if (!e || e.cx !== cx || e.cy !== cy || e.r !== r) {
      this.misses++;
      return null;
    }
    // The clock has to advance on a HIT as well as on a put, or a settled match — which is
    // mostly hits — never moves it, and the sweep below has no idea what is stale.
    e.used = ++this.clock;
    this.hits++;
    return e.cells;
  }

  put(unit: number, cx: number, cy: number, r: number, cells: Uint32Array): void {
    this.byUnit.set(unit, { cx, cy, r, cells, used: ++this.clock });
    // A dead unit's entry is never asked for again, and nothing tells us it died. Sweep the
    // ones nothing has touched in a long while, but only once the map is big enough to be
    // worth walking — the live set is one entry per unit on the field.
    if (this.byUnit.size > 4096) this.sweep();
  }

  /**
   * A tree came down (or grew) at this cell: every footprint whose ray ring could have crossed
   * it is now wrong. The rays reach `r` cells in Chebyshev distance, so anything further than
   * `r + radius` away cannot have been shadowed by it and keeps its entry.
   */
  invalidateAround(cx: number, cy: number, radius: number): void {
    for (const [unit, e] of this.byUnit) {
      const reach = e.r + radius;
      if (Math.abs(e.cx - cx) <= reach && Math.abs(e.cy - cy) <= reach) this.byUnit.delete(unit);
    }
  }

  /** The ground itself moved under everything — forget the lot. */
  clear(): void {
    this.byUnit.clear();
  }

  // ---- the recorder's scratch ----------------------------------------------------------
  //
  // A cast's rays cross the cells near the eye many times over, so the footprint has to be
  // deduped as it is collected or the replay costs several times what it should. That needs a
  // mark per cell — half a megabyte on a big map — and it lives HERE, on the one shared cache,
  // rather than on each of nine viewpoints: a cast is never nested, so one is all there is use
  // for.
  private mark: Int32Array | null = null;
  private gen = 0;

  beginCast(cells: number): void {
    if (!this.mark || this.mark.length < cells) this.mark = new Int32Array(cells);
    this.gen++;
  }

  /** True the first time this cell is offered during the current cast. */
  markOnce(i: number): boolean {
    const m = this.mark!;
    if (m[i] === this.gen) return false;
    m[i] = this.gen;
    return true;
  }

  get size(): number {
    return this.byUnit.size;
  }

  private sweep(): void {
    const stale = this.clock - 2048;
    for (const [unit, e] of this.byUnit) if (e.used < stale) this.byUnit.delete(unit);
  }
}

export class VisionMap {
  readonly width: number; // cells
  readonly height: number;
  readonly originX: number; // world-space low corner (== map centerOffset)
  readonly originY: number;
  // Three bitmaps over the same grid:
  //   `visible`  — rebuilt every update: what can I see RIGHT NOW.
  //   `explored` — sticky: do I know the TERRAIN here (grey rather than black).
  //   `seen`     — sticky: did I ever have EYES here.
  //
  // The last two look like the same fact and were one bitmap until they demonstrably
  // weren't. They come apart wherever knowledge of the ground is handed out without
  // anybody looking at it: the "start explored" lobby option, and a FOGGED fog modifier.
  // WC3's own three fogstates say which is which — FOG_OF_WAR_FOGGED is documented as
  // "explored, not seen", and a building shows through fog because you REMEMBER it, not
  // because the tile is grey. Fog a region a player has never visited and they get grey
  // terrain with nothing standing on it.
  private visible: Uint8Array;
  private explored: Uint8Array;
  private seen: Uint8Array;
  // `iseedeadpeople`: a pure override that reports the whole map Visible without
  // touching `explored`, so toggling it back off restores the real fog.
  private revealAll = false;
  // The two halves of WC3's fog, each independently switchable from a script
  // (common.j `FogEnable` / `FogMaskEnable`; blizzard.j wraps them as FogEnableOn/Off
  // and FogMaskEnableOn/Off). They are NOT the same switch:
  //   • the MASK is the black "you have never been here" layer  → FogMaskEnable
  //   • the FOG  is the grey "you can't see it right now" layer → FogEnable
  // Turning the mask off shows the whole map's terrain in grey; turning the fog off as
  // well lights it completely. Like revealAll these are pure read-side overrides, so
  // switching one back on restores the real fog underneath.
  private fogEnabled = true;
  private maskEnabled = true;
  // Line-of-sight height field (world units per cell), installed by setHeightField.
  // `ground` = terrain height for the eye/target; `block` = ground + tree height, the
  // thing that casts shadows. `treeCount` lets overlapping trees (and the several cells
  // one big tree covers) add/remove cleanly.
  private ground: Float32Array | null = null;
  private block: Float32Array | null = null;
  private treeCount: Uint16Array | null = null;
  // The shared sight-footprint cache (see SightStamps), and the scratch a cache MISS records
  // into: `rec` collects the cells this cast lit, and `recMark`/`recGen` dedupe them, because
  // the rays overlap heavily near the eye and a footprint replayed with its duplicates would
  // cost several times what it should.
  private stamps: SightStamps | null = null;
  private rec: number[] | null = null;

  constructor(originX: number, originY: number, worldWidth: number, worldHeight: number) {
    this.originX = originX;
    this.originY = originY;
    this.width = Math.max(1, Math.ceil(worldWidth / VISION_CELL));
    this.height = Math.max(1, Math.ceil(worldHeight / VISION_CELL));
    this.visible = new Uint8Array(this.width * this.height);
    this.explored = new Uint8Array(this.width * this.height);
    this.seen = new Uint8Array(this.width * this.height);
  }

  /** Share one sight-footprint cache with every other viewpoint on this map (SightStamps).
   *  Without one, every reveal is cast from scratch, which is exactly what the uncached arm of
   *  `tools/sim-vision-cache-test.cjs` measures against. */
  setSightStamps(stamps: SightStamps | null): void {
    this.stamps = stamps;
  }

  /** Install the terrain height field so reveal() does line-of-sight. `heightAt` is
   *  the same world-height sampler units stand on. Sampled once per cell centre. */
  setHeightField(heightAt: (wx: number, wy: number) => number): void {
    this.stamps?.clear(); // the ground every footprint was cast over is being replaced
    const n = this.width * this.height;
    this.ground = new Float32Array(n);
    this.block = new Float32Array(n);
    this.treeCount = new Uint16Array(n);
    for (let cy = 0; cy < this.height; cy++) {
      for (let cx = 0; cx < this.width; cx++) {
        const i = cy * this.width + cx;
        const wx = this.originX + (cx + 0.5) * VISION_CELL;
        const wy = this.originY + (cy + 0.5) * VISION_CELL;
        const h = heightAt(wx, wy);
        this.ground[i] = h;
        this.block[i] = h;
      }
    }
  }

  /** Mark a vision-blocking tree of half-extent `radius` centred at (wx, wy) — a
   *  treeline shadows the ground behind it. A tree is NOT a point: harvestable trees
   *  carry `PathTextures\4x4Default.tga` (128×128 world units) or `2x2Default.tga`
   *  (64×64), so a 4×4 tree spans four 64-unit vision cells. Stamping only the centre
   *  cell left three quarters of every big tree transparent and a treeline full of
   *  holes you could see a creep camp through (#43). Overlapping trees stack;
   *  removeTreeBlocker undoes one. */
  addTreeBlocker(wx: number, wy: number, radius = VISION_CELL / 2): void {
    this.forEachBlockerCell(wx, wy, radius, (i) => {
      this.treeCount![i]++;
      this.block![i] = this.ground![i] + TREE_BLOCK;
    });
    this.forgetStampsAround(wx, wy, radius);
  }

  /** A felled tree stops blocking sight once a cell holds no more trees. Pass the
   *  same radius it was added with, so the exact cells it stamped are released. */
  removeTreeBlocker(wx: number, wy: number, radius = VISION_CELL / 2): void {
    this.forEachBlockerCell(wx, wy, radius, (i) => {
      if (this.treeCount![i] > 0 && --this.treeCount![i] === 0) this.block![i] = this.ground![i];
    });
    this.forgetStampsAround(wx, wy, radius);
  }

  /** What casts a shadow here has changed, so every remembered footprint that could have been
   *  shadowed by it has to be cast again. The cache is SHARED, so this is stated once here
   *  rather than by each viewpoint — every one of them is handed the same tree events, and the
   *  ones after the first find nothing left to forget. */
  private forgetStampsAround(wx: number, wy: number, radius: number): void {
    if (!this.stamps) return;
    const [cx, cy] = this.worldToCell(wx, wy);
    this.stamps.invalidateAround(cx, cy, Math.ceil(radius / VISION_CELL) + 1);
  }

  /** Cells covered by a footprint square: every cell whose CENTRE falls in the
   *  half-open span [w-radius, w+radius). Centre-in-square (rather than any overlap)
   *  keeps a treeline watertight without over-blocking — trees on a map share one
   *  lattice, so their squares tile the plane and each cell centre lands in exactly
   *  one of them. A degenerate radius still stamps the tree's own cell. */
  private forEachBlockerCell(wx: number, wy: number, radius: number, fn: (i: number) => void): void {
    if (!this.block || !this.treeCount || !this.ground) return;
    const r = Math.max(radius, VISION_CELL / 2);
    const [x0, x1] = this.cellSpan(wx - r, wx + r, this.originX, this.width);
    const [y0, y1] = this.cellSpan(wy - r, wy + r, this.originY, this.height);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) fn(cy * this.width + cx);
  }

  /** Clamped range of cells whose CENTRE falls in the half-open world span [lo, hi). */
  private cellSpan(lo: number, hi: number, origin: number, limit: number): [number, number] {
    return [spanLo(lo, origin), spanHi(hi, origin, limit)];
  }

  /** The BRIGHTEST fog state over the footprint square of half-extent `radius` centred
   *  at (wx, wy) — i.e. the same cells addTreeBlocker stamps. A tall prop is *seen* if
   *  any cell it stands on is seen. A 4×4 tree spans four vision cells and shadows its
   *  own back half, so asking one arbitrary origin cell drew front-line trees as fogged
   *  grey (#43 follow-up); the ground under them is legitimately dark, the tree is not.
   *  `radius <= 0` degrades to the single cell at (wx, wy). */
  bestStateAt(wx: number, wy: number, radius: number): FogState {
    if (this.revealAll) return FogState.Visible;
    if (radius <= 0) return this.stateAt(wx, wy);
    // Spans computed inline rather than through `cellSpan`, which hands back a tuple. This is
    // the hottest call in the renderer's fog pass — asked for every doodad on the map, and
    // nine in ten of them are trees, which is what carries a radius (mapViewer.fogWidgets) —
    // so at ten passes a second the two throwaway arrays per call were ~90,000 allocations a
    // second on Extreme Candy War's 4,345 doodads.
    const x0 = spanLo(wx - radius, this.originX);
    const x1 = spanHi(wx + radius, this.originX, this.width);
    const y0 = spanLo(wy - radius, this.originY);
    const y1 = spanHi(wy + radius, this.originY, this.height);
    let best = FogState.Unexplored;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const s = this.cellState(cx, cy);
        if (s > best) best = s;
        if (best === FogState.Visible) return best;
      }
    }
    return best;
  }

  setRevealAll(on: boolean): void {
    this.revealAll = on;
  }

  /** Mark every cell Explored (terrain memory) without making it Visible — the
   *  "start explored" lobby option: the whole map shows dimmed grey instead of
   *  pitch black, while live sight and enemy-movement concealment still work
   *  (non-visible cells stay Explored, never promoted to Visible).
   *
   *  `seen` is pointedly NOT filled. Start-explored gives you the map, not the enemy:
   *  in the real game you still have to scout their base. Filling both was one bitmap's
   *  worth of code and put every opponent's town hall on the minimap from turn 0. */
  exploreAll(): void {
    this.explored.fill(1);
  }
  get revealed(): boolean {
    return this.revealAll;
  }

  /** Clear the "currently visible" layer. Call once before re-stamping all
   *  friendly units for this update; `explored` is left intact. */
  beginFrame(): void {
    this.visible.fill(0);
  }

  /** Reveal a unit's sight of world radius `radius` centred at (wx, wy). With a
   *  height field installed and a ground unit, this is line-of-sight (higher ground
   *  and trees cast shadows); flyers and the no-field fallback reveal a full circle. */
  reveal(wx: number, wy: number, radius: number, flying = false, unit?: number): void {
    if (radius <= 0) return;
    // `unit` opts this sight into the footprint cache. Only the line-of-sight path takes it:
    // the radial one casts no rays at all, so there is nothing there worth remembering, and its
    // radius is a float rather than the integer ring the cache is keyed on.
    if (this.ground && this.block && !flying) this.revealLineOfSight(wx, wy, radius, unit);
    else this.revealRadial(wx, wy, radius);
  }

  /** A plain filled circle: every cell whose centre falls inside becomes Visible
   *  (and Explored forever). Used by flyers and when no height field is installed. */
  private revealRadial(wx: number, wy: number, radius: number): void {
    const cx = (wx - this.originX) / VISION_CELL;
    const cy = (wy - this.originY) / VISION_CELL;
    const r = radius / VISION_CELL;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) {
          const i = y * this.width + x;
          this.visible[i] = 1;
          this.explored[i] = 1;
          this.seen[i] = 1;
        }
      }
    }
  }

  /** Heightfield line-of-sight: cast a ray from the unit to every cell on the sight
   *  ring; along each ray keep the steepest elevation angle seen so far, and a cell
   *  is visible only if it rises to (or above) that running horizon. Higher ground /
   *  trees raise the horizon and so shadow the lower ground behind them — while a unit
   *  standing ON high ground looks down over everything. O(radius²) per unit. */
  private revealLineOfSight(wx: number, wy: number, radius: number, unit?: number): void {
    const ground = this.ground!;
    const ucx = Math.floor((wx - this.originX) / VISION_CELL);
    const ucy = Math.floor((wy - this.originY) / VISION_CELL);
    if (!this.inBounds(ucx, ucy)) return;
    const R = Math.round(radius / VISION_CELL);
    // Has this unit already lit this exact cell with this exact sight — for ANY viewpoint on this
    // map? Then the answer is a list of cells rather than a few thousand ray steps. (Switched
    // off, this bypasses the cache COMPLETELY rather than always missing: a miss still records
    // the footprint on the way past, and an off-arm that pays for recording would not be a
    // measurement of what this replaced.)
    const stamps = unit === undefined || !this.stamps?.enabled ? null : this.stamps;
    if (stamps) {
      const cached = stamps.get(unit as number, ucx, ucy, R);
      if (cached) {
        this.applyCells(cached);
        return;
      }
      // A miss: cast it, and record what it lit on the way.
      this.rec = [];
      stamps.beginCast(this.width * this.height);
    }
    const eyeH = ground[ucy * this.width + ucx] + EYE_BONUS;
    // The unit always sees its own cell.
    this.lit(ucy * this.width + ucx);
    // Cast to every cell on the square ring at Chebyshev distance R; the ray walk
    // clips to the circular radius. Adjacent rays overlap enough to cover the disk.
    for (let t = -R; t <= R; t++) {
      this.castRay(ucx, ucy, ucx + t, ucy - R, R, eyeH);
      this.castRay(ucx, ucy, ucx + t, ucy + R, R, eyeH);
      this.castRay(ucx, ucy, ucx - R, ucy + t, R, eyeH);
      this.castRay(ucx, ucy, ucx + R, ucy + t, R, eyeH);
    }
    if (stamps) {
      stamps.put(unit as number, ucx, ucy, R, Uint32Array.from(this.rec!));
      this.rec = null;
    }
  }

  /** This cell is lit: the three layers, and the recorder if a cast is being remembered — deduped
   *  through the cache's own mark (`markOnce`), since the ray fan crosses the cells near the eye
   *  many times over and a footprint replayed with its duplicates costs several times what it
   *  should. */
  private lit(i: number): void {
    this.visible[i] = 1;
    this.explored[i] = 1;
    this.seen[i] = 1;
    const rec = this.rec;
    if (rec && this.stamps!.markOnce(i)) rec.push(i);
  }

  /** Replay a remembered footprint into THIS viewpoint's layers. */
  private applyCells(cells: Uint32Array): void {
    const visible = this.visible;
    const explored = this.explored;
    const seen = this.seen;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      visible[i] = 1;
      explored[i] = 1;
      seen[i] = 1;
    }
  }

  private castRay(ox: number, oy: number, tx: number, ty: number, R: number, eyeH: number): void {
    const ground = this.ground!;
    const block = this.block!;
    const dx = tx - ox;
    const dy = ty - oy;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) return;
    const ix = dx / steps;
    const iy = dy / steps;
    let x = ox + 0.5;
    let y = oy + 0.5;
    let maxAngle = -Infinity;
    for (let s = 1; s <= steps; s++) {
      x += ix;
      y += iy;
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      const ddx = cx - ox;
      const ddy = cy - oy;
      const dCells = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dCells > R) break;
      if (!this.inBounds(cx, cy)) break;
      const i = cy * this.width + cx;
      const dWorld = dCells * VISION_CELL;
      // Visible if this cell's terrain rises to at least the running horizon angle.
      if ((ground[i] - eyeH) / dWorld >= maxAngle - ANGLE_EPS) {
        this.lit(i);
      }
      // Then this cell's BLOCK height (terrain + any tree) raises the horizon for
      // everything beyond it along this ray.
      const aBlock = (block[i] - eyeH) / dWorld;
      if (aBlock > maxAngle) maxAngle = aBlock;
    }
  }

  /** Can a unit standing at (fromX, fromY) SEE the point (toX, toY)? One ray, the same
   *  running-horizon rule `castRay` uses to paint the fog: every cell along the way
   *  raises the horizon by its BLOCK height (terrain + trees), and the target is seen
   *  only if its ground still rises to that horizon. This is what stops a creep from
   *  aggroing a hero through a treeline — the fog already hid him, now the creep is
   *  blind to him too (issue #45 follow-up).
   *
   *  `flying` (either end airborne) skips the test: a flyer looks over the treeline,
   *  and a flyer is seen over it. With no height field installed (headless sim, no
   *  terrain) nothing blocks. */
  hasLineOfSight(fromX: number, fromY: number, toX: number, toY: number, flying = false): boolean {
    const ground = this.ground;
    const block = this.block;
    if (flying || !ground || !block) return true;
    const [ox, oy] = this.worldToCell(fromX, fromY);
    const [tcx, tcy] = this.worldToCell(toX, toY);
    if (!this.inBounds(ox, oy) || !this.inBounds(tcx, tcy)) return true;
    if (ox === tcx && oy === tcy) return true; // same cell — always sees itself
    const eyeH = ground[oy * this.width + ox] + EYE_BONUS;
    const dx = tcx - ox;
    const dy = tcy - oy;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const ix = dx / steps;
    const iy = dy / steps;
    let x = ox + 0.5;
    let y = oy + 0.5;
    let maxAngle = -Infinity;
    for (let s = 1; s <= steps; s++) {
      x += ix;
      y += iy;
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (!this.inBounds(cx, cy)) return false;
      const i = cy * this.width + cx;
      const ddx = cx - ox;
      const ddy = cy - oy;
      const dWorld = Math.sqrt(ddx * ddx + ddy * ddy) * VISION_CELL;
      // The target's own cell: seen if its ground clears the horizon built up on the way.
      // (Its own block height is irrelevant — a unit under a tree is not hidden by it.)
      if (cx === tcx && cy === tcy) return (ground[i] - eyeH) / dWorld >= maxAngle - ANGLE_EPS;
      const aBlock = (block[i] - eyeH) / dWorld;
      if (aBlock > maxAngle) maxAngle = aBlock;
    }
    return true;
  }

  worldToCell(wx: number, wy: number): [number, number] {
    return [
      Math.floor((wx - this.originX) / VISION_CELL),
      Math.floor((wy - this.originY) / VISION_CELL),
    ];
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  /** Fog state at a world position — used to hide units and gate minimap dots. */
  stateAt(wx: number, wy: number): FogState {
    if (this.revealAll) return FogState.Visible;
    const cx = Math.floor((wx - this.originX) / VISION_CELL);
    const cy = Math.floor((wy - this.originY) / VISION_CELL);
    return this.cellState(cx, cy);
  }

  /** Fog state at a grid cell — used per-vertex by the 3D overlay mesh. Cells off
   *  the map read Unexplored (black), matching the border fog. `FogEnable(false)` /
   *  `FogMaskEnable(false)` lift the grey / black layers on the way out. */
  cellState(cx: number, cy: number): FogState {
    if (this.revealAll) return FogState.Visible;
    if (!this.inBounds(cx, cy)) return this.maskEnabled ? FogState.Unexplored : FogState.Explored;
    const i = cy * this.width + cx;
    const raw = this.visible[i] ? FogState.Visible : this.explored[i] ? FogState.Explored : FogState.Unexplored;
    return this.promote(raw);
  }

  /** Apply the FogEnable / FogMaskEnable overrides to a raw grid state: with the mask
   *  off, nothing is ever black; with the fog off, anything explored is fully lit. */
  private promote(raw: FogState): FogState {
    if (raw === FogState.Unexplored && !this.maskEnabled) raw = FogState.Explored;
    if (raw === FogState.Explored && !this.fogEnabled) raw = FogState.Visible;
    return raw;
  }

  /** common.j `FogEnable(flag)` — the grey "explored but not currently seen" veil. */
  setFogEnabled(on: boolean): void {
    this.fogEnabled = on;
  }

  /** common.j `FogMaskEnable(flag)` — the black "never explored" mask. */
  setMaskEnabled(on: boolean): void {
    this.maskEnabled = on;
  }

  /** …and what `IsFogEnabled` / `IsFogMaskEnabled` read back. Not decoration: blizzard.j's
   *  CinematicModeExBJ saves both, turns them off for the cinematic, and restores what it
   *  read — so these two answers decide whether a map that ran a cinematic still has fog
   *  afterwards (7.24). */
  isFogEnabled(): boolean {
    return this.fogEnabled;
  }
  isMaskEnabled(): boolean {
    return this.maskEnabled;
  }

  /** Did this player ever have EYES on this cell — as opposed to merely knowing the
   *  terrain here? This is the question a remembered BUILDING asks: WC3 leaves the last
   *  thing you saw standing on the ground, and "the last thing you saw" is empty until
   *  you have looked. Handing out terrain memory (start-explored, a FOGGED modifier)
   *  does not answer it; only real sight and a VISIBLE modifier do.
   *
   *  Deliberately does NOT consult `maskEnabled`, though the old `isExplored` did.
   *  `FogMaskEnable(false)` turns off the black layer — it makes terrain legible, it does
   *  not tell you what is built on it. Same distinction one level up. `revealAll` still
   *  wins, because `iseedeadpeople` is meant to show you everything. */
  hasSeen(cx: number, cy: number): boolean {
    if (this.revealAll) return true;
    return this.inBounds(cx, cy) && this.seen[cy * this.width + cx] === 1;
  }

  /** Hold a rectangle at a fog state — a script-placed `CreateFogModifierRect` /
   *  `SetFogStateRect`. Re-stamped over the freshly-rebuilt grid each vision update,
   *  so a *running* modifier keeps winning over what the units can actually see. */
  stampRect(minX: number, minY: number, maxX: number, maxY: number, state: FogState): void {
    const x0 = Math.max(0, Math.floor((minX - this.originX) / VISION_CELL));
    const x1 = Math.min(this.width - 1, Math.ceil((maxX - this.originX) / VISION_CELL));
    const y0 = Math.max(0, Math.floor((minY - this.originY) / VISION_CELL));
    const y1 = Math.min(this.height - 1, Math.ceil((maxY - this.originY) / VISION_CELL));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) this.stampCell(cy * this.width + cx, state);
    }
  }

  /** Hold a circle at a fog state — `CreateFogModifierRadius[Loc]` / `SetFogStateRadius`. */
  stampCircle(wx: number, wy: number, radius: number, state: FogState): void {
    if (radius <= 0) return;
    const cx = (wx - this.originX) / VISION_CELL;
    const cy = (wy - this.originY) / VISION_CELL;
    const r = radius / VISION_CELL;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) this.stampCell(y * this.width + x, state);
      }
    }
  }

  /** A fog modifier OVERRIDES what the grid computed, in both directions: VISIBLE lights
   *  a cell no unit can see (the TD that shows you its whole maze), and MASKED blacks out
   *  a cell you are standing in — so MASKED must clear `explored`, the one layer that is
   *  otherwise write-once. That's what makes a re-masked area go properly black again. */
  private stampCell(i: number, state: FogState): void {
    if (state === FogState.Visible) {
      // A VISIBLE modifier hands out real eyes — the TD showing you its whole maze shows
      // you the towers in it, not bare ground.
      this.visible[i] = 1;
      this.explored[i] = 1;
      this.seen[i] = 1;
    } else if (state === FogState.Explored) {
      // FOGGED is "explored, not seen": grey terrain, and NOT a memory of what stands on
      // it. `seen` is deliberately left alone — that is the whole distinction.
      this.visible[i] = 0;
      this.explored[i] = 1;
    } else {
      this.visible[i] = 0;
      this.explored[i] = 0;
      this.seen[i] = 0; // re-masked ground forgets its buildings too
    }
  }

  /** Does this cell block line of sight beyond its own terrain height? True for tree
   *  (treeline) cells that raise the horizon — used by the debug collider overlay to
   *  show which cells obstruct fog-of-war vision. (Cliffs block via terrain height, not
   *  this flag.) */
  isBlocker(cx: number, cy: number): boolean {
    if (!this.block || !this.ground || !this.inBounds(cx, cy)) return false;
    const i = cy * this.width + cx;
    return this.block[i] > this.ground[i] + 1;
  }
}
