import { TICK, TOP_SPEED_MAX, TURN_RATE, UNITS_PER_SPEED } from "./map";

// THE RACING LINE — how a Computer+ racer knows where the road goes (docs/grand-prix-ai.md).
//
// The map says two things about its track and neither is a line to drive on. The GROUND says where
// a cart may be at all (`IsValidLocForVehicle`: cliff level 4, and the pathing map for the trees
// and walls a pathed `SetUnitPositionLoc` will not put it inside); the 34 CHECK POINTS say which
// way round — each is a point and a facing, and a cart has "reached" one once it is on the far
// side of the line through it (`ReachedCheckPoint`). A person reads the road off the screen. This
// file reads it off the same two facts: a path over the drivable ground from each check point to
// the next, kept off the walls, pulled smooth, and then given the one number a kart needs at every
// metre of it — how fast it may be going there.
//
// Pure: it is handed the ground as a predicate and returns arrays, so the headless test builds the
// same route the match does. Every constant in here is OURS.

export interface Gate {
  x: number;
  y: number;
  /** The way the check point faces, degrees (`udg_PlaceCheckPtDir`). */
  dir: number;
}

export interface Ground {
  drivable(x: number, y: number): boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Route {
  /** World units between two samples. */
  step: number;
  n: number;
  length: number;
  x: Float32Array;
  y: Float32Array;
  /** The road's own direction at each sample, radians. */
  heading: Float32Array;
  /** How fast a cart that can turn `TURN_RATE` may be going at each sample to hold the line, in
   *  speedometer points, before anybody's brakes are considered. */
  cornerSpeed: Float32Array;
  /** How far the nearest wall is from each sample, world units (capped). */
  room: Float32Array;
  /** Which check point each sample is on its way to. */
  gate: Int16Array;
  /** The sample each check point sits at. */
  gateAt: Int32Array;
}

/** The grid the road is found on: one terrain cell. Fine enough for a track a thousand wide. */
const CELL = 128;
/** A sample of the finished line every this many world units. */
const STEP = 64;
/** Clearance past this is as good as open ground (world units). */
const ROOM_CAP = CELL * 6;
/** The line is never pulled closer to a wall than this, unless the road itself is narrower. */
const ROOM_SAFE = 330;

/** Lay the racing line through `gates`, in order and back round to the first. Null if the ground
 *  does not join them — which is "this is not the map we thought", never a route to drive. */
export function buildRoute(gates: readonly Gate[], ground: Ground): Route | null {
  if (gates.length < 3) return null;
  const w = Math.max(1, Math.ceil((ground.maxX - ground.minX) / CELL));
  const h = Math.max(1, Math.ceil((ground.maxY - ground.minY) / CELL));
  const cx = (x: number): number => Math.min(w - 1, Math.max(0, Math.floor((x - ground.minX) / CELL)));
  const cy = (y: number): number => Math.min(h - 1, Math.max(0, Math.floor((y - ground.minY) / CELL)));
  const wx = (c: number): number => ground.minX + (c + 0.5) * CELL;
  const wy = (c: number): number => ground.minY + (c + 0.5) * CELL;

  // --- 1. what is road: the cell's middle and its four quarters must all take a cart.
  const open = new Uint8Array(w * h);
  const Q = CELL * 0.35;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = wx(i), y = wy(j);
      open[j * w + i] = ground.drivable(x, y) && ground.drivable(x - Q, y - Q) && ground.drivable(x + Q, y - Q)
        && ground.drivable(x - Q, y + Q) && ground.drivable(x + Q, y + Q) ? 1 : 0;
    }
  }

  // --- 2. how far each road cell is from the nearest wall (a two-pass chamfer, in world units).
  const room = new Float32Array(w * h);
  const D1 = CELL, D2 = CELL * Math.SQRT2;
  for (let k = 0; k < room.length; k++) room[k] = open[k] ? ROOM_CAP : 0;
  const relax = (k: number, i: number, j: number, di: number, dj: number, d: number): void => {
    const ni = i + di, nj = j + dj;
    const v = ni < 0 || nj < 0 || ni >= w || nj >= h ? 0 : room[nj * w + ni];
    if (v + d < room[k]) room[k] = v + d;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!open[k]) continue;
      relax(k, i, j, -1, 0, D1); relax(k, i, j, 0, -1, D1); relax(k, i, j, -1, -1, D2); relax(k, i, j, 1, -1, D2);
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      if (!open[k]) continue;
      relax(k, i, j, 1, 0, D1); relax(k, i, j, 0, 1, D1); relax(k, i, j, 1, 1, D2); relax(k, i, j, -1, 1, D2);
    }
  }
  const roomAt = (x: number, y: number): number => {
    // Bilinear over the cell middles, so pulling a point a few units reads as a few units.
    const fx = (x - ground.minX) / CELL - 0.5, fy = (y - ground.minY) / CELL - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
    const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= w || j >= h ? 0 : room[j * w + i]);
    return (at(i0, j0) * (1 - tx) + at(i0 + 1, j0) * tx) * (1 - ty) + (at(i0, j0 + 1) * (1 - tx) + at(i0 + 1, j0 + 1) * tx) * ty;
  };

  // --- 3. a check point's own cell — or the nearest road beside it, for one planted on a verge.
  //        "Road" is the ONE piece of drivable ground the check points share: the infield of a
  //        loop is level grass too, walled off by its trees, and a marker standing at the edge of
  //        the track must not be read as standing in it.
  const piece = new Int32Array(w * h);
  let pieces = 0;
  for (let k0 = 0; k0 < open.length; k0++) {
    if (!open[k0] || piece[k0]) continue;
    piece[k0] = ++pieces;
    const todo = [k0];
    while (todo.length) {
      const k = todo.pop() as number;
      const i = k % w, j = (k / w) | 0;
      if (i > 0 && open[k - 1] && !piece[k - 1]) { piece[k - 1] = pieces; todo.push(k - 1); }
      if (i < w - 1 && open[k + 1] && !piece[k + 1]) { piece[k + 1] = pieces; todo.push(k + 1); }
      if (j > 0 && open[k - w] && !piece[k - w]) { piece[k - w] = pieces; todo.push(k - w); }
      if (j < h - 1 && open[k + w] && !piece[k + w]) { piece[k + w] = pieces; todo.push(k + w); }
    }
  }
  const snap = (g: Gate, only: number): number => {
    const i0 = cx(g.x), j0 = cy(g.y);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 8 && best < 0; r++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (i < 0 || j < 0 || i >= w || j >= h || !open[j * w + i]) continue;
          if (only && piece[j * w + i] !== only) continue;
          const d = (wx(i) - g.x) ** 2 + (wy(j) - g.y) ** 2;
          if (d < bestD) { bestD = d; best = j * w + i; }
        }
      }
    }
    return best;
  };
  const votes = new Map<number, number>();
  for (const g of gates) {
    const c = snap(g, 0);
    if (c >= 0) votes.set(piece[c], (votes.get(piece[c]) ?? 0) + 1);
  }
  let track = 0;
  for (const [id, n] of votes) if (!track || n > (votes.get(track) ?? 0)) track = id;
  if (!track) return null;
  const cells = gates.map((g) => snap(g, track));
  if (cells.some((c) => c < 0)) return null;

  // --- 4. the road from each check point to the next: A*, where a step beside a wall costs more
  //        than one down the middle, so the path it finds is one a kart can be late on.
  const wallCost = (k: number): number => {
    const r = room[k];
    return r < CELL * 1.5 ? 8 : r < CELL * 2.5 ? 3.5 : r < CELL * 3.5 ? 1.8 : r < CELL * 4.5 ? 1.25 : 1;
  };
  // Float64: a float32 that rounded UP reads as "improved" to the very sum that set it, and on a
  // grid full of equal-cost paths that re-pushes without end.
  const cost = new Float64Array(w * h);
  const from = new Int32Array(w * h);
  const stamp = new Int32Array(w * h);
  let run = 0;
  const leg = (a: number, b: number): number[] | null => {
    run++;
    const bi = b % w, bj = (b / w) | 0;
    const heap: number[] = [];
    const prio: number[] = [];
    const push = (k: number, p: number): void => {
      let n = heap.length;
      heap.push(k); prio.push(p);
      while (n > 0) {
        const up = (n - 1) >> 1;
        if (prio[up] <= p) break;
        heap[n] = heap[up]; prio[n] = prio[up];
        n = up;
      }
      heap[n] = k; prio[n] = p;
    };
    const pop = (): number => {
      const top = heap[0];
      const k = heap.pop() as number, p = prio.pop() as number;
      const len = heap.length;
      if (len) {
        let n = 0;
        for (;;) {
          let c = n * 2 + 1;
          if (c >= len) break;
          if (c + 1 < len && prio[c + 1] < prio[c]) c++;
          if (prio[c] >= p) break;
          heap[n] = heap[c]; prio[n] = prio[c];
          n = c;
        }
        heap[n] = k; prio[n] = p;
      }
      return top;
    };
    cost[a] = 0; from[a] = -1; stamp[a] = run;
    push(a, 0);
    while (heap.length) {
      const k = pop();
      if (k === b) {
        const path: number[] = [];
        for (let c = b; c >= 0; c = from[c]) path.push(c);
        return path.reverse();
      }
      const i = k % w, j = (k / w) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nk = nj * w + ni;
          if (!open[nk]) continue;
          // No squeezing diagonally between two walls.
          if (di && dj && (!open[j * w + ni] || !open[nj * w + i])) continue;
          const g = cost[k] + (di && dj ? D2 : D1) * wallCost(nk);
          if (stamp[nk] === run && g >= cost[nk]) continue;
          cost[nk] = g; from[nk] = k; stamp[nk] = run;
          push(nk, g + Math.hypot(ni - bi, nj - bj) * CELL);
        }
      }
    }
    return null;
  };

  // The whole lap as one closed string of cells, remembering which check point each is bound for
  // and which cell each check point itself is.
  const px: number[] = [], py: number[] = [], bound: number[] = [], legStart: number[] = [];
  for (let g = 0; g < gates.length; g++) {
    const next = (g + 1) % gates.length;
    const path = leg(cells[g], cells[next]);
    if (!path) return null;
    legStart.push(px.length);
    for (let s = 0; s < path.length - 1; s++) {
      px.push(wx(path[s] % w)); py.push(wy((path[s] / w) | 0)); bound.push(next);
    }
  }
  const m = px.length;
  if (m < 8) return null;

  // --- 5. pull it smooth: every point drifts toward the middle of its neighbours, and is let go
  //        only where that does not take it nearer a wall than a kart wants to be.
  for (let pass = 0; pass < 120; pass++) {
    for (let i = 0; i < m; i++) {
      const a = (i + m - 1) % m, b = (i + 1) % m;
      const nx = px[i] + ((px[a] + px[b]) / 2 - px[i]) * 0.5;
      const ny = py[i] + ((py[a] + py[b]) / 2 - py[i]) * 0.5;
      const have = roomAt(px[i], py[i]);
      if (roomAt(nx, ny) >= Math.min(have, ROOM_SAFE)) { px[i] = nx; py[i] = ny; }
    }
  }

  // --- 6. one sample every STEP along it.
  const seg: number[] = [], upTo: number[] = [];
  let length = 0;
  for (let i = 0; i < m; i++) {
    const b = (i + 1) % m;
    upTo.push(length);
    seg.push(Math.hypot(px[b] - px[i], py[b] - py[i]));
    length += seg[i];
  }
  const n = Math.max(8, Math.round(length / STEP));
  const step = length / n;
  const x = new Float32Array(n), y = new Float32Array(n), gate = new Int16Array(n), roomOut = new Float32Array(n);
  let at = 0;
  for (let s = 0; s < n; s++) {
    const want = s * step;
    while (at < m - 1 && upTo[at] + seg[at] < want) at++;
    const t = seg[at] > 0 ? Math.min(1, (want - upTo[at]) / seg[at]) : 0;
    const b = (at + 1) % m;
    x[s] = px[at] + (px[b] - px[at]) * t;
    y[s] = py[at] + (py[b] - py[at]) * t;
    gate[s] = bound[at];
    roomOut[s] = roomAt(x[s], y[s]);
  }
  const gateAt = new Int32Array(gates.length);
  for (let g = 0; g < gates.length; g++) gateAt[g] = Math.min(n - 1, Math.round(upTo[legStart[g]] / step));

  // --- 7. the road's direction, and from how fast it bends, how fast it can be taken: a cart
  //        turns TURN_RATE whatever its speed, so the speed a bend allows is that over its curvature.
  const heading = new Float32Array(n), cornerSpeed = new Float32Array(n);
  const SPAN = 3;
  for (let s = 0; s < n; s++) {
    const a = (s + n - SPAN) % n, b = (s + SPAN) % n;
    heading[s] = Math.atan2(y[b] - y[a], x[b] - x[a]);
  }
  for (let s = 0; s < n; s++) {
    const a = (s + n - SPAN) % n, b = (s + SPAN) % n;
    const bend = Math.abs(angleDiff(heading[a], heading[b])) / (2 * SPAN * step); // radians a world unit
    cornerSpeed[s] = bend > 1e-6 ? Math.min(TOP_SPEED_MAX * 2, TURN_RATE / bend / UNITS_PER_SPEED) : TOP_SPEED_MAX * 2;
  }
  return { step, n, length, x, y, heading, cornerSpeed, room: roomOut, gate, gateAt };
}

