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

export class VisionMap {
  readonly width: number; // cells
  readonly height: number;
  readonly originX: number; // world-space low corner (== map centerOffset)
  readonly originY: number;
  // Two bitmaps over the same grid: `visible` is rebuilt every update (who can I
  // see RIGHT NOW), `explored` is sticky (where have I EVER seen — terrain memory).
  private visible: Uint8Array;
  private explored: Uint8Array;
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

  constructor(originX: number, originY: number, worldWidth: number, worldHeight: number) {
    this.originX = originX;
    this.originY = originY;
    this.width = Math.max(1, Math.ceil(worldWidth / VISION_CELL));
    this.height = Math.max(1, Math.ceil(worldHeight / VISION_CELL));
    this.visible = new Uint8Array(this.width * this.height);
    this.explored = new Uint8Array(this.width * this.height);
  }

  /** Install the terrain height field so reveal() does line-of-sight. `heightAt` is
   *  the same world-height sampler units stand on. Sampled once per cell centre. */
  setHeightField(heightAt: (wx: number, wy: number) => number): void {
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
  }

  /** A felled tree stops blocking sight once a cell holds no more trees. Pass the
   *  same radius it was added with, so the exact cells it stamped are released. */
  removeTreeBlocker(wx: number, wy: number, radius = VISION_CELL / 2): void {
    this.forEachBlockerCell(wx, wy, radius, (i) => {
      if (this.treeCount![i] > 0 && --this.treeCount![i] === 0) this.block![i] = this.ground![i];
    });
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
    return [
      Math.max(0, Math.ceil((lo - origin) / VISION_CELL - 0.5)),
      Math.min(limit - 1, Math.ceil((hi - origin) / VISION_CELL - 0.5) - 1),
    ];
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
    const [x0, x1] = this.cellSpan(wx - radius, wx + radius, this.originX, this.width);
    const [y0, y1] = this.cellSpan(wy - radius, wy + radius, this.originY, this.height);
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
   *  (non-visible cells stay Explored, never promoted to Visible). */
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
  reveal(wx: number, wy: number, radius: number, flying = false): void {
    if (radius <= 0) return;
    if (this.ground && this.block && !flying) this.revealLineOfSight(wx, wy, radius);
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
        }
      }
    }
  }

  /** Heightfield line-of-sight: cast a ray from the unit to every cell on the sight
   *  ring; along each ray keep the steepest elevation angle seen so far, and a cell
   *  is visible only if it rises to (or above) that running horizon. Higher ground /
   *  trees raise the horizon and so shadow the lower ground behind them — while a unit
   *  standing ON high ground looks down over everything. O(radius²) per unit. */
  private revealLineOfSight(wx: number, wy: number, radius: number): void {
    const ground = this.ground!;
    const ucx = Math.floor((wx - this.originX) / VISION_CELL);
    const ucy = Math.floor((wy - this.originY) / VISION_CELL);
    if (!this.inBounds(ucx, ucy)) return;
    const R = Math.round(radius / VISION_CELL);
    const eyeH = ground[ucy * this.width + ucx] + EYE_BONUS;
    // The unit always sees its own cell.
    this.visible[ucy * this.width + ucx] = 1;
    this.explored[ucy * this.width + ucx] = 1;
    // Cast to every cell on the square ring at Chebyshev distance R; the ray walk
    // clips to the circular radius. Adjacent rays overlap enough to cover the disk.
    for (let t = -R; t <= R; t++) {
      this.castRay(ucx, ucy, ucx + t, ucy - R, R, eyeH);
      this.castRay(ucx, ucy, ucx + t, ucy + R, R, eyeH);
      this.castRay(ucx, ucy, ucx - R, ucy + t, R, eyeH);
      this.castRay(ucx, ucy, ucx + R, ucy + t, R, eyeH);
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
        this.visible[i] = 1;
        this.explored[i] = 1;
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

  /** Has this cell ever been seen? (Progressive doodad reveal in the renderer.) */
  isExplored(cx: number, cy: number): boolean {
    if (this.revealAll || !this.maskEnabled) return true;
    return this.inBounds(cx, cy) && this.explored[cy * this.width + cx] === 1;
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
      this.visible[i] = 1;
      this.explored[i] = 1;
    } else if (state === FogState.Explored) {
      this.visible[i] = 0;
      this.explored[i] = 1;
    } else {
      this.visible[i] = 0;
      this.explored[i] = 0;
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
