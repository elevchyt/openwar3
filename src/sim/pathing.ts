import wpm from "mdx-m3-viewer/dist/cjs/parsers/w3x/wpm";

// Pathing grid from war3map.wpm (plan Phase 5 — move orders that respect pathing).
// The pathing map is 4x the terrain tile grid (32 world units per cell), aligned
// to the terrain's centerOffset. Byte flag bits (verified against real maps, e.g.
// (2)EchoIsles.w3m): 0x02 = unwalkable, 0x08 = unbuildable. The dominant ground byte
// 0x40 has both clear; every unwalkable cell also sets 0x08, plus ~14% of walkable
// cells set 0x08 alone (walkable-but-unbuildable margins/slopes). Buildings stamp
// 0x08 over their full pathTex footprint to reserve build spacing (see destructibles.ts).

export const PATHING_CELL = 32;

/** WC3's BUILD grid: 64 world units, two pathing cells a side, half a terrain tile.
 *  Buildings snap to it and the placement ghost draws one green/red square per build
 *  cell — which is why a barracks (12×12 pathing cells) is the "6×6 building" the
 *  community calls it, with a 1-square pathing buffer (wc3c.net 897815, warcraft3.info
 *  article 423). Pathfinding still runs on the 32-unit cells. */
export const BUILD_CELL = 64;
export const BUILD_CELL_CELLS = BUILD_CELL / PATHING_CELL; // pathing cells per build cell

/** The war3map.wpm bits we act on. They are independent channels — a cliff face
 *  sets Unwalkable and Unbuildable both, but ~14% of walkable cells set Unbuildable alone
 *  (slopes, the margin a production building leaves walkable around itself). Never collapse
 *  them into one.
 *
 *  `NoWater` is the third domain, and the one that makes a SEA a place rather than a wall.
 *  Counted over Rise of the Naga's own wpm (384×512): 67,768 cells are a bare 0x40 (open
 *  land), 46,304 are 0x0a — Unwalkable + Unbuildable with NoWater CLEAR, which is its ocean —
 *  and 40,328 are 0xce / 12,516 0xca, Unwalkable WITH NoWater set: no boat sails over either.
 *  (The 0xca half of that is the cliffs; the 0xce half is the map's unplayable border, which
 *  only the `Unflyable` bit below tells apart.) So a ground unit asks "is Unwalkable clear?"
 *  and a floating one asks "is NoWater clear?", and the map's shallows (0x00) answer yes to
 *  both, exactly as WC3 has it — a Footman wades where a transport can also sail. */
export enum PathingFlag {
  Unwalkable = 0x02,
  /** The UNPLAYABLE area, and nothing else in a real map (issue #117). Cross-tabulated
   *  against war3map.w3e over (2)EchoIsles, (2)BootyBay and a hand-made boundary test map,
   *  `0x04` is set on exactly the cells whose terrain tile carries a w3e boundary flag
   *  (`isBoundaryTile`) and on no other cell — which also settles what the bit means, since
   *  the one thing the black border stops that a cliff does not is a FLYER. Do not read it
   *  as "a cliff": EchoIsles' cliffs are `0xca` and its border `0xce`, and the single bit
   *  between those two is this one. */
  Unflyable = 0x04,
  Unbuildable = 0x08,
  NoWater = 0x40,
}

/** Which domain a unit moves through — the question `walkable` is really asking.
 *
 *  `air` is the odd one out and deliberately so: it is not a third terrain flag but the
 *  ABSENCE of almost every rule. A flyer crosses cliffs, water, trees, buildings and other
 *  units, so the only thing left to ask it is whether the cell is part of the map at all
 *  (`PathingFlag.Unflyable`, issue #117) — which is why a flyer flies straight nearly always
 *  and searches only when a strip of unplayable ground is in the way. */
export type PathDomain = "ground" | "water" | "air";

export interface PathingData {
  width: number;
  height: number;
  flags: Uint8Array; // row-major, length width*height
}

