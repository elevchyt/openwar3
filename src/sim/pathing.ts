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
    this.blockStamps[cy * this.width + cx]++;
  }

  /** Release one stamp of a cell (felled tree / collapsed building footprint). The cell
   *  only reopens once the LAST claim on it is gone — and never if the terrain itself
   *  is unwalkable underneath. */
  unblock(cx: number, cy: number): void {
    if (!this.inBounds(cx, cy) || !this.blockStamps) return;
    const i = cy * this.width + cx;
    if (this.blockStamps[i] > 0) this.blockStamps[i]--;
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

  /** Nearest cell this domain can stand on, searched in growing rings. Null if none near. */
  nearestWalkable(cx: number, cy: number, maxRadius = 32, domain: PathDomain = "ground"): [number, number] | null {
    if (this.walkable(cx, cy, domain)) return [cx, cy];
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          if (this.walkable(cx + dx, cy + dy, domain)) return [cx + dx, cy + dy];
        }
      }
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