/**
 * How fast one cart may be going at every sample: the corner's own limit, scaled by how much of it
 * this driver dares, and then walked BACKWARDS so it is already slow enough when the corner comes.
 *
 * The brakes are the script's (`CalcSpeed`): the Down key against a rolling cart is TWICE the
 * model's acceleration every 0.05 s. A point of speed is `UNITS_PER_SPEED` world units a second, so
 * over a distance the SQUARE of the speed falls by `2 · (points a second) / UNITS_PER_SPEED` a
 * world unit. `braking` is how much of that the driver counts on having.
 */
export function speedPlan(route: Route, top: number, accel: number, corner: number, braking: number): Float32Array {
  const plan = new Float32Array(route.n);
  for (let s = 0; s < route.n; s++) plan[s] = Math.min(top, route.cornerSpeed[s] * corner);
  const decel = (2 * accel * braking) / TICK; // speedometer points a second
  const drop = (2 * decel * route.step) / UNITS_PER_SPEED;
  // Twice round, so the limit at the end of the lap sees the corner at the start of the next.
  for (let pass = 0; pass < 2; pass++) {
    for (let s = route.n - 1; s >= 0; s--) {
      const ahead = plan[(s + 1) % route.n];
      const may = Math.sqrt(ahead * ahead + drop);
      if (may < plan[s]) plan[s] = may;
    }
  }
  return plan;
}