export function parseWpm(bytes: Uint8Array): PathingData {
  const file = new wpm.File();
  file.load(bytes);
  return { width: file.size[0], height: file.size[1], flags: file.pathing };
}

// WC3 reserves an n×n block of pathing cells per stationary unit, keyed off
// collision size (hive tutorial 154558: 0–15 → 1×1, 16–31 → 2×2, 32–47 → 3×3,
// 48+ → 4×4). This is what makes surrounds work: stopped units block cells.
export function footprintCells(collision: number): number {
  if (collision <= 0) return 0;
  if (collision < 16) return 1;
  if (collision < 32) return 2;
  if (collision < 48) return 3;
  return 4;
}

/** The biggest footprint `footprintCells` produces (collision 48+). The clearance map is
 *  capped here: nothing ever asks it a larger question, and capping keeps it one byte a cell. */
const FOOT_MAX = 4;

/** A unit's footprint as the region labels key on it. 0 (a unit with no collision) and 1 are
 *  the same question — "could a point get there" — so they share one set of labels. */
function footClamp(n: number): number {
  return n <= 1 ? 1 : n > FOOT_MAX ? FOOT_MAX : n | 0;
}

export class PathingGrid {
  readonly width: number;
  readonly height: number;
  // The TERRAIN baseline, straight from war3map.wpm. Read-only from here on: cliffs and
  // water are the map's own geometry and nothing a building/tree does may erase them.
  private flags: Uint8Array;
  private originX: number;
  private originY: number;
  // Dynamic reservation layer (stationary units). Counted, so overlapping
  // reservations (rare, e.g. spawn overflow) release cleanly.
  private reservations: Uint16Array | null = null;
  // Dynamic CLAIM layer: the block a *moving* unit holds while it walks. Kept apart from
  // the reservations because the two answer different questions — the pathfinder routes
  // around STOPPED units only (WC3 units path straight through a crowd that is itself on
  // the move and sort it out locally), while the movement step itself must respect both or
  // two units walk through each other. Counted for the same reason reservations are: a
  // claim is taken before the old one is dropped at a block boundary, and a unit that
  // spawns on top of another starts out sharing cells.
  private claims: Uint16Array | null = null;
  // Stamped footprint layers (trees + buildings), kept OFF the terrain baseline and
  // COUNTED for the same reason the reservations are: footprints overlap (a gnoll hut
  // pressed into the treeline shares cells with the trees, and a pathTex's blue border
  // laps over its neighbour's), so clearing one on a bare bitmask would punch a hole in
  // the terrain or in whatever else still stands on those cells. Counting means a
  // footprint releases exactly the cells it took, and only once nothing else claims them.
  private blockStamps: Uint16Array | null = null; // red channel → unwalkable
  private buildStamps: Uint16Array | null = null; // blue channel → unbuildable
  // Static connectivity labels, keyed by domain AND footprint size — see `regionAt`. The
  // arrays are kept and refilled rather than reallocated: a rebuild is triggered by a felled
  // tree or a building going up, and a fresh Int32Array per key per event is megabytes of
  // garbage for something that happens all match (see PathScratch in pathfind.ts for the
  // same reasoning about the search's own working set).
  private regions = new Map<string, Int32Array>();
  private regionCounts = new Map<string, Int32Array>();
  private regionsBuilt = new Set<string>();
  private regionStack: Int32Array | null = null;
  private clearances = new Map<PathDomain, Uint8Array>();
  private regionsDirty = true;

  constructor(data: PathingData, centerOffset: readonly [number, number]) {
    this.width = data.width;
    this.height = data.height;
    this.flags = data.flags;
    this.originX = centerOffset[0];
    this.originY = centerOffset[1];
  }

  /** Reserve an n×n cell block whose origin (low corner) is (cx0, cy0). */
  reserve(cx0: number, cy0: number, n: number): void {
    this.reservations ??= new Uint16Array(this.width * this.height);
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        if (this.inBounds(x, y)) this.reservations[y * this.width + x]++;
      }
    }
  }

  release(cx0: number, cy0: number, n: number): void {
    if (!this.reservations) return;
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        const i = y * this.width + x;
        if (this.inBounds(x, y) && this.reservations[i] > 0) this.reservations[i]--;
      }
    }
  }

  isReserved(cx: number, cy: number): boolean {
    return this.reservations !== null && this.inBounds(cx, cy) && this.reservations[cy * this.width + cx] > 0;
  }

  /** Claim an n×n cell block (origin = low corner) for a unit that is WALKING onto it.
   *  A claim is the "reserve the tile before you step into it" half of WC3 movement: a
   *  mover holds the block it stands on for as long as it is on the move, and may only
   *  advance once it holds the next one — which is what makes body-blocking work and stops
   *  a unit interpolating toward a tile it will never be allowed to occupy. */
  claim(cx0: number, cy0: number, n: number): void {
    this.claims ??= new Uint16Array(this.width * this.height);
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        if (this.inBounds(x, y)) this.claims[y * this.width + x]++;
      }
    }
  }

  unclaim(cx0: number, cy0: number, n: number): void {
    if (!this.claims) return;
    for (let y = cy0; y < cy0 + n; y++) {
      for (let x = cx0; x < cx0 + n; x++) {
        const i = y * this.width + x;
        if (this.inBounds(x, y) && this.claims[i] > 0) this.claims[i]--;
      }
    }
  }

  isClaimed(cx: number, cy: number): boolean {
    return this.claims !== null && this.inBounds(cx, cy) && this.claims[cy * this.width + cx] > 0;
  }

  /** Is any unit — stopped (reservation) or walking (claim) — holding this cell right now?
   *  The question anything that PLACES a body asks; `isReserved` alone is the pathfinder's
   *  narrower question and answers "no" for a cell somebody is currently standing on. */
  isOccupied(cx: number, cy: number): boolean {
    return this.isReserved(cx, cy) || this.isClaimed(cx, cy);
  }

  /** Snap a world position so an n×n footprint aligns to the cell grid: odd
   *  footprints centre on a cell centre, even ones on a cell corner (WC3). */
  snapForFootprint(wx: number, wy: number, n: number): [number, number] {
    if (n <= 0) return [wx, wy];
    return this.snapForFootprintRect(wx, wy, n, n);
  }

  /** Rectangular variant (w×h cells) — unit footprints, cell-grid aligned. */
  snapForFootprintRect(wx: number, wy: number, w: number, h: number): [number, number] {
    const snap = (v: number, origin: number, cells: number) =>
      cells % 2 === 1
        ? origin + (Math.floor((v - origin) / PATHING_CELL) + 0.5) * PATHING_CELL
        : origin + Math.round((v - origin) / PATHING_CELL) * PATHING_CELL;
    return [snap(wx, this.originX, w), snap(wy, this.originY, h)];
  }

  /** Snap a building of w×h pathing cells to the BUILD grid, not the pathing grid.
   *  WC3 places buildings on 64-unit squares (two pathing cells a side) — the green
   *  squares you see under the placement ghost. So a barracks (`12x12Simple.tga`) is
   *  the "6×6 building" everyone calls it, and the Altar of Kings (`10x10Simple.tga`)
   *  is 5×5, not 10×10. Equivalent statement: the footprint's low-corner cell index is
   *  always EVEN. Solving `origin + 2k·32 = centre − 16w` for the centre gives
   *  `centre = origin + 64k + 16w`, i.e. an even half-width (farm, 4 cells) lands on a
   *  build-square corner and an odd one (altar, 10 cells → 5 squares) on its centre. */
  snapForBuildingRect(wx: number, wy: number, w: number, h: number): [number, number] {
    const snap = (v: number, origin: number, cells: number) => {
      const half = (cells * PATHING_CELL) / 2;
      return origin + Math.round((v - origin - half) / BUILD_CELL) * BUILD_CELL + half;
    };
    return [snap(wx, this.originX, w), snap(wy, this.originY, h)];
  }

  /** Origin (low corner) cell of an n×n footprint centred at world (wx, wy).
   *  Positions should be snapped via snapForFootprint() first. */
  footprintOrigin(wx: number, wy: number, n: number): [number, number] {
    if (n % 2 === 1) {
      const [cx, cy] = this.worldToCell(wx, wy);
      return [cx - (n - 1) / 2, cy - (n - 1) / 2];
    }
    return [
      Math.round((wx - this.originX) / PATHING_CELL) - n / 2,
      Math.round((wy - this.originY) / PATHING_CELL) - n / 2,
    ];
  }

  /** The ANCHOR cell footprintFits()/nearestFit() index an n×n footprint by, for a unit
   *  standing at world (wx, wy). footprintFits scans `cx - (n>>1) … cx - (n>>1) + n - 1`,
   *  so the anchor is the centre cell for an odd footprint and the high-corner cell for an
   *  even one — which is why the two parities round differently. */
  footprintAnchor(wx: number, wy: number, n: number): [number, number] {
    if (n <= 0 || n % 2 === 1) return this.worldToCell(wx, wy);
    return [
      Math.round((wx - this.originX) / PATHING_CELL),
      Math.round((wy - this.originY) / PATHING_CELL),
    ];
  }

  /** The exact inverse of footprintAnchor: where a unit whose n×n footprint is anchored on
   *  cell (cx, cy) actually stands. Odd footprints sit on the cell CENTRE, even ones on the
   *  cell CORNER — the same rule snapForFootprint applies.
   *
   *  Use this rather than cellToWorld() + snapForFootprint() for an even footprint: the cell
   *  centre lands exactly on a .5 boundary, so the re-snap's Math.round pushes it a whole
   *  cell off (and JS rounds .5 toward +∞, so the error is directional). */
  footprintCenter(cx: number, cy: number, n: number): [number, number] {
    const half = n <= 0 || n % 2 === 1 ? 0.5 : 0;
    return [this.originX + (cx + half) * PATHING_CELL, this.originY + (cy + half) * PATHING_CELL];
  }

  /** World-space origin (low corner) = the map's centerOffset. Used to align an
   *  independent overlay grid (e.g. the fog-of-war vision map) to the same space. */
  get origin(): readonly [number, number] {
    return [this.originX, this.originY];
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  /** May a unit of this domain stand on the cell? A stamped footprint (a tree, a building)
   *  stops both — a pier is in the way of a boat as much as of a Footman. */
  walkable(cx: number, cy: number, domain: PathDomain = "ground"): boolean {
    if (!this.inBounds(cx, cy)) return false;
    // The air domain asks a different question and reads no stamps: a flyer passes over the
    // pier as readily as over the trees under it (see PathDomain).
    if (domain === "air") return this.playable(cx, cy);
    const i = cy * this.width + cx;
    const flag = domain === "water" ? PathingFlag.NoWater : PathingFlag.Unwalkable;
    return (this.flags[i] & flag) === 0 && !(this.blockStamps && this.blockStamps[i] > 0);
  }

  /** True if a building may be founded on this cell: not unbuildable *and* not
   *  unwalkable terrain (cliffs/water are both). Placement tests this over a
   *  building's full pathTex footprint; movable-unit reservations are ignored
   *  (our own units scatter when the builder arrives), matching WC3. */
  buildable(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const i = cy * this.width + cx;
    if ((this.flags[i] & (PathingFlag.Unwalkable | PathingFlag.Unbuildable)) !== 0) return false;
    return !(this.blockStamps && this.blockStamps[i] > 0) && !(this.buildStamps && this.buildStamps[i] > 0);
  }

  /** Mark a cell unwalkable — used to stamp destructible (tree) + building footprints. */
  block(cx: number, cy: number): void {
    if (!this.inBounds(cx, cy)) return;
    this.blockStamps ??= new Uint16Array(this.width * this.height);
    // Walkability only actually CHANGES on the 0→1 transition (the stamps are counted, so
    // the second tree on a cell shuts nothing that was open) — and it is only a change that
    // invalidates the region labels. A treeline being stamped at map load is thousands of
    // calls; this makes all but the first of them free.
    if (this.blockStamps[cy * this.width + cx]++ === 0) this.regionsDirty = true;
  }

  /** Release one stamp of a cell (felled tree / collapsed building footprint). The cell
   *  only reopens once the LAST claim on it is gone — and never if the terrain itself
   *  is unwalkable underneath. */
  unblock(cx: number, cy: number): void {
    if (!this.inBounds(cx, cy) || !this.blockStamps) return;
    const i = cy * this.width + cx;
    if (this.blockStamps[i] > 0 && --this.blockStamps[i] === 0) this.regionsDirty = true;
  }

  /** Mark/clear a cell unbuildable — building footprints' full (blue) extent, so
   *  the next building can't crowd in and close the walkable corridor between them. */
  blockBuild(cx: number, cy: number): void {
    if (!this.inBounds(cx, cy)) return;
    this.buildStamps ??= new Uint16Array(this.width * this.height);
    this.buildStamps[cy * this.width + cx]++;
  }

  unblockBuild(cx: number, cy: number): void {
    if (!this.inBounds(cx, cy) || !this.buildStamps) return;
    const i = cy * this.width + cx;
    if (this.buildStamps[i] > 0) this.buildStamps[i]--;
  }

  worldToCell(wx: number, wy: number): [number, number] {
    return [
      Math.floor((wx - this.originX) / PATHING_CELL),
      Math.floor((wy - this.originY) / PATHING_CELL),
    ];
  }

  cellToWorld(cx: number, cy: number): [number, number] {
    return [this.originX + (cx + 0.5) * PATHING_CELL, this.originY + (cy + 0.5) * PATHING_CELL];
  }

  /**
   * Is this cell part of the map at all — inside the PLAYABLE area rather than the black
   * unplayable border (issue #117)?
   *
   * Read off the terrain baseline only, never the stamps: a building standing on a cell does
   * not move the edge of the world, and this answer has to be the same for the whole match.
   * Off the grid entirely counts as unplayable, which is the honest answer for a point past
   * the last cell.
   *
   * This is the one question a FLYER can be refused with. Everything else it ignores — it
   * crosses cliffs, trees and buildings — but `Unflyable` is set on nothing except the
   * boundary, so "can I fly there" and "is that inside the map" are the same test.
   */
  playable(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return (this.flags[cy * this.width + cx] & PathingFlag.Unflyable) === 0;
  }

  /** `playable` for a world point — the form every caller outside the pathfinder wants. */
  playableAt(wx: number, wy: number): boolean {
    const [cx, cy] = this.worldToCell(wx, wy);
    return this.playable(cx, cy);
  }

  /**
   * Does the straight line from (x0,y0) to (x1,y1) stay inside the map — i.e. may a FLYER
   * simply go there, or does the unplayable area stand in the way (issue #117)?
   *
   * This is the cheap test that keeps air movement a straight line in the ordinary case. It
   * samples every half cell rather than walking a supercover DDA, which can in principle miss
   * a line that only clips one cell's corner; the smallest unplayable region a map can have is
   * a whole terrain TILE — four cells on a side — so nothing a real map contains slips through.
   */
  segmentPlayable(x0: number, y0: number, x1: number, y1: number): boolean {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (PATHING_CELL / 2));
    if (steps <= 0) return this.playableAt(x0, y0);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.playableAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  /** Nearest playable cell, searched in growing rings (the twin of `nearestWalkable`, for
   *  the air domain). Null when nothing within `maxRadius` is inside the map.
   *
   *  Takes the CLOSEST cell on the first ring that has one rather than the first it walks
   *  into. A ring is a square, so its corner is half again as far as its middle — and a
   *  flyer sent at the map's west edge would visibly drift south-west on its way to being
   *  turned back. */
  nearestPlayable(cx: number, cy: number, maxRadius = 32): [number, number] | null {
    if (this.playable(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxRadius; r++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const d = dx * dx + dy * dy;
          if (d >= bestD || !this.playable(cx + dx, cy + dy)) continue;
          best = [cx + dx, cy + dy];
          bestD = d;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Nearest cell this domain can stand on, searched in growing rings. Null if none near.
   *
   *  `accept` narrows what counts — findPath uses it to keep a goal dropped inside a
   *  treeline on the CALLER'S side of it (see `regionAt`), because snapping it through to
   *  the far side is an order to walk round the whole forest that the player never gave.
   *
   *  Takes the CLOSEST cell on the first ring that has one, not the first it walks into: a
   *  ring is a square, so its corner is half again as far as its middle, and scanning
   *  row-major biases every snap toward the bottom-left. (Same reasoning, and same fix, as
   *  `nearestPlayable` above.) */
  nearestWalkable(
    cx: number,
    cy: number,
    maxRadius = 32,
    domain: PathDomain = "ground",
    accept?: (x: number, y: number) => boolean,
  ): [number, number] | null {
    const ok = (x: number, y: number) => this.walkable(x, y, domain) && (!accept || accept(x, y));
    if (ok(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxRadius; r++) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const d = dx * dx + dy * dy;
          if (d >= bestD || !ok(cx + dx, cy + dy)) continue;
          best = [cx + dx, cy + dy];
          bestD = d;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** True if an n×n unit footprint anchored on (cx,cy) — see footprintAnchor — fits
   *  entirely on walkable cells no other unit is holding. "Holding" is the wide test
   *  (isOccupied): a spot somebody is currently WALKING across is not a spot to drop a
   *  freshly-trained unit on, or to send an attacker to stand in. */
  footprintFits(cx: number, cy: number, n: number, domain: PathDomain = "ground"): boolean {
    if (n <= 1) return this.walkable(cx, cy, domain) && !this.isOccupied(cx, cy);
    const half = n >> 1;
    for (let y = cy - half; y < cy - half + n; y++) {
      for (let x = cx - half; x < cx - half + n; x++) {
        if (!this.walkable(x, y, domain) || this.isOccupied(x, y)) return false;
      }
    }
    return true;
  }

  /**
   * Which connected piece of the STATIC map an n×n mover anchored on this cell belongs to,
   * or -1 where its footprint does not fit at all. Flood-filled once per (domain, footprint)
   * and reused until a tree is felled or a building goes up (see `block`/`unblock`).
   *
   * This exists because "can I get there at all" is the question A* answers most expensively
   * and least well. A* is a best-effort search on a budget: when it runs out it hands back
   * the explored cell CLOSEST TO THE GOAL, and against a wall of trees that cell is the wall
   * of trees. So the two failures the budget produced were the same failure — a goal on an
   * island burned the whole budget proving nothing, and a goal that merely needed a long walk
   * round a forest ran out of budget mid-detour and the unit marched into the treeline and
   * stood there. A label lookup separates them before the search starts.
   *
   * The FOOTPRINT is part of the key and not an afterthought, and it is what the first cut of
   * this cost: labelled one cell wide, "same region" proves only that a POINT could get
   * there, so every search a 2×2 body could not thread reported "reachable, fund it" and then
   * flooded the whole region to prove otherwise. Measured on Feralas LV that was a constant
   * ~40 ms stall several times a second — a failing search always spends its whole budget, so
   * an over-generous budget costs exactly that much every time it is wrong. Keyed on the
   * footprint the answer is exact for the terrain, so the only searches left that can fail
   * are the ones bodies block, and bodies move.
   *
   * FOUR-connected on purpose. A* is 8-directional but forbids corner-cutting — a diagonal
   * step is legal only when both of its orthogonal neighbours are open, which is exactly when
   * the two cells are already 4-connected. Labelling 8-connected would join two regions that
   * touch at a single corner and declare a route nothing can walk.
   *
   * Units are not in the labels, deliberately. This answers the question `terrainReachable`
   * asks — "could it get there if nobody were in the way" — and a crowd is a wait, not a wall.
   */
  regionAt(cx: number, cy: number, domain: PathDomain = "ground", footprint = 1): number {
    if (!this.inBounds(cx, cy)) return -1;
    return this.regionLabels(domain, footClamp(footprint))[cy * this.width + cx];
  }

  /** How many cells the region containing (cx,cy) holds — 0 where the footprint does not fit.
   *  This is the exact worst case for a search inside it: A* expands each cell at most once,
   *  so a budget of this size cannot fail to find a route that is there. */
  regionSize(cx: number, cy: number, domain: PathDomain = "ground", footprint = 1): number {
    const n = footClamp(footprint);
    const id = this.regionAt(cx, cy, domain, n);
    if (id < 0) return 0;
    const counts = this.regionCounts.get(`${domain}/${n}`)!;
    return id < counts.length ? counts[id] : 0;
  }

  /** Can an n×n mover walk from one cell to the other at all, ignoring bodies? Unknown
   *  (either end unwalkable for it) answers false — callers treat that as "cannot prove it"
   *  rather than as a verdict. */
  sameRegion(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    domain: PathDomain = "ground",
    footprint = 1,
  ): boolean {
    const a = this.regionAt(ax, ay, domain, footprint);
    return a >= 0 && a === this.regionAt(bx, by, domain, footprint);
  }

  /** The region a TARGET sits in when the target itself stands on cells nobody may occupy —
   *  a building, a tree, a unit's own footprint. Falls back to the nearest cell around it the
   *  mover DOES fit on, which is the ground an approach actually ends on. */
  regionNear(cx: number, cy: number, domain: PathDomain = "ground", footprint = 1, radius = 6): number {
    const n = footClamp(footprint);
    const here = this.regionAt(cx, cy, domain, n);
    if (here >= 0) return here;
    for (let r = 1; r <= radius; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const d = dx * dx + dy * dy;
          if (d >= bestD) continue;
          const id = this.regionAt(cx + dx, cy + dy, domain, n);
          if (id < 0) continue;
          best = id;
          bestD = d;
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Does an n×n footprint anchored on (cx,cy) — see `footprintAnchor` — lie wholly on
   * walkable ground? Bodies are not asked about; this is the TERRAIN half of the clearance
   * test, and it is one array read rather than the n² the block walk costs.
   *
   * `clearanceMap` holds, for every cell, the side of the largest all-walkable square whose
   * LOW corner is that cell (capped at FOOT_MAX, the biggest footprint the collision table
   * produces). The block an anchor indexes starts at `cx - (n>>1)`, so "does it fit" is
   * "is the square there at least n on a side" — which is the standard clearance DP,
   * `c = 1 + min(right, below, diagonal)`, in one backward pass over the grid.
   */
  footprintClear(cx: number, cy: number, n: number, domain: PathDomain = "ground"): boolean {
    if (n > FOOT_MAX) {
      // Bigger than anything the collision table makes; fall back to the exact walk rather
      // than answering from a map that was capped below the question.
      const half = n >> 1;
      for (let y = cy - half; y < cy - half + n; y++)
        for (let x = cx - half; x < cx - half + n; x++) if (!this.walkable(x, y, domain)) return false;
      return true;
    }
    const half = n <= 1 ? 0 : n >> 1;
    const x0 = cx - half;
    const y0 = cy - half;
    if (x0 < 0 || y0 < 0 || x0 >= this.width || y0 >= this.height) return false;
    return this.clearanceMap(domain)[y0 * this.width + x0] >= Math.max(1, n);
  }

  /** Largest all-walkable square (side, capped at FOOT_MAX) with its LOW corner on each cell.
   *  One backward DP pass; rebuilt with the region labels. */
  private clearanceMap(domain: PathDomain): Uint8Array {
    this.freshenRegions();
    const cached = this.clearances.get(domain);
    if (cached && this.regionsBuilt.has(`c/${domain}`)) return cached;
    const w = this.width;
    const h = this.height;
    let c = cached;
    if (!c) {
      c = new Uint8Array(w * h);
      this.clearances.set(domain, c);
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!this.walkable(x, y, domain)) { c[i] = 0; continue; }
        const right = x + 1 < w ? c[i + 1] : 0;
        const below = y + 1 < h ? c[i + w] : 0;
        const diag = x + 1 < w && y + 1 < h ? c[i + w + 1] : 0;
        const m = right < below ? (right < diag ? right : diag) : below < diag ? below : diag;
        c[i] = m + 1 > FOOT_MAX ? FOOT_MAX : m + 1;
      }
    }
    this.regionsBuilt.add(`c/${domain}`);
    return c;
  }

  /** Drop every cached label/clearance the last stamp change invalidated. The arrays stay —
   *  only their contents are stale — so a rebuild refills in place. */
  private freshenRegions(): void {
    if (!this.regionsDirty) return;
    this.regionsBuilt.clear();
    this.regionsDirty = false;
  }

  /** Labels for one (domain, footprint), flood-filled on demand. A stamp change dirties every
   *  key at once (a building is in a boat's way as much as a Footman's), and the rebuild is
   *  deferred to the next question — so stamping a whole treeline at map load costs one fill,
   *  not one per tree, and a key nothing ever asks about is never built at all. */
  private regionLabels(domain: PathDomain, n: number): Int32Array {
    this.freshenRegions();
    const key = `${domain}/${n}`;
    if (this.regionsBuilt.has(key)) return this.regions.get(key)!;

    const w = this.width;
    const h = this.height;
    const size = w * h;
    let label = this.regions.get(key);
    if (!label) {
      label = new Int32Array(size);
      this.regions.set(key, label);
    }
    label.fill(-1);
    const clear = this.clearanceMap(domain);
    // An anchor's block starts at `cx - half`, so the clearance to read sits `half` cells
    // down-left of it; cells whose block would run off the grid are simply not anchors.
    const half = n <= 1 ? 0 : n >> 1;
    const fits = (x: number, y: number): boolean => {
      const x0 = x - half;
      const y0 = y - half;
      return x0 >= 0 && y0 >= 0 && x0 < w && y0 < h && clear[y0 * w + x0] >= n;
    };
    // Every cell is labelled BEFORE it is pushed, so it is pushed at most once and the
    // stack can never need more than one slot per cell.
    const stack = (this.regionStack ??= new Int32Array(size));
    const counts: number[] = [];
    for (let seed = 0; seed < size; seed++) {
      if (label[seed] !== -1) continue;
      if (!fits(seed % w, (seed / w) | 0)) continue;
      const id = counts.length;
      let sp = 0;
      let count = 0;
      label[seed] = id;
      stack[sp++] = seed;
      while (sp > 0) {
        const k = stack[--sp];
        count++;
        const x = k % w;
        const y = (k / w) | 0;
        if (x > 0 && label[k - 1] === -1 && fits(x - 1, y)) { label[k - 1] = id; stack[sp++] = k - 1; }
        if (x + 1 < w && label[k + 1] === -1 && fits(x + 1, y)) { label[k + 1] = id; stack[sp++] = k + 1; }
        if (y > 0 && label[k - w] === -1 && fits(x, y - 1)) { label[k - w] = id; stack[sp++] = k - w; }
        if (y + 1 < h && label[k + w] === -1 && fits(x, y + 1)) { label[k + w] = id; stack[sp++] = k + w; }
      }
      counts.push(count);
    }
    this.regionCounts.set(key, Int32Array.from(counts));
    this.regionsBuilt.add(key);
    return label;
  }

  /** Nearest cell (spiralling out from cx,cy) where an n×n footprint fits — for
   *  placing a freshly-trained unit on empty tiles it actually fits on.
   *  `accept` optionally rejects otherwise-fitting cells: a batch placed in one frame uses
   *  it to skip cells already handed out, since reservations only land on the next tick. */
  nearestFit(cx: number, cy: number, n: number, maxRadius = 24, accept?: (x: number, y: number) => boolean, domain: PathDomain = "ground"): [number, number] | null {
    for (let r = 0; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (accept && !accept(cx + dx, cy + dy)) continue;
          if (this.footprintFits(cx + dx, cy + dy, n, domain)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }
}