/**
 * Where on the line a cart is: the nearest sample, looked for first just ahead of where it was
 * last (so the figure-of-eight's crossing never puts it on the other road), and anywhere the
 * script's own check point agrees with when it is nowhere near that — a fresh cart dropped off by
 * the helicopter, or one a rocket threw.
 */
export function locate(route: Route, x: number, y: number, last: number, nextGate: number): number {
  const d2 = (s: number): number => (route.x[s] - x) ** 2 + (route.y[s] - y) ** 2;
  let best = -1, bestD = Infinity;
  if (last >= 0) {
    for (let k = -12; k <= 70; k++) {
      const s = (last + k + route.n * 2) % route.n;
      const d = d2(s);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (bestD < 700 * 700) return best;
  }
  best = -1; bestD = Infinity;
  const gates = route.gateAt.length;
  const g = ((nextGate % gates) + gates) % gates;
  const prev = (g + gates - 1) % gates;
  for (let s = 0; s < route.n; s++) {
    if (route.gate[s] !== g && route.gate[s] !== prev) continue;
    const d = d2(s);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (best >= 0) return best;
  for (let s = 0; s < route.n; s++) {
    const d = d2(s);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** Signed shortest turn from `from` to `to`, radians, in (−π, π]. */
export function angleDiff(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
